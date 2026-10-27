/* ui-arena: Cards | Arena | Grid switch for the Live section. Arena = one tile per live game (sport visual, win chance, your bet slips),
   Grid = every live game as a small tile. Uses the globals of home.js (DATA, games, probs, summaries, gameFor, legStatsFor, betLive, legP, ...)
   and registers via window.LiveUI. Cards stays the default; any failure here leaves the Cards view untouched. */
(function () {
  'use strict';
  var KEY = 'bt.livemode', MODES = ['cards', 'arena', 'grid'];
  var mode = 'cards', model = null, lastHTML = '', seeded = false;
  var LASTSCORE = {}, LASTPLAY = {}, hostSec = null, view = null, seg = null, DATA_REF = null;
  try { var sv = localStorage.getItem(KEY); if (MODES.indexOf(sv) >= 0) mode = sv; } catch (e) {}

  function E(s) { return esc(s); }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }
  function pct(p) { return p == null ? '–' : Math.round(p * 100) + '%'; }
  function tc(t, d) { return t && /^[0-9a-f]{6}$/i.test(t.color || '') ? '#' + t.color : (d || 'var(--accent)'); }
  function sides(g) {
    var T = g.teams || [], A = T.filter(function (t) { return !t.home; })[0] || T[0], H = T.filter(function (t) { return t.home; })[0] || T[1];
    return A && H ? [A, H] : null;
  }
  var LEAGUE = { 'baseball/mlb': 'MLB', 'football/nfl': 'NFL', 'football/college-football': 'NCAAF', 'basketball/nba': 'NBA', 'basketball/wnba': 'WNBA',
    'basketball/mens-college-basketball': 'NCAAB', 'hockey/nhl': 'NHL' };
  function league(m) { var p = String(m.path || ''); return LEAGUE[p] || (/^soccer/.test(p) ? 'Soccer' : (p.split('/')[1] || p).toUpperCase()); }

  // ---------- model: live games, with the bets that touch them ----------
  function buildModel() {
    var D = DATA_REF; if (!D || !D.open) return null;
    var byGame = {}, order = [], bets = [];
    D.open.forEach(function (b, bi) {
      var ls = legStatsFor(b), status = b.multi ? combine(ls.map(function (x) { return x.s; })) : (ls[0] ? ls[0].s : '?');
      var gs = (b.match ? [gameFor(b.match)] : b.legs.map(function (L) { return gameFor(L.match); })).filter(Boolean);
      if (status === 'LOST' || !gs.some(gLive)) return;
      var v = betLive(b, status, ls), p = status === 'WON' ? 1 : (v && v.p != null ? v.p : null);
      var legs = ls.map(function (x) {
        var lp = legP(b, x.L, x.s, x);
        return { x: x, p: x.s === 'WON' ? 1 : x.s === 'LOST' ? 0 : lp, st: x.s };
      });
      var bet = { b: b, bi: bi, status: status, ls: ls, p: p, legs: legs };
      bets.push(bet);
      var seen = {};
      b.legs.forEach(function (L) {
        var m = matchOfLeg(b, L), g = m && gameFor(m);
        if (!m || !g || !gLive(g) || seen[m.id]) return;
        seen[m.id] = 1;
        var e = byGame[m.id];
        if (!e) { e = byGame[m.id] = { id: String(m.id), m: m, g: g, bets: [] }; order.push(e); }
        e.bets.push(bet);
      });
    });
    order.sort(function (a, b) {
      return (b.g.state === 'in') - (a.g.state === 'in') || b.bets.length - a.bets.length || String(a.g.date).localeCompare(String(b.g.date));
    });
    return { games: order, bets: bets };
  }

  // ---------- pieces ----------
  function hasP(g) { var q = probs[g.id]; return q && g.state === 'in' && q.home != null; }
  function tug(g) {
    var S = sides(g); if (!S || !hasP(g)) return '';
    var q = probs[g.id], h = q.home, a = q.away != null ? q.away : 1 - h, d = q.tie != null ? q.tie : 0;
    var A = S[0], H = S[1], pa = Math.round(a * 100), ph = Math.round(h * 100), pd = Math.round(d * 100);
    return '<div class="ar-tug"><div class="ar-lab"><span>' + E(A.abbr) + ' <em>' + pa + '%</em></span>' + (pd ? '<span>Draw <em>' + pd + '%</em></span>' : '') +
      '<span>' + E(H.abbr) + ' <em>' + ph + '%</em></span></div><div class="ar-bar"><span style="width:' + pa + '%;background:' + tc(A) + '"></span>' +
      (pd ? '<span style="width:' + pd + '%;background:var(--dim)"></span>' : '') + '<span style="width:' + ph + '%;background:' + tc(H) + '"></span></div></div>';
  }
  function scoreRow(g, big) {
    var S = sides(g); if (!S) return '';
    var pre = g.state === 'pre', sc = S.map(function (t) { return pre ? null : num(t.score); });
    var mx = Math.max(sc[0] == null ? -1 : sc[0], sc[1] == null ? -1 : sc[1]);
    var prev = LASTSCORE[g.id], now = sc.join('-'), pop = seeded && prev && prev !== now;
    LASTSCORE[g.id] = now;
    function cell(i) { return '<b class="ar-pts ' + (sc[i] === mx && sc[0] !== sc[1] ? 'lead' : 'trail') + (pop && String(prev).split('-')[i] !== String(sc[i]) ? ' pop' : '') + '">' + (sc[i] == null ? '' : sc[i]) + '</b>'; }
    return '<div class="ar-score"><div class="ar-tm">' + LiveUI.badge(S[0]) + '<span class="ar-nm">' + E(S[0].short || S[0].name) + '</span></div>' +
      '<div class="ar-mid">' + cell(0) + '<span class="ar-dash">–</span>' + cell(1) + '</div>' +
      '<div class="ar-tm r">' + LiveUI.badge(S[1]) + '<span class="ar-nm">' + E(S[1].short || S[1].name) + '</span></div></div>';
  }
  function lastPlay(e) {
    var g = e.g, S = summaries[e.id], txt = '';
    var pl = S ? playsOf(S.d).filter(function (p) { return p && p.text && !/^(goalie stopped|stoppage|period start|game start)$/i.test(p.text); }) : [];
    if (pl.length) { var p = pl[pl.length - 1]; txt = p.text; } else txt = g.lastPlay || '';
    if (!txt) return '';
    var fresh = seeded && LASTPLAY[e.id] != null && LASTPLAY[e.id] !== txt;
    LASTPLAY[e.id] = txt;
    return '<div class="ar-play' + (fresh ? ' fresh' : '') + '"><small>' + E(g.detail || '') + '</small>' + E(txt) + '</div>';
  }

  // basketball: scoring run from the play feed, court drawing, lead
  function bbRun(e) {
    var S = summaries[e.id], sc = S ? playsOf(S.d).filter(function (p) { return p && p.scoringPlay; }) : [];
    if (!sc.length) return null;
    var tid = null, pts = 0, opp = 0, last = sc[sc.length - 1];
    tid = last.team && last.team.id; if (tid == null) return null;
    for (var i = sc.length - 1; i >= 0; i--) {
      var p = sc[i], v = num(p.scoreValue) || 0;
      if (p.team && String(p.team.id) === String(tid)) pts += v; else { opp += v; break; }
    }
    // points the other side scored during the run (before it began) are not counted: report the run only
    var T = (sides(e.g) || []).filter(function (t) { return String(t.id) === String(tid); })[0];
    return T && pts >= 6 ? { t: T, pts: pts } : null;
  }
  function courtSVG(S) {
    return '<svg viewBox="0 0 300 120" width="100%" aria-hidden="true"><rect x="2" y="2" width="296" height="116" rx="6" fill="#8a5a2b"/>' +
      '<g fill="none" stroke="#f3e3c3" stroke-opacity=".75" stroke-width="1.5"><rect x="2" y="2" width="296" height="116" rx="6"/><path d="M150 2v116"/><circle cx="150" cy="60" r="16"/>' +
      '<rect x="2" y="38" width="60" height="44"/><path d="M2 12h28a62 62 0 0 1 0 96H2"/><circle cx="62" cy="60" r="14"/><rect x="238" y="38" width="60" height="44"/>' +
      '<path d="M298 12h-28a62 62 0 0 0 0 96h28"/><circle cx="238" cy="60" r="14"/></g>' +
      '<rect x="2" y="2" width="30" height="116" fill="' + tc(S[0]) + '" opacity=".35"/><rect x="268" y="2" width="30" height="116" fill="' + tc(S[1]) + '" opacity=".35"/>' +
      '<text x="17" y="66" fill="#fff" font-size="12" font-weight="700" text-anchor="middle">' + E(S[0].abbr) + '</text><text x="283" y="66" fill="#fff" font-size="12" font-weight="700" text-anchor="middle">' + E(S[1].abbr) + '</text></svg>';
  }
  function basketballHTML(e) {
    var S = sides(e.g); if (!S) return '';
    var a = num(S[0].score) || 0, h = num(S[1].score) || 0, run = bbRun(e), lead = a === h ? 'Tied' : (a > h ? S[0].abbr : S[1].abbr) + ' by ' + Math.abs(a - h);
    var tot = Math.max(1, a + h), pa = Math.round(a / tot * 100);
    return '<div class="ar-vis col">' + courtSVG(S) + '<div class="ar-tug"><div class="ar-lab"><span>' + (run ? E(run.t.abbr) + ' on a <em>' + run.pts + '-pt run</em>' : 'Lead <em>' + E(lead) + '</em>') + '</span></div>' +
      '<div class="ar-bar"><span style="width:' + pa + '%;background:' + tc(S[0]) + '"></span><span style="width:' + (100 - pa) + '%;background:' + tc(S[1]) + '"></span></div></div></div>';
  }
  // hockey: shots on goal from saves + goals, power play from the situation / last play
  function hockeyHTML(e) {
    var g = e.g, S = sides(g); if (!S) return '';
    function sog(t) { var o = S[0] === t ? S[1] : S[0], sv = Number((o.st || {}).saves); return isNaN(sv) ? null : sv + (num(t.score) || 0); }
    var sa = sog(S[0]), sh = sog(S[1]), si = g.sit || {}, lp = String(g.lastPlay || '');
    var pp = Object.keys(si).filter(function (k) { return /power ?play|strength/i.test(k) && si[k]; })[0];
    var rink = '<svg viewBox="0 0 300 120" width="100%" aria-hidden="true"><rect x="2" y="2" width="296" height="116" rx="36" fill="#dbe9f5"/><g fill="none" stroke-width="1.8">' +
      '<path d="M150 2v116" stroke="#c8102e"/><circle cx="150" cy="60" r="16" stroke="#2f6fd0"/><path d="M54 2v116M246 2v116" stroke="#2f6fd0"/><path d="M30 2v116M270 2v116" stroke="#c8102e" stroke-width="1"/>' +
      '<circle cx="86" cy="36" r="14" stroke="#c8102e"/><circle cx="86" cy="84" r="14" stroke="#c8102e"/><circle cx="214" cy="36" r="14" stroke="#c8102e"/><circle cx="214" cy="84" r="14" stroke="#c8102e"/></g>' +
      '<rect x="22" y="52" width="8" height="16" fill="#8aa0b8"/><rect x="270" y="52" width="8" height="16" fill="#8aa0b8"/></svg>';
    var bars = '';
    if (sa != null && sh != null) {
      var mx = Math.max(1, sa, sh);
      bars = [[S[0], sa], [S[1], sh]].map(function (r) {
        return '<div class="ar-sog"><span>' + E(r[0].abbr) + '</span><div class="ar-bar"><span style="width:' + Math.round(r[1] / mx * 100) + '%;background:' + tc(r[0]) + '"></span></div><b>' + r[1] + '</b></div>';
      }).join('') + '<div class="ar-cap">Shots on goal</div>';
    }
    var tag = pp ? 'Power play' + (typeof si[pp] === 'string' ? ' ' + E(si[pp]) : '') : /power play/i.test(lp) ? 'Power play' : /empty net/i.test(lp) ? 'Empty net' : '';
    return '<div class="ar-vis col">' + rink + bars + (tag ? '<div class="ar-flag">' + tag + '</div>' : '') + '</div>';
  }
  function visual(e) {
    var p = String(e.m.path || ''), h = '';
    try {
      if (/^basketball/.test(p)) h = basketballHTML(e);
      else if (p === 'hockey/nhl') h = hockeyHTML(e);
      else if (LiveUI.visual) h = LiveUI.visual(e.m, e.g);
    } catch (x) { h = ''; }
    return h ? '<div class="ar-vwrap' + (/^(basketball|hockey)/.test(p) ? '' : ' uiv') + '">' + h + '</div>' : '';
  }

  // ---------- bet slips ----------
  function tone(p, st) { return st === 'WON' ? 'hit' : p == null ? 'neu' : p >= 0.55 ? 'win' : p <= 0.45 ? 'lose' : 'neu'; }
  function priceOf(b) { return b.boosted_price && b.boosted_price !== b.price ? b.price + ' → ' + b.boosted_price : (b.price || ''); }
  function slipHTML(bt, e) {
    var b = bt.b, p = bt.p, cls = tone(p, bt.status), n = b.legs.length;
    var h = '<div class="ar-slip ' + cls + '" data-bi="' + bt.bi + '"><span class="ar-ring" style="--p:' + (p == null ? 0 : Math.round(p * 100)) + '"><i>' + (cls === 'hit' ? '✓' : '') + '</i></span>' +
      '<div class="ar-sl"><b><span class="ar-lt">' + E(shortLabel(b, e.g)) + '</span>' + (n > 1 ? '<span class="ar-lc">' + n + ' legs</span>' : '') + '</b><small>' + E(priceOf(b)) + ' · ' + money(b.stake) + (b.to_win != null ? ' to win ' + money(b.to_win) : '') + '</small></div>' +
      '<div class="ar-odd"><strong>' + pct(p) + '</strong><small>' + (n > 1 ? 'all ' + n + ' legs hit' : 'chance to win') + '</small></div>';
    if (n > 1) {
      h += '<ul class="ar-legs">' + bt.legs.map(function (l) {
        var k = l.st === 'WON' ? 'hit' : l.st === 'LOST' ? 'l' : l.p == null ? 'n' : l.p >= 0.55 ? 'w' : l.p <= 0.45 ? 'l' : 'n';
        var lg = l.x.g, vs = lg && lg.teams ? lg.teams.map(function (t) { return t.abbr; }).join(' @ ') : '';
        return '<li class="' + k + '"><i>' + (l.st === 'WON' ? '✓' : '') + '</i><span class="ar-lg">' + E(l.x.L.text || l.x.lbl || '') + '<small>' + E((l.x.n || '') + (vs && vs !== (e.g.teams || []).map(function (t) { return t.abbr; }).join(' @ ') ? (l.x.n ? ' · ' : '') + vs : '')) + '</small></span><span class="ar-lp">' + pct(l.p) + '</span></li>';
      }).join('') +
        '<li class="ov"><span class="ar-lg">Overall chance this slip wins<small>every leg must hit: ' + bt.legs.map(function (l) { return pct(l.p); }).join(' × ') + '</small></span><span class="ar-lp">' + pct(p) + '</span></li></ul>';
    }
    return h + '</div>';
  }

  // ---------- total band ----------
  function totals(M) {
    var L = M.bets.filter(function (x) { return x.p != null; }), n = L.length; if (!n) return null;
    var risk = 0, ew = 0, best = 0, ex = 0, dist = { 0: 1 }, money_ok = true;
    L.forEach(function (x) {
      var b = x.b, st = b.cash_stake != null ? b.cash_stake : (b.stake || 0), tw = b.to_win;
      ew += x.p; risk += st;
      if (tw == null) { money_ok = false; return; }
      best += tw; ex += x.p * tw - (1 - x.p) * st;
      var nd = {};
      Object.keys(dist).forEach(function (k) {
        var v = dist[k], w = Math.round((+k + tw) * 100) / 100, l = Math.round((+k - st) * 100) / 100;
        if (x.p > 0) nd[w] = (nd[w] || 0) + v * x.p;
        if (x.p < 1) nd[l] = (nd[l] || 0) + v * (1 - x.p);
      });
      dist = nd;
    });
    var ahead = 0; Object.keys(dist).forEach(function (k) { if (+k > 0) ahead += dist[k]; });
    return { n: n, ew: ew, risk: risk, ex: ex, best: best, ahead: ahead, money: money_ok };
  }
  function totHTML(M) {
    var T = totals(M); if (!T) return '';
    var sg = function (v) { return (v >= 0 ? '+' : '−') + money(Math.abs(v)); }, a = Math.round(T.ahead * 100);
    return '<div class="ar-tot"><div class="ar-tc big"><small>Chance you finish ahead</small><strong class="' + (a >= 50 ? 'g' : 'r') + '">' + a + '%</strong><em>across ' + T.n + (T.n < M.bets.length ? ' of ' + M.bets.length : '') + ' live bet' + (M.bets.length === 1 ? '' : 's') + (T.n < M.bets.length ? ' with a chance' : '') + (T.n > 1 ? ' · bets on one game move together' : '') + '</em></div>' +
      '<div class="ar-tc"><small>Expected wins</small><strong>' + T.ew.toFixed(1) + '<span> of ' + T.n + '</span></strong></div>' +
      '<div class="ar-tc"><small>At risk</small><strong>' + money(T.risk) + '</strong></div>' +
      '<div class="ar-tc"><small>Expected profit</small><strong class="' + (T.ex >= 0 ? 'g' : 'r') + '">' + sg(T.ex) + '</strong></div>' +
      '<div class="ar-tc"><small>Range</small><strong><span class="r">' + sg(-T.risk) + '</span> <span>to</span> <span class="g">' + sg(T.best) + '</span></strong></div>' +
      '<div class="ar-tc wide"><div class="ar-bar"><span style="width:' + a + '%;background:var(--win)"></span><span style="width:' + (100 - a) + '%;background:var(--lose)"></span></div></div></div>';
  }

  // ---------- Arena tiles ----------
  function tileHTML(e) {
    var g = e.g, pre = g.state !== 'in';
    return '<article class="ar-tile" data-g="' + E(e.id) + '" aria-label="' + E((g.teams || []).map(function (t) { return t.name; }).join(' at ')) + '">' +
      '<div class="ar-hd"><span class="' + (pre ? 'ar-soon' : 'ar-live') + '"><i></i>' + (pre ? 'Starting' : 'Live') + '</span><span>' + E(league(e.m)) + ' · ' + E(g.detail || '') + '</span></div>' +
      scoreRow(g) + visual(e) + tug(g) + lastPlay(e) +
      '<div class="ar-slips">' + e.bets.map(function (bt) { return slipHTML(bt, e); }).join('') + '</div></article>';
  }

  // ---------- Grid tiles ----------
  function situation(e) {
    var g = e.g, si = g.sit || {}, p = String(e.m.path || '');
    if (p === 'baseball/mlb') {
      var on = ['onFirst', 'onSecond', 'onThird'].filter(function (k) { return si[k]; }).length;
      var o = si.outs != null ? si.outs : g.outs;
      return (on ? on + ' on' : 'Bases empty') + (o != null ? ' · ' + o + ' out' : '');
    }
    if (/^football/.test(p)) return si.downDistanceText || si.shortDownDistanceText || si.possessionText || '';
    if (/^basketball/.test(p)) { var r = bbRun(e); return r ? r.t.abbr + ' ' + r.pts + '-pt run' : ''; }
    if (p === 'hockey/nhl') { var lp = String(g.lastPlay || ''); return /power play/i.test(lp) ? 'Power play' : ''; }
    return String(g.lastPlay || '').slice(0, 40);
  }
  function miniHTML(e) {
    var g = e.g, S = sides(g); if (!S) return '';
    var pre = g.state !== 'in', sc = S.map(function (t) { return pre ? null : num(t.score); });
    var mx = Math.max(sc[0] == null ? -1 : sc[0], sc[1] == null ? -1 : sc[1]);
    var rows = S.map(function (t, i) {
      return '<div class="ar-mr">' + LiveUI.badge(t) + '<span class="ar-n">' + E(t.short || t.name) + '</span><b class="' + (sc[i] === mx && sc[0] !== sc[1] ? 'w' : '') + '">' + (sc[i] == null ? '' : sc[i]) + '</b></div>';
    }).join('');
    var bar = '';
    if (hasP(g)) {
      var q = probs[g.id], h = q.home, a = q.away != null ? q.away : 1 - h, d = q.tie != null ? q.tie : 0;
      bar = '<div class="ar-mb"><span style="width:' + a * 100 + '%;background:' + tc(S[0]) + '"></span>' + (d ? '<span style="width:' + d * 100 + '%;background:var(--dim)"></span>' : '') + '<span style="width:' + h * 100 + '%;background:' + tc(S[1]) + '"></span></div>';
    }
    var oneAway = e.bets.some(function (bt) { var live = bt.legs.filter(function (l) { return l.st !== 'WON'; }).length; return bt.b.legs.length > 1 && live === 1; });
    var pcs = e.bets.map(function (bt) {
      var k = tone(bt.p, bt.status);
      return '<em class="ar-pc ' + (k === 'hit' ? 'win' : k) + '">' + pct(bt.p) + (bt.b.legs.length > 1 ? '<span class="ar-lc">' + bt.b.legs.length + 'L</span>' : '') + '</em>';
    }).join('');
    return '<button type="button" class="ar-mt' + (oneAway ? ' hot' : '') + '" data-g="' + E(e.id) + '" title="Double-click for the full game"><div class="ar-mh"><span>' + E(league(e.m)) + ' · ' + E(g.detail || '') + '</span><span class="ar-lv"><i></i></span></div>' +
      rows + bar + '<div class="ar-mf"><span class="ar-sit">' + E(situation(e)) + '</span><span class="ar-pcs">' + pcs + '</span></div></button>';
  }
  function gridHTML(M) {
    var win = 0, lose = 0, away = 0;
    M.bets.forEach(function (bt) {
      var k = tone(bt.p, bt.status); if (k === 'win' || k === 'hit') win++; else if (k === 'lose') lose++;
      if (bt.b.legs.length > 1 && bt.legs.filter(function (l) { return l.st !== 'WON'; }).length === 1) away++;
    });
    return '<div class="ar-sumrow"><span><b>' + M.games.length + '</b> live</span><span><b>' + M.bets.length + '</b> bets in play</span><span class="g"><b>' + win + '</b> winning</span><span class="r"><b>' + lose + '</b> losing</span>' +
      (away ? '<span class="y"><b>' + away + '</b> one leg away</span>' : '') + '</div><div class="ar-mgrid">' + M.games.map(miniHTML).join('') + '</div>' +
      '<p class="ar-legend">Numbers are your chance to win each bet. Double-click (or double-tap) a game to open it.</p>';
  }

  // ---------- host: switch, container, render ----------
  function setMode(m, keep) {
    mode = m;
    if (!keep) { try { localStorage.setItem(KEY, m); } catch (e) {} }
    apply();
  }
  function apply() {
    if (!hostSec) return;
    hostSec.classList.toggle('am-on', mode !== 'cards');
    if (seg) Array.prototype.forEach.call(seg.querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.m === mode)); });
    if (view) view.hidden = mode === 'cards';
    paint(true);
  }
  function paint(force) {
    if (!view || mode === 'cards') return;
    var M = model = buildModel(), h;
    if (!M || !M.games.length) h = '<div class="meta">Nothing live right now.</div>';
    else h = totHTML(M) + (mode === 'grid' ? gridHTML(M) : '<div class="ar-grid">' + M.games.map(tileHTML).join('') + '</div>');
    if (mode === 'arena') h = backBtn() + h;
    if (force || h !== lastHTML) { lastHTML = h; view.innerHTML = h; }
    seeded = true;
  }
  var cameFromGrid = false;
  function backBtn() { return cameFromGrid ? '<button type="button" class="ar-back" data-back="1">← Back to grid</button>' : ''; }
  function openGame(id) {
    cameFromGrid = true; setMode('arena', true);
    var el = view.querySelector('.ar-tile[data-g="' + id + '"]');
    if (!el) return;
    el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    el.classList.remove('arrive'); void el.offsetWidth; el.classList.add('arrive');
  }
  var lastTap = { id: null, t: 0 }, hint = null;
  function say(t) {
    if (!hint) { hint = document.createElement('div'); hint.className = 'ar-toast'; hint.setAttribute('role', 'status'); document.body.appendChild(hint); }
    hint.textContent = t; hint.hidden = false; clearTimeout(say.t); say.t = setTimeout(function () { hint.hidden = true; }, 2200);
  }
  function onClick(ev) {
    var t = ev.target.closest && ev.target.closest('.ar-mt,[data-back],.ar-slip');
    if (!t) return;
    if (t.dataset.back) { cameFromGrid = false; setMode('grid', true); window.scrollTo(0, 0); return; }
    if (t.classList.contains('ar-slip')) { return; }
    var id = t.dataset.g, now = Date.now();
    if (lastTap.id === id && now - lastTap.t < 350) { lastTap = { id: null, t: 0 }; openGame(id); }
    else { lastTap = { id: id, t: now }; say('Double-click to open the full game'); }
  }
  function onKey(ev) {
    if (ev.key !== 'Enter') return;
    var t = ev.target.closest && ev.target.closest('.ar-mt'); if (t) openGame(t.dataset.g);
  }
  function init() {
    hostSec = document.getElementById('sec-live'); var body = hostSec && hostSec.querySelector('.secbody'); if (!body) return false;
    seg = document.createElement('div'); seg.className = 'ar-seg'; seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Live view');
    seg.innerHTML = MODES.map(function (m) { return '<button type="button" data-m="' + m + '" aria-pressed="false">' + m[0].toUpperCase() + m.slice(1) + '</button>'; }).join('');
    seg.addEventListener('click', function (ev) { var b = ev.target.closest('button'); if (b) { cameFromGrid = false; setMode(b.dataset.m); } });
    view = document.createElement('div'); view.id = 'arenaView'; view.className = 'ar-view'; view.hidden = true;
    view.addEventListener('click', onClick); view.addEventListener('keydown', onKey);
    body.insertBefore(seg, body.firstChild); body.appendChild(view);
    apply(); return true;
  }
  function after(ctx) {
    try { DATA_REF = (ctx && ctx.DATA) || DATA_REF; if (!view && !init()) return; if (mode !== 'cards') paint(false); else seeded = true; } catch (e) { try { if (view) view.hidden = true; if (hostSec) hostSec.classList.remove('am-on'); } catch (x) {} }
  }
  if (window.LiveUI && window.LiveUI.afterRender) window.LiveUI.afterRender.push(after);
})();
