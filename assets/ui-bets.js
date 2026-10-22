/* ui-bets: leg rings, one-leg-left, hit/bust celebration. Uses the globals of home.js (DATA, games, gameFor, legStatsFor, betLive, ...) and registers via window.LiveUI. */
(function () {
  'use strict';
  var LEGSTATE = {};      // card key -> {legs:[status..], bet:status, ev:{li:{t,until}}, card:{t,until}|null}
  var seeded = false;
  var DUR = 1400;

  function isWon(s) { return s === 'WON' || s === 'HIT'; }
  // one ring for EVERY leg: count legs fill to pv/pt, "under" legs fill to pv/limit, everything else (ML, spread, ...) fills to its win chance
  function legInfo(x, b) {
    var L = x.L || {}, g = x.g, ov = L.side !== 'under' && L.op !== 'under';
    if (L.type === 'prop' && ov && typeof x.pv === 'number' && typeof x.pt === 'number' && x.pt > 0) return { kind: 'count', pv: x.pv, pt: x.pt, s: x.s };
    if ((L.type === 'total' || L.type === 'teamtotal') && ov && typeof L.line === 'number' && typeof x.pv === 'number') return { kind: 'count', pv: x.pv, pt: Math.floor(L.line) + 1, s: x.s };
    if ((L.type === 'prop' || L.type === 'total' || L.type === 'teamtotal') && !ov && typeof L.line === 'number' && typeof x.pv === 'number') return { kind: 'under', pv: x.pv, pt: Math.max(1, Math.ceil(L.line) - 1), s: x.s };
    var p = null;
    if (g && g.state !== 'pre') { try { p = legP(b, L, x.s, x); } catch (e) {} }
    if (x.s === 'WON') p = 1; else if (x.s === 'LOST') p = 0;
    return { kind: 'prob', p: (typeof p === 'number' && isFinite(p)) ? p : null, s: x.s };
  }
  function ringHTML(x) {
    var won = x.s === 'WON', lost = x.s === 'LOST', frac, col, txt, cls = '', title;
    if (x.kind === 'count') {
      frac = Math.max(0, Math.min(1, x.pv / Math.max(1, x.pt)));
      col = won ? 'var(--win)' : lost ? 'var(--lose)' : (x.pt - x.pv === 1 ? 'var(--push)' : '#6b7488');
      txt = x.pv + '/' + x.pt; title = x.pv + ' of ' + x.pt;
    } else if (x.kind === 'under') {
      frac = Math.max(0, Math.min(1, x.pv / x.pt));
      col = lost || x.pv > x.pt ? 'var(--lose)' : x.pv >= x.pt ? 'var(--push)' : 'var(--win)';
      txt = x.pv + '/' + x.pt; title = x.pv + ' of max ' + x.pt;
    } else {
      var p = x.p;
      frac = p == null ? 0 : p;
      col = won ? 'var(--win)' : lost ? 'var(--lose)' : p == null ? '#6b7488' : p >= 0.55 ? 'var(--win)' : p <= 0.45 ? 'var(--lose)' : 'var(--push)';
      txt = p == null ? '–' : (won ? '✓' : lost ? '✗' : Math.round(p * 100) + '%'); title = p == null ? 'not started' : 'win chance ' + Math.round(p * 100) + '%';
      cls = ' up' + (p == null ? ' none' : '');
    }
    var sz = txt.length <= 5 ? '' : txt.length <= 7 ? ' u7' : ' u9';
    if (txt.length > 7) txt = String(x.pv);
    return '<span class="uring' + sz + cls + '" style="--p:' + (frac * 100).toFixed(1) + '%;--c:' + col + '" title="' + title + '"><i>' + txt + '</i></span>';
  }
  function decorateRing(row, x, b) {
    var old = row.querySelector(':scope > .uring');
    if (old) old.remove();
    row.classList.remove('uir');
    if (!x || !x.L) return;
    row.classList.add('uir');
    row.insertAdjacentHTML('afterbegin', ringHTML(legInfo(x, b)));
  }
  function setFx(el, kind, until) {
    var left = until - Date.now();
    if (left <= 0) return;
    el.classList.add(kind);
    el.style.animationDelay = (-(DUR - left) / 1000).toFixed(2) + 's';
  }

  function run() {
    var now = Date.now();
    var cards = document.querySelectorAll('.card[data-k][data-bi]');
    var first = !seeded;
    for (var c = 0; c < cards.length; c++) {
      var card = cards[c];
      try {
        var b = DATA && DATA.open && DATA.open[+card.dataset.bi];
        if (!b || !b.legs) continue;
        var k = card.dataset.k, ls = legStatsFor(b);
        var st = ls.map(function (x) { return x.s; });
        var bet = b.multi ? combine(st) : st[0];
        var prev = LEGSTATE[k];
        var rec = prev || (LEGSTATE[k] = { legs: st.slice(), bet: bet, ev: {}, card: null });
        if (prev && !first) {
          for (var i = 0; i < st.length; i++) {
            var was = prev.legs[i], is = st[i];
            if (was === is) continue;
            if (b.multi && isWon(is) && !isWon(was)) rec.ev[i] = { t: 'hit', until: now + DUR };
            else if (b.multi && is === 'LOST' && was !== 'LOST') rec.ev[i] = { t: 'bust', until: now + DUR };
          }
          if (bet !== prev.bet) {
            if (bet === 'WON') {
              rec.card = { t: 'hit', until: now + DUR };
              if (document.visibilityState === 'visible' && navigator.vibrate) { try { navigator.vibrate([60, 40, 60]); } catch (e) {} }
            } else if (bet === 'LOST') rec.card = { t: 'bust', until: now + DUR };
          }
        }
        rec.legs = st.slice(); rec.bet = bet;

        card.classList.remove('oneaway');
        var oldTag = card.querySelector('.uone'); if (oldTag) oldTag.remove();

        if (b.multi) {
          var rows = card.querySelectorAll('.score > .leg[data-li]');
          for (var r = 0; r < rows.length; r++) {
            var li = +rows[r].dataset.li, x = ls[li];
            if (!x) continue;
            decorateRing(rows[r], x, b);
            var ev = rec.ev[li];
            rows[r].classList.remove('hit', 'bust');
            if (ev && ev.until > now) setFx(rows[r], ev.t, ev.until);
          }
          if (ls.length >= 2) {
            var rest = ls.filter(function (x) { return !isWon(x.s); });
            if (rest.length === 1 && rest[0].s !== 'LOST' && !(rest[0].g && rest[0].g.completed)) {
              card.classList.add('oneaway');
              var mid = card.querySelector('.sl3') || card.querySelector('.cmid');
              if (mid && !mid.querySelector('.uone')) {
                var lbl = mid.querySelector('.sld') || mid.querySelector('.clbl');
                var t = document.createElement('span'); t.className = 'uone'; t.textContent = '1 LEG LEFT';
                if (lbl) lbl.insertAdjacentElement('afterend', t); else mid.appendChild(t);
              }
            }
          }
        }
        card.classList.remove('hit', 'bust');
        if (rec.card && rec.card.until > now) setFx(card, rec.card.t, rec.card.until);
      } catch (e) {}
    }
    seeded = true;
  }
  // home.js tick1s() re-renders every .leg row each second (wiping the ring child but keeping the class): put the ring back
  function mend() {
    var rows = document.querySelectorAll('.leg.uir');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.querySelector(':scope > .uring')) continue;
      try {
        var card = row.closest('.card[data-bi]'), b = card && DATA.open[+card.dataset.bi];
        if (!b) continue;
        var x = legStatsFor(b)[+row.dataset.li];
        if (x) decorateRing(row, x, b);
      } catch (e) {}
    }
  }
  try {
    var mo = new MutationObserver(function () {
      mo.disconnect();
      try { mend(); } catch (e) {}
      watch();
    });
    var watch = function () {
      ['live', 'bets', 'wonCards', 'lostCards'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) mo.observe(el, { childList: true, subtree: true });
      });
    };
    watch();
  } catch (e) {}
  window.LiveUI = window.LiveUI || { scoreBox: null, afterRender: [] };
  window.LiveUI.afterRender.push(function () { try { run(); } catch (e) {} });
})();
