/* ============================================================================
   Dalal — pages/settings.js
   ----------------------------------------------------------------------------
   Application preferences, data source diagnostics, and local cache controls.
   ========================================================================== */
(function (D) {
  "use strict";

  var ui = D.ui;
  var fmt = D.fmt;
  var esc = fmt.esc;

  D.pages = D.pages || {};

  D.pages.settings = function (container) {
    var cleanupFns = [];
    var state = {
      pingMs: null,
      pingStatus: "checking",
      backendSource: null
    };

    function checkBackend() {
      var start = Date.now();
      D.api.get("/api/health").then(function (res) {
        state.pingMs = Date.now() - start;
        state.pingStatus = res && res.ok ? "healthy" : "warning";
        state.backendSource = res ? res.provider : "unknown";
        render();
      }).catch(function () {
        state.pingMs = Date.now() - start;
        state.pingStatus = "offline (using static snapshot)";
        state.backendSource = "local static";
        render();
      });
    }

    function render() {
      var currentTheme = D.prefs.get("theme", "system");
      var currentFlashes = D.prefs.get("flashes", true);

      var themeOptions = [
        { label: "System Default", value: "system" },
        { label: "Dark Theme", value: "dark" },
        { label: "Light Theme", value: "light" }
      ];

      var themeButtons = themeOptions.map(function (opt) {
        return '<button type="button" class="btn-theme" data-theme="' + esc(opt.value) +
          '" aria-pressed="' + (currentTheme === opt.value) + '">' + esc(opt.label) + '</button>';
      }).join("");

      var html = '<div class="container">' +
        '<div class="page-head mb-4">' +
          '<h1>Settings & Diagnostics</h1>' +
          '<p class="dim small">Configure Dalal preferences and verify market-data infrastructure</p>' +
        '</div>' +

        '<div class="grid grid-2 mb-4">' +
          '<div class="card">' +
            '<div class="card-head"><h2>Appearance & Behavior</h2></div>' +
            '<div class="card-body">' +
              '<div class="setting-row mb-3">' +
                '<label class="bold block mb-1">Color Theme</label>' +
                '<div class="segmented">' + themeButtons + '</div>' +
              '</div>' +
              '<div class="setting-row mb-3">' +
                '<label class="flex-center gap-2 cursor-pointer">' +
                  '<input type="checkbox" id="pref-flashes" ' + (currentFlashes ? 'checked' : '') + '> ' +
                  '<span>Enable live price tick flash animations</span>' +
                '</label>' +
              '</div>' +
            '</div>' +
          '</div>' +

          '<div class="card">' +
            '<div class="card-head"><h2>Data Connection Status</h2></div>' +
            '<div class="card-body">' +
              '<div class="mb-2"><span class="bold">Backend Status:</span> ' +
                '<span class="badge ' + (state.pingStatus === 'healthy' ? 'up' : 'down') + '">' +
                  esc(state.pingStatus) +
                '</span></div>' +
              '<div class="mb-2"><span class="bold">Round-trip Latency:</span> ' +
                (state.pingMs !== null ? esc(state.pingMs) + ' ms' : 'measuring...') + '</div>' +
              '<div class="mb-2"><span class="bold">Active Provider:</span> ' +
                (state.backendSource ? esc(state.backendSource) : 'detecting...') + '</div>' +
              '<div class="mb-3"><span class="bold">Wire Compression:</span> gzip enabled (server.py)</div>' +
              '<button type="button" id="btn-recheck-ping" class="btn btn-sm">Re-test Connection</button>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="card mb-4">' +
          '<div class="card-head"><h2>Local Storage & Cache</h2></div>' +
          '<div class="card-body">' +
            '<p class="dim small mb-3">All user preferences and watchlists are stored locally in your browser (HTML5 localStorage). No private cookies or trackers are used.</p>' +
            '<div class="flex-center gap-2">' +
              '<button type="button" id="btn-reset-prefs" class="btn btn-sm btn-ghost">Reset All Preferences</button>' +
              '<button type="button" id="btn-export-diag" class="btn btn-sm">Download System Diagnostics</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

      container.innerHTML = html;

      ui.on(container, "click", ".btn-theme", function (evt, btn) {
        var t = btn.getAttribute("data-theme");
        if (t) {
          D.prefs.set("theme", t);
          document.documentElement.setAttribute("data-theme", t);
          render();
        }
      });

      var flashesCheckbox = container.querySelector("#pref-flashes");
      if (flashesCheckbox) {
        flashesCheckbox.addEventListener("change", function () {
          D.prefs.set("flashes", flashesCheckbox.checked);
        });
      }

      var pingBtn = container.querySelector("#btn-recheck-ping");
      if (pingBtn) pingBtn.addEventListener("click", checkBackend);

      var resetBtn = container.querySelector("#btn-reset-prefs");
      if (resetBtn) {
        resetBtn.addEventListener("click", function () {
          if (confirm("Reset all stored preferences to default?")) {
            D.prefs.reset();
            location.reload();
          }
        });
      }

      var exportDiagBtn = container.querySelector("#btn-export-diag");
      if (exportDiagBtn) {
        exportDiagBtn.addEventListener("click", function () {
          var diag = {
            timestamp: new Date().toISOString(),
            status: D.market.getStatus(),
            watchlist: D.watch.list(),
            quotesCount: Object.keys(D.market.getQuotes() || {}).length,
            indicesCount: Object.keys(D.market.getIndices() || {}).length,
            ping: state.pingMs,
            backend: state.backendSource
          };
          var str = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(diag, null, 2));
          var a = document.createElement("a");
          a.href = str;
          a.download = "dalal_diagnostics.json";
          a.click();
        });
      }
    }

    render();
    checkBackend();

    return function cleanup() {
      cleanupFns.forEach(function (fn) { fn(); });
    };
  };
})(window.Dalal = window.Dalal || {});
