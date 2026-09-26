"""MarketService — the one place that answers "what are the numbers right now?".

Responsibilities:

* own the refresh policy (this cycle's tier, the daily post-close sync),
* merge provider output with the SQLite cache,
* compute derived market statistics (breadth, movers) *from real values only*,
* expose the JSON the HTTP layer and the committed snapshot share, so the
  static GitHub Pages build and the live server can never disagree about the
  shape or the meaning of the data.

Derived statistics are labelled as derived: nothing here invents a price.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any, Iterable

from . import calendar as mcal
from . import config, providers, store as store_mod, symbols, validate

log = logging.getLogger("dalal.service")


class MarketService:
    def __init__(self, store: store_mod.Store | None = None,
                 chain: providers.ProviderChain | None = None) -> None:
        self.store = store or store_mod.Store(config.DB_PATH)
        self.chain = chain or providers.ProviderChain()
        self.lock = threading.RLock()
        self.quotes: dict[str, dict[str, Any]] = {}
        self.indices: dict[str, dict[str, Any]] = {}
        self.market: dict[str, Any] = mcal.market_state()
        self.status: dict[str, Any] | None = None
        self.last_refresh: float = 0.0
        self.last_error: str = ""
        self.refresh_count: int = 0
        self.last_daily_sync: str = ""
        self._wide_cursor: int = 0
        self.hydrate()

    # ------------------------------------------------------------- boot ----
    def hydrate(self) -> int:
        """Warm the cache from SQLite: a restart shows real (if older) data.

        Cached values are split back into the tier they belong to, so a restart
        while a provider is unreachable still shows the last known index levels
        (clearly timestamped and freshness-labelled) instead of empty cards.
        """
        cached = self.store.load_quotes()
        with self.lock:
            for sym, q in cached.items():
                if sym in symbols.INDICES:
                    self.indices[sym] = validate.annotate(q, self.market)
                else:
                    self.quotes[sym] = validate.annotate(q, self.market)
            self.last_refresh = float(self.store.get_meta("last_refresh", 0) or 0)
            self.last_daily_sync = str(self.store.get_meta("last_daily_sync", "") or "")
        log.info("hydrated %d cached quotes (%d indices)",
                 len(cached), sum(1 for s in cached if s in symbols.INDICES))
        return len(cached)

    # -------------------------------------------------------- refresh tier --
    def featured(self) -> list[str]:
        """Indices + curated symbols: refreshed every cycle."""
        return sorted(set(symbols.INDEX_SYMBOL_LIST()) | set(symbols.curated()))

    def _wide_slice(self) -> list[str]:
        """A configurable slice of the remaining listing, refreshed slowly."""
        universe = symbols.symbols()
        if not universe:
            return []
        batch = max(1, config.SPARK_CHUNK * config.WIDE_PER_CYCLE)
        start = self._wide_cursor % len(universe)
        chunk = [universe[(start + i) % len(universe)] for i in range(min(batch, len(universe)))]
        self._wide_cursor = (start + len(chunk)) % len(universe)
        return chunk

    def refresh(self, wide: bool = True) -> dict[str, Any]:
        """One refresh cycle. Safe to call from the background thread."""
        t0 = time.time()
        errors: list[str] = []
        with self.lock:
            self.market = mcal.market_state()
            market = self.market
            self.status = self.chain.market_status() or self.status
            self._sync_holidays()
        try:
            fresh_indices = self.chain.indices()
        except Exception as exc:                     # noqa: BLE001
            fresh_indices, errors = {}, errors + [f"indices: {exc}"]
        try:
            targets = self.featured()
            if wide:
                targets += self._wide_slice()
            fresh_quotes = self.chain.quotes(targets)
        except Exception as exc:                     # noqa: BLE001
            fresh_quotes, errors = {}, errors + [f"quotes: {exc}"]

        with self.lock:
            for sym, q in fresh_indices.items():
                self.indices[sym] = validate.annotate(q, market, t0)
            for sym, q in fresh_quotes.items():
                if validate.is_available(q):
                    self.quotes[sym] = validate.annotate(q, market, t0)
            self.last_refresh = time.time()
            self.refresh_count += 1
            self.last_error = "; ".join(errors)[:300]
        self.store.save_quotes(fresh_indices)
        self.store.save_quotes({s: q for s, q in fresh_quotes.items()
                                if validate.is_available(q)})
        self.store.set_meta("last_refresh", self.last_refresh)
        if errors:
            log.warning("refresh issues: %s", self.last_error)
        # persist which provider answered, for the /api/meta transparency panel
        self.store.set_meta("providers", {"served": self.chain.served,
                                          "sourceLine": self.chain.source_line()})
        return {"ok": not errors, "refreshed": len(fresh_quotes) + len(fresh_indices),
                "errors": errors, "seconds": round(time.time() - t0, 2)}

    def _sync_holidays(self) -> None:
        """Refresh the exchange holiday list at most once a week."""
        if mcal._cache.get("fetched") and \
                time.time() - float(mcal._cache["fetched"]) < config.HOLIDAY_TTL:
            return
        rows = self.chain.holidays()
        if rows:
            mcal.apply_holiday_feed(rows, source="nse")

    # ------------------------------------------------------ on-demand data --
    def ensure_quotes(self, syms: Iterable[str],
                      max_age: float | None = None) -> dict[str, dict[str, Any]]:
        """Guarantee fresh-enough quotes for exactly these symbols.

        A request for symbols that are not cached (or whose cache entry is
        older than `max_age`) triggers a bounded, provider-arbitrated fetch
        instead of returning a hole — and never a made-up number.
        """
        max_age = config.QUOTES_TTL if max_age is None else max_age
        want = [s for s in dict.fromkeys(symbols.canonical(s) for s in syms) if s]
        now = time.time()
        with self.lock:
            market = self.market
            stale = [s for s in want
                     if s not in self.quotes or
                     (now - float(self.quotes[s].get("fetched") or 0)) > max_age]
        if stale:
            try:
                fresh = self.chain.quotes(stale)
            except Exception as exc:                 # noqa: BLE001
                fresh = {}
                self.last_error = f"on-demand quotes: {exc}"
            ok = {s: q for s, q in fresh.items() if validate.is_available(q)}
            if ok:
                with self.lock:
                    for sym, q in ok.items():
                        self.quotes[sym] = validate.annotate(q, market, now)
                self.store.save_quotes(ok)
        out: dict[str, dict[str, Any]] = {}
        with self.lock:
            for s in want:
                q = self.quotes.get(s) or self.indices.get(s)
                out[s] = validate.annotate(q, self.market, now) if q else \
                    validate.annotate(validate.unavailable_quote(
                        s, reason="provider has not returned this symbol yet"),
                        self.market, now)
        return out

    def ensure_history(self, sym: str, range_: str = "1Y",
                       max_age: float | None = None) -> dict[str, Any]:
        """Real OHLC series, or an explicit unavailable record."""
        sym = symbols.canonical(sym) or sym
        range_ = str(range_ or "1Y").upper()
        max_age = config.HISTORY_TTL if max_age is None else max_age
        cached = self.store.load_history(sym, range_, max_age)
        if cached:
            return cached
        fresh = self.chain.history(sym, range_)
        if not fresh:
            stale = self.store.load_history(sym, range_)     # serve, but flag it
            if stale:
                stale["stale"] = True
                stale["freshness"] = "STALE"
                return stale
            return {"sym": sym, "range": range_, "points": [], "candles": [],
                    "available": False, "source": "", "asOf": None,
                    "reason": "no price history available from the configured providers",
                    "provenance": {"points": "unavailable"}}
        fresh["available"] = True
        self.store.save_history(fresh)
        return fresh

    def ensure_fundamentals(self, sym: str) -> dict[str, Any]:
        """Real reported metrics, or N/A — never an estimate."""
        sym = symbols.canonical(sym) or sym
        cached = self.store.load_fundamentals(sym)
        if cached and cached.get("available"):
            return cached
        rec = self.chain.fundamentals(sym)
        if rec is None:
            rec = {"available": False, "source": "", "asOf": None, "metrics": {},
                   "unavailable": [], "provenance": {},
                   "reason": "no provider in the configured chain supplies fundamentals"}
        self.store.save_fundamentals(sym, rec)
        return rec

    # ---------------------------------------------------- derived statistics --
    def breadth(self, quoted: dict[str, dict[str, Any]],
                indices: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
        """Advance/decline and 52-week extremes, counted from real quotes only."""
        adv = dec = unch = 0
        high52 = low52 = 0
        volume = 0.0
        saw_volume = False       # a sum of nothing is unknown, not zero
        for q in quoted.values():
            pct = q.get("changePct")
            if pct is None or pct == 0:
                unch += 1
            elif pct > 0:
                adv += 1
            else:
                dec += 1
            hi, lo, price = q.get("high52"), q.get("low52"), q.get("price")
            if hi and price and price >= hi * 0.999:
                high52 += 1
            if lo and price and price <= lo * 1.001:
                low52 += 1
            if q.get("volume"):
                volume += float(q["volume"])
                saw_volume = True
        nifty = (indices or {}).get("NIFTY 50") or {}
        return {"advances": adv, "declines": dec, "unchanged": unch,
                "high52": high52, "low52": low52,
                "totalVolume": volume if saw_volume else None,
                "sampleSize": len(quoted),
                # NSE reports the official count for the index itself
                "niftyAdvances": nifty.get("advances"),
                "niftyDeclines": nifty.get("declines"),
                "niftyUnchanged": nifty.get("unchanged"),
                "basis": "tracked symbols with a real quote"}

    def movers(self, quoted: dict[str, dict[str, Any]], limit: int = 8) -> dict[str, Any]:
        """Gainers / losers / most active from real quotes only."""
        rows = [q for q in quoted.values()
                if validate.is_available(q) and q.get("changePct") is not None]

        def slim(q: dict[str, Any]) -> dict[str, Any]:
            m = symbols.meta(q["sym"])
            return {"symbol": q["sym"], "name": q.get("name") or m.get("name") or q["sym"],
                    "sector": m.get("sector") or "", "price": q.get("price"),
                    "changePct": q.get("changePct"), "change": q.get("change"),
                    "volume": q.get("volume"), "source": q.get("source"),
                    "asOf": q.get("asOf"), "freshness": q.get("freshness")}

        gain = sorted((q for q in rows if q["changePct"] > 0), key=lambda q: -q["changePct"])
        loss = sorted((q for q in rows if q["changePct"] < 0), key=lambda q: q["changePct"])
        active = sorted((q for q in rows if q.get("volume")), key=lambda q: -float(q["volume"]))
        return {"gainers": [slim(q) for q in gain[:limit]],
                "losers": [slim(q) for q in loss[:limit]],
                "active": [slim(q) for q in active[:limit]],
                "basis": f"top {limit} of {len(rows)} tracked quotes"}

    # ----------------------------------------------------------- payloads --
    def market_payload(self, include_history: bool = False,
                       history_syms: list[str] | None = None) -> dict[str, Any]:
        """The dashboard payload — identical in shape to the committed snapshot,
        so the static build and the live server cannot disagree about meaning."""
        now = time.time()
        with self.lock:
            market = dict(self.market)
            indices = {s: dict(q) for s, q in self.indices.items()}
            quotes = {s: dict(q) for s, q in self.quotes.items()}
            status = dict(self.status) if self.status else None
            last_refresh = self.last_refresh
        for s in symbols.INDEX_SYMBOL_LIST():
            indices.setdefault(s, validate.unavailable_quote(
                s, reason="index level not returned by provider"))
        universe = symbols.load_universe()
        quoted = {s: q for s, q in quotes.items()
                  if validate.is_available(q) and s in universe}
        payload: dict[str, Any] = {
            "schema": 2,
            "generatedAt": now,
            "asOf": max([q.get("asOf") or 0 for q in
                         list(quoted.values()) + list(indices.values())] or [0]) or None,
            "market": market,
            "source": {"providers": self.chain.providers_used(), "line": self.chain.source_line(),
                       "exchangeStatus": status},
            "indices": indices,
            "quotes": quoted,
            "breadth": self.breadth(quoted, indices),
            "movers": self.movers(quoted),
            "calendar": {"upcoming": mcal.calendar_payload(90)["holidays"][:10],
                         "holidaySource": mcal._cache.get("source", "seed")},
            "stats": {"quotesTracked": len(quoted), "universe": len(universe),
                      "cachedRows": self.store.quote_count(),
                      "lastRefresh": last_refresh, "refreshCount": self.refresh_count,
                      "lastError": self.last_error},
            "provenance": {"indices": "provider snapshot; change/% recomputed",
                           "quotes": "provider snapshot; change/% recomputed",
                           "breadth": "derived from tracked real quotes",
                           "movers": "derived from tracked real quotes",
                           "fundamentals": "provider-reported only; otherwise N/A"},
        }
        if include_history:
            hist: dict[str, Any] = {}
            for s in (history_syms or self.featured()):
                rec = self.ensure_history(s, "5Y")
                if rec.get("available"):
                    hist[s] = rec
            payload["history"] = hist
        return payload

    def quote_payload(self, syms: Iterable[str], max_age: float | None = None) -> dict[str, Any]:
        rows = self.ensure_quotes(syms, max_age)
        return {"schema": 2, "generatedAt": time.time(),
                "asOf": max([q.get("asOf") or 0 for q in rows.values()] or [0]) or None,
                "market": self.market, "quotes": rows,
                "source": {"providers": self.chain.providers_used(),
                           "line": self.chain.source_line()},
                "provenance": {"quotes": "provider snapshot; change/% recomputed"}}

    def history_payload(self, sym: str, range_: str = "1Y") -> dict[str, Any]:
        rec = self.ensure_history(sym, range_)
        rec.setdefault("available", bool(rec.get("points")))
        rec["market"] = self.market
        return rec

    def fundamentals_payload(self, sym: str) -> dict[str, Any]:
        rec = self.ensure_fundamentals(sym)
        rec["symbol"] = symbols.canonical(sym)
        rec["meta"] = symbols.meta(sym)
        rec["market"] = self.market
        return rec

    def health_payload(self) -> dict[str, Any]:
        with self.lock:
            market = dict(self.market)
        return {"ok": True, "now": time.time(), "market": market,
                "cache": self.store.stats(), "cooldownUntil": providers.GATE.until,
                "outboundCalls": providers.GATE.calls,
                "blockedCalls": providers.GATE.blocked,
                "lastRefresh": self.last_refresh, "lastError": self.last_error,
                "providers": self.chain.health(),
                "config": {"refreshInterval": config.MARKET_REFRESH_INTERVAL,
                           "closedRefreshInterval": config.CLOSED_REFRESH_INTERVAL,
                           "dailySync": config.DAILY_MARKET_SYNC,
                           "timezone": config.TIMEZONE,
                           "providerOrder": config.PROVIDER_ORDER,
                           "offline": config.OFFLINE}}

    # ---------------------------------------------------------- snapshot ----
    def snapshot_js(self, include_history: bool = True) -> str:
        """js/snapshot.js for hosts with no server (GitHub Pages, file://)."""
        payload = self.market_payload(include_history=include_history)
        payload["kind"] = "snapshot"
        body = json.dumps(payload, separators=(",", ":"), default=str)
        stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(payload["generatedAt"]))
        return ("/* Dalal static market snapshot — real provider data, no server needed.\n"
                f"   Generated {stamp} by `python3 server.py --snapshot`.\n"
                f"   Source: {self.chain.source_line()}.\n"
                "   Regenerated by .github/workflows/snapshot.yml; do not edit by hand. */\n"
                f"window.DALAL_SNAPSHOT = {body};\n")
