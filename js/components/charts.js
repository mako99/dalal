/* ============================================================================
   Dalal — charts
   ----------------------------------------------------------------------------
   Hand-rolled SVG charts (no chart library, no build step). Three rules:

   * a series that has no data is never drawn. The caller gets `false` back and
     prints the reason instead, so the app can never show an empty box that
     looks like a flat market;
   * every series keeps its own timestamps, so a tooltip date is the date the
     provider reported and not an interpolation;
   * the y-domain includes the previous close when the caller supplies one, so
     "up" and "down" stay visually true instead of being auto-scaled flat.

   Charts re-render on resize (debounced) from the stored spec, so a rotate or
   a window drag never leaves a stretched chart behind.
   ========================================================================== */
(function (D) {
  "use strict";

  var fmt = D.fmt;
  var esc = fmt.esc;
  var charts = {};

  var PAD = { top: 12, right: 10, bottom: 22, left: 52 };
  var MAX_POINTS = 280;                 // plenty for a screen, cheap to redraw

  function uid() {
    return "c" + Math.random().toString(36).slice(2, 9);
  }

  /** Even-stride downsampling that always keeps the final point. */
  function thin(points, max) {
    if (!points || points.length <= max) return points || [];
    var stride = Math.ceil(points.length / max);
    var out = [];
    for (var i = 0; i < points.length; i += stride) out.push(points[i]);
    if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
    return out;
  }

  function extent(values) {
    var lo = Infinity;
    var hi = -Infinity;
    values.forEach(function (v) {
      if (!fmt.isNum(v)) return;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    });
    if (lo === Infinity) return null;
    if (hi === lo) {                     // a flat series still needs a band
      var pad = Math.abs(hi) * 0.005 || 1;
      return [lo - pad, hi + pad];
    }
    return [lo, hi];
  }

  /** Compact axis labels: 23,140 / 1.2Cr / 4.5L. */
  function axisLabel(value) {
    if (!fmt.isNum(value)) return "";
    var abs = Math.abs(value);
    if (abs >= 1e7) return (value / 1e7).toFixed(1) + "Cr";
    if (abs >= 1e5) return (value / 1e5).toFixed(1) + "L";
    if (abs >= 1000) return fmt.group(value, 0);
    return fmt.group(value, abs < 10 ? 2 : 0);
  }

  function size(host, height) {
    var width = Math.max(240, Math.round(host.clientWidth || 640));
    return { w: width, h: height || 300 };
  }

  charts.thin = thin;
  charts.axisLabel = axisLabel;

  /** Every chart is redrawn from its spec when the window changes size. */
  function remember(host, render) {
    var entry = { host: host, render: render };
    charts._live = (charts._live || []).filter(function (e) {
      return e.host !== host && e.host.isConnected;
    });
    charts._live.push(entry);
  }

  var resizeTimer = null;
  window.addEventListener("resize", function () {
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () {
      (charts._live || []).forEach(function (entry) {
        if (!entry.host.isConnected) return;
        try { entry.render(); } catch (err) { if (window.console) console.error(err); }
      });
    }, 160);
  });
  /**
   * Line / area chart with an optional previous-close baseline, optional volume
   * panel, crosshair and tooltip.
   *   spec: {points: [[iso, close]], volumes: [n], baseline: n, color, height,
   *          label, valueLabel}
   */
  charts.line = function (host, spec) {
    var points = (spec.points || []).filter(function (p) { return p && fmt.isNum(p[1]); });
    if (points.length < 2) return false;
    points = thin(points, MAX_POINTS);

    var box = size(host, spec.height || 300);
    var vols = spec.volumes && spec.volumes.length === points.length ? spec.volumes : null;
    var volH = vols ? 42 : 0;
    var innerW = box.w - PAD.left - PAD.right;
    var innerH = box.h - PAD.top - PAD.bottom - volH;
    var values = points.map(function (p) { return p[1]; });
    if (fmt.isNum(spec.baseline)) values = values.concat([spec.baseline]);
    var dom = extent(values);
    if (!dom) return false;
    var pad = (dom[1] - dom[0]) * 0.06;
    var lo = dom[0] - pad;
    var hi = dom[1] + pad;

    function x(i) { return PAD.left + (i / (points.length - 1)) * innerW; }
    function y(v) { return PAD.top + (1 - (v - lo) / (hi - lo)) * innerH; }

    var line = points.map(function (p, i) {
      return (i ? "L" : "M") + x(i).toFixed(1) + " " + y(p[1]).toFixed(1);
    }).join(" ");

    var last = points[points.length - 1][1];
    var up = fmt.isNum(spec.baseline) ? last >= spec.baseline : true;
    var color = spec.color || (up ? "var(--up)" : "var(--down)");
    var gid = uid();

    var grid = "";
    for (var g = 0; g <= 4; g += 1) {
      var gy = (PAD.top + (g / 4) * innerH).toFixed(1);
      grid += '<line x1="' + PAD.left + '" y1="' + gy + '" x2="' + (box.w - PAD.right) +
        '" y2="' + gy + '"></line>' +
        '<text x="' + (PAD.left - 6) + '" y="' + (Number(gy) + 3.5).toFixed(1) +
        '" text-anchor="end">' + esc(axisLabel(hi - (g / 4) * (hi - lo))) + "</text>";
    }

    var baseline = fmt.isNum(spec.baseline)
      ? '<line class="chart-baseline" x1="' + PAD.left + '" y1="' + y(spec.baseline).toFixed(1) +
        '" x2="' + (box.w - PAD.right) + '" y2="' + y(spec.baseline).toFixed(1) + '"></line>'
      : "";

    var volume = "";
    if (vols) {
      var vmax = Math.max.apply(null, vols.filter(fmt.isNum).concat([0]));
      if (vmax > 0) {
        var vTop = PAD.top + innerH + 10;
        var bw = Math.max(1, innerW / points.length - 1);
        volume = '<g class="chart-vol">' + vols.map(function (v, i) {
          if (!fmt.isNum(v)) return "";
          var h2 = (v / vmax) * volH;
          return '<rect x="' + (x(i) - bw / 2).toFixed(1) + '" y="' + (vTop + volH - h2).toFixed(1) +
            '" width="' + bw.toFixed(1) + '" height="' + h2.toFixed(1) +
            '" fill="var(--text-3)"></rect>';
        }).join("") + "</g>";
      }
    }

    var xLabels = [0, Math.floor(points.length / 2), points.length - 1].map(function (i) {
      return '<text x="' + x(i).toFixed(1) + '" y="' + (box.h - 6) + '" text-anchor="' +
        (i === 0 ? "start" : i === points.length - 1 ? "end" : "middle") + '">' +
        esc(String(points[i][0]).slice(0, 10)) + "</text>";
    }).join("");

    host.innerHTML =
      '<svg class="chart-svg" viewBox="0 0 ' + box.w + " " + box.h + '" width="' + box.w +
      '" height="' + box.h + '" role="img" aria-label="' +
      esc((spec.label || "Price") + ": " + points.length + " points from " +
          String(points[0][0]).slice(0, 10) + " to " +
          String(points[points.length - 1][0]).slice(0, 10)) + '">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.5"></stop>' +
      '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"></stop>' +
      "</linearGradient></defs>" +
      '<g class="chart-grid">' + grid + "</g>" +
      '<path class="chart-area" fill="url(#' + gid + ')" d="' + line + " L" +
        (box.w - PAD.right) + " " + (PAD.top + innerH) + " L" + PAD.left + " " +
        (PAD.top + innerH) + ' Z"></path>' +
      baseline +
      '<path class="chart-line" stroke="' + color + '" d="' + line + '"></path>' +
      volume +
      '<g class="chart-axis">' + xLabels + "</g>" +
      '<g class="chart-cursor" style="display:none">' +
      '<line class="chart-cross" y1="' + PAD.top + '" y2="' + (PAD.top + innerH) + '"></line>' +
      '<circle class="chart-dot" r="3.5" fill="' + color + '"></circle></g>' +
      "</svg>" +
      '<div class="chart-tip" hidden></div>';

    charts.crosshair(host, {
      points: points,
      volumes: vols,
      x: x,
      y: y,
      box: box,
      baseline: spec.baseline,
      valueLabel: spec.valueLabel || "Close",
      volumeLabel: spec.volumeLabel || "Volume"
    });
    remember(host, function () { charts.line(host, spec); });
    return true;
  };
  /** Crosshair + tooltip for a single-series chart. */
  charts.crosshair = function (host, ctx) {
    var svg = host.querySelector("svg");
    var cursor = host.querySelector(".chart-cursor");
    var tip = host.querySelector(".chart-tip");
    if (!svg || !cursor || !tip) return;
    var line = cursor.querySelector("line");
    var dot = cursor.querySelector("circle");
    var points = ctx.points;
    var innerW = ctx.box.w - PAD.left - PAD.right;

    function nearest(clientX) {
      var rect = svg.getBoundingClientRect();
      var px = (clientX - rect.left) * (rect.width ? ctx.box.w / rect.width : 1);
      var idx = Math.round(((px - PAD.left) / innerW) * (points.length - 1));
      return Math.min(points.length - 1, Math.max(0, idx));
    }

    function show(clientX) {
      var i = nearest(clientX);
      var point = points[i];
      var value = point[1];
      cursor.style.display = "";
      line.setAttribute("x1", ctx.x(i).toFixed(1));
      line.setAttribute("x2", ctx.x(i).toFixed(1));
      dot.setAttribute("cx", ctx.x(i).toFixed(1));
      dot.setAttribute("cy", ctx.y(value).toFixed(1));

      var rows = '<dt>Price</dt><dd>' + esc(fmt.price(value)) + "</dd>";
      if (fmt.isNum(ctx.baseline) && ctx.baseline > 0) {
        var diff = value - ctx.baseline;
        rows += '<dt>Change</dt><dd class="' + fmt.dir(diff) + '">' +
          esc(fmt.change(diff)) + " (" + esc(fmt.pct((diff / ctx.baseline) * 100)) + ")</dd>";
      }
      var vol = ctx.volumes ? ctx.volumes[i] : null;
      if (fmt.isNum(vol)) rows += "<dt>Volume</dt><dd>" + esc(fmt.volume(vol)) + "</dd>";

      tip.innerHTML = '<div class="t-date">' + esc(String(point[0])) + "</div><dl>" + rows + "</dl>";
      tip.hidden = false;
      var left = ctx.x(i) * (svg.clientWidth ? svg.clientWidth / ctx.box.w : 1);
      tip.style.left = Math.min(Math.max(left, 74), ctx.box.w - 74) + "px";
      tip.style.top = (ctx.y(value) * (svg.clientHeight ? svg.clientHeight / ctx.box.h : 1) - 8) + "px";
    }

    function hide() {
      cursor.style.display = "none";
      tip.hidden = true;
    }

    host.addEventListener("pointermove", function (evt) { show(evt.clientX); });
    host.addEventListener("pointerleave", hide);
    host.addEventListener("touchstart", function (evt) {
      if (evt.touches[0]) show(evt.touches[0].clientX);
    }, { passive: true });
    host.addEventListener("touchmove", function (evt) {
      if (evt.touches[0]) show(evt.touches[0].clientX);
    }, { passive: true });
    host.addEventListener("touchend", hide);
  };


  /** Candlestick chart with a volume panel. */
  charts.candles = function (host, spec) {
    var candles = (spec.candles || []).filter(function (c) {
      return c && fmt.isNum(c.c);
    });
    if (candles.length < 2) return false;
    candles = thin(candles, MAX_POINTS);

    var box = size(host, spec.height || 300);
    var volH = 40;
    var innerW = box.w - PAD.left - PAD.right;
    var innerH = box.h - PAD.top - PAD.bottom - volH;
    var dom = extent(candles.reduce(function (acc, c) { return acc.concat([c.l, c.h]); }, []));
    if (!dom) return false;
    var pad = (dom[1] - dom[0]) * 0.06;
    var lo = dom[0] - pad;
    var hi = dom[1] + pad;
    var step = innerW / candles.length;
    var bodyW = Math.max(1.2, step * 0.62);

    function x(i) { return PAD.left + i * step + step / 2; }
    function y(v) { return PAD.top + (1 - (v - lo) / (hi - lo)) * innerH; }

    var grid = "";
    for (var g = 0; g <= 4; g += 1) {
      var gy = (PAD.top + (g / 4) * innerH).toFixed(1);
      grid += '<line x1="' + PAD.left + '" y1="' + gy + '" x2="' + (box.w - PAD.right) +
        '" y2="' + gy + '"></line><text x="' + (PAD.left - 6) + '" y="' +
        (Number(gy) + 3.5).toFixed(1) + '" text-anchor="end">' +
        esc(axisLabel(hi - (g / 4) * (hi - lo))) + "</text>";
    }

    var vmax = Math.max.apply(null, candles.map(function (c) {
      return fmt.isNum(c.v) ? c.v : 0;
    }).concat([0]));
    var vTop = PAD.top + innerH + 8;
    var body = candles.map(function (c, i) {
      var rising = !fmt.isNum(c.o) || c.c >= c.o;
      var colour = rising ? "var(--up)" : "var(--down)";
      var top = y(Math.max(fmt.isNum(c.o) ? c.o : c.c, c.c));
      var bottom = y(Math.min(fmt.isNum(c.o) ? c.o : c.c, c.c));
      var out = '<g class="chart-candle"><line class="chart-wick" x1="' + x(i).toFixed(1) +
        '" y1="' + y(fmt.isNum(c.h) ? c.h : c.c).toFixed(1) + '" x2="' + x(i).toFixed(1) +
        '" y2="' + y(fmt.isNum(c.l) ? c.l : c.c).toFixed(1) + '" stroke="' + colour + '"></line>' +
        '<rect x="' + (x(i) - bodyW / 2).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' +
        bodyW.toFixed(1) + '" height="' + Math.max(1, bottom - top).toFixed(1) + '" fill="' +
        colour + '" stroke="' + colour + '"></rect>';
      if (vmax > 0 && fmt.isNum(c.v)) {
        var vh = (c.v / vmax) * volH;
        out += '<rect class="chart-vol" x="' + (x(i) - bodyW / 2).toFixed(1) + '" y="' +
          (vTop + volH - vh).toFixed(1) + '" width="' + bodyW.toFixed(1) + '" height="' +
          vh.toFixed(1) + '" fill="' + colour + '"></rect>';
      }
      return out + "</g>";
    }).join("");

    var xLabels = [0, Math.floor(candles.length / 2), candles.length - 1].map(function (i) {
      return '<text x="' + x(i).toFixed(1) + '" y="' + (box.h - 6) + '" text-anchor="' +
        (i === 0 ? "start" : i === candles.length - 1 ? "end" : "middle") + '">' +
        esc(String(candles[i].t).slice(0, 10)) + "</text>";
    }).join("");

    host.innerHTML =
      '<svg class="chart-svg" viewBox="0 0 ' + box.w + " " + box.h + '" width="' + box.w +
      '" height="' + box.h + '" role="img" aria-label="' +
      esc((spec.label || "Price") + " candlesticks, " + candles.length + " sessions") + '">' +
      '<g class="chart-grid">' + grid + "</g>" + body +
      '<g class="chart-axis">' + xLabels + "</g></svg>" +
      '<div class="chart-tip" hidden></div>';

    charts.candleTip(host, candles, x, y, box);
    remember(host, function () { charts.candles(host, spec); });
    return true;
  };

  charts.candleTip = function (host, candles, x, y, box) {
    var svg = host.querySelector("svg");
    var tip = host.querySelector(".chart-tip");
    if (!svg || !tip) return;
    var step = (box.w - PAD.left - PAD.right) / candles.length;

    function show(clientX) {
      var rect = svg.getBoundingClientRect();
      var px = (clientX - rect.left) * (rect.width ? box.w / rect.width : 1);
      var i = Math.min(candles.length - 1,
                       Math.max(0, Math.floor((px - PAD.left) / step)));
      var c = candles[i];
      var move = fmt.isNum(c.o) ? c.c - c.o : null;
      tip.innerHTML = '<div class="t-date">' + esc(String(c.t)) + "</div><dl>" +
        "<dt>Open</dt><dd>" + esc(fmt.price(c.o)) + "</dd>" +
        "<dt>High</dt><dd>" + esc(fmt.price(c.h)) + "</dd>" +
        "<dt>Low</dt><dd>" + esc(fmt.price(c.l)) + "</dd>" +
        "<dt>Close</dt><dd>" + esc(fmt.price(c.c)) + "</dd>" +
        (fmt.isNum(move) ? '<dt>Move</dt><dd class="' + fmt.dir(move) + '">' +
          esc(fmt.pct(fmt.isNum(c.o) && c.o ? (move / c.o) * 100 : null)) + "</dd>" : "") +
        "<dt>Volume</dt><dd>" + esc(fmt.volume(c.v)) + "</dd></dl>";
      tip.hidden = false;
      var left = x(i) * (svg.clientWidth ? svg.clientWidth / box.w : 1);
      tip.style.left = Math.min(Math.max(left, 78), box.w - 78) + "px";
      tip.style.top = (y(c.c) * (svg.clientHeight ? svg.clientHeight / box.h : 1) - 12) + "px";
    }
    host.addEventListener("pointermove", function (evt) { show(evt.clientX); });
    host.addEventListener("pointerleave", function () { tip.hidden = true; });
    host.addEventListener("touchmove", function (evt) {
      if (evt.touches[0]) show(evt.touches[0].clientX);
    }, { passive: true });
    host.addEventListener("touchend", function () { tip.hidden = true; });
  };


  /**
   * Multi-series comparison chart. Each series is normalized to percentage
   * change relative to its own starting price (index 0 = 0%).
   *   series: [{label, color, points: [[iso, val]]}]
   */
  charts.multi = function (host, spec) {
    var rawSeries = (spec.series || []).filter(function (s) {
      return s && s.points && s.points.length >= 2;
    });
    if (!rawSeries.length) return false;

    var series = rawSeries.map(function (s) {
      var pts = thin(s.points, MAX_POINTS);
      var base = pts[0][1];
      if (!fmt.isNum(base) || base === 0) return null;
      var norm = pts.map(function (p) {
        return [p[0], ((p[1] - base) / base) * 100, p[1]];
      });
      return { label: s.label, color: s.color, norm: norm, raw: pts };
    }).filter(Boolean);

    if (!series.length) return false;

    var box = size(host, spec.height || 340);
    var innerW = box.w - PAD.left - PAD.right;
    var innerH = box.h - PAD.top - PAD.bottom;

    var allVals = [0];
    series.forEach(function (s) {
      s.norm.forEach(function (p) { allVals.push(p[1]); });
    });
    var dom = extent(allVals);
    var pad = (dom[1] - dom[0]) * 0.08 || 1;
    var lo = dom[0] - pad;
    var hi = dom[1] + pad;

    function x(i, len) { return PAD.left + (i / (len - 1)) * innerW; }
    function y(v) { return PAD.top + (1 - (v - lo) / (hi - lo)) * innerH; }

    var grid = "";
    for (var g = 0; g <= 4; g += 1) {
      var gy = (PAD.top + (g / 4) * innerH).toFixed(1);
      var gv = hi - (g / 4) * (hi - lo);
      grid += '<line x1="' + PAD.left + '" y1="' + gy + '" x2="' + (box.w - PAD.right) +
        '" y2="' + gy + '"></line><text x="' + (PAD.left - 6) + '" y="' +
        (Number(gy) + 3.5).toFixed(1) + '" text-anchor="end">' +
        esc((gv >= 0 ? "+" : "") + gv.toFixed(1) + "%") + "</text>";
    }

    var zeroLine = '<line class="chart-baseline" x1="' + PAD.left + '" y1="' +
      y(0).toFixed(1) + '" x2="' + (box.w - PAD.right) + '" y2="' +
      y(0).toFixed(1) + '"></line>';

    var lines = series.map(function (s) {
      var d = s.norm.map(function (p, i) {
        return (i ? "L" : "M") + x(i, s.norm.length).toFixed(1) + " " + y(p[1]).toFixed(1);
      }).join(" ");
      return '<path class="chart-line" stroke="' + s.color + '" stroke-width="2" d="' + d + '"></path>';
    }).join("");

    var longest = series.reduce(function (a, b) { return a.norm.length > b.norm.length ? a : b; });
    var xLabels = [0, Math.floor(longest.norm.length / 2), longest.norm.length - 1].map(function (i) {
      return '<text x="' + x(i, longest.norm.length).toFixed(1) + '" y="' + (box.h - 6) +
        '" text-anchor="' + (i === 0 ? "start" : i === longest.norm.length - 1 ? "end" : "middle") + '">' +
        esc(String(longest.norm[i][0]).slice(0, 10)) + "</text>";
    }).join("");

    host.innerHTML =
      '<svg class="chart-svg" viewBox="0 0 ' + box.w + " " + box.h + '" width="' + box.w +
      '" height="' + box.h + '" role="img" aria-label="Comparison chart">' +
      '<g class="chart-grid">' + grid + "</g>" + zeroLine + lines +
      '<g class="chart-axis">' + xLabels + "</g>" +
      '<g class="chart-cursor" style="display:none">' +
      '<line class="chart-cross" y1="' + PAD.top + '" y2="' + (PAD.top + innerH) + '"></line>' +
      '</g></svg>' +
      '<div class="chart-tip" hidden></div>';

    charts.multiTip(host, series, box, PAD, innerW);
    remember(host, function () { charts.multi(host, spec); });
    return true;
  };

  charts.multiTip = function (host, series, box, pad, innerW) {
    var svg = host.querySelector("svg");
    var tip = host.querySelector(".chart-tip");
    var cursor = host.querySelector(".chart-cursor");
    var line = cursor ? cursor.querySelector("line") : null;
    if (!svg || !tip || !line) return;

    function show(clientX) {
      var rect = svg.getBoundingClientRect();
      var px = (clientX - rect.left) * (rect.width ? box.w / rect.width : 1);
      var frac = Math.min(1, Math.max(0, (px - pad.left) / innerW));

      line.setAttribute("x1", (pad.left + frac * innerW).toFixed(1));
      line.setAttribute("x2", (pad.left + frac * innerW).toFixed(1));
      cursor.style.display = "";

      var tipHtml = "<dl>";
      var dateStr = "";
      series.forEach(function (s) {
        var idx = Math.min(s.norm.length - 1, Math.round(frac * (s.norm.length - 1)));
        var pt = s.norm[idx];
        if (!dateStr && pt[0]) dateStr = String(pt[0]).slice(0, 10);
        var pctVal = pt[1];
        var rawVal = pt[2];
        tipHtml += '<dt style="color:' + s.color + '">' + esc(s.label) + "</dt>" +
          '<dd class="' + (pctVal >= 0 ? "up" : "down") + '">' +
          (pctVal >= 0 ? "+" : "") + pctVal.toFixed(2) + "% " +
          '<span class="dim small">(' + esc(fmt.price(rawVal)) + ")</span></dd>";
      });
      tipHtml += "</dl>";

      tip.innerHTML = '<div class="t-date">' + esc(dateStr) + "</div>" + tipHtml;
      tip.hidden = false;
      var left = pad.left + frac * innerW;
      tip.style.left = Math.min(Math.max(left, 90), box.w - 90) + "px";
      tip.style.top = "20px";
    }

    host.addEventListener("pointermove", function (evt) { show(evt.clientX); });
    host.addEventListener("pointerleave", function () {
      cursor.style.display = "none";
      tip.hidden = true;
    });
  };

  /** Mini SVG sparkline returning an inline SVG string (no interaction). */
  charts.spark = function (points, opts) {
    var o = opts || {};
    var pts = (points || []).filter(function (p) {
      return p && fmt.isNum(typeof p === "number" ? p : p[1]);
    });
    if (pts.length < 2) return "";
    var vals = pts.map(function (p) { return typeof p === "number" ? p : p[1]; });
    var w = o.width || 80;
    var h = o.height || 24;
    var dom = extent(vals);
    if (!dom) return "";
    var lo = dom[0];
    var hi = dom[1];
    var color = o.color || (vals[vals.length - 1] >= vals[0] ? "var(--up)" : "var(--down)");

    var d = vals.map(function (v, i) {
      var px = (i / (vals.length - 1)) * w;
      var py = h - 2 - ((v - lo) / (hi - lo || 1)) * (h - 4);
      return (i ? "L" : "M") + px.toFixed(1) + " " + py.toFixed(1);
    }).join(" ");

    return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' +
      w + " " + h + '" aria-hidden="true"><path fill="none" stroke="' + color +
      '" stroke-width="1.5" d="' + d + '"></path></svg>';
  };

  D.charts = charts;
})(window.Dalal = window.Dalal || {});
