(function () {
  'use strict';
  var f = document.getElementById('f'), em = document.getElementById('em'), go = document.getElementById('go'),
      msg = document.getElementById('msg'), who = document.getElementById('who');
  var next = (new URLSearchParams(location.search).get('next') || 'index.html').replace(/[^\w.\-]/g, '') || 'index.html';
  function say(t, c) { msg.textContent = t; msg.className = c || ''; }
  if (!window.DB || !DB.ready) { say('Sign-in could not load. Reload the page.', 'err'); go.disabled = true; return; }
  DB.getUser().then(function (u) {
    if (!u) return;
    f.hidden = true; who.hidden = false;
    who.innerHTML = '<p>Signed in as <b></b>.</p><button id="so" type="button">Sign out</button><a href="index.html">Back to Live</a>';
    who.querySelector('b').textContent = u.email;
    who.querySelector('#so').onclick = function () { DB.signOut().then(function () { location.reload(); }); };
  });
  f.addEventListener('submit', function (e) {
    e.preventDefault(); go.disabled = true; say('Sending…');
    DB.sendLink(em.value.trim(), next).then(function (r) {
      if (r.error) { say(/not allowed|signups|not found/i.test(r.error.message) ? 'That email is not invited yet.' : r.error.message, 'err'); go.disabled = false; return; }
      say('Check your email and tap the link.', 'ok');
    }).catch(function (x) { say(String(x && x.message || x), 'err'); go.disabled = false; });
  });
})();
