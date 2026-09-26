/* ============================================================================
   Dalal — pages/watchlist.js
   ----------------------------------------------------------------------------
   User watchlist view with fast removal, sorting, and export.
   ========================================================================== */
(function (D) {
  "use strict";

  var ui = D.ui;
  var fmt = D.fmt;
  var esc = fmt.esc;

  D.pages = D.pages || {};

  D.pages.watchlist = function (container) {
    var cleanupFns = [];
    var state = {
      sort: { key: "change_p", dir: "desc" }
    };

    var columns = [
      {
        key: "symbol",
        label: "Instrument",
        sortValue: function (r) { return r.symbol; },
        html: function (r) {
          return '<div><a href="#/stock/' + esc(r.symbol) + '" class="bold">' + esc(r.symbol) + '</a>' +
            '<div class="dim small ellipsis" style="max-width:180px">' + esc(r.name) + '</div></div>';
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
      },
      {
        key: "action",
        label: "Remove",
        sortable: false,
        html: function (r) {
          return '<button type="button" class="btn btn-sm btn-ghost btn-remove-watch" ' +
            'data-sym="' + esc(r.symbol) + '" aria-label="Remove ' + esc(r.symbol) + '">&times;</button>';
        }
      }
    ];

    function render() {
      var syms = D.watch.list();
      var quotes = D.market.getQuotes() || {};
      var indices = D.market.getIndices() || {};

      if (!syms.length) {
        var emptyHtml = '<div class="container">' +
          '<div class="page-head flex-between mb-4">' +
            '<div>' +
              '<h1>Watchlist</h1>' +
              '<p class="dim small">Keep track of your favorite Indian equities and indices</p>' +
            '</div>' +
          '</div>' +
          '<div class="card p-card">' +
            ui.empty("Your watchlist is currently empty.") +
            '<div class="text-center mt-3">' +
              '<p class="dim small mb-2">Quickly add top benchmark stocks:</p>' +
              '<div class="flex-center flex-wrap gap-2">' +
                '<button type="button" class="btn btn-sm btn-add-preset" data-sym="RELIANCE">+ RELIANCE</button>' +
                '<button type="button" class="btn btn-sm btn-add-preset" data-sym="TCS">+ TCS</button>' +
                '<button type="button" class="btn btn-sm btn-add-preset" data-sym="HDFCBANK">+ HDFCBANK</button>' +
                '<button type="button" class="btn btn-sm btn-add-preset" data-sym="INFY">+ INFY</button>' +
                '<button type="button" class="btn btn-sm btn-add-preset" data-sym="ICICIBANK">+ ICICIBANK</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>';
        container.innerHTML = emptyHtml;

        ui.on(container, "click", ".btn-add-preset", function (evt, btn) {
          var s = btn.getAttribute("data-sym");
          if (s) {
            D.watch.add(s);
            ui.toast("Added " + s + " to watchlist", "ok", 1500);
          }
        });
        return;
      }

      var rows = syms.map(function (sym) {
        var meta = D.sym.lookup(sym) || { symbol: sym, name: sym, sector: "Other" };
        var q = quotes[sym] || indices[sym] || {};
        return {
          symbol: sym,
          name: meta.name,
          sector: meta.sector || "Other",
          price: q.price,
          change: q.change,
          change_p: q.change_p,
          low: q.low,
          high: q.high,
          low52: q.low52,
          high52: q.high52
        };
      });

      var sorted = ui.sortRows(rows, columns, state.sort);

      var tableHtml = ui.table({
        columns: columns,
        rows: sorted,
        sort: state.sort,
        label: "Saved Watchlist"
      });

      var html = '<div class="container">' +
        '<div class="page-head flex-between mb-4">' +
          '<div>' +
            '<h1>Watchlist (' + syms.length + ')</h1>' +
            '<p class="dim small">Saved instruments stored locally in your browser</p>' +
          '</div>' +
          '<div class="flex-center gap-2">' +
            '<button type="button" id="btn-export-watch" class="btn btn-sm">Export JSON</button>' +
            '<button type="button" id="btn-clear-watch" class="btn btn-sm btn-ghost">Clear All</button>' +
          '</div>' +
        '</div>' +
        '<div class="card">' +
          '<div class="card-body card-body--flush">' + tableHtml + '</div>' +
        '</div>' +
      '</div>';

      container.innerHTML = html;

      ui.bindTableSort(container, state, render);

      ui.on(container, "click", ".btn-remove-watch", function (evt, btn) {
        var sym = btn.getAttribute("data-sym");
        if (sym) {
          D.watch.remove(sym);
          ui.toast("Removed " + sym, "ok", 1500);
        }
      });

      var clearBtn = container.querySelector("#btn-clear-watch");
      if (clearBtn) {
        clearBtn.addEventListener("click", function () {
          if (confirm("Are you sure you want to clear your entire watchlist?")) {
            D.watch.set([]);
            ui.toast("Watchlist cleared", "ok", 1500);
          }
        });
      }

      var exportBtn = container.querySelector("#btn-export-watch");
      if (exportBtn) {
        exportBtn.addEventListener("click", function () {
          var dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(syms, null, 2));
          var dlAnchor = document.createElement("a");
          dlAnchor.setAttribute("href", dataStr);
          dlAnchor.setAttribute("download", "dalal_watchlist.json");
          dlAnchor.click();
        });
      }
    }

    render();
    var unsubM = D.market.subscribe(function () { render(); });
    var unsubW = D.watch.subscribe(function () { render(); });
    cleanupFns.push(unsubM, unsubW);

    return function cleanup() {
      cleanupFns.forEach(function (fn) { fn(); });
    };
  };
})(window.Dalal = window.Dalal || {});
