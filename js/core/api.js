/* ============================================================================
   Dalal — API client
   ----------------------------------------------------------------------------
   One transport, two modes, and an explicit third state for "no data at all":

     api        server.py answered /api/...  (live, cached and timestamped)
     snapshot   the server is unreachable, so the generated js/snapshot.js is
                used — real provider output, frozen at the time it was written,
                and shown with that timestamp
     unavailable  neither worked: callers get an error and the page must say so

   A failure never becomes a zero, a zero never becomes a price, and the mode is
   surfaced to the UI so the freshness badge can be honest about which one the
   reader is looking at.
   ========================================================================== */
(function (D) {
  "use strict";

  var api = {};
  var TIMEOUT = 15000;
  var listeners = [];

  api.transport = "unknown";      // "api" | "snapshot" | "unavailable"
  api.lastError = null;
  api.lastSuccessAt = 0;
  api.requests = 0;

  function emit(evt) {
    listeners.slice().forEach(function (fn) {
      try { fn(evt); } catch (err) { if (window.console) console.error(err); }
    });
  }

  function ApiError(message, code, status) {
    var err = new Error(message);
    err.code = code || "error";
    err.status = status || 0;
    return err;
  }

  function setTransport(mode) {
    if (api.transport === mode) return;
    api.transport = mode;
    emit({ type: "transport", value: mode });
  }

  function url(path, params) {
    var qs = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === "") return;
      qs.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
    });
    return path + (qs.length ? "?" + qs.join("&") : "");
  }

  function fetchJSON(path, params, opts) {
    opts = opts || {};
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = window.setTimeout(function () { if (ctrl) ctrl.abort(); },
                                  opts.timeout || TIMEOUT);
    api.requests += 1;
    return window.fetch(url(path, params), {
      signal: ctrl ? ctrl.signal : undefined,
      headers: { Accept: "application/json" },
      cache: "no-store"
    }).then(function (res) {
      if (!res.ok) throw ApiError("HTTP " + res.status + " from " + path, "http", res.status);
      return res.json();
    }).then(function (data) {
      window.clearTimeout(timer);
      api.lastSuccessAt = Date.now();
      api.lastError = null;
      return data;
    }).catch(function (err) {
      window.clearTimeout(timer);
      var e = (err && err.name === "AbortError")
        ? ApiError("request to " + path + " timed out", "timeout")
        : err;
      api.lastError = e;
      throw e;
    });
  }

  function snapshot() {
    var snap = window.DALAL_SNAPSHOT;
    if (!snap || snap.schema === undefined || !snap.indices) return null;
    return snap;
  }

  api.hasSnapshot = function () { return !!snapshot(); };

  api.snapshotStamp = function () {
    var snap = snapshot();
    return snap ? snap.generatedAt : 0;
  };

  /** Try the live API, fall back to the committed snapshot, then fail loudly. */
  function withFallback(liveCall, fromSnapshot, label) {
    setTransport("api");
    return liveCall().then(function (data) {
      setTransport("api");
      return data;
    }).catch(function (err) {
      var snap = snapshot();
      var fallback = snap ? fromSnapshot(snap) : null;
      if (fallback) {
        setTransport("snapshot");
        fallback._fallback = true;
        fallback._transportError = String((err && err.message) || err);
        return fallback;
      }
      setTransport("api");
      throw ApiError(
        label + " unavailable (" + String((err && err.message) || err) + ")", "unavailable");
    });
  }

  api.subscribe = function (fn) {
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
  };

  api.isUp = function () { return api.transport !== "unavailable" && !!api.lastSuccessAt; };

  /* ------------------------------------------------------------ endpoints -- */

  /** Dashboard payload: indices, quotes, breadth, movers, calendar, stats. */
  api.market = function (opts) {
    opts = opts || {};
    return withFallback(
      function () { return fetchJSON("/api/market", opts.history ? { history: "1" } : {}, opts); },
      function (snap) { return snap; },
      "Market data"
    );
  };
  /** Quotes for specific symbols (the server fetches any it does not hold). */
  api.quotes = function (symbols, opts) {
    var want = (symbols || []).join(",");
    if (!want) return Promise.resolve({ quotes: {} });
    return withFallback(
      function () { return fetchJSON("/api/quotes", { s: want }, opts); },
      function (snap) {
        var out = {};
        (symbols || []).forEach(function (s) {
          var c = D.sym.canonical(s) || s;
          var q = snap.quotes[c] || snap.indices[c];
          if (q) out[c] = q;
        });
        return { quotes: out, market: snap.market, asOf: snap.asOf, _fallback: true };
      },
      "Quotes"
    );
  };

  /**
   * Price history. Resolves an explicit unavailable record (available: false)
   * rather than rejecting when the provider has no series, because "no history"
   * is a fact the chart should print, not an exception.
   */
  api.history = function (symbol, range) {
    var sym = D.sym.canonical(symbol) || symbol;
    var span = range || "1Y";
    return fetchJSON("/api/history", { s: sym, range: span }, { timeout: 20000 })
      .then(function (rec) {
        setTransport("api");
        return rec;
      })
      .catch(function (err) {
        var snap = snapshot();
        var rec = snap && snap.history ? snap.history[sym] : null;
        if (rec) {
          setTransport("snapshot");
          return Object.assign({ available: true, range: span }, rec);
        }
        setTransport(snap ? "snapshot" : "unavailable");
        return { sym: sym, range: span, points: [], candles: [], available: false,
                 source: "", asOf: null, _error: String((err && err.message) || err),
                 reason: "price history could not be loaded" };
      });
  };

  /** Provider-reported fundamentals, or an explicit "not available". */
  api.fundamentals = function (symbol) {
    var sym = D.sym.canonical(symbol) || symbol;
    return fetchJSON("/api/fundamentals", { s: sym }, { timeout: 20000 })
      .then(function (rec) { setTransport("api"); return rec; })
      .catch(function (err) {
        setTransport(snapshot() ? "snapshot" : "unavailable");
        return { symbol: sym, available: false, metrics: {}, unavailable: [],
                 source: "", asOf: null, _error: String((err && err.message) || err),
                 reason: "fundamentals could not be loaded" };
      });
  };

  /** Ranked search. Falls back to the local index, which needs no network. */
  api.search = function (query, limit) {
    var q = String(query || "").trim();
    if (!q) return Promise.resolve({ query: q, results: [] });
    return fetchJSON("/api/search", { q: q, limit: limit || 12 }, { timeout: 8000 })
      .then(function (res) { setTransport("api"); return res; })
      .catch(function () {
        if (snapshot()) setTransport("snapshot");
        return { query: q, results: D.sym.search(q, limit || 12), local: true };
      });
  };

  /** Exchange holiday calendar: sessions, holidays and the current state. */
  api.calendar = function (days) {
    return withFallback(
      function () { return fetchJSON("/api/calendar", { days: days || 400 }); },
      function (snap) { return { holidays: (snap.calendar || {}).upcoming || [],
                                state: snap.market, source: (snap.calendar || {}).holidaySource || "" }; },
      "Market calendar"
    );
  };

  /** Health/counters — used by the status strip and the settings page. */
  api.health = function () {
    return fetchJSON("/api/health", {}, { timeout: 8000 });
  };

  /** Provenance of everything the server knows. */
  api.meta = function () {
    return fetchJSON("/api/meta", {}, { timeout: 8000 });
  };
})(window.Dalal = window.Dalal || {});
