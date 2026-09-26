"""Indian market calendar — one place that decides whether NSE is open.

Rules implemented here (and nowhere else):

* timezone is Asia/Kolkata (never the host clock's timezone),
* equity session: pre-open 09:00–09:15, regular 09:15–15:30 IST,
* weekends are closed,
* NSE holidays come from NSE's own `holiday-master` feed, cached on disk and
  seeded with a committed copy so a static host without network access still
  knows the holidays,
* special (muhurat) sessions from the same feed are honoured as extra open
  windows rather than being treated as holidays.

The module is pure with respect to its inputs: pass `now` to test any instant.
"""
from __future__ import annotations

import datetime as dt
import json
import time
from typing import Any

from . import config

try:                                    # zoneinfo ships with Python 3.9+
    from zoneinfo import ZoneInfo

    IST = ZoneInfo("Asia/Kolkata")
except Exception:                       # pragma: no cover - exotic platforms
    IST = dt.timezone(dt.timedelta(hours=5, minutes=30), "IST")

SESSION_OPEN = dt.time(9, 15)
SESSION_CLOSE = dt.time(15, 30)
PRE_OPEN = dt.time(9, 0)
POST_CLOSE = dt.time(16, 0)

# Committed seed, replaced by NSE's feed when it is reachable. Kept minimal
# and obviously data-shaped so it can be reviewed in a diff.
FALLBACK_HOLIDAYS: dict[str, str] = {
    "2026-01-15": "Municipal Corporation Election - Maharashtra",
    "2026-01-26": "Republic Day",
    "2026-03-04": "Holi",
    "2026-03-26": "Ram Navami",
    "2026-03-31": "Mahavir Jayanti",
    "2026-04-03": "Good Friday",
    "2026-04-14": "Dr. Ambedkar Jayanti",
    "2026-05-01": "Maharashtra Day",
    "2026-08-26": "Ganesh Chaturthi",
    "2026-10-02": "Mahatma Gandhi Jayanti",
    "2026-10-20": "Dussehra",
    "2026-11-09": "Diwali Balipratipada",
    "2026-11-24": "Guru Nanak Jayanti",
    "2026-12-25": "Christmas",
}

_cache: dict[str, Any] = {"holidays": {}, "special": {}, "fetched": 0.0, "source": "seed"}


def now_ist(now: float | None = None) -> dt.datetime:
    """Current time in IST (or the supplied epoch seconds)."""
    return dt.datetime.fromtimestamp(now if now is not None else time.time(), IST)


def _load_seed() -> tuple[dict[str, str], dict[str, Any], float, str]:
    """Committed copy of NSE's calendar, if one was written out."""
    try:
        raw = json.loads(config.HOLIDAY_FILE.read_text(encoding="utf-8"))
        return (raw.get("holidays") or {}, raw.get("special") or {},
                float(raw.get("fetched") or 0), raw.get("source") or "seed")
    except (OSError, ValueError):
        return dict(FALLBACK_HOLIDAYS), {}, 0.0, "seed"


def holidays(refresh: bool = False) -> dict[str, str]:
    """{YYYY-MM-DD: description} of NSE trading holidays."""
    if not refresh and _cache["holidays"] and time.time() - _cache["fetched"] < config.HOLIDAY_TTL:
        return _cache["holidays"]
    if not _cache["holidays"]:
        h, special, fetched, source = _load_seed()
        _cache.update(holidays=h, special=special, fetched=fetched, source=source)
    return _cache["holidays"]


def apply_holiday_feed(rows: list[dict[str, Any]], source: str = "nse",
                       persist: bool = True) -> dict[str, str]:
    """Install a freshly fetched NSE holiday list (called by the provider).

    The feed wins for the dates it lists; anything it does not mention (a
    different year, or a seeded date while the feed is unreachable) is kept, so
    a partially-populated feed can never silently make a holiday tradable.
    Set persist=False in tests to avoid touching the committed seed file.
    """
    out: dict[str, str] = {}
    special: dict[str, Any] = {}
    for row in rows or []:
        raw = str(row.get("tradingDate") or "").strip()
        try:
            d = dt.datetime.strptime(raw, "%d-%b-%Y").date()
        except ValueError:
            continue
        key = d.isoformat()
        desc = (row.get("description") or "").strip() or "Holiday"
        morning, evening = row.get("morning_session"), row.get("evening_session")
        if morning or evening:
            # a special session: the exchange is shut, then reopens briefly
            special[key] = {"open": (morning or {}).get("startTime"),
                            "close": (morning or {}).get("endTime"),
                            "evening": evening}
        out[key] = desc
    if not out:
        return holidays()
    merged = dict(holidays())              # make sure the seed is loaded first
    merged.update(out)
    specials = dict(_cache.get("special") or {})
    specials.update(special)
    _cache.update(holidays=merged, special=specials, fetched=time.time(), source=source)
    if persist:
        try:
            config.HOLIDAY_FILE.write_text(json.dumps(
                {"fetched": _cache["fetched"], "source": source,
                 "holidays": merged, "special": specials}, indent=1), encoding="utf-8")
        except OSError:
            pass
    return merged


def reset_cache(holidays_map: dict[str, str] | None = None,
                special: dict[str, Any] | None = None, source: str = "seed") -> None:
    """Test/reload hook: replace the in-memory calendar without touching disk."""
    _cache.update(holidays=dict(holidays_map or {}), special=dict(special or {}),
                  fetched=time.time() if holidays_map else 0.0, source=source)


# ------------------------------------------------------------ trading days --
def is_weekend(d: dt.date) -> bool:
    return d.weekday() >= 5


def is_trading_day(d: dt.date, holiday_map: dict[str, str] | None = None) -> bool:
    hm = holidays() if holiday_map is None else holiday_map
    return not is_weekend(d) and d.isoformat() not in hm


def prev_trading_day(d: dt.date, holiday_map: dict[str, str] | None = None) -> dt.date:
    cur = d
    for _ in range(20):
        if is_trading_day(cur, holiday_map):
            return cur
        cur -= dt.timedelta(days=1)
    return d


def next_trading_day(d: dt.date, holiday_map: dict[str, str] | None = None) -> dt.date:
    cur = d
    for _ in range(20):
        if is_trading_day(cur, holiday_map):
            return cur
        cur += dt.timedelta(days=1)
    return d


def _at(d: dt.date, t: dt.time) -> dt.datetime:
    return dt.datetime.combine(d, t, tzinfo=IST)


def market_state(now: float | None = None) -> dict[str, Any]:
    """Everything the UI needs to describe the market right now."""
    t = now_ist(now)
    today, tt, hm = t.date(), t.time(), holidays()
    weekend = is_weekend(today)
    holiday_desc = hm.get(today.isoformat())
    special = _cache.get("special", {}).get(today.isoformat())

    state, reason, label = "CLOSED", "", "Market Closed"
    special_open = False
    if special:
        # A special (muhurat) session outranks the weekend/holiday closure:
        # the exchange does open, briefly, on that evening.
        try:
            o = dt.datetime.strptime(special.get("open"), "%H:%M").time() \
                if special.get("open") else None
            c = dt.datetime.strptime(special.get("close"), "%H:%M").time() \
                if special.get("close") else None
        except ValueError:
            o = c = None
        if o and c and o <= tt <= c:
            state, reason, label = "SPECIAL", holiday_desc or "", "Special session"
            special_open = True
        elif o:
            reason = f"special session {special.get('open')}–{special.get('close')} IST"
    if not special_open:
        # Order matters: a date the exchange itself lists as a holiday is
        # reported as HOLIDAY even when it also falls on a weekend, because
        # "Market Closed · Diwali Laxmi Pujan" tells the reader far more than
        # the generic "Weekend" does.
        if holiday_desc:
            state, reason, label = "HOLIDAY", holiday_desc, f"Market Closed · {holiday_desc}"
        elif weekend:
            state, reason, label = "WEEKEND", "Weekend", "Market Closed · Weekend"

    if state == "CLOSED":
        if PRE_OPEN <= tt < SESSION_OPEN:
            state, label, reason = "PRE_OPEN", "Pre-open", "Pre-open session"
        elif SESSION_OPEN <= tt <= SESSION_CLOSE:
            state, label, reason = "OPEN", "Market Open", ""
        elif tt < PRE_OPEN:
            reason = "Before session open"

    is_open = state in ("OPEN", "SPECIAL", "PRE_OPEN")
    trading_today = is_trading_day(today, hm)
    last_session = today if (trading_today and tt >= SESSION_CLOSE) \
        else prev_trading_day(today, hm)
    # "Next open" must always be in the future:
    #   still trading        -> the session after today
    #   trading day, pre-open-> today's own open
    #   trading day, after   -> the session after today
    #   weekend/holiday      -> the next trading day
    if is_open or (trading_today and tt > SESSION_OPEN):
        next_day = next_trading_day(today + dt.timedelta(days=1), hm)
    elif trading_today:
        next_day = today
    else:
        next_day = next_trading_day(today, hm)
    next_open = _at(next_day, SESSION_OPEN)

    return {
        "state": state,
        "label": label,
        "reason": reason,
        "isOpen": is_open,
        "isTradingDay": is_trading_day(today, hm),
        "timezone": str(config.TIMEZONE),
        "localTime": t.isoformat(timespec="seconds"),
        "tradeDate": last_session.isoformat(),
        "session": {"preOpen": PRE_OPEN.strftime("%H:%M"), "open": SESSION_OPEN.strftime("%H:%M"),
                    "close": SESSION_CLOSE.strftime("%H:%M"), "postClose": POST_CLOSE.strftime("%H:%M")},
        "nextOpen": int(next_open.timestamp()),
        "nextOpenLabel": next_open.strftime("%a %d %b, %H:%M IST"),
        "holidayToday": holiday_desc or "",
        "holidaySource": _cache.get("source", "seed"),
    }


def calendar_payload(days: int = 400, now: float | None = None) -> dict[str, Any]:
    """Upcoming + recent sessions and holidays, for the Market Calendar page."""
    t = now_ist(now)
    hm = holidays()
    horizon = t.date() + dt.timedelta(days=days)
    hols = sorted(({"date": k, "description": v} for k, v in hm.items()
                   if t.date() <= dt.date.fromisoformat(k) <= horizon),
                  key=lambda x: x["date"])
    sessions = []
    d = t.date()
    while d <= horizon and len(sessions) < days:
        if is_trading_day(d, hm):
            sessions.append(d.isoformat())
        d += dt.timedelta(days=1)
    return {"timezone": str(config.TIMEZONE), "source": _cache.get("source", "seed"),
            "fetched": _cache.get("fetched", 0), "holidays": hols,
            "sessions": sessions[:370], "state": market_state(now)}
