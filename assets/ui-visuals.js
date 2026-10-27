/* ui-visuals: diamond, field bar, period pips. Uses the globals of home.js (DATA, games, gameFor, legStatsFor, betLive, ...) and registers via window.LiveUI. */
(function () {
  'use strict';
  function E(s) { try { return typeof esc === 'function' ? esc(s) : String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); } catch (e) { return ''; } }
  function num(v) { if (v == null || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }

  // ---- period timeline ----
  function periodSpec(path, g) {
    var p = String(path || ''), per = num(g.period) || 0, total, pre;
    if (/^baseball/.test(p)) { total = Math.max(9, per); pre = ''; }
    else if (/^hockey/.test(p)) { total = 3; pre = 'P'; }
    else if (/^football/.test(p)) { total = 4; pre = 'Q'; }
    else if (/^basketball/.test(p) && /college/.test(p)) { total = 2; pre = 'H'; }
    else if (/^basketball/.test(p)) { total = 4; pre = 'Q'; }
    else if (/^soccer/.test(p)) { total = 2; pre = 'H'; }
    else return null;
    if (!per) return null;
    var n = Math.max(total, per);
    return { total: n, base: total, per: per, lab: function (i) {
      if (/^baseball/.test(p)) return String(i);
      if (/^soccer/.test(p) && i <= total) return i + 'H';
      if (i <= total) return pre + i;
      return n - total > 1 ? 'OT' + (i - total) : 'OT';
    } };
  }
  function pipsHTML(m, g) {
    var s = periodSpec(m.path, g); if (!s) return '';
    var d = String(g.detail || '') + ' ' + String(g.longDetail || '');
    var brk = /half ?time|^end |end of|intermission/i.test(d) && !/^baseball/.test(m.path);
    var h = '<div class="pips" role="img" aria-label="' + E('Period ' + s.per + ' of ' + s.base) + '">';
    for (var i = 1; i <= s.total; i++) {
      var c = i < s.per ? 'done' : i === s.per ? (brk ? 'done' : 'now') : '';
      h += '<span class="pip ' + c + '"><i></i><em>' + E(s.lab(i)) + '</em></span>';
    }
    return h + '</div>';
  }

  // ---- baseball ----
  function dots(n, max, cls) {
    n = Math.max(0, Math.min(max, num(n) || 0));
    var h = '';
    for (var i = 0; i < max; i++) h += '<i class="' + (i < n ? 'on' : '') + '"></i>';
    return '<span class="dots ' + cls + '">' + h + '</span>';
  }
  function diamondSVG(si) {
    function base(k, x, y) { return '<rect class="base' + (si[k] ? ' on' : '') + '" x="' + (x - 7) + '" y="' + (y - 7) + '" width="14" height="14" rx="1.5" transform="rotate(45 ' + x + ' ' + y + ')"/>'; }
    return '<svg class="uiv-dia" viewBox="0 0 80 64" width="84" height="67" aria-hidden="true">' +
      '<path class="paths" d="M40 52 L66 34 L40 14 L14 34 Z"/>' + base('onSecond', 40, 14) + base('onThird', 14, 34) + base('onFirst', 66, 34) +
      '<path class="plate" d="M40 50 l6 5 v5 h-12 v-5 z"/></svg>';
  }
  function baseballHTML(g) {
    var si = g.sit;
    if (!si || (si.balls == null && si.outs == null && si.onFirst == null && si.onSecond == null && si.onThird == null)) return '';
    var o = si.outs != null ? si.outs : g.outs;
    var h = '<div class="uiv-bb">' + diamondSVG(si) + '<div class="bbc">' +
      '<div><b>B</b>' + dots(si.balls, 3, 'ball') + '</div><div><b>S</b>' + dots(si.strikes, 2, 'strike') + '</div><div><b>O</b>' + dots(o, 3, 'out') + '</div></div>';
    var bt = si.batter && si.batter.n, pt = si.pitcher && si.pitcher.n;
    if (bt || pt) h += '<div class="bbn">' + (bt ? '<span><small>AB</small> ' + E(bt) + '</span>' : '') + (pt ? '<span><small>P</small> ' + E(pt) + '</span>' : '') + '</div>';
    return h + '</div>';
  }

  // ---- football field ----
  function tcol(t) { return t && /^[0-9a-f]{6}$/i.test(t.color || '') ? '#' + t.color : null; }
  function fieldHTML(g) {
    var si = g.sit; if (!si || !(num(si.down) > 0)) return '';
    var T = g.teams || [], A = T.filter(function (t) { return !t.home; })[0], H = T.filter(function (t) { return t.home; })[0];
    if (!A || !H) return '';
    var x = null, txt = String(si.possessionText || '');
    var mt = /^\s*([A-Z]{2,4})\s+(\d{1,2})\s*$/.exec(txt) || /\bat\s+([A-Z]{2,4})\s+(\d{1,2})\s*$/.exec(String(si.downDistanceText || ''));
    if (mt) {
      var n = num(mt[2]);
      if (n != null && n >= 1 && n <= 50) { if (mt[1] === A.abbr) x = n; else if (mt[1] === H.abbr) x = 100 - n; }
    } else if (/\bat\s+(?:the\s+)?(?:50|midfield)\b/i.test(String(si.downDistanceText || ''))) x = 50;
    var poss = T.filter(function (t) { return String(t.id) === String(si.possession); })[0];
    var dd = String(si.downDistanceText || si.shortDownDistanceText || '');
    var dist = /goal/i.test(dd) ? 'goal' : num(si.distance);
    var dir = poss ? (poss === A ? 1 : -1) : 0;
    var pc = tcol(poss) || 'var(--accent)';
    var h = '<div class="uiv-field"><div class="ffield">';
    h += '<span class="ez l" style="background:' + (tcol(A) || 'var(--card2)') + '"><em>' + E(A.abbr) + '</em></span><div class="yd">';
    if (si.isRedZone && dir) h += '<span class="rzt ' + (dir > 0 ? 'r' : 'l') + '"></span>';
    for (var q = 10; q < 100; q += 10) h += '<span class="tk' + (q === 50 ? ' mid' : '') + '" style="left:' + q + '%"></span>';
    if (x != null) {
      h += '<span class="los" style="left:' + x + '%"></span>';
      if (dir && dist != null) {
        var fd = dist === 'goal' ? (dir > 0 ? 100 : 0) : Math.max(0, Math.min(100, x + dir * dist));
        h += '<span class="fdl" style="left:' + fd + '%"></span>';
      }
      h += '<span class="ball" style="left:' + x + '%;background:' + pc + '">' + (dir ? (dir > 0 ? '&#9654;' : '&#9664;') : '') + '</span>';
    }
    h += '</div><span class="ez r" style="background:' + (tcol(H) || 'var(--card2)') + '"><em>' + E(H.abbr) + '</em></span></div>';
    if (dd || poss) h += '<div class="fcap">' + (poss ? '<b style="background:' + pc + '">' + E(poss.abbr) + '</b>' : '') + '<span>' + E(dd) + '</span>' + (si.isRedZone ? '<span class="rz">RED ZONE</span>' : '') + '</div>';
    return h + '</div>';
  }

  // ---- soccer ----
  function soccerHTML(g) {
    var min = null, d = String(g.detail || '') + ' ' + String(g.longDetail || '');
    var mm = /(\d{1,3})(?:\s*\+\s*(\d{1,2}))?\s*['′]/.exec(d);
    if (mm) min = num(mm[1]) + (mm[2] ? num(mm[2]) : 0);
    else if (typeof g.clock === 'number' && g.clock > 0) min = Math.floor(g.clock / 60) + 1;
    var ht = /half ?time|\bHT\b/i.test(d);
    if (ht) min = 45;
    if (min == null) return '';
    var span = Math.max(90, min), pct = Math.min(100, min / span * 100), hp = 45 / span * 100;
    return '<div class="uiv-soc"><div class="sbar"><span class="sfill" style="width:' + pct.toFixed(1) + '%"></span><span class="snotch" style="left:' + hp.toFixed(1) + '%"></span></div>' +
      '<div class="slab"><small>0</small><b>' + (ht ? 'HT' : E(min) + "'") + '</b><small>' + span + "'</small></div></div>";
  }

  function build(m, g) {
    var p = String(m.path || ''), h = pipsHTML(m, g);
    if (p === 'baseball/mlb') h += baseballHTML(g);
    else if (/^football/.test(p)) h += fieldHTML(g);
    else if (/^soccer/.test(p)) h += soccerHTML(g);
    return h;
  }

  function decorate(ctx) {
    try {
      var D = (ctx && ctx.DATA) || window.DATA; if (!D || !D.open) return;
      document.querySelectorAll('.card[data-bi]').forEach(function (card) {
        try {
          var b = D.open[+card.dataset.bi], ldet = card.querySelector('.ldet'); if (!b || !ldet) return;
          var seen = {}, need = ldet.querySelector(':scope > .need'), ref = need ? need.nextSibling : ldet.firstChild;
          b.legs.forEach(function (L) {
            var m = matchOfLeg(b, L), g = m && gameFor(m);
            if (!m || !g || g.state !== 'in' || seen[g.id]) return;
            seen[g.id] = 1;
            var html = build(m, g), old = null;
            ldet.querySelectorAll(':scope > .uiv').forEach(function (n) { if (n.dataset.gid === String(g.id)) old = n; });
            if (!html) { if (old) old.remove(); return; }
            if (old) { if (old.dataset.sig !== html) { old.innerHTML = html; old.dataset.sig = html; } ref = old.nextSibling; return; }
            var w = document.createElement('div'); w.className = 'uiv'; w.dataset.gid = String(g.id); w.dataset.sig = html; w.innerHTML = html;
            ldet.insertBefore(w, ref); ref = w.nextSibling;
          });
        } catch (e) {}
      });
    } catch (e) {}
  }
  if (window.LiveUI && window.LiveUI.afterRender) window.LiveUI.afterRender.push(decorate);
  if (window.LiveUI) window.LiveUI.visual = build;   // reused by ui-arena
})();
