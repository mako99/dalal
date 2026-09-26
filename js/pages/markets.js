/* ============================================================================
   Dalal — pages/markets.js
   ----------------------------------------------------------------------------
   Comprehensive overview of Indian benchmark and sectoral indices.
   ========================================================================== */
(function (D) {
  "use strict";

  var ui = D.ui;
  var fmt = D.fmt;
  var esc = fmt.esc;

  D.pages = D.pages || {};

  D.pages.markets = function (container) {
    var cleanupFns = [];
    var state = {
      sort: { key: "change_p", dir: "desc" },
      activeTab: "all"
    };

    var columns = [
      {
        key: "name",
        label: "Index",
        sortValue: function (r) { return r.name; },
        html: function (r) {
          return '<div><span class="bold">' + esc(r.name) + '</span>' +
            '<div class="dim small">' + esc(r.symbol) + '</div></div>';
        }
      },
      {
        key: "price",
        label: "Value",
        num: true,
        sortValue: function (r) { return r.price; },
        html: function (r) { return fmt.isNum(r.price) ? fmt.price(r.price) : fmt.NA; }
      },
      {
        key: "change",
        label: "Change",
        num: true,
        sortValue: function (r) { return r.change; },
        html: function (r) { return ui.changeBadge(r.change, r.change_p); }
      },
      {
        key: "range",
        label: "Day Range",
        sortable: false,
        html: function (r) { return ui.rangeMeter(r.price, r.low, r.high); }
      },
      {
        key: "range52",
        label: "52-Week Range",
        sortable: false,
        html: function (r) { return ui.rangeMeter(r.price, r.low52, r.high52); }
      }
    ];

    function render() {
      var allIndices = D.sym.indices();
      var cachedIndices = D.market.getIndices() || {};
      var quotes = D.market.getQuotes() || {};

      var rows = allIndices.map(function (idx) {
        var q = cachedIndices[idx.symbol] || quotes[idx.symbol] || {};
        return {
          symbol: idx.symbol,
          name: idx.name,
          category: idx.category || "broad",
          price: q.price,
          change: q.change,
          change_p: q.change_p,
          low: q.low,
          high: q.high,
          low52: q.low52,
          high52: q.high52
        };
      });

      if (state.activeTab !== "all") {
        rows = rows.filter(function (r) { return r.category === state.activeTab; });
      }

      var sorted = ui.sortRows(rows, columns, state.sort);

      var tabs = [
        { label: "All Indices", value: "all" },
        { label: "Broad Market", value: "broad" },
        { label: "Sectoral", value: "sectoral" }
      ];

      var tabsHtml = '<div class="segmented mb-4" role="tablist">' +
        tabs.map(function (t) {
          var sel = state.activeTab === t.value;
          return '<button type="button" class="tab-btn" role="tab" aria-selected="' +
            sel + '" data-tab="' + esc(t.value) + '">' + esc(t.label) + '</button>';
        }).join("") + '</div>';

      var tableHtml = ui.table({
        columns: columns,
        rows: sorted,
        sort: state.sort,
        label: "Indian Market Indices"
      });

      var html = '<div class="container">' +
        '<div class="page-head flex-between mb-4">' +
          '<div>' +
            '<h1>Market Indices</h1>' +
            '<p class="dim small">NSE & BSE benchmark and sectoral indices</p>' +
          '</div>' +
          '<div>' + ui.freshness(D.market.getStatus()) + '</div>' +
        '</div>' +
        tabsHtml +
        '<div class="card">' +
          '<div class="card-body card-body--flush">' + tableHtml + '</div>' +
        '</div>' +
      '</div>';

      container.innerHTML = html;

      ui.bindTableSort(container, state, render);

      ui.on(container, "click", ".tab-btn", function (evt, btn) {
        var tab = btn.getAttribute("data-tab");
        if (tab && tab !== state.activeTab) {
          state.activeTab = tab;
          render();
        }
      });
    }

    render();
    var unsub = D.market.subscribe(function () { render(); });
    cleanupFns.push(unsub);

    return function cleanup() {
      cleanupFns.forEach(function (fn) { fn(); });
    };
  };
})(window.Dalal = window.Dalal || {});
