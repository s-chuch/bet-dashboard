/* ui-bets: leg rings, one-leg-left, hit/bust celebration. Uses the globals of home.js (DATA, games, gameFor, legStatsFor, betLive, ...) and registers via window.LiveUI. */
(function () {
  'use strict';
  var LEGSTATE = {};      // card key -> {legs:[status..], bet:status, ev:{li:{t,until}}, card:{t,until}|null}
  var seeded = false;
  var DUR = 1400;

  function isWon(s) { return s === 'WON' || s === 'HIT'; }
  function ringHTML(x) {
    var pv = x.pv, pt = x.pt, won = x.s === 'WON', lost = x.s === 'LOST';
    var frac = Math.max(0, Math.min(1, pv / Math.max(1, pt)));
    var col = won ? 'var(--win)' : lost ? 'var(--lose)' : (pt - pv === 1 ? 'var(--push)' : '#6b7488');
    var st = '--p:' + (frac * 100).toFixed(1) + '%;--c:' + col;
    return '<span class="uring" style="' + st + '" title="' + pv + ' of ' + pt + '"><i>' + pv + '/' + pt + '</i></span>';
  }
  function decorateRing(row, x) {
    var L = x.L;
    var old = row.querySelector(':scope > .uring');
    if (old) old.remove();
    row.classList.remove('uir');
    if (!L || L.type !== 'prop' || L.op === 'under') return;
    if (typeof x.pv !== 'number' || typeof x.pt !== 'number' || !isFinite(x.pv) || !isFinite(x.pt)) return;
    if (x.pt > 15 || x.pt <= 0) return;
    row.classList.add('uir');
    row.insertAdjacentHTML('afterbegin', ringHTML(x));
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
            decorateRing(rows[r], x);
            var ev = rec.ev[li];
            rows[r].classList.remove('hit', 'bust');
            if (ev && ev.until > now) setFx(rows[r], ev.t, ev.until);
          }
          if (ls.length >= 2) {
            var rest = ls.filter(function (x) { return !isWon(x.s); });
            if (rest.length === 1 && rest[0].s !== 'LOST' && !(rest[0].g && rest[0].g.completed)) {
              card.classList.add('oneaway');
              var mid = card.querySelector('.cmid');
              if (mid && !mid.querySelector('.uone')) {
                var lbl = mid.querySelector('.clbl');
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
        if (x) decorateRing(row, x);
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
