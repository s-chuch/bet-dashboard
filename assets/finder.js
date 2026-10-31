/* Bet Finder: renders finder.json (written by the finder workflow) and can dispatch a fresh scan
   with the same GitHub token the Upload page stores in this browser (localStorage 'bt.gh.settle'). */
(function () {
  'use strict';
  var REPO_API = 'https://api.github.com/repos/s-chuch/bet-dashboard';
  var TOKEN_KEY = 'bt.gh.settle';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function getTok() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setTok(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
  function am(n) { return n == null ? '?' : (n > 0 ? '+' : '') + n; }
  function money(n) { return n == null ? '?' : '$' + Number(n).toFixed(2); }
  function hdrs() { return { 'Authorization': 'Bearer ' + getTok(), 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }; }
  var opt = function (extra) { var o = { headers: hdrs(), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }; for (var k in extra) o[k] = extra[k]; return o; };

  function header(r) {
    return '<span class="app app-' + esc(r.book) + '">' + esc(r.book_app) + '</span><h4>' + esc(r.book_app + ': ' + r.sport + ' (' + r.league + '), ' + r.market.toUpperCase() + ': ' + r.selection + ' (' + r.away + ' @ ' + r.home + ')') + '</h4>';
  }
  function full(r) {
    var line = r.pin_line_type === 'alt' ? ' Pinnacle\u2019s matching line is an alternate one, so double-check the price.' : '';
    return '<article class="pick">' + header(r) + '<ul>' +
      '<li><b>Competition:</b> ' + esc(r.league) + '</li>' +
      '<li><b>Bet type:</b> In ' + esc(r.book_app) + ', open the game, go to the <b>' + esc(r.app_market) + '</b> market and tap \u201c' + esc(r.selection.replace(/ to win$/, '')) + '\u201d.</li>' +
      '<li><b>Stake:</b> ' + money(r.stake) + ' cash at ' + esc(r.book_app) + ' (' + r.stake_pct + '% of your ' + money(r.balance) + ' balance)</li>' +
      '<li><b>Yes at:</b> ' + am(r.odds) + ' now; still playable at ' + am(r.kill_price) + ' or better</li>' +
      '<li><b>Start:</b> ' + esc(r.start_et) + '</li>' +
      '<li><b>Fair:</b> ' + am(r.fair_odds) + ' (' + r.fair_pct + '% to win), <span class="ev">+' + r.ev_pct + '% EV</span>' + (r.ev_dollars != null ? ' (about ' + money(r.ev_dollars) + ' expected profit)' : '') + '. Pinnacle: ' + esc(r.pin_prices) + '.' + line + '</li>' +
      '<li><b>Wins if:</b> ' + esc(r.wins_if) + '</li>' +
      (r.caution ? '<li class="caution">\u26a0 ' + esc(r.caution) + '</li>' : '') +
      '</ul>' + act(r, 'cash', r.book, r.odds, r.stake) + '</article>';
  }
  function short(r) {
    return '<article class="pick near">' + header(r) + '<p><b>' + esc(r.book_app) + '</b> ' + am(r.odds) + ' \u00b7 fair ' + am(r.fair_odds) + ' \u00b7 ' + r.ev_pct + '% EV \u00b7 needs ' + am(r.kill_price) + ' \u00b7 ' + esc(r.start_et) + '</p>' + (r.skip_reason ? '<p class="caution small">' + esc(r.skip_reason) + '</p>' : '') + '</article>';
  }

  // ---------- bets you already have: never recommended again, listed as played ----------
  var OPEN = [], GENERIC = { fc: 1, cf: 1, sc: 1, united: 1, city: 1, state: 1, team: 1, club: 1, real: 1, sporting: 1, athletic: 1, the: 1 };
  function reEsc(x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function loadOpen() {   // open bets from data.json: catches a bet logged since the last scan (the scan itself also excludes them)
    return fetch('data.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : {}; }).then(function (d) {
      OPEN = (d.open || []).map(function (b) { return { bet_id: b.bet_id, book: b.book, pick: b.pick || '', event: b.event || '', stake: b.stake, price: b.price || '', boosted_price: b.boosted_price || '', text: ((b.event || '') + ' ' + (b.pick || '')).toLowerCase() }; });
    }).catch(function () {});
  }
  function playedOn(r) {
    var keys = [r.home, r.away].map(function (v) { return String(v || '').toLowerCase().trim(); }).filter(function (v) { return v.length > 3 && !GENERIC[v]; });
    return OPEN.filter(function (b) { return keys.some(function (k) { return new RegExp('(^|[^a-z])' + reEsc(k) + '([^a-z]|$)').test(b.text); }); });
  }
  function samePick(sel, b) {
    var t = String(sel || '').replace(/ to win$/, '').trim().toLowerCase(); return !!t && new RegExp('(^|[^a-z0-9])' + reEsc(t) + '([^a-z0-9]|$)').test(String(b.pick || '').toLowerCase());
  }
  function playedCard(r) {
    var ps = r.played || [], same = ps.some(function (p) { return p.same_pick; });
    return '<article class="pick played"><span class="tag ok">' + (same ? 'Played \u2713' : 'Same game') + '</span>' + header(r) + '<p class="small"><b>' +
      (same ? 'You already played this bet.' : 'You already have a bet on this game, so it is not recommended.') + '</b> Finder price now: ' + esc(r.book_app) + ' ' + am(r.odds) + ' \u00b7 +' + r.ev_pct + '% EV \u00b7 ' + esc(r.start_et) + '</p><ul>' +
      ps.map(function (p) { return '<li><b>' + esc(p.book) + ':</b> ' + esc(p.pick) + ' \u00b7 $' + esc(String(p.stake).replace(/^\$/, '')) + ' at ' + esc(p.price) + (p.boosted_price ? ' (boosted ' + esc(p.boosted_price) + ')' : '') + '</li>'; }).join('') + '</ul></article>';
  }

  // ---------- Log it / Skip on every pick card (dispatches add-bets.yml, the same path as the Upload page) ----------
  var CARDS = [], SKIPKEY = 'bt.finder.skips', SERVER_SKIPS = {};
  function etParts(d) {
    var o = {}; new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).forEach(function (p) { o[p.type] = p.value; }); return o.year + '-' + o.month + '-' + o.day + ' ' + o.hour + ':' + o.minute;
  }
  function today() { return etParts(new Date()).slice(0, 10); }
  function keyOf(r) { return r.key || ((r.start_utc || '').slice(0, 10) + '|' + r.event + '|' + r.selection); }
  function localSkips() { try { var j = JSON.parse(localStorage.getItem(SKIPKEY) || '{}'); return j[today()] || []; } catch (e) { return []; } }
  function addLocalSkip(k) { try { var j = {}; j[today()] = localSkips().concat([k]); localStorage.setItem(SKIPKEY, JSON.stringify(j)); } catch (e) {} }
  function skipped(r) { var k = keyOf(r); return SERVER_SKIPS[k] || localSkips().indexOf(k) >= 0; }
  function act(r, kind, book, price, stake, boost) {
    var i = CARDS.length; CARDS.push({ r: r, kind: kind, book: book, boost: boost || 0 });
    var ph = kind === 'cash' ? '' : (kind === 'bonus' ? 'bonus $' : 'stake $');
    return '<div class="act" data-i="' + i + '"><div class="act-row">' +
      '<label>Wager $<input class="a-stake" inputmode="decimal" value="' + esc(stake != null && stake !== '' ? Number(stake).toFixed(2) : '') + '" placeholder="' + ph + '"></label>' +
      '<label>Odds <input class="a-odds" inputmode="text" value="' + esc(am(price)) + '"></label>' +
      '<button class="btn pri a-log" type="button">Log it</button></div>' +
      '<div class="act-row"><input class="a-why" type="text" placeholder="Skip reason (odds wrong/moved)"><button class="btn a-skip" type="button">Skip</button></div>' +
      '<div class="a-msg small muted"></div></div>';
  }
  function decA(a) { return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function rowFor(c, stake, odds) {
    var r = c.r, now = new Date(), st = r.start_utc ? etParts(new Date(r.start_utc)) : '', bonus = c.kind === 'bonus';
    var mk = r.market + (c.kind === 'boost' ? ' (' + c.boost + '% profit boost)' : bonus ? ' (bonus bet $' + stake.toFixed(2) + ')' : '');
    var profit = stake * (decA(odds) - 1) * (c.kind === 'boost' ? 1 + c.boost / 100 : 1);
    var boosted = c.kind === 'boost' ? Math.round(profit / stake * 100) : null;
    return { date: today(), book: c.book, event: r.event || (r.away + ' @ ' + r.home), start_et: r.start_et || '', market: mk, pick: r.selection.replace(/ to win$/, ' ML'),
      price: am(odds), boosted_price: boosted && boosted >= 100 ? am(boosted) : '', stake: stake.toFixed(2) + (bonus ? ' (bonus)' : ''), to_win: profit.toFixed(2),
      placed_at: etParts(now), kind: c.kind, sport: r.league || r.sport || '', game_start: st, selection: r.selection, fair: r.fair_pct != null ? String(r.fair_pct) : '',
      ev: r.ev_pct != null ? String(r.ev_pct) : '', rec_price: am(r.odds), key: keyOf(r) };
  }
  function dispatch(rows, box, onDone) {
    var msg = box.querySelector('.a-msg'), t0 = Date.now();
    fetch(REPO_API + '/actions/workflows/add-bets.yml/dispatches', opt({ method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { bets: JSON.stringify(rows) } }), headers: (function () { var h = hdrs(); h['Content-Type'] = 'application/json'; return h; })() }))
      .then(function (r) {
        if (r.status !== 204) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(r.status === 401 ? 'GitHub rejected the token. Paste a new one above.' : 'GitHub refused (HTTP ' + r.status + (j.message ? ': ' + j.message : '') + ')'); });
        msg.textContent = 'Sent. Waiting for GitHub (about a minute)\u2026'; wait(0);
      }).catch(function (e) { onDone(false, e.message || String(e)); });
    function wait(n) {
      if (n > 48) return onDone(false, 'Still running after 4 minutes. Check the Log page shortly.');
      setTimeout(function () {
        fetch(REPO_API + '/actions/workflows/add-bets.yml/runs?per_page=5&event=workflow_dispatch', opt({})).then(function (r) { return r.json(); }).then(function (j) {
          var run = (j.workflow_runs || []).filter(function (x) { return Date.parse(x.created_at) >= t0 - 5000; }).pop();
          if (!run || run.status !== 'completed') return wait(n + 1);
          onDone(run.conclusion === 'success', run.conclusion === 'success' ? '' : 'GitHub run ' + run.conclusion + ' (bad field or duplicate). Nothing was logged twice.');
        }).catch(function () { wait(n + 1); });
      }, 5000);
    }
  }
  function onAct(e) {
    var b = e.target, box = b.closest ? b.closest('.act') : null; if (!box) return;
    var c = CARDS[+box.getAttribute('data-i')], msg = box.querySelector('.a-msg'); if (!c) return;
    var isLog = b.classList.contains('a-log'), isSkip = b.classList.contains('a-skip'); if (!isLog && !isSkip) return;
    if (!getTok()) { msg.className = 'a-msg small err'; msg.textContent = 'Connect GitHub above first (same token as the Upload page).'; return; }
    if (isLog) {
      var stake = Number(box.querySelector('.a-stake').value.replace(/[$,\s]/g, '')), ot = box.querySelector('.a-odds').value.replace(/\s|\u2212/g, function (x) { return x === '\u2212' ? '-' : ''; });
      if (/^\d{3,5}$/.test(ot)) ot = '+' + ot;
      var odds = /^[+-]\d{3,5}$/.test(ot) ? parseInt(ot, 10) : NaN;
      if (!(stake > 0 && stake <= 500)) { msg.className = 'a-msg small err'; msg.textContent = 'Enter a wager between $0.01 and $500.'; return; }
      if (!(Math.abs(odds) >= 100)) { msg.className = 'a-msg small err'; msg.textContent = 'Odds must look like +150 or -120.'; return; }
      if (b.getAttribute('data-armed') !== '1') {
        b.setAttribute('data-armed', '1'); b.textContent = 'Tap to confirm $' + stake.toFixed(2) + ' at ' + am(odds);
        msg.className = 'a-msg small muted'; msg.textContent = c.book + (c.kind === 'cash' ? ' cash' : c.kind === 'bonus' ? ' bonus bet' : ' ' + c.boost + '% boost') + ' \u00b7 tap again to log, or wait to cancel.';
        setTimeout(function () { if (b.getAttribute('data-armed') === '1' && !b.disabled) { b.removeAttribute('data-armed'); b.textContent = 'Log it'; msg.textContent = ''; } }, 6000);
        return;
      }
      b.removeAttribute('data-armed'); b.disabled = true; b.textContent = 'Logging\u2026'; box.querySelector('.a-skip').disabled = true;
      dispatch([rowFor(c, stake, odds)], box, function (ok, why) {
        if (ok) { b.textContent = 'Logged \u2713'; box.closest('.pick').classList.add('logged'); msg.className = 'a-msg small pos'; msg.textContent = 'Logged to the tracker (duplicate guard checked).'; }
        else { b.disabled = false; b.textContent = 'Log it'; box.querySelector('.a-skip').disabled = false; msg.className = 'a-msg small err'; msg.textContent = why; }
      });
    } else {
      var why = box.querySelector('.a-why').value.trim() || 'odds wrong/moved', r = c.r, card = box.closest('.pick');
      b.disabled = true; addLocalSkip(keyOf(r)); card.classList.add('skipping'); msg.className = 'a-msg small muted'; msg.textContent = 'Skipped (' + why + '). Saving\u2026';
      dispatch([{ skip: '1', book: c.book, event: r.event || (r.away + ' @ ' + r.home), price: am(r.odds), key: keyOf(r), reason: why, kind: c.kind, sport: r.league || '', selection: r.selection,
        game_start: r.start_utc ? etParts(new Date(r.start_utc)) : '', fair: r.fair_pct != null ? String(r.fair_pct) : '', ev: r.ev_pct != null ? String(r.ev_pct) : '', rec_price: am(r.odds) }], box, function (ok, err) {
        if (ok) card.style.display = 'none';
        else { b.disabled = false; msg.className = 'a-msg small err'; msg.textContent = 'Hidden on this phone, but not saved: ' + err; }
      });
    }
  }
  document.addEventListener('click', onAct);
  function loadSkips() {
    if (window.DB && DB.ready) {   /* signed-in, cut-over accounts keep their skips in Supabase (private); others use the public CSV below */
      return DB.cutover().then(function (on) {
        if (!on) return loadSkipsCsv();
        return DB.client.from('skips').select('rec_key').eq('day', today()).then(function (r) {
          SERVER_SKIPS = {}; (r.data || []).forEach(function (x) { SERVER_SKIPS[x.rec_key] = 1; });
        });
      }).catch(function () {});
    }
    return loadSkipsCsv();
  }
  function loadSkipsCsv() {
    return fetch('data/finder_skips.csv?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (t) {
      var d = today(); SERVER_SKIPS = {};
      t.split('\n').slice(1).forEach(function (l) { var m = l.match(/^(\d{4}-\d{2}-\d{2}),[^,]*,("(?:[^"]|"")*"|[^,]*)/); if (m && m[1] === d) SERVER_SKIPS[m[2].replace(/^"|"$/g, '').replace(/""/g, '"')] = 1; });
    }).catch(function () {});
  }

  // ---------- Bonus bet mode: +300..+500 ranked by bonus-bet return p*(dec-1) ----------
  function bonusCard(r, i) {
    return '<article class="pick bonus">' + header(r) + '<ul>' +
      '<li><b>#' + (i + 1) + ' \u00b7 Bonus return:</b> ' + r.bonus_ret_pct + '% of the bonus face (expected cash back per $1 of bonus)</li>' +
      '<li><b>Yes at:</b> ' + am(r.yes_at) + ' (now at ' + esc(r.book_app) + ')' + (r.bonus_floor ? '; still OK at ' + am(r.bonus_floor) + ' or longer (60% return)' : '') + '</li>' +
      '<li><b>Bet type:</b> <b>' + esc(r.app_market) + '</b> \u2192 \u201c' + esc(r.selection.replace(/ to win$/, '')) + '\u201d. Same pick at another book is fine if its price is at least the floor.</li>' +
      '<li><b>Fair:</b> ' + am(r.fair_odds) + ' (' + r.fair_pct + '% to win) \u00b7 <b>Start:</b> ' + esc(r.start_et) + '</li>' +
      '<li><b>Wins if:</b> ' + esc(r.wins_if) + '</li></ul>' + act(r, 'bonus', r.book, r.odds, '') + '</article>';
  }
  function renderBonus(d) {
    var b = ((d && d.bonus) || []).filter(function (r) { return !skipped(r); });
    $('bonus').innerHTML = b.length ? '<p class="muted small">Use one bonus bet at a time. Ranked by return on the bonus (you keep only the profit).</p>' + b.map(bonusCard).join('') : '<p class="empty">No +300 to +500 price returns 60%+ of face in this scan.</p>';
  }

  // ---------- Profit boost helper: book + boost % -> +100..+299 picks ranked by boosted EV ----------
  var POOL = [];
  function dec(a) { return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function renderBoost() {
    var book = $('bb-book').value, pctv = Number($('bb-pct').value), out = $('boost');
    if (!(pctv > 0 && pctv <= 200)) { out.innerHTML = '<p class="empty err">Enter a boost between 1 and 200%.</p>'; return; }
    if (!POOL.length) { out.innerHTML = '<p class="empty">No +100 to +299 prices in this scan.</p>'; return; }
    var rows = POOL.map(function (p) {
      var price = book === 'bet365' && p.bet365_odds != null ? p.bet365_odds : p.odds, f = p.fair_pct / 100;
      var ev = f * (1 + (dec(price) - 1) * (1 + pctv / 100)) - 1;
      var need = Math.ceil(100 * (((1.02 / f) - 1) / (1 + pctv / 100)));   // shortest + price that keeps +2% boosted EV
      return { p: p, price: price, ev: ev, need: need, b365: book === 'bet365' && p.bet365_odds != null };
    }).filter(function (x) { return x.ev > 0; }).sort(function (a, b) { return b.ev - a.ev; }).slice(0, 8);
    out.innerHTML = rows.length ? rows.map(function (x, i) {
      var p = x.p, boosted = Math.round((dec(x.price) - 1) * (1 + pctv / 100) * 100);
      return '<article class="pick near"><h4>' + esc('#' + (i + 1) + ' ' + p.league + ': ' + p.selection + ' (' + p.event + ')') + '</h4><p>' + esc(p.app_market) + ' \u00b7 ' +
        (x.b365 ? 'bet365 ' : 'best feed price (' + esc(p.book_app) + ') ') + am(x.price) + ' \u2192 boosted ' + am(boosted) + ' \u00b7 fair ' + am(p.fair_odds) + ' \u00b7 <span class="ev">+' + (x.ev * 100).toFixed(1) + '% boosted EV</span> \u00b7 <span class="small muted">boost rule \u2713 straight, +100 to +299</span></p>' +
        '<p class="small muted">' + (book === 'bet365' ? '' : 'Check ' + esc(book) + '\u2019s own price: ') + 'still +2% if its unboosted price is ' + (x.need >= 100 ? am(x.need) : '+100') + ' or longer. ' + esc(p.start_et) + (p.three_way ? ' \u00b7 3-way: a draw loses' : '') + '</p>' + act(p, 'boost', book, x.price, '', pctv) + '</article>';
    }).join('') : '<p class="empty">No +100 to +299 pick is +EV even with this boost.</p>';
  }

  function render(d) {
    CARDS = [];
    if (!d || !d.ok) { $('scan-time').textContent = d && d.scanned_et ? d.scanned_et : 'never'; $('bets').innerHTML = '<p class="empty err">' + esc(d && d.error ? 'Last scan failed: ' + d.error : 'No scan yet. Tap Scan now.') + '</p>'; return; }
    $('scan-time').textContent = d.scanned_et;
    renderBonus(d); POOL = (d.boost_pool || []).filter(function (r) { return !skipped(r); }); renderBoost();
    var bl = [], played = (d.played || []).slice(), seen = {};
    played.forEach(function (r) { seen[keyOf(r)] = 1; });
    d.bets.filter(function (r) { return !skipped(r); }).forEach(function (r) {
      var m = playedOn(r);
      if (!m.length) return bl.push(r);
      if (!seen[keyOf(r)]) { seen[keyOf(r)] = 1; played.push(Object.assign({}, r, { played: m.map(function (b) { return { bet_id: b.bet_id, book: b.book, pick: b.pick, stake: b.stake, price: b.price, boosted_price: b.boosted_price, same_pick: samePick(r.selection, b) }; }) })); }
    });
    $('bets').innerHTML = bl.length ? bl.map(full).join('') : '<p class="empty">Nothing reached +2% EV in this scan' + (played.length ? ' that you have not already played' : '') + '. No filler bets.</p>';
    $('played').innerHTML = played.length ? played.map(playedCard).join('') : '<p class="empty">None. You have no bet on a game the scan found +EV.</p>';
    var near = d.near_misses.filter(function (r) { return !playedOn(r).length; });
    $('near').innerHTML = near.length ? near.map(short).join('') : '<p class="empty">None.</p>';
    var c = d.counts || {}, rows = Object.keys(c).map(function (k) { var s = c[k]; return '<li>' + esc(k.toUpperCase()) + ': ' + s.games + ' games, ' + s.prices + ' prices compared, ' + s.exposed + ' skipped (your bets), ' + s.not_confirmed + ' not confirmed by Pinnacle</li>'; });
    $('details').innerHTML = 'Next ' + d.window_hours + ' hours. ' + d.totals.prices + ' prices compared: ' + d.totals.bet + ' bet' + (d.totals.played ? ' (' + d.totals.played + ' already played)' : '') + ', ' + d.totals.skip + ' skip, ' + d.totals.no + ' no.<ul>' + rows.join('') + '</ul>' +
      (d.errors && d.errors.length ? '<p class="err">' + d.errors.map(esc).join('<br>') + '</p>' : '');
  }
  function load(fresh) {
    var url = fresh ? REPO_API + '/contents/finder.json?ref=main&t=' + Date.now() : 'finder.json?t=' + Date.now();
    var o = fresh ? { headers: { 'Accept': 'application/vnd.github.raw+json' }, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' } : { cache: 'no-store' };
    if (fresh && getTok()) o.headers.Authorization = 'Bearer ' + getTok();
    return Promise.all([loadSkips(), loadOpen()]).then(function () { return fetch(url, o); }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(render)
      .catch(function () { if (!fresh) render(null); });
  }
  function renderTok() {
    var t = $('tok');
    if (getTok()) { t.innerHTML = '<span class="muted">Using the GitHub token saved on the Upload page.</span>'; return; }
    t.innerHTML = '<span class="muted">To use Scan now, save your GitHub token (the same one as the Upload page):</span><input id="tok-in" type="password" autocomplete="off" placeholder="github_pat_\u2026"><button class="btn" id="tok-save" type="button">Save</button>';
    $('tok-save').onclick = function () { var v = $('tok-in').value.trim(); if (v) { setTok(v); renderTok(); } };
  }
  function status(s, bad) { var e = $('scan-status'); e.textContent = s; e.className = 'small ' + (bad ? 'err' : 'muted'); }
  function scanNow() {
    if (!getTok()) { status('Save your GitHub token first.', true); return; }
    var btn = $('scan-now'); btn.disabled = true;
    var t0 = Date.now() - 15000;
    status('Starting scan\u2026');
    fetch(REPO_API + '/actions/workflows/finder.yml/dispatches', opt({ method: 'POST', body: JSON.stringify({ ref: 'main' }), headers: (function () { var h = hdrs(); h['Content-Type'] = 'application/json'; return h; })() }))
      .then(function (r) { if (r.status !== 204) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error('GitHub refused (HTTP ' + r.status + (j.message ? ': ' + j.message : '') + ')'); }); poll(t0, 0); })
      .catch(function (e) { status(e.message || String(e), true); btn.disabled = false; });
  }
  function poll(t0, n) {
    var btn = $('scan-now');
    if (n > 60) { status('Still running after 5 minutes. Check back shortly.', true); btn.disabled = false; return; }
    setTimeout(function () {
      fetch(REPO_API + '/actions/workflows/finder.yml/runs?per_page=3&event=workflow_dispatch', opt({})).then(function (r) { return r.json(); }).then(function (j) {
        var run = (j.workflow_runs || []).filter(function (x) { return Date.parse(x.created_at) >= t0; })[0];
        if (!run) { status('Waiting for GitHub to start the scan\u2026'); return poll(t0, n + 1); }
        if (run.status !== 'completed') { status('Scanning on GitHub (' + run.status + ')\u2026'); return poll(t0, n + 1); }
        btn.disabled = false;
        if (run.conclusion !== 'success') { status('The scan failed on GitHub (' + run.conclusion + '). Showing the last good scan.', true); return; }
        status('Done. Loading the new results\u2026');
        load(true).then(function () { status('Updated.'); });
      }).catch(function () { poll(t0, n + 1); });
    }, n ? 5000 : 4000);
  }
  $('scan-now').onclick = scanNow;
  $('bb-book').onchange = renderBoost; $('bb-pct').oninput = renderBoost;
  renderTok();
  load(false);
})();
