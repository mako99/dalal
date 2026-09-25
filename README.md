# Dalal — Stock Analysis for the Indian Market

A fast, single-page stock-analysis website for Indian large caps, designed with
an Apple-inspired visual language (SF system fonts, translucent nav, hero
gradients, pill buttons, hairline cards).

> **Data notice** — with `server.py` running, *prices* update in real time
> from Yahoo Finance. Fundamentals, financials and analyst notes remain
> *illustrative* demo data. Not investment advice.

## Run it

Option 1 — with live data (recommended):

    python3 server.py
    # open http://localhost:8000

The bundled `server.py` serves the site and proxies real-time prices from
Yahoo Finance at `/api/quotes`. Prices, day change and the ticker tape then
update live (polled every 15 s) — a LIVE/DEMO badge on the ticker shows the
feed status. Fundamentals and financials remain illustrative demo data.

Option 2 — just open the file (demo data only):

    double-click index.html  (or: xdg-open index.html)

No build step, no dependencies, works offline.

## What's inside

| File | Purpose |
|---|---|
| `index.html` | App shell: nav, search, ticker tape, footer |
| `css/styles.css` | Apple-style design system |
| `js/data.js` | Dataset: 13 curated NSE stocks (rich hand-written data) + 238-symbol sector table + 4 indices; auto-expands any symbol into a full record; 5 years of daily closes (Sep 2021 → Sep 2026), FY21–FY25 financials, 5-quarter shareholding, strengths/concerns |
| `js/universe_nse.js` | Generated from NSE's official EQUITY_L.csv — the complete board (2,578 securities), so every listed stock is searchable offline too (`python3 server.py --refresh-universe` regenerates it) |
| `js/charts.js` | Canvas chart engine: price chart (crosshair, volume, 50/200 DMA, normalized compare), donut, bar chart, sparklines |
| `js/app.js` | Hash-router SPA: Overview, Stock detail, Screener, Compare, Watchlist |
| `js/live.js` | Live overlay: polls `/api/quotes` every 15 s, patches prices/day-change into the dataset, rebuilds ticker + current view, LIVE/DEMO badge |
| `server.py` | Zero-dependency Python server: serves the site + `/api/quotes` and `/api/universe` proxies to Yahoo Finance and NSE's official listing. Tier 1 polls indices + curated stocks per-symbol; tier 2 refreshes all 2,584 symbols in batched calls. Includes retry/backoff, 429 cooldown and caching |

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

## Plugging in live data

`server.py` already proxies live quotes into the dataset at runtime (see
`js/live.js`). To point at another source, keep the `close` (array of numbers)
+ `stats` shape and the rest of the app works unchanged.
