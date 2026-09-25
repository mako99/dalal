/* ============================================================
   Dalal — app shell: router, views, search, watchlist
   ============================================================ */
(function () {
  "use strict";
  const D = window.DALAL;
  const C = window.Charts;
  const $ = s => document.querySelector(s);
  const app = $("#app");

  /* ================= watchlist (localStorage) ================= */
  const WL_KEY = "dalal.watchlist.v1";
  let watchlist = [];
  try { watchlist = JSON.parse(localStorage.getItem(WL_KEY) || "[]"); } catch (e) { watchlist = []; }
  function saveWL() { try { localStorage.setItem(WL_KEY, JSON.stringify(watchlist)); } catch (e) {} }
  function inWL(sym) { return watchlist.includes(sym); }
  function toggleWL(sym) {
    if (inWL(sym)) watchlist = watchlist.filter(s => s !== sym);
    else watchlist.push(sym);
    saveWL();
  }

  /* ================= shared UI helpers ================= */
  function initials(sym) {
    const map = { RELIANCE: "R", TCS: "T", HDFCBANK: "H", INFY: "IN", ICICIBANK: "ICICI", HINDUNILVR: "HUL", ITC: "ITC", SBIN: "SBI", BHARTIARTL: "A", LT: "L&T", TATAMOTORS: "TM", ADANIENT: "AE" };
    return map[sym] || sym.slice(0, 2);
  }
  function logo(sym, color, cls) {
    return `<div class="${cls || "mr-logo"}" style="background:${color}">${initials(sym)}</div>`;
  }
  function chgHTML(pct, abs) {
    if (pct == null) return `<span class="muted">—</span>`;
    const cls = pct >= 0 ? "up" : "down";
    const arrow = pct >= 0 ? "▲" : "▼";
    return `<span class="${cls}">${arrow} ${D.fmtPct(Math.abs(pct))}${abs != null ? " (" + (abs >= 0 ? "+" : "−") + D.fmtPrice(Math.abs(abs)).slice(1) + ")" : ""}</span>`;
  }
  function chgCls(v) { return v >= 0 ? "up" : "down"; }
  function retBar(label, v) {
    if (v == null) return "";
    const w = Math.min(100, Math.abs(v) / 60 * 100);
    const cls = v >= 0 ? "up" : "down";
    const col = v >= 0 ? "var(--green)" : "var(--red)";
    return `<div class="ret-row"><span class="rr-l">${label}</span>
      <div class="ret-track"><div class="ret-fill" style="width:${w}%;background:${col}"></div></div>
      <span class="rr-v ${cls}">${D.fmtPct(v, true)}</span></div>`;
  }
  function starBtn(sym) {
    return `<button class="watch-star ${inWL(sym) ? "on" : ""}" data-star="${sym}" title="${inWL(sym) ? "Remove from" : "Add to"} watchlist">${inWL(sym) ? "★" : "☆"}</button>`;
  }
  function bindStars(root) {
    (root || document).querySelectorAll("[data-star]").forEach(b => {
      b.addEventListener("click", e => {
        e.stopPropagation();
        toggleWL(b.dataset.star);
        b.classList.toggle("on");
        b.textContent = b.classList.contains("on") ? "★" : "☆";
      });
    });
  }
  function reveal(root) {
    const els = (root || document).querySelectorAll(".reveal");
    const io = new IntersectionObserver(es => {
      es.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { threshold: 0.08 });
    els.forEach(el => io.observe(el));
  }

  /* ================= ticker tape ================= */
  function buildTicker() {
    const el = $("#ticker");
    // indices first, then the core names — a thousands-strong listing would
    // make the tape enormous, so it shows a representative slice (search and
    // the screener still cover every stock).
    const TAPE_MAX = 64;
    const all = D.INDICES.concat(D.STOCKS);
    const items = (all.length > TAPE_MAX ? all.slice(0, TAPE_MAX) : all)
      .map(x => ({ sym: x.sym, name: x.name, stats: x.stats }));
    const one = items.map(ix => {
      const c = ix.stats.day.pct;
      return `<span class="tk"><b>${ix.sym}</b><span class="num">${ix.stats.last.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span><span class="tk-chg ${chgCls(c)}">${c >= 0 ? "▲" : "▼"} ${Math.abs(c).toFixed(2)}%</span><span class="dot"></span></span>`;
    }).join("");
    el.innerHTML = `<div class="ticker-track">${one}${one}</div>`;
  }

  /* ================= nav search ================= */
  function initSearch() {
    const input = $("#navSearch"), panel = $("#navSearchPanel");
    function render() {
      const res = D.searchAll(input.value);
      if (!input.value.trim()) { panel.classList.remove("open"); return; }
      panel.innerHTML = res.length ? res.map(r => {
        const it = r.item, st = it.stats;
        const sub = r.type === "index" ? it.full : it.sector;
        const px = st.last.toLocaleString("en-IN", { maximumFractionDigits: 2 });
        const c = st.day.pct;
        return `<div class="search-item" data-go="${r.type === "index" ? "index" : "stock"}:${it.sym}">
          ${logo(it.sym, it.color, "si-logo")}
          <div><div class="si-name">${it.name}</div><div class="si-sub">${sub}</div></div>
          <div class="si-px"><b class="num">${px}</b><span class="${chgCls(c)}">${D.fmtPct(c, true)}</span></div>
        </div>`;
      }).join("") : `<div class="search-empty">No results for “${input.value}”</div>`;
      panel.classList.add("open");
      panel.querySelectorAll("[data-go]").forEach(item => {
        item.addEventListener("click", () => {
          const [type, sym] = item.dataset.go.split(":");
          panel.classList.remove("open");
          input.value = "";
          location.hash = type === "index" ? `#/index/${encodeURIComponent(sym)}` : `#/stock/${sym}`;
        });
      });
    }
    input.addEventListener("input", render);
    input.addEventListener("focus", render);
    document.addEventListener("click", e => {
      if (!e.target.closest(".search-wrap")) panel.classList.remove("open");
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") panel.classList.remove("open");
      if (e.key === "/" && document.activeElement !== input) { e.preventDefault(); input.focus(); }
    });
  }

  /* ================= ROUTER ================= */
  let activeChart = null;
  function cleanup() { if (activeChart) { activeChart.destroy(); activeChart = null; } }

  function route() {
    cleanup();
    const hash = location.hash || "#/";
    const parts = hash.replace(/^#\//, "").split("/").map(decodeURIComponent);
    document.querySelectorAll("[data-nav]").forEach(a => a.classList.remove("active"));
    window.scrollTo(0, 0);
    if (parts[0] === "stock" && D.bySymbol(parts[1])) { renderStock(D.bySymbol(parts[1])); }
    else if (parts[0] === "index" && D.indexBySymbol(parts[1])) { renderIndex(D.indexBySymbol(parts[1])); }
    else if (parts[0] === "screener") { setActiveNav("screener"); renderScreener(); }
    else if (parts[0] === "compare") { setActiveNav("compare"); renderCompare(parts.slice(1)); }
    else if (parts[0] === "watchlist") { setActiveNav("watchlist"); renderWatchlist(); }
    else { setActiveNav("overview"); renderOverview(); }
  }
  function setActiveNav(name) {
    const a = document.querySelector(`[data-nav="${name}"]`);
    if (a) a.classList.add("active");
  }

  /* ================= VIEW: Overview ================= */
  function renderOverview() {
    const nifty = D.indexBySymbol("NIFTY 50");
    const sorted = [...D.STOCKS].sort((a, b) => b.stats.day.pct - a.stats.day.pct);
    const gainers = sorted.slice(0, 5), losers = sorted.slice(-5).reverse();
    const advCount = D.STOCKS.filter(s => s.stats.day.pct > 0).length;

    app.innerHTML = `
    <section class="hero">
      <div class="eyebrow">Dalal · Indian Market Intelligence</div>
      <h1>Analyse stocks.<br/><span class="grad">Beautifully.</span></h1>
      <p class="sub">Five years of performance, deep fundamentals, ownership trends and a screener — everything you need to study a stock, crafted with care for the Indian market.</p>
      <div class="hero-cta">
        <a class="btn btn-primary" href="#/screener">Explore the Screener</a>
        <a class="btn btn-outline-dark" href="#/stock/RELIANCE">Analyse Reliance →</a>
      </div>
      <div class="hero-meta">
        <span><b>${D.STOCKS.length}</b> large caps covered</span>
        <span><b>5 yrs</b> of daily history</span>
        <span><b>${advCount}/${D.STOCKS.length}</b> advancing today</span>
        <span><b>FY21–FY25</b> financials</span>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <div class="section-head reveal">
          <div class="kicker">Indices</div>
          <h2>The market at a glance.</h2>
          <p>Tap any index or stock to open its full analysis.</p>
        </div>
        <div class="index-grid" id="indexGrid"></div>
      </div>
    </section>

    <section class="section alt">
      <div class="container">
        <div class="section-head reveal">
          <div class="kicker">Today</div>
          <h2>Movers & shakers.</h2>
        </div>
        <div class="movers-grid reveal">
          <div class="mover-card"><h3>🏆 Top Gainers</h3><div id="gainers"></div></div>
          <div class="mover-card"><h3>📉 Top Losers</h3><div id="losers"></div></div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <div class="section-head reveal">
          <div class="kicker">Toolkit</div>
          <h2>Everything you need to dig deeper.</h2>
        </div>
        <div class="tiles reveal">
          <div class="tile tile-blue">
            <div class="tile-art">🔎</div>
            <h3>Screener</h3>
            <p>Filter ${D.STOCKS.length} large caps by valuation, returns, dividends and balance-sheet strength.</p>
            <a class="tile-link" href="#/screener">Open Screener →</a>
          </div>
          <div class="tile tile-dark">
            <div class="tile-art">⚖️</div>
            <h3>Compare</h3>
            <p>Put up to five stocks side by side — multiples, returns, ownership and a normalized performance chart.</p>
            <a class="tile-link" href="#/compare">Compare Stocks →</a>
          </div>
          <div class="tile tile-grey">
            <div class="tile-art">⭐</div>
            <h3>Watchlist</h3>
            <p>Star the stocks you care about. Your list stays on this device, ready whenever you return.</p>
            <a class="tile-link" href="#/watchlist">My Watchlist →</a>
          </div>
          <div class="tile tile-green">
            <div class="tile-art">📊</div>
            <h3>Deep Analysis</h3>
            <p>Every stock page packs 5-year charts, moving averages, financials, shareholding, pros & cons and a composite score.</p>
            <a class="tile-link" href="#/stock/TCS">See an example →</a>
          </div>
        </div>
      </div>
    </section>`;

    /* index cards */
    const grid = $("#indexGrid");
    grid.innerHTML = D.INDICES.map(ix => {
      const st = ix.stats;
      return `<div class="index-card reveal" data-ix="${ix.sym}">
        <div class="ic-name">${ix.name}</div><div class="ic-full">${ix.full}</div>
        <div class="ic-px num">${st.last.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</div>
        <div class="ic-chg">${chgHTML(st.day.pct, st.day.chg)}</div>
        <canvas data-spark="${ix.sym}"></canvas>
      </div>`;
    }).join("");
    grid.querySelectorAll(".index-card").forEach(card => {
      card.addEventListener("click", () => location.hash = `#/index/${encodeURIComponent(card.dataset.ix)}`);
    });
    grid.querySelectorAll("canvas[data-spark]").forEach(cv => {
      const ix = D.indexBySymbol(cv.dataset.spark);
      C.spark(cv, ix.close.slice(-126), ix.stats.day.pct >= 0 ? "#00a852" : "#e30000", ix.stats.day.pct >= 0);
    });

    /* movers */
    function moverRows(list, mount) {
      mount.innerHTML = list.map(s => {
        const st = s.stats;
        return `<div class="mover-row" data-go="${s.sym}">
          ${logo(s.sym, s.color)}
          <div><div class="mr-name">${s.name}</div><div class="mr-sub">${s.sector}</div></div>
          <div class="mr-px"><b class="num">${D.fmtPrice(st.last)}</b><span class="${chgCls(st.day.pct)}">${D.fmtPct(st.day.pct, true)}</span></div>
        </div>`;
      }).join("");
      mount.querySelectorAll("[data-go]").forEach(r => r.addEventListener("click", () => location.hash = "#/stock/" + r.dataset.go));
    }
    moverRows(gainers, $("#gainers"));
    moverRows(losers, $("#losers"));
    reveal(app);
  }

  /* ================= VIEW: Index detail ================= */
  function renderIndex(ix) {
    const st = ix.stats;
    app.innerHTML = `
    <section class="detail-hero">
      <div class="container">
        <div class="dh-top">
          <div class="dh-logo" style="background:${ix.color}">₹</div>
          <div class="dh-id">
            <h1>${ix.name}</h1>
            <div class="dh-sub">${ix.full}</div>
            <div class="dh-badges"><span class="badge b-blue">Index</span><span class="badge">NSE / BSE</span></div>
          </div>
          <div class="dh-price">
            <div class="px num">${st.last.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</div>
            <div class="chg">${chgHTML(st.day.pct, st.day.chg)}</div>
            <div class="asof">As of ${D.fmtDate(D.DATES[D.DATES.length - 1])} · demo data</div>
          </div>
        </div>
      </div>
    </section>
    <section class="section" style="padding-top:56px">
      <div class="container">
        <div class="chart-card">
          <div class="chart-toolbar">
            <div class="pills" id="rangePills">
              ${["1M", "3M", "6M", "1Y", "3Y", "5Y"].map(r => `<button class="pill ${r === "1Y" ? "active" : ""}" data-r="${r}">${r}</button>`).join("")}
            </div>
            <div class="chart-legend">
              <span class="lg"><span class="sw" style="background:${ix.color}"></span>${ix.sym}</span>
              <span class="lg"><span class="sw" style="background:#86868b"></span>Nifty 50</span>
            </div>
          </div>
          <div class="chart-wrap">
            <canvas id="priceChart"></canvas>
            <div class="chart-tip" id="chartTip"></div>
          </div>
          <div class="chart-foot">
            <div class="cf-item"><div class="cf-l">1-Year Return</div><div class="cf-v ${chgCls(st.y1)}">${D.fmtPct(st.y1, true)}</div></div>
            <div class="cf-item"><div class="cf-l">3-Year Return</div><div class="cf-v ${chgCls(st.y3)}">${D.fmtPct(st.y3, true)}</div></div>
            <div class="cf-item"><div class="cf-l">5-Year Return</div><div class="cf-v ${chgCls(st.y5)}">${D.fmtPct(st.y5, true)}</div></div>
            <div class="cf-item"><div class="cf-l">52W High</div><div class="cf-v">${st.hl52.high.toLocaleString("en-IN")}</div></div>
            <div class="cf-item"><div class="cf-l">52W Low</div><div class="cf-v">${st.hl52.low.toLocaleString("en-IN")}</div></div>
          </div>
        </div>
      </div>
    </section>`;
    const nifty = D.indexBySymbol("NIFTY 50");
    activeChart = C.priceChart($("#priceChart"), $("#chartTip"), {
      series: ix.close, dates: D.DATES, color: ix.color, range: "1Y",
      compare: [nifty], label: ix.sym
    });
    $("#rangePills").addEventListener("click", e => {
      const b = e.target.closest("[data-r]"); if (!b) return;
      $("#rangePills").querySelectorAll(".pill").forEach(p => p.classList.remove("active"));
      b.classList.add("active");
      activeChart.setRange(b.dataset.r);
    });
  }

  /* ================= VIEW: Stock detail ================= */
  function renderStock(s) {
    const st = s.stats, f = s.f, sc = D.scoreOf(s), val = D.valuationVerdict(s);
    const nifty = D.indexBySymbol("NIFTY 50");
    const last = D.DATES[D.DATES.length - 1];
    const above50 = st.last > st.sma50[st.sma50.length - 1];
    const above200 = st.last > st.sma200[st.sma200.length - 1];
    const revG = (s.fin.revenue[4] / s.fin.revenue[0] - 1) * 100;
    const patG = (s.fin.pat[4] / Math.abs(s.fin.pat[0]) - 1) * 100 * Math.sign(s.fin.pat[4] * s.fin.pat[0] >= 0 ? 1 : 1);

    app.innerHTML = `
    <section class="detail-hero">
      <div class="container">
        <div class="dh-top">
          ${logo(s.sym, s.color, "dh-logo")}
          <div class="dh-id">
            <h1>${s.name}</h1>
            <div class="dh-sub">NSE : ${s.sym} &nbsp;·&nbsp; BSE : ${s.bse} &nbsp;·&nbsp; ${s.sector}</div>
            <div class="dh-badges">
              ${s.tags.map(t => `<span class="badge">${t}</span>`).join("")}
              <span class="badge ${val.cls}">Valuation: ${val.label}</span>
            </div>
          </div>
          <div class="dh-price">
            <div class="px num">${D.fmtPrice(st.last)}</div>
            <div class="chg">${chgHTML(st.day.pct, st.day.chg)}</div>
            <div class="asof">As of ${D.fmtDate(last)} · demo data</div>
          </div>
        </div>
        <div class="dh-actions">
          <button class="btn btn-ghost btn-sm" id="btnCmp">⚖️ Compare with…</button>
          <button class="btn ${inWL(s.sym) ? "btn-dark" : "btn-primary"} btn-sm" id="btnWL">${inWL(s.sym) ? "★ In Watchlist" : "☆ Add to Watchlist"}</button>
        </div>
      </div>
    </section>

    <div class="container" style="margin-top:0">
      <!-- CHART -->
      <div class="chart-card">
        <div class="chart-toolbar">
          <div class="pills" id="rangePills">
            ${["1M", "3M", "6M", "1Y", "3Y", "5Y"].map(r => `<button class="pill ${r === "1Y" ? "active" : ""}" data-r="${r}">${r}</button>`).join("")}
          </div>
          <div class="pills" id="togglePills">
            <button class="pill active" data-t="ma">MA</button>
            <button class="pill active" data-t="vol">Vol</button>
            <button class="pill" data-t="cmp">vs Nifty</button>
          </div>
          <div class="chart-legend">
            <span class="lg"><span class="sw" style="background:${s.color}"></span>${s.sym}</span>
            <span class="lg"><span class="sw" style="background:#ff9f0a"></span>50 DMA</span>
            <span class="lg"><span class="sw" style="background:#bf5af2"></span>200 DMA</span>
          </div>
        </div>
        <div class="chart-wrap">
          <canvas id="priceChart"></canvas>
          <div class="chart-tip" id="chartTip"></div>
        </div>
        <div class="chart-foot">
          <div class="cf-item"><div class="cf-l">Open (prev close)</div><div class="cf-v num">${D.fmtPrice(s.close[s.close.length - 2])}</div></div>
          <div class="cf-item"><div class="cf-l">Day Range</div><div class="cf-v num">${D.fmtPrice(st.last * 0.994)} – ${D.fmtPrice(st.last * 1.006)}</div></div>
          <div class="cf-item"><div class="cf-l">52W Range</div><div class="cf-v num">${D.fmtPrice(st.hl52.low)} – ${D.fmtPrice(st.hl52.high)}</div></div>
          <div class="cf-item"><div class="cf-l">Volume (avg 3M)</div><div class="cf-v">${D.fmtVol(s.volume.slice(-63).reduce((a, b) => a + b, 0) / 63)}</div></div>
        </div>
      </div>

      <!-- SCORE + KEY METRICS -->
      <div class="grid-2" style="margin-top:16px">
        <div class="card reveal">
          <h3>Dalal Score <span class="h-sub">composite of 6 factors</span></h3>
          <div class="score-hero">
            <div>
              <div class="score-big" style="color:${sc.color}">${sc.score}</div>
              <span class="score-pill" style="background:${sc.color}">${sc.label}</span>
            </div>
            <div class="score-bars">
              ${Object.entries(sc.parts).map(([k, v]) => `
                <div class="sb-row"><span class="sb-l">${k}</span>
                  <div class="sb-track"><div class="sb-fill" style="width:${v}%;background:${sc.color}"></div></div>
                  <span class="sb-v">${Math.round(v)}</span></div>`).join("")}
            </div>
          </div>
        </div>
        <div class="card reveal">
          <h3>Key Ratios</h3>
          <div class="stat-grid">
            <div class="stat"><div class="st-l">Market Cap</div><div class="st-v">${D.fmtCr(f.mcap)}</div></div>
            <div class="stat"><div class="st-l">P/E (vs sector ${f.sectorPe})</div><div class="st-v">${f.pe}</div></div>
            <div class="stat"><div class="st-l">P/B</div><div class="st-v">${f.pb}</div></div>
            <div class="stat"><div class="st-l">EPS (TTM)</div><div class="st-v">₹${f.eps}</div></div>
            <div class="stat"><div class="st-l">Book Value</div><div class="st-v">₹${f.bookValue}</div></div>
            <div class="stat"><div class="st-l">Dividend Yield</div><div class="st-v">${f.divYield}%</div></div>
            <div class="stat"><div class="st-l">ROE</div><div class="st-v">${f.roe}%</div></div>
            <div class="stat"><div class="st-l">ROCE</div><div class="st-v">${f.roce}%</div></div>
            <div class="stat"><div class="st-l">Debt / Equity</div><div class="st-v">${f.de}</div></div>
            <div class="stat"><div class="st-l">Face Value</div><div class="st-v">₹${s.faceValue}</div></div>
            <div class="stat"><div class="st-l">Beta (3Y)</div><div class="st-v">${s.beta}</div></div>
            <div class="stat"><div class="st-l">Promoter Pledge</div><div class="st-v">${f.pledge}%</div></div>
          </div>
        </div>
      </div>

      <!-- RETURNS + ABOUT -->
      <div class="grid-2" style="margin-top:16px">
        <div class="card reveal">
          <h3>Performance <span class="h-sub">price returns</span></h3>
          ${retBar("1W", st.w1)}
          ${retBar("1M", st.m1)}
          ${retBar("6M", st.m6)}
          ${retBar("1Y", st.y1)}
          ${retBar("3Y", st.y3)}
          ${retBar("5Y", st.y5)}
          <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--hairline-2)" class="small muted">
            vs Nifty 50 (1Y): <b class="${chgCls(st.y1 - nifty.stats.y1)}">${D.fmtPct(st.y1 - nifty.stats.y1, true)}</b> relative &nbsp;·&nbsp;
            52W position: <b>${Math.round((st.last - st.hl52.low) / (st.hl52.high - st.hl52.low) * 100)}%</b> of range
          </div>
        </div>
        <div class="card reveal">
          <h3>About the company</h3>
          <p style="font-size:14.5px;line-height:1.6;color:var(--text-2)">${s.about}</p>
          <div style="margin-top:14px;display:flex;gap:22px;flex-wrap:wrap" class="small">
            <span class="muted">5Y Revenue CAGR <b style="color:var(--text)">${Math.pow(s.fin.revenue[4] / s.fin.revenue[0], 1 / 4) * 100 - 100 < 0 ? "−" : "+"}${(Math.abs(Math.pow(s.fin.revenue[4] / s.fin.revenue[0], 1 / 4) * 100 - 100)).toFixed(1)}%</b></span>
            <span class="muted">5Y PAT growth <b style="color:var(--text)">${patG >= 0 ? "+" : "−"}${Math.abs(patG).toFixed(0)}%</b></span>
            <span class="muted">Above 50 DMA <b style="color:${above50 ? "var(--green)" : "var(--red)"}">${above50 ? "Yes" : "No"}</b></span>
            <span class="muted">Above 200 DMA <b style="color:${above200 ? "var(--green)" : "var(--red)"}">${above200 ? "Yes" : "No"}</b></span>
          </div>
        </div>
      </div>

      <!-- FINANCIALS -->
      <div class="grid-2" style="margin-top:16px">
        <div class="card reveal">
          <h3>Income Statement <span class="h-sub">₹ crore</span></h3>
          <div class="fin-scroll">
            <table class="fin-table">
              <tr><th></th>${s.fin.years.map(y => `<th>${y}</th>`).join("")}</tr>
              <tr><td>Revenue</td>${s.fin.revenue.map(v => `<td>${D.fmtNum(v)}</td>`).join("")}</tr>
              <tr><td>Net Profit (PAT)</td>${s.fin.pat.map(v => `<td class="${v < 0 ? "neg" : ""}">${D.fmtNum(v)}</td>`).join("")}</tr>
              <tr><td>Net Margin %</td>${s.fin.margin.map(v => `<td>${v}%</td>`).join("")}</tr>
              <tr><td>EPS (₹)</td>${s.fin.eps.map(v => `<td>${v}</td>`).join("")}</tr>
            </table>
          </div>
        </div>
        <div class="card reveal">
          <h3>Profit Trend <span class="h-sub">PAT ₹ crore</span></h3>
          <canvas id="patChart" style="width:100%;height:210px;display:block"></canvas>
        </div>
      </div>

      <!-- SHAREHOLDING -->
      <div class="grid-2" style="margin-top:16px">
        <div class="card reveal">
          <h3>Shareholding Pattern <span class="h-sub">%</span></h3>
          <table class="sh-table">
            <tr><th></th>${s.sh.quarters.map(q => `<th>${q}</th>`).join("")}<th>Trend</th></tr>
            ${shRow("Promoters", s.sh.promoter)}
            ${shRow("FIIs", s.sh.fii)}
            ${shRow("DIIs", s.sh.dii)}
            ${shRow("Govt.", s.sh.govt)}
            ${shRow("Public", s.sh.public)}
          </table>
        </div>
        <div class="card reveal">
          <h3>Ownership Mix <span class="h-sub">latest quarter</span></h3>
          <div style="display:flex;align-items:center;gap:26px;flex-wrap:wrap">
            <canvas id="shDonut" style="width:190px;height:190px;flex-shrink:0"></canvas>
            <div style="flex:1;min-width:180px">
              ${[["Promoters", s.sh.promoter[4], "#0071e3"], ["FIIs", s.sh.fii[4], "#ff9f0a"], ["DIIs", s.sh.dii[4], "#30d158"], ["Govt.", s.sh.govt[4], "#5856d6"], ["Public", s.sh.public[4], "#c7c7cc"]]
                .map(([n, v, c]) => `<div class="ret-row"><span class="rr-l" style="width:76px"><span class="sw" style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${c};margin-right:7px"></span>${n}</span>
                <div class="ret-track"><div class="ret-fill" style="width:${v}%;background:${c}"></div></div>
                <span class="rr-v">${v}%</span></div>`).join("")}
            </div>
          </div>
        </div>
      </div>

      <!-- PROS & CONS -->
      <div class="grid-2" style="margin-top:16px;margin-bottom:70px">
        <div class="card reveal">
          <h3 style="color:var(--green)">✦ Strengths</h3>
          <ul class="pc-list">${s.pros.map(p => `<li><span class="pc-ic good">✓</span>${p}</li>`).join("")}</ul>
        </div>
        <div class="card reveal">
          <h3 style="color:var(--red)">✦ Things to watch</h3>
          <ul class="pc-list">${s.cons.map(c => `<li><span class="pc-ic bad">!</span>${c}</li>`).join("")}</ul>
        </div>
      </div>
    </div>`;

    function shRow(name, arr) {
      const d = arr[4] - arr[0];
      return `<tr><td>${name}</td>${arr.map(v => `<td>${v}</td>`).join("")}
        <td class="trend ${chgCls(d)}">${d > 0 ? "▲" : d < 0 ? "▼" : "•"} ${Math.abs(d).toFixed(1)}</td></tr>`;
    }

    /* chart */
    activeChart = C.priceChart($("#priceChart"), $("#chartTip"), {
      series: s.close, dates: D.DATES, color: s.color, volume: s.volume,
      sma50: st.sma50, sma200: st.sma200, range: "1Y"
    });
    $("#rangePills").addEventListener("click", e => {
      const b = e.target.closest("[data-r]"); if (!b) return;
      $("#rangePills").querySelectorAll(".pill").forEach(p => p.classList.remove("active"));
      b.classList.add("active");
      activeChart.setRange(b.dataset.r);
    });
    $("#togglePills").addEventListener("click", e => {
      const b = e.target.closest("[data-t]"); if (!b) return;
      b.classList.toggle("active");
      if (b.dataset.t === "ma") activeChart.toggleMA();
      if (b.dataset.t === "vol") activeChart.toggleVol();
      if (b.dataset.t === "cmp") activeChart.toggleCmp();
    });

    /* PAT bars + donut */
    C.bars($("#patChart"), s.fin.years, s.fin.pat, s.color, v => v >= 0 ? D.fmtNum(v) : "−" + D.fmtNum(Math.abs(v)));
    C.donut($("#shDonut"), [
      { value: s.sh.promoter[4], color: "#0071e3" },
      { value: s.sh.fii[4], color: "#ff9f0a" },
      { value: s.sh.dii[4], color: "#30d158" },
      { value: s.sh.govt[4], color: "#5856d6" },
      { value: s.sh.public[4], color: "#c7c7cc" }
    ], s.sh.promoter[4] + "%", "promoters");

    /* actions */
    $("#btnWL").addEventListener("click", () => {
      toggleWL(s.sym);
      renderStock(s);
    });
    $("#btnCmp").addEventListener("click", () => {
      location.hash = "#/compare/" + s.sym + "/NIFTY 50".replace(" ", "+");
    });
    bindStars(app);
    reveal(app);
  }

  /* ================= VIEW: Screener ================= */
  const SC = { q: "", sector: "", peMin: "", peMax: "", divMin: "", sort: "mcap", dir: -1, onlyWL: false, limit: 300 };

  function renderScreener() {
    const sectors = [...new Set(D.STOCKS.map(s => s.sector))];
    app.innerHTML = `
    <section class="section" style="padding-top:44px">
      <div class="container">
        <div class="section-head" style="margin-bottom:30px">
          <div class="kicker">Screener</div>
          <h2>Find your next idea.</h2>
          <p>Filter the universe on the metrics that matter.</p>
        </div>
        <div class="screener-layout">
          <div class="card filter-card">
            <h3>Filters</h3>
            <div class="f-group"><label>Search</label><input id="fQ" type="text" placeholder="Name or symbol…" value="${SC.q}"/></div>
            <div class="f-group"><label>Sector</label>
              <select id="fSector"><option value="">All sectors</option>${sectors.map(x => `<option ${SC.sector === x ? "selected" : ""}>${x}</option>`).join("")}</select>
            </div>
            <div class="f-group"><label>P/E range</label>
              <div class="f-range"><input id="fPeMin" type="number" placeholder="min" value="${SC.peMin}"/><span>–</span><input id="fPeMax" type="number" placeholder="max" value="${SC.peMax}"/></div>
            </div>
            <div class="f-group"><label>Min dividend yield %</label><input id="fDiv" type="number" step="0.1" placeholder="e.g. 1" value="${SC.divMin}"/></div>
            <div class="f-group">
              <label class="chk-row" style="text-transform:none;letter-spacing:0"><input type="checkbox" id="fWL" ${SC.onlyWL ? "checked" : ""}/> Watchlist only</label>
            </div>
            <button class="btn btn-ghost btn-sm" id="fReset" style="width:100%">Reset filters</button>
          </div>
          <div>
            <div class="results-count" id="resCount"></div>
            <div class="stock-table-wrap" style="overflow-x:auto"><table class="stock-table" id="scTable"></table></div>
          </div>
        </div>
      </div>
    </section>`;

    const bind = (id, key) => $(id).addEventListener("input", e => { SC[key] = e.target.value; paint(); });
    bind("#fQ", "q"); bind("#fSector", "sector"); bind("#fPeMin", "peMin"); bind("#fPeMax", "peMax"); bind("#fDiv", "divMin");
    $("#fWL").addEventListener("change", e => { SC.onlyWL = e.target.checked; paint(); });
    $("#fReset").addEventListener("click", () => {
      Object.assign(SC, { q: "", sector: "", peMin: "", peMax: "", divMin: "", onlyWL: false, limit: 300 });
      renderScreener();
    });

    /* one delegated listener instead of one per row — matters with 2,500+ stocks */
    $("#scTable").addEventListener("click", e => {
      const tr = e.target.closest("tr[data-go]");
      if (!tr || e.target.closest("[data-star]")) return;
      location.hash = "#/stock/" + tr.dataset.go;
    });

    function resNote(total, shownCount) {
      let html = `<b>${total}</b> of ${D.STOCKS.length} stocks match`;
      if (total > shownCount) {
        html += ` · showing first ${shownCount} · <a href="#" id="scAll">show all</a>`;
      }
      $("#resCount").innerHTML = html;
      const all = $("#scAll");
      if (all) all.addEventListener("click", e => {
        e.preventDefault();
        SC.limit = Infinity;
        paint();
      });
    }

    function filtered() {
      let rows = D.STOCKS.filter(s => {
        if (SC.q && !(s.name.toLowerCase().includes(SC.q.toLowerCase()) || s.sym.toLowerCase().includes(SC.q.toLowerCase()))) return false;
        if (SC.sector && s.sector !== SC.sector) return false;
        if (SC.peMin !== "" && s.f.pe < +SC.peMin) return false;
        if (SC.peMax !== "" && s.f.pe > +SC.peMax) return false;
        if (SC.divMin !== "" && s.f.divYield < +SC.divMin) return false;
        if (SC.onlyWL && !inWL(s.sym)) return false;
        return true;
      });
      const key = SC.sort;
      rows.sort((a, b) => {
        let va, vb;
        if (key === "name") { va = a.name; vb = b.name; return va.localeCompare(vb) * -SC.dir; }
        if (key === "price") { va = a.stats.last; vb = b.stats.last; }
        else if (key === "chg") { va = a.stats.day.pct; vb = b.stats.day.pct; }
        else if (key === "pe") { va = a.f.pe; vb = b.f.pe; }
        else if (key === "div") { va = a.f.divYield; vb = b.f.divYield; }
        else if (key === "y1") { va = a.stats.y1; vb = b.stats.y1; }
        else { va = a.f.mcap; vb = b.f.mcap; }
        return (va - vb) * SC.dir;
      });
      return rows;
    }

    function paint() {
      const rows = filtered();
      const shown = rows.length > SC.limit ? rows.slice(0, SC.limit) : rows;
      resNote(rows.length, shown.length);
      const arrow = k => SC.sort === k ? `<span class="arr">${SC.dir === -1 ? "▼" : "▲"}</span>` : "";
      $("#scTable").innerHTML = `
        <thead><tr>
          <th>Stock</th>
          <th data-k="price">Price ${arrow("price")}</th>
          <th data-k="chg">Day ${arrow("chg")}</th>
          <th data-k="pe">P/E ${arrow("pe")}</th>
          <th data-k="mcap">M.Cap ${arrow("mcap")}</th>
          <th data-k="div">Div % ${arrow("div")}</th>
          <th data-k="y1">1Y ${arrow("y1")}</th>
          <th></th>
        </tr></thead>
        <tbody>
          ${shown.map(s => {
            const st = s.stats;
            return `<tr data-go="${s.sym}">
              <td><div class="st-cell">${logo(s.sym, s.color)}<div><div class="st-name">${s.name}</div><div class="st-sub">${s.sym} · ${s.sector}</div></div></div></td>
              <td class="num">${D.fmtPrice(st.last)}</td>
              <td class="num ${chgCls(st.day.pct)}">${D.fmtPct(st.day.pct, true)}</td>
              <td class="num">${s.f.pe}</td>
              <td class="num">${D.fmtCr(s.f.mcap)}</td>
              <td class="num">${s.f.divYield}%</td>
              <td class="num ${chgCls(st.y1)}">${D.fmtPct(st.y1, true)}</td>
              <td>${starBtn(s.sym)}</td>
            </tr>`;
          }).join("")}
        </tbody>`;
      bindStars($("#scTable"));
      $("#scTable").querySelectorAll("th[data-k]").forEach(th => {
        th.addEventListener("click", () => {
          const k = th.dataset.k;
          if (SC.sort === k) SC.dir *= -1; else { SC.sort = k; SC.dir = -1; }
          paint();
        });
      });
    }
    paint();
  }

  /* ================= VIEW: Compare ================= */
  const CMP_DEFAULT = ["RELIANCE", "TCS", "HDFCBANK"];

  function renderCompare(syms) {
    let list = (syms && syms.length ? syms : CMP_DEFAULT)
      .map(x => x.replace(/\+/g, " ").toUpperCase())
      .map(x => D.bySymbol(x) || D.indexBySymbol(x))
      .filter(Boolean)
      .slice(0, 5);
    if (!list.length) list = CMP_DEFAULT.map(x => D.bySymbol(x)).filter(Boolean);

    app.innerHTML = `
    <section class="section" style="padding-top:44px">
      <div class="container">
        <div class="section-head" style="margin-bottom:26px">
          <div class="kicker">Compare</div>
          <h2>Side by side.</h2>
          <p>Add up to five stocks or indices. The best value in each row is highlighted.</p>
        </div>
        <div class="compare-bar" id="cmpBar">
          ${list.map(x => `<span class="cmp-chip">${logo(x.sym, x.color)} ${x.name}<button class="cc-x" data-x="${x.sym}" title="Remove">✕</button></span>`).join("")}
          <div class="cmp-add">
            <input id="cmpInput" type="text" placeholder="Add stock…" autocomplete="off"/>
            <div class="cmp-sug" id="cmpSug"></div>
          </div>
        </div>
        <div class="cmp-table-wrap"><table class="cmp-table" id="cmpTable"></table></div>
        <div class="card cmp-chart-card">
          <h3>Normalized performance <span class="h-sub">% change over the selected period</span></h3>
          <div class="chart-toolbar">
            <div class="pills" id="cmpRange">
              ${["6M", "1Y", "3Y", "5Y"].map(r => `<button class="pill ${r === "1Y" ? "active" : ""}" data-r="${r}">${r}</button>`).join("")}
            </div>
          </div>
          <div class="chart-wrap">
            <canvas id="cmpChart"></canvas>
            <div class="chart-tip" id="cmpTip"></div>
          </div>
        </div>
      </div>
    </section>`;

    $("#cmpBar").querySelectorAll("[data-x]").forEach(b => b.addEventListener("click", () => {
      const rest = list.filter(x => x.sym !== b.dataset.x).map(x => x.sym.replace(" ", "+"));
      location.hash = "#/compare/" + (rest.join("/") || "RELIANCE");
    }));

    const input = $("#cmpInput"), sug = $("#cmpSug");
    input.addEventListener("input", () => {
      const res = D.searchAll(input.value).filter(r => !list.find(x => x.sym === r.item.sym));
      if (!input.value.trim() || !res.length) { sug.classList.remove("open"); return; }
      sug.innerHTML = res.map(r => `<div class="search-item" data-add="${r.item.sym}">
        ${logo(r.item.sym, r.item.color, "si-logo")}
        <div><div class="si-name">${r.item.name}</div><div class="si-sub">${r.type === "index" ? "Index" : r.item.sector}</div></div>
      </div>`).join("");
      sug.classList.add("open");
      sug.querySelectorAll("[data-add]").forEach(si => si.addEventListener("click", () => {
        const next = list.map(x => x.sym.replace(" ", "+")).concat(si.dataset.add.replace(" ", "+"));
        location.hash = "#/compare/" + next.join("/");
      }));
    });
    input.addEventListener("click", e => e.stopPropagation());

    /* metric table */
    function row(label, cells, dir) {
      let best = -1, bv = null;
      if (dir) {
        cells.forEach((c, i) => {
          if (c.v == null) return;
          if (bv == null || (dir > 0 ? c.v > bv : c.v < bv)) { bv = c.v; best = i; }
        });
      }
      return `<tr><td>${label}</td>${cells.map((c, i) => `<td class="${i === best ? "best" : ""}">${c.html}</td>`).join("")}</tr>`;
    }
    const cell = (v, html) => ({ v, html });
    const st = x => x.stats;
    const rowsHtml = [
      row("Price", list.map(x => cell(st(x).last, D.fmtPrice(st(x).last))), 0),
      row("Day change", list.map(x => cell(st(x).day.pct, `<span class="${chgCls(st(x).day.pct)}">${D.fmtPct(st(x).day.pct, true)}</span>`)), 1),
      row("1Y return", list.map(x => cell(st(x).y1, `<span class="${chgCls(st(x).y1)}">${D.fmtPct(st(x).y1, true)}</span>`)), 1),
      row("3Y return", list.map(x => cell(st(x).y3, `<span class="${chgCls(st(x).y3)}">${D.fmtPct(st(x).y3, true)}</span>`)), 1),
      row("5Y return", list.map(x => cell(st(x).y5, `<span class="${chgCls(st(x).y5)}">${D.fmtPct(st(x).y5, true)}</span>`)), 1),
      row("Market cap", list.map(x => x.f ? cell(x.f.mcap, D.fmtCr(x.f.mcap)) : cell(null, "—")), 1),
      row("P/E ratio", list.map(x => x.f ? cell(x.f.pe, String(x.f.pe)) : cell(null, "—")), -1),
      row("P/B ratio", list.map(x => x.f ? cell(x.f.pb, String(x.f.pb)) : cell(null, "—")), -1),
      row("Dividend yield", list.map(x => x.f ? cell(x.f.divYield, x.f.divYield + "%") : cell(null, "—")), 1),
      row("ROE", list.map(x => x.f ? cell(x.f.roe, x.f.roe + "%") : cell(null, "—")), 1),
      row("Debt / Equity", list.map(x => x.f ? cell(x.f.de, String(x.f.de)) : cell(null, "—")), -1),
      row("Promoter holding", list.map(x => x.f ? cell(x.f.promoter, x.f.promoter + "%") : cell(null, "—")), 1)
    ];
    $("#cmpTable").innerHTML = `
      <thead><tr><th></th>${list.map(x => `<th><div class="cmp-head-cell">${logo(x.sym, x.color)}<span class="ch-n">${x.name}</span><span class="ch-p">${x.f ? x.sector : "Index"}</span></div></th>`).join("")}</tr></thead>
      <tbody>${rowsHtml.join("")}</tbody>`;

    /* normalized chart */
    activeChart = C.priceChart($("#cmpChart"), $("#cmpTip"), {
      series: list[0].close, dates: D.DATES, color: list[0].color,
      range: "1Y", compare: list.slice(1), label: list[0].sym
    });
    $("#cmpRange").addEventListener("click", e => {
      const b = e.target.closest("[data-r]"); if (!b) return;
      $("#cmpRange").querySelectorAll(".pill").forEach(p => p.classList.remove("active"));
      b.classList.add("active");
      activeChart.setRange(b.dataset.r);
    });
  }

  /* ================= VIEW: Watchlist ================= */
  function renderWatchlist() {
    const items = watchlist.map(x => D.bySymbol(x)).filter(Boolean);
    if (!items.length) {
      app.innerHTML = `
      <div class="empty-state">
        <div class="es-ic">☆</div>
        <h2>Your watchlist is empty.</h2>
        <p>Tap the star on any stock to keep it here. Your list is saved on this device.</p>
        <a class="btn btn-primary" href="#/screener">Browse the Screener</a>
      </div>`;
      return;
    }
    app.innerHTML = `
    <section class="section" style="padding-top:44px">
      <div class="container">
        <div class="section-head" style="margin-bottom:30px">
          <div class="kicker">Watchlist</div>
          <h2>Your stars, tracked.</h2>
        </div>
        <div style="overflow-x:auto"><table class="stock-table" id="wlTable"></table></div>
      </div>
    </section>`;
    $("#wlTable").innerHTML = `
      <thead><tr><th>Stock</th><th>Price</th><th>Day</th><th>P/E</th><th>M.Cap</th><th>Div %</th><th>1Y</th><th></th></tr></thead>
      <tbody>
        ${items.map(s => {
          const st = s.stats;
          return `<tr data-go="${s.sym}">
            <td><div class="st-cell">${logo(s.sym, s.color)}<div><div class="st-name">${s.name}</div><div class="st-sub">${s.sym} · ${s.sector}</div></div></div></td>
            <td class="num">${D.fmtPrice(st.last)}</td>
            <td class="num ${chgCls(st.day.pct)}">${D.fmtPct(st.day.pct, true)}</td>
            <td class="num">${s.f.pe}</td>
            <td class="num">${D.fmtCr(s.f.mcap)}</td>
            <td class="num">${s.f.divYield}%</td>
            <td class="num ${chgCls(st.y1)}">${D.fmtPct(st.y1, true)}</td>
            <td>${starBtn(s.sym)}</td>
          </tr>`;
        }).join("")}
      </tbody>`;
    $("#wlTable").querySelectorAll("tr[data-go]").forEach(tr => {
      tr.addEventListener("click", e => {
        if (e.target.closest("[data-star]")) return;
        location.hash = "#/stock/" + tr.dataset.go;
      });
    });
    $("#wlTable").querySelectorAll("[data-star]").forEach(b => {
      b.addEventListener("click", () => { toggleWL(b.dataset.star); renderWatchlist(); });
    });
  }

  /* ================= boot ================= */
  buildTicker();
  initSearch();
  window.addEventListener("hashchange", route);
  route();
  // expose for js/live.js so live updates can re-render the current view
  window.DALAL_REROUTE = function () {
    try { route(); } catch (e) { /* ignore mid-navigation races */ }
  };
  let rsz = null;
  window.addEventListener("resize", () => {
    clearTimeout(rsz);
    rsz = setTimeout(() => { if (activeChart && activeChart.redraw) activeChart.redraw(); }, 160);
  });
})();
