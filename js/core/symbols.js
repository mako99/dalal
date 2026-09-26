/* ============================================================================
   Dalal — symbols and static metadata
   ----------------------------------------------------------------------------
   One place in the browser knows what a symbol is, mirroring
   marketdata/symbols.py so the UI and the API agree about identity:

     "reliance", "RELIANCE.NS", "reliance.ns"  ->  "RELIANCE"
     "nifty", "NIFTY50", "^NSEI", "Nifty Bank"  ->  "NIFTY 50" / "BANKNIFTY"

   Names and sectors come from the generated metadata files (js/data/curated.js
   and js/universe_nse.js). Those files hold no prices and no fundamentals —
   only identity — so nothing here can show a stale number.
   ========================================================================== */
(function (D) {
  "use strict";

  var sym = {};
  var SYM_RE = /^[A-Z0-9&.\-]{1,24}$/;

  /* Display registry for the tracked indices: order, label and accent colour.
     `sym` is exactly the key the API uses. */
  var INDICES = [
    { sym: "NIFTY 50", label: "NIFTY 50", full: "NSE benchmark · 50 companies", color: "#3b82f6", exchange: "NSE" },
    { sym: "SENSEX", label: "SENSEX", full: "BSE benchmark · 30 companies", color: "#8b5cf6", exchange: "BSE" },
    { sym: "BANKNIFTY", label: "BANK NIFTY", full: "Banking benchmark · 12 banks", color: "#22c55e", exchange: "NSE" },
    { sym: "NIFTY IT", label: "NIFTY IT", full: "Technology · 10 companies", color: "#f59e0b", exchange: "NSE" },
    { sym: "NIFTY MIDCAP", label: "NIFTY MIDCAP 50", full: "Mid-cap benchmark · 50 companies", color: "#06b6d4", exchange: "NSE" },
    { sym: "NIFTY NEXT 50", label: "NIFTY NEXT 50", full: "Emerging large caps · 50 companies", color: "#ec4899", exchange: "NSE" },
    { sym: "INDIA VIX", label: "INDIA VIX", full: "Volatility index", color: "#ef4444", exchange: "NSE" }
  ];

  var INDEX_MAP = {};
  INDICES.forEach(function (ix) { INDEX_MAP[ix.sym] = ix; });

  var ALIASES = {
    NIFTY: "NIFTY 50", NIFTY50: "NIFTY 50", NSEI: "NIFTY 50", "^NSEI": "NIFTY 50",
    "BANK NIFTY": "BANKNIFTY", NIFTYBANK: "BANKNIFTY", "NIFTY BANK": "BANKNIFTY",
    "^NSEBANK": "BANKNIFTY", SENSEX30: "SENSEX", "BSE SENSEX": "SENSEX",
    BSESN: "SENSEX", "^BSESN": "SENSEX", NIFTYIT: "NIFTY IT", CNXIT: "NIFTY IT",
    "^CNXIT": "NIFTY IT", MIDCAP50: "NIFTY MIDCAP", "NIFTY MIDCAP 50": "NIFTY MIDCAP",
    "NIFTY NEXT50": "NIFTY NEXT 50", NSMIDCP: "NIFTY NEXT 50",
    VIX: "INDIA VIX", INDIAVIX: "INDIA VIX", "^INDIAVIX": "INDIA VIX"
  };

  /** Normalise any user or provider spelling to a canonical symbol. */
  sym.canonical = function (raw) {
    if (raw === null || raw === undefined) return "";
    var s = String(raw).trim().toUpperCase();
    if (!s) return "";
    if (INDEX_MAP[s]) return s;
    s = s.replace(/\.(NS|BO|NSE|BSE)$/, "");
    if (INDEX_MAP[s]) return s;
    s = s.replace(/^\^/, "");
    if (ALIASES[s]) return ALIASES[s];
    return SYM_RE.test(s) ? s : "";
  };

  sym.isIndex = function (raw) { return !!INDEX_MAP[sym.canonical(raw)]; };
  sym.indices = function () { return INDICES.slice(); };
  sym.index = function (raw) { return INDEX_MAP[sym.canonical(raw)] || null; };

  /* -------------------------------------------------------------- metadata -- */
  var metaCache = null;

  function buildMeta() {
    var out = {};
    (window.DALAL_CURATED_META || []).forEach(function (row) {
      if (row && row[0]) out[row[0]] = { name: row[1] || row[0], sector: row[2] || "" };
    });
    (window.DALAL_NSE_UNIVERSE || []).forEach(function (row) {
      if (row && row[0] && !out[row[0]]) out[row[0]] = { name: row[1] || row[0], sector: "" };
    });
    return out;
  }

  sym.all = function () {
    if (!metaCache) metaCache = buildMeta();
    return metaCache;
  };

  /** {symbol, name, sector, exchange, kind} — never a price. */
  sym.meta = function (raw) {
    var c = sym.canonical(raw);
    if (!c) return { symbol: "", name: "", sector: "", exchange: "", kind: "" };
    var ix = INDEX_MAP[c];
    if (ix) {
      return { symbol: c, name: ix.label, sector: "Index", exchange: ix.exchange,
               kind: "index", full: ix.full, color: ix.color };
    }
    var rec = sym.all()[c];
    return { symbol: c, name: (rec && rec.name) || c, sector: (rec && rec.sector) || "",
             exchange: "NSE", kind: "equity" };
  };

  sym.name = function (raw) { return sym.meta(raw).name; };
  sym.sector = function (raw) { return sym.meta(raw).sector; };

  /** Every sector in the curated metadata, for the screener's filter. */
  sym.sectors = function () {
    var seen = {};
    var all = sym.all();
    Object.keys(all).forEach(function (s) { if (all[s].sector) seen[all[s].sector] = true; });
    return Object.keys(seen).sort();
  };

  sym.universeSize = function () { return Object.keys(sym.all()).length; };
  D.sym = sym;
  /* ---------------------------------------------------------- local search -- */
  /** Instant prefix search over identity only; the API re-ranks it when up. */
  sym.search = function (query, limit) {
    var q = String(query || "").trim().toUpperCase();
    var max = limit || 10;
    if (!q) return [];
    var out = [];
    INDICES.forEach(function (ix) {
      if (ix.sym.indexOf(q) === 0 || ix.label.indexOf(q) !== -1) {
        out.push({ symbol: ix.sym, name: ix.label, sector: "Index", kind: "index" });
      }
    });
    var all = sym.all();
    var keys = Object.keys(all);
    var buckets = [[], [], [], []];
    for (var i = 0; i < keys.length; i += 1) {
      var s = keys[i];
      var name = (all[s].name || "").toUpperCase();
      if (s === q) buckets[0].push(s);
      else if (s.indexOf(q) === 0) buckets[1].push(s);
      else if (name.indexOf(q) === 0) buckets[2].push(s);
      else if (name.indexOf(q) !== -1) buckets[3].push(s);
    }
    for (var b = 0; b < buckets.length && out.length < max; b += 1) {
      buckets[b].sort();
      for (var j = 0; j < buckets[b].length && out.length < max; j += 1) {
        var k = buckets[b][j];
        out.push({ symbol: k, name: all[k].name, sector: all[k].sector, kind: "equity" });
      }
    }
    return out.slice(0, max);
  };
})(window.Dalal = window.Dalal || {});
