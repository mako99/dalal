#!/usr/bin/env python3
"""
Dalal live-data server.

Serves the static site and proxies live quotes from Yahoo Finance at
  GET /api/quotes          -> all tracked symbols
  GET /api/quotes?s=TCS,INFY  -> specific symbols

Run:   python3 server.py   (then open http://localhost:8000)
"""
import csv
import io
import json
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent
PORT = 8000

# Indices need explicit Yahoo tickers; every stock symbol maps to <SYM>.NS.
INDEX_MAP = {
    "NIFTY 50": "^NSEI",
    "SENSEX": "^BSESN",
    "BANKNIFTY": "^NSEBANK",
    "NIFTY IT": "^CNXIT",
}

def _discover_symbols():
    """Read js/data.js so the server tracks exactly what the site ships:
    the curated 'sym: "X"' records plus the UNIVERSE_META symbol table.
    Index names (SENSEX, BANKNIFTY, ...) are excluded — they carry their own
    Yahoo tickers in INDEX_MAP and must not be mapped as <SYM>.NS."""
    try:
        src = (ROOT / "js" / "data.js").read_text(encoding="utf-8")
    except OSError:
        return [], []
    idx = set(INDEX_MAP)
    curated = sorted(set(re.findall(r'sym:\s*"([A-Z0-9&\-]+)"', src)) - idx)
    block = ""
    start = src.find("const UNIVERSE_META")
    if start != -1:
        end = src.find("\n  ];", start)
        block = src[start:end if end != -1 else len(src)]
    universe = sorted(set(re.findall(r'\["([A-Z0-9&\-]+)",\s*"', block)) - idx)
    return curated, universe


CURATED_SYMS, UNIVERSE_SYMS = _discover_symbols()
STOCK_SYMS = sorted(set(CURATED_SYMS) | set(UNIVERSE_SYMS))
YAHOO = {s: s + ".NS" for s in STOCK_SYMS}
YAHOO.update(INDEX_MAP)  # indices always keep their ^-prefixed tickers

# ---- complete NSE listing (official EQUITY_L.csv) -------------------------
NSE_CSV_URLS = [
    "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv",
    "https://archives.nseindia.com/content/equities/EQUITY_L.csv",
]
UNIVERSE_FILE = ROOT / "universe_nse.json"
UNIVERSE_TTL = 7 * 86400  # refresh the list weekly


def load_nse_universe(force=False):
    """Complete NSE equity list as [{sym, name, series}]. Cached on disk."""
    if not force and UNIVERSE_FILE.exists():
        try:
            cached = json.loads(UNIVERSE_FILE.read_text(encoding="utf-8"))
            if cached.get("symbols") and (time.time() - cached.get("fetched", 0)) < UNIVERSE_TTL:
                return cached["symbols"]
        except Exception:
            pass
    for url in NSE_CSV_URLS:
        try:
            raw = _http(url).decode("utf-8-sig", errors="replace")
            out = []
            for row in csv.DictReader(io.StringIO(raw)):
                sym = (row.get("SYMBOL") or "").strip().upper()
                if not sym or not re.fullmatch(r"[A-Z0-9&\-]+", sym):
                    continue
                out.append({
                    "sym": sym,
                    "name": (row.get("NAME OF COMPANY") or sym).strip() or sym,
                    "series": (row.get(" SERIES") or row.get("SERIES") or "EQ").strip(),
                })
            if out:
                UNIVERSE_FILE.write_text(
                    json.dumps({"fetched": time.time(), "source": url, "symbols": out}),
                    encoding="utf-8")
                return out
        except Exception:
            continue
    return []


NSE_LIST = []   # populated below, after _http() is defined
NSE_SYMS = []
ALL_SYMS = STOCK_SYMS

# fast tier: indices + hand-curated stocks (accurate per-symbol changePct)
FAST_SYMS = list(INDEX_MAP) + CURATED_SYMS
# wide tier: the whole listing, fetched in batches via the spark endpoint
SPARK_CHUNK = 80
SPARK_PER_CYCLE = 3   # batches per refresh cycle
SPARK_GAP = 0.5       # seconds between batched calls

_cache = {"ts": 0.0, "data": {}}
HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]
_last_attempt = 0.0
_cooldown_until = 0.0
MIN_GAP = 1.2  # seconds between outbound calls to stay under Yahoo's rate limits
COOLDOWN = 300  # pause outbound calls for 5 min after a 429


class RateLimited(Exception):
    """Yahoo edge responded 429 — back off globally."""


def _http(url):
    """GET a URL, returning the body. Uses curl (HTTP/2, less
    fingerprint-blocked) when present; falls back to urllib.
    Raises RateLimited on 429/999 responses."""
    if shutil.which("curl"):
        p = subprocess.run(
            ["curl", "-sS", "--max-time", "8", "-A",
             "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
             "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
             "-H", "Accept-Language: en-US,en;q=0.5",
             "-w", "\n%{http_code}", url],
            capture_output=True)
        out = p.stdout
        if out:
            body, _, tail = out.rpartition(b"\n")
            if tail.strip().isdigit():
                code = int(tail.strip())
                if code in (429, 999):
                    raise RateLimited(f"HTTP {code}")
                if 200 <= code < 300:
                    return body
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
    })
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        if e.code in (429, 999):
            raise RateLimited(f"HTTP {e.code}") from e
        raise


# ---- initialise the complete NSE listing (needs _http above) --------------
NSE_LIST = load_nse_universe()
NSE_SYMS = sorted({e["sym"] for e in NSE_LIST} - set(INDEX_MAP))
YAHOO.update({s: s + ".NS" for s in NSE_SYMS})
ALL_SYMS = sorted(set(STOCK_SYMS) | set(NSE_SYMS))


def fetch_one(sym):
    """Fetch a live quote for one Dalal symbol via Yahoo's chart endpoint.
    Tries query1/query2 with a retry; raises on total failure."""
    global _last_attempt, _cooldown_until
    if time.time() < _cooldown_until:
        raise RateLimited("cooldown active")
    url_path = (f"/v8/finance/chart/{urllib.parse.quote(YAHOO[sym])}?range=1d&interval=1m")
    last_err = None
    for attempt in range(3):
        host = HOSTS[attempt % len(HOSTS)]
        wait = MIN_GAP - (time.time() - _last_attempt)
        if wait > 0:
            time.sleep(wait)
        _last_attempt = time.time()
        try:
            raw = _http("https://" + host + url_path)
            payload = json.loads(raw.decode())
            res = (payload.get("chart") or {}).get("result") or []
            if not res:
                raise ValueError("empty chart result")
            meta = res[0].get("meta", {})
            price = meta.get("regularMarketPrice")
            if price is None:
                raise ValueError("no price in meta")
            return {
                "price": price,
                "prevClose": meta.get("chartPreviousClose") or meta.get("previousClose"),
                "changePct": meta.get("regularMarketChangePercent"),
                "time": meta.get("regularMarketTime"),
            }
        except RateLimited as e:
            _cooldown_until = time.time() + COOLDOWN  # stop hammering, back off
            raise
        except Exception as e:
            last_err = e
            time.sleep(1.5 * (attempt + 1))  # back off on transient errors
    raise last_err  # propagate so caller can decide


def fetch_quotes(syms):
    """Fetch live quotes per-symbol (accurate changePct). Returns {sym: quote}.
    Resilient: a single bad symbol is skipped and cached values are kept."""
    now = time.time()
    cached = dict(_cache["data"]) if (now - _cache["ts"]) < 600 else {}
    out = dict(cached)
    ok = 0
    try:
        for sym in syms:
            if sym not in YAHOO:
                continue
            try:
                q = fetch_one(sym)
            except RateLimited:
                raise
            except Exception:
                continue  # e.g. symbol not listed on Yahoo — skip it
            out[sym] = q
            ok += 1
    except RateLimited:
        pass  # throttled — serve whatever we have, retry after cooldown
    if ok:
        _cache["ts"] = now
        _cache["data"] = dict(out)
    return out


def fetch_spark(syms):
    """Batched quote fetch via Yahoo's spark endpoint — many symbols per call,
    used for the wide universe so we stay well inside rate limits."""
    global _last_attempt, _cooldown_until
    want = [s for s in syms if s in YAHOO]
    if not want:
        return 0
    if time.time() < _cooldown_until:
        raise RateLimited("cooldown active")
    url = ("https://" + HOSTS[0] + "/v7/finance/spark?symbols="
           + urllib.parse.quote(",".join(YAHOO[s] for s in want))
           + "&indicators=close")
    wait = SPARK_GAP - (time.time() - _last_attempt)
    if wait > 0:
        time.sleep(wait)
    _last_attempt = time.time()
    try:
        payload = json.loads(_http(url).decode())
    except RateLimited:
        _cooldown_until = time.time() + COOLDOWN
        raise
    got = 0
    for sym in want:
        entry = payload.get(YAHOO[sym]) or payload.get(sym)
        if not isinstance(entry, dict):
            continue
        closes = entry.get("close") or []
        price = closes[-1] if closes else None
        if not isinstance(price, (int, float)):
            continue
        prev = entry.get("chartPreviousClose") or entry.get("previousClose")
        _cache["data"][sym] = {
            "price": price,
            "prevClose": prev,
            "changePct": ((price - prev) / prev * 100) if prev else None,
            "time": entry.get("regularMarketTime"),
        }
        got += 1
    if got:
        _cache["ts"] = time.time()
    return got


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):  # quieter logs
        pass

    def do_GET(self):
        if self.path.startswith("/api/universe"):
            self._handle_universe()
        elif self.path.startswith("/api/quotes"):
            self._handle_quotes()
        else:
            super().do_GET()

    def _handle_universe(self):
        """The complete NSE listing so the front-end can offer every stock."""
        syms = NSE_LIST or [{"sym": s, "name": s, "series": "EQ"} for s in UNIVERSE_SYMS]
        self._json(200, {
            "ok": True,
            "count": len(syms),
            "source": "NSE EQUITY_L.csv" if NSE_LIST else "data.js UNIVERSE_META",
            "symbols": syms,
        })

    def _handle_quotes(self):
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        req_syms = qs.get("s", [None])[0]
        syms = [s.strip() for s in req_syms.split(",")] if req_syms else list(YAHOO)
        # always answer instantly from the background-refreshed cache
        data = {s: _cache["data"][s] for s in syms if s in _cache["data"]}
        age = round(time.time() - _cache["ts"], 1) if _cache["data"] else None
        self._json(200, {"ok": True, "quotes": data, "live": bool(data), "age": age})

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def write_client_universe(symbols):
    """Emit js/universe_nse.js so the full listing works offline too."""
    pairs = [[e["sym"], e["name"]] for e in symbols]
    js = ("/* Generated from NSE's official EQUITY_L.csv by:\n"
          "   python3 server.py --refresh-universe\n"
          "   Symbols + company names only; fundamentals are illustrative. */\n"
          "window.DALAL_NSE_UNIVERSE = "
          + json.dumps(pairs, ensure_ascii=False, separators=(",", ":")) + ";\n")
    path = ROOT / "js" / "universe_nse.js"
    path.write_text(js, encoding="utf-8")
    return path


def refresher():
    """Background thread. Tier 1: indices + curated stocks, per-symbol.
    Tier 2: one batch of the wide universe per cycle, via spark, so the
    whole list refreshes every few minutes without hammering Yahoo."""
    chunks = [ALL_SYMS[i:i + SPARK_CHUNK] for i in range(0, len(ALL_SYMS), SPARK_CHUNK)]
    ci = 0
    spark_fails = 0
    fallback_rounds = 0
    slice_size = 12
    while True:
        try:
            fetch_quotes(FAST_SYMS)
        except Exception:
            pass
        if spark_fails < 3:
            for _ in range(SPARK_PER_CYCLE):
                if not chunks:
                    break
                try:
                    got = fetch_spark(chunks[ci % len(chunks)])
                    ci += 1
                    spark_fails = 0 if got else spark_fails + 1
                except RateLimited:
                    break  # cooling down; try again next cycle
                except Exception:
                    spark_fails += 1
        else:
            # batched endpoint refused — walk the listing a slice at a time
            start = (ci * slice_size) % max(1, len(ALL_SYMS))
            try:
                fetch_quotes(ALL_SYMS[start:start + slice_size])
            except Exception:
                pass
            ci += 1
            fallback_rounds += 1
            if fallback_rounds >= 10:  # periodically retry the batched endpoint
                spark_fails = 0
                fallback_rounds = 0
        time.sleep(12)


if __name__ == "__main__":
    import sys

    if "--refresh-universe" in sys.argv:
        fresh = load_nse_universe(force=True)
        if fresh:
            p = write_client_universe(fresh)
            print(f"Refreshed NSE universe: {len(fresh)} symbols -> {p} and {UNIVERSE_FILE}")
        else:
            print("Could not download the NSE list (network blocked?) — keeping existing files.")
        sys.exit(0)

    import threading
    threading.Thread(target=refresher, daemon=True).start()
    print(f"Dalal server  →  http://localhost:{PORT}")
    print(f"  live quotes : {len(ALL_SYMS)} NSE symbols tracked (Yahoo Finance)")
    print(f"  listing     : {len(NSE_LIST)} symbols from NSE EQUITY_L.csv")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()