"""Market-data providers behind one interface.

    MarketDataProvider
        ├── NSEProvider    — the exchange itself: index levels, market status,
        │                    holiday calendar (authoritative, no API key)
        └── YahooProvider  — per-symbol quotes, 52w range, volume, OHLC history
                             and (when a crumb is obtainable) fundamentals

Capabilities are per-provider and explicitly reported, so the frontend never
has to know which provider answered, and a missing capability degrades to
"unavailable" instead of to an invented number.

Nothing here returns a price the provider did not give us: every method either
yields validated fields or an "unavailable" record (see validate.make_quote).
"""
from __future__ import annotations

import http.cookiejar
import json
import logging
import random
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterable

from . import config, validate

log = logging.getLogger("dalal.providers")

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/126.0.0.0 Safari/537.36")


class ProviderError(Exception):
    """Any provider failure: network, shape, HTTP error."""


class RateLimited(ProviderError):
    """HTTP 429/999 — back off globally, do not hammer."""


class _Gate:
    """One global gate for outbound calls: minimum gap + shared backoff.

    Yahoo throttles by IP, so pacing has to be process-wide rather than
    per-request, and a single 429 must pause *every* provider thread.
    """

    def __init__(self, gap: float, cooldown: float) -> None:
        self.gap = gap
        self.cooldown = cooldown
        self.until = 0.0
        self.last = 0.0
        self.lock = threading.Lock()
        self.calls = 0
        self.blocked = 0

    def wait(self) -> None:
        with self.lock:
            now = time.time()
            if now < self.until:
                self.blocked += 1
                raise RateLimited(f"cooldown active for {self.until - now:.0f}s")
            delay = self.gap - (now - self.last)
            if delay > 0:
                time.sleep(delay)
            self.last = time.time()
            self.calls += 1

    def trip(self) -> None:
        with self.lock:
            self.until = time.time() + self.cooldown


GATES: dict[str, _Gate] = {"yahoo": _Gate(config.MIN_GAP, config.COOLDOWN),
                           "nse": _Gate(config.MIN_GAP, config.COOLDOWN)}
GATE = GATES["yahoo"]            # kept for backwards-compatible health output


def gate_for(provider: str) -> _Gate:
    """Per-provider throttle: a Yahoo 429 must never stop NSE index updates."""
    if provider not in GATES:
        GATES[provider] = _Gate(config.MIN_GAP, config.COOLDOWN)
    return GATES[provider]


def http_get(url: str, headers: dict[str, str] | None = None,
             opener: urllib.request.OpenerDirector | None = None,
             timeout: float | None = None, gate: str = "yahoo") -> bytes:
    """GET with per-provider pacing, retries and exponential backoff."""
    if config.OFFLINE:
        raise ProviderError("offline mode (MARKET_OFFLINE=1)")
    pace = gate_for(gate)
    hdrs = {"User-Agent": UA, "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9"}
    hdrs.update(headers or {})
    last: Exception | None = None
    for attempt in range(config.MAX_RETRIES + 1):
        pace.wait()
        try:
            req = urllib.request.Request(url, headers=hdrs)
            op = opener or urllib.request.build_opener()
            with op.open(req, timeout=timeout or config.HOST_TIMEOUT) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (429, 999):
                pace.trip()
                raise RateLimited(f"HTTP {e.code} from {url.split('/')[2]}") from e
            last = ProviderError(f"HTTP {e.code} {url}")
            if e.code in (400, 401, 403, 404):
                break                      # retrying will not help
        except Exception as e:             # noqa: BLE001 - network noise
            last = e
        time.sleep(min(8.0, 1.2 * (2 ** attempt)) + random.random())
    raise last if isinstance(last, ProviderError) else ProviderError(str(last))


class MarketDataProvider:
    """Provider interface. Implement what the source can do; return None/{} for
    what it cannot, and never invent a value."""

    name = "base"
    capabilities: tuple[str, ...] = ()

    def indices(self) -> dict[str, dict[str, Any]]:
        return {}

    def quotes(self, syms: Iterable[str]) -> dict[str, dict[str, Any]]:
        return {}

    def history(self, sym: str, range_: str = "5y",
                interval: str = "1d") -> dict[str, Any] | None:
        return None

    def fundamentals(self, sym: str) -> dict[str, Any] | None:
        return None

    def holidays(self) -> list[dict[str, Any]] | None:
        return None

    def universe(self) -> list[dict[str, Any]] | None:
        return None

    def market_status(self) -> dict[str, Any] | None:
        return None

    def health(self) -> dict[str, Any]:
        return {"provider": self.name, "capabilities": list(self.capabilities),
                "ok": None}


class NSEProvider(MarketDataProvider):
    """NSE (the exchange itself) — index levels, market status, holidays.

    The three endpoints used here answer an anonymous request; NSE's deeper
    per-equity endpoints sit behind Akamai bot protection and answer 403, so
    they are deliberately *not* depended on (Yahoo covers per-symbol quotes).
    No API key is needed or used.
    """

    name = "nse"
    capabilities = ("indices", "market_status", "holidays")
    BASE = "https://www.nseindia.com"

    def __init__(self) -> None:
        self._status: dict[str, Any] | None = None

    def _json(self, path: str) -> Any:
        raw = http_get(self.BASE + path, headers={
            "Referer": self.BASE + "/market-data/live-equity-market",
            "X-Requested-With": "XMLHttpRequest"}, gate="nse")
        try:
            return json.loads(raw.decode())
        except ValueError as exc:
            raise ProviderError(f"nse {path}: invalid JSON") from exc

    def market_status(self) -> dict[str, Any] | None:
        """Exchange status + the timestamp the exchange itself stamps."""
        from . import calendar as mcal
        try:
            data = self._json("/api/marketStatus")
        except ProviderError as exc:
            log.warning("nse marketStatus failed: %s", exc)
            return None
        rows = data.get("marketState") or []
        row = next((r for r in rows if r.get("market") == "Capital Market"), rows[0] if rows else None)
        if not row:
            return None
        as_of, label = self._parse_trade_date(row.get("tradeDate"))
        out = {"market": row.get("market"), "status": row.get("marketStatus"),
               "message": row.get("marketStatusMessage"),
               "tradeDateLabel": label, "asOf": as_of,
               "index": row.get("index"), "last": validate.num(row.get("last")),
               "variation": validate.num(row.get("variation")),
               "percentChange": validate.num(row.get("percentChange")),
               "source": self.name,
               "state": mcal.market_state()}
        self._status = out
        return out

    @staticmethod
    def _parse_trade_date(raw: Any) -> tuple[float | None, str]:
        """'25-Sep-2026 15:30' (IST) -> (epoch seconds, original label)."""
        import datetime as dt
        from .calendar import IST
        if not raw:
            return None, ""
        label = str(raw).strip()
        for fmt in ("%d-%b-%Y %H:%M", "%d-%b-%Y"):
            try:
                d = dt.datetime.strptime(label, fmt)
                return d.replace(tzinfo=IST).timestamp(), label
            except ValueError:
                continue
        return None, label

    def _as_of(self) -> float:
        if self._status and self._status.get("asOf"):
            return float(self._status["asOf"])
        return time.time()

    def indices(self) -> dict[str, dict[str, Any]]:
        from . import symbols
        try:
            data = self._json("/api/allIndices")
        except ProviderError as exc:
            log.warning("nse allIndices failed: %s", exc)
            return {}
        as_of = self._as_of()
        out: dict[str, dict[str, Any]] = {}
        for row in data.get("data") or []:
            label = str(row.get("index") or "").strip()
            sym = symbols.INDEX_BY_PROVIDER.get(label)
            if not sym or sym not in symbols.INDICES:
                continue
            q = validate.make_quote(
                sym, price=row.get("last"), prev_close=row.get("previousClose"),
                change_pct=row.get("percentChange"), source=self.name, as_of=as_of,
                exchange=symbols.INDICES[sym]["exchange"],
                extra={"advances": validate.num(row.get("advances")),
                       "declines": validate.num(row.get("declines")),
                       "unchanged": validate.num(row.get("unchanged")),
                       "variation": validate.num(row.get("variation"))})
            out[sym] = q
        return out

    def holidays(self) -> list[dict[str, Any]] | None:
        try:
            data = self._json("/api/holiday-master?type=trading")
        except ProviderError as exc:
            log.warning("nse holiday-master failed: %s", exc)
            return None
        return data.get("CM") or data.get("FO") or []


class YahooFinanceProvider(MarketDataProvider):
    """Yahoo Finance — per-symbol quotes, OHLC history, some fundamentals.

    Yahoo throttles by IP and gates its richer endpoints behind a cookie+crumb
    handshake, so:
      * every call goes through the shared gate (minimum gap + 429 cooldown),
      * the crumb is fetched lazily and refreshed; when it is refused the
        provider falls back to the chart endpoint, which answers anonymously
        and still carries price, previous close, volume, day range, 52-week
        range, company name and exchange,
      * fields Yahoo does not supply come back as unavailable — never guessed.
    """

    name = "yahoo"
    capabilities = ("quotes", "history", "fundamentals")
    HOSTS = ("query1.finance.yahoo.com", "query2.finance.yahoo.com")
    BATCH = 40                       # symbols per /v7/finance/quote call

    # UI range -> (yahoo range, interval). Yahoo has no 3y, so 3Y is served by
    # the 5y daily series and sliced client-side (no extra request).
    RANGES = {
        "1D": ("1d", "5m"), "1W": ("5d", "15m"), "1M": ("1mo", "1d"),
        "3M": ("3mo", "1d"), "6M": ("6mo", "1d"), "1Y": ("1y", "1d"),
        "3Y": ("5y", "1d"), "5Y": ("5y", "1d"), "MAX": ("max", "1wk"),
    }

    def __init__(self) -> None:
        self._crumb: str = ""
        self._opener: urllib.request.OpenerDirector | None = None
        self._crumb_at: float = 0.0
        self._host_i = 0

    def _host(self) -> str:
        self._host_i += 1
        return self.HOSTS[self._host_i % len(self.HOSTS)]

    def _session(self) -> tuple[urllib.request.OpenerDirector | None, str]:
        """Cookie jar + crumb, cached. ('', None) when Yahoo refuses."""
        if self._crumb and time.time() - self._crumb_at < config.COOKIE_TTL:
            return self._opener, self._crumb
        cj = http.cookiejar.CookieJar()
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        gate_for(self.name).wait()          # the crumb handshake is a real call
        try:
            with op.open(urllib.request.Request(
                    "https://fc.yahoo.com/", headers={"User-Agent": UA}), timeout=8):
                pass
        except Exception:            # noqa: BLE001 - the cookie usually still lands
            pass
        raw = ""
        try:
            raw = op.open(urllib.request.Request(
                "https://query1.finance.yahoo.com/v1/test/getcrumb",
                headers={"User-Agent": UA}), timeout=8).read().decode().strip()
        except Exception as exc:     # noqa: BLE001
            log.info("yahoo crumb unavailable (%s) - using chart meta", exc)
        self._opener, self._crumb_at = op, time.time()
        self._crumb = raw if raw and "<" not in raw else ""
        return self._opener, self._crumb

    def _json(self, path: str, host: str | None = None) -> Any:
        raw = http_get("https://" + (host or self._host()) + path)
        try:
            return json.loads(raw.decode())
        except ValueError as exc:
            raise ProviderError(f"yahoo {path}: invalid JSON") from exc

    # ------------------------------------------------------------- quotes ---
    def quotes(self, syms: Iterable[str]) -> dict[str, dict[str, Any]]:
        from . import symbols
        want = [s for s in dict.fromkeys(symbols.canonical(s) for s in syms) if s]
        if not want:
            return {}
        out: dict[str, dict[str, Any]] = {}
        _, crumb = self._session()
        if crumb:
            out.update(self._batch_quotes(want, crumb))
        for sym in [s for s in want if s not in out]:
            q = self._meta_quote(sym)
            if q:
                out[sym] = q
        if not out:
            raise ProviderError("yahoo returned no quotes")
        return out

    def _batch_quotes(self, syms: list[str], crumb: str) -> dict[str, dict[str, Any]]:
        from . import symbols
        out: dict[str, dict[str, Any]] = {}
        for i in range(0, len(syms), self.BATCH):
            chunk = syms[i:i + self.BATCH]
            tickers = ",".join(urllib.parse.quote(symbols.yahoo_ticker(s)) for s in chunk)
            try:
                data = self._json(f"/v7/finance/quote?symbols={tickers}"
                                  f"&crumb={urllib.parse.quote(crumb)}&fields=all")
            except ProviderError as exc:
                log.warning("yahoo batch quote failed (%s) - using chart meta", exc)
                return out
            for row in (data.get("quoteResponse") or {}).get("result") or []:
                sym = symbols.canonical(str(row.get("symbol") or ""))
                if sym:
                    out[sym] = self._from_quote_row(
                        sym, row, as_of=validate.num(row.get("regularMarketTime")))
        return out

    @staticmethod
    def _from_quote_row(sym: str, row: dict[str, Any], as_of: Any) -> dict[str, Any]:
        return validate.make_quote(
            sym, price=row.get("regularMarketPrice"),
            prev_close=row.get("regularMarketPreviousClose"),
            change_pct=row.get("regularMarketChangePercent"),
            volume=row.get("regularMarketVolume"),
            day_high=row.get("regularMarketDayHigh"),
            day_low=row.get("regularMarketDayLow"),
            high_52=row.get("fiftyTwoWeekHigh"), low_52=row.get("fiftyTwoWeekLow"),
            name=row.get("longName") or row.get("shortName") or "",
            exchange=row.get("fullExchangeName") or "NSE",
            currency=row.get("currency") or "INR", as_of=as_of, source="yahoo",
            extra={"marketState": row.get("marketState"),
                   "fundamentals": {k: validate.num(row.get(k)) for k in (
                       "marketCap", "trailingPE", "forwardPE",
                       "epsTrailingTwelveMonths", "bookValue", "priceToBook",
                       "dividendYield", "trailingAnnualDividendYield",
                       "returnOnEquity", "debtToEquity", "revenueGrowth",
                       "earningsGrowth")}})

    def _meta_quote(self, sym: str) -> dict[str, Any] | None:
        """Anonymous fallback: /v8/finance/chart carries the essentials."""
        from . import symbols
        ticker = symbols.yahoo_ticker(sym)
        if not ticker:
            return None
        try:
            data = self._json(f"/v8/finance/chart/{urllib.parse.quote(ticker)}"
                              "?range=1d&interval=1d")
        except ProviderError as exc:
            log.info("yahoo chart meta failed for %s: %s", sym, exc)
            return None
        res = (data.get("chart") or {}).get("result") or []
        if not res:
            return None
        m = res[0].get("meta") or {}
        return validate.make_quote(
            sym, price=m.get("regularMarketPrice"),
            prev_close=m.get("chartPreviousClose") or m.get("previousClose"),
            change_pct=m.get("regularMarketChangePercent"),
            volume=m.get("regularMarketVolume"),
            day_high=m.get("regularMarketDayHigh"), day_low=m.get("regularMarketDayLow"),
            high_52=m.get("fiftyTwoWeekHigh"), low_52=m.get("fiftyTwoWeekLow"),
            name=m.get("longName") or m.get("shortName") or "",
            exchange=m.get("fullExchangeName") or m.get("exchangeName") or "NSE",
            currency=m.get("currency") or "INR",
            as_of=validate.num(m.get("regularMarketTime")), source="yahoo",
            extra={"marketState": m.get("marketState")})

    # ------------------------------------------------------------ history ---
    def history(self, sym: str, range_: str = "1Y",
                interval: str | None = None) -> dict[str, Any] | None:
        """OHLC(V) series for one symbol — the only price history the UI shows."""
        import datetime as dt
        from . import symbols
        from .calendar import IST
        ticker = symbols.yahoo_ticker(sym)
        if not ticker:
            return None
        key = str(range_ or "1Y").upper()
        yrange, yinterval = self.RANGES.get(key, ("5y", "1d"))
        yinterval = interval or yinterval
        try:
            data = self._json(
                f"/v8/finance/chart/{urllib.parse.quote(ticker)}"
                f"?range={yrange}&interval={yinterval}&includePrePost=false")
        except ProviderError as exc:
            log.warning("yahoo history failed for %s: %s", sym, exc)
            return None
        res = (data.get("chart") or {}).get("result") or []
        if not res:
            return None
        r = res[0]
        stamps = r.get("timestamp") or []
        quote = ((r.get("indicators") or {}).get("quote") or [{}])[0]
        closes = quote.get("close") or []
        if not stamps or not closes:
            return None
        intraday = yinterval.endswith("m") or yinterval.endswith("h")
        fmt = "%Y-%m-%dT%H:%M" if intraday else "%Y-%m-%d"
        points: list[list[Any]] = []
        candles: list[dict[str, Any]] = []
        for i, ts in enumerate(stamps):
            def at(field: str) -> float | None:
                arr = quote.get(field) or []
                return validate.num(arr[i]) if i < len(arr) else None
            close = at("close")
            if close is None:
                continue                     # Yahoo pads nulls; skip, never fill
            when = dt.datetime.fromtimestamp(ts, IST).strftime(fmt)
            points.append([when, round(close, 4)])
            candles.append({"t": when, "o": at("open"), "h": at("high"),
                            "l": at("low"), "c": round(close, 4),
                            "v": at("volume")})
        if len(points) < 2:
            return None
        meta = r.get("meta") or {}
        return {"sym": sym, "range": key,
                "requestedRange": yrange, "interval": yinterval,
                "intraday": intraday, "source": "yahoo",
                "currency": meta.get("currency") or "INR",
                "exchange": meta.get("fullExchangeName") or "",
                "asOf": validate.num(meta.get("regularMarketTime")) or time.time(),
                "points": points, "candles": candles,
                "provenance": {"points": "provider:yahoo", "candles": "provider:yahoo"}}

    # ------------------------------------------------------- fundamentals ---
    FUND_METRICS = ("marketCap", "enterpriseValue", "pe", "forwardPe", "pb", "eps",
                    "dividendYieldPct", "bookValue", "roePct", "roaPct",
                    "revenueGrowthPct", "earningsGrowthPct", "profitMarginPct",
                    "grossMarginPct", "operatingMarginPct", "debtToEquityPct",
                    "currentRatio", "totalRevenue", "netIncome", "totalDebt", "totalCash")

    def fundamentals(self, sym: str) -> dict[str, Any] | None:
        """Real reported metrics, or an explicit "unavailable".

        Yahoo mixes unit conventions: returnOnEquity/margins/growth are
        fractions (0.089 = 8.9%) while dividendYield and debtToEquity are
        already percentages. Both are normalised here — the *Pct suffix always
        means a percentage — so the UI never has to guess.
        """
        from . import symbols
        ticker = symbols.yahoo_ticker(sym)
        if not ticker or symbols.is_index(sym):
            return None
        _, crumb = self._session()
        def unavailable(reason: str) -> dict[str, Any]:
            return {"available": False, "source": "yahoo", "asOf": None,
                    "reason": reason, "metrics": {},
                    "unavailable": list(self.FUND_METRICS), "provenance": {}}
        if not crumb:
            return unavailable("Yahoo needs an authenticated session (crumb) "
                               "for fundamentals — showing N/A")
        try:
            data = self._json(
                f"/v10/finance/quoteSummary/{urllib.parse.quote(ticker)}"
                "?modules=financialData,defaultKeyStatistics,summaryDetail"
                f"&crumb={urllib.parse.quote(crumb)}", host="query1.finance.yahoo.com")
        except ProviderError as exc:
            log.info("quoteSummary failed for %s: %s", sym, exc)
            return unavailable(f"provider error: {exc}")
        res = ((data.get("quoteSummary") or {}).get("result") or [{}])[0]
        fin, stats, summ = (res.get("financialData") or {},
                            res.get("defaultKeyStatistics") or {},
                            res.get("summaryDetail") or {})

        def raw(mod: dict[str, Any], key: str) -> float | None:
            v = mod.get(key)
            if isinstance(v, dict):
                v = v.get("raw")
            return validate.num(v)

        def pct_from_fraction(mod: dict[str, Any], key: str) -> float | None:
            v = raw(mod, key)
            return round(v * 100, 2) if v is not None else None

        metrics = {
            "marketCap": raw(summ, "marketCap") or raw(stats, "marketCap"),
            "enterpriseValue": raw(stats, "enterpriseValue"),
            "pe": raw(summ, "trailingPE"), "forwardPe": raw(summ, "forwardPE"),
            "pb": raw(stats, "priceToBook"), "eps": raw(stats, "trailingEps"),
            "dividendYieldPct": raw(summ, "dividendYield"),
            "bookValue": raw(stats, "bookValue"),
            "roePct": pct_from_fraction(fin, "returnOnEquity"),
            "roaPct": pct_from_fraction(fin, "returnOnAssets"),
            "revenueGrowthPct": pct_from_fraction(fin, "revenueGrowth"),
            "earningsGrowthPct": pct_from_fraction(fin, "earningsGrowth"),
            "profitMarginPct": pct_from_fraction(fin, "profitMargins"),
            "grossMarginPct": pct_from_fraction(fin, "grossMargins"),
            "operatingMarginPct": pct_from_fraction(fin, "operatingMargins"),
            "debtToEquityPct": raw(fin, "debtToEquity"),
            "currentRatio": raw(fin, "currentRatio"),
            "totalRevenue": raw(fin, "totalRevenue"),
            "netIncome": raw(fin, "netIncomeToCommon"),
            "totalDebt": raw(fin, "totalDebt"),
            "totalCash": raw(fin, "totalCash"),
        }
        present = {k: v for k, v in metrics.items() if v is not None}
        if not present:
            return unavailable("provider returned no reported metrics")
        return {"available": True, "source": "yahoo", "asOf": time.time(),
                "period": "latest reported", "metrics": present,
                "unavailable": [k for k in self.FUND_METRICS if k not in present],
                "provenance": {k: "provider:yahoo" for k in present}}

    def health(self) -> dict[str, Any]:
        return {"provider": self.name, "capabilities": list(self.capabilities),
                "crumb": bool(self._crumb), "ok": None}


# ------------------------------------------------------------------ chain --
PROVIDERS: dict[str, type[MarketDataProvider]] = {
    "nse": NSEProvider,
    "yahoo": YahooFinanceProvider,
}


class ProviderChain:
    """Tries providers in configured order and records who answered.

    Capability-by-capability degradation:

        provider A fails/429  ->  provider B  ->  caller's cache  ->  "unavailable"

    The chain never substitutes a value: if nobody can supply a price, the
    result is an unavailable quote and the UI says so.
    """

    def __init__(self, order: list[str] | None = None,
                 instances: list[MarketDataProvider] | None = None) -> None:
        names = [n for n in (order or config.PROVIDER_ORDER) if n in PROVIDERS]
        self.providers: list[MarketDataProvider] = list(instances or []) or \
            [PROVIDERS[n]() for n in names] or [YahooFinanceProvider()]
        self.served: dict[str, str] = {}     # capability -> provider name
        self.errors: list[str] = []

    # -- helpers ------------------------------------------------------------
    def _record(self, capability: str, provider: str) -> None:
        self.served[capability] = provider

    def source_line(self) -> str:
        """Human-readable attribution for the UI footer / info panel."""
        bits = []
        if "indices" in self.served:
            bits.append({"nse": "NSE India", "yahoo": "Yahoo Finance"}[
                self.served["indices"]] + " (indices)")
        if "quotes" in self.served:
            bits.append({"nse": "NSE India", "yahoo": "Yahoo Finance"}[
                self.served["quotes"]] + " (quotes)")
        if "history" in self.served:
            bits.append({"yahoo": "Yahoo Finance", "nse": "NSE India"}[
                self.served["history"]] + " (history)")
        return " · ".join(bits) or "no provider responded"

    def providers_used(self) -> list[str]:
        return sorted(set(self.served.values())) or [p.name for p in self.providers]

    # -- capabilities -------------------------------------------------------
    def indices(self) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for p in self.providers:
            missing = True
            try:
                got = p.indices()
            except (ProviderError, Exception) as exc:     # noqa: BLE001
                self.errors.append(f"{p.name}.indices: {exc}")
                continue
            for sym, q in got.items():
                if validate.is_available(q) and sym not in out:
                    out[sym] = q
                    self._record("indices", p.name)
            if not missing:
                break
        return out

    def quotes(self, syms: Iterable[str]) -> dict[str, dict[str, Any]]:
        from . import symbols
        want = [s for s in dict.fromkeys(symbols.canonical(s) for s in syms) if s]
        out: dict[str, dict[str, Any]] = {}
        for p in self.providers:
            missing = [s for s in want if not validate.is_available(out.get(s))]
            if not missing:
                break
            try:
                got = p.quotes(missing)
            except RateLimited as exc:
                self.errors.append(f"{p.name}.quotes: {exc}")
                break                       # global cooldown: stop trying now
            except Exception as exc:        # noqa: BLE001
                self.errors.append(f"{p.name}.quotes: {exc}")
                continue
            for sym, q in got.items():
                if validate.is_available(q):
                    out[sym] = q
                    self._record("quotes", p.name)
        return out

    def history(self, sym: str, range_: str = "1Y") -> dict[str, Any] | None:
        for p in self.providers:
            try:
                got = p.history(sym, range_)
            except Exception as exc:        # noqa: BLE001
                self.errors.append(f"{p.name}.history: {exc}")
                continue
            if got and got.get("points"):
                self._record("history", p.name)
                return got
        return None

    def fundamentals(self, sym: str) -> dict[str, Any] | None:
        for p in self.providers:
            try:
                got = p.fundamentals(sym)
            except Exception as exc:        # noqa: BLE001
                self.errors.append(f"{p.name}.fundamentals: {exc}")
                continue
            if got:
                if got.get("available"):
                    self._record("fundamentals", p.name)
                return got
        return None

    def holidays(self) -> list[dict[str, Any]] | None:
        for p in self.providers:
            try:
                got = p.holidays()
            except Exception as exc:        # noqa: BLE001
                self.errors.append(f"{p.name}.holidays: {exc}")
                continue
            if got:
                return got
        return None

    def market_status(self) -> dict[str, Any] | None:
        for p in self.providers:
            try:
                got = p.market_status()
            except Exception as exc:        # noqa: BLE001
                self.errors.append(f"{p.name}.market_status: {exc}")
                continue
            if got:
                return got
        return None

    def health(self) -> dict[str, Any]:
        return {"providers": [p.health() for p in self.providers],
                "served": dict(self.served), "sourceLine": self.source_line(),
                "recentErrors": self.errors[-5:]}
