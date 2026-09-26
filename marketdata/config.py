"""Central configuration for the Dalal market-data layer.

Everything tunable lives here and is read from the environment once at
import time, so there is exactly one place to look when behaviour has to
change between a laptop, a server and a CI runner.

    MARKET_PROVIDER=yahoo,nse      provider order (first working one wins)
    MARKET_REFRESH_INTERVAL=300    seconds between open-market refresh cycles
    DAILY_MARKET_SYNC=15:45        IST time for the post-close daily sync
    TIMEZONE=Asia/Kolkata          market timezone
    PORT=8000                      HTTP port of server.py
    MARKET_MIN_GAP=1.2             seconds between outbound provider calls
    MARKET_COOLDOWN=300            seconds to back off after HTTP 429
    MARKET_OFFLINE=1               never touch the network (tests, CI smoke)
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("MARKET_DB") or (ROOT / "dalal.db"))
SNAPSHOT_FILE = ROOT / "js" / "snapshot.js"
UNIVERSE_FILE = ROOT / "universe_nse.json"
HOLIDAY_FILE = ROOT / "holidays_nse.json"


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _order(name: str, default: str) -> list[str]:
    raw = os.environ.get(name, default) or ""
    return [p.strip().lower() for p in raw.split(",") if p.strip()]


# --- hosting / time ---------------------------------------------------------
PORT = _int("PORT", 8000)
TIMEZONE = os.environ.get("TIMEZONE", "Asia/Kolkata")

# --- providers --------------------------------------------------------------
# NSE first: it is the exchange itself, so its index levels, holiday calendar
# and equity snapshots are authoritative. Yahoo is the fallback (and the only
# source of Sensex and of deep price history).
PROVIDER_ORDER = _order("MARKET_PROVIDER", "nse,yahoo")
OFFLINE = _flag("MARKET_OFFLINE", False)
MIN_GAP = _float("MARKET_MIN_GAP", 1.2)
COOLDOWN = _float("MARKET_COOLDOWN", 300.0)
HOST_TIMEOUT = _float("MARKET_TIMEOUT", 12.0)
MAX_RETRIES = _int("MARKET_RETRIES", 2)

# --- refresh policy ---------------------------------------------------------
MARKET_REFRESH_INTERVAL = _int("MARKET_REFRESH_INTERVAL", 300)   # open market
CLOSED_REFRESH_INTERVAL = _int("MARKET_CLOSED_REFRESH_INTERVAL", 1800)
DAILY_MARKET_SYNC = os.environ.get("DAILY_MARKET_SYNC", "15:45")
DAILY_SYNC_SLACK_MIN = _int("DAILY_SYNC_SLACK_MIN", 20)          # run window

# --- cache TTLs -------------------------------------------------------------
QUOTES_TTL = _int("MARKET_QUOTE_TTL", 25)        # seconds a cached quote may serve
INDEX_TTL = _int("MARKET_INDEX_TTL", 60)
HISTORY_TTL = _int("MARKET_HISTORY_TTL", 86400)  # a day: daily closes move once
UNIVERSE_TTL = _int("MARKET_UNIVERSE_TTL", 604800)
HOLIDAY_TTL = _int("MARKET_HOLIDAY_TTL", 604800)
SNAPSHOT_EVERY = _int("MARKET_SNAPSHOT_EVERY", 1800)
COOKIE_TTL = _int("MARKET_COOKIE_TTL", 900)      # NSE session refresh

# --- honesty thresholds -----------------------------------------------------
# A move this large is far more likely to be a bad print than a real move, so
# it is flagged (never silently shown as a normal day).
SANE_MOVE_PCT = _float("MARKET_SANE_MOVE_PCT", 25.0)
DELAYED_AFTER = _int("MARKET_DELAYED_AFTER", 900)   # 15 min: intraday lag
STALE_AFTER = _int("MARKET_STALE_AFTER", 86400)     # >1 day: show as stale

# --- universe tiers ---------------------------------------------------------
# The featured tier is fetched symbol-by-symbol (accurate change % + 52w range)
# every cycle; the wide tier is filled from bulk index/market snapshots.
SPARK_CHUNK = _int("MARKET_BATCH_SIZE", 50)
WIDE_PER_CYCLE = _int("MARKET_WIDE_PER_CYCLE", 3)
