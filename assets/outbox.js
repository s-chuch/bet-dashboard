/* Outbox: bets sent from the Upload page are handed to this queue (localStorage), so you can leave the page while GitHub adds them.
   Every page loads it: it finishes the dispatch, follows the workflow run, and shows a chip in the nav (Sending… / Added ✓ / Failed · Retry).
   Safe to repeat a dispatch: add_bets.py skips bets that are already in the tracker. */
(function () {
  'use strict';
  var KEY = 'bt.outbox', TOKEN_KEY = 'bt.gh.settle', API = 'https://api.github.com/repos/s-chuch/bet-dashboard';
  var ME = Math.random().toString(36).slice(2), subs = [], timer = 0, busy = {};
  var GAP = 4000, LOCK_MS = 12000, DONE_MS = 60000, GIVE_UP_MS = 5 * 60000;
  var SJ_KEY = 'bt.slipjobs', SJ_GAP = 5000, SJ_GIVE_UP = 15 * 60000, SJ_KEEP = 3 * 86400000, stimer = 0;

  function load() { try { var v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function save(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {} }
  function tok() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function patch(id, p) {   // re-read first: another open page may have changed the list
    var list = load(), j = list.filter(function (x) { return x.id === id; })[0];
    if (!j) return null;
    Object.keys(p).forEach(function (k) { j[k] = p[k]; });
    save(list); changed(); return j;
  }
  function changed() { render(); subs.forEach(function (f) { try { f(load()); } catch (e) {} }); }
  function active(j) { return j.state === 'queued' || j.state === 'sending' || j.state === 'sent'; }

  function dispatchMsg(status, j) {
    return status === 401 ? 'GitHub rejected the token. Paste a new one on the Upload page.'
      : status === 403 ? 'Not allowed: the token needs Actions: Read and write on s-chuch/bet-dashboard (or GitHub rate limit).'
      : status === 404 ? 'GitHub could not find the add-bets workflow, or the token has no access to the repo.'
      : (j && j.message) || ('HTTP ' + status);
  }
  function post(j) {
    if (!tok()) { patch(j.id, { state: 'failed', msg: 'Connect GitHub on the Upload page first.' }); return Promise.resolve(); }
    patch(j.id, { state: 'sending' });
    return fetch(API + '/actions/workflows/add-bets.yml/dispatches', {
      method: 'POST', keepalive: true,   // keepalive lets the request finish even if the page is closed or changed
      headers: { 'Authorization': 'Bearer ' + tok(), 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      body: j.body, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'
    }).then(function (r) {
      if (r.status === 204) { patch(j.id, { state: 'sent', t0: Date.now(), msg: '' }); return; }
      return r.json().catch(function () { return {}; }).then(function (b) { patch(j.id, { state: 'failed', msg: dispatchMsg(r.status, b) }); });
    }, function () {
      var n = (j.tries || 0) + 1;
      patch(j.id, n >= 3 ? { state: 'failed', msg: 'Network error. Nothing was sent. Tap to retry.', tries: n } : { state: 'queued', tries: n });
    });
  }
  function follow(j) {
    if (Date.now() - (j.t0 || 0) > GIVE_UP_MS) { patch(j.id, { state: 'failed', msg: 'GitHub is slow to answer. Check the Auto-runs tab on the Logs page; Retry is safe (duplicates are skipped).' }); return Promise.resolve(); }
    return fetch(API + '/actions/workflows/add-bets.yml/runs?per_page=3&event=workflow_dispatch', {
      headers: { 'Authorization': 'Bearer ' + tok(), 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'
    }).then(function (r) { return r.ok ? r.json() : { workflow_runs: [] }; }).then(function (b) {
      var run = (b.workflow_runs || []).filter(function (x) { return Date.parse(x.created_at) >= (j.t0 || 0) - 15000; })[0];
      if (!run || run.status !== 'completed') return;
      if (run.conclusion === 'success') patch(j.id, { state: 'done', doneAt: Date.now(), msg: '' });
      else patch(j.id, { state: 'failed', msg: 'GitHub could not add them (' + run.conclusion + ').', url: run.html_url });
    }, function () {});
  }
  function tick() {
    var now = Date.now(), list = load().filter(function (j) { return j.state !== 'done' || now - (j.doneAt || 0) < DONE_MS; });
    if (list.length !== load().length) { save(list); changed(); }
    list.filter(active).forEach(function (j) {
      if (j.lock && j.lock !== ME && now - (j.lockAt || 0) < LOCK_MS) return;   // another open page is on it
      if (busy[j.id]) return;
      busy[j.id] = 1; patch(j.id, { lock: ME, lockAt: now });
      (j.state === 'sent' ? follow(j) : post(j)).then(function () { delete busy[j.id]; }, function () { delete busy[j.id]; });
    });
    if (!list.some(active)) { clearInterval(timer); timer = 0; }
  }
  function start() { if (!timer) { timer = setInterval(tick, GAP); } setTimeout(tick, 0); }

  /* ---- screenshots being read on the server (slip_jobs in Supabase): remembered here so every page can show progress ---- */
  function sload() { try { var v = JSON.parse(localStorage.getItem(SJ_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function ssave(list) { try { localStorage.setItem(SJ_KEY, JSON.stringify(list)); } catch (e) {} }
  function spatch(id, p) { var list = sload(), j = list.filter(function (x) { return x.id === id; })[0]; if (!j) return; Object.keys(p).forEach(function (k) { j[k] = p[k]; }); ssave(list); changed(); }
  function sreading() { return sload().filter(function (j) { return j.state === 'reading'; }); }
  function spoll() {
    var d = window.DB, now = Date.now(), list = sreading();
    var old = sload().filter(function (j) { return now - (j.at || 0) > SJ_KEEP; });
    if (old.length) { ssave(sload().filter(function (j) { return now - (j.at || 0) <= SJ_KEEP; })); changed(); }
    if (!list.length) { clearInterval(stimer); stimer = 0; return; }
    if (!d || !d.ready || !d.user) return;
    d.client.from('slip_jobs').select('id,status,error').in('id', list.map(function (j) { return j.id; })).then(function (r) {
      if (r.error) return;
      var rows = r.data || [];
      list.forEach(function (j) {
        var row = rows.filter(function (x) { return x.id === j.id; })[0];
        if (row && row.status === 'done') spatch(j.id, { state: 'ready' });
        else if (row && row.status === 'error') spatch(j.id, { state: 'failed', msg: row.error || 'Reading failed.' });
        else if (!row && now - (j.at || 0) > 120000) api.slipDrop(j.id);   // removed elsewhere (another device, or you removed it)
        else if (now - (j.at || 0) > SJ_GIVE_UP) spatch(j.id, { state: 'failed', msg: 'The server did not answer. Tap Re-read on the Upload page.' });
      });
    }, function () {});
  }
  function sstart() { if (!stimer) stimer = setInterval(spoll, SJ_GAP); setTimeout(spoll, 1500); }

  /* ---- nav chip ---- */
  function render() {
    var nav = document.querySelector('.site-nav .in'); if (!nav) return;
    var list = load(), el = nav.querySelector('.ob-chip'), sj = sload();
    var act = list.filter(active), bad = list.filter(function (j) { return j.state === 'failed'; }), ok = list.filter(function (j) { return j.state === 'done'; });
    var sRead = sj.filter(function (j) { return j.state === 'reading'; }), sReady = sj.filter(function (j) { return j.state === 'ready'; }), sBad = sj.filter(function (j) { return j.state === 'failed'; });
    if (!list.length && !sj.length) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('a'); el.className = 'ob-chip'; el.href = '#'; el.setAttribute('role', 'status'); nav.appendChild(el); el.addEventListener('click', onChip); }
    var n = act.reduce(function (s, j) { return s + (j.n || 0); }, 0), go = false;
    if (bad.length) { el.className = 'ob-chip bad'; el.textContent = 'Failed · Retry'; el.title = bad[0].msg; }
    else if (sBad.length) { go = true; el.className = 'ob-chip bad'; el.textContent = 'Reading failed · Open'; el.title = sBad[0].msg; }
    else if (act.length) { el.className = 'ob-chip busy'; el.textContent = 'Sending ' + n + '…'; el.title = 'GitHub is adding your bets. You can keep browsing.'; }
    else if (sRead.length) { go = true; el.className = 'ob-chip busy'; el.textContent = 'Reading ' + sRead.length + '…'; el.title = 'The server is reading your screenshots. You can keep browsing; they will be ready to approve on the Upload page.'; }
    else if (sReady.length) { go = true; el.className = 'ob-chip ok'; el.textContent = sReady.length + ' ready · Review'; el.title = 'Tap to open the Upload page and approve them.'; }
    else { el.className = 'ob-chip ok'; el.textContent = 'Added ✓'; el.title = ok.length ? 'Added. The Live page shows them within a minute or two.' : ''; }
    el.setAttribute('href', go ? 'upload.html' : '#');
  }
  function onChip(e) {
    if (e.currentTarget.getAttribute('href') !== '#') return;   // a link to the Upload page: let it navigate
    e.preventDefault();
    var list = load(), bad = list.filter(function (j) { return j.state === 'failed'; })[0];
    if (bad) { if (confirm(bad.msg + '\n\nTry again?')) api.retry(bad.id); else if (confirm('Discard these bets?')) api.dismiss(bad.id); }
    else if (list.some(function (j) { return j.state === 'done'; })) { list.filter(function (j) { return j.state === 'done'; }).forEach(function (j) { api.dismiss(j.id); }); }
  }

  var api = window.Outbox = {
    add: function (n, body) {
      var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6), list = load();
      list.push({ id: id, n: n, body: body, state: 'queued', tries: 0, at: Date.now() }); save(list); changed(); start(); return id;
    },
    retry: function (id) { patch(id, { state: 'queued', tries: 0, msg: '', lock: '' }); start(); },
    dismiss: function (id) { save(load().filter(function (j) { return j.id !== id; })); changed(); },
    slipAdd: function (id, name) { var list = sload(); list.push({ id: id, name: name || '', state: 'reading', at: Date.now() }); ssave(list); changed(); sstart(); },
    slipDrop: function (id) { ssave(sload().filter(function (j) { return j.id !== id; })); changed(); },
    slipsReady: function () { return sload().some(function (j) { return j.state === 'ready' || j.state === 'failed'; }); },
    jobs: load,
    on: function (f) { subs.push(f); }
  };
  window.addEventListener('pagehide', function () {   // free my jobs so the next page picks them up at once instead of waiting out the lock
    var list = load(); list.forEach(function (j) { if (j.lock === ME) { j.lock = ''; j.lockAt = 0; } }); save(list);
  });
  window.addEventListener('storage', function (e) { if (e.key === KEY || e.key === SJ_KEY) render(); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { render(); if (load().some(active)) start(); if (sreading().length) sstart(); } });
  function boot() { render(); if (load().some(active)) start(); if (sreading().length) sstart(); }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
})();
