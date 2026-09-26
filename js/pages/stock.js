/* ============================================================================
   Dalal — pages/stock.js
   ----------------------------------------------------------------------------
   Individual stock quote view with interactive charts, technical stats,
   and fundamentals.
   ========================================================================== */
(function (D) {
  "use strict";

  var ui = D.ui;
  var fmt = D.fmt;
  var esc = fmt.esc;

  D.pages = D.pages || {};

  D.pages.stock = function (container, params) {
    var rawSymbol = (params && params.symbol) || "RELIANCE";
    var symbol = D.sym.canonical(rawSymbol);
    var cleanupFns = [];

    var state = {
      range: "1M",
      mode: "line", // 'line' | 'candle'
      historyLoading: false,
      historyData: null,
      fundamentalsLoading: false,
      fundamentalsData: null
    };

    function loadHistory() {
      state.historyLoading = true;
      D.market.getHistory(symbol, state.range).then(function (data) {
        state.historyData = data;
        state.historyLoading = false;
        renderChart();
      }).catch(function () {
        state.historyLoading = false;
        renderChart();
      });
    }

    function loadFundamentals() {
      state.fundamentalsLoading = true;
      D.market.getFundamentals(symbol).then(function (data) {
        state.fundamentalsData = data;
        state.fundamentalsLoading = false;
        renderFundamentals();
      }).catch(function () {
        state.fundamentalsLoading = false;
        renderFundamentals();
      });
    }

    function renderChart() {
      var chartHost = container.querySelector("#stock-chart-host");
      if (!chartHost) return;

      if (state.historyLoading) {
        chartHost.innerHTML = '<div class="chart-loading"><div class="skeleton" style="height:280px"></div></div>';
        return;
      }

      var data = state.historyData;
      if (!data || (!data.candles && !data.points)) {
        chartHost.innerHTML = ui.empty("No historical data available for " + symbol + " (" + state.range + ").");
        return;
      }

      var q = (D.market.getQuotes() || {})[symbol] || {};

      if (state.mode === "candle" && data.candles && data.candles.length) {
        D.charts.candles(chartHost, {
          candles: data.candles,
          height: 300,
          label: symbol
        });
      } else {
        var pts = data.points || (data.candles ? data.candles.map(function (c) { return [c.t, c.c]; }) : []);
        var vols = data.candles ? data.candles.map(function (c) { return c.v; }) : null;
        D.charts.line(chartHost, {
          points: pts,
          volumes: vols,
          baseline: q.prev_close,
          height: 300,
          label: symbol
        });
      }
    }

    function renderFundamentals() {
      var fHost = container.querySelector("#stock-fundamentals-host");
      if (!fHost) return;

      if (state.fundamentalsLoading) {
        fHost.innerHTML = '<div class="skeleton" style="height:120px"></div>';
        return;
      }

      var f = state.fundamentalsData;
      if (!f || Object.keys(f).length === 0) {
        fHost.innerHTML = '<p class="dim small">Fundamental statistics unavailable for this instrument.</p>';
        return;
      }

      var items = [
        { label: "Market Cap", val: fmt.compact(f.market_cap, "₹") },
        { label: "P/E Ratio", val: fmt.isNum(f.pe) ? f.pe.toFixed(2) : fmt.NA },
        { label: "P/B Ratio", val: fmt.isNum(f.pb) ? f.pb.toFixed(2) : fmt.NA },
        { label: "EPS (TTM)", val: fmt.isNum(f.eps) ? "₹" + f.eps.toFixed(2) : fmt.NA },
        { label: "Div Yield", val: fmt.isNum(f.dividend_yield) ? fmt.pct(f.dividend_yield) : fmt.NA },
        { label: "ROE", val: fmt.isNum(f.roe) ? fmt.pct(f.roe) : fmt.NA },
        { label: "Debt / Equity", val: fmt.isNum(f.debt_to_equity) ? f.debt_to_equity.toFixed(2) : fmt.NA },
        { label: "Book Value", val: fmt.isNum(f.book_value) ? "₹" + f.book_value.toFixed(2) : fmt.NA }
      ];

      fHost.innerHTML = '<div class="grid grid-4 stats-grid">' +
        items.map(function (it) {
          return '<div class="stat-box">' +
            '<div class="dim small">' + esc(it.label) + '</div>' +
            '<div class="bold">' + esc(it.val) + '</div>' +
          '</div>';
        }).join("") + '</div>';
    }

    function render() {
      var meta = D.sym.lookup(symbol) || { symbol: symbol, name: symbol, sector: "Equity" };
      var quotes = D.market.getQuotes() || {};
      var indices = D.market.getIndices() || {};
      var q = quotes[symbol] || indices[symbol] || {};
      var status = D.market.getStatus();

      var ranges = ["1D", "1W", "1M", "1Y", "5Y"];
      var rangeButtons = ranges.map(function (r) {
        var sel = state.range === r;
        return '<button type="button" class="btn-range" data-range="' + esc(r) +
          '" aria-pressed="' + sel + '">' + esc(r) + '</button>';
      }).join("");

      var modeButtons = '<div class="segmented">' +
        '<button type="button" class="btn-mode" data-mode="line" aria-pressed="' +
          (state.mode === "line") + '">Line</button>' +
        '<button type="button" class="btn-mode" data-mode="candle" aria-pressed="' +
          (state.mode === "candle") + '">Candle</button>' +
      '</div>';

      var p = q.price;
      var chg = q.change;
      var chgP = q.change_p;
      var dirClass = fmt.dir(chg);

      var stats = [
        { label: "Previous Close", val: fmt.isNum(q.prev_close) ? fmt.price(q.prev_close) : fmt.NA },
        { label: "Open", val: fmt.isNum(q.open) ? fmt.price(q.open) : fmt.NA },
        { label: "Day High", val: fmt.isNum(q.high) ? fmt.price(q.high) : fmt.NA },
        { label: "Day Low", val: fmt.isNum(q.low) ? fmt.price(q.low) : fmt.NA },
        { label: "Volume", val: fmt.isNum(q.volume) ? fmt.volume(q.volume) : fmt.NA },
        { label: "52-Week High", val: fmt.isNum(q.high52) ? fmt.price(q.high52) : fmt.NA },
        { label: "52-Week Low", val: fmt.isNum(q.low52) ? fmt.price(q.low52) : fmt.NA }
      ];

      var statsHtml = '<div class="grid grid-4 stats-grid mb-4">' +
        stats.map(function (s) {
          return '<div class="stat-box">' +
            '<div class="dim small">' + esc(s.label) + '</div>' +
            '<div class="bold">' + esc(s.val) + '</div>' +
          '</div>';
        }).join("") + '</div>';

      var html = '<div class="container">' +
        '<div class="stock-header flex-between mb-3">' +
          '<div>' +
            '<div class="flex-center gap-2">' +
              '<h1>' + esc(meta.name) + '</h1>' +
              '<span class="badge">' + esc(symbol) + '</span>' +
              '<span class="dim small">' + esc(meta.sector || "") + '</span>' +
              '<span id="star-btn-host"></span>' +
            '</div>' +
            '<div class="dim small mt-1">NSE &bull; Regular Trading &bull; INR</div>' +
          '</div>' +
          '<div>' + ui.freshness(status) + '</div>' +
        '</div>' +

        '<div class="stock-price-hero mb-4">' +
          '<div class="hero-price-row">' +
            '<span class="hero-price ' + dirClass + '">' + (fmt.isNum(p) ? esc(fmt.price(p)) : fmt.NA) + '</span>' +
            '<span class="badge ' + dirClass + ' large">' +
              (fmt.isNum(chg) ? esc(fmt.change(chg)) + ' (' + esc(fmt.pct(chgP)) + ')' : fmt.NA) +
            '</span>' +
          '</div>' +
          '<div class="dim small mt-1">As of ' + esc(fmt.time(q.timestamp || Date.now())) + '</div>' +
        '</div>' +

        '<div class="grid grid-2 mb-4">' +
          '<div class="card p-card">' + ui.rangeMeter(p, q.low, q.high, "Day Range") + '</div>' +
          '<div class="card p-card">' + ui.rangeMeter(p, q.low52, q.high52, "52-Week Range") + '</div>' +
        '</div>' +

        '<div class="card mb-4">' +
          '<div class="card-head flex-between">' +
            '<div class="segmented">' + rangeButtons + '</div>' +
            modeButtons +
          '</div>' +
          '<div class="card-body" id="stock-chart-host"></div>' +
        '</div>' +

        '<div class="card mb-4">' +
          '<div class="card-head"><h2>Key Trading Statistics</h2></div>' +
          '<div class="card-body">' + statsHtml + '</div>' +
        '</div>' +

        '<div class="card mb-4">' +
          '<div class="card-head"><h2>Company Fundamentals</h2></div>' +
          '<div class="card-body" id="stock-fundamentals-host"></div>' +
        '</div>' +
      '</div>';

      container.innerHTML = html;

      var starHost = container.querySelector("#star-btn-host");
      if (starHost) starHost.appendChild(ui.starButton(symbol));

      ui.on(container, "click", ".btn-range", function (evt, btn) {
        var r = btn.getAttribute("data-range");
        if (r && r !== state.range) {
          state.range = r;
          container.querySelectorAll(".btn-range").forEach(function (b) {
            b.setAttribute("aria-pressed", String(b.getAttribute("data-range") === r));
          });
          loadHistory();
        }
      });

      ui.on(container, "click", ".btn-mode", function (evt, btn) {
        var m = btn.getAttribute("data-mode");
        if (m && m !== state.mode) {
          state.mode = m;
          container.querySelectorAll(".btn-mode").forEach(function (b) {
            b.setAttribute("aria-pressed", String(b.getAttribute("data-mode") === m));
          });
          renderChart();
        }
      });

      renderChart();
      renderFundamentals();
    }

    render();
    loadHistory();
    loadFundamentals();

    var unsub = D.market.subscribe(function () {
      render();
    });
    cleanupFns.push(unsub);

    return function cleanup() {
      cleanupFns.forEach(function (fn) { fn(); });
    };
  };
})(window.Dalal = window.Dalal || {});
