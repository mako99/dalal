# Dalal Market Data Architecture & Provider Specification

This document details the real-time Indian market data architecture for Dalal, provider capabilities, data freshness invariants, and deployment constraints.

---

## 1. System Architecture

```text
       ┌────────────────────────┐
       │     Market Provider    │
       │    (NSE / Yahoo / …)   │
       └───────────┬────────────┘
                   │ HTTPS REST
                   ▼
       ┌────────────────────────┐
       │   dalal/marketdata/    │
       │   ProviderChain        │
       └───────────┬────────────┘
                   │
         ┌─────────┴─────────┐
         ▼                   ▼
┌──────────────────┐  ┌──────────────────┐
│  Validation &    │  │  SQLite Cache /  │
│  Maths Engine    │  │  Store (dalal.db)│
│  (validate.py)   │  │  (store.py)      │
└────────┬─────────┘  └────────┬─────────┘
         └─────────┬───────────┘
                   ▼
         ┌───────────────────┐
         │     server.py     │
         │   (HTTP Server)   │
         └─────────┬─────────┘
                   │ REST API / Gzip
                   ▼
         ┌───────────────────┐
         │ Dalal Frontend UI │
         │ (GitHub Pages /   │
         │  Local Server)    │
         └───────────────────┘
```

---

## 2. Core Principle: Data Correctness & Honesty

1. **No Invented Numbers**:
   If an exchange or provider is offline or unreachable, Dalal returns `available: false` or shows `DATA UNAVAILABLE` with a stale status banner. It never invents, fakes, or mocks prices.
2. **Derived Maths**:
   The absolute price change and percentage change are always recomputed directly from the displayed price and the previous day's close:
   $$\text{change} = \text{price} - \text{prev\_close}$$
   $$\text{change\_p} = \left(\frac{\text{change}}{\text{prev\_close}}\right) \times 100$$
   Provider-reported percentage changes are not blindly trusted if they disagree with the price math.
3. **Transparent Freshness States**:
   - `LIVE`: During active session (09:15 - 15:30 IST) with quote age < 120 seconds.
   - `DELAYED`: Active session, quote age between 2 and 15 minutes.
   - `MARKET CLOSED`: Outside market trading hours or on exchange holidays. Displays timestamp of the final closing price.
   - `STALE`: Quotes older than expected or provider unavailable.

---

## 3. Data Providers & Capabilities

### Primary: Official NSE Provider (`NSEProvider`)
- **Source**: NSE India API & index feeds (`nsearchives.nseindia.com`).
- **Capabilities**:
  - Benchmark Index levels (`^NSEI`, `^NSEBANK`, `^CNXIT`, etc.).
  - Official Exchange Trading Session State (`Open`, `Pre-Open`, `Closed`).
  - Trading Holiday Calendar.
  - Official Equity List (`EQUITY_L.csv`) with ISIN and industry classifications.
- **Latency / Cadence**: Quotes updated during market hours; official closing prices generated after 15:30 IST.

### Secondary: Yahoo Finance (`YahooFinanceProvider`)
- **Source**: Yahoo Finance query API.
- **Capabilities**:
  - Real-time/15-minute delayed equity quotes (`.NS` tickers).
  - Historical OHLC candlestick and close series (1D, 5D, 1M, 6M, 1Y, 5Y).
  - Selected fundamentals (Market Cap, P/E, P/B, EPS, Dividend Yield).
- **Limitations**:
  - Rate limiting (HTTP 429 backoff implemented via cooldown in `config.py`).
  - No secret keys required or stored in frontend.

---

## 4. Environment Variables (`.env.example`)

```env
# Port for Dalal local HTTP API server
PORT=8000

# Provider configuration: comma-separated list in priority order
MARKET_PROVIDER=nse,yahoo

# Refresh interval (in seconds) during open market hours
MARKET_REFRESH_INTERVAL=60

# Timezone for market calendar
TIMEZONE=Asia/Kolkata

# Minimum gap between outgoing provider HTTP calls (rate limiting)
MARKET_MIN_GAP=1.2

# Cooldown period (in seconds) if HTTP 429 received
MARKET_COOLDOWN=300

# Offline mode (1 = disable external network calls, uses local snapshot/cache)
MARKET_OFFLINE=0

# SQLite cache file path
MARKET_DB=dalal.db
```

---

## 5. Deployment Options

### A. Static Deployment (GitHub Pages)
- Serves static assets (`index.html`, `css/styles.css`, `js/`).
- Market data is read from `js/snapshot.js`, which is updated automatically via GitHub Actions `.github/workflows/snapshot.yml` on a scheduled cron after every market session.
- No backend server or secrets needed on GitHub Pages.

### B. Live Server Deployment (Self-hosted or VPS)
- Run `python3 server.py --port 8000`.
- Periodically refreshes quotes during market hours.
- Handles `/api/market`, `/api/quotes`, `/api/history`, `/api/fundamentals`, `/api/calendar`, and `/api/health`.
- Enables live polling and on-demand quotes for the entire 2,500+ NSE universe.
