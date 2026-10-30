/* Outbox: bets sent from the Upload page are handed to this queue (localStorage), so you can leave the page while GitHub adds them.
   Every page loads it: it finishes the dispatch, follows the workflow run, and shows a chip in the nav (Sending… / Added ✓ / Failed · Retry).
   Safe to repeat a dispatch: add_bets.py skips bets that are already in the tracker. */
(function () {
  'use strict';
  var KEY = 'bt.outbox', TOKEN_KEY = 'bt.gh.settle', API = 'https://api.github.com/repos/s-chuch/bet-dashboard';
  var ME = Math.random().toString(36).slice(2), subs = [], timer = 0, busy = {};
  var GAP = 4000, LOCK_MS = 12000, DONE_MS = 60000, GIVE_UP_MS = 5 * 60000;

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

  /* ---- nav chip ---- */
  function render() {
    var nav = document.querySelector('.site-nav .in'); if (!nav) return;
    var list = load(), el = nav.querySelector('.ob-chip');
    var act = list.filter(active), bad = list.filter(function (j) { return j.state === 'failed'; }), ok = list.filter(function (j) { return j.state === 'done'; });
    if (!list.length) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('a'); el.className = 'ob-chip'; el.href = '#'; el.setAttribute('role', 'status'); nav.appendChild(el); el.addEventListener('click', onChip); }
    var n = act.reduce(function (s, j) { return s + (j.n || 0); }, 0);
    el.className = 'ob-chip ' + (bad.length ? 'bad' : act.length ? 'busy' : 'ok');
    el.textContent = bad.length ? 'Failed · Retry' : act.length ? 'Sending ' + n + '…' : 'Added ✓';
    el.title = bad.length ? bad[0].msg : act.length ? 'GitHub is adding your bets. You can keep browsing.' : ok.length ? 'Added. The Live page shows them within a minute or two.' : '';
  }
  function onChip(e) {
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
    jobs: load,
    on: function (f) { subs.push(f); }
  };
  window.addEventListener('pagehide', function () {   // free my jobs so the next page picks them up at once instead of waiting out the lock
    var list = load(); list.forEach(function (j) { if (j.lock === ME) { j.lock = ''; j.lockAt = 0; } }); save(list);
  });
  window.addEventListener('storage', function (e) { if (e.key === KEY) render(); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { render(); if (load().some(active)) start(); } });
  function boot() { render(); if (load().some(active)) start(); }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
})();
