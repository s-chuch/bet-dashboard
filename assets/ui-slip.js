/* ui-slip: minimized bet slip (.crow) as a mini scoreboard. Registers window.LiveUI.crow(b, ctx) -> inner HTML of .crow (must keep [data-pill], [data-psub], .mini, .chev) and LiveUI.tick for per-second ring updates. */
(function () {
  'use strict';
  var LU = window.LiveUI = window.LiveUI || { scoreBox: null, crow: null, afterRender: [], tick: [] };
  LU.afterRender = LU.afterRender || [];
  LU.tick = LU.tick || [];

  var PCT = {};            // card key -> last win-chance percent seen (number) or null
  var MAXDOTS = 8;

  function E(s) { return esc(s); }

  function pctOf(txt) { var m = /(\d{1,3})\s*%/.exec(String(txt || '')); return m ? Math.min(100, +m[1]) : null; }
  function ringTarget(cls, txt) {
    if (cls === 'WON' || cls === 'LOST') return 100;
    var p = pctOf(txt);
    return p == null ? 0 : p;
  }

  // ---- start time ("7:00 PM", "Today") from the linked game or the logged start string ----
  function startParts(g, b) {
    try {
      if (g && g.date) {
        var d = new Date(g.date);
        if (!isNaN(d)) {
          var t = d.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
          var today = etDay(Date.now()) === etDay(g.date);
          return { t: t, d: today ? 'Today' : d.toLocaleString('en-US', { timeZone: TZ, weekday: 'short' }) };
        }
      }
      var m = String((b && b.start) || '').match(/^(\w{3}) (\w{3}) (\d{1,2}) 0?(\d{1,2}:\d{2}) ?([AP]M)/);
      if (m) {
        var now = new Date().toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
        var td = now.indexOf(m[1]) === 0 && now.indexOf(m[2] + ' ' + m[3]) >= 0;
        return { t: m[4] + ' ' + m[5], d: td ? 'Today' : m[1] };
      }
    } catch (e) {}
    return null;
  }

  // ---- condensed leg text ----
  var SUFFIX = /^(jr\.?|sr\.?|ii|iii|iv|v)$/i;
  function condLeg(L) {
    var t = String((L && (L.text || L.team)) || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    var ty = L && L.type;
    if (ty === 'total' && L.line != null) return (L.side === 'under' ? 'U' : 'O') + L.line;
    if (ty === 'ml' || ty === 'spread' || ty === 'draw') return t;
    if (ty === 'teamtotal') return t.replace(/\s*team pts?/i, ' TT');
    t = t.replace(/both teams to score/i, 'BTTS').replace(/^yes\s+BTTS/i, 'BTTS');
    var tk = t.split(' ');
    var idx = -1;
    for (var i = 0; i < tk.length; i++) {
      if (/^([OU]?\d)/.test(tk[i]) || (i > 0 && /^[A-Z]{2,5}$/.test(tk[i]))) { idx = i; break; }
    }
    if (idx === 0) return t;
    var name = idx < 0 ? tk : tk.slice(0, idx), rest = idx < 0 ? [] : tk.slice(idx);
    if (name.length < 2 || name.length > 3) return t;
    var last = name[name.length - 1];
    if (SUFFIX.test(last) && name.length > 1) last = name[name.length - 2] + ' ' + last;
    var r = rest.join(' ').replace(/\bpts\b/i, '').replace(/\s+/g, ' ').trim();
    return r ? last + ' ' + r : last;
  }

  function titleOf(b, g, firstG) {
    var legs = b.legs || [];
    if (b.multi && legs.length) {
      var c = legs.map(condLeg).filter(Boolean);
      if (!c.length) return shortLabel(b, g || firstG);
      var s = c.slice(0, 2).join(' · ');
      if (c.length > 2) s += ' · +' + (c.length - 2);
      if (s.length > 31 && c.length > 1) s = c[0] + ' · +' + (c.length - 1);   // 2 legs do not fit on a 360 px phone
      return s;
    }
    var L = legs[0];
    if (L && (L.type === 'ml' || L.type === 'spread' || L.type === 'total' || L.type === 'teamtotal'))
      return shortLabel(b, g || firstG);
    return b.pick || shortLabel(b, g || firstG);
  }

  // ---- scoreboard line ----
  function sortedTeams(g) {
    return g.teams.slice().sort(function (a, c) { return (a.home ? 1 : 0) - (c.home ? 1 : 0); });
  }
  function num(s) { var n = parseFloat(s); return isNaN(n) ? null : n; }
  function boardHTML(g, extraN, b) {
    var order = sortedTeams(g), badge = LU.badge || function () { return ''; };
    var pre = g.state === 'pre', live = g.state === 'in', post = !!g.completed || g.state === 'post';
    var sc = order.map(function (t) { return pre ? null : num(t.score); });
    var mx = Math.max.apply(null, sc.map(function (x) { return x == null ? -1 : x; }));
    var tie = sc.length > 1 && sc.every(function (x) { return x === sc[0]; });
    var cell = function (t, i) {
      var c = pre ? '' : tie ? ' tie' : (sc[i] === mx ? ' lead' : ' trail');
      return '<b class="bscore sls' + c + '" data-gid="' + E(g.id) + '" data-side="' + i + '">' + E(t.score == null ? '' : t.score) + '</b>';
    };
    var mid, chip;
    if (pre) {
      mid = badge(order[0]) + '<span class="slat">@</span>' + badge(order[1]);
      var sp = startParts(g, b);
      chip = '<span class="slc">' + (sp ? E(sp.t + (sp.d ? ' · ' + sp.d : '')) : 'Upcoming') + '</span>';
    } else {
      mid = badge(order[0]) + cell(order[0], 0) + '<span class="slat">–</span>' + cell(order[1], 1) + badge(order[1]);
      if (live) chip = '<span class="slc live"><i class="ldot"></i>' + (typeof stIcon === 'function' ? stIcon(g) : '') +
        '<span data-clk="' + E(g.id) + '" data-sep=" ">' + E(clockText(g, ' ')) + '</span></span>';
      else chip = '<span class="slc fin">' + E(post ? 'Final' : (g.detail || 'Final')) + '</span>';
    }
    return '<span class="slg">' + mid + '</span>' + chip +
      (extraN > 0 ? '<span class="slc more">+' + extraN + ' game' + (extraN > 1 ? 's' : '') + '</span>' : '');
  }
  function plainTop(b, legStats) {
    var sp = startParts(null, b), txt = String(b.event || '').trim() || String(b.market || '').replace(/\s*\(.*$/, '');
    var m = /^Futures/i.test(b.market || '') && txt && !/futures/i.test(txt) ? txt + ' · Futures' : txt;
    return '<span class="slt1">' + E(m) + '</span>' + (sp ? '<span class="slc">' + E(sp.t + ' · ' + sp.d) + '</span>' : '');
  }

  // ---- dots ----
  function dotKind(x) {
    var s = x.s;
    if (s === 'WON') return 'hit';
    if (s === 'LOST') return 'lost';
    if (s === 'PUSH') return 'push';
    if (s === 'NOT STARTED' || s === 'NO GAME' || s === '?' || !s) return 'wait';
    return 'live';
  }
  function dotsHTML(legStats) {
    var n = legStats.length, shown = legStats.slice(0, MAXDOTS), best = -1, bestRem = Infinity;
    shown.forEach(function (x, i) {
      if (dotKind(x) === 'live' && x.pt != null && x.pv != null) {
        var rem = x.pt - x.pv;
        if (rem < bestRem) { bestRem = rem; best = i; }
      }
    });
    var out = shown.map(function (x, i) {
      var k = dotKind(x), t = (x.L && (x.L.text || x.L.team)) || '';
      var lab = (i === best && n <= 4) ? '<em>' + E(x.pv + '/' + x.pt) + '</em>' : '';
      return '<span class="dw"><i class="d ' + k + '" title="' + E(t + (x.s ? ' · ' + x.s : '')) + '"></i>' + lab + '</span>';
    }).join('');
    if (n > MAXDOTS) out += '<em class="dmore">+' + (n - MAXDOTS) + '</em>';
    return '<span class="sld" aria-hidden="true">' + out + '</span>';
  }

  function tagsHTML(b) {
    var mk = String(b.market || ''), out = '', m = /(\d+)% [^)]*boost/i.exec(mk);
    if (m) out += '<span class="slt2 bo" title="' + E(m[1] + '% profit boost') + '"><i class="bw">BOOST </i><i class="bn2">+</i>' + E(m[1]) + '%</span>';
    else if (/boost/i.test(mk)) out += '<span class="slt2 bo" title="Profit boost">BOOST</span>';
    if (/bonus bet|free bet/i.test(mk)) out += '<span class="slt2 bn" title="Bonus bet">BONUS</span>';
    return out;
  }

  function build(b, ctx) {
    var q = pillState(b, ctx.status, ctx.legStats), cl = cls(q.cls);
    var legStats = ctx.legStats || [], g = ctx.g, firstG = ctx.firstG;

    // games involved
    var seen = {}, gs = [];
    if (g && g.id != null) { seen[g.id] = 1; gs.push(g); }
    legStats.forEach(function (x) { if (x.g && x.g.id != null && !seen[x.g.id]) { seen[x.g.id] = 1; gs.push(x.g); } });
    var prim = g || gs.filter(function (x) { return x.state === 'in'; })[0] ||
      gs.filter(function (x) { return x.state === 'pre'; }).sort(function (a, c) { return new Date(a.date) - new Date(c.date); })[0] || gs[0];
    var top = (prim && prim.teams && prim.teams.length >= 2) ? boardHTML(prim, gs.length - 1, b) : plainTop(b, legStats);

    // ring
    var target = ringTarget(cl, q.txt), p = pctOf(q.txt), k = ctx.k, prev = PCT[k], init = target, attrs = '';
    if (prev !== undefined && prev !== null && p != null && prev !== p) {
      init = prev;
      attrs = ' data-to="' + target + '"' + (Math.abs(p - prev) >= 3 ? ' data-pulse="1"' : '');
    }
    PCT[k] = p;
    var sp = startParts(prim, b), spt = sp ? sp.t.split(' ') : null;
    var upc = '<span class="slt"><b>' + (spt ? E(spt[0]) : 'UP') + '</b>' + (spt && spt[1] ? '<small>' + E(spt[1]) + '</small>' : '') + '</span>';
    var ring = '<span class="slr" style="--p:' + init + '"' + attrs + '><span class="pill ' + cl + '" data-pill>' + E(q.txt) + '</span>' + upc + '</span>';

    var pay = '<span class="slp"><b>' + money(b.stake) + '</b>' + (b.to_win != null ? ' → ' + money(b.to_win) : '') + '</span>';
    var row3 = dotsHTML(legStats) + pay + tagsHTML(b) + '<span class="slk">' + E(bookTag(b.book)) + '</span>';

    return '<div class="sl">' + ring +
      '<div class="slm"><div class="sl1">' + top + '</div><div class="sl2">' + E(titleOf(b, g, firstG)) + '</div><div class="sl3">' + row3 + '</div></div>' +
      '<small class="psub sr" data-psub>' + E(q.sub) + '</small></div>' +
      '<span class="chev">›</span>' + (ctx.mini || '');
  }

  LU.crow = function (b, ctx) {
    try { return build(b, ctx); } catch (e) { return null; }
  };

  // ---- ring animation helpers ----
  function pulse(r) {
    r.classList.remove('pulse');
    void r.offsetWidth;
    r.classList.add('pulse');
  }
  if (!window.__slipPulseBound) {
    window.__slipPulseBound = true;
    document.addEventListener('animationend', function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('slr')) e.target.classList.remove('pulse');
    });
  }

  LU.afterRender.push(function () {
    try {
      var rs = document.querySelectorAll('.slr[data-to]');
      for (var i = 0; i < rs.length; i++) {
        var r = rs[i], to = r.getAttribute('data-to'), pu = r.hasAttribute('data-pulse');
        void r.offsetWidth;
        r.style.setProperty('--p', to);
        r.removeAttribute('data-to');
        r.removeAttribute('data-pulse');
        if (pu) pulse(r);
      }
    } catch (e) {}
  });

  // keep ring fill (and pulse on a >=3 point move) in sync with the [data-pill] text that tick1s rewrites
  LU.tick.push(function () {
    var cards = document.querySelectorAll('.card[data-k]');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i], r = c.querySelector('.slr'), pe = c.querySelector('[data-pill]');
      if (!r || !pe) continue;
      var txt = pe.textContent, cl = (pe.className.split(/\s+/).filter(function (x) { return x !== 'pill'; })[0]) || '';
      var t = String(ringTarget(cl, txt));
      if (r.hasAttribute('data-to')) continue;           // render's own animation is pending
      if (r.style.getPropertyValue('--p') !== t) r.style.setProperty('--p', t);
      var p = pctOf(txt), k = c.dataset.k, prev = PCT[k];
      if (p != null && prev != null && Math.abs(p - prev) >= 3) pulse(r);
      if (prev === undefined || p !== prev) PCT[k] = p;
    }
  });
})();
