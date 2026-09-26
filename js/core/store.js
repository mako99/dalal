/* ============================================================================
   Dalal — local storage: preferences and the watchlist
   ----------------------------------------------------------------------------
   Two deliberately separate stores, because they have different lifetimes:

     dalal.prefs.v1       display settings (theme, chart type, refresh mode)
     dalal.watchlist.v1   the user's symbols

   Resetting settings must never delete a watchlist, so they do not share a
   key. Both degrade to an in-memory copy when storage is unavailable (Safari
   private mode, sandboxed iframes, file:// in some browsers) instead of
   throwing, so the app keeps working for one session.
   ========================================================================== */
(function (D) {
  "use strict";

  var PREF_KEY = "dalal.prefs.v1";
  var WATCH_KEY = "dalal.watchlist.v1";

  function canStore() {
    try {
      var probe = "__dalal_probe__";
      window.localStorage.setItem(probe, "1");
      window.localStorage.removeItem(probe);
      return true;
    } catch (err) {
      return false;
    }
  }
  var HAS_STORAGE = canStore();
  var memory = {};

  function read(key, fallback) {
    try {
      var raw = HAS_STORAGE ? window.localStorage.getItem(key) : memory[key];
      return raw === null || raw === undefined ? fallback : JSON.parse(raw);
    } catch (err) {
      return fallback;
    }
  }

  function write(key, value) {
    var raw = JSON.stringify(value);
    if (HAS_STORAGE) {
      try {
        window.localStorage.setItem(key, raw);
        return true;
      } catch (err) { /* fall through to memory */ }
    }
    memory[key] = raw;
    return false;
  }

  function emitter() {
    var listeners = [];
    return {
      subscribe: function (fn) {
        listeners.push(fn);
        return function () {
          listeners = listeners.filter(function (f) { return f !== fn; });
        };
      },
      emit: function (payload) {
        listeners.slice().forEach(function (fn) {
          try { fn(payload); } catch (err) { if (window.console) console.error(err); }
        });
      }
    };
  }

  /* ------------------------------------------------------------ preferences -- */
  var DEFAULTS = {
    theme: "auto",              // auto | dark | light
    chartType: "line",          // line | candle
    refreshMode: "auto",        // auto | manual
    flash: true,                // brief highlight when a price changes
    compact: false,             // denser tables
    indexSet: ["NIFTY 50", "SENSEX", "BANKNIFTY", "NIFTY IT", "NIFTY MIDCAP", "NIFTY NEXT 50", "INDIA VIX"]
  };

  var prefs = read(PREF_KEY, {}) || {};
  Object.keys(DEFAULTS).forEach(function (k) {
    if (prefs[k] === undefined) prefs[k] = DEFAULTS[k];
  });

  var prefEvents = emitter();

  D.prefs = {
    defaults: DEFAULTS,
    all: function () { return Object.assign({}, prefs); },
    get: function (key) { return prefs[key]; },
    set: function (key, value) {
      if (prefs[key] === value) return value;
      prefs[key] = value;
      write(PREF_KEY, prefs);
      prefEvents.emit(D.prefs.all());
      return value;
    },
    toggle: function (key) { return D.prefs.set(key, !prefs[key]); },
    reset: function () {
      prefs = Object.assign({}, DEFAULTS);
      write(PREF_KEY, prefs);
      prefEvents.emit(D.prefs.all());
    },
    subscribe: prefEvents.subscribe,
    persistent: HAS_STORAGE
  };

  /* -------------------------------------------------------------- watchlist -- */
  function sanitise(list) {
    var seen = {};
    return (Array.isArray(list) ? list : [])
      .map(function (s) { return String(s || "").trim().toUpperCase(); })
      .filter(function (s) { if (!s || seen[s]) return false; seen[s] = true; return true; })
      .slice(0, 500);
  }

  var symbols = sanitise(read(WATCH_KEY, []));
  var watchEvents = emitter();

  function commit() {
    write(WATCH_KEY, symbols);
    watchEvents.emit(symbols.slice());
  }

  D.watch = {
    list: function () { return symbols.slice(); },
    count: function () { return symbols.length; },
    has: function (sym) { return symbols.indexOf(D.sym.canonical(sym)) !== -1; },
    add: function (sym) {
      var s = D.sym.canonical(sym);
      if (!s || symbols.indexOf(s) !== -1) return false;
      symbols.push(s);
      commit();
      return true;
    },
    addMany: function (list) {
      var added = 0;
      (list || []).forEach(function (s) {
        var c = D.sym.canonical(s);
        if (c && symbols.indexOf(c) === -1) { symbols.push(c); added += 1; }
      });
      if (added) commit();
      return added;
    },
    remove: function (sym) {
      var s = D.sym.canonical(sym);
      var at = symbols.indexOf(s);
      if (at === -1) return false;
      symbols.splice(at, 1);
      commit();
      return true;
    },
    toggle: function (sym) {
      return D.watch.has(sym) ? (D.watch.remove(sym), false) : (D.watch.add(sym), true);
    },
    clear: function () { symbols = []; commit(); },
    subscribe: watchEvents.subscribe,
    persistent: HAS_STORAGE
  };
})(window.Dalal = window.Dalal || {});
