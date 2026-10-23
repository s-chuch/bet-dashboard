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

  /* Signed-in visitors get their own private copy of data/stats/log/archive from the `snapshots` table;
     the page code keeps calling fetch('data.json') etc. unchanged. No snapshot yet (or signed out) -> the public file. */
  var realFetch = window.fetch.bind(window), SNAP = /(?:^|\/)(data|stats|log|archive)\.json(?:\?|$)/;
  window.fetch = function (input, init) {
    var u = typeof input === 'string' ? input : (input && input.url) || '';
    var m = SNAP.exec(u.split('#')[0]);
    if (!m || /^[a-z]+:\/\//i.test(u) && u.indexOf(location.origin) !== 0) return realFetch(input, init);
    return DB.getUser().then(function (user) {
      if (!user) return realFetch(input, init);
      return DB.client.from('snapshots').select('payload').eq('kind', m[1]).maybeSingle().then(function (r) {
        if (r.error || !r.data) return realFetch(input, init);
        return new Response(JSON.stringify(r.data.payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
    }).catch(function () { return realFetch(input, init); });
  };

  function chip() {
    var nav = document.querySelector('.site-nav .in'); if (!nav) return;
    var a = nav.querySelector('.acct');
    if (!a) { a = document.createElement('a'); a.className = 'acct'; var br = nav.querySelector('.brand'); br ? br.after(a) : nav.prepend(a); }
    if (DB.user) { a.textContent = (DB.user.email || 'account').split('@')[0]; a.title = 'Signed in as ' + DB.user.email + ' (tap to sign out)'; a.href = '#'; a.onclick = function (e) { e.preventDefault(); if (confirm('Sign out?')) DB.signOut(); }; }
    else { a.textContent = 'Sign in'; a.title = 'Sign in'; a.href = 'login.html'; a.onclick = null; }
  }
  DB.client.auth.onAuthStateChange(function (ev, s) { DB.user = s ? s.user : null; chip(); });
  function boot() { DB.getUser().then(chip); }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
})();
