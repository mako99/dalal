#!/usr/bin/env python3
"""
Dalal live-data server.

Serves the static site and proxies live quotes from Yahoo Finance at
  GET /api/quotes                -> indices + curated stocks (small default)
  GET /api/quotes?s=TCS,INFY     -> those symbols (fetched live on demand)
  GET /api/quotes?full=1         -> every symbol cached so far
  GET /api/history?s=TCS,SENSEX  -> month-end closes for the last 5 years
  GET /api/snapshot              -> quotes + history for the featured symbols
  GET /api/universe              -> the complete NSE equity listing

Quotes are kept in SQLite (dalal.db) so a restart starts warm, and the
featured symbols are also written out to js/snapshot.js so the site shows
real numbers when it is hosted without this server (GitHub Pages).

Run:      python3 server.py           (then open http://localhost:8000)
Snapshot: python3 server.py --snapshot [--history]
Universe: python3 server.py --refresh-universe
"""
import csv
import io
import json
import re
import shutil
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.request
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent
PORT = 8000

# Local cache of the last known good data. Quotes live in SQLite so the site
# already shows recent numbers the moment it boots (and while Yahoo is away),
# and the featured symbols also get a committed js/snapshot.js for GitHub
# Pages / file:// where no server is running at all.
DB_PATH = ROOT / "dalal.db"
SNAPSHOT_FILE = ROOT / "js" / "snapshot.js"
SNAPSHOT_EVERY = 1800        # rewrite js/snapshot.js at most every 30 min
HIST_MONTHS = 60             # five years of monthly closes in the snapshot
HIST_TTL = 86400             # refetch a symbol's history once a day
QUOTES_TTL = 25              # seconds a cached quote may serve a direct ask

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

_cache = {"ts": 0.0, "data": {}, "last_fresh": 0}
HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]
_last_attempt = 0.0
_cooldown_until = 0.0
MIN_GAP = 1.2  # seconds between outbound calls to stay under Yahoo's rate limits
COOLDOWN = 300  # pause outbound calls for 5 min after a 429


class RateLimited(Exception):
    """Yahoo edge responded 429 — back off globally."""


# ---- SQLite cache ----------------------------------------------------------
_db_conn = None
_db_lock = threading.Lock()


def _db():
    """One shared connection: the refresher thread and the HTTP handler
    threads both use it, so every access is serialised by _db_lock."""
    global _db_conn
    if _db_conn is None:
        _db_conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        _db_conn.execute(
            "CREATE TABLE IF NOT EXISTS quotes("
            "sym TEXT PRIMARY KEY, price REAL, prev_close REAL,"
            "change_pct REAL, ts REAL)")
        _db_conn.execute(
            "CREATE TABLE IF NOT EXISTS history("
            "sym TEXT PRIMARY KEY, json TEXT, fetched REAL)")
        _db_conn.commit()
    return _db_conn


def db_save_quotes(quotes):
    """Persist the last known quote per symbol (survives restarts)."""
    rows = [(s, q.get("price"), q.get("prevClose"), q.get("changePct"),
             q.get("time") or time.time())
            for s, q in quotes.items()
            if isinstance(q.get("price"), (int, float))]
    if not rows:
        return 0
    try:
        with _db_lock:
            db = _db()
            db.executemany(
                "INSERT OR REPLACE INTO quotes"
                "(sym, price, prev_close, change_pct, ts) VALUES(?,?,?,?,?)", rows)
            db.commit()
    except sqlite3.Error:
        return 0
    return len(rows)


def db_load_quotes(max_age=None):
    """{sym: quote} for everything cached on disk, newest first per symbol."""
    sql = ("SELECT q.sym, q.price, q.prev_close, q.change_pct, q.ts "
           "FROM quotes q JOIN (SELECT sym, MAX(ts) m FROM quotes GROUP BY sym) x"
           " ON q.sym = x.sym AND q.ts = x.m")
    try:
        with _db_lock:
            rows = _db().execute(sql).fetchall()
    except sqlite3.Error:
        return {}
    out = {}
    for sym, price, prev, pct, ts in rows:
        if price is None:
            continue
        if max_age is not None and (time.time() - (ts or 0)) > max_age:
            continue
        out[sym] = {"price": price, "prevClose": prev,
                    "changePct": pct, "time": ts}
    return out


def db_save_history(sym, points):
    try:
        with _db_lock:
            _db().execute("INSERT OR REPLACE INTO history(sym, json, fetched) VALUES(?,?,?)",
                          (sym, json.dumps(points), time.time()))
            _db().commit()
    except sqlite3.Error:
        pass


def db_load_history(syms, max_age=None):
    """{sym: [[date, close], ...]} for symbols already fetched before.
    `max_age` (seconds) skips rows older than that so callers can trigger a
    refresh without clearing the table."""
    want = [s for s in syms if s in YAHOO]
    if not want:
        return {}
    out = {}
    try:
        with _db_lock:
            db = _db()
            for sym in want:
                row = db.execute("SELECT json, fetched FROM history WHERE sym=?", (sym,)).fetchone()
                if not row:
                    continue
                if max_age is not None and (time.time() - (row[1] or 0)) > max_age:
                    continue
                pts = json.loads(row[0])
                if pts:
                    out[sym] = pts
    except (sqlite3.Error, ValueError):
        return out
    return out


def _rate_wait(gap):
    """Space outbound calls so we stay under Yahoo's rate limits."""
    global _last_attempt
    wait = gap - (time.time() - _last_attempt)
    if wait > 0:
        time.sleep(wait)
    _last_attempt = time.time()


UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
# Yahoo's edge answers this UA with JSON and answers some others with 429,
# so it is not cosmetic — a Firefox UA string was getting 429 on every call.
HDRS = {
    "User-Agent": UA,
    "Accept": "application/json, text/html, */*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}


def _http(url):
    """GET a URL and return the body.

    urllib goes first: Yahoo's edge answers it. curl (HTTP/2, different TLS
    fingerprint) is only a fallback, because the same request that urllib
    answers with JSON comes back as 429 from curl.
    Raises RateLimited on 429/999 responses.
    """
    last_err = None
    try:
        req = urllib.request.Request(url, headers=HDRS)
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        if e.code in (429, 999):
            raise RateLimited(f"HTTP {e.code}") from e
        last_err = e
    except Exception as e:
        last_err = e
    if shutil.which("curl"):
        p = subprocess.run(
            ["curl", "-sS", "--max-time", "8", "-A", UA,
             "-H", "Accept: " + HDRS["Accept"],
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
    raise last_err


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
        _rate_wait(MIN_GAP)
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
    Resilient: a single bad symbol is skipped and cached values are kept.
    Every freshly fetched quote is also written to dalal.db."""
    out = dict(_cache["data"])
    fresh = {}
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
            fresh[sym] = q
    except RateLimited:
        pass  # throttled — serve whatever we have, retry after cooldown
    if fresh:
        _cache["ts"] = time.time()
        _cache["data"] = out
        _cache["last_fresh"] = len(fresh)
        db_save_quotes(fresh)
    else:
        _cache["last_fresh"] = 0
    return out


def fetch_spark(syms):
    """Batched quote fetch via Yahoo's spark endpoint — many symbols per call,
    used for the wide universe so we stay well inside rate limits."""
    global _cooldown_until
    want = [s for s in syms if s in YAHOO]
    if not want:
        return 0
    if time.time() < _cooldown_until:
        raise RateLimited("cooldown active")
    url = ("https://" + HOSTS[0] + "/v7/finance/spark?symbols="
           + urllib.parse.quote(",".join(YAHOO[s] for s in want))
           + "&indicators=close")
    _rate_wait(SPARK_GAP)
    try:
        payload = json.loads(_http(url).decode())
    except RateLimited:
        _cooldown_until = time.time() + COOLDOWN
        raise
    got = 0
    fresh = {}
    for sym in want:
        entry = payload.get(YAHOO[sym]) or payload.get(sym)
        if not isinstance(entry, dict):
            continue
        closes = entry.get("close") or []
        price = closes[-1] if closes else None
        if not isinstance(price, (int, float)):
            continue
        prev = entry.get("chartPreviousClose") or entry.get("previousClose")
        fresh[sym] = {
            "price": price,
            "prevClose": prev,
            "changePct": ((price - prev) / prev * 100) if prev else None,
            "time": entry.get("regularMarketTime"),
        }
        got += 1
    if got:
        _cache["data"].update(fresh)
        _cache["ts"] = time.time()
        db_save_quotes(fresh)
    return got


# ---- real price history (5y of monthly closes per featured symbol) ---------
def _monthly(points, months=HIST_MONTHS):
    """Thin a daily [date, close] list down to roughly the last `months`
    month-end points (always keeping the newest one)."""
    if not points:
        return []
    by_month = {}
    for d, c in points:
        by_month[d[:7]] = [d, c]          # later dates overwrite -> month end
    vals = [by_month[k] for k in sorted(by_month)]
    if len(vals) > months:
        vals = vals[-months:]
    return vals


def fetch_history(sym):
    """Daily closes for a symbol over the last 5y, thinned to month ends.
    Returns [[\"2021-09-24\", 63.2], ...] (possibly empty)."""
    global _cooldown_until
    if sym not in YAHOO:
        return []
    if time.time() < _cooldown_until:
        raise RateLimited("cooldown active")
    _rate_wait(MIN_GAP)
    for attempt, host in enumerate(HOSTS):
        url = (f"https://{host}/v8/finance/chart/{urllib.parse.quote(YAHOO[sym])}"
               "?range=5y&interval=1d")
        try:
            payload = json.loads(_http(url).decode())
            res = (payload.get("chart") or {}).get("result") or []
            if not res:
                raise ValueError("empty chart result")
            stamps = res[0].get("timestamp") or []
            closes = ((res[0].get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
            pts = []
            for ts, c in zip(stamps, closes):
                if not isinstance(c, (int, float)) or c <= 0:
                    continue
                pts.append([time.strftime("%Y-%m-%d", time.gmtime(int(ts))), round(c, 2)])
            if len(pts) < 30:
                raise ValueError("history too short")
            return _monthly(pts)
        except RateLimited:
            _cooldown_until = time.time() + COOLDOWN
            raise
        except Exception:
            if attempt == len(HOSTS) - 1:
                return []
            time.sleep(1.5)
    return []


def refresh_history(force=False):
    """Make sure every featured symbol has ~5y of monthly closes in the DB.
    Rows younger than a day are reused, so this is cheap after the first run."""
    have = {} if force else db_load_history(FAST_SYMS, max_age=HIST_TTL)
    out = dict(have)
    for sym in FAST_SYMS:
        if sym in out:
            continue
        try:
            pts = fetch_history(sym)
        except RateLimited:
            break
        except Exception:
            pts = []
        if pts:
            db_save_history(sym, pts)
            out[sym] = pts
    return out


def warm_cache():
    """Start every boot with the freshest data we already have on disk:
    the site is useful immediately, even before Yahoo answers."""
    stored = db_load_quotes()
    if stored:
        newest = max((q.get("time") or 0) for q in stored.values())
        _cache["data"].update(stored)
        _cache["ts"] = min(_cache["ts"] or newest, newest) if _cache["ts"] else newest
    return len(stored)


def refresh_fast():
    """One pass of the featured tier (indices + curated stocks) plus a
    committed snapshot when Yahoo answered. Returns the quote count."""
    fetch_quotes(FAST_SYMS)
    if _cache["last_fresh"]:
        maybe_write_snapshot()
    return len(_cache["data"])


_snapshot_state = {"ts": 0.0}


def maybe_write_snapshot(force=False):
    """Rewrite js/snapshot.js at most once per SNAPSHOT_EVERY seconds."""
    now = time.time()
    if not force and (now - _snapshot_state["ts"]) < SNAPSHOT_EVERY:
        return None
    path = write_snapshot()
    if path:
        _snapshot_state["ts"] = now
    return path


def build_snapshot():
    """The payload committed to js/snapshot.js: live quotes + real 5y
    month-end closes for the indices and the curated stocks."""
    quotes = {s: _cache["data"][s] for s in FAST_SYMS if s in _cache["data"]}
    hist = db_load_history(FAST_SYMS)
    return {"fetched": round(time.time(), 1), "quotes": quotes, "history": hist}


def write_snapshot(payload=None):
    """Emit js/snapshot.js so GitHub Pages / file:// show real numbers."""
    data = payload or build_snapshot()
    if not data.get("quotes") and not data.get("history"):
        return None
    js = ("/* Generated by server.py — real Yahoo Finance data.\n"
          "   Refresh with:  python3 server.py --snapshot\n"
          "   Quotes are the last values the server saw; history is ~5y of\n"
          "   month-end closes for the indices and curated stocks. */\n"
          "window.DALAL_SNAPSHOT = "
          + json.dumps(data, separators=(",", ":")) + ";\n")
    SNAPSHOT_FILE.write_text(js, encoding="utf-8")
    return SNAPSHOT_FILE


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
        elif self.path.startswith("/api/history"):
            self._handle_history()
        elif self.path.startswith("/api/snapshot"):
            self._json(200, build_snapshot())
        else:
            super().do_GET()

    def end_headers(self):
        # lets the page work when opened straight from file:// as well
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

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
        """Answer instantly from the background-refreshed cache.

        /api/quotes              -> indices + curated stocks (small default)
        /api/quotes?s=TCS,INFY   -> just those symbols (fetched live if new)
        /api/quotes?full=1       -> everything cached so far
        """
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        req = qs.get("s", [None])[0]
        full = qs.get("full", ["0"])[0] in ("1", "true", "yes")
        if req:
            syms = [s.strip().upper() for s in req.split(",") if s.strip()]
            missing = [s for s in syms if s not in _cache["data"]][:10]
            if missing:
                fetch_quotes(missing)   # first ask for this symbol: go get it
        elif full:
            syms = sorted(_cache["data"])
        else:
            syms = FAST_SYMS
        data = {s: _cache["data"][s] for s in syms if s in _cache["data"]}
        age = round(time.time() - _cache["ts"], 1) if _cache["data"] else None
        self._json(200, {
            "ok": True,
            "quotes": data,
            "live": bool(_cache["last_fresh"]),
            "age": age,
            "count": len(_cache["data"]),
        })

    def _handle_history(self):
        """/api/history?s=TCS,SENSEX -> month-end closes for the last 5y.
        Served from the SQLite cache; only unseen symbols hit the network."""
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        req = qs.get("s", [None])[0]
        syms = ([s.strip().upper() for s in req.split(",") if s.strip()]
                if req else FAST_SYMS)
        hist, age = {}, None
        for sym in dict.fromkeys(syms):
            pts = db_load_history([sym])
            if sym in pts:
                hist[sym] = pts[sym]
                continue
            try:
                pts = fetch_history(sym)
            except Exception:
                pts = []
            if pts:
                db_save_history(sym, pts)
                hist[sym] = pts
        age = round(time.time() - _cache["ts"], 1) if _cache["data"] else None
        self._json(200, {"ok": True, "history": hist,
                         "count": len(hist), "months": HIST_MONTHS, "age": age})

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
    try:
        warm_cache()                 # serve yesterday's numbers until Yahoo talks
        refresh_history()            # month-end closes for the featured symbols
    except Exception:
        pass
    chunks = [ALL_SYMS[i:i + SPARK_CHUNK] for i in range(0, len(ALL_SYMS), SPARK_CHUNK)]
    ci = 0
    spark_fails = 0
    fallback_rounds = 0
    slice_size = 12
    while True:
        try:
            refresh_fast()
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

    if "--snapshot" in sys.argv:
        n = warm_cache()
        fetch_quotes(FAST_SYMS)                      # best effort live quotes
        hist = refresh_history(force="--history" in sys.argv)
        p = write_snapshot()
        if p:
            print(f"Wrote {p}: {len(_cache['data'])} quotes ({n} restored from cache), "
                  f"history for {len(hist)} symbols")
        else:
            print("No data from Yahoo Finance — js/snapshot.js left untouched.")
        sys.exit(0)

    warm_cache()
    threading.Thread(target=refresher, daemon=True).start()
    print(f"Dalal server  →  http://localhost:{PORT}")
    print(f"  live quotes : {len(ALL_SYMS)} NSE symbols tracked (Yahoo Finance)")
    print("  history     : /api/history?s=TCS,SENSEX  ·  /api/snapshot")
    print(f"  listing     : {len(NSE_LIST)} symbols from NSE EQUITY_L.csv")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()