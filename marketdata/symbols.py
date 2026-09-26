"""The single place that knows what a Dalal symbol *is*.

Nothing else in the codebase hardcodes a ticker string. A caller works with a
canonical symbol ("RELIANCE", "NIFTY 50") and asks this module for the
provider-specific ticker, so provider quirks live in exactly one file:

    NSE    -> "RELIANCE"            (and "NIFTY 50" as an index label)
    Yahoo  -> "RELIANCE.NS"         (indices keep their ^-prefixed tickers)
    BSE    -> "RELIANCE.BO"

load_universe() reads the same js/data.js + js/universe_nse.js the website
ships with, so the server tracks exactly what the UI can display.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from . import config

INDEX_BY_PROVIDER: dict[str, str] = {}
SYM_RE = re.compile(r"^[A-Z0-9&.\-]{1,24}$")


def _index(sym, name, full, yahoo, nse_index, exchange, color) -> dict[str, Any]:
    return {"sym": sym, "name": name, "full": full, "yahoo": yahoo,
            "nse_index": nse_index, "exchange": exchange, "color": color,
            "kind": "index"}


# Canonical index registry. `nse_index` is the exact label NSE uses in
# /api/allIndices, so index levels are matched without guessing.
INDICES: dict[str, dict[str, Any]] = {
    ix["sym"]: ix for ix in (
        _index("NIFTY 50", "Nifty 50", "NSE Benchmark · 50 companies",
               "^NSEI", "NIFTY 50", "NSE", "#0071e3"),
        _index("SENSEX", "BSE Sensex", "BSE Benchmark · 30 companies",
               "^BSESN", None, "BSE", "#5856d6"),
        _index("BANKNIFTY", "Nifty Bank", "Banking benchmark · 12 banks",
               "^NSEBANK", "NIFTY BANK", "NSE", "#30d158"),
        _index("NIFTY IT", "Nifty IT", "Technology benchmark · 10 companies",
               "^CNXIT", "NIFTY IT", "NSE", "#ff9f0a"),
        _index("NIFTY MIDCAP", "Nifty Midcap 50", "Mid-cap benchmark · 50 companies",
               "^NSEMDCP50", "NIFTY MIDCAP 50", "NSE", "#bf5af2"),
        _index("NIFTY NEXT 50", "Nifty Next 50", "Emerging large caps · 50 companies",
               "^NSMIDCP", "NIFTY NEXT 50", "NSE", "#64d2ff"),
        _index("INDIA VIX", "India VIX", "NSE volatility index",
               "^INDIAVIX", "INDIA VIX", "NSE", "#ff375f"),
    )
}
INDEX_BY_PROVIDER.update({v["yahoo"]: k for k, v in INDICES.items()})
INDEX_BY_PROVIDER.update(
    {v["nse_index"]: k for k, v in INDICES.items() if v["nse_index"]})

ALIASES = {
    "BANK NIFTY": "BANKNIFTY", "NIFTY BANK": "BANKNIFTY", "NIFTYBANK": "BANKNIFTY",
    "NIFTY": "NIFTY 50", "NIFTY50": "NIFTY 50", "NSEI": "NIFTY 50",
    "SENSEX 30": "SENSEX", "BSESN": "SENSEX", "BSE SENSEX": "SENSEX",
    "NIFTYIT": "NIFTY IT", "CNXIT": "NIFTY IT", "MIDCAP": "NIFTY MIDCAP",
    "VIX": "INDIA VIX", "INDIAVIX": "INDIA VIX",
}


def canonical(raw: str) -> str:
    """Normalise UI input to a canonical key ("reliance" -> "RELIANCE").

    Accepts RELIANCE.NS/RELIANCE.BO, ^NSEI/^BSESN, "Nifty Bank" and friends.
    Returns "" when the input cannot be a symbol.
    """
    if not raw:
        return ""
    s = str(raw).strip().upper()
    if s in INDICES:
        return s
    for suffix in (".NS", ".BO", ".NSE", ".BSE"):
        if s.endswith(suffix):
            s = s[: -len(suffix)]
            break
    s = s.lstrip("^")
    s = ALIASES.get(s, s)
    if s in INDICES or s in INDEX_BY_PROVIDER:
        return INDEX_BY_PROVIDER.get(s, s)
    return s if SYM_RE.match(s) else ""


def yahoo_ticker(sym: str) -> str:
    c = canonical(sym)
    if not c:
        return ""
    return INDICES[c]["yahoo"] if c in INDICES else c + ".NS"


def bse_ticker(sym: str) -> str:
    c = canonical(sym)
    return "" if (not c or c in INDICES) else c + ".BO"



def is_index(sym: str) -> bool:
    return canonical(sym) in INDICES


def nse_index_label(sym: str) -> str:
    return INDICES.get(canonical(sym), {}).get("nse_index") or ""


def meta(sym: str) -> dict[str, Any]:
    """Static metadata for one symbol — names and sectors, never prices."""
    c = canonical(sym)
    if not c:
        return {}
    if c in INDICES:
        return dict(INDICES[c])
    u = load_universe().get(c) or {}
    return {"sym": c, "name": u.get("name") or c, "sector": u.get("sector") or "",
            "exchange": "NSE", "kind": "equity"}


# ---------------------------------------------------------------- universe --
def read_text(path: Path) -> str:
    """File contents, or "" — a missing metadata file is not an error."""
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def _rows_after(src: str, marker: str = "") -> list[Any]:
    """The JSON array assigned to `marker` (or the first array) in a file.

    ``json.JSONDecoder.raw_decode`` is used rather than slicing to the last
    ``]`` because a generated file may hold more than one array — slicing to the
    last bracket would merge js/data/curated.js's two arrays into invalid JSON.
    """
    i = src.find(marker) if marker else 0
    if i == -1:
        return []
    start = src.find("[", i)
    if start == -1:
        return []
    try:
        rows, _ = json.JSONDecoder().raw_decode(src[start:])
    except ValueError:
        return []
    return rows if isinstance(rows, list) else []


def _meta_from_rows(rows: list[Any]) -> dict[str, dict[str, Any]]:
    """[["SYM", "Company Name", "Sector"], …] -> {SYM: {name, sector}}."""
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, list) or len(row) < 2:
            continue
        sym = str(row[0]).strip().upper()
        if SYM_RE.match(sym):
            out[sym] = {"name": str(row[1]), "sector": str(row[2]) if len(row) > 2 else ""}
    return out


@lru_cache(maxsize=1)
def load_universe() -> dict[str, dict[str, Any]]:
    """{SYM: {name, sector}} for every symbol the site can show.

    Curated records come from js/data.js (they carry a sector); the rest come
    from js/universe_nse.js — NSE's own EQUITY_L.csv listing.
    """
    out: dict[str, dict[str, Any]] = {}
    root: Path = config.ROOT
    # 1. hand-maintained metadata: symbol, company name, sector
    out.update(_meta_from_rows(_rows_after(
        read_text(root / "js" / "data" / "curated.js"), "DALAL_CURATED_META")))
    # 2. the complete listing NSE itself publishes (symbol + company name)
    for sym, rec in _meta_from_rows(_rows_after(
            read_text(root / "js" / "universe_nse.js"), "DALAL_NSE_UNIVERSE")).items():
        out.setdefault(sym, rec)
    for sym in INDICES:
        out.pop(sym, None)          # indices are not equities
    return out


def symbols() -> list[str]:
    return sorted(load_universe())


def INDEX_SYMBOL_LIST() -> list[str]:
    """Canonical keys of every tracked index (see INDICES)."""
    return list(INDICES)


@lru_cache(maxsize=1)
def curated() -> list[str]:
    """The hand-maintained flagship symbols listed in js/data/curated.js.

    These are the ones the dashboard shows by default, so they are refreshed
    every cycle; the rest of the listing is refreshed in slow background sweeps
    and on demand.
    """
    src = read_text(config.ROOT / "js" / "data" / "curated.js")
    found = {canonical(m) for m in _rows_after(src, "DALAL_CURATED =") if isinstance(m, str)}
    return sorted(s for s in found if s and s not in INDICES)


def search(query: str, limit: int = 12) -> list[dict[str, Any]]:
    """Ranked search: exact ticker, ticker prefix, name prefix, name contains."""
    q = (query or "").strip().upper()
    if not q:
        return []
    universe = load_universe()
    buckets: list[list[tuple[str, dict[str, Any]]]] = [[], [], [], []]
    for sym, rec in universe.items():
        name = (rec.get("name") or "").upper()
        if sym == q:
            buckets[0].append((sym, rec))
        elif sym.startswith(q):
            buckets[1].append((sym, rec))
        elif name.startswith(q):
            buckets[2].append((sym, rec))
        elif q in name:
            buckets[3].append((sym, rec))
    out: list[dict[str, Any]] = []
    for bucket in buckets:
        for sym, rec in sorted(bucket):
            out.append({"symbol": sym, "name": rec.get("name") or sym,
                        "sector": rec.get("sector") or "", "exchange": "NSE",
                        "kind": "equity"})
            if len(out) >= limit:
                return out
    return out


def nse_index_label(sym: str) -> str:
    return INDICES.get(canonical(sym), {}).get("nse_index") or ""
