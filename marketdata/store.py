"""SQLite cache — the last known good values.

The cache exists so that (a) a restart starts warm and (b) a provider outage
degrades to clearly-labelled stale data instead of to nothing at all. Every
row carries the timestamp the value belongs to *and* the time it was fetched,
because those are different things and the UI shows both.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from . import validate

log = logging.getLogger("dalal.store")

SCHEMA = """
CREATE TABLE IF NOT EXISTS quotes(
  sym TEXT PRIMARY KEY, price REAL, prev_close REAL, change REAL, change_pct REAL,
  volume REAL, day_high REAL, day_low REAL, high52 REAL, low52 REAL,
  as_of REAL, fetched REAL, source TEXT, extra TEXT);
CREATE TABLE IF NOT EXISTS history(
  sym TEXT, range TEXT, payload TEXT, fetched REAL, source TEXT,
  PRIMARY KEY(sym, range));
CREATE TABLE IF NOT EXISTS fundamentals(
  sym TEXT PRIMARY KEY, payload TEXT, fetched REAL, source TEXT, available INTEGER);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
"""


class Store:
    def __init__(self, path: Path | str) -> None:
        self.path = str(path)
        self._lock = threading.RLock()
        self._conn: sqlite3.Connection | None = None

    # -- plumbing -----------------------------------------------------------
    #: every column the current schema expects in `quotes`
    QUOTE_COLUMNS = (("price", "REAL"), ("prev_close", "REAL"), ("change", "REAL"),
                     ("change_pct", "REAL"), ("volume", "REAL"), ("day_high", "REAL"),
                     ("day_low", "REAL"), ("high52", "REAL"), ("low52", "REAL"),
                     ("as_of", "REAL"), ("fetched", "REAL"), ("source", "TEXT"),
                     ("extra", "TEXT"))

    def _db(self) -> sqlite3.Connection:
        if self._conn is None:
            conn = sqlite3.connect(self.path, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            self._conn = conn
            try:
                conn.executescript(SCHEMA)
                self._migrate()
                conn.commit()
            except sqlite3.Error as exc:
                log.error("store init failed on %s: %s", self.path, exc)
                conn.rollback()
        return self._conn

    def _migrate(self) -> None:
        """Upgrade a database written by an older Dalal release in place.

        Deployment reality: an existing host already has a dalal.db from the
        previous schema (quotes had no volume, 52-week range or timestamps).
        Adding the missing columns keeps that warm cache instead of discarding
        it, and backfills the timestamps from the legacy `ts` column so cached
        values are still aged honestly.
        """
        assert self._conn is not None
        cols = {r["name"] for r in self._conn.execute("PRAGMA table_info(quotes)")}
        if cols:
            for name, decl in self.QUOTE_COLUMNS:
                if name not in cols:
                    self._conn.execute(f"ALTER TABLE quotes ADD COLUMN {name} {decl}")
            if "ts" in cols:               # legacy timestamp column
                self._conn.execute("UPDATE quotes SET as_of=ts WHERE as_of IS NULL")
                self._conn.execute("UPDATE quotes SET fetched=ts WHERE fetched IS NULL")
            self._conn.execute("UPDATE quotes SET source='legacy-cache' "
                               "WHERE source IS NULL")
        hcols = {r["name"] for r in self._conn.execute("PRAGMA table_info(history)")}
        if hcols and "payload" not in hcols:
            # legacy history stored one month-end series per symbol with no
            # range; it is cheap to refetch, so replace the table rather than guess
            self._conn.execute("DROP TABLE history")
            self._conn.executescript(SCHEMA)

    def execute(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            try:
                cur = self._db().execute(sql, args)
                rows = cur.fetchall()
                self._db().commit()
                return rows
            except sqlite3.Error as exc:
                # never silent: a swallowed error here once hid a bad migration
                log.warning("sqlite error (%s): %s", exc, sql.split("(")[0][:60])
                try:
                    self._db().rollback()
                except sqlite3.Error:
                    pass
                return []

    # -- quotes -------------------------------------------------------------
    def save_quotes(self, quotes: dict[str, dict[str, Any]]) -> int:
        rows = []
        for sym, q in quotes.items():
            if not validate.is_available(q):
                continue                      # never cache a hole as if it were data
            rows.append((sym, q.get("price"), q.get("prevClose"), q.get("change"),
                         q.get("changePct"), q.get("volume"), q.get("dayHigh"),
                         q.get("dayLow"), q.get("high52"), q.get("low52"),
                         q.get("asOf"), q.get("fetched") or time.time(),
                         q.get("source") or "", json.dumps(
                             {k: v for k, v in q.items()
                              if k in ("name", "exchange", "currency", "marketState",
                                       "advances", "declines", "unchanged", "variation",
                                       "fundamentals", "flags")})))
        if not rows:
            return 0
        with self._lock:
            try:
                self._db().executemany(
                    "INSERT OR REPLACE INTO quotes(sym, price, prev_close, change,"
                    " change_pct, volume, day_high, day_low, high52, low52, as_of,"
                    " fetched, source, extra) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
                self._db().commit()
            except sqlite3.Error:
                return 0
        return len(rows)

    def load_quotes(self, max_age: float | None = None) -> dict[str, dict[str, Any]]:
        rows = self.execute("SELECT * FROM quotes")
        out: dict[str, dict[str, Any]] = {}
        now = time.time()
        for r in rows:
            if max_age is not None and now - (r["fetched"] or 0) > max_age:
                continue
            try:
                extra = json.loads(r["extra"] or "{}")
            except ValueError:
                extra = {}
            q = {"sym": r["sym"], "price": r["price"], "prevClose": r["prev_close"],
                 "change": r["change"], "changePct": r["change_pct"],
                 "volume": r["volume"], "dayHigh": r["day_high"], "dayLow": r["day_low"],
                 "high52": r["high52"], "low52": r["low52"], "asOf": r["as_of"],
                 "fetched": r["fetched"], "source": (r["source"] or "") + "+cache",
                 "flags": ["cached"], "provenance": {"price": "cache"}}
            q.update(extra)
            if validate.is_available(q):
                out[q["sym"]] = q
        return out

    def quote_count(self) -> int:
        rows = self.execute("SELECT COUNT(*) c FROM quotes")
        return int(rows[0]["c"]) if rows else 0

    # -- history ------------------------------------------------------------
    def save_history(self, rec: dict[str, Any]) -> None:
        if not rec.get("points"):
            return
        self.execute("INSERT OR REPLACE INTO history(sym, range, payload, fetched,"
                     " source) VALUES(?,?,?,?,?)",
                     (rec["sym"], rec["range"], json.dumps(rec), time.time(),
                      rec.get("source") or ""))

    def load_history(self, sym: str, range_: str,
                     max_age: float | None = None) -> dict[str, Any] | None:
        rows = self.execute("SELECT payload, fetched FROM history WHERE sym=? AND range=?",
                            (sym, range_))
        if not rows:
            return None
        if max_age is not None and time.time() - (rows[0]["fetched"] or 0) > max_age:
            return None
        try:
            rec = json.loads(rows[0]["payload"])
        except ValueError:
            return None
        rec["fromCache"] = True
        return rec

    # -- fundamentals -------------------------------------------------------
    def save_fundamentals(self, sym: str, rec: dict[str, Any]) -> None:
        self.execute("INSERT OR REPLACE INTO fundamentals(sym, payload, fetched,"
                     " source, available) VALUES(?,?,?,?,?)",
                     (sym, json.dumps(rec), time.time(), rec.get("source") or "",
                      1 if rec.get("available") else 0))

    def load_fundamentals(self, sym: str) -> dict[str, Any] | None:
        rows = self.execute("SELECT payload FROM fundamentals WHERE sym=?", (sym,))
        if not rows:
            return None
        try:
            return json.loads(rows[0]["payload"])
        except ValueError:
            return None

    # -- misc ---------------------------------------------------------------
    def set_meta(self, key: str, value: Any) -> None:
        self.execute("INSERT OR REPLACE INTO meta(k, v) VALUES(?,?)",
                     (key, json.dumps(value)))

    def get_meta(self, key: str, default: Any = None) -> Any:
        rows = self.execute("SELECT v FROM meta WHERE k=?", (key,))
        if not rows:
            return default
        try:
            return json.loads(rows[0]["v"])
        except ValueError:
            return default

    def stats(self) -> dict[str, Any]:
        def count(table: str) -> int:
            rows = self.execute(f"SELECT COUNT(*) c FROM {table}")
            return int(rows[0]["c"]) if rows else 0
        return {"path": self.path, "quotes": count("quotes"),
                "history": count("history"), "fundamentals": count("fundamentals")}
