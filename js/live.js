/* ============================================================
   Dalal — live data overlay
   Polls /api/quotes (served by server.py, Yahoo Finance proxy)
   and patches live prices into the demo dataset, then re-renders
   the ticker tape and the current view. Falls back silently to
   demo data when the API isn't available (e.g. opening the file
   directly without the server).
   ============================================================ */
(function () {
  "use strict";
  const D = window.DALAL;
  if (!D || !window.fetch) return;

  const ALL = D.INDICES.concat(D.STOCKS).map(x => x.sym);
  const TICKER_MAX = 64;   // keep the tape light once the universe is thousands strong
  let lastLive = false;

  /* how many instruments the tape shows: indices first, then the core names */
  function tickerItems() {
    const items = D.INDICES.concat(D.STOCKS);
    return items.length > TICKER_MAX ? items.slice(0, TICKER_MAX) : items;
  }

  /* ---- pull the complete NSE listing once (server.py /api/universe) ---- */
  function loadFullUniverse() {
    fetch("/api/universe", { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        if (!j || !j.symbols || !j.symbols.length) return;
        const added = D.extendUniverse(j.symbols);
        if (added) {
          rerender();          // rebuild the tape + current view with the new list
          setBadge(lastLive);  // refresh the tooltip count
        }
      })
      .catch(() => { /* offline / demo mode */ });
  }

  function apply(quotes) {
    let changed = false;
    Object.keys(quotes).forEach(sym => {
      const q = quotes[sym];
      if (!q || typeof q.price !== "number") return;
      const item = D.bySymbol(sym) || D.indexBySymbol(sym);
      if (!item) return;

      const series = item.close;
      const samePrice = item.live === true && series[series.length - 1] === q.price;
      const prevDemo = series[series.length - 1];
      const base = (typeof q.prevClose === "number" && q.prevClose > 0)
        ? q.prevClose : prevDemo;

      // replace last point with the live price, day change vs previous close
      series[series.length - 1] = q.price;
      item.stats = D.statsFor(series);
      item.stats.last = q.price;
      item.stats.day = {
        chg: (typeof q.change === "number") ? q.change : (q.price - base),
        pct: (typeof q.changePct === "number") ? q.changePct
              : (base ? (q.price - base) / base * 100 : 0)
      };
      item.live = true;
      if (!samePrice) changed = true; // skip re-render when nothing moved
    });
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

  function tick() {
    fetch("/api/quotes", { cache: "no-store" })
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(j => {
        if (apply(j.quotes || {})) rerender();
        setBadge(true);
      })
      .catch(() => setBadge(false));
  }

  function setBadge(live) {
    lastLive = live;
    let b = document.getElementById("liveBadge");
    if (!b) {
      const t = document.getElementById("ticker");
      if (!t) return;
      b = document.createElement("span");
      b.id = "liveBadge";
      b.style.cssText = "position:absolute;right:12px;top:0;height:100%;display:flex;align-items:center;gap:6px;font-size:11px;z-index:5;padding:0 10px;background:inherit;";
      t.appendChild(b);
    }
    b.title = D.STOCKS.length.toLocaleString("en-IN") + " listed stocks · " +
      D.INDICES.length + " indices · " +
      (live ? "updating from Yahoo Finance" : "showing demo data (start server.py for live prices)");
    b.innerHTML = live
      ? '<span style="width:7px;height:7px;border-radius:50%;background:#30d158;display:inline-block"></span><span style="color:#9a9aa0">LIVE</span>'
      : '<span style="width:7px;height:7px;border-radius:50%;background:#8e8e93;display:inline-block"></span><span style="color:#9a9aa0">DEMO</span>';
  }

  setBadge(false);
  tick();
  loadFullUniverse();
  setInterval(tick, 15000); // poll every 15s
})();