/* ============================================================================
   Dalal — hash router
   ----------------------------------------------------------------------------
   Hash routing keeps the app deployable as plain static files (GitHub Pages,
   a USB stick, `file://`), which is how this project ships. Each route owns a
   render function returning an optional cleanup, so a page can unsubscribe
   from the market store when the reader navigates away instead of leaking a
   listener per visit.
   ========================================================================== */
(function (D) {
  "use strict";

  var routes = [];
  var current = null;
  var cleanup = null;
  var listeners = [];

  function parse(hash) {
    var raw = String(hash || "").replace(/^#/, "");
    var qsAt = raw.indexOf("?");
    var path = qsAt === -1 ? raw : raw.slice(0, qsAt);
    var query = {};
    if (qsAt !== -1) {
      raw.slice(qsAt + 1).split("&").forEach(function (pair) {
        if (!pair) return;
        var i = pair.indexOf("=");
        var k = decodeURIComponent(i === -1 ? pair : pair.slice(0, i));
        var v = i === -1 ? "" : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, " "));
        query[k] = v;
      });
    }
    if (!path || path === "/") path = "/";
    return { path: path.replace(/\/+$/, "") || "/", query: query, hash: raw };
  }

  function match(path) {
    for (var i = 0; i < routes.length; i += 1) {
      var route = routes[i];
      var names = [];
      var pattern = route.path.replace(/:([A-Za-z0-9_]+)/g, function (_, name) {
        names.push(name);
        return "([^/]+)";
      });
      var m = new RegExp("^" + pattern + "$").exec(path);
      if (!m) continue;
      var params = {};
      names.forEach(function (name, idx) { params[name] = decodeURIComponent(m[idx + 1]); });
      return { route: route, params: params };
    }
    return null;
  }

  var router = {
    /** Register a route: {path: "/stock/:symbol", name, title, render}. */
    add: function (route) {
      routes.push(route);
      routes.sort(function (a, b) { return b.path.length - a.path.length; });
      return router;
    },

    subscribe: function (fn) {
      listeners.push(fn);
      return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
    },

    current: function () { return current; },

    navigate: function (hash) {
      if (window.location.hash === hash) return router.resolve();
      window.location.hash = hash;
    },

    /** Render the route for the current hash. Safe to call at any time. */
    resolve: function () {
      var loc = parse(window.location.hash);
      var found = match(loc.path) || match("/");
      if (cleanup) {
        try { cleanup(); } catch (err) { if (window.console) console.error(err); }
        cleanup = null;
      }
      current = {
        name: found.route.name,
        path: loc.path,
        query: loc.query,
        params: found.params,
        route: found.route
      };
      document.title = (found.route.title ? found.route.title + " · " : "") + "Dalal";
      listeners.forEach(function (fn) {
        try { fn(current); } catch (err) { if (window.console) console.error(err); }
      });
      if (found.route.render) {
        try {
          var result = found.route.render(D.app.view(), current);
          if (typeof result === "function") cleanup = result;
        } catch (err) {
          if (window.console) console.error(err);
          D.ui.renderError(D.app.view(), err, loc.path);
        }
      }
      return current;
    },

    /** A link's href for a route name + params, for building anchors in JS. */
    href: function (name, params, query) {
      var route = routes.filter(function (r) { return r.name === name; })[0];
      if (!route) return "#/";
      var path = route.path;
      Object.keys(params || {}).forEach(function (k) {
        path = path.replace(":" + k, encodeURIComponent(params[k]));
      });
      var qs = Object.keys(query || {}).filter(function (k) {
        return query[k] !== undefined && query[k] !== null && query[k] !== "";
      }).map(function (k) {
        return encodeURIComponent(k) + "=" + encodeURIComponent(query[k]);
      }).join("&");
      return "#" + path + (qs ? "?" + qs : "");
    },

    start: function () {
      window.addEventListener("hashchange", function () {
        router.resolve();
        var main = document.getElementById("main");
        if (main && !D.router.current().query.keepScroll) main.focus({ preventScroll: true });
        window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
      });
      return router.resolve();
    },

    parse: parse
  };

  D.router = router;
})(window.Dalal = window.Dalal || {});
