/* ============================================================================
   Dalal — market state
   ----------------------------------------------------------------------------
   The single source of truth for the running app: one payload, one refresh
   loop, one place that decides how often to poll.

   Refresh cadence follows the exchange, not the browser:
     market open   -> every 30s   (the server already caches for ~25s)
     market closed -> every 5 min (a close does not move again until the open)
     manual mode   -> only when the reader asks

   Polling pauses while the tab is hidden and resumes with an immediate
   refresh, so a backgrounded tab costs nothing and a returning reader is never
   looking at a stale screen. A failed refresh keeps the last good payload on
   screen and records the error; it never clears the numbers.
   ========================================================================== */
(function (D) {
  "use strict";

  var OPEN_MS = 30000;
  var CLOSED_MS = 300000;

  var state = {
    status: "loading",       // loading | ready | error
    payload: null,
    error: null,
    transport: "unknown",
    lastGoodAt: 0,
    updatedAt: 0,
    refreshing: false,
    nextRefreshAt: 0
  };

  var listeners = [];
  var inflight = null;
  var timer = null;
  var historyCache = {};        // "SYM|RANGE" -> record
  var historyInflight = {};
  var fundamentalCache = {};
  var fundamentalInflight = {};
  var lastPrices = {};          // sym -> price, for the change flash

  function emit() {
    listeners.slice().forEach(function (fn) {
      try { fn(state); } catch (err) { if (window.console) console.error(err); }
    });
  }

  function market() { return (state.payload && state.payload.market) || null; }

  D.api.subscribe(function (evt) {
    if (evt.type === "transport") {
      state.transport = evt.value;
      emit();
    }
  });

  /* ------------------------------------------------------------- refresh -- */
  function schedule() {
    if (timer) window.clearTimeout(timer);
    timer = null;
    if (D.prefs.get("refreshMode") === "manual") return;
    if (document.hidden) return;
    var open = market() && market().isOpen;
    var every = open ? OPEN_MS : CLOSED_MS;
    state.nextRefreshAt = Date.now() + every;
    timer = window.setTimeout(function () { D.market.refresh(); }, every);
  }

  function notePrices(payload) {
    function walk(bag) {
      Object.keys(bag || {}).forEach(function (sym) {
        var px = bag[sym] && bag[sym].price;
        if (typeof px === "number") lastPrices[sym] = px;
      });
    }
    walk(payload.indices);
    walk(payload.quotes);
  }

  D.market = {
    state: state,

    subscribe: function (fn) {
      listeners.push(fn);
      return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
    },

    /** Fetch the dashboard payload. Concurrent calls share one request. */
    refresh: function (opts) {
      opts = opts || {};
      if (inflight) return inflight;
      state.refreshing = true;
      state.status = state.payload ? "ready" : "loading";
      emit();

      function done() {
        state.refreshing = false;
        inflight = null;
        emit();
        schedule();
      }

      inflight = D.api.market({ history: !!opts.history })
        .then(function (payload) {
          if (!payload || !payload.indices) throw new Error("payload has no indices");
          notePrices(payload);
          state.payload = payload;
          state.market = payload.market;
          state.error = null;
          state.status = "ready";
          state.lastGoodAt = Date.now();
          state.updatedAt = Date.now();
          state.transport = D.api.transport;
        })
        .catch(function (err) {
          state.error = err;
          state.status = state.payload ? "ready" : "error";
          state.transport = D.api.transport;
        })
        .then(function () { done(); return state.payload; });
      return inflight;
    },

    resume: function () { schedule(); },

    intervalMs: function () {
      var open = market() && market().isOpen;
      return open ? OPEN_MS : CLOSED_MS;
    },
    /* ---------------------------------------------------------- selectors -- */

    /** One quote by canonical symbol: an index level or a stock. */
    quote: function (sym) {
      var c = D.sym.canonical(sym);
      if (!c || !state.payload) return null;
      return (state.payload.indices && state.payload.indices[c]) ||
             (state.payload.quotes && state.payload.quotes[c]) || null;
    },

    /** Every index the payload carries, in the registry's display order. */
    indices: function () {
      if (!state.payload) return [];
      var bag = state.payload.indices || {};
      var seen = {};
      var out = [];
      D.sym.indices().forEach(function (ix) {
        var q = bag[ix.sym];
        if (q) { out.push(Object.assign({ meta: ix }, q)); seen[ix.sym] = true; }
      });
      Object.keys(bag).forEach(function (s) {
        if (!seen[s]) out.push(Object.assign({ meta: D.sym.meta(s) }, bag[s]));
      });
      return out;
    },

    /** Equities only, with identity attached — the shape tables use. */
    list: function () {
      if (!state.payload) return [];
      var bag = state.payload.quotes || {};
      return Object.keys(bag).map(function (s) { return D.market.row(s); })
        .filter(Boolean);
    },

    /** One equity row: quote fields plus name/sector, never a derived price. */
    row: function (sym) {
      var c = D.sym.canonical(sym);
      var q = state.payload && state.payload.quotes ? state.payload.quotes[c] : null;
      var meta = D.sym.meta(c);
      if (!q) {
        return { symbol: c, name: meta.name, sector: meta.sector, available: false,
                 price: null, prevClose: null, change: null, changePct: null,
                 volume: null, high52: null, low52: null, asOf: null,
                 freshness: "UNAVAILABLE", source: "", stale: false };
      }
      return Object.assign({}, q, {
        symbol: c,
        name: q.name || meta.name,
        sector: meta.sector,
        kind: meta.kind,
        available: D.fmt.isNum(q.price)
      });
    },

    breadth: function () { return (state.payload && state.payload.breadth) || null; },
    movers: function () { return (state.payload && state.payload.movers) || null; },
    stats: function () { return (state.payload && state.payload.stats) || null; },
    source: function () { return (state.payload && state.payload.source) || null; },
    asOf: function () { return state.payload ? state.payload.asOf : null; },

    /** Per-sector average move, from real quotes only. */
    sectors: function () {
      var buckets = {};
      D.market.list().forEach(function (row) {
        if (!row.available || !D.fmt.isNum(row.changePct) || !row.sector) return;
        var b = buckets[row.sector] ||
          (buckets[row.sector] = { sector: row.sector, sum: 0, n: 0, up: 0, down: 0 });
        b.sum += row.changePct;
        b.n += 1;
        if (row.changePct > 0) b.up += 1;
        else if (row.changePct < 0) b.down += 1;
      });
      return Object.keys(buckets).map(function (k) {
        var b = buckets[k];
        return { sector: b.sector, pct: b.sum / b.n, count: b.n, up: b.up, down: b.down };
      }).sort(function (a, b) { return b.pct - a.pct; });
    },

    /** Did this price change since the last refresh? Drives the flash. */
    moved: function (sym) {
      var q = D.market.quote(sym);
      if (!q || !D.fmt.isNum(q.price)) return null;
      var prev = lastPrices[sym];
      if (!D.fmt.isNum(prev) || prev === q.price) return null;
      return q.price > prev ? "up" : "down";
    },

    /* -------------------------------------------------- lazy per-symbol data -- */

    /** Price history, cached per (symbol, range) and de-duplicated in flight. */
    history: function (sym, range) {
      var c = D.sym.canonical(sym) || sym;
      var key = c + "|" + (range || "1Y");
      if (historyCache[key]) return Promise.resolve(historyCache[key]);
      if (historyInflight[key]) return historyInflight[key];
      historyInflight[key] = D.api.history(c, range).then(function (rec) {
        historyCache[key] = rec;
        delete historyInflight[key];
        return rec;
      }, function (err) {
        delete historyInflight[key];
        throw err;
      });
      return historyInflight[key];
    },

    cachedHistory: function (sym, range) {
      return historyCache[(D.sym.canonical(sym) || sym) + "|" + (range || "1Y")] || null;
    },

    fundamentals: function (sym) {
      var c = D.sym.canonical(sym) || sym;
      if (fundamentalCache[c]) return Promise.resolve(fundamentalCache[c]);
      if (fundamentalInflight[c]) return fundamentalInflight[c];
      fundamentalInflight[c] = D.api.fundamentals(c).then(function (rec) {
        fundamentalCache[c] = rec;
        delete fundamentalInflight[c];
        return rec;
      }, function (err) {
        delete fundamentalInflight[c];
        throw err;
      });
      return fundamentalInflight[c];
    },

    /** Make sure these symbols have quotes; merge any that arrive. */
    ensureQuotes: function (symbols) {
      var want = (symbols || []).map(function (s) { return D.sym.canonical(s); })
        .filter(function (s) { return s && !D.market.quote(s); });
      if (!want.length) return Promise.resolve([]);
      return D.api.quotes(want).then(function (res) {
        var got = (res && res.quotes) || {};
        var merged = [];
        Object.keys(got).forEach(function (s) {
          if (!state.payload || !state.payload.quotes) return;
          if (!state.payload.quotes[s]) { state.payload.quotes[s] = got[s]; merged.push(s); }
          else if ((got[s].asOf || 0) > (state.payload.quotes[s].asOf || 0)) {
            state.payload.quotes[s] = got[s];
            merged.push(s);
          }
        });
        if (merged.length) emit();
        return merged;
      });
    },

    /** Force a refresh of specific symbols (used by the refresh control). */
    pull: function (symbols) {
      return D.api.quotes(symbols).then(function (res) {
        if (!state.payload || !res) return [];
        Object.keys(res.quotes || {}).forEach(function (s) {
          if (state.payload.quotes[s]) state.payload.quotes[s] = res.quotes[s];
          else if (state.payload.indices[s]) state.payload.indices[s] = res.quotes[s];
        });
        emit();
        return Object.keys(res.quotes || {});
      });
    }
  };

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (timer) window.clearTimeout(timer);
      timer = null;
    } else {
      D.market.refresh().catch(function () { /* state records the error */ });
    }
  });

  D.prefs.subscribe(function () { schedule(); });
})(window.Dalal = window.Dalal || {});

