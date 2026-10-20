/* Upload bets: screenshots -> OCR in the browser (Tesseract.js, self-hosted) -> editable draft rows -> add-bets workflow.
   The images never leave the phone. Only the rows you confirm are sent (as a workflow_dispatch input). */
(function () {
  'use strict';
  var REPO_API = 'https://api.github.com/repos/s-chuch/bet-dashboard';
  var TOKEN_KEY = 'bt.gh.settle';
  var BOOKS = ['DraftKings', 'FanDuel', 'Caesars', 'PointsBet', 'bet365', 'theScore', 'Hard Rock', 'BetMGM', 'BetRivers', 'Bet99', '888sport', 'Betway', 'LeoVegas', 'Sports Interaction', 'Pinnacle', 'Proline', 'Bally Bet', 'NorthStar Bets'];
  var ODDS_RE = /^[+-][0-9]{2,5}$/, MONEY_RE = /^[0-9]{1,6}(\.[0-9]{1,2})?$/, DATE_RE = /^20[0-9]{2}-[01][0-9]-[0-3][0-9]$/;
  var MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var S = { items: [], drafts: [], worker: null, workerP: null, busy: false, existing: [], sending: false, nextId: 1 };

  function getTok() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setTok(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
  function todayET() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /* ---------- GitHub connection card ---------- */
  function renderGh() {
    var t = getTok(), el = $('gh');
    if (t) {
      el.innerHTML = '<h3>GitHub</h3><p class="small">Connected ✓ &nbsp;<button class="btn sm" type="button" id="gh-forget" style="margin-left:6px">Forget token</button></p>';
      $('gh-forget').onclick = function () { setTok(''); renderGh(); };
    } else {
      el.innerHTML = '<h3>Connect GitHub (once)</h3><p class="small muted">Adding bets runs a GitHub workflow, which needs your token (the same one the Logs page uses). It stays in this browser only.</p>' +
        '<p class="small"><a target="_blank" rel="noopener noreferrer" href="https://github.com/settings/personal-access-tokens/new?name=bet-tracker&amp;description=Bet+tracker+page%3A+settle+bets%2C+add+bets+and+read+Actions+runs&amp;target_name=s-chuch&amp;expires_in=90&amp;actions=write&amp;metadata=read">Open GitHub token page ↗</a> · Only select repositories → s-chuch/bet-dashboard · Actions: Read and write.</p>' +
        '<div class="f-row" style="display:flex;gap:8px"><input type="text" id="gh-in" placeholder="Paste token (github_pat_…)" autocomplete="off" autocapitalize="off" spellcheck="false" style="flex:1"><button class="btn pri" type="button" id="gh-save">Save</button></div><p id="gh-err" class="small neg"></p>';
      $('gh-save').onclick = function () {
        var v = $('gh-in').value.trim();
        if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(v)) { $('gh-err').textContent = 'That does not look like a GitHub token.'; return; }
        setTok(v); renderGh(); updateSend();
      };
    }
  }

  /* ---------- existing bets (duplicate check) ---------- */
  function dupKey(book, event, pick, stake) {
    var n = function (s) { return String(s || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]/g, ''); };
    return [String(book || '').trim().toLowerCase(), n(event), n(pick), (parseFloat(stake) || 0).toFixed(2)].join('|');
  }
  function loadExisting() {
    fetch('data.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      var rows = [].concat(d.open || [], d.settled_recent || []);
      S.existing = rows.map(function (b) { return dupKey(b.book, b.event, b.pick, b.stake); });
      S.drafts.forEach(markDup); renderDrafts();
    }).catch(function () {});
  }
  function markDup(dr) { dr.dup = S.existing.indexOf(dupKey(dr.book, dr.event, dr.pick, dr.stake)) >= 0; if (dr.dup && dr.kind === 'placed') dr.on = false; }

  /* ---------- OCR ---------- */
  function getWorker(onProgress) {
    if (S.workerP) return S.workerP;
    var base = 'assets/vendor/tesseract';
    S.workerP = Tesseract.createWorker('eng', 1, {
      workerPath: base + '/worker.min.js', corePath: base, langPath: base, gzip: true, workerBlobURL: false,
      logger: function (m) { if (S.progress) S.progress(m); }
    }).then(function (w) { S.worker = w; return w; });
    return S.workerP;
  }
  function runQueue() {
    if (S.busy) return;
    var it = S.items.filter(function (x) { return x.state === 'wait'; })[0];
    if (!it) { return; }
    S.busy = true; it.state = 'read'; renderQueue();
    S.progress = function (m) { if (m && typeof m.progress === 'number') { it.pct = Math.round(m.progress * 100); it.msg = m.status; renderQueue(); } };
    getWorker().then(function (w) { return w.recognize(it.file); }).then(function (r) {
      it.text = (r && r.data && r.data.text) || '';
      it.state = 'done'; it.pct = 100;
      addDraftFrom(it);
    }).catch(function (e) { it.state = 'err'; it.msg = 'Could not read this picture (' + (e && e.message ? e.message : e) + ')'; })
      .then(function () { S.busy = false; renderQueue(); renderDrafts(); runQueue(); });
  }

  /* ---------- parse -> draft ---------- */
  function slipDate(text) {
    var m = String(text).match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d\d)\b/i);
    if (!m) return '';
    var mo = MON[m[1].toLowerCase()], d = parseInt(m[2], 10);
    return m[3] + '-' + pad(mo + 1) + '-' + pad(d);
  }
  // "Today 3:00 PM" / "OCT 25 1PM" / "Mon Oct 19 07:10 PM ET" -> "Mon Oct 19 07:10 PM ET" (weekday from the date)
  function normStart(txt, dateStr) {
    var t = String(txt || '').trim(); if (!t) return '';
    var base = DATE_RE.test(dateStr) ? new Date(dateStr + 'T12:00:00Z') : new Date();
    var m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i); if (!m) return t;
    var hh = parseInt(m[1], 10), mm = m[2] ? parseInt(m[2], 10) : 0, ap = m[3].toUpperCase(), day = null;
    var md = t.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\b/i);
    if (md) { day = new Date(Date.UTC(base.getUTCFullYear(), MON[md[1].toLowerCase()], parseInt(md[2], 10), 12)); if (day < base - 200 * 864e5) day.setUTCFullYear(day.getUTCFullYear() + 1); }
    else if (/tomorrow/i.test(t)) day = new Date(base.getTime() + 864e5);
    else if (/today|tonight/i.test(t)) day = base;
    if (!day) return t;
    return DOW[day.getUTCDay()] + ' ' + MN[day.getUTCMonth()] + ' ' + day.getUTCDate() + ' ' + pad(hh) + ':' + pad(mm) + ' ' + ap + ' ET';
  }
  function addDraftFrom(it) {
    var p = {};
    if (typeof SlipParse === 'undefined') p = { kind: 'placed', warnings: ['Automatic field filling is not available: fill the fields from the text at the bottom of this card.'] };
    else try { p = SlipParse.parseSlip(it.text) || {}; } catch (e) { p = { kind: 'placed', warnings: ['Could not fill the fields automatically (' + e.message + '). Fill them from the text at the bottom of this card.'] }; }
    var date = slipDate(it.text) || todayET();
    var dr = {
      id: S.nextId++, file: it.name, kind: p.kind || 'other', on: p.kind === 'placed' || p.kind === 'open',
      book: p.book || '', date: date, event: p.event || '', start: normStart(p.start_text, date), market: p.market || '', pick: p.pick || '',
      price: p.price || '', boosted: p.boosted_price || '', stake: p.stake != null ? String(p.stake) : '', to_win: p.to_win != null ? String(p.to_win) : '',
      warnings: (p.warnings || []).slice(), result: p.result || '', text: it.text, dup: false
    };
    if (dr.kind === 'settled') dr.warnings.unshift('This slip is already settled (' + (dr.result || 'result shown') + '). Settled bets are not added here.');
    if (dr.kind === 'other') dr.warnings.unshift('This does not look like a bet slip.');
    markDup(dr); S.drafts.push(dr);
  }

  /* ---------- validation + send ---------- */
  function problems(d) {
    var bad = {};
    if (BOOKS.indexOf(d.book) < 0) bad.book = 1;
    if (!DATE_RE.test(d.date)) bad.date = 1;
    if (!d.event.trim()) bad.event = 1;
    if (!d.pick.trim()) bad.pick = 1;
    if (!ODDS_RE.test(d.price.trim())) bad.price = 1;
    if (d.boosted.trim() && !ODDS_RE.test(d.boosted.trim())) bad.boosted = 1;
    var st = parseFloat(d.stake);
    if (!MONEY_RE.test(d.stake.trim()) || !(st > 0 && st <= 500)) bad.stake = 1;
    if (!MONEY_RE.test(d.to_win.trim())) bad.to_win = 1;
    return bad;
  }
  function updateSend() {
    var on = S.drafts.filter(function (d) { return d.on; }), ok = on.length && on.every(function (d) { return !Object.keys(problems(d)).length; });
    var b = $('send'); if (!b) return;
    b.disabled = !ok || S.sending || !getTok();
    b.textContent = on.length ? 'Add ' + on.length + ' bet' + (on.length === 1 ? '' : 's') + ' to tracker' : 'Add to tracker';
    if (!S.sending && !$('sendmsg').dataset.keep) $('sendmsg').textContent = !getTok() ? 'Connect GitHub above first.' : (on.length && !ok ? 'Fix the red fields first.' : '');
  }
  function send() {
    var on = S.drafts.filter(function (d) { return d.on; });
    if (!on.length || S.sending) return;
    var rows = on.map(function (d) {
      return { date: d.date, book: d.book, event: d.event.trim(), start_et: d.start.trim(), market: d.market.trim(), pick: d.pick.trim(), price: d.price.trim(), boosted_price: d.boosted.trim(), stake: d.stake.trim(), to_win: d.to_win.trim() };
    });
    var body = JSON.stringify({ ref: 'main', inputs: { bets: JSON.stringify(rows) } });
    if (body.length > 60000) { $('sendmsg').textContent = 'Too many bets for one send. Send fewer at a time.'; return; }
    S.sending = true; $('sendmsg').dataset.keep = '1'; $('sendmsg').textContent = 'Sending…'; updateSend();
    var t0 = Date.now();
    fetch(REPO_API + '/actions/workflows/add-bets.yml/dispatches', { method: 'POST', headers: { 'Authorization': 'Bearer ' + getTok(), 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' }, body: body, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
      .then(function (r) {
        if (r.status === 204) { $('sendmsg').textContent = 'Sent ' + rows.length + '. GitHub is adding them (about a minute)…'; poll(t0, rows.length); return; }
        return r.json().catch(function () { return {}; }).then(function (j) {
          var m = r.status === 401 ? 'GitHub rejected the token. Forget it above and paste a new one.' : r.status === 403 ? 'Not allowed: the token needs Actions: Read and write on s-chuch/bet-dashboard (or GitHub rate limit).' : r.status === 404 ? 'GitHub could not find the add-bets workflow, or the token has no access to the repo.' : (j && j.message) || ('HTTP ' + r.status);
          fail(m);
        });
      }).catch(function () { fail('Network error. Nothing was sent.'); });
  }
  function fail(m) { S.sending = false; delete $('sendmsg').dataset.keep; updateSend(); $('sendmsg').textContent = m; $('sendmsg').dataset.keep = '1'; }
  function poll(t0, n) {
    var tries = 0;
    (function tick() {
      tries++;
      fetch(REPO_API + '/actions/workflows/add-bets.yml/runs?per_page=3&event=workflow_dispatch', { headers: { 'Authorization': 'Bearer ' + getTok(), 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
        .then(function (r) { return r.ok ? r.json() : { workflow_runs: [] }; })
        .then(function (j) {
          var run = (j.workflow_runs || []).filter(function (x) { return Date.parse(x.created_at) >= t0 - 15000; })[0];
          if (run && run.status === 'completed') {
            S.sending = false; delete $('sendmsg').dataset.keep;
            if (run.conclusion === 'success') {
              $('sendmsg').innerHTML = 'Added ✓ The Live page shows them within a minute or two. <a href="index.html">Open Live</a>';
              S.drafts = S.drafts.filter(function (d) { return !d.on; }); S.items = S.items.filter(function (x) { return x.state !== 'done'; });
              renderQueue(); renderDrafts(true);
            } else { $('sendmsg').innerHTML = 'GitHub could not add them (' + esc(run.conclusion) + '). <a target="_blank" rel="noopener noreferrer" href="' + esc(run.html_url) + '">See the run ↗</a>'; updateSend(); $('sendmsg').dataset.keep = ''; delete $('sendmsg').dataset.keep; }
            return;
          }
          if (tries > 40) { S.sending = false; delete $('sendmsg').dataset.keep; $('sendmsg').textContent = 'Still running. Check the Auto-runs tab on the Logs page in a minute.'; updateSend(); return; }
          setTimeout(tick, 4000);
        }).catch(function () { setTimeout(tick, 5000); });
    })();
  }

  /* ---------- rendering ---------- */
  function renderQueue() {
    $('queue').innerHTML = S.items.map(function (it) {
      var st = it.state === 'wait' ? 'Waiting…' : it.state === 'read' ? ('Reading… ' + (it.pct || 0) + '%') : it.state === 'done' ? 'Read ✓' : esc(it.msg || 'Failed');
      return '<div class="qi"><img alt="" src="' + esc(it.url) + '"><div><div class="nm">' + esc(it.name) + '</div><div class="st">' + st + '</div>' + (it.state === 'read' ? '<div class="bar"><i style="width:' + (it.pct || 0) + '%"></i></div>' : '') + '</div><button class="btn sm x" type="button" data-rm="' + it.id + '">Remove</button></div>';
    }).join('');
  }
  function fld(d, k, label, cls, type) {
    var bad = problems(d)[k] ? ' bad' : '';
    if (k === 'book') {
      return '<label class="fld' + bad + ' ' + (cls || '') + '"><span>' + label + '</span><select data-d="' + d.id + '" data-k="book"><option value="">Choose…</option>' + BOOKS.map(function (b) { return '<option' + (b === d.book ? ' selected' : '') + '>' + esc(b) + '</option>'; }).join('') + '</select></label>';
    }
    return '<label class="fld' + bad + ' ' + (cls || '') + '"><span>' + label + '</span><input type="text" data-d="' + d.id + '" data-k="' + k + '" value="' + esc(d[k]) + '" autocomplete="off" autocapitalize="off" spellcheck="false"' + (type === 'num' ? ' inputmode="decimal"' : '') + '></label>';
  }
  function renderDrafts(keepMsg) {
    $('review').hidden = !S.drafts.length;
    $('rows').innerHTML = S.drafts.map(function (d) {
      var tag = d.kind === 'settled' ? '<span class="tag bad">settled</span>' : d.kind === 'other' ? '<span class="tag bad">not a slip</span>' : d.dup ? '<span class="tag warn">already in tracker</span>' : (d.warnings.length ? '<span class="tag warn">check</span>' : '<span class="tag ok">looks good</span>');
      var form = (d.kind === 'placed' || d.kind === 'open') ? '<div class="grid">' + fld(d, 'book', 'Book') + fld(d, 'date', 'Date placed', '', '') + fld(d, 'stake', 'Stake', '', 'num') + fld(d, 'to_win', 'To win', '', 'num') +
        fld(d, 'event', 'Event', 'full') + fld(d, 'pick', 'Pick (legs joined by +)', 'full') + fld(d, 'market', 'Market', 'half') + fld(d, 'start', 'Start (ET)', 'half') + fld(d, 'price', 'Odds', '', '') + fld(d, 'boosted', 'Boosted odds', '', '') + '</div>' : '';
      var w = d.warnings.length ? '<ul class="warns">' + d.warnings.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '';
      var raw = '<details class="small muted" style="margin-top:8px"><summary>What the reader saw</summary><pre style="white-space:pre-wrap;font-size:11px;margin:6px 0 0">' + esc(d.text) + '</pre></details>';
      return '<div class="draft' + (d.on ? '' : ' skip') + '" data-id="' + d.id + '"><div class="hd"><label><input type="checkbox" data-on="' + d.id + '"' + (d.on ? ' checked' : '') + (d.kind === 'placed' || d.kind === 'open' ? '' : ' disabled') + '> ' + esc(d.file) + '</label>' + tag + '</div>' + form + w + raw + '</div>';
    }).join('');
    if (!keepMsg) { var m = $('sendmsg'); if (m && !m.dataset.keep) m.textContent = ''; }
    updateSend();
  }

  /* ---------- events ---------- */
  function addFiles(list) {
    Array.prototype.forEach.call(list || [], function (f) {
      if (!/^image\//.test(f.type) && !/\.(png|jpe?g|webp|heic)$/i.test(f.name)) return;
      if (f.size > 25 * 1024 * 1024) return;
      S.items.push({ id: S.nextId++, file: f, name: f.name || 'screenshot', url: URL.createObjectURL(f), state: 'wait', pct: 0 });
    });
    renderQueue(); runQueue();
  }
  $('files').addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });
  var drop = $('drop');
  ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
  drop.addEventListener('drop', function (e) { addFiles(e.dataTransfer && e.dataTransfer.files); });
  $('queue').addEventListener('click', function (e) {
    var id = e.target && e.target.getAttribute && e.target.getAttribute('data-rm'); if (!id) return;
    var it = S.items.filter(function (x) { return String(x.id) === id; })[0]; if (!it || it.state === 'read') return;
    try { URL.revokeObjectURL(it.url); } catch (x) {}
    S.items = S.items.filter(function (x) { return x !== it; }); S.drafts = S.drafts.filter(function (d) { return d.file !== it.name; });
    renderQueue(); renderDrafts();
  });
  $('rows').addEventListener('input', function (e) {
    var t = e.target, id = t.getAttribute('data-d'), k = t.getAttribute('data-k'); if (!id || !k) return;
    var d = S.drafts.filter(function (x) { return String(x.id) === id; })[0]; if (!d) return;
    if (!S.sending) delete $('sendmsg').dataset.keep;
    d[k] = t.value; markDup(d);
    var fl = t.closest('.fld'); if (fl) fl.classList.toggle('bad', !!problems(d)[k]);
    updateSend();
  });
  $('rows').addEventListener('change', function (e) {
    var t = e.target, on = t.getAttribute('data-on');
    if (on) { var d = S.drafts.filter(function (x) { return String(x.id) === on; })[0]; if (d) { d.on = t.checked; var c = t.closest('.draft'); if (c) c.classList.toggle('skip', !d.on); updateSend(); } return; }
    if (t.getAttribute('data-k') === 'book') { var id = t.getAttribute('data-d'), dd = S.drafts.filter(function (x) { return String(x.id) === id; })[0]; if (dd) { dd.book = t.value; markDup(dd); renderDrafts(true); } }
  });
  $('send').addEventListener('click', send);

  renderGh(); loadExisting(); updateSend();
})();
