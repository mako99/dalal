#!/usr/bin/env python3
"""Dalal — static site + market-data API.

This file is deliberately thin: everything about *where* data comes from,
*how* it is validated and *how* it is cached lives in the `marketdata`
package. Here we only serve it over HTTP and run the refresh loop.

Endpoints
    GET /api/market                 dashboard payload (indices, quotes, breadth, movers)
    GET /api/market?history=1       … including 5y daily history for the featured set
    GET /api/quotes?s=TCS,INFY      validated quotes for those symbols (on demand)
    GET /api/quotes?full=1          every symbol currently cached
    GET /api/history?s=TCS&range=1Y OHLC candles + closes (1D…5Y)
    GET /api/fundamentals?s=TCS     provider-reported metrics, or available:false
    GET /api/search?q=tata          ranked symbol search
    GET /api/universe               the symbols the site can show
    GET /api/calendar               sessions + NSE holidays, with market state
    GET /api/meta                   provenance: providers, timestamps, cache
    GET /api/health                 liveness + counters (safe to poll)

CLI
    python3 server.py                        serve on PORT (default 8000)
    python3 server.py --snapshot             refresh once, write js/snapshot.js, exit
    python3 server.py --snapshot --history   … with 5y history for featured symbols
    python3 server.py --check                print provider/market diagnostics, exit
    python3 server.py --refresh-universe     regenerate js/universe_nse.js from NSE
    python3 server.py --no-fetch             serve without any outbound calls

Environment: see marketdata/config.py (MARKET_PROVIDER, MARKET_REFRESH_INTERVAL,
DAILY_MARKET_SYNC, TIMEZONE, PORT, MARKET_OFFLINE, …). There are no API keys in
this application, and nothing provider-side is ever exposed to the browser.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import logging
import os
import re
import signal
import sys
import threading
import time
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from marketdata import calendar as mcal            # noqa: E402
from marketdata import config, service, symbols    # noqa: E402

ROOT = config.ROOT
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("dalal.server")

SVC = service.MarketService()
_STOP = threading.Event()
_last_snapshot = 0.0


# --------------------------------------------------------------- snapshot --
def write_snapshot(include_history: bool = True) -> Path:
    """Write js/snapshot.js atomically so a reader never sees a half file."""
    global _last_snapshot
    tmp = config.SNAPSHOT_FILE.with_suffix(".js.tmp")
    tmp.write_text(SVC.snapshot_js(include_history=include_history), encoding="utf-8")
    tmp.replace(config.SNAPSHOT_FILE)
    _last_snapshot = time.time()
    log.info("snapshot written: %s (%.1f KB)", config.SNAPSHOT_FILE.name,
             config.SNAPSHOT_FILE.stat().st_size / 1024)
    return config.SNAPSHOT_FILE


def _maybe_snapshot(force: bool = False) -> None:
    if force or (time.time() - _last_snapshot) > config.SNAPSHOT_EVERY:
        try:
            write_snapshot(include_history=True)
        except Exception as exc:              # noqa: BLE001 - never kill the loop
            log.warning("snapshot failed: %s", exc)


# ------------------------------------------------------------ refresh loop --
def _interval() -> int:
    return config.MARKET_REFRESH_INTERVAL if mcal.market_state()["isOpen"] \
        else config.CLOSED_REFRESH_INTERVAL


def _daily_sync_due() -> bool:
    """True once per trading day, in a short window after the configured close."""
    import datetime as dt
    now = mcal.now_ist()
    if SVC.last_daily_sync >= mcal.market_state()["tradeDate"]:
        return False
    try:
        hh, mm = (int(x) for x in config.DAILY_MARKET_SYNC.split(":"))
    except (ValueError, AttributeError):
        hh, mm = 15, 45
    target = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    slack = target + dt.timedelta(minutes=config.DAILY_SYNC_SLACK_MIN)
    if not mcal.is_trading_day(now.date()):
        return False
    return target <= now <= slack


def _mark_daily_sync() -> None:
    SVC.last_daily_sync = mcal.now_ist().date().isoformat()
    SVC.store.set_meta("last_daily_sync", SVC.last_daily_sync)


def refresher() -> None:
    """Background loop: refresh the tiers on a market-aware schedule."""
    log.info("refresher idle %.0fs; waiting %ss while closed, %ss while open",
             time.time(), config.CLOSED_REFRESH_INTERVAL, config.MARKET_REFRESH_INTERVAL)
    time.sleep(1.0)
    while not _STOP.is_set():
        try:
            result = SVC.refresh(wide=True)
            if result.get("errors"):
                log.info("cycle kept %d values (%s)", result["refreshed"],
                         "; ".join(result["errors"])[:160])
        except Exception as exc:              # noqa: BLE001
            log.warning("refresh cycle failed: %s", exc)
        if config.OFFLINE:
            log.info("MARKET_OFFLINE=1 - serving cache only, refresher idles")
            _STOP.wait(3600)
            continue
        _maybe_snapshot()
        if _daily_sync_due():
            log.info("daily post-close sync for %s", mcal.market_state()["tradeDate"])
            try:
                SVC.refresh(wide=True)
                write_snapshot(include_history=True)
                _mark_daily_sync()
            except Exception as exc:          # noqa: BLE001
                log.warning("daily sync failed: %s", exc)
        _STOP.wait(max(30, _interval()))


# --------------------------------------------------------------- HTTP API --
class Handler(SimpleHTTPRequestHandler):
    server_version = "Dalal/2.0"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # -- helpers ------------------------------------------------------------
    def log_message(self, fmt: str, *args: Any) -> None:      # quieter access log
        if "/api/" in (self.path or ""):
            log.debug("%s %s", self.address_string(), fmt % args)

    def _send_json(self, obj: Any, status: int = 200, max_age: int = 0) -> None:
        body = json.dumps(obj, separators=(",", ":"), default=str).encode()
        encoding = ""
        # The dashboard payload carries every tracked quote, so it is worth
        # compressing on the wire when the client asks for it.
        if len(body) > 1024 and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body, encoding = gzip.compress(body, 6), "gzip"
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if encoding:
            self.send_header("Content-Encoding", encoding)
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store" if max_age == 0
                         else f"public, max-age={max_age}")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _query(self) -> dict[str, list[str]]:
        return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

    def _symbols_param(self, q: dict[str, list[str]]) -> list[str]:
        raw: list[str] = []
        for value in q.get("s", []) + q.get("symbols", []) + q.get("symbol", []):
            raw += [p for p in value.replace("|", ",").split(",") if p.strip()]
        return raw

    # -- routing ------------------------------------------------------------
    def do_OPTIONS(self) -> None:                              # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:                                  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if not path.startswith("/api/"):
            return super().do_GET()
        q = self._query()
        try:
            handler = ROUTES.get(path)
            if handler is None:
                return self._send_json({"error": "unknown endpoint", "path": path},
                                       status=404)
            return handler(self, q)
        except Exception as exc:                # noqa: BLE001 - never 500 blindly
            log.exception("api error on %s", path)
            return self._send_json({"error": str(exc)[:200], "path": path}, status=503)

    # -- static files -------------------------------------------------------
    def end_headers(self) -> None:
        path = urllib.parse.urlparse(self.path).path
        if path.endswith((".js", ".css", ".svg", ".png", ".woff2")):
            self.send_header("Cache-Control", "public, max-age=300")
        elif path.endswith(".html") or path in ("/", ""):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()


# ------------------------------------------------------------------ routes --
def api_market(h: Handler, q: dict[str, list[str]]) -> None:
    with_hist = q.get("history", ["0"])[0] not in ("0", "false", "")
    h._send_json(SVC.market_payload(include_history=with_hist))


def api_quotes(h: Handler, q: dict[str, list[str]]) -> None:
    if q.get("full", ["0"])[0] not in ("0", "false", ""):
        live = dict(SVC.quotes)
        h._send_json({"quotes": live, "count": len(live), "market": SVC.market,
                      "source": {"line": SVC.chain.source_line()}})
        return
    want = h._symbols_param(q) or SVC.featured()
    h._send_json(SVC.quote_payload(want))


def api_history(h: Handler, q: dict[str, list[str]]) -> None:
    want = h._symbols_param(q)
    if not want:
        return h._send_json({"error": "pass ?s=SYMBOL"}, status=400)
    range_ = (q.get("range", ["1Y"])[0] or "1Y").upper()
    if len(want) == 1:
        return h._send_json(SVC.history_payload(want[0], range_))
    h._send_json({"range": range_, "series": {
        symbols.canonical(s) or s: SVC.history_payload(s, range_) for s in want[:8]}})


def api_fundamentals(h: Handler, q: dict[str, list[str]]) -> None:
    want = h._symbols_param(q)
    if not want:
        return h._send_json({"error": "pass ?s=SYMBOL"}, status=400)
    if len(want) == 1:
        return h._send_json(SVC.fundamentals_payload(want[0]))
    h._send_json({"fundamentals": {symbols.canonical(s) or s:
                                  SVC.fundamentals_payload(s) for s in want[:10]}})


def api_search(h: Handler, q: dict[str, list[str]]) -> None:
    term = (q.get("q", [""])[0] or "").strip()
    limit = int((q.get("limit", ["12"])[0]) or 12)
    results = symbols.search(term, limit=min(40, max(1, limit)))
    quotes = SVC.quote_payload([r["symbol"] for r in results])["quotes"] if results else {}
    for r in results:
        quote = quotes.get(r["symbol"]) or {}
        r["price"] = quote.get("price")
        r["changePct"] = quote.get("changePct")
        r["freshness"] = quote.get("freshness")
    h._send_json({"query": term, "results": results, "market": SVC.market})


def api_universe(h: Handler, q: dict[str, list[str]]) -> None:
    universe = symbols.load_universe()
    h._send_json({"count": len(universe),
                  "symbols": [{"symbol": s, "name": v.get("name") or s,
                               "sector": v.get("sector") or ""}
                              for s, v in sorted(universe.items())],
                  "indices": [{"symbol": k, "name": v["name"], "exchange": v["exchange"]}
                              for k, v in symbols.INDICES.items()]})


def api_calendar(h: Handler, q: dict[str, list[str]]) -> None:
    days = int((q.get("days", ["400"])[0]) or 400)
    h._send_json(mcal.calendar_payload(days=min(400, max(7, days))), max_age=300)


def api_snapshot(h: Handler, q: dict[str, list[str]]) -> None:
    with_hist = q.get("history", ["1"])[0] not in ("0", "false", "")
    h._send_json(SVC.market_payload(include_history=with_hist))


def api_meta(h: Handler, q: dict[str, list[str]]) -> None:
    h._send_json({
        "source": {"providers": SVC.chain.providers_used(),
                   "line": SVC.chain.source_line(),
                   "exchangeStatus": SVC.status},
        "market": SVC.market,
        "asOf": SVC.market_payload()["asOf"],
        "generatedAt": time.time(),
        "provenance": {"indices": "provider", "quotes": "provider",
                       "breadth": "derived from real quotes",
                       "movers": "derived from real quotes", "history": "provider",
                       "fundamentals": "provider-reported only; otherwise N/A"},
        "cache": SVC.store.stats(),
        "config": {"refreshInterval": config.MARKET_REFRESH_INTERVAL,
                   "closedRefreshInterval": config.CLOSED_REFRESH_INTERVAL,
                   "dailySync": config.DAILY_MARKET_SYNC,
                   "timezone": config.TIMEZONE,
                   "providerOrder": config.PROVIDER_ORDER}})


def api_health(h: Handler, q: dict[str, list[str]]) -> None:
    h._send_json(SVC.health_payload())


ROUTES = {
    "/api/market": api_market,
    "/api/quotes": api_quotes,
    "/api/history": api_history,
    "/api/chart": api_history,
    "/api/fundamentals": api_fundamentals,
    "/api/search": api_search,
    "/api/universe": api_universe,
    "/api/calendar": api_calendar,
    "/api/snapshot": api_snapshot,
    "/api/meta": api_meta,
    "/api/health": api_health,
}


# --------------------------------------------------------------------- CLI --
def refresh_universe() -> int:
    """Regenerate js/universe_nse.js from NSE's official EQUITY_L.csv."""
    from marketdata.providers import ProviderError, http_get
    urls = ["https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv",
            "https://archives.nseindia.com/content/equities/EQUITY_L.csv"]
    rows: list[tuple[str, str]] = []
    for url in urls:
        try:
            raw = http_get(url).decode("utf-8-sig", errors="replace")
        except ProviderError as exc:
            log.warning("universe fetch failed (%s): %s", url, exc)
            continue
        for row in csv.DictReader(io.StringIO(raw)):
            sym = (row.get("SYMBOL") or "").strip().upper()
            name = (row.get("NAME OF COMPANY") or sym).strip()
            if sym and re.fullmatch(r"[A-Z0-9&\-]{1,24}", sym):
                rows.append((sym, name))
        if rows:
            break
    if not rows:
        log.error("could not refresh the universe from NSE")
        return 1
    rows = sorted(set(rows))
    out = ("/* Generated from NSE's official EQUITY_L.csv by:\n"
           "   python3 server.py --refresh-universe\n"
           "   Symbols + company names only; prices and fundamentals come from\n"
           "   the market-data API (see README), never from this file. */\n"
           "window.DALAL_NSE_UNIVERSE = "
           + json.dumps(rows, separators=(",", ":")) + ";\n")
    (ROOT / "js" / "universe_nse.js").write_text(out, encoding="utf-8")
    log.info("js/universe_nse.js refreshed with %d symbols", len(rows))
    return 0


def diagnostics() -> int:
    """Print what the pipeline can actually see right now."""
    print(f"timezone            {config.TIMEZONE}")
    print(f"provider order      {config.PROVIDER_ORDER}")
    print(f"refresh interval    {config.MARKET_REFRESH_INTERVAL}s open / "
          f"{config.CLOSED_REFRESH_INTERVAL}s closed")
    print(f"daily sync          {config.DAILY_MARKET_SYNC} IST")
    print(f"universe            {len(symbols.load_universe())} symbols "
          f"({len(symbols.curated())} curated)")
    state = mcal.market_state()
    print(f"market              {state['state']} ({state['label']}) "
          f"trade date {state['tradeDate']} next open {state['nextOpenLabel']}")
    print(f"holidays            {len(mcal.holidays())} (source: {mcal._cache['source']})")
    print(f"cache               {SVC.store.stats()}")
    if config.OFFLINE:
        print("offline             yes (MARKET_OFFLINE=1) - no provider calls")
        return 0
    result = SVC.refresh(wide=False)
    print(f"refresh             {result['refreshed']} values in {result['seconds']}s"
          f"{' errors: ' + '; '.join(result['errors']) if result['errors'] else ''}")
    payload = SVC.market_payload()
    for sym in ("NIFTY 50", "SENSEX", "BANKNIFTY", "NIFTY IT"):
        q = payload["indices"].get(sym) or {}
        if q.get("price"):
            print(f"  {sym:11s} {q['price']:>12,.2f}  {q['changePct']:+.2f}%  "
                  f"{q['source']:6s} {q['freshness']}")
        else:
            print(f"  {sym:11s} unavailable ({q.get('reason', '')})")
    print(f"quotes tracked      {len(payload['quotes'])}")
    print(f"breadth             {payload['breadth']}")
    print(f"source              {payload['source']['line']}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Dalal market-data server")
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=config.PORT)
    ap.add_argument("--snapshot", action="store_true",
                    help="refresh once, write js/snapshot.js, exit")
    ap.add_argument("--history", action="store_true",
                    help="include 5y history in the snapshot")
    ap.add_argument("--check", action="store_true", help="print diagnostics and exit")
    ap.add_argument("--refresh-universe", action="store_true",
                    help="regenerate js/universe_nse.js from NSE")
    ap.add_argument("--no-fetch", action="store_true",
                    help="serve from cache only, never call a provider")
    args = ap.parse_args(argv)

    if args.no_fetch:
        config.OFFLINE = True
    if args.refresh_universe:
        return refresh_universe()
    if args.check:
        return diagnostics()
    if args.snapshot:
        result = SVC.refresh(wide=False)
        log.info("pre-snapshot refresh: %s values", result["refreshed"])
        path = write_snapshot(include_history=args.history)
        payload = SVC.market_payload()
        with_hist = len(payload.get("history") or {})
        print(f"wrote {path} ({path.stat().st_size / 1024:.1f} KB) · "
              f"{len(payload['indices'])} indices · {len(payload['quotes'])} quotes · "
              f"{with_hist} history series · source: {payload['source']['line']}")
        return 0

    if not config.OFFLINE:
        threading.Thread(target=refresher, name="refresh", daemon=True).start()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True

    def stop(signum: int, frame: Any) -> None:      # noqa: ARG001
        log.info("shutting down")
        _STOP.set()
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    log.info("serving %s on http://%s:%d", ROOT, args.host, args.port)
    log.info("market: %s · sources: %s", mcal.market_state()["label"],
             SVC.chain.source_line())
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        _STOP.set()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
