/* ============================================================================
   Dalal — pages/compare.js
   ----------------------------------------------------------------------------
   Multi-symbol performance comparison with normalized percentage charts.
   ========================================================================== */
(function (D) {
  "use strict";

  var ui = D.ui;
  var fmt = D.fmt;
  var esc = fmt.esc;

  D.pages = D.pages || {};

  var PALETTE = [
    "#2563eb", // blue
    "#10b981", // green
    "#f59e0b", // amber
    "#8b5cf6", // purple
    "#ef4444"  // red
  ];

  D.pages.compare = function (container, params) {
    var cleanupFns = [];
    var initialSymbols = (params && params.symbols)
      ? params.symbols.split(",").map(function (s) { return s.trim(); }).filter(Boolean)
      : ["RELIANCE", "TCS", "HDFCBANK", "INFY"];

    var state = {
      symbols: initialSymbols.slice(0, 5),
      range: "1M",
      loading: false,
      seriesData: {} // symbol -> { points: [[iso, val]] }
    };

    function loadAllSeries() {
      state.loading = true;
      var promises = state.symbols.map(function (sym) {
        return D.market.getHistory(sym, state.range).then(function (res) {
          var pts = res.points || (res.candles ? res.candles.map(function (c) { return [c.t, c.c]; }) : []);
          return { symbol: sym, points: pts };
        }).catch(function () {
          return { symbol: sym, points: [] };
        });
      });

      Promise.all(promises).then(function (results) {
        state.loading = false;
        var map = {};
        results.forEach(function (r) { map[r.symbol] = r; });
        state.seriesData = map;
        renderChart();
      });
    }

    function renderChart() {
      var chartHost = container.querySelector("#compare-chart-host");
      var statsHost = container.querySelector("#compare-stats-host");
      if (!chartHost || !statsHost) return;

      if (state.loading) {
        chartHost.innerHTML = '<div class="chart-loading"><div class="skeleton" style="height:320px"></div></div>';
        statsHost.innerHTML = '';
        return;
      }

      var chartSeries = [];
      var statsRows = [];

      state.symbols.forEach(function (sym, idx) {
        var s = state.seriesData[sym];
        var color = PALETTE[idx % PALETTE.length];
        if (s && s.points && s.points.length >= 2) {
          chartSeries.push({ label: sym, color: color, points: s.points });
          var startVal = s.points[0][1];
          var endVal = s.points[s.points.length - 1][1];
          var retPct = ((endVal - startVal) / startVal) * 100;
          var vals = s.points.map(function (p) { return p[1]; });

          statsRows.push({
            symbol: sym,
            color: color,
            start: startVal,
            end: endVal,
            returnPct: retPct,
            min: Math.min.apply(null, vals),
            max: Math.max.apply(null, vals)
          });
        }
      });

      if (!chartSeries.length) {
        chartHost.innerHTML = ui.empty("No historical data returned for the selected symbols.");
        statsHost.innerHTML = '';
        return;
      }

      D.charts.multi(chartHost, { series: chartSeries, height: 340 });

      var tbody = statsRows.map(function (row) {
        var dir = fmt.dir(row.returnPct);
        return '<tr>' +
          '<td><span class="legend-dot" style="background:' + row.color + '"></span> ' +
            '<a href="#/stock/' + esc(row.symbol) + '" class="bold">' + esc(row.symbol) + '</a></td>' +
          '<td class="num">' + esc(fmt.price(row.start)) + '</td>' +
          '<td class="num bold">' + esc(fmt.price(row.end)) + '</td>' +
          '<td class="num ' + dir + ' bold">' + esc(fmt.pct(row.returnPct)) + '</td>' +
          '<td class="num dim">' + esc(fmt.price(row.min)) + '</td>' +
          '<td class="num dim">' + esc(fmt.price(row.max)) + '</td>' +
        '</tr>';
      }).join("");

      statsHost.innerHTML = '<div class="table-wrap"><table class="data">' +
        '<thead><tr>' +
          '<th>Symbol</th><th class="num">Start Price</th><th class="num">Latest Price</th>' +
          '<th class="num">Return</th><th class="num">Min</th><th class="num">Max</th>' +
        '</tr></thead><tbody>' + tbody + '</tbody></table></div>';
    }

    function render() {
      var ranges = ["1W", "1M", "3M", "1Y"];
      var rangeButtons = ranges.map(function (r) {
        return '<button type="button" class="btn-range" data-range="' + esc(r) +
          '" aria-pressed="' + (state.range === r) + '">' + esc(r) + '</button>';
      }).join("");

      var pills = state.symbols.map(function (sym, idx) {
        var col = PALETTE[idx % PALETTE.length];
        return '<span class="symbol-pill" style="border-left: 3px solid ' + col + '">' +
          esc(sym) +
          (state.symbols.length > 1
            ? ' <button type="button" class="btn-pill-remove" data-sym="' + esc(sym) + '" aria-label="Remove ' + esc(sym) + '">&times;</button>'
            : '') +
        '</span>';
      }).join("");

      var html = '<div class="container">' +
        '<div class="page-head flex-between mb-4">' +
          '<div>' +
            '<h1>Symbol Comparison</h1>' +
            '<p class="dim small">Compare normalized percentage returns across Indian equities</p>' +
          '</div>' +
          '<div class="segmented">' + rangeButtons + '</div>' +
        '</div>' +

        '<div class="card p-card mb-4">' +
          '<div class="flex-between flex-wrap gap-3">' +
            '<div class="flex-center flex-wrap gap-2">' + pills + '</div>' +
            (state.symbols.length < 5
              ? '<form id="compare-add-form" class="flex-center gap-2">' +
                  '<input type="search" id="compare-input" class="input input-sm" placeholder="Add symbol (e.g. SBIN)...">' +
                  '<button type="submit" class="btn btn-sm">Add</button>' +
                '</form>'
              : '<span class="dim small">Max 5 symbols reached</span>') +
          '</div>' +
        '</div>' +

        '<div class="card mb-4">' +
          '<div class="card-head"><h2>Performance (% Return)</h2></div>' +
          '<div class="card-body" id="compare-chart-host"></div>' +
        '</div>' +

        '<div class="card mb-4">' +
          '<div class="card-head"><h2>Comparative Statistics</h2></div>' +
          '<div class="card-body card-body--flush" id="compare-stats-host"></div>' +
        '</div>' +
      '</div>';

      container.innerHTML = html;

      ui.on(container, "click", ".btn-range", function (evt, btn) {
        var r = btn.getAttribute("data-range");
        if (r && r !== state.range) {
          state.range = r;
          render();
          loadAllSeries();
        }
      });

      ui.on(container, "click", ".btn-pill-remove", function (evt, btn) {
        var sym = btn.getAttribute("data-sym");
        if (sym) {
          state.symbols = state.symbols.filter(function (s) { return s !== sym; });
          render();
          loadAllSeries();
        }
      });

      var form = container.querySelector("#compare-add-form");
      if (form) {
        form.addEventListener("submit", function (evt) {
          evt.preventDefault();
          var input = container.querySelector("#compare-input");
          var raw = (input.value || "").trim().toUpperCase();
          if (!raw) return;
          var canon = D.sym.canonical(raw);
          if (state.symbols.indexOf(canon) === -1 && state.symbols.length < 5) {
            state.symbols.push(canon);
            render();
            loadAllSeries();
          } else {
            ui.toast(canon + " is already in comparison", "warn", 1800);
          }
        });
      }

      renderChart();
    }

    render();
    loadAllSeries();

    return function cleanup() {
      cleanupFns.forEach(function (fn) { fn(); });
    };
  };
})(window.Dalal = window.Dalal || {});
