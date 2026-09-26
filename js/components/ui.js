/* ============================================================================
   Dalal — UI kit
   ----------------------------------------------------------------------------
   Small, dependency-free building blocks shared by every page:

     ui.h / ui.clear          DOM helpers (no framework, no build step)
     ui.badge                 the freshness verdict for one value
     ui.table                 an accessible, sortable table
     ui.empty / ui.banner     the honest "we have nothing to show" states
     ui.toast                 transient feedback
     ui.renderError           the router's error boundary

   Every string that reaches innerHTML goes through fmt.esc(), because company
   names arrive from the exchange's listing and are data, not markup.
   ========================================================================== */
(function (D) {
  "use strict";

  var fmt = D.fmt;
  var ui = {};
  var esc = fmt.esc;

  /* ------------------------------------------------------------ DOM helpers -- */
  ui.h = function (tag, attrs) {
    var node = document.createElement(tag);
    var bag = attrs || {};
    Object.keys(bag).forEach(function (key) {
      var value = bag[key];
      if (value === null || value === undefined || value === false) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "html") node.innerHTML = value;
      else if (key === "dataset") {
        Object.keys(value).forEach(function (k) { node.dataset[k] = value[k]; });
      } else if (key.slice(0, 2) === "on" && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, value);
    });
    for (var i = 2; i < arguments.length; i += 1) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  };

  ui.clear = function (node) {
    if (node) node.replaceChildren();
    return node;
  };

  ui.mount = function (node, html) {
    if (node) node.innerHTML = html;
    return node;
  };

  /** Build a node tree from an HTML string (used for table bodies). */
  ui.from = function (html) {
    var wrap = document.createElement("div");
    wrap.innerHTML = html;
    return wrap;
  };

  /** One delegated handler for a selector inside a container. */
  ui.on = function (root, event, selector, handler) {
    root.addEventListener(event, function (evt) {
      var target = evt.target.closest ? evt.target.closest(selector) : null;
      if (target && root.contains(target)) handler(evt, target);
    });
  };

  /* ------------------------------------------------------------- freshness -- */
  var LABELS = {
    LIVE: "Live",
    DELAYED: "Delayed",
    CLOSED: "Market closed",
    STALE: "Stale",
    UNAVAILABLE: "Data unavailable"
  };

  var CLASSES = {
    LIVE: "badge--live",
    DELAYED: "badge--delayed",
    CLOSED: "badge--closed",
    STALE: "badge--stale",
    UNAVAILABLE: "badge--unavailable"
  };

  /**
   * The freshness verdict for one quote. The server's own verdict is used when
   * present; otherwise it is recomputed here with the same rules (age against
   * the latest completed session), so a cached snapshot is judged exactly the
   * way a live response is.
   */
  ui.freshness = function (quote, market) {
    if (!quote || !fmt.isNum(quote.price)) return "UNAVAILABLE";
    if (quote.freshness && LABELS[quote.freshness]) return quote.freshness;
    var age = Date.now() / 1000 - (fmt.isNum(quote.asOf) ? quote.asOf : 0);
    var trade = market && market.tradeDate;
    var day = fmt.isoDay(quote.asOf);
    if (trade && day) {
      if (day >= trade) return market.isOpen ? (age <= 900 ? "LIVE" : "DELAYED") : "CLOSED";
      return "STALE";
    }
    if (age > 86400) return "STALE";
    return market && market.isOpen ? (age <= 900 ? "LIVE" : "DELAYED") : "CLOSED";
  };

  ui.freshnessLabel = function (state) { return LABELS[state] || LABELS.UNAVAILABLE; };

  /** <span class="badge badge--closed">Market closed</span> */
  ui.badge = function (state, extra) {
    var cls = CLASSES[state] || CLASSES.UNAVAILABLE;
    return '<span class="badge ' + cls + '">' + esc(LABELS[state] || state) +
           (extra ? " · " + esc(extra) : "") + "</span>";
  };

  /** Badge for a quote, plus the session time it belongs to. */
  ui.quoteBadge = function (quote, market) {
    var state = ui.freshness(quote, market);
    var when = quote && fmt.isNum(quote.asOf) && quote.asOf > 0 ? fmt.time(quote.asOf) : "";
    return ui.badge(state) +
      (when ? ' <span class="dim small">as of ' + esc(when) + " IST</span>"
            : ' <span class="dim small">no timestamp</span>');
  };

  /* ------------------------------------------------------------ value cells -- */
  /** Price, flashing when the number moved since the previous poll. */
  ui.priceHtml = function (quote, opts) {
    var o = opts || {};
    if (!quote || !fmt.isNum(quote.price)) {
      return '<span class="dim" title="' +
        esc((quote && quote.reason) || "not reported") + '">' + fmt.NA + "</span>";
    }
    var moved = o.flash === false ? null : D.market.moved(quote.sym);
    return '<span class="num' + (moved ? " flash-" + moved : "") + '">' +
      esc(fmt.price(quote.price, o.dp)) + "</span>";
  };

  ui.changeHtml = function (change, pct) {
    if (!fmt.isNum(change) && !fmt.isNum(pct)) return '<span class="dim">' + fmt.NA + "</span>";
    var dir = fmt.dir(fmt.isNum(pct) ? pct : change);
    return '<span class="num ' + dir + '">' + esc(fmt.pct(pct)) + "</span>" +
      (fmt.isNum(change)
        ? ' <span class="small ' + dir + ' num">(' + esc(fmt.change(change)) + ")</span>"
        : "");
  };
  /** The 52-week range meter with today's level marked on it. */
  ui.rangeMeter = function (low, high, price) {
    if (!fmt.isNum(low) || !fmt.isNum(high) || high <= low || !fmt.isNum(price)) {
      return '<p class="dim small">52-week range not reported by the provider.</p>';
    }
    var pos = Math.min(100, Math.max(0, ((price - low) / (high - low)) * 100));
    return '<div class="range-meter" role="img" aria-label="' + esc(
        "52-week range " + fmt.price(low) + " to " + fmt.price(high) +
        ", now " + fmt.price(price)) + '">' +
      '<div class="fill" style="width:' + pos.toFixed(1) + '%"></div>' +
      '<div class="marker" style="left:' + pos.toFixed(1) + '%"></div></div>' +
      '<div class="range-labels"><span class="num">' + esc(fmt.price(low)) +
      ' <span class="dim">52w low</span></span><span class="num">' + esc(fmt.price(high)) +
      ' <span class="dim">52w high</span></span></div>';
  };

  ui.breadthHtml = function (breadth) {
    if (!breadth || !fmt.isNum(breadth.advances)) {
      return '<p class="dim small">Advance / decline counts are not available.</p>';
    }
    var total = Math.max(1, breadth.advances + breadth.declines + breadth.unchanged);
    function pct(n) { return ((n / total) * 100).toFixed(1) + "%"; }
    return '<div class="breadth" role="img" aria-label="' + esc(
        breadth.advances + " advancing, " + breadth.declines + " declining, " +
        breadth.unchanged + " unchanged") + '">' +
      '<div class="adv" style="width:' + pct(breadth.advances) + '"></div>' +
      '<div class="unch" style="width:' + pct(breadth.unchanged) + '"></div>' +
      '<div class="dec" style="width:' + pct(breadth.declines) + '"></div></div>' +
      '<div class="breadth-legend">' +
      '<span class="up">▲ ' + esc(fmt.count(breadth.advances)) + " advancing</span>" +
      '<span class="down">▼ ' + esc(fmt.count(breadth.declines)) + " declining</span>" +
      '<span class="dim">' + esc(fmt.count(breadth.unchanged)) + " unchanged</span></div>";
  };

  /* ------------------------------------------------------------------ states -- */
  ui.empty = function (opts) {
    var o = opts || {};
    return '<div class="empty"><div class="empty-icon" aria-hidden="true">' +
      (o.icon || "◍") + "</div><h3>" + esc(o.title || "Nothing to show") + "</h3>" +
      (o.message ? "<p>" + esc(o.message) + "</p>" : "") +
      (o.actionHref
        ? '<a class="btn btn--primary" href="' + esc(o.actionHref) + '">' +
          esc(o.actionLabel || "Continue") + "</a>"
        : "") + "</div>";
  };

  ui.banner = function (kind, message, opts) {
    var o = opts || {};
    return '<div class="banner' + (kind ? " banner--" + kind : "") + '">' +
      '<span aria-hidden="true">' + (kind === "error" || kind === "warn" ? "⚠" : "ℹ") + "</span>" +
      "<span>" + esc(message) + "</span>" +
      (o.actionLabel
        ? '<span class="b-actions"><button class="btn btn--sm" type="button" data-action="' +
          esc(o.action) + '">' + esc(o.actionLabel) + "</button></span>"
        : "") + "</div>";
  };

  ui.skeleton = function (variant, count) {
    var out = "";
    for (var i = 0; i < (count || 1); i += 1) {
      out += '<div class="skeleton skeleton--' + (variant || "line") + '"></div>';
    }
    return out;
  };

  /** The one place that explains why a value is missing. */
  ui.unavailable = function (what, reason) {
    return '<div class="note note--warn"><span aria-hidden="true">⚠</span><span>' +
      "<b>" + esc(what) + ": data unavailable.</b> " +
      esc(reason || "The configured providers did not return this value.") +
      "</span></div>";
  };

  ui.renderError = function (root, err, path) {
    ui.mount(root,
      '<div class="container"><div class="card"><div class="card-body">' +
      ui.banner("error", "Something went wrong rendering " + (path || "this page") + ": " +
                String((err && err.message) || err)) +
      '<p class="muted small" style="margin-top:12px">Open the browser console for the full ' +
      "stack trace. The rest of the app is still usable.</p>" +
      '<p style="margin-top:12px"><a class="btn" href="#/">Back to overview</a></p>' +
      "</div></div></div>");
  };

  /* ------------------------------------------------------------------ toasts -- */
  ui.toast = function (message, kind, ms) {
    var host = document.getElementById("toasts");
    if (!host) return;
    var node = ui.h("div", { class: "toast" + (kind ? " toast--" + kind : ""),
                             role: "status", text: message });
    host.appendChild(node);
    window.setTimeout(function () {
      node.style.opacity = "0";
      window.setTimeout(function () { node.remove(); }, 220);
    }, ms || 3200);
  };

  /* ------------------------------------------------------------------ tables -- */
  /**
   * Sortable table markup.
   *   columns: [{key, label, num?, sortValue?(row), html?(row), sortable?}]
   *   rows:    plain objects; `symbol` drives row linking and the flash.
   */
  ui.table = function (opts) {
    var columns = opts.columns || [];
    var rows = opts.rows || [];
    var sort = opts.sort || { key: columns[0] && columns[0].key, dir: "desc" };

    var head = columns.map(function (col) {
      if (col.sortable === false) {
        return '<th scope="col"' + (col.num ? ' class="num"' : "") + ">" +
          esc(col.label) + "</th>";
      }
      var aria = "none";
      if (sort && sort.key === col.key) aria = sort.dir === "asc" ? "ascending" : "descending";
      return '<th scope="col" class="sortable' + (col.num ? " num" : "") + '" ' +
        'aria-sort="' + aria + '" data-sort="' + esc(col.key) + '" tabindex="0">' +
        esc(col.label) + "</th>";
    }).join("");

    var body = rows.map(function (row) {
      var cells = columns.map(function (col) {
        var value;
        if (col.html) value = col.html(row);
        else if (row[col.key] === null || row[col.key] === undefined) value = fmt.NA;
        else value = esc(row[col.key]);
        return "<td" + (col.num ? ' class="num"' : "") + ">" + value + "</td>";
      }).join("");
      var rowClass = opts.rowClass ? opts.rowClass(row) : "";
      return '<tr data-symbol="' + esc(row.symbol || "") + '"' +
        (rowClass ? ' class="' + esc(rowClass) + '"' : "") + ">" + cells + "</tr>";
    }).join("");

    return '<div class="table-wrap"><table class="data"' +
      (opts.label ? ' aria-label="' + esc(opts.label) + '"' : "") + ">" +
      (opts.caption ? "<caption>" + esc(opts.caption) + "</caption>" : "") +
      "<thead><tr>" + head + "</tr></thead><tbody>" +
      (body || '<tr><td colspan="' + Math.max(1, columns.length) + '" class="dim">' +
        esc(opts.emptyMessage || "No rows match the current filters.") + "</td></tr>") +
      "</tbody></table></div>";
  };

  /** Sort rows by a column definition; unknown values always sink. */
  ui.sortRows = function (rows, columns, sort) {
    if (!sort || !sort.key) return rows;
    var col = columns.filter(function (c) { return c.key === sort.key; })[0];
    if (!col || !col.sortValue) return rows;
    var factor = sort.dir === "asc" ? 1 : -1;
    var pick = col.sortValue;
    return rows.slice().sort(function (a, b) {
      var x = pick(a);
      var y = pick(b);
      var xn = x === null || x === undefined || (typeof x === "number" && !isFinite(x));
      var yn = y === null || y === undefined || (typeof y === "number" && !isFinite(y));
      if (xn && yn) return 0;
      if (xn) return 1;
      if (yn) return -1;
      if (typeof x === "number" && typeof y === "number") return (x - y) * factor;
      return String(x).localeCompare(String(y)) * factor;
    });
  };

  /** Click + keyboard sorting for a table host. */
  ui.bindTableSort = function (host, state, rerender) {
    function activate(th) {
      var key = th.getAttribute("data-sort");
      if (!key) return;
      if (state.sort.key === key) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      else { state.sort.key = key; state.sort.dir = "desc"; }
      rerender();
    }
    ui.on(host, "click", "th[data-sort]", function (evt, th) { activate(th); });
    ui.on(host, "keydown", "th[data-sort]", function (evt, th) {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        activate(th);
      }
    });
  };
  /* --------------------------------------------------------------- controls -- */
  /** A segmented control; `onPick(value)` fires on click. */
  ui.segmented = function (items, active, onPick, label) {
    var box = ui.h("div", { class: "segmented", role: "group",
                            "aria-label": label || "Options" });
    items.forEach(function (item) {
      var value = item.value === undefined ? item : item.value;
      var text = item.label === undefined ? item : item.label;
      box.appendChild(ui.h("button", {
        type: "button",
        "aria-pressed": String(value === active),
        text: text,
        onclick: function () { onPick(value); }
      }));
    });
    return box;
  };

  ui.select = function (options, value, onChange, attrs) {
    var sel = ui.h("select", Object.assign({ class: "select" }, attrs || {}));
    options.forEach(function (opt) {
      var node = ui.h("option", { value: opt.value, text: opt.label });
      if (String(opt.value) === String(value)) node.selected = true;
      sel.appendChild(node);
    });
    sel.addEventListener("change", function () { onChange(sel.value); });
    return sel;
  };

  var STAR_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" stroke="currentColor" ' +
    'stroke-width="1.8" aria-hidden="true"><path d="M12 3.5l2.7 5.6 6 .8-4.4 4.2 1.1 6' +
    '-5.4-3-5.4 3 1.1-6-4.4-4.2 6-.8z"/></svg>';

  /** Watchlist star; keeps itself in sync with the stored list. */
  ui.starButton = function (symbol) {
    var sym = D.sym.canonical(symbol);
    var on = D.watch.has(sym);
    var node = ui.h("button", {
      class: "star",
      type: "button",
      "aria-pressed": String(on),
      "aria-label": "Toggle " + sym + " in your watchlist",
      title: "Toggle watchlist",
      html: STAR_SVG,
      onclick: function (evt) {
        evt.preventDefault();
        evt.stopPropagation();
        var added = D.watch.toggle(sym);
        ui.toast((added ? "Added " : "Removed ") + sym +
                 (added ? " to" : " from") + " your watchlist", "ok", 1800);
      }
    });
    node.firstChild.setAttribute("fill", on ? "currentColor" : "none");
    D.watch.subscribe(function (list) {
      var yes = list.indexOf(sym) !== -1;
      node.setAttribute("aria-pressed", String(yes));
      node.firstChild.setAttribute("fill", yes ? "currentColor" : "none");
    });
    return node;
  };

  /** A switch row that writes straight through to the preference store. */
  ui.switchRow = function (label, key, help) {
    var input = ui.h("input", { type: "checkbox", checked: !!D.prefs.get(key) });
    input.addEventListener("change", function () { D.prefs.set(key, input.checked); });
    return ui.h("label", { class: "switch" }, input,
      ui.h("span", { class: "track" }), ui.h("span", { text: label }),
      help ? ui.h("span", { class: "dim small", text: help }) : null);
  };

  ui.card = function (title, bodyHtml, opts) {
    var o = opts || {};
    return '<section class="card">' +
      (title
        ? '<div class="card-head"><div><h2>' + esc(title) + "</h2>" +
          (o.sub ? '<p class="card-sub">' + esc(o.sub) + "</p>" : "") + "</div>" +
          (o.aside || "") + "</div>"
        : "") +
      '<div class="card-body' + (o.flush ? " card-body--flush" : "") + '">' + bodyHtml +
      "</div>" +
      (o.foot ? '<div class="card-foot">' + o.foot + "</div>" : "") + "</section>";
  };

  ui.pageHead = function (title, sub, actionsHtml) {
    return '<div class="container"><div class="page-head"><div><div class="page-title">' +
      "<h1>" + esc(title) + "</h1></div>" +
      (sub ? '<p class="page-sub">' + esc(sub) + "</p>" : "") + "</div>" +
      (actionsHtml ? '<div class="page-actions">' + actionsHtml + "</div>" : "") +
      "</div></div>";
  };
})(window.Dalal = window.Dalal || {});
