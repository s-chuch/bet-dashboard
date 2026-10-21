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
    return '<h4>' + esc(r.sport + ' (' + r.league + '), ' + r.market.toUpperCase() + ': ' + r.selection + ' (' + r.away + ' @ ' + r.home + ')') + '</h4>';
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
      '</ul></article>';
  }
  function short(r) {
    return '<article class="pick near">' + header(r) + '<p>' + esc(r.book_app) + ' ' + am(r.odds) + ' \u00b7 fair ' + am(r.fair_odds) + ' \u00b7 ' + r.ev_pct + '% EV \u00b7 needs ' + am(r.kill_price) + ' \u00b7 ' + esc(r.start_et) + '</p></article>';
  }
  function render(d) {
    if (!d || !d.ok) { $('scan-time').textContent = d && d.scanned_et ? d.scanned_et : 'never'; $('bets').innerHTML = '<p class="empty err">' + esc(d && d.error ? 'Last scan failed: ' + d.error : 'No scan yet. Tap Scan now.') + '</p>'; return; }
    $('scan-time').textContent = d.scanned_et;
    $('bets').innerHTML = d.bets.length ? d.bets.map(full).join('') : '<p class="empty">Nothing reached +2% EV in this scan. No filler bets.</p>';
    $('near').innerHTML = d.near_misses.length ? d.near_misses.map(short).join('') : '<p class="empty">None.</p>';
    var c = d.counts || {}, rows = Object.keys(c).map(function (k) { var s = c[k]; return '<li>' + esc(k.toUpperCase()) + ': ' + s.games + ' games, ' + s.prices + ' prices compared, ' + s.exposed + ' skipped (your bets), ' + s.not_confirmed + ' not confirmed by Pinnacle</li>'; });
    $('details').innerHTML = 'Next ' + d.window_hours + ' hours. ' + d.totals.prices + ' prices compared: ' + d.totals.bet + ' bet, ' + d.totals.skip + ' skip, ' + d.totals.no + ' no.<ul>' + rows.join('') + '</ul>' +
      (d.errors && d.errors.length ? '<p class="err">' + d.errors.map(esc).join('<br>') + '</p>' : '');
  }
  function load(fresh) {
    var url = fresh ? REPO_API + '/contents/finder.json?ref=main&t=' + Date.now() : 'finder.json?t=' + Date.now();
    var o = fresh ? { headers: { 'Accept': 'application/vnd.github.raw+json' }, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' } : { cache: 'no-store' };
    if (fresh && getTok()) o.headers.Authorization = 'Bearer ' + getTok();
    return fetch(url, o).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(render)
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
  renderTok();
  load(false);
})();
