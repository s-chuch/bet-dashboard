(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); }, msg = $('msg');
  function say(t, c) { msg.textContent = t; msg.className = c || ''; }
  if (!window.DB || !DB.ready) { document.querySelector('.page-sub').textContent = 'Could not load. Reload the page.'; return; }
  DB.requireLogin().then(function (u) {
    return DB.client.from('profiles').select('display_name,stake_pct,ev_threshold,slip_owner_names,rules').eq('user_id', u.id).maybeSingle().then(function (r) {
      var p = r.data;
      if (!p) { document.querySelector('.page-sub').textContent = 'No profile for this account yet. Ask the owner to set one up.'; return; }
      $('f').hidden = false;
      $('dn').value = p.display_name || ''; $('sp').value = p.stake_pct; $('ev').value = p.ev_threshold;
      $('ow').value = (p.slip_owner_names || []).join(', ');
      if (p.rules && Object.keys(p.rules).length) { $('rules').hidden = false; $('rj').textContent = JSON.stringify(p.rules, null, 1); }
      $('f').addEventListener('submit', function (e) {
        e.preventDefault();
        var sp = parseFloat($('sp').value), ev = parseFloat($('ev').value);
        if (!(sp >= 0.05 && sp <= 5)) return say('Stake must be between 0.05% and 5%.', 'err');
        if (!(ev >= 0 && ev <= 20)) return say('EV must be between 0 and 20.', 'err');
        var names = $('ow').value.split(',').map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 12);
        $('go').disabled = true; say('Saving…');
        DB.client.from('profiles').update({ display_name: $('dn').value.trim().slice(0, 40) || null, stake_pct: sp, ev_threshold: ev, slip_owner_names: names }).eq('user_id', u.id).then(function (w) {
          $('go').disabled = false;
          if (w.error) return say(w.error.message, 'err');
          try { if (names.length) localStorage.setItem('bt.owners', JSON.stringify(names)); } catch (x) {}
          say('Saved.', 'ok');
        });
      });
    });
  });
})();
