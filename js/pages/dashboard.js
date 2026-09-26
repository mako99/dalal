/* ============================================================================
   Dalal — pages/dashboard.js
   ----------------------------------------------------------------------------
   Main dashboard: Hero benchmark indices, market breadth, top gainers/losers,
   most active volume, and sectoral performance heat.
   ========================================================================== */
(function (D) {
  "use strict";

  var ui = D.ui;
  var fmt = D.fmt;
  var esc = fmt.esc;

  D.pages = D.pages || {};

  D.pages.dashboard = function (container) {
    var cleanupFns = [];

    function render() {
      var quotes = D.market.getQuotes() || {};
      var indices = D.market.getIndices() || {};
      var status = D.market.getStatus();

      // Top benchmark indices
      var heroSymbols = ["^NSEI", "^BSESN", "^NSEBANK"];
      var heroCards = heroSymbols.map(function (sym) {
        var q = indices[sym] || quotes[sym];
        var info = D.sym.indexInfo(sym) || { name: sym, short: sym };
        if (!q) {
          return '<div class="card card-hero"><div class="card-body">' +
            '<div class="dim small">' + esc(info.name) + '</div>' +
            '<div class="h2">' + fmt.NA + '</div></div></div>';
        }
        var p = q.price;
        var chg = q.change;
        var chgP = q.change_p;
        var dirClass = fmt.dir(chg);

        return '<div class="card card-hero" data-symbol="' + esc(sym) + '">' +
          '<div class="card-body">' +
            '<div class="flex-between">' +
              '<span class="bold">' + esc(info.short || sym) + '</span>' +
              '<span class="dim small">' + esc(info.name) + '</span>' +
            '</div>' +
            '<div class="hero-price-row">' +
              '<span class="hero-price ' + dirClass + '">' + esc(fmt.price(p)) + '</span>' +
              '<span class="badge ' + dirClass + '">' +
                esc(fmt.change(chg)) + ' (' + esc(fmt.pct(chgP)) + ')' +
              '</span>' +
            '</div>' +
            '<div class="hero-meta">' +
              ui.rangeMeter(p, q.low, q.high, "Day Range") +
            '</div>' +
          '</div>' +
        '</div>';
      }).join("");

      // Breadth and Top Mover calculation
      var equities = D.sym.equities();
      var advances = 0, declines = 0, unchanged = 0;
      var ranked = [];

      equities.forEach(function (eq) {
        var q = quotes[eq.symbol];
        if (q && fmt.isNum(q.change_p)) {
          if (q.change > 0) advances++;
          else if (q.change < 0) declines++;
          else unchanged++;
          ranked.push({
            symbol: eq.symbol,
            name: eq.name,
            sector: eq.sector,
            price: q.price,
            change: q.change,
            change_p: q.change_p,
            volume: q.volume
          });
        }
      });

      var gainers = ranked.slice().sort(function (a, b) { return b.change_p - a.change_p; }).slice(0, 5);
      var losers = ranked.slice().sort(function (a, b) { return a.change_p - b.change_p; }).slice(0, 5);
      var activeVol = ranked.slice().filter(function (r) { return fmt.isNum(r.volume); })
                            .sort(function (a, b) { return b.volume - a.volume; }).slice(0, 5);

      function miniTable(rows, isVolume) {
        if (!rows.length) return '<p class="dim small p-card">No live quotes available yet.</p>';
        var body = rows.map(function (r) {
          var dir = fmt.dir(r.change);
          return '<tr data-symbol="' + esc(r.symbol) + '">' +
            '<td><a href="#/stock/' + esc(r.symbol) + '" class="bold">' + esc(r.symbol) + '</a>' +
              '<div class="dim small ellipsis" style="max-width:140px">' + esc(r.name) + '</div></td>' +
            '<td class="num">' + esc(fmt.price(r.price)) + '</td>' +
            (isVolume
              ? '<td class="num bold">' + esc(fmt.volume(r.volume)) + '</td>'
              : '<td class="num ' + dir + ' bold">' + esc(fmt.pct(r.change_p)) + '</td>') +
          '</tr>';
        }).join("");
        return '<table class="data data-compact"><tbody>' + body + '</tbody></table>';
      }

      // Sector performance snapshot
      var sectorMap = {};
      equities.forEach(function (eq) {
        var q = quotes[eq.symbol];
        if (q && fmt.isNum(q.change_p)) {
          var s = eq.sector || "Other";
          if (!sectorMap[s]) sectorMap[s] = { totalPct: 0, count: 0 };
          sectorMap[s].totalPct += q.change_p;
          sectorMap[s].count++;
        }
      });
      var sectorList = Object.keys(sectorMap).map(function (s) {
        return { name: s, avgPct: sectorMap[s].totalPct / sectorMap[s].count };
      }).sort(function (a, b) { return b.avgPct - a.avgPct; });

      var sectorPills = sectorList.map(function (sec) {
        var dir = fmt.dir(sec.avgPct);
        return '<a href="#/screener?sector=' + encodeURIComponent(sec.name) + '" class="sector-pill ' + dir + '">' +
          '<span class="sector-pill-name">' + esc(sec.name) + '</span>' +
          '<span class="sector-pill-val">' + esc(fmt.pct(sec.avgPct)) + '</span>' +
        '</a>';
      }).join("");

      var html = '<div class="container">' +
        '<div class="dashboard-header flex-between mb-4">' +
          '<div>' +
            '<h1>Indian Market Overview</h1>' +
            '<p class="dim small">Real-time NSE benchmark indices and market activity</p>' +
          '</div>' +
          '<div>' + ui.freshness(status) + '</div>' +
        '</div>' +

        '<div class="grid grid-3 mb-4">' + heroCards + '</div>' +

        '<div class="card mb-4">' +
          '<div class="card-head"><h2>Market Breadth</h2></div>' +
          '<div class="card-body">' +
            ui.breadth(advances, declines, unchanged) +
          '</div>' +
        '</div>' +

        '<div class="grid grid-3 mb-4">' +
          ui.card("Top Gainers", miniTable(gainers, false), { flush: true }) +
          ui.card("Top Losers", miniTable(losers, false), { flush: true }) +
          ui.card("Most Active by Volume", miniTable(activeVol, true), { flush: true }) +
        '</div>' +

        '<div class="card mb-4">' +
          '<div class="card-head"><h2>Sector Performance</h2>' +
            '<span class="dim small">Equal-weighted basket average</span></div>' +
          '<div class="card-body"><div class="sector-pill-grid">' +
            (sectorPills || '<p class="dim small">Loading sectoral data...</p>') +
          '</div></div>' +
        '</div>' +
      '</div>';

      container.innerHTML = html;
    }

    render();
    var unsub = D.market.subscribe(function () { render(); });
    cleanupFns.push(unsub);

    return function cleanup() {
      cleanupFns.forEach(function (fn) { fn(); });
    };
  };
})(window.Dalal = window.Dalal || {});
