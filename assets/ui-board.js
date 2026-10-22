/* ui-board: scoreboard badges, LIVE pulse, score/play flash. Uses the globals of home.js (DATA, games, gameFor, legStatsFor, betLive, ...) and registers via window.LiveUI. */
(function () {
  'use strict';
  var LASTSEEN = {}, PLAYSEEN = {}, seeded = false;

  function hex(c) { c = String(c || '').replace('#', ''); return /^[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : ''; }
  function lum(h) {
    var v = [0, 2, 4].map(function (i) { var x = parseInt(h.substr(i, 2), 16) / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  }
  function e(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function badge(t) {
    t = t || {};
    var bg = hex(t.color), alt = hex(t.alt), ring = '';
    if (bg && lum(bg) < 0.03) {
      if (alt && lum(alt) >= 0.03 && alt !== bg) { ring = 'border-color:#' + alt + ';'; }
      else { ring = 'border-color:rgba(255,255,255,.45);'; }
    } else if (bg && lum(bg) < 0.06) { ring = 'border-color:rgba(255,255,255,.3);'; }
    var fg = bg ? (lum(bg) > 0.4 ? '#000' : '#fff') : 'var(--txt)';
    var style = 'background:' + (bg ? '#' + bg : 'var(--card2)') + ';color:' + fg + ';' + ring;
    var ab = String(t.abbr || t.short || t.name || '?').slice(0, 4);
    return '<span class="tbadge' + (ab.length > 3 ? ' sm' : '') + '" style="' + e(style) + '" aria-hidden="true">' + e(ab) + '</span>';
  }

  function num(s) { var n = parseFloat(s); return isNaN(n) ? null : n; }

  window.LiveUI = window.LiveUI || { scoreBox: null, afterRender: [] };
  window.LiveUI.badge = badge;
  window.LiveUI.scoreBox = function (g) {
    if (!g || !g.teams || !g.teams.length) return '';
    var live = g.state === 'in', pre = g.state === 'pre', post = !!g.completed || g.state === 'post';
    var order = g.teams.slice().sort(function (a, b) { return (a.home ? 1 : 0) - (b.home ? 1 : 0); });
    var sc = order.map(function (t) { return pre ? null : num(t.score); });
    var mx = Math.max.apply(null, sc.map(function (x) { return x == null ? -1 : x; }));
    var tie = sc.length > 1 && sc.every(function (x) { return x === sc[0]; });
    var rows = order.map(function (t, i) {
      var c = pre ? '' : tie ? ' tie' : (sc[i] === mx ? ' lead' : ' trail');
      return '<div class="row brow' + c + '">' + badge(t) + '<span class="bname">' + e(t.name || t.abbr) + '</span>' +
        '<b class="bscore" data-gid="' + e(g.id) + '" data-side="' + i + '">' + (pre ? '' : e(t.score == null ? '' : t.score)) + '</b></div>';
    }).join('');
    var det;
    if (live) {
      det = '<span class="livepill"><i class="ldot"></i>LIVE</span><span class="pchip"><span data-clk="' + e(g.id) + '" data-sep=" - ">' +
        e(typeof clockText === 'function' ? clockText(g, ' - ') : g.detail) + '</span></span>';
    } else if (pre) {
      det = '<span class="pchip pre">' + e(typeof fmtStart === 'function' ? fmtStart(g, g.detail) : g.detail) + '</span>';
    } else {
      det = '<span class="pchip fin">' + e(g.detail || 'Final') + '</span>';
    }
    return '<div class="score board' + (live ? ' islive' : '') + '">' + rows + '<div class="det bdet">' + det + '</div>' +
      (post ? '' : (typeof stBadge === 'function' ? stBadge(g) : '')) + '</div>';
  };

  function gidsOfCard(c) {
    var out = [];
    try {
      var b = DATA.open[+c.dataset.bi], seen = {};
      if (!b) return out;
      (b.legs || []).forEach(function (L) {
        var m = b.match || L.match, g = m && gameFor(m);
        if (g && g.state === 'in' && !seen[g.id]) { seen[g.id] = 1; out.push(g.id); }
      });
    } catch (x) {}
    return out;
  }

  function flash(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  window.LiveUI.afterRender.push(function () {
    try {
      var first = !seeded; seeded = true;
      var G = (typeof games !== 'undefined' && games) || {};
      var changed = {};
      Object.keys(G).forEach(function (id) {
        var g = G[id]; if (!g || !g.teams) return;
        var order = g.teams.slice().sort(function (a, b) { return (a.home ? 1 : 0) - (b.home ? 1 : 0); });
        var arr = order.map(function (t) { return String(t.score == null ? '' : t.score); });
        var prev = LASTSEEN[id];
        if (prev && !first) {
          var ch = [];
          arr.forEach(function (s, i) { if (prev.arr[i] !== s && s !== '' && g.state !== 'pre') ch.push(i); });
          if (ch.length) changed[id] = ch;
        }
        LASTSEEN[id] = { scores: arr.join('-'), arr: arr };
      });
      document.querySelectorAll('.bscore[data-gid]').forEach(function (el) {
        var ch = changed[el.dataset.gid];
        if (ch && ch.indexOf(+el.dataset.side) >= 0) flash(el, 'flash');
      });
      var updates = {};
      document.querySelectorAll('.card[data-bi]').forEach(function (c) {
        var ul = c.querySelector('.tick ul'); if (!ul) return;
        var gids = gidsOfCard(c), gi = -1, firstLi = true, kids = ul.children;
        for (var i = 0; i < kids.length; i++) {
          var k = kids[i];
          if (k.classList.contains('tg')) { gi++; firstLi = true; continue; }
          if (k.tagName !== 'LI') continue;
          if (gi < 0) gi = 0;
          if (!firstLi) continue;
          firstLi = false;
          var gid = gids[gi] || (c.dataset.bi + ':' + gi);
          var key = k.textContent;
          var prev = PLAYSEEN[gid];
          if (prev !== undefined && prev !== key && !first) k.classList.add('newplay');
          updates[gid] = key;
        }
      });
      Object.keys(updates).forEach(function (g) { PLAYSEEN[g] = updates[g]; });
    } catch (x) {}
  });
})();
