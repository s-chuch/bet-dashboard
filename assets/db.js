/* Supabase client + sign-in state (phase 2a). The anon key is public by design; Row Level Security
   in Postgres is what keeps each user's rows private. Never put the service key in the frontend. */
(function () {
  'use strict';
  var URL_ = 'https://jzlfbpxcqerwtiurzsmu.supabase.co';
  var KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp6bGZicHhjcWVyd3RpdXJ6c211Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2MDcyMDMsImV4cCI6MjEwODE4MzIwM30.YpUnOlqgNCElbMxpRPtIj09SDrs3As1jSQ6-tMQ0bSU';
  var lib = window.supabase;
  var DB = window.DB = { url: URL_, ready: !!(lib && lib.createClient), client: null, user: null };
  if (!DB.ready) return;
  DB.client = lib.createClient(URL_, KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' } });

  /* Resolves to the signed-in user or null. */
  DB.getUser = function () {
    return DB.client.auth.getSession().then(function (r) {
      DB.user = r && r.data && r.data.session ? r.data.session.user : null; return DB.user;
    }).catch(function () { return null; });
  };
  /* For pages that must have a session: sends visitors to login.html and remembers where they were. */
  DB.requireLogin = function () {
    return DB.getUser().then(function (u) {
      if (!u) { location.replace('login.html?next=' + encodeURIComponent(location.pathname.split('/').pop() || 'index.html')); return new Promise(function () {}); }
      return u;
    });
  };
  DB.signOut = function () { return DB.client.auth.signOut().then(function () { DB.user = null; chip(); }); };
  /* Invite-only: shouldCreateUser is false, so an unknown email gets an error instead of an account. */
  DB.sendLink = function (email, next) {
    var back = location.origin + location.pathname.replace(/[^\/]*$/, '') + (next || 'index.html');
    return DB.client.auth.signInWithOtp({ email: email, options: { shouldCreateUser: false, emailRedirectTo: back } });
  };

  /* Cutover switch: profiles.rules.cutover = true means this account's data lives in Supabase. Until then every page
     behaves exactly as before (public files + GitHub token). The answer is cached so pages decide before it loads. */
  var CUT_KEY = 'bt.cutover', PLACEHOLDER = 'supabase_session_no_github_token', TOK_KEY = 'bt.gh.settle';
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
  function applyToken(on) {              /* pages insist on a "token" before they will send; ours is a stand-in, never used on GitHub */
    var cur = lsGet(TOK_KEY);
    if (on && !cur) lsSet(TOK_KEY, PLACEHOLDER); else if (!on && cur === PLACEHOLDER) lsSet(TOK_KEY, null);
  }
  var cutP = null;
  DB.cutover = function () {
    if (cutP) return cutP;
    cutP = DB.getUser().then(function (u) {
      if (!u) { lsSet(CUT_KEY, null); applyToken(false); return false; }
      return DB.client.from('profiles').select('rules').maybeSingle().then(function (r) {
        var on = !!(r.data && r.data.rules && r.data.rules.cutover === true || r.data && r.data.rules && r.data.rules.cutover === 'true');
        lsSet(CUT_KEY, on ? '1' : null); applyToken(on); return on;
      });
    }).catch(function () { return lsGet(CUT_KEY) === '1'; });
    return cutP;
  };
  if (lsGet(CUT_KEY) === '1') applyToken(true);

  var realFetch = window.fetch.bind(window);
  var SNAP = /(?:^|\/)(data|stats|log|archive)\.json(?:\?|$)/;
  var GHWF = /^https:\/\/api\.github\.com\/repos\/s-chuch\/bet-dashboard\/actions\/workflows\/([\w.\-]+)\/(dispatches|runs)(?:\?|$)/;
  var KIND = { 'add-bets.yml': 'add_bets', 'manual-settle.yml': 'manual_settle', 'set-balance.yml': 'set_balance' };
  function noAuth(init) {                /* never send the stand-in token to GitHub */
    var h = init && init.headers; if (!h) return init;
    var flat = {}; if (typeof h.forEach === 'function' && !(h instanceof Array)) h.forEach(function (v, k) { flat[k] = v; }); else for (var k in h) flat[k] = h[k];
    Object.keys(flat).forEach(function (k) { if (/^authorization$/i.test(k) && String(flat[k]).indexOf(PLACEHOLDER) >= 0) delete flat[k]; });
    return Object.assign({}, init, { headers: flat });
  }
  function json(obj, status) { return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } }); }
  function toRequest(wf, inputs) {
    var i = inputs || {};
    if (wf === 'add-bets.yml') return { kind: 'add_bets', payload: { bets: i.bets } };
    if (wf === 'manual-settle.yml') return { kind: 'manual_settle', payload: { bet_id: i.bet_id, result: i.result, profit: i.profit || '' } };
    if (wf === 'set-balance.yml') return { kind: 'set_balance', payload: { book: i.book, amount: i.amount, note: i.note || '' } };
    return null;
  }
  window.fetch = function (input, init) {
    var u = typeof input === 'string' ? input : (input && input.url) || '';
    var snap = SNAP.exec(u.split('#')[0]);
    if (snap && !(/^[a-z]+:\/\//i.test(u) && u.indexOf(location.origin) !== 0)) {
      return DB.cutover().then(function (on) {
        if (!on) return realFetch(input, init);
        return DB.client.from('snapshots').select('payload').eq('kind', snap[1]).maybeSingle().then(function (r) {
          if (r.error || !r.data) return realFetch(input, init);     /* no snapshot yet: public file */
          return json(r.data.payload);
        });
      }).catch(function () { return realFetch(input, init); });
    }
    var gh = GHWF.exec(u);
    if (gh) {
      var wf = gh[1], what = gh[2];
      return DB.cutover().then(function (on) {
        if (!on) return realFetch(input, noAuth(init));
        if (what === 'dispatches') {
          var body = {}; try { body = JSON.parse((init && init.body) || '{}'); } catch (e) {}
          var req = toRequest(wf, body.inputs);
          if (!req) return new Response(null, { status: 204 });                         /* autorun / finder: server pass already runs on a timer */
          return DB.client.from('requests').insert(req).then(function (r) {
            return r.error ? json({ message: r.error.message }, 422) : new Response(null, { status: 204 });
          });
        }
        if (KIND[wf]) {
          return DB.client.from('requests').select('id,status,message,created_at,finished_at').eq('kind', KIND[wf]).order('id', { ascending: false }).limit(10).then(function (r) {
            var runs = (r.data || []).map(function (x) {
              var done = x.status === 'done' || x.status === 'failed';
              return { id: x.id, event: 'workflow_dispatch', status: done ? 'completed' : (x.status === 'running' ? 'in_progress' : 'queued'),
                       conclusion: done ? (x.status === 'done' ? 'success' : 'failure') : null, created_at: x.created_at, updated_at: x.finished_at || x.created_at,
                       html_url: location.href, message: x.message };
            });
            return json({ total_count: runs.length, workflow_runs: runs });
          });
        }
        return realFetch(input, noAuth(init));
      }).catch(function () { return realFetch(input, noAuth(init)); });
    }
    if (/^https:\/\/api\.github\.com\//.test(u) && init && init.headers) return realFetch(input, noAuth(init));
    return realFetch(input, init);
  };

  function chip() {
    var nav = document.querySelector('.site-nav .in'); if (!nav) return;
    var a = nav.querySelector('.acct');
    if (!a) { a = document.createElement('a'); a.className = 'acct'; var br = nav.querySelector('.brand'); br ? br.after(a) : nav.prepend(a); }
    if (DB.user) { a.textContent = (DB.user.email || 'account').split('@')[0]; a.title = 'Signed in as ' + DB.user.email + ' (tap to sign out)'; a.href = '#'; a.onclick = function (e) { e.preventDefault(); if (confirm('Sign out?')) DB.signOut(); }; }
    else { a.textContent = 'Sign in'; a.title = 'Sign in'; a.href = 'login.html'; a.onclick = null; }
  }
  DB.client.auth.onAuthStateChange(function (ev, s) { DB.user = s ? s.user : null; cutP = null; chip(); setTimeout(DB.cutover, 0); });
  function boot() { DB.getUser().then(chip); DB.cutover(); }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
})();
