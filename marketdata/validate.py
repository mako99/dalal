"""Quote validation and normalisation.

Every price that reaches the UI passes through here. The rules:

* a quote with no usable price is *unavailable* — not zero, not yesterday's
  number quietly re-labelled as today's;
* change and change % are always recomputed from (price, previousClose) so a
  percentage can never disagree with the two prices it is displayed beside;
* a move beyond `SANE_MOVE_PCT` is flagged rather than shown as a normal day;
* every quote carries the timestamp it belongs to, the provider that produced
  it, and a freshness verdict, so the UI can say "as of" and "stale" honestly.
"""
from __future__ import annotations

import math
import time
from typing import Any

from . import config

FRESHNESS = ("LIVE", "DELAYED", "CLOSED", "STALE", "UNAVAILABLE")


def num(value: Any) -> float | None:
    """float or None — never NaN/Inf, never a string that merely looks numeric."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        f = float(value)
    elif isinstance(value, str):
        try:
            f = float(value.replace(",", "").replace("₹", "").strip())
        except ValueError:
            return None
    else:
        return None
    return f if math.isfinite(f) else None


def positive(value: Any) -> float | None:
    f = num(value)
    return f if (f is not None and f > 0) else None


def derive_change(price: Any, prev_close: Any) -> tuple[float | None, float | None]:
    """change and change % from the same two prices the UI prints."""
    p, prev = num(price), num(prev_close)
    if p is None or prev in (None, 0):
        return None, None
    change = round(p - prev, 4)
    return change, round(change / prev * 100, 6)


def unavailable_quote(sym: str, reason: str = "no data", source: str = "",
                      fetched: float | None = None) -> dict[str, Any]:
    """An explicit hole in the data. The UI renders this as "Data unavailable"."""
    return {"sym": sym, "price": None, "prevClose": None, "change": None,
            "changePct": None, "volume": None, "dayHigh": None, "dayLow": None,
            "high52": None, "low52": None, "name": "", "exchange": "",
            "currency": "INR", "asOf": None, "fetched": float(fetched or 0),
            "source": source, "reason": reason, "flags": ["unavailable"],
            "provenance": {k: "unavailable" for k in
                           ("price", "prevClose", "change", "changePct", "volume",
                            "high52", "low52")}}


def make_quote(sym: str, *, price: Any, prev_close: Any = None,
               change_pct: Any = None, volume: Any = None, day_high: Any = None,
               day_low: Any = None, high_52: Any = None, low_52: Any = None,
               name: str = "", exchange: str = "", currency: str = "INR",
               as_of: Any = None, fetched: float | None = None, source: str = "",
               delayed: bool = False, extra: dict | None = None) -> dict[str, Any]:
    """Normalise one provider quote. Returns an *unavailable* record when the
    provider did not give a usable price — callers must not invent one."""
    p = positive(price)
    if p is None:
        return unavailable_quote(sym, reason="provider returned no usable price",
                                 source=source, fetched=fetched)
    prev = positive(prev_close)
    change, pct = derive_change(p, prev)
    if pct is None:                      # no previous close: fall back to the provider %
        pct = num(change_pct)
        prev = None if pct is not None else prev
    flags: list[str] = []
    if pct is not None and abs(pct) > config.SANE_MOVE_PCT:
        flags.append("large-move")
    q = {
        "sym": sym,
        "price": round(p, 4),
        "prevClose": prev,
        "change": change,
        "changePct": pct,
        "volume": num(volume),
        "dayHigh": positive(day_high),
        "dayLow": positive(day_low),
        "high52": positive(high_52),
        "low52": positive(low_52),
        "name": name or "",
        "exchange": exchange or "",
        "currency": currency or "INR",
        "asOf": float(num(as_of) or fetched or time.time()),
        "fetched": float(fetched or time.time()),
        "source": source,
        "delayed": bool(delayed),
        "flags": flags,
        "provenance": {
            "price": f"provider:{source}" if source else "provider",
            "prevClose": "provider" if prev is not None else "unavailable",
            "change": "derived" if change is not None else "unavailable",
            "changePct": "derived" if (change is not None and prev) else "provider",
            "volume": "provider" if volume is not None else "unavailable",
            "high52": "provider" if high_52 is not None else "unavailable",
            "low52": "provider" if low_52 is not None else "unavailable",
        },
    }
    if extra:
        q.update(extra)
    return q


def is_available(q: dict[str, Any] | None) -> bool:
    return bool(q) and positive(q.get("price")) is not None


def as_of_date(as_of: Any) -> str:
    """IST calendar date of a quote timestamp ('2026-09-25')."""
    import datetime as dt
    from .calendar import IST
    ts = num(as_of)
    if ts is None:
        return ""
    try:
        return dt.datetime.fromtimestamp(ts, IST).date().isoformat()
    except (OverflowError, OSError, ValueError):
        return ""


def freshness(q: dict[str, Any] | None, market: dict[str, Any] | None = None,
              now: float | None = None) -> str:
    """LIVE / DELAYED / CLOSED / STALE / UNAVAILABLE for one quote.

    "Stale" means *older than the latest completed session* — a value from the
    last close while the market is shut is "CLOSED", which is the honest label
    for it, not a warning.
    """
    if not is_available(q):
        return "UNAVAILABLE"
    t = now if now is not None else time.time()
    market = market or {}
    age = t - float(q.get("asOf") or 0)
    trade_date = str(market.get("tradeDate") or "")
    if trade_date:
        if as_of_date(q.get("asOf")) >= trade_date:
            if market.get("isOpen"):
                return "LIVE" if age <= config.DELAYED_AFTER else "DELAYED"
            return "CLOSED"
        return "STALE"
    if age > config.STALE_AFTER:
        return "STALE"
    if market.get("isOpen"):
        return "LIVE" if age <= config.DELAYED_AFTER else "DELAYED"
    return "CLOSED"


def annotate(q: dict[str, Any] | None, market: dict[str, Any] | None = None,
             now: float | None = None) -> dict[str, Any]:
    """Add age/freshness so one payload can drive every status badge."""
    t = now if now is not None else time.time()
    if not q:
        return annotate(unavailable_quote(""), market, t)
    q = dict(q)
    # Enforce the module's core invariant for *every* payload path (providers,
    # cache, snapshot): the change a user reads is the difference between the
    # two prices printed next to it. A cached row that stored no `change`, or a
    # provider percentage that disagrees with its own prices, is corrected here
    # rather than shown.
    if positive(q.get("price")) is not None and positive(q.get("prevClose")) is not None:
        change, pct = derive_change(q.get("price"), q.get("prevClose"))
        q["change"], q["changePct"] = change, pct
    q["age"] = int(max(0, t - float(q.get("asOf") or t)))
    q["freshness"] = freshness(q, market, t)
    q["stale"] = q["freshness"] in ("STALE", "DELAYED")
    return q


def human_age(seconds: Any) -> str:
    """'2h 14m ago' — the wording the UI uses next to cached values."""
    s = num(seconds)
    if s is None:
        return "unknown"
    s = int(max(0, s))
    if s < 60:
        return f"{s}s ago"
    if s < 3600:
        return f"{s // 60}m ago"
    if s < 86400:
        return f"{s // 3600}h {(s % 3600) // 60}m ago"
    return f"{s // 86400}d {(s % 86400) // 3600}h ago"
