/* ============================================================================
   Dalal — pages/screener.js
   ----------------------------------------------------------------------------
   Stock screener: Multi-sector filters, search filter, performance tiers,
   and sortable real-time metrics table.
   ========================================================================== */
(function (D) {
  "use strict";

  var ui = D.ui;
  var fmt = D.fmt;
  var esc = fmt.esc;

  D.pages = D.pages || {};

  D.pages.screener = function (container, params) {
    var cleanupFns = [];
    var initialSector = (params && params.sector) || "all";

    var state = {
      search: "",
      sector: initialSector,
      tier: "all", // 'all' | 'gainers' | 'losers' | 'high52' | 'low52'
      sort: { key: "change_p", dir: "desc" }
    };

    var columns = [
      {
        key: "symbol",
        label: "Stock",
        sortValue: function (r) { return r.symbol; },
        html: function (r) {
          return '<div class="flex-center gap-2">' +
            '<span class="star-col" data-sym="' + esc(r.symbol) + '"></span>' +
            '<div><a href="#/stock/' + esc(r.symbol) + '" class="bold">' + esc(r.symbol) + '</a>' +
            '<div class="dim small ellipsis" style="max-width:180px">' + esc(r.name) + '</div></div>' +
          '</div>';
        }
      },
      {
        key: "sector",
        label: "Sector",
        sortValue: function (r) { return r.sector; },
        html: function (r) { return '<span class="dim small">' + esc(r.sector || "Other") + '</span>'; }
      },
      {
        key: "price",
        label: "Price",
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
        key: "volume",
        label: "Volume",
        num: true,
        sortValue: function (r) { return r.volume; },
        html: function (r) { return fmt.isNum(r.volume) ? fmt.volume(r.volume) : fmt.NA; }
      },
      {
        key: "range",
        label: "Day Range",
        sortable: false,
        html: function (r) { return ui.rangeMeter(r.price, r.low, r.high); }
      },
      {
        key: "range52",
        label: "52W Range",
        sortable: false,
        html: function (r) { return ui.rangeMeter(r.price, r.low52, r.high52); }
      }
    ];

    function render() {
      var equities = D.sym.equities();
      var quotes = D.market.getQuotes() || {};

      var rows = equities.map(function (eq) {
        var q = quotes[eq.symbol] || {};
        return {
          symbol: eq.symbol,
          name: eq.name,
          sector: eq.sector || "Other",
          price: q.price,
          change: q.change,
          change_p: q.change_p,
          volume: q.volume,
          low: q.low,
          high: q.high,
          low52: q.low52,
          high52: q.high52
        };
      });

      // Filters
      if (state.search) {
        var query = state.search.toLowerCase();
        rows = rows.filter(function (r) {
          return r.symbol.toLowerCase().indexOf(query) !== -1 ||
                 r.name.toLowerCase().indexOf(query) !== -1;
        });
      }

      if (state.sector !== "all") {
        rows = rows.filter(function (r) { return r.sector === state.sector; });
      }

      if (state.tier === "gainers") {
        rows = rows.filter(function (r) { return r.change > 0; });
      } else if (state.tier === "losers") {
        rows = rows.filter(function (r) { return r.change < 0; });
      } else if (state.tier === "high52") {
        rows = rows.filter(function (r) {
          return fmt.isNum(r.price) && fmt.isNum(r.high52) && r.price >= r.high52 * 0.95;
        });
      } else if (state.tier === "low52") {
        rows = rows.filter(function (r) {
          return fmt.isNum(r.price) && fmt.isNum(r.low52) && r.price <= r.low52 * 1.05;
        });
      }

      var sorted = ui.sortRows(rows, columns, state.sort);

      var sectors = ["all"].concat(D.sym.sectors());
      var sectorOptions = sectors.map(function (s) {
        return '<option value="' + esc(s) + '"' + (state.sector === s ? ' selected' : '') + '>' +
          esc(s === "all" ? "All Sectors" : s) + '</option>';
      }).join("");

      var tiers = [
        { label: "All Equities", value: "all" },
        { label: "Gainers", value: "gainers" },
        { label: "Losers", value: "losers" },
        { label: "Near 52W High", value: "high52" },
        { label: "Near 52W Low", value: "low52" }
      ];

      var tierButtons = tiers.map(function (t) {
        var sel = state.tier === t.value;
        return '<button type="button" class="btn-tier" data-tier="' + esc(t.value) +
          '" aria-pressed="' + sel + '">' + esc(t.label) + '</button>';
      }).join("");

      var tableHtml = ui.table({
        columns: columns,
        rows: sorted,
        sort: state.sort,
        label: "NSE Equities Screener"
      });

      var html = '<div class="container">' +
        '<div class="page-head flex-between mb-4">' +
          '<div>' +
            '<h1>Equities Screener</h1>' +
            '<p class="dim small">Filter and sort ' + equities.length + ' tracked NSE stocks</p>' +
          '</div>' +
          '<div>' + ui.freshness(D.market.getStatus()) + '</div>' +
        '</div>' +

        '<div class="card p-card mb-4">' +
          '<div class="filter-bar flex-wrap gap-3">' +
            '<input type="search" id="screener-search" class="input input-search" ' +
              'placeholder="Filter by symbol or name..." value="' + esc(state.search) + '">' +
            '<select id="screener-sector" class="select">' + sectorOptions + '</select>' +
            '<div class="segmented">' + tierButtons + '</div>' +
          '</div>' +
        '</div>' +

        '<div class="card">' +
          '<div class="card-head flex-between">' +
            '<h2>Matching Instruments (' + sorted.length + ')</h2>' +
          '</div>' +
          '<div class="card-body card-body--flush">' + tableHtml + '</div>' +
        '</div>' +
      '</div>';

      container.innerHTML = html;

      // Populate stars
      container.querySelectorAll(".star-col").forEach(function (el) {
        var sym = el.getAttribute("data-sym");
        if (sym) el.appendChild(ui.starButton(sym));
      });

      ui.bindTableSort(container, state, render);

      var searchInput = container.querySelector("#screener-search");
      if (searchInput) {
        searchInput.addEventListener("input", function () {
          state.search = searchInput.value;
          render();
        });
      }

      var sectorSelect = container.querySelector("#screener-sector");
      if (sectorSelect) {
        sectorSelect.addEventListener("change", function () {
          state.sector = sectorSelect.value;
          render();
        });
      }

      ui.on(container, "click", ".btn-tier", function (evt, btn) {
        var tier = btn.getAttribute("data-tier");
        if (tier && tier !== state.tier) {
          state.tier = tier;
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
