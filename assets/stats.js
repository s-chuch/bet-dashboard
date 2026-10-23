(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var $ = function (id) { return document.getElementById(id); };
  var state = { data: null, range: 'All', bank: 'Total', metric: 'pnl' };

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) { v = Number(v); return isFinite(v) ? v : 0; }
  function has(v) { return v !== null && v !== undefined && v !== '' && isFinite(Number(v)); }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  function money(v) {
    return (v < 0 ? '-' : '') + '$' + Math.abs(num(v)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function pnl(v) {
    v = num(v);
    var r = Math.round(Math.abs(v) * 100) / 100;
    return (v < 0 && r > 0 ? '-' : '+') + '$' + r.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function pct(v, signed) {
    v = num(v);
    return (signed && v > 0 ? '+' : '') + (Math.round(v * 10) / 10).toFixed(1) + '%';
  }
  function cls(v) { return num(v) > 0 ? 'pos' : num(v) < 0 ? 'neg' : ''; }
  function el(tag, props, kids) {
    var e = document.createElement(tag);
    for (var k in (props || {})) {
      if (k === 'class') e.className = props[k];
      else if (k === 'text') e.textContent = props[k];
      else e.setAttribute(k, props[k]);
    }
    arr(kids).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }
  function sv(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in (attrs || {})) {
      if (k === 'text') e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(e);
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function fmtDate(d, long) {
    var p = String(d || '').slice(0, 10).split('-');
    if (p.length !== 3) return String(d || '');
    var dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    if (isNaN(dt)) return String(d);
    return dt.toLocaleDateString('en-US', long ? { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  // Timestamps without an offset ("2026-10-18 08:34") are Eastern wall-clock; others are real instants. Always shown in Toronto time.
  var TZ = 'America/Toronto';
  function tsFmt(t, o) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(t || '').trim()), d, opts = { month: 'short', day: 'numeric' };
    for (var k in o) opts[k] = o[k];
    if (m) { d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))); opts.timeZone = 'UTC'; }
    else { d = new Date(t); opts.timeZone = TZ; }
    return isNaN(d) ? String(t || '') : d.toLocaleString('en-US', opts);
  }
  function fmtTs(t) { return tsFmt(t, {}); }
  function empty(node, msg) { clear(node); node.appendChild(el('div', { class: 'empty chart-empty', text: msg })); }
  function niceAxis(min, max, n) {
    if (min === max) { min -= 1; max += 1; }
    var span = max - min, step = Math.pow(10, Math.floor(Math.log10(span / n)));
    var err = span / n / step;
    step *= err >= 7 ? 10 : err >= 3 ? 5 : err >= 1.5 ? 2 : 1;
    var lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, t = [];
    for (var v = lo; v <= hi + step / 2; v += step) t.push(Math.round(v * 1e6) / 1e6);
    return { lo: lo, hi: hi, ticks: t };
  }
  function axisLabel(v) {
    var a = Math.abs(v), s = a >= 1000 ? (Math.round(a / 100) / 10) + 'k' : String(Math.round(a * 100) / 100);
    return (v < 0 ? '-$' : '$') + s;
  }

  // ---------- range ----------
  var RANGES = ['7d', '30d', 'All'];
  function filteredDaily() {
    var d = arr(obj(state.data).daily).filter(function (x) { return x && x.date; });
    if (state.range === 'All' || !d.length) return d;
    var n = state.range === '7d' ? 7 : 30;
    var last = new Date(String(d[d.length - 1].date).slice(0, 10) + 'T00:00:00Z');
    var cut = new Date(last.getTime() - (n - 1) * 86400000).toISOString().slice(0, 10);
    return d.filter(function (x) { return String(x.date).slice(0, 10) >= cut; });
  }

  function segment(container, items, current, onPick, labels) {
    clear(container);
    items.forEach(function (it) {
      var b = el('button', { type: 'button', role: 'tab', 'aria-selected': it === current ? 'true' : 'false', text: labels ? labels[it] : it });
      b.addEventListener('click', function () { onPick(it); });
      container.appendChild(b);
    });
  }

  // ---------- chart interaction ----------
  function attachHover(wrap, svg, n, xAt, show, hide) {
    var tip = el('div', { class: 'tip', role: 'status' });
    wrap.appendChild(tip);
    var cur = -1;
    function place(i) {
      if (i < 0 || i >= n) return;
      cur = i;
      var info = show(i);
      clear(tip);
      tip.appendChild(el('span', { text: info.title }));
      tip.appendChild(el('b', { text: info.value, class: info.cls || '' }));
      var rect = svg.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
      var x = xAt(i) * (rect.width / (svg.viewBox.baseVal.width || rect.width)) + (rect.left - wr.left);
      x = Math.max(50, Math.min(wr.width - 50, x));
      tip.style.left = x + 'px';
      tip.style.top = '-4px';
      tip.classList.add('on');
    }
    function idxFromEvent(e) {
      var r = svg.getBoundingClientRect();
      var vw = svg.viewBox.baseVal.width || r.width;
      var x = (e.clientX - r.left) * (vw / r.width), best = 0, bd = Infinity;
      for (var i = 0; i < n; i++) { var d = Math.abs(xAt(i) - x); if (d < bd) { bd = d; best = i; } }
      return best;
    }
    svg.addEventListener('pointermove', function (e) { place(idxFromEvent(e)); });
    svg.addEventListener('pointerdown', function (e) { place(idxFromEvent(e)); });
    svg.addEventListener('pointerleave', function () { tip.classList.remove('on'); hide(); });
    svg.addEventListener('blur', function () { tip.classList.remove('on'); hide(); });
    svg.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { place(Math.max(0, (cur < 0 ? n : cur) - 1)); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { place(Math.min(n - 1, cur + 1)); e.preventDefault(); }
      else if (e.key === 'Escape') { tip.classList.remove('on'); hide(); }
    });
  }

  var uid = 0;
  // Generic chart: kind 'line' or 'bars'. pts: [{label, y, title}]
  function drawChart(node, pts, o) {
    clear(node);
    if (!pts.length) { empty(node, o.emptyMsg || 'No data yet'); return; }
    var W = Math.max(240, node.clientWidth || 320), H = o.h || 210;
    var padL = 44, padR = 8, padT = 10, padB = 22;
    var ys = pts.map(function (p) { return p.y; });
    var mn = Math.min.apply(null, ys), mx = Math.max.apply(null, ys);
    if (o.zero) { mn = Math.min(mn, 0); mx = Math.max(mx, 0); }
    var ax = niceAxis(mn, mx, 4);
    var iw = W - padL - padR, ih = H - padT - padB, n = pts.length;
    var sx = function (i) { return o.kind === 'bars' ? padL + (i + .5) * iw / n : padL + (n === 1 ? iw / 2 : i * iw / (n - 1)); };
    var sy = function (v) { return padT + (ax.hi - v) / (ax.hi - ax.lo) * ih; };
    var svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', tabindex: '0', 'aria-label': o.aria + '. Use arrow keys to inspect values.' }, node);
    var id = 'g' + (++uid);
    var defs = sv('defs', {}, svg);
    function grad(gid, color, a0, a1) {
      var g = sv('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      sv('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': a0 }, g);
      sv('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': a1 }, g);
    }
    ax.ticks.forEach(function (t) {
      sv('line', { x1: padL, x2: W - padR, y1: sy(t), y2: sy(t), stroke: t === 0 ? '#4a5570' : '#252b3a', 'stroke-width': 1, 'stroke-dasharray': t === 0 ? '' : '3 4' }, svg);
      sv('text', { x: padL - 6, y: sy(t) + 3.5, 'text-anchor': 'end', text: axisLabel(t) }, svg);
    });
    // x labels
    var maxL = Math.max(2, Math.floor(iw / 62)), step = Math.max(1, Math.ceil(n / maxL));
    for (var i = 0; i < n; i += step) {
      sv('text', { x: sx(i), y: H - 5, 'text-anchor': i === 0 && n > 1 ? 'start' : sx(i) > W - padR - 24 ? 'end' : 'middle', text: pts[i].label }, svg);
    }
    var hl = sv('g', {}, svg), marker;
    if (o.kind === 'bars') {
      var bw = Math.max(1.5, Math.min(22, iw / n * .72));
      pts.forEach(function (p, i) {
        var y0 = sy(0), y1 = sy(p.y), h = Math.max(1.5, Math.abs(y1 - y0));
        sv('rect', { x: sx(i) - bw / 2, y: p.y >= 0 ? y0 - h : y0, width: bw, height: h, rx: Math.min(3, bw / 2), fill: p.y >= 0 ? '#34d399' : '#f87171', opacity: .92 }, svg);
      });
      marker = sv('rect', { y: padT, height: ih, width: iw / n, fill: '#fff', opacity: 0, 'pointer-events': 'none' }, hl);
    } else {
      var last = pts[n - 1].y, up = last >= 0, col = o.color || (up ? '#34d399' : '#f87171');
      if (o.zero) {
        // split coloring: green above zero line, red below
        var zy = sy(0) / H;
        var gl = sv('linearGradient', { id: id + 's', gradientUnits: 'userSpaceOnUse', x1: 0, x2: 0, y1: padT, y2: padT + ih }, defs);
        var zp = Math.max(0, Math.min(100, (sy(0) - padT) / ih * 100));
        sv('stop', { offset: '0%', 'stop-color': '#34d399' }, gl);
        sv('stop', { offset: zp + '%', 'stop-color': '#34d399' }, gl);
        sv('stop', { offset: zp + '%', 'stop-color': '#f87171' }, gl);
        sv('stop', { offset: '100%', 'stop-color': '#f87171' }, gl);
        grad(id + 'a', '#34d399', .32, 0); grad(id + 'b', '#f87171', 0, .3);
        var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + sx(i).toFixed(1) + ' ' + sy(p.y).toFixed(1); }).join('');
        var base = sy(0).toFixed(1);
        var area = d + 'L' + sx(n - 1).toFixed(1) + ' ' + base + 'L' + sx(0).toFixed(1) + ' ' + base + 'Z';
        var cA = sv('clipPath', { id: id + 'ca' }, defs); sv('rect', { x: 0, y: 0, width: W, height: sy(0) }, cA);
        var cB = sv('clipPath', { id: id + 'cb' }, defs); sv('rect', { x: 0, y: sy(0), width: W, height: H }, cB);
        sv('path', { d: area, fill: 'url(#' + id + 'a)', 'clip-path': 'url(#' + id + 'ca)' }, svg);
        sv('path', { d: area, fill: 'url(#' + id + 'b)', 'clip-path': 'url(#' + id + 'cb)' }, svg);
        sv('path', { d: d, fill: 'none', stroke: 'url(#' + id + 's)', 'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
      } else {
        col = col || '#818cf8';
        grad(id + 'a', col, .3, 0);
        var d2 = pts.map(function (p, i) { return (i ? 'L' : 'M') + sx(i).toFixed(1) + ' ' + sy(p.y).toFixed(1); }).join('');
        sv('path', { d: d2 + 'L' + sx(n - 1).toFixed(1) + ' ' + (padT + ih) + 'L' + sx(0).toFixed(1) + ' ' + (padT + ih) + 'Z', fill: 'url(#' + id + 'a)' }, svg);
        sv('path', { d: d2, fill: 'none', stroke: col, 'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
      }
      if (n === 1) sv('circle', { cx: sx(0), cy: sy(pts[0].y), r: 3.5, fill: col }, svg);
      marker = sv('g', { opacity: 0, 'pointer-events': 'none' }, hl);
      sv('line', { x1: 0, x2: 0, y1: padT, y2: padT + ih, stroke: '#8f97a8', 'stroke-width': 1, 'stroke-dasharray': '3 3' }, marker);
      sv('circle', { cx: 0, cy: 0, r: 4.5, fill: '#0b0d12', stroke: '#eef0f5', 'stroke-width': 2 }, marker);
    }
    attachHover(node, svg, n, sx, function (i) {
      if (o.kind === 'bars') { marker.setAttribute('x', sx(i) - iw / n / 2); marker.setAttribute('opacity', .08); }
      else {
        marker.setAttribute('opacity', 1);
        marker.firstChild.setAttribute('x1', sx(i)); marker.firstChild.setAttribute('x2', sx(i));
        marker.lastChild.setAttribute('cx', sx(i)); marker.lastChild.setAttribute('cy', sy(pts[i].y));
      }
      return { title: pts[i].title, value: o.fmt(pts[i].y), cls: o.signed ? cls(pts[i].y) : '' };
    }, function () { marker.setAttribute('opacity', 0); });
  }

  // ---------- sections ----------
  function renderHero(daily) {
    var t = obj(obj(state.data).totals), hero = $('hero');
    clear(hero);
    var ranged = state.range !== 'All';
    var P, ROI, WR, BETS, ST, label;
    if (ranged) {
      var w = 0, l = 0, s = 0, p = 0, b = 0;
      daily.forEach(function (d) { w += num(d.won); l += num(d.lost); s += num(d.staked); p += num(d.pnl); b += num(d.bets); });
      P = p; ST = s; ROI = s ? p / s * 100 : 0; WR = (w + l) ? w / (w + l) * 100 : 0; BETS = w + l; label = 'Last ' + state.range.replace('d', ' days');
    } else {
      P = num(t.pnl); ST = num(t.staked); ROI = has(t.roi) ? num(t.roi) : (ST ? P / ST * 100 : 0);
      WR = num(t.win_rate); BETS = has(t.won) || has(t.lost) ? num(t.won) + num(t.lost) : num(t.bets);
      label = t.first_date ? fmtDate(t.first_date, true) + ' – ' + fmtDate(t.last_date, true) : 'All time';
    }
    var left = el('div', {}, [
      el('div', { class: 'l', text: 'Total P&L' }),
      el('div', { class: 'big ' + cls(P), text: pnl(P), 'aria-label': 'Total profit and loss ' + pnl(P) }),
      el('div', { class: 'sub', text: label })
    ]);
    function g(l, v, c) { return el('div', {}, [el('div', { class: 'l', text: l }), el('div', { class: 'v ' + (c || ''), text: v })]); }
    var grid = el('div', { class: 'hero-grid' }, [
      g('ROI', pct(ROI, true), cls(ROI)), g('Win rate', pct(WR)), g('Settled', String(BETS))
    ]);
    hero.appendChild(left); hero.appendChild(grid);

    var k1 = $('kpis1'); clear(k1);
    function kpi(l, v, s, c, sm) {
      return el('div', { class: 'kpi' }, [el('div', { class: 'l', text: l }), el('div', { class: 'v ' + (c || '') + (sm ? ' sm' : ''), text: v }), s ? el('div', { class: 's', text: s }) : null]);
    }
    k1.appendChild(kpi('Staked', money(ST), ranged ? label : 'Avg ' + money(t.avg_stake) + ' / bet'));
    var wl = el('div', { class: 'kpi' }, [el('div', { class: 'l', text: 'Avg win / loss' }),
      el('div', { class: 'v sm' }, [el('span', { class: 'pos', text: pnl(t.avg_win) }), el('span', { class: 'dim', text: ' / ' }), el('span', { class: 'neg', text: pnl(-Math.abs(num(t.avg_loss))) })]),
      el('div', { class: 's', text: ranged ? 'per settled bet · all time' : 'per settled bet' })]);
    k1.appendChild(wl);
    var st = obj(state.data).streak ? obj(obj(state.data).streak) : {}, cu = st.current;
    var sTxt = cu && cu.n ? (cu.type === 'won' ? 'W' : 'L') + cu.n : '–';
    k1.appendChild(kpi('Current streak', sTxt, 'Best W' + num(st.best_win) + ' · Worst L' + num(st.worst_loss), cu && cu.n ? (cu.type === 'won' ? 'pos' : 'neg') : ''));
    k1.appendChild(kpi('Unsettled bets', String(num(t.open)), money(t.open_stake) + ' at risk · potential payout ' + money(t.open_payout) + (num(t.open_payout_tbc) > 0 ? ' + ' + num(t.open_payout_tbc) + ' TBC' : '')));

    var bw = $('bw'); clear(bw);
    [['best', 'Best bet', t.best], ['worst', 'Worst bet', t.worst]].forEach(function (x) {
      var b = x[2], c = el('div', { class: 'bet-card ' + x[0] });
      c.appendChild(el('div', { class: 'l', text: x[1] }));
      if (b && typeof b === 'object') {
        c.appendChild(el('div', { class: 'v ' + cls(b.pnl), text: pnl(b.pnl) }));
        c.appendChild(el('div', { class: 't', title: String(b.pick || ''), text: String(b.pick || '—') }));
        c.appendChild(el('div', { class: 's', text: [b.book, b.event, b.date ? fmtDate(b.date) : ''].filter(Boolean).join(' · ') }));
      } else c.appendChild(el('div', { class: 'muted', text: 'No data yet' }));
      bw.appendChild(c);
    });
  }

  function renderCharts(daily) {
    var cum = [], run = 0;
    daily.forEach(function (d) {
      // recompute for range so the line starts from zero for the window
      run += num(d.pnl);
      cum.push({ label: fmtDate(d.date), y: state.range === 'All' && has(d.cum_pnl) ? num(d.cum_pnl) : run, title: fmtDate(d.date, true) });
    });
    var rangeTotal = daily.reduce(function (a, d) { return a + num(d.pnl); }, 0);
    $('cum-sum').textContent = daily.length ? pnl(cum.length ? cum[cum.length - 1].y : 0) : '';
    $('cum-sum').className = 'small num ' + (cum.length ? cls(cum[cum.length - 1].y) : 'muted');
    drawChart($('c-cum'), cum, { kind: 'line', zero: true, signed: true, fmt: pnl, aria: 'Cumulative profit and loss over time, ending at ' + pnl(cum.length ? cum[cum.length - 1].y : 0), emptyMsg: 'No settled days in this range' });

    var bars = daily.map(function (d) { return { label: fmtDate(d.date), y: num(d.pnl), title: fmtDate(d.date, true) + ' · ' + num(d.bets) + ' bets' }; });
    var best = daily.filter(function (d) { return num(d.pnl) > 0; }).length;
    $('day-sum').textContent = daily.length ? best + ' green / ' + (daily.length - best) + ' other days' : '';
    drawChart($('c-day'), bars, { kind: 'bars', zero: true, signed: true, fmt: pnl, h: 180, aria: 'Daily profit and loss, ' + daily.length + ' days', emptyMsg: 'No settled days in this range' });

    // heat strip
    var heat = $('heat'); clear(heat);
    var recent = arr(obj(state.data).daily).slice(-30);
    if (!recent.length) heat.appendChild(el('div', { class: 'empty', text: 'No settled days yet' }));
    var mx = Math.max.apply(null, recent.map(function (d) { return Math.abs(num(d.pnl)); }).concat([1]));
    recent.forEach(function (d) {
      var p = num(d.pnl), k = p > 0 ? 'w' : p < 0 ? 'l' : 'z';
      var c = el('div', { class: 'cell ' + k, role: 'listitem', title: fmtDate(d.date, true) + ': ' + pnl(p), 'aria-label': fmtDate(d.date, true) + ', ' + (p > 0 ? 'profit ' : p < 0 ? 'loss ' : 'break-even ') + pnl(p), text: p > 0 ? 'W' : p < 0 ? 'L' : '–' });
      c.style.setProperty('--a', (0.2 + 0.6 * Math.abs(p) / mx).toFixed(2));
      c.setAttribute('tabindex', '0'); c.setAttribute('role', 'button');
      if (state.day === d.date) c.className += ' sel';
      c.addEventListener('click', function () { state.day = state.day === d.date ? null : d.date; renderCharts(daily); });
      c.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); c.click(); } });
      heat.appendChild(c);
    });
    renderDay(recent);
  }

  // ---------- day detail (tap a heat tile) ----------
  function renderDay(recent) {
    var box = $('heat-day'); if (!box) { box = el('div', { id: 'heat-day', class: 'dayd' }); $('heat').parentNode.appendChild(box); }
    clear(box);
    var d = recent.filter(function (x) { return x.date === state.day; })[0];
    if (!d) { state.day = null; box.hidden = true; return; }
    box.hidden = false;
    var st = num(d.staked), p = num(d.pnl), push = num(d.bets) - num(d.won) - num(d.lost);
    var close = el('button', { class: 'dayx', type: 'button', 'aria-label': 'Close day details', text: '×' });
    close.addEventListener('click', function () { state.day = null; var t = recent; renderDay(t); Array.prototype.forEach.call(document.querySelectorAll('#heat .cell.sel'), function (n) { n.classList.remove('sel'); }); });
    box.appendChild(el('div', { class: 'row sb' }, [el('strong', { text: fmtDate(d.date, true) }), close]));
    var kv = function (k, v, c) { return el('div', { class: 'daykv' }, [el('span', { class: 'muted small', text: k }), el('b', { class: 'num ' + (c || ''), text: v })]); };
    box.appendChild(el('div', { class: 'daystats' }, [
      kv('Net P/L', pnl(p), cls(p)), kv('Staked', money(st)), kv('ROI', st ? pct(p / st * 100, true) : '–', cls(p)),
      kv('W-L', num(d.won) + '-' + num(d.lost) + (push ? '-' + push : ''))]));
    var items = arr(d.items);
    if (!items.length) { box.appendChild(el('div', { class: 'muted small', text: num(d.bets) + ' bets (details appear after the next refresh)' })); return; }
    items.forEach(function (b) {
      var r = String(b.result || '').toLowerCase(), price = b.boosted_price ? b.price + ' → ' + b.boosted_price : b.price;
      box.appendChild(el('div', { class: 'dayb' }, [
        el('div', { class: 'row sb' }, [el('span', { class: 'dayp', text: b.pick || b.market }), el('b', { class: 'num ' + cls(b.pnl), text: pnl(b.pnl) })]),
        el('div', { class: 'muted small', text: [b.book, b.event].filter(Boolean).join(' · ') }),
        el('div', { class: 'small' }, [
          el('span', { class: 'num', text: (price || '') + ' · ' + (has(b.stake) ? money(b.stake) : (b.stake || '')) + ' · ' }),
          el('span', { class: r === 'won' ? 'pos' : r === 'lost' ? 'neg' : 'muted', text: (b.result || '').toUpperCase() }),
          el('span', { class: 'daytag', text: b.kind || '' })])]));
    });
  }

  function renderBank() {
    var bk = arr(obj(state.data).bankroll).filter(function (b) { return b && b.ts; });
    var names = [];
    bk.forEach(function (b) { Object.keys(obj(b.books)).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); }); });
    var opts = ['Total'].concat(names);
    if (opts.indexOf(state.bank) < 0) state.bank = 'Total';
    segment($('bank-seg'), opts, state.bank, function (v) { state.bank = v; renderBank(); });
    var pts = [];
    bk.forEach(function (b) {
      var v = state.bank === 'Total' ? b.total : obj(b.books)[state.bank];
      if (has(v)) pts.push({ label: fmtTs(b.ts), y: num(v), title: tsFmt(b.ts, { hour: 'numeric', minute: '2-digit' }) + ' ET' });
    });
    drawChart($('c-bank'), pts, { kind: 'line', zero: false, color: '#818cf8', fmt: money, aria: 'Bankroll over time for ' + state.bank, emptyMsg: 'No bankroll snapshots yet' });
  }

  function breakdown(title, rows, key, keepOrder) {
    var panel = el('section', { class: 'panel', 'aria-label': title });
    panel.appendChild(el('h3', { text: title }));
    rows = arr(rows).filter(function (r) { return r && r[key] != null; });
    if (!rows.length) { panel.appendChild(el('div', { class: 'empty', text: 'No data yet' })); return panel; }
    var m = state.metric;
    if (keepOrder) {
      var wo = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
      rows = rows.slice().sort(function (a, b) { return wo.indexOf(String(a[key]).slice(0, 3).toLowerCase()) - wo.indexOf(String(b[key]).slice(0, 3).toLowerCase()); });
    } else rows = rows.slice().sort(function (a, b) { return num(b[m]) - num(a[m]); });
    var vals = rows.map(function (r) { return num(r[m]); });
    var lo = Math.min.apply(null, vals.concat([0])), hi = Math.max.apply(null, vals.concat([0])), span = (hi - lo) || 1;
    var zp = -lo / span * 100;
    rows.forEach(function (r) {
      var v = num(r[m]), w = Math.abs(v) / span * 100;
      var track = el('div', { class: 'track', 'aria-hidden': 'true' });
      var bar = el('div', { class: 'bar ' + (v >= 0 ? 'p' : 'n') });
      bar.style.left = (v >= 0 ? zp : zp - w) + '%'; bar.style.width = w + '%';
      var z = el('div', { class: 'zero' }); z.style.left = zp + '%';
      track.appendChild(z); track.appendChild(bar);
      var name = String(r[key]);
      var rec = num(r.won) + '-' + num(r.lost) + ' · ' + (m === 'pnl' ? 'ROI ' + pct(r.roi, true) : pnl(r.pnl)) + ' · ' + num(r.bets) + ' bets';
      var valTxt = m === 'pnl' ? pnl(v) : pct(v, true);
      var row = el('div', { class: 'brow', role: 'group', 'aria-label': name + ': ' + valTxt + ', ' + rec }, [
        el('div', { class: 'nm', title: name }, [document.createTextNode(name), el('span', { class: 'rec', text: num(r.won) + '-' + num(r.lost) + ' · ' + pct(r.win_rate) + ' win' })]),
        track,
        el('div', { class: 'val ' + cls(v), text: valTxt })
      ]);
      panel.appendChild(row);
    });
    return panel;
  }

  function renderBreakdowns() {
    var d = obj(state.data), host = $('breakdowns'); clear(host);
    segment($('metric-seg'), ['pnl', 'roi'], state.metric, function (v) { state.metric = v; renderBreakdowns(); }, { pnl: 'P&L', roi: 'ROI' });
    host.appendChild(breakdown('By sportsbook', d.by_book, 'book'));
    host.appendChild(breakdown('By market', d.by_market, 'market'));
    host.appendChild(breakdown('By odds range', d.by_odds, 'bucket'));
    // weekday keeps calendar order
    var order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    var wk = arr(d.by_weekday);
    var wp = breakdown('By weekday', wk, 'day', true);
    host.appendChild(wp);
    var bo = obj(d.boosted), br = [];
    if (bo.boosted) br.push(Object.assign({ kind: 'Boosted' }, obj(bo.boosted)));
    if (bo.regular) br.push(Object.assign({ kind: 'Regular' }, obj(bo.regular)));
    host.appendChild(breakdown('Boosted vs regular', br, 'kind'));
  }

  function renderPicks() {
    var p = obj(obj(state.data).picks), node = $('picks'); clear(node);
    if (!num(p.total) && !num(p.graded)) { node.appendChild(el('div', { class: 'empty', text: 'No picks tracked yet' })); return; }
    var wrap = el('div', { class: 'ring-row' });
    var graded = num(p.graded), wr = graded ? (has(p.win_rate) ? num(p.win_rate) : num(p.won) / graded * 100) : 0;
    var S = 96, R = 40, C = 2 * Math.PI * R;
    var svg = sv('svg', { class: 'ring', width: S, height: S, viewBox: '0 0 96 96', role: 'img', 'aria-label': 'Pick accuracy ' + pct(wr) + ' over ' + graded + ' graded picks' });
    sv('circle', { cx: 48, cy: 48, r: R, fill: 'none', stroke: '#252b3a', 'stroke-width': 9 }, svg);
    var arc = sv('circle', { cx: 48, cy: 48, r: R, fill: 'none', stroke: graded && wr >= 50 ? '#34d399' : '#f87171', 'stroke-width': 9, 'stroke-linecap': 'round', 'stroke-dasharray': (C * Math.min(100, wr) / 100) + ' ' + C, transform: 'rotate(-90 48 48)' }, svg);
    if (!graded) arc.setAttribute('stroke-dasharray', '0 ' + C);
    sv('text', { x: 48, y: 54, 'text-anchor': 'middle', text: graded ? Math.round(wr) + '%' : '–' }, svg);
    wrap.appendChild(svg);
    var st = el('div', { class: 'pstats' });
    [['Total picks', p.total], ['Graded', p.graded], ['Won', p.won, 'pos'], ['Lost', p.lost, 'neg'], ['Placed as bets', p.placed], ['Accuracy', graded ? pct(wr) : '–']].forEach(function (x) {
      st.appendChild(el('div', {}, [el('div', { class: 'l', text: x[0] }), el('div', { class: 'v ' + (x[2] || ''), text: String(typeof x[1] === 'string' ? x[1] : num(x[1])) })]));
    });
    wrap.appendChild(st); node.appendChild(wrap);
  }


  // ---------- game plan (stats.json game_plan, recomputed every build) ----------
  var PLAN_TABS = [['by_type', 'Type'], ['by_book', 'Book'], ['by_band', 'Odds'], ['by_money', 'Cash/boost/bonus'], ['by_source', 'My picks vs own'], ['by_legs', 'Legs']];
  state.planTab = 'by_type';
  function renderPlan() {
    var g = obj(obj(state.data).game_plan), host = $('plan'); clear(host);
    if (!arr(g.rules).length) { host.appendChild(el('div', { class: 'empty', text: 'Game plan appears after the next update' })); return; }
    arr(g.rules).forEach(function (r) {
      host.appendChild(el('div', { class: 'prule ' + (r.ok ? 'ok' : 'warn') }, [
        el('span', { class: 'pn', text: (r.ok ? '\u2713 ' : '! ') + r.n }),
        el('div', {}, [el('div', { class: 'pr', text: r.rule }), el('div', { class: 'pt', text: r.track })])]));
    });
    var lbl = {}; PLAN_TABS.forEach(function (t) { lbl[t[0]] = t[1]; });
    segment($('plan-seg'), PLAN_TABS.map(function (t) { return t[0]; }), state.planTab, function (v) { state.planTab = v; renderPlan(); }, lbl);
    var rows = arr(g[state.planTab]), tab = $('plan-tab'); clear(tab);
    var t = el('table', { class: 'ptab' });
    var hd = el('tr', {}, ['', 'Bets', 'W-L', 'P/L', 'ROI'].map(function (h) { return el('th', { text: h }); }));
    t.appendChild(hd);
    rows.forEach(function (r) {
      t.appendChild(el('tr', { class: r.sub ? 'sub' + r.sub : '' }, [el('td', { text: (r.sub === 1 ? '\u21b3 ' : r.sub === 2 ? '\u00b7 ' : '') + r.key }), el('td', { text: String(r.bets) }), el('td', { text: r.won + '-' + r.lost }),
        el('td', { class: cls(r.pnl), text: pnl(r.pnl) }), el('td', { class: cls(r.roi), text: num(r.staked) ? pct(r.roi, true) : '\u2013' })]));
    });
    tab.appendChild(rows.length ? t : el('div', { class: 'empty', text: 'No settled bets yet' }));
    var b = obj(g.bonus);
    $('plan-note').textContent = (b.n ? 'Bonus bets: ' + money(b.returned) + ' back from ' + money(b.face) + ' face (' + (b.conv_pct == null ? '\u2013' : Math.round(b.conv_pct) + '%') + '; good is 60%+). ' : '') + 'ROI is on cash staked; bonus bets risk no cash. ' + (g.note || '');
    var c = obj(g.clv), ch = $('clv'); clear(ch);
    if (!num(c.n)) { ch.appendChild(el('div', { class: 'empty', text: 'No closing lines captured yet. Straight ML / spread / total bets get one in the hour before start (' + num(c.tracked) + ' bets have a logged time).' })); return; }
    ch.appendChild(el('div', { class: 'pt', text: c.n + ' bets graded \u00b7 average CLV ' + pct(c.avg, true) + ' \u00b7 beat the close ' + Math.round(num(c.beat_pct)) + '% (' + c.beat + '/' + c.n + ')' }));
    arr(c.recent).forEach(function (x) {
      ch.appendChild(el('div', { class: 'brow' }, [el('span', { class: 'nm', text: x.book + ' \u00b7 ' + x.pick }), el('span', { class: 'rec', text: x.price + ' vs close ' + x.close_price }), el('span', { class: 'val ' + cls(x.clv_pct), text: pct(x.clv_pct, true) })]));
    });
  }

  function renderAll() {
    if (!state.data) return;
    var daily = filteredDaily();
    renderHero(daily);
    renderCharts(daily);
    renderBank();
    renderBreakdowns();
    renderPicks();
    renderPlan();
    var g = obj(state.data).generated_at, d = g ? new Date(g) : null;
    $('updated').textContent = d && !isNaN(d) ? 'Updated ' + tsFmt(g, { hour: 'numeric', minute: '2-digit' }) + ' ET' : 'Updated recently';
  }

  function renderRange() {
    segment($('range'), RANGES, state.range, function (v) { state.range = v; renderRange(); renderAll(); });
  }

  // ---------- load ----------
  function load() {
    fetch('stats.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (t) {
        var j = JSON.parse(t);
        $('err').hidden = true;
        if (t === state.raw && state.data) return; // unchanged: keep focus, tooltips and scroll state
        state.raw = t; state.data = obj(j); renderAll();
      })
      .catch(function (e) {
        var er = $('err');
        if (state.data) { er.textContent = 'Could not refresh stats; showing last loaded data.'; er.hidden = false; }
        else {
          er.textContent = 'Stats are not available yet. They will appear after the next update.'; er.hidden = false;
          $('updated').textContent = 'No data';
          clear($('hero')); $('hero').appendChild(el('div', { class: 'empty', text: 'No stats yet' }));
        }
      });
  }
  var rt, lastW = window.innerWidth;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { if (window.innerWidth === lastW) return; lastW = window.innerWidth; if (state.data) { renderCharts(filteredDaily()); renderBank(); } }, 150); });
  renderRange();
  load();
  setInterval(function () { if (!document.hidden) load(); }, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
})();
