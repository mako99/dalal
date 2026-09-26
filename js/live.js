/* ============================================================
   Dalal — live data overlay
   Three layers, best available wins:
     1. /api/quotes  (server.py → Yahoo Finance proxy), polled every 15s
     2. /api/history (real 5y month-end closes) for the symbol you open
     3. js/snapshot.js — real data committed by "python3 server.py --snapshot"
   With none of them (GitHub Pages, or index.html opened from disk with no
   server running) the generated demo dataset is used and the badge reads DEMO.
   ============================================================ */
(function () {
  "use strict";
  const D = window.DALAL;
  if (!D || !window.fetch) return;

  /* Opened straight from disk? Then relative /api/... paths would resolve
     against the filesystem, so talk to the bundled server instead — it
     replies with CORS headers, so the browser allows it. */
  const API = (location.protocol === "http:" || location.protocol === "https:")
    ? "" : "http://localhost:8000";

  const SNAP = window.DALAL_SNAPSHOT || null;   // written by server.py
  const TICKER_MAX = 64;  // keep the tape light once the universe is thousands strong
  let state = "demo";     // demo | cached | live
  let snapApplied = false;
  let hasReal = false;      // any real (Yahoo) number painted yet
  const askedHistory = new Set();   // symbols we already pulled real history for

  /* how many instruments the tape shows: indices first, then the core names */
  function tickerItems() {
    const items = D.INDICES.concat(D.STOCKS);
    return items.length > TICKER_MAX ? items.slice(0, TICKER_MAX) : items;
  }

  function fetchJSON(url) {
    return fetch(url, { cache: "no-store" })
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); });
  }

  /* ---- real closes onto the demo trading-day grid (log-linear) ---- */
  function resample(points) {
    const dates = D.DATES, out = new Array(dates.length);
    let i = 0, prev = points[0][1], prevDate = points[0][0];
    for (let k = 0; k < dates.length; k++) {
      const d = dates[k];
      while (i + 1 < points.length && points[i + 1][0] <= d) {
        i++; prev = points[i][1]; prevDate = points[i][0];
      }
      const nx = points[i + 1];
      if (!nx || nx[0] <= d) { out[k] = prev; continue; }   // before 1st / after last point
      const span = Date.parse(nx[0]) - Date.parse(prevDate);
      const t = span > 0 ? (Date.parse(d) - Date.parse(prevDate)) / span : 0;
      out[k] = Math.round(Math.exp(
        Math.log(prev) + (Math.log(nx[1]) - Math.log(prev)) * Math.max(0, Math.min(1, t))) * 100) / 100;
    }
    return out;
  }

  /* Replace a generated path with the real one (monthly points → daily grid). */
  function applyHistory(hist) {
    let changed = false;
    Object.keys(hist || {}).forEach(sym => {
      const pts = hist[sym];
      if (!Array.isArray(pts) || pts.length < 12) return;
      const item = D.bySymbol(sym) || D.indexBySymbol(sym);
      if (!item || !item.close || !item.close.length || item.real) return;
      item.close = resample(pts);
      item.stats = D.statsFor(item.close);
      item.real = true;
      changed = true;
    });
    if (changed) seeded();
    return changed;
  }

  function seeded() { hasReal = true; if (state === "demo") state = "cached"; }

  /* ---- live quotes onto the same dataset ---- */
  function apply(quotes) {
    let changed = false;
    Object.keys(quotes || {}).forEach(sym => {
      const q = quotes[sym];
      if (!q || typeof q.price !== "number") return;
      const item = D.bySymbol(sym) || D.indexBySymbol(sym);
      if (!item || !item.close || !item.close.length) return;

      const series = item.close;
      const samePrice = item.live === true && series[series.length - 1] === q.price;
      const lastDemo = series[series.length - 1];
      // prefer the real previous close; fall back to the previous grid point
      const base = (typeof q.prevClose === "number" && q.prevClose > 0) ? q.prevClose : lastDemo;
      const pct = base > 0 ? (q.price - base) / base * 100
                           : (typeof q.changePct === "number" ? q.changePct : 0);

      series[series.length - 1] = q.price;      // last point becomes the live price
      item.stats = D.statsFor(series);
      item.stats.last = q.price;
      item.stats.day = {
        chg: (typeof q.change === "number") ? q.change : q.price - base,
        pct: pct
      };
      item.live = true;
      if (!samePrice) changed = true;           // skip re-render when nothing moved
    });
    if (changed) seeded();
    return changed;
  }

  function rerender() {
    // ticker tape
    const ticker = document.querySelector("#ticker .ticker-track");
    if (ticker) {
      const items = tickerItems();
      const one = items.map(ix => {
        const c = ix.stats.day.pct;
        const cls = c >= 0 ? "up" : "down";
        return `<span class="tk"><b>${ix.sym}</b><span class="num">${ix.stats.last.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span><span class="tk-chg ${cls}">${c >= 0 ? "▲" : "▼"} ${Math.abs(c).toFixed(2)}%</span><span class="dot"></span></span>`;
      }).join("");
      ticker.innerHTML = one + one;
      // keep the scroll speed steady however long the track is
      try {
        ticker.style.animationDuration = Math.max(45, Math.round(ticker.scrollWidth / 110)) + "s";
      } catch (e) { /* layout not available */ }
    }
    // current page — route() scrolls to top, so restore the user's position
    if (typeof window.DALAL_REROUTE === "function") {
      const y = window.scrollY || 0;
      try { window.DALAL_REROUTE(); window.scrollTo(0, y); } catch (e) { /* mid-navigation race */ }
    }
  }

  /* ---- pull the complete NSE listing once (server.py /api/universe) ---- */
  function loadFullUniverse() {
    fetchJSON(API + "/api/universe")
      .then(j => {
        if (!j || !j.symbols || !j.symbols.length) return;
        const added = D.extendUniverse(j.symbols);
        if (added) {
          rerender();          // rebuild the tape + current view with the new list
          setBadge(state);     // refresh the tooltip count
        }
      })
      .catch(() => { /* offline / demo mode */ });
  }

  /* ---- symbols the page you are looking at needs in order to be right ---- */
  function viewSymbols() {
    const parts = (location.hash || "#/").replace(/^#\//, "").split("/").map(decodeURIComponent);
    if (parts[0] === "stock" || parts[0] === "index") {
      return parts[1] ? [parts[1].toUpperCase()] : [];
    }
    if (parts[0] === "compare") {
      return parts.slice(1).filter(Boolean).map(s => s.replace(/\+/g, " ").toUpperCase());
    }
    return [];
  }

  /* Deep-linked page for a symbol the background refresher has not reached:
     ask for its quote and its real 5y history directly. */
  function upgradeView() {
    const syms = viewSymbols().filter(s => D.bySymbol(s) || D.indexBySymbol(s));
    if (!syms.length) return;
    fetchJSON(API + "/api/quotes?s=" + encodeURIComponent(syms.join(",")))
      .then(j => { if (apply(j.quotes || {})) rerender(); })
      .catch(() => { /* offline */ });
    syms.forEach(sym => {
      if (askedHistory.has(sym)) return;
      askedHistory.add(sym);
      fetchJSON(API + "/api/history?s=" + encodeURIComponent(sym))
        .then(j => { if (applyHistory(j.history || {})) rerender(); })
        .catch(() => { askedHistory.delete(sym); });
    });
  }

  /* ---- committed snapshot: real numbers with no server running ---- */
  function useSnapshot() {
    if (!SNAP) return false;
    let changed = false;
    if (applyHistory(SNAP.history)) changed = true;
    if (apply(SNAP.quotes)) changed = true;
    if (changed) snapApplied = true;
    return changed;
  }

  function tick() {
    fetchJSON(API + "/api/quotes")
      .then(j => {
        const n = Object.keys(j.quotes || {}).length;
        if (apply(j.quotes || {})) rerender();
        // j.live: the server reached Yahoo Finance on its last pass. Age alone
        // says nothing — after a closed session the newest trade is hours old.
        if (n && j.live) setBadge("live", j.age);
        else if (n) setBadge("cached", j.age);
        else setBadge(hasReal ? "cached" : "demo");
      })
      .catch(() => setBadge(hasReal ? "cached" : "demo"));
  }

  function ago(secs) {
    const mins = Math.max(0, Math.round(secs / 60));
    return mins < 90 ? " · " + mins + " min ago" : " · " + Math.round(mins / 60) + " h ago";
  }

  /* badge: LIVE (server is answering with Yahoo data) / CACHED (real Yahoo
     numbers, but server.py is not running) / DEMO (generated dataset) */
  function setBadge(next, age) {
    if (next) state = next;
    let when = "";
    if (state !== "live") {
      const secs = typeof age === "number" ? age
        : (snapApplied && SNAP && SNAP.fetched)
          ? (Date.now() - SNAP.fetched * 1000) / 1000 : null;
      if (secs !== null) when = ago(secs);
    }
    const dot = state === "live" ? "#30d158" : state === "cached" ? "#ff9f0a" : "#8e8e93";
    const word = state === "live" ? "LIVE" : state === "cached" ? "CACHED" : "DEMO";
    let b = document.getElementById("liveBadge");
    if (!b) {
      const t = document.getElementById("ticker");
      if (!t) return;
      b = document.createElement("span");
      b.id = "liveBadge";
      b.style.cssText = "position:absolute;right:10px;top:0;height:100%;display:flex;align-items:" +
        "center;gap:6px;font-size:11px;z-index:6;padding:0 10px;background:inherit;" +
        "backdrop-filter:blur(2px)";
      t.appendChild(b);
    }
    b.title = D.STOCKS.length.toLocaleString("en-IN") + " listed stocks · " +
      D.INDICES.length + " indices · " +
      (state === "live" ? "updating from Yahoo Finance"
        : state === "cached" ? "real Yahoo Finance data — server.py is not running"
          : "generated demo data — run python3 server.py for live prices");
    b.innerHTML = '<span style="width:7px;height:7px;border-radius:50%;background:' + dot +
      ';display:inline-block"></span><span style="color:#9a9aa0">' + word + when + "</span>";
  }

  setBadge("demo");
  if (useSnapshot()) setBadge("cached");   // real data shipped with the site
  tick();
  loadFullUniverse();
  upgradeView();
  window.addEventListener("hashchange", upgradeView);
  setInterval(tick, 15000);   // poll every 15s
})();

