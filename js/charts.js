/* ============================================================
   Dalal — tiny canvas chart engine
   DPR-aware line/area charts with crosshair, volume bars,
   moving averages, normalized comparison, donuts & sparklines.
   ============================================================ */
(function () {
  "use strict";
  const D = window.DALAL;

  function prep(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(10, rect.width), h = Math.max(10, rect.height);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }
  function niceTicks(min, max, count) {
    const span = max - min || 1;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
    const start = Math.ceil(min / step) * step;
    const out = [];
    for (let v = start; v <= max + step * 0.001; v += step) out.push(v);
    return out;
  }
  function fmtAxisPrice(v) {
    if (v >= 100000) return (v / 100000).toFixed(2) + "L";
    if (v >= 1000) return v.toLocaleString("en-IN", { maximumFractionDigits: 0 });
    return v.toFixed(v < 100 ? 1 : 0);
  }

  /* ---------- sparkline (index cards) ---------- */
  function spark(canvas, series, color, up) {
    const { ctx, w, h } = prep(canvas);
    const min = Math.min(...series), max = Math.max(...series);
    const pad = 4;
    const X = i => (i / (series.length - 1)) * w;
    const Y = v => pad + (1 - (v - min) / (max - min || 1)) * (h - pad * 2);
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, up ? "rgba(0,168,82,.22)" : "rgba(227,0,0,.20)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.beginPath();
    series.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)));
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
  }

  /* ---------- main price chart ---------- */
  function priceChart(canvas, tipEl, opts) {
    const { series, dates, color, volume, sma50, sma200, compare } = opts;
    let range = opts.range || "1Y";
    let showVol = opts.showVol !== false;
    let showMA = opts.showMA !== false;
    let showCmp = !!compare;
    let raf = null, dead = false;

    const daysMap = { "1M": 21, "3M": 63, "6M": 126, "1Y": 251, "3Y": 756, "5Y": 99999 };
    const CMP_COLORS = ["#0071e3", "#ff9f0a", "#bf5af2", "#30d158", "#64d2ff", "#ff375f"];

    function slice() {
      const n = series.length;
      const back = Math.min(daysMap[range] || 251, n - 1);
      const start = n - 1 - back;
      return { start, end: n - 1 };
    }

    function draw(hoverIdx) {
      if (dead) return;
      const { ctx, w, h } = prep(canvas);
      const { start, end } = slice();
      const padL = 8, padR = 62, padT = 14, volH = showVol ? Math.round(h * 0.16) : 0, padB = 26;
      const plotW = w - padL - padR, plotH = h - padT - padB - volH;

      /* normalized compare mode */
      if (showCmp && compare && compare.length) {
        const sets = [{ data: series, color: color || "#0071e3", label: opts.label || "" }]
          .concat(compare.map((c, i) => ({ data: c.close, color: CMP_COLORS[(i + 1) % CMP_COLORS.length], label: c.sym })));
        let gmin = Infinity, gmax = -Infinity;
        const norm = sets.map(s => {
          const base = s.data[start];
          const arr = s.data.slice(start, end + 1).map(v => (v / base - 1) * 100);
          gmin = Math.min(gmin, ...arr); gmax = Math.max(gmax, ...arr);
          return arr;
        });
        const padV = (gmax - gmin) * 0.08 || 1;
        gmin -= padV; gmax += padV;
        const X = i => padL + ((i - start) / (end - start)) * plotW;
        const Y = v => padT + (1 - (v - gmin) / (gmax - gmin)) * plotH;

        ctx.strokeStyle = "rgba(0,0,0,.06)"; ctx.lineWidth = 1;
        niceTicks(gmin, gmax, 5).forEach(t => {
          const y = Y(t);
          ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
          ctx.fillStyle = "#86868b"; ctx.font = "11px -apple-system,Segoe UI,sans-serif";
          ctx.textAlign = "left"; ctx.fillText((t > 0 ? "+" : "") + t.toFixed(0) + "%", padL + plotW + 8, y + 4);
        });
        norm.forEach((arr, si) => {
          ctx.beginPath();
          arr.forEach((v, i) => i ? ctx.lineTo(X(start + i), Y(v)) : ctx.moveTo(X(start + i), Y(v)));
          ctx.strokeStyle = sets[si].color; ctx.lineWidth = si === 0 ? 2.4 : 1.8; ctx.lineJoin = "round"; ctx.stroke();
        });
        axisDates(ctx, dates, start, end, padL, plotW, h - 8);
        if (hoverIdx != null) crosshair(ctx, X, null, hoverIdx, padT, plotH + padT);
        return;
      }

      /* normal mode */
      const seg = series.slice(start, end + 1);
      let min = Math.min(...seg), max = Math.max(...seg);
      if (showMA && sma50) for (let i = start; i <= end; i++) { const v = sma50[i]; if (v != null) { min = Math.min(min, v); max = Math.max(max, v); } }
      if (showMA && sma200) for (let i = start; i <= end; i++) { const v = sma200[i]; if (v != null) { min = Math.min(min, v); max = Math.max(max, v); } }
      const padV = (max - min) * 0.07 || 1;
      min -= padV; max += padV;
      const X = i => padL + ((i - start) / (end - start)) * plotW;
      const Y = v => padT + (1 - (v - min) / (max - min)) * plotH;

      /* gridlines + y labels */
      ctx.font = "11px -apple-system,Segoe UI,sans-serif";
      niceTicks(min, max, 5).forEach(t => {
        const y = Y(t);
        ctx.strokeStyle = "rgba(0,0,0,.06)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
        ctx.fillStyle = "#86868b"; ctx.textAlign = "left";
        ctx.fillText(fmtAxisPrice(t), padL + plotW + 8, y + 4);
      });

      /* area fill */
      const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      grad.addColorStop(0, hexA(color, 0.20));
      grad.addColorStop(1, hexA(color, 0.01));
      ctx.beginPath();
      seg.forEach((v, i) => i ? ctx.lineTo(X(start + i), Y(v)) : ctx.moveTo(X(start + i), Y(v)));
      ctx.strokeStyle = color; ctx.lineWidth = 2.2; ctx.lineJoin = "round"; ctx.stroke();
      ctx.lineTo(X(end), padT + plotH); ctx.lineTo(X(start), padT + plotH); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();

      /* moving averages */
      if (showMA && sma50) line(ctx, sma50, start, end, X, Y, "#ff9f0a", 1.4);
      if (showMA && sma200) line(ctx, sma200, start, end, X, Y, "#bf5af2", 1.4);

      /* volume */
      if (showVol && volume) {
        const vseg = volume.slice(start, end + 1);
        const vmax = Math.max(...vseg);
        const vTop = padT + plotH + 10;
        vseg.forEach((v, i) => {
          const bh = (v / vmax) * (volH - 6);
          const up = i === 0 || series[start + i] >= series[start + i - 1];
          ctx.fillStyle = up ? "rgba(0,168,82,.35)" : "rgba(227,0,0,.30)";
          const bw = Math.max(1, plotW / (end - start) - 1);
          ctx.fillRect(X(start + i) - bw / 2, vTop + (volH - 6 - bh), bw, bh);
        });
      }

      axisDates(ctx, dates, start, end, padL, plotW, h - 8);

      /* last price marker */
      const lastY = Y(series[end]);
      ctx.setLineDash([3, 3]); ctx.strokeStyle = hexA(color, .5);
      ctx.beginPath(); ctx.moveTo(padL, lastY); ctx.lineTo(padL + plotW, lastY); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(X(end), lastY, 3.5, 0, 7); ctx.fill();
      const lp = series[end].toFixed(2);
      ctx.fillStyle = color;
      roundRect(ctx, padL + plotW + 4, lastY - 10, 54, 20, 6); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.textAlign = "left"; ctx.font = "600 11px -apple-system,Segoe UI,sans-serif";
      ctx.fillText(lp, padL + plotW + 10, lastY + 4);

      if (hoverIdx != null) crosshair(ctx, X, Y, hoverIdx, padT, plotH + padT);
    }

    function line(ctx, arr, start, end, X, Y, col, lw) {
      ctx.beginPath();
      let started = false;
      for (let i = start; i <= end; i++) {
        const v = arr[i]; if (v == null) continue;
        if (!started) { ctx.moveTo(X(i), Y(v)); started = true; } else ctx.lineTo(X(i), Y(v));
      }
      ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke();
    }
    function axisDates(ctx, dates, start, end, padL, plotW, y) {
      ctx.fillStyle = "#86868b"; ctx.font = "11px -apple-system,Segoe UI,sans-serif"; ctx.textAlign = "center";
      const ticks = 5;
      for (let k = 0; k <= ticks; k++) {
        const i = Math.round(start + (end - start) * k / ticks);
        const d = new Date(dates[i] + "T00:00:00Z");
        const lbl = d.toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" });
        ctx.fillText(lbl, Math.min(Math.max(padL + (i - start) / (end - start) * plotW, 24), padL + plotW - 6), y);
      }
    }
    function crosshair(ctx, X, Y, idx, top, bottom) {
      const x = X(idx);
      ctx.strokeStyle = "rgba(0,0,0,.25)"; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.setLineDash([]);
    }
    function hexA(hex, a) {
      const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${a})`;
    }
    function roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }

    /* interactions */
    function onMove(ev) {
      const rect = canvas.getBoundingClientRect();
      const cx = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
      const { start, end } = slice();
      const padL = 8, padR = 62;
      const plotW = rect.width - padL - padR;
      let idx = Math.round(start + (cx - padL) / plotW * (end - start));
      idx = Math.max(start, Math.min(end, idx));
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        draw(idx);
        if (tipEl) {
          const d = dates[idx];
          const rows = [];
          if (showCmp && compare && compare.length) {
            const base0 = series[start], base1 = series[idx];
            rows.push(["Stock", ((base1 / base0 - 1) * 100).toFixed(1) + "%"]);
            compare.forEach((c, ci) => {
              rows.push([c.sym, ((c.close[idx] / c.close[start] - 1) * 100).toFixed(1) + "%"]);
            });
          } else {
            rows.push(["Close", D.fmtPrice(series[idx])]);
            if (showMA && sma50 && sma50[idx] != null) rows.push(["50 DMA", D.fmtPrice(sma50[idx])]);
            if (showMA && sma200 && sma200[idx] != null) rows.push(["200 DMA", D.fmtPrice(sma200[idx])]);
            if (showVol && volume) rows.push(["Volume", D.fmtVol(volume[idx])]);
          }
          tipEl.innerHTML = `<div class="tt-d">${D.fmtDate(d)}</div>` +
            rows.map(r => `<div class="tt-row"><span>${r[0]}</span><b>${r[1]}</b></div>`).join("");
          tipEl.style.display = "block";
          const tw = tipEl.offsetWidth;
          const px = Math.min(Math.max(idx === null ? 0 : (idx - start) / (end - start) * rect.width - tw / 2, 4), rect.width - tw - 4);
          tipEl.style.left = px + "px";
        }
      });
    }
    function onLeave() {
      if (raf) cancelAnimationFrame(raf);
      draw(null);
      if (tipEl) tipEl.style.display = "none";
    }
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("touchmove", onMove, { passive: true });
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("touchend", onLeave);

    draw(null);

    return {
      setRange(r) { range = r; draw(null); },
      toggleVol() { showVol = !showVol; draw(null); },
      toggleMA() { showMA = !showMA; draw(null); },
      toggleCmp() { showCmp = !showCmp; draw(null); },
      redraw: () => draw(null),
      destroy() { dead = true; }
    };
  }

  /* ---------- donut (shareholding) ---------- */
  function donut(canvas, segments, centerTop, centerBottom) {
    const { ctx, w, h } = prep(canvas);
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 6, ir = r * 0.62;
    const total = segments.reduce((s, x) => s + x.value, 0);
    let a0 = -Math.PI / 2;
    segments.forEach(s => {
      const a1 = a0 + (s.value / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, a0, a1); ctx.arc(cx, cy, ir, a1, a0, true); ctx.closePath();
      ctx.fillStyle = s.color; ctx.fill();
      a0 = a1;
    });
    if (centerTop) {
      ctx.fillStyle = "#1d1d1f"; ctx.textAlign = "center";
      ctx.font = "700 15px -apple-system,Segoe UI,sans-serif";
      ctx.fillText(centerTop, cx, cy + 1);
      ctx.fillStyle = "#86868b"; ctx.font = "10.5px -apple-system,Segoe UI,sans-serif";
      ctx.fillText(centerBottom || "", cx, cy + 16);
    }
  }

  /* ---------- grouped bars (financials) ---------- */
  function bars(canvas, labels, values, color, fmt) {
    const { ctx, w, h } = prep(canvas);
    const padB = 24, padT = 12, padR = 8;
    const max = Math.max(...values.map(Math.abs)) || 1;
    const min = Math.min(0, ...values);
    const plotH = h - padB - padT;
    const Y = v => padT + (1 - (v - min) / (max - min)) * plotH;
    const bw = Math.min(46, (w - 20) / values.length * 0.55);
    const step = (w - 16) / values.length;
    /* zero line */
    if (min < 0) {
      ctx.strokeStyle = "rgba(0,0,0,.15)";
      ctx.beginPath(); ctx.moveTo(8, Y(0)); ctx.lineTo(w - 8, Y(0)); ctx.stroke();
    }
    values.forEach((v, i) => {
      const x = 8 + step * i + (step - bw) / 2;
      const y0 = Y(0), y1 = Y(v);
      const grad = ctx.createLinearGradient(0, Math.min(y0, y1), 0, Math.max(y0, y1));
      grad.addColorStop(0, color); grad.addColorStop(1, color + "99");
      ctx.fillStyle = v >= 0 ? grad : "#e30000";
      const r = Math.min(6, bw / 2);
      const top = Math.min(y0, y1), bh = Math.abs(y0 - y1);
      ctx.beginPath();
      ctx.moveTo(x, top + bh); ctx.lineTo(x, top + r); ctx.arcTo(x, top, x + r, top, r);
      ctx.lineTo(x + bw - r, top); ctx.arcTo(x + bw, top, x + bw, top + r, r);
      ctx.lineTo(x + bw, top + bh); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#86868b"; ctx.font = "10.5px -apple-system,Segoe UI,sans-serif"; ctx.textAlign = "center";
      ctx.fillText(labels[i], x + bw / 2, h - 8);
      ctx.fillStyle = "#1d1d1f"; ctx.font = "600 11px -apple-system,Segoe UI,sans-serif";
      ctx.fillText(fmt(v), x + bw / 2, top - 5);
    });
  }

  window.Charts = { spark, priceChart, donut, bars };
})();