/* ============================================================================
   Dalal — js/app.js
   ----------------------------------------------------------------------------
   Application Shell:
   - Initializes router and maps page views
   - Manages topbar navigation, active link highlights
   - Implements global search command palette (Ctrl+K / '/')
   - Implements theme toggle (dark/light/system)
   - Refreshes statusbar with market status & data provider freshness
   - Coordinates market data initial boot
   ========================================================================== */
(function (D) {
  "use strict";

  var ui = D.ui;
  var fmt = D.fmt;
  var esc = fmt.esc;

  function initApp() {
    var mainEl = document.getElementById("main");
    var statusbarEl = document.getElementById("statusbar");
    var themeBtn = document.getElementById("themeBtn");
    var refreshBtn = document.getElementById("refreshBtn");
    var paletteBtn = document.getElementById("paletteBtn");
    var menuBtn = document.getElementById("menuBtn");
    var moreMenu = document.getElementById("moreMenu");

    // Initialize Theme
    var savedTheme = D.prefs.get("theme", "system");
    if (savedTheme !== "system") {
      document.documentElement.setAttribute("data-theme", savedTheme);
    }

    if (themeBtn) {
      themeBtn.addEventListener("click", function () {
        var current = document.documentElement.getAttribute("data-theme") || "system";
        var next = current === "light" ? "dark" : (current === "dark" ? "system" : "light");
        if (next === "system") {
          document.documentElement.removeAttribute("data-theme");
        } else {
          document.documentElement.setAttribute("data-theme", next);
        }
        D.prefs.set("theme", next);
        ui.toast("Theme set to " + next, "ok", 1200);
      });
    }

    // Refresh Button
    if (refreshBtn) {
      refreshBtn.addEventListener("click", function () {
        refreshBtn.classList.add("spinning");
        D.market.refresh().then(function () {
          refreshBtn.classList.remove("spinning");
          ui.toast("Market quotes refreshed", "ok", 1500);
        }).catch(function () {
          refreshBtn.classList.remove("spinning");
          ui.toast("Failed to refresh quotes", "warn", 2000);
        });
      });
    }

    // More Menu toggle
    if (menuBtn && moreMenu) {
      menuBtn.addEventListener("click", function (evt) {
        evt.stopPropagation();
        var isHidden = moreMenu.hasAttribute("hidden");
        if (isHidden) {
          moreMenu.removeAttribute("hidden");
          menuBtn.setAttribute("aria-expanded", "true");
        } else {
          moreMenu.setAttribute("hidden", "");
          menuBtn.setAttribute("aria-expanded", "false");
        }
      });

      document.addEventListener("click", function (evt) {
        if (!moreMenu.contains(evt.target) && evt.target !== menuBtn) {
          moreMenu.setAttribute("hidden", "");
          menuBtn.setAttribute("aria-expanded", "false");
        }
      });
    }

    // Setup Statusbar
    function updateStatusbar() {
      if (!statusbarEl) return;
      var status = D.market.getStatus();
      var stateClass = status.open ? "up" : "dim";
      var statusText = status.open ? "Market Open" : "Market Closed";
      var reasonText = status.reason ? " (" + status.reason + ")" : "";
      var provText = "NSE &bull; " + (D.market.getProviderName() || "Dalal Feed");

      statusbarEl.innerHTML =
        '<span class="status-dot ' + stateClass + '"></span> ' +
        '<span class="status-label">' + esc(statusText + reasonText) + '</span> ' +
        '<span class="status-sep">&bull;</span> ' +
        '<span class="status-prov">' + provText + '</span>';
    }

    // Search Palette
    var paletteBackdrop = document.getElementById("paletteBackdrop");
    var paletteInput = document.getElementById("paletteInput");
    var paletteList = document.getElementById("paletteList");
    var paletteHint = document.getElementById("paletteHint");
    var selectedIndex = -1;
    var currentMatches = [];

    function openPalette() {
      if (!paletteBackdrop) return;
      paletteBackdrop.removeAttribute("hidden");
      paletteInput.value = "";
      selectedIndex = -1;
      paletteInput.focus();
      updatePaletteResults("");
    }

    function closePalette() {
      if (!paletteBackdrop) return;
      paletteBackdrop.setAttribute("hidden", "");
    }

    function updatePaletteResults(query) {
      if (!paletteList) return;
      var q = (query || "").trim().toLowerCase();
      var equities = D.sym.equities();
      var indices = D.sym.indices();
      var all = indices.concat(equities);

      if (!q) {
        currentMatches = all.slice(0, 10);
      } else {
        currentMatches = all.filter(function (it) {
          return it.symbol.toLowerCase().indexOf(q) !== -1 ||
                 (it.name && it.name.toLowerCase().indexOf(q) !== -1);
        }).slice(0, 12);
      }

      if (!currentMatches.length) {
        paletteList.innerHTML = '<li class="palette-empty dim small p-card">No matching symbols found.</li>';
        if (paletteHint) paletteHint.textContent = "";
        return;
      }

      selectedIndex = 0;
      var quotes = D.market.getQuotes() || {};
      var indQuotes = D.market.getIndices() || {};

      var html = currentMatches.map(function (it, idx) {
        var isSel = idx === selectedIndex;
        var quote = quotes[it.symbol] || indQuotes[it.symbol] || {};
        var priceStr = fmt.isNum(quote.price) ? fmt.price(quote.price) : "";
        var chgBadge = fmt.isNum(quote.change_p)
          ? '<span class="badge ' + fmt.dir(quote.change) + '">' + esc(fmt.pct(quote.change_p)) + '</span>'
          : '';

        return '<li class="palette-item' + (isSel ? ' is-selected' : '') + '" role="option" data-idx="' + idx + '">' +
          '<div class="flex-between">' +
            '<div>' +
              '<span class="bold">' + esc(it.symbol) + '</span> ' +
              '<span class="dim small">' + esc(it.name) + '</span>' +
            '</div>' +
            '<div class="flex-center gap-2">' +
              (priceStr ? '<span class="num bold">' + esc(priceStr) + '</span>' : '') +
              chgBadge +
            '</div>' +
          '</div>' +
        '</li>';
      }).join("");

      paletteList.innerHTML = html;
      if (paletteHint) paletteHint.textContent = currentMatches.length + " results";
    }

    function selectPaletteItem(idx) {
      if (idx < 0 || idx >= currentMatches.length) return;
      var it = currentMatches[idx];
      closePalette();
      if (it.symbol.charAt(0) === "^") {
        location.hash = "#/markets";
      } else {
        location.hash = "#/stock/" + encodeURIComponent(it.symbol);
      }
    }

    if (paletteBtn) paletteBtn.addEventListener("click", openPalette);
    if (paletteBackdrop) {
      paletteBackdrop.addEventListener("click", function (evt) {
        if (evt.target === paletteBackdrop) closePalette();
      });
    }

    if (paletteInput) {
      paletteInput.addEventListener("input", function () {
        updatePaletteResults(paletteInput.value);
      });

      paletteInput.addEventListener("keydown", function (evt) {
        if (evt.key === "Escape") {
          closePalette();
        } else if (evt.key === "ArrowDown") {
          evt.preventDefault();
          if (currentMatches.length > 0) {
            selectedIndex = (selectedIndex + 1) % currentMatches.length;
            renderPaletteSelection();
          }
        } else if (evt.key === "ArrowUp") {
          evt.preventDefault();
          if (currentMatches.length > 0) {
            selectedIndex = (selectedIndex - 1 + currentMatches.length) % currentMatches.length;
            renderPaletteSelection();
          }
        } else if (evt.key === "Enter") {
          evt.preventDefault();
          selectPaletteItem(selectedIndex);
        }
      });
    }

    function renderPaletteSelection() {
      var items = paletteList.querySelectorAll(".palette-item");
      items.forEach(function (el, idx) {
        if (idx === selectedIndex) {
          el.classList.add("is-selected");
          el.scrollIntoView({ block: "nearest" });
        } else {
          el.classList.remove("is-selected");
        }
      });
    }

    if (paletteList) {
      ui.on(paletteList, "click", ".palette-item", function (evt, el) {
        var idx = parseInt(el.getAttribute("data-idx"), 10);
        selectPaletteItem(idx);
      });
    }

    // Keyboard Shortcuts: '/' or 'Ctrl+K' / 'Cmd+K' opens search
    document.addEventListener("keydown", function (evt) {
      var isSearchKey = (evt.key === "/" && evt.target.tagName !== "INPUT" && evt.target.tagName !== "TEXTAREA") ||
                        ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === "k");
      if (isSearchKey) {
        evt.preventDefault();
        openPalette();
      }
    });

    // Router Registration
    var router = new D.Router(mainEl);

    router.add("/", function (el) {
      return D.pages.dashboard(el);
    }, { label: "Overview", navKey: "dashboard" });

    router.add("/markets", function (el) {
      return D.pages.markets(el);
    }, { label: "Markets", navKey: "markets" });

    router.add("/stock/:symbol", function (el, params) {
      return D.pages.stock(el, params);
    }, { label: "Stock Detail", navKey: "stock" });

    router.add("/screener", function (el, params) {
      return D.pages.screener(el, params);
    }, { label: "Screener", navKey: "screener" });

    router.add("/compare", function (el, params) {
      return D.pages.compare(el, params);
    }, { label: "Compare", navKey: "compare" });

    router.add("/watchlist", function (el) {
      return D.pages.watchlist(el);
    }, { label: "Watchlist", navKey: "watchlist" });

    router.add("/calendar", function (el) {
      return D.pages.calendar(el);
    }, { label: "Calendar", navKey: "calendar" });

    router.add("/settings", function (el) {
      return D.pages.settings(el);
    }, { label: "Settings", navKey: "settings" });

    // Active link highlighting
    router.onNavigate(function (route, path) {
      var navKey = route ? route.options.navKey : "";
      document.querySelectorAll("nav a[data-route]").forEach(function (a) {
        var key = a.getAttribute("data-route");
        if (key === navKey) {
          a.setAttribute("aria-current", "page");
          a.classList.add("active");
        } else {
          a.removeAttribute("aria-current");
          a.classList.remove("active");
        }
      });
      window.scrollTo(0, 0);
    });

    // Start router
    router.start();

    // Start market engine
    D.market.init();
    updateStatusbar();
    D.market.subscribe(updateStatusbar);

  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
  } else {
    initApp();
  }
})(window.Dalal = window.Dalal || {});
