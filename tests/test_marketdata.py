"""Tests for the market-data layer: the calculations the site depends on.

Run:  python3 -m unittest discover -s tests -v
      MARKET_OFFLINE=1 python3 -m unittest discover -s tests

No network access is required — every provider call is stubbed.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("MARKET_OFFLINE", "1")
os.environ["MARKET_DB"] = str(Path(tempfile.gettempdir()) / "dalal_test.db")

from marketdata import calendar as mcal        # noqa: E402
from marketdata import config, providers, service, store, symbols, validate  # noqa: E402


class TestChangeMaths(unittest.TestCase):
    """spec §31: the displayed % must come from the displayed prices."""

    def test_spec_example(self):
        change, pct = validate.derive_change(74200, 74000)
        self.assertEqual(change, 200.0)
        self.assertAlmostEqual(pct, 0.27027, places=5)
        self.assertEqual(round(pct, 2), 0.27)

    def test_zero_and_missing_previous_close(self):
        self.assertEqual(validate.derive_change(100, 0), (None, None))
        self.assertEqual(validate.derive_change(100, None), (None, None))
        self.assertEqual(validate.derive_change(None, 100), (None, None))

    def test_negative_move(self):
        change, pct = validate.derive_change(98, 100)
        self.assertEqual(change, -2.0)
        self.assertEqual(pct, -2.0)

    def test_percentage_is_recomputed_not_trusted(self):
        """A wrong provider % must not survive: price/prevClose win."""
        q = validate.make_quote("X", price=110, prev_close=100, change_pct=99.0,
                                source="test")
        self.assertEqual(q["price"], 110)
        self.assertEqual(q["changePct"], 10.0)
        self.assertEqual(q["provenance"]["changePct"], "derived")

    def test_nan_and_junk_are_not_numbers(self):
        for junk in (None, "abc", float("nan"), float("inf"), True):
            self.assertIsNone(validate.num(junk), msg=repr(junk))
        self.assertEqual(validate.num("1,234.5"), 1234.5)


class TestQuoteValidation(unittest.TestCase):
    """spec §24/§32: a missing price is unavailable, never a fake zero."""

    def test_missing_price_is_unavailable(self):
        q = validate.make_quote("X", price=None, source="test")
        self.assertFalse(validate.is_available(q))
        self.assertIsNone(q["price"])
        self.assertEqual(q["flags"], ["unavailable"])
        self.assertEqual(validate.freshness(q), "UNAVAILABLE")
        self.assertEqual(q["provenance"]["price"], "unavailable")

    def test_zero_and_negative_prices_rejected(self):
        for bad in (0, -5, "n/a", ""):
            self.assertFalse(validate.is_available(
                validate.make_quote("X", price=bad, source="test")))

    def test_large_move_is_flagged_not_hidden(self):
        q = validate.make_quote("X", price=200, prev_close=100, source="test")
        self.assertEqual(q["changePct"], 100.0)
        self.assertIn("large-move", q["flags"])
        self.assertIsNotNone(q["price"])          # shown, but flagged

    def test_sane_quote_has_no_flags(self):
        q = validate.make_quote("X", price=101, prev_close=100, volume=10,
                                high_52=120, low_52=80, source="test")
        self.assertEqual(q["flags"], [])
        self.assertEqual(q["provenance"]["change"], "derived")
        self.assertEqual(q["provenance"]["high52"], "provider")
        self.assertEqual(q["provenance"]["volume"], "provider")


class TestFreshness(unittest.TestCase):
    """spec §2/§20: stale data must never look live."""

    def setUp(self):
        self.now = time.time()

    def quote(self, age: int):
        return validate.make_quote("X", price=100, prev_close=99, source="test",
                                   as_of=self.now - age)

    def test_open_market_live_then_delayed(self):
        open_market = {"isOpen": True}
        self.assertEqual(validate.freshness(self.quote(30), open_market, self.now), "LIVE")
        self.assertEqual(validate.freshness(self.quote(3600), open_market, self.now),
                         "DELAYED")

    def test_closed_market_is_closed_not_live(self):
        self.assertEqual(validate.freshness(self.quote(7200), {"isOpen": False},
                                            self.now), "CLOSED")

    def test_yesterday_is_stale(self):
        self.assertEqual(validate.freshness(self.quote(3 * 86400), {"isOpen": True},
                                            self.now), "STALE")

    def test_annotate_marks_cached_data(self):
        q = validate.annotate(self.quote(3 * 86400), {"isOpen": False}, self.now)
        self.assertTrue(q["stale"])
        self.assertTrue(q["age"] >= 3 * 86400 - 5)
        self.assertEqual(q["freshness"], "STALE")

    def test_human_age_wording(self):
        self.assertEqual(validate.human_age(30), "30s ago")
        self.assertEqual(validate.human_age(180), "3m ago")
        self.assertEqual(validate.human_age(8040), "2h 14m ago")


class TestSymbols(unittest.TestCase):
    """spec §7: one mapping, used by search, charts, compare and the API."""

    def test_canonical_forms(self):
        cases = {"reliance": "RELIANCE", "RELIANCE.NS": "RELIANCE",
                 "RELIANCE.BO": "RELIANCE", "^NSEI": "NIFTY 50",
                 "^BSESN": "SENSEX", "bank nifty": "BANKNIFTY",
                 "nifty": "NIFTY 50", "RELIANCE.NSE": "RELIANCE"}
        for raw, want in cases.items():
            self.assertEqual(symbols.canonical(raw), want, msg=raw)

    def test_rejects_non_symbols(self):
        for bad in ("", "   ", "DROP TABLE quotes;", "RELIANCE/NS"):
            self.assertEqual(symbols.canonical(bad), "", msg=repr(bad))

    def test_provider_tickers(self):
        self.assertEqual(symbols.yahoo_ticker("reliance"), "RELIANCE.NS")
        self.assertEqual(symbols.yahoo_ticker("SENSEX"), "^BSESN")
        self.assertEqual(symbols.bse_ticker("RELIANCE"), "RELIANCE.BO")
        self.assertEqual(symbols.bse_ticker("SENSEX"), "")   # an index, not an equity
        self.assertEqual(symbols.nse_index_label("BANKNIFTY"), "NIFTY BANK")

    def test_index_detection(self):
        self.assertTrue(symbols.is_index("NIFTY 50"))
        self.assertFalse(symbols.is_index("RELIANCE"))
        self.assertNotIn("NIFTY 50", symbols.load_universe())

    def test_search_ranks_exact_then_prefix(self):
        results = [r["symbol"] for r in symbols.search("reliance")]
        self.assertEqual(results[0], "RELIANCE")

    def test_search_by_company_name(self):
        self.assertIn("TCS", [r["symbol"] for r in symbols.search("tata consultancy")])

    def test_meta_never_contains_prices(self):
        for sym in ("RELIANCE", "NIFTY 50"):
            m = symbols.meta(sym)
            self.assertNotIn("price", m)
            self.assertNotIn("last", m)


class TestMarketCalendar(unittest.TestCase):
    """spec §6: Asia/Kolkata sessions, weekends, NSE holidays, special sessions."""

    def setUp(self):
        # Hermetic: snapshot the in-memory calendar and never write the seed file.
        self._saved = (dict(mcal._cache["holidays"]), dict(mcal._cache["special"]),
                       mcal._cache["fetched"], mcal._cache["source"])

    def tearDown(self):
        (hols, special, fetched, source) = self._saved
        mcal._cache.update(holidays=hols, special=special, fetched=fetched,
                           source=source)

    def state(self, iso: str, hh: int, mm: int) -> dict:
        when = dt.datetime.fromisoformat(f"{iso}T{hh:02d}:{mm:02d}:00+05:30")
        return mcal.market_state(when.timestamp())

    def test_open_during_session(self):
        st = self.state("2026-09-23", 11, 30)          # Wednesday
        self.assertEqual(st["state"], "OPEN")
        self.assertTrue(st["isOpen"])
        self.assertEqual(st["tradeDate"], "2026-09-23")

    def test_pre_open_window(self):
        st = self.state("2026-09-23", 9, 5)
        self.assertEqual(st["state"], "PRE_OPEN")
        self.assertTrue(st["isOpen"])

    def test_before_and_after_session(self):
        self.assertEqual(self.state("2026-09-23", 8, 0)["state"], "CLOSED")
        after = self.state("2026-09-23", 16, 0)
        self.assertEqual(after["state"], "CLOSED")
        self.assertEqual(after["tradeDate"], "2026-09-23")   # today's close counts

    def test_weekend_is_closed_and_points_at_friday(self):
        st = self.state("2026-09-26", 12, 0)           # Saturday
        self.assertEqual(st["state"], "WEEKEND")
        self.assertFalse(st["isOpen"])
        self.assertEqual(st["tradeDate"], "2026-09-25")
        self.assertIn("Mon 28 Sep", st["nextOpenLabel"])

    def test_holiday_is_closed_not_open(self):
        st = self.state("2026-01-26", 11, 0)           # Republic Day (Monday)
        self.assertEqual(st["state"], "HOLIDAY")
        self.assertIn("Republic Day", st["label"])
        self.assertFalse(st["isTradingDay"])

    def test_trading_day_is_not_a_naive_weekday_check(self):
        self.assertFalse(mcal.is_trading_day(dt.date(2026, 1, 26)))   # holiday
        self.assertFalse(mcal.is_trading_day(dt.date(2026, 9, 26)))   # Saturday
        self.assertTrue(mcal.is_trading_day(dt.date(2026, 9, 25)))    # Friday

    def test_next_open_skips_weekend_and_holiday(self):
        self.assertEqual(self.state("2026-09-25", 16, 0)["nextOpenLabel"],
                         "Mon 28 Sep, 09:15 IST")
        # Fri 23 Jan 2026 after close -> Mon 26 Jan is a holiday -> Tue 27 Jan
        self.assertIn("27 Jan", self.state("2026-01-23", 16, 0)["nextOpenLabel"])

    def test_holiday_feed_ingestion_keeps_special_sessions(self):
        rows = [{"tradingDate": "08-Nov-2026", "description": "Diwali Laxmi Pujan",
                 "morning_session": {"startTime": "18:15", "endTime": "19:15"}}]
        feed = mcal.apply_holiday_feed(rows, source="test", persist=False)
        self.assertEqual(feed.get("2026-11-08"), "Diwali Laxmi Pujan")
        # the feed must not drop holidays it did not mention
        self.assertIn("2026-01-26", feed)
        self.assertEqual(mcal._cache["special"]["2026-11-08"]["open"], "18:15")
        # a muhurat session is open inside its window, closed outside it
        self.assertEqual(self.state("2026-11-08", 18, 45)["state"], "SPECIAL")
        self.assertEqual(self.state("2026-11-08", 12, 0)["state"], "HOLIDAY")

    def test_empty_feed_does_not_wipe_the_calendar(self):
        before = mcal.holidays()
        mcal.apply_holiday_feed([], source="test", persist=False)
        self.assertEqual(mcal.holidays(), before)


class TestStore(unittest.TestCase):
    """The cache round-trips values and never caches a hole as data."""

    def setUp(self):
        self.path = Path(tempfile.gettempdir()) / f"dalal_test_{time.time_ns()}.db"
        self.store = store.Store(self.path)

    def tearDown(self):
        if self.store._conn:
            self.store._conn.close()
        Path(self.path).unlink(missing_ok=True)

    def test_quote_round_trip(self):
        q = validate.make_quote("RELIANCE", price=1226.0, prev_close=1219.2,
                                volume=13108409, high_52=1611.8, low_52=1210.5,
                                source="yahoo", as_of=time.time())
        self.store.save_quotes({"RELIANCE": q})
        back = self.store.load_quotes()["RELIANCE"]
        self.assertEqual(back["price"], 1226.0)
        self.assertEqual(back["prevClose"], 1219.2)
        self.assertAlmostEqual(back["changePct"], 0.5577, places=4)
        self.assertIn("cache", back["source"])

    def test_unavailable_quote_is_not_cached(self):
        self.store.save_quotes({"BOGUS": validate.unavailable_quote("BOGUS")})
        self.assertEqual(self.store.load_quotes(), {})

    def test_history_round_trip_and_max_age(self):
        self.store.save_history({"sym": "TCS", "range": "5Y", "source": "yahoo",
                                 "points": [["2021-09-24", 3400.0],
                                            ["2026-09-24", 3100.0]]})
        got = self.store.load_history("TCS", "5Y", max_age=60)
        self.assertEqual(len(got["points"]), 2)
        self.assertTrue(got["fromCache"])
        self.assertIsNone(self.store.load_history("TCS", "5Y", max_age=-1))

    def test_meta_round_trip(self):
        self.store.set_meta("last_daily_sync", "2026-09-25")
        self.assertEqual(self.store.get_meta("last_daily_sync"), "2026-09-25")
        self.assertEqual(self.store.get_meta("missing", "fallback"), "fallback")


class _Stub(providers.MarketDataProvider):
    """A provider that either answers or fails, on demand."""

    name = "stub"

    def __init__(self, label: str, fail: bool = False, price: float | None = 100.0):
        self.name = label
        self.fail = fail
        self.price = price
        self.calls = 0

    def quotes(self, syms):
        self.calls += 1
        if self.fail:
            raise providers.ProviderError(f"{self.name} is down")
        out = {}
        for s in syms:
            sym = symbols.canonical(s)
            out[sym] = (validate.make_quote(sym, price=self.price, prev_close=99,
                                            source=self.name, as_of=time.time())
                        if self.price else validate.unavailable_quote(sym))
        return out


class _RateLimitedStub(_Stub):
    def quotes(self, syms):
        self.calls += 1
        raise providers.RateLimited("429")


class TestProviderChainFailures(unittest.TestCase):
    """spec §21: failure degrades down the chain, never into a fake price."""

    def test_second_provider_fills_the_gap(self):
        bad, good = _Stub("bad", fail=True), _Stub("good", price=101.0)
        chain = providers.ProviderChain(instances=[bad, good])
        out = chain.quotes(["RELIANCE"])
        self.assertEqual(out["RELIANCE"]["price"], 101.0)
        self.assertEqual(out["RELIANCE"]["source"], "good")
        self.assertTrue(chain.errors)
        self.assertIn("bad", chain.errors[0])

    def test_no_provider_leaves_a_hole_not_a_number(self):
        chain = providers.ProviderChain(instances=[_Stub("bad", fail=True)])
        self.assertEqual(chain.quotes(["RELIANCE"]), {})

    def test_rate_limit_stops_hammering_further_providers(self):
        slow, other = _RateLimitedStub("slow"), _Stub("other", price=50.0)
        chain = providers.ProviderChain(instances=[slow, other])
        chain.quotes(["RELIANCE"])
        self.assertEqual(slow.calls, 1)
        self.assertEqual(other.calls, 0)          # global cooldown respected

    def test_missing_capability_returns_none(self):
        chain = providers.ProviderChain(instances=[_Stub("stub")])
        self.assertIsNone(chain.history("RELIANCE", "1Y"))
        self.assertIsNone(chain.holidays())
        self.assertIsNone(chain.market_status())


class TestServiceWithNoProviders(unittest.TestCase):
    """An offline/failing deployment must say "unavailable", never invent."""

    def setUp(self):
        self.path = Path(tempfile.gettempdir()) / f"dalal_svc_{time.time_ns()}.db"
        self.svc = service.MarketService(
            store=store.Store(self.path),
            chain=providers.ProviderChain(instances=[_Stub("dead", fail=True)]))

    def tearDown(self):
        if self.svc.store._conn:
            self.svc.store._conn.close()
        Path(self.path).unlink(missing_ok=True)

    def test_quotes_payload_marks_unavailable(self):
        payload = self.svc.quote_payload(["RELIANCE", "TCS"])
        for sym in ("RELIANCE", "TCS"):
            q = payload["quotes"][sym]
            self.assertIsNone(q["price"])
            self.assertEqual(q["freshness"], "UNAVAILABLE")
            self.assertTrue(q["reason"])
        self.assertIn("provenance", payload)

    def test_market_payload_shape_and_honesty(self):
        payload = self.svc.market_payload()
        self.assertEqual(payload["schema"], 2)
        self.assertEqual(set(payload["indices"]), set(symbols.INDEX_SYMBOL_LIST()))
        for q in payload["indices"].values():
            self.assertIsNone(q["price"])              # nothing fetched: no numbers
            self.assertIsNotNone(q["reason"])
        self.assertEqual(payload["quotes"], {})
        self.assertEqual(payload["breadth"]["sampleSize"], 0)
        self.assertEqual(payload["movers"]["gainers"], [])
        self.assertIn("line", payload["source"])
        self.assertIn("provenance", payload)

    def test_history_and_fundamentals_unavailable(self):
        rec = self.svc.history_payload("RELIANCE", "1Y")
        self.assertFalse(rec["available"])
        self.assertEqual(rec["points"], [])
        self.assertEqual(rec["provenance"]["points"], "unavailable")
        f = self.svc.fundamentals_payload("RELIANCE")
        self.assertFalse(f["available"])
        self.assertEqual(f["metrics"], {})
        self.assertTrue(f["reason"])

    def test_snapshot_js_is_valid_javascript(self):
        js = self.svc.snapshot_js(include_history=False)
        self.assertTrue(js.startswith("/*"))
        self.assertIn("window.DALAL_SNAPSHOT = ", js)
        body = js.split("window.DALAL_SNAPSHOT = ", 1)[1].rstrip().rstrip(";")
        payload = json.loads(body)
        self.assertEqual(payload["schema"], 2)
        self.assertEqual(payload["kind"], "snapshot")
        self.assertIn("market", payload)


class TestMarketPayloadWithData(unittest.TestCase):
    """With real-looking quotes, breadth and movers are derived, not copied."""

    def setUp(self):
        self.path = Path(tempfile.gettempdir()) / f"dalal_data_{time.time_ns()}.db"
        self.svc = service.MarketService(store=store.Store(self.path),
                                         chain=providers.ProviderChain(instances=[]))
        now = time.time()
        self.svc.quotes.update({
            "RELIANCE": validate.make_quote("RELIANCE", price=1226.0, prev_close=1219.2,
                                            volume=13_000_000, high_52=1226.0,
                                            low_52=1210.5, source="test", as_of=now),
            "TCS": validate.make_quote("TCS", price=3100.0, prev_close=3200.0,
                                       volume=2_000_000, high_52=4600.0, low_52=3000.0,
                                       source="test", as_of=now),
            "INFY": validate.make_quote("INFY", price=1500.0, prev_close=1500.0,
                                        volume=500_000, source="test", as_of=now),
        })
        self.svc.indices["NIFTY 50"] = validate.make_quote(
            "NIFTY 50", price=23140.5, prev_close=23063.1, source="nse", as_of=now,
            extra={"advances": 34, "declines": 15, "unchanged": 1})

    def tearDown(self):
        if self.svc.store._conn:
            self.svc.store._conn.close()
        Path(self.path).unlink(missing_ok=True)

    def test_breadth_is_derived_from_real_quotes(self):
        b = self.svc.market_payload()["breadth"]
        self.assertEqual((b["advances"], b["declines"], b["unchanged"]), (1, 1, 1))
        self.assertEqual(b["high52"], 1)               # RELIANCE at its 52w high
        self.assertEqual(b["niftyAdvances"], 34)       # official NSE count kept

    def test_movers_are_sorted_by_real_change(self):
        m = self.svc.market_payload()["movers"]
        self.assertEqual([r["symbol"] for r in m["gainers"]], ["RELIANCE"])
        self.assertEqual([r["symbol"] for r in m["losers"]], ["TCS"])
        self.assertEqual(m["active"][0]["symbol"], "RELIANCE")

    def test_change_matches_the_prices_beside_it(self):
        q = self.svc.market_payload()["quotes"]["TCS"]
        self.assertAlmostEqual(q["change"], -100.0)
        self.assertAlmostEqual(q["changePct"], -3.125)
        self.assertAlmostEqual(q["change"] / q["prevClose"] * 100, q["changePct"], places=3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
