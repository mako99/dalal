# Dalal — Stock Analysis for the Indian Market

A fast, single-page stock-analysis website for Indian large caps, designed with
an Apple-inspired visual language (SF system fonts, translucent nav, hero
gradients, pill buttons, hairline cards).

> **Data notice** — prices and 5-year charts come from **real Yahoo Finance
> data** (live through `server.py`, or from the committed `js/snapshot.js`).
> Fundamentals, financials and analyst notes remain *illustrative* demo data.
> Not investment advice.

## Run it

Option 1 — with live data (recommended):

    python3 server.py
    # open http://localhost:8000

The bundled `server.py` serves the site and proxies Yahoo Finance. On boot it
replays whatever it cached last time from **`dalal.db`** (SQLite, auto-created,
git-ignored), so the page is useful before the first request goes out, and a
background thread keeps refreshing quotes and history so a page load never waits
on Yahoo. The badge on the ticker shows what you are looking at:

| Badge | Meaning |
|---|---|
| **LIVE** | `server.py` reached Yahoo Finance on its last pass |
| **CACHED** | real Yahoo numbers, served from the local cache / `js/snapshot.js` |
| **DEMO** | generated dataset — no Yahoo data available |

Option 2 — GitHub Pages or double-clicked `index.html` (no server):

    python3 server.py --snapshot --history   # refresh js/snapshot.js
    git add js/snapshot.js && git commit -m "data: refresh snapshot"

`js/snapshot.js` is committed generated data: the latest real quotes plus ~5
years of month-end closes for the featured names. The site loads it and shows
real prices and real charts, with the badge reading CACHED and the age of the
data in the tooltip. GitHub Actions regenerates it for you — see
`.github/workflows/snapshot.yml`, which runs the fetcher every two hours and
pushes the new file.

    python3 server.py --snapshot             # quotes + cached history
    python3 server.py --snapshot --history   # also refetch all 5y history

## Data pipeline

| Endpoint / file | What it does |
|---|---|
| `GET /api/quotes?s=…` | Quotes for the featured tier (or any symbols you ask for), served straight from `dalal.db` |
| `GET /api/history?s=TCS,SENSEX` | ~5y of month-end closes per symbol from the cache — the chart on a detail page uses this, so it needs no Yahoo round-trip |
| `GET /api/snapshot` | The same payload that is written to `js/snapshot.js` |
| `GET /api/universe` | NSE's full listing (cached in SQLite for a day) |
| `dalal.db` | SQLite cache: `quotes`, `history` and `listing`. A background thread loops every ~12 s — featured quotes each cycle plus three batches of the wide universe; history once a day |
| `js/snapshot.js` | Generated, committed fallback so static hosting still shows real data |

Yahoo rate-limits unauthenticated clients hard (HTTP 429), which is why the
server keeps its own clock, a shared cooldown across all callers, and prefers
`urllib` over `curl` — see `_http()` in `server.py`.

## What's inside

| File | Purpose |
|---|---|
| `index.html` | App shell: nav, search, ticker tape, footer |
| `css/styles.css` | Apple-style design system |
| `js/data.js` | Dataset: 13 curated NSE stocks (rich hand-written data) + 238-symbol sector table + 4 indices; auto-expands any symbol into a full record; 5 years of daily closes (Sep 2021 → Sep 2026), FY21–FY25 financials, 5-quarter shareholding, strengths/concerns |
| `js/universe_nse.js` | Generated from NSE's official EQUITY_L.csv — the complete board (2,578 securities), so every listed stock is searchable offline too (`python3 server.py --refresh-universe` regenerates it) |
| `js/charts.js` | Canvas chart engine: price chart (crosshair, volume, 50/200 DMA, normalized compare), donut, bar chart, sparklines |
| `js/app.js` | Hash-router SPA: Overview, Stock detail, Screener, Compare, Watchlist |
| `js/live.js` | Live overlay: polls `/api/quotes` every 15 s, pulls real history when you open a symbol, falls back to `js/snapshot.js`, patches prices/day-change into the dataset, LIVE/CACHED/DEMO badge |
| `js/snapshot.js` | **Generated** — real quotes + 5y history for the featured symbols, written by `server.py --snapshot` |
| `server.py` | Zero-dependency Python server: serves the site, proxies Yahoo Finance + NSE's listing, caches both in SQLite, refreshes in the background, and emits `js/snapshot.js`. Retry/backoff, shared 429 cooldown, per-tier pacing |


## Features

- **Overview** — Nifty 50 / Sensex / Bank Nifty / Nifty IT cards with sparklines, top gainers & losers, toolkit tiles
- **Stock page** — 5-year interactive chart (1M–5Y ranges, MA / Volume / vs-Nifty toggles), Dalal Score (composite of 6 factors), 12 key ratios, returns bars (1W→5Y), income statement FY21–FY25, PAT trend chart, shareholding pattern table + donut, strengths & things-to-watch
- **Screener** — filter by search, sector, P/E range, min dividend yield, watchlist-only; sortable columns
- **Compare** — up to 5 instruments, metric table with best-value highlighting, normalized performance chart
- **Watchlist** — star any stock; persists via localStorage
- **Search** — press `/` anywhere; live results across the full ~250-symbol universe (stocks + indices)

## The universe

**Every listed stock is on the list.** `js/data.js` carries a curated core
(13 hand-written records + a 238-symbol table across 19 sectors), and
`js/universe_nse.js` — generated from NSE's official *EQUITY_L.csv* listing —
adds the **complete NSE board (2,578 securities: EQ, BE and BZ series)**, so
the app covers **2,584 stocks + 4 indices** (~2,588 instruments).

- The 13 flagship stocks have rich hand-written data.
- Every other symbol is expanded at load time into a complete record — price
  history, ratios, FY21–FY25 financials, shareholding, strengths/concerns —
  generated deterministically from the symbol, so it's identical on every
  load. Those fundamentals are *illustrative*; prices become real when
  `server.py` is running (the server tracks all 2,584 symbols).
- Full listing load costs ~1 s of page boot and ~130 MB of memory; the
  screener shows the first 300 matches with a *show all* link, and the tape
  shows a 64-symbol slice (search covers everything).

To refresh the listing when NSE changes it:

    python3 server.py --refresh-universe

This re-downloads EQUITY_L.csv, updates the cache and regenerates
`js/universe_nse.js`. Adding a stock by hand is still possible: append
`["SYMBOL", "Company Name", "Sector"],` to `UNIVERSE_META` in `js/data.js`.

## Swapping the data source

`js/live.js` overlays real data onto the generated dataset in this order:

1. `/api/quotes` from `server.py` (queried every 15 s) — replaces price, day
   change and previous close for every symbol the server knows.
2. `/api/history?s=SYMBOL` — when you open a symbol, its real month-end closes
   replace the generated path (log-linear interpolation onto the daily grid, so
   1M/1Y/5Y ranges and the MAs stay coherent).
3. `js/snapshot.js` — the same two things, baked at build time, when no server
   is reachable (GitHub Pages, `file://`).
4. The generated dataset, last resort, labelled DEMO.

To use a different provider, keep the shape the server already returns —
`{"quotes": {"SYM": {"price", "prevClose", "changePct", "time"}}}` and
`{"history": {"SYM": [["2026-09-25", 123.4], ...]}}` — and everything else in
the app works unchanged.
