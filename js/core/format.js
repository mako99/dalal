/* ============================================================================
   Dalal — formatting and calculations
   ----------------------------------------------------------------------------
   The browser mirrors the server's arithmetic rules so a number can never mean
   one thing in the API and another on screen:

   * a value that is not a finite number is `null`, never 0 and never NaN;
   * change and change % are derived from (price, previous close) — the same
     two prices printed beside them;
   * `null` renders as an em dash, and a *missing* value is never dressed up as
     a zero. If a provider did not report a metric, the UI says so.

   All market clock output is rendered in Asia/Kolkata no matter where the
   reader is, because the exchange session is defined in IST.
   ========================================================================== */
(function (D) {
  "use strict";

  var fmt = {};
  var IST = "Asia/Kolkata";
  var DASH = "\u2014";                 // em dash: "we do not have this"

  fmt.NA = DASH;

  /* ------------------------------------------------------------ primitives -- */
  fmt.isNum = function (v) {
    return typeof v === "number" && isFinite(v);
  };

  fmt.esc = function (s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  /* Indian digit grouping: 12,34,567.89 — not 1,234,567.89 */
  fmt.group = function (value, dp) {
    if (!fmt.isNum(value)) return DASH;
    var neg = value < 0;
    var parts = Math.abs(value).toFixed(dp === undefined ? 2 : dp).split(".");
    var whole = parts[0];
    var rest = whole.length > 3 ? whole.slice(-3) : whole;
    var head = whole.length > 3 ? whole.slice(0, -3) : "";
    while (head.length > 2) {
      rest = head.slice(-2) + "," + rest;
      head = head.slice(0, -2);
    }
    if (head) rest = head + "," + rest;
    return (neg ? "-" : "") + rest + (parts[1] ? "." + parts[1] : "");
  };

  fmt.num = function (value, dp) {
    return fmt.isNum(value) ? fmt.group(value, dp === undefined ? 2 : dp) : DASH;
  };

  /** ₹ price. Money is shown with two decimals, as an exchange does. */
  fmt.price = function (value, dp) {
    return fmt.isNum(value) ? "\u20b9" + fmt.group(value, dp === undefined ? 2 : dp) : DASH;
  };

  /** Bare number that may legitimately be zero (volume, counts). */
  fmt.count = function (value) {
    return fmt.isNum(value) ? fmt.group(value, 0) : DASH;
  };

  /** +1.23% / -1.23% / — */
  fmt.pct = function (value, opts) {
    if (!fmt.isNum(value)) return DASH;
    var o = opts || {};
    var dp = o.dp === undefined ? 2 : o.dp;
    var sign = o.sign === false ? "" : value > 0 ? "+" : "";
    return sign + fmt.group(value, dp) + "%";
  };

  /** +₹12.20 — the absolute move, formatted like the price it belongs to. */
  fmt.change = function (value, opts) {
    if (!fmt.isNum(value)) return DASH;
    var o = opts || {};
    var dp = o.dp === undefined ? 2 : o.dp;
    var sign = o.sign === false ? "" : value > 0 ? "+" : value < 0 ? "-" : "";
    return sign + "\u20b9" + fmt.group(Math.abs(value), dp);
  };

  /** 1.24 Cr / 45.6 L / 12.3 K — the Indian market's own magnitude words. */
  fmt.compact = function (value) {
    if (!fmt.isNum(value)) return DASH;
    var abs = Math.abs(value);
    if (abs >= 1e7) return (value / 1e7).toFixed(2) + " Cr";
    if (abs >= 1e5) return (value / 1e5).toFixed(2) + " L";
    if (abs >= 1e3) return (value / 1e3).toFixed(1) + " K";
    return String(Math.round(value));
  };

  fmt.volume = function (value) {
    return fmt.isNum(value) ? fmt.compact(value) : DASH;
  };
  /* -------------------------------------------------------------- IST clock -- */
  function ist(epoch, options) {
    if (!fmt.isNum(epoch) || epoch <= 0) return DASH;
    try {
      return new Intl.DateTimeFormat("en-IN", Object.assign({ timeZone: IST }, options))
        .format(new Date(epoch * 1000));
    } catch (err) {
      return DASH;
    }
  }

  /** "3:30 pm" — the session time a quote belongs to. */
  fmt.time = function (epoch) {
    return ist(epoch, { hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase();
  };

  /** "25 Sep 2026" */
  fmt.date = function (epoch) {
    return ist(epoch, { day: "2-digit", month: "short", year: "numeric" });
  };

  /** "Fri 25 Sep" — compact, for table cells. */
  fmt.dayMonth = function (epoch) {
    return ist(epoch, { weekday: "short", day: "2-digit", month: "short" });
  };

  /** "26 Sep 2026, 3:30 pm IST" — the canonical "as of" string. */
  fmt.stamp = function (epoch) {
    if (!fmt.isNum(epoch) || epoch <= 0) return "unknown";
    return fmt.date(epoch) + ", " + fmt.time(epoch) + " IST";
  };

  /** ISO calendar date in IST ("2026-09-25"), for comparing session dates. */
  fmt.isoDay = function (epoch) {
    if (!fmt.isNum(epoch) || epoch <= 0) return "";
    var parts = ist(epoch, { year: "numeric", month: "2-digit", day: "2-digit" }).split("/");
    return parts.length === 3 ? parts[2] + "-" + parts[1] + "-" + parts[0] : "";
  };

  fmt.age = function (seconds) {
    if (!fmt.isNum(seconds)) return DASH;
    var s = Math.max(0, Math.round(seconds));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m ago";
    return Math.floor(s / 86400) + "d " + Math.floor((s % 86400) / 3600) + "h ago";
  };

  /* ------------------------------------------------------------- arithmetic -- */
  /** {change, pct} derived from the two prices that will be displayed. */
  fmt.derive = function (price, prevClose) {
    if (!fmt.isNum(price) || !fmt.isNum(prevClose) || prevClose === 0) {
      return { change: null, pct: null };
    }
    var change = price - prevClose;
    return { change: change, pct: (change / prevClose) * 100 };
  };

  fmt.dir = function (value) {
    if (!fmt.isNum(value) || value === 0) return "flat";
    return value > 0 ? "up" : "down";
  };

  /** Signed percentage spread between two prices (used by Compare). */
  fmt.rel = function (a, b) {
    if (!fmt.isNum(a) || !fmt.isNum(b) || b === 0) return null;
    return ((a - b) / b) * 100;
  };

  /** A quote's move, preferring the server's already-derived pair. */
  fmt.quoteChange = function (quote) {
    if (!quote) return { change: null, pct: null };
    if (fmt.isNum(quote.change) && fmt.isNum(quote.changePct)) {
      return { change: quote.change, pct: quote.changePct };
    }
    return fmt.derive(quote.price, quote.prevClose);
  };
  /* @@FMT@@ */
})(window.Dalal = window.Dalal || {});
