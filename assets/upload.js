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

  /* ---------- duplicate check (same rule as scripts/add_bets.py: same book + stake, within 3 days, same line numbers, names overlap >= 75%) ---------- */
  var STOP = {to:1,win:1,wins:1,ml:1,moneyline:1,pts:1,points:1,pt:1,sog:1,sot:1,shots:1,shot:1,on:1,goal:1,goals:1,team:1,total:1,the:1,fc:1,and:1,of:1,sgp:1,leg:1,legs:1,vs:1,v:1,at:1,target:1,parlay:1};
  function sig(o) {
    var t = (String(o.event || '') + ' ' + String(o.pick || '')).toLowerCase().match(/[a-z]+|\d+(?:\.\d+)?/g) || [], w = {}, n = {};
    t.forEach(function (x) { if (/^\d/.test(x)) n[x] = 1; else if (!STOP[x] && x.length > 1) w[x] = 1; });
    return { w: Object.keys(w), n: Object.keys(n).sort().join(',') };
  }
  function sameBet(a, b) {
    if (String(a.book).trim().toLowerCase() !== String(b.book).trim().toLowerCase()) return false;
    if (Math.abs((parseFloat(a.stake) || 0) - (parseFloat(b.stake) || 0)) > 0.005) return false;
    var da = Date.parse(a.date), db = Date.parse(b.date); if (isNaN(da) || isNaN(db) || Math.abs(da - db) > 3 * 864e5) return false;
    var x = sig(a), y = sig(b); if (x.n !== y.n || !x.w.length || !y.w.length) return false;
    var hit = x.w.filter(function (k) { return y.w.indexOf(k) >= 0; }).length;
    return hit / Math.min(x.w.length, y.w.length) >= 0.75;
  }
  function loadExisting() {
    fetch('data.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      S.existing = [].concat(d.open || [], d.settled_recent || []).map(function (b) { return { book: b.book, event: b.event, pick: b.pick, stake: b.stake, date: b.date }; });
      renderDrafts();
    }).catch(function () {});
  }
  // a draft is a duplicate of a tracker bet, or of an earlier draft in this upload
  function markDup(dr) {
    var i = S.drafts.indexOf(dr), earlier = i < 0 ? S.drafts : S.drafts.slice(0, i);
    var was = dr.dup;
    dr.dup = S.existing.some(function (e) { return sameBet(dr, e); }) || earlier.some(function (o) { return (o.kind === 'placed' || o.kind === 'open') && sameBet(dr, o); });
    if (dr.dup && !was && (dr.kind === 'placed' || dr.kind === 'open')) dr.on = false;
  }
  function markAllDups() { S.drafts.forEach(markDup); }

  /* ---------- AI reading (Gemini vision, free key) ---------- */
  var AI_KEY = 'bt.ai.gemini', GEM = 'https://generativelanguage.googleapis.com/v1beta/';
  function getAi() { try { return localStorage.getItem(AI_KEY) || ''; } catch (e) { return ''; } }
  function setAi(v) { try { v ? localStorage.setItem(AI_KEY, v) : localStorage.removeItem(AI_KEY); } catch (e) {} S.model = ''; }
  function renderAi() {
    var k = getAi(), el = $('ai');
    if (k) {
      el.innerHTML = '<h3>AI reading</h3><p class="small">On ✓ &nbsp;<span class="muted" id="ai-model"></span> <button class="btn sm" type="button" id="ai-off" style="margin-left:6px">Remove key</button></p>';
      $('ai-off').onclick = function () { setAi(''); renderAi(); };
      if (S.model) $('ai-model').textContent = '(' + S.model + ')';
    } else {
      el.innerHTML = '<h3>AI reading (recommended, free)</h3><p class="small muted">Lets the page read slips as well as Claude or Grok do, so you fill in nothing. Get a free Google AI Studio key (1 minute), paste it once; it stays in this browser.</p>' +
        '<p class="small"><a target="_blank" rel="noopener noreferrer" href="https://aistudio.google.com/apikey">Get a free key ↗</a> · Privacy: on Google’s free tier, the screenshots you upload may be used by Google to improve its products. Crop out balances if that matters to you.</p>' +
        '<div style="display:flex;gap:8px"><input type="text" id="ai-in" placeholder="Paste key (AIza…)" autocomplete="off" autocapitalize="off" spellcheck="false" style="flex:1"><button class="btn pri" type="button" id="ai-save">Save</button></div><p id="ai-err" class="small neg"></p>';
      $('ai-save').onclick = function () {
        var v = $('ai-in').value.trim();
        if (!/^AIza[0-9A-Za-z_-]{30,}$/.test(v)) { $('ai-err').textContent = 'That does not look like a Google AI key (starts with AIza).'; return; }
        setAi(v); renderAi();
      };
    }
  }
  function pickModel(models) {
    var names = (models || []).filter(function (m) { return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0; }).map(function (m) { return String(m.name).replace(/^models\//, ''); })
      .filter(function (n) { return /flash/.test(n) && !/lite|image|tts|live|audio|thinking|exp|preview|8b/.test(n); });
    var prefs = [/^gemini-flash-latest$/, /^gemini-3(\.\d+)?-flash$/, /^gemini-2\.5-flash$/, /^gemini-2\.0-flash$/, /^gemini-1\.5-flash/, /flash/];
    for (var i = 0; i < prefs.length; i++) { var f = names.filter(function (n) { return prefs[i].test(n); }).sort().reverse()[0]; if (f) return f; }
    return '';
  }
  function getModel() {
    if (S.model) return Promise.resolve(S.model);
    return fetch(GEM + 'models?pageSize=200&key=' + encodeURIComponent(getAi()), { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (r) {
      if (!r.ok) throw new Error(r.status === 400 || r.status === 403 ? 'Google rejected the key' : 'Google error ' + r.status);
      return r.json();
    }).then(function (j) { var m = pickModel(j.models); if (!m) throw new Error('no Gemini model available for this key'); S.model = m; var e = $('ai-model'); if (e) e.textContent = '(' + m + ')'; return m; });
  }
  function shrink(file) {   // max 1600 px, JPEG: small enough to send fast, sharp enough to read
    return new Promise(function (res, rej) {
      var img = new Image(), u = URL.createObjectURL(file);
      img.onload = function () {
        var sc = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(u);
        res(c.toDataURL('image/jpeg', 0.88).split(',')[1]);
      };
      img.onerror = function () { URL.revokeObjectURL(u); rej(new Error('could not open the picture')); };
      img.src = u;
    });
  }
  var PROMPT = 'You read screenshots of sports-betting app screens (Caesars, DraftKings, FanDuel, PointsBet, bet365, theScore, Hard Rock, BetMGM ...) for a personal bet tracker. Money is Canadian dollars; ignore currency symbols. ' +
    'Return ONLY JSON: {"bets":[{...}]} with one object per bet visible (a My Bets list can show several). Never invent a value: use "" when it is not visible. Fields: ' +
    'kind ("placed" = receipt / Bet Placed page, "open" = pending bet on a My Bets / Open list, "settled" = shows WON / LOST / Returned / cashed out / void, "other" = not a bet), result ("won"|"lost"|"void"|"" , settled only), ' +
    'book (exactly one of: ' + BOOKS.join(', ') + ' - decide from logos, layout and wording: "CAESARS SPORTSBOOK" = Caesars; "Receipt ... DK63..." with Wager Amount / Total Payout = DraftKings; blue "My Bets" with Opta / TOTAL WAGER / TOTAL PAYOUT / Cash out = FanDuel; red "Betslip ... Receipt #B26" = PointsBet; green "Bet Ref PP..." / "To Return" / BetGuard + Wager/Return = bet365), ' +
    'date (YYYY-MM-DD the bet was placed if a timestamp is visible, else ""), event ("Away @ Home" for NA sports, "Team A v Team B" for soccer), start_et (kickoff text as shown, e.g. "Tue Oct 20 03:00 PM ET" or "Today 3:00 PM"), ' +
    'market (e.g. "SGP 3-leg (30% profit boost)", "Parlay 3-leg", "Moneyline", "Futures"), ' +
    'pick (ALL legs in short form joined by " + ", e.g. "Celtics ML + Jayson Tatum 20+ pts + Cade Cunningham 15+ pts"; "Over 150.5 + Valkyries -3.5"; "NY Jets U26.5 team pts"; "Jakob Chychrun 2+ SOG + Darcy Kuemper 24+ saves"; "Phil Foden 1+ goals"; "Harry Kane 1+ SOT + Harry Kane 3+ shots"; "Jackson Chourio U1.5 TB"; "Junior Caminero 1+ hits"; "Christian McCaffrey anytime TD + Mike Evans 40+ rec yds"; "Cade Cunningham 8+ ast + Payton Pritchard 4+ reb"; "Draw"; use the team nickname for ML, spreads and team totals), ' +
    'price (American odds of the whole bet BEFORE any profit boost, like "+325"; if only the boosted odds are shown use those), boosted_price (American odds AFTER the boost if a boost is shown, else ""; if only payout is shown compute (payout - stake) / stake * 100), ' +
    'stake (cash wagered, number), to_win (profit if it wins = total payout including boost minus stake, number), boost_pct (number or ""), warnings (array of short strings for anything unclear or cut off). ' +
    'Ignore account balances, bonus-offer banners and ads. For a settled slip fill the same fields and the result.';
  function aiRead(it) {
    var tries = 0;
    function go(model, b64) {
      tries++;
      var body = { contents: [{ parts: [{ text: PROMPT + ' Today is ' + todayET() + ' (America/Toronto).' }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } };
      return fetch(GEM + 'models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(getAi()), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (r) {
        if (r.status === 429 && tries < 4) { it.msg = 'Waiting for Google’s free-tier limit…'; renderQueue(); return new Promise(function (ok) { setTimeout(ok, 15000 * tries); }).then(function () { return go(model, b64); }); }
        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error((j.error && j.error.message ? j.error.message : 'HTTP ' + r.status).slice(0, 160)); });
        return r.json();
      });
    }
    return getModel().then(function (m) { return shrink(it.file).then(function (b64) { return go(m, b64); }); }).then(function (j) {
      var t = ((((j.candidates || [])[0] || {}).content || {}).parts || []).map(function (x) { return x.text || ''; }).join('');
      t = t.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
      var o = JSON.parse(t), arr = Array.isArray(o) ? o : (o.bets || []);
      if (!arr.length) throw new Error('the AI found no bet on this picture');
      return arr;
    });
  }
  function fromAi(r) {
    var num = function (x) { if (x === '' || x == null) return null; var n = parseFloat(String(x).replace(/[^0-9.]/g, '')); return isFinite(n) ? n : null; };
    var odds = function (x) { var m = String(x || '').replace(/[−–]/g, '-').match(/^\s*([+-]?)\s*(\d{2,5})\s*$/); return m ? (m[1] || '+') + m[2] : ''; };
    var kind = ['placed', 'open', 'settled', 'other'].indexOf(r.kind) >= 0 ? r.kind : 'placed';
    return { kind: kind, book: BOOKS.indexOf(r.book) >= 0 ? r.book : '', date: /^20\d\d-\d\d-\d\d$/.test(r.date || '') ? r.date : '', event: String(r.event || ''), start_text: String(r.start_et || ''), market: String(r.market || ''), pick: String(r.pick || ''),
      price: odds(r.price), boosted_price: odds(r.boosted_price), stake: num(r.stake), to_win: num(r.to_win), result: r.result || '', warnings: Array.isArray(r.warnings) ? r.warnings.map(String).slice(0, 5) : [] };
  }

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
  function ocrRead(it, why) {
    S.progress = function (m) { if (m && typeof m.progress === 'number') { it.pct = Math.round(m.progress * 100); it.msg = m.status; renderQueue(); } };
    return getWorker().then(function (w) { return w.recognize(it.file); }).then(function (r) {
      it.text = (r && r.data && r.data.text) || '';
      addDraftFrom(it, why);
    });
  }
  function runQueue() {
    if (S.busy) return;
    var it = S.items.filter(function (x) { return x.state === 'wait'; })[0];
    if (!it) { return; }
    S.busy = true; it.state = 'read'; it.msg = ''; renderQueue();
    var job = getAi() ? aiRead(it).then(function (rows) {
      rows.forEach(function (r) { addDraftParsed(it.name, fromAi(r), 'Read by AI', ''); });
    }).catch(function (e) { it.msg = ''; return ocrRead(it, 'AI reading failed (' + (e && e.message ? e.message : e) + '), so the basic reader was used. Check every field.'); })
      : ocrRead(it, getAi() ? '' : 'Basic reader (no AI key). Add a free key above for full automatic reading.');
    job.then(function () { it.state = 'done'; it.pct = 100; }).catch(function (e) { it.state = 'err'; it.msg = 'Could not read this picture (' + (e && e.message ? e.message : e) + ')'; })
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
  function addDraftFrom(it, why) {
    var p = {};
    if (typeof SlipParse === 'undefined') p = { kind: 'placed', warnings: ['Automatic field filling is not available: fill the fields from the text at the bottom of this card.'] };
    else try { p = SlipParse.parseSlip(it.text) || {}; } catch (e) { p = { kind: 'placed', warnings: ['Could not fill the fields automatically (' + e.message + '). Fill them from the text at the bottom of this card.'] }; }
    if (!p.date) p.date = slipDate(it.text);
    addDraftParsed(it.name, p, why || '', it.text);
  }
  function addDraftParsed(name, p, note, text) {
    var date = p.date || todayET();
    var dr = {
      id: S.nextId++, file: name, kind: p.kind || 'other', on: p.kind === 'placed' || p.kind === 'open',
      book: p.book || '', date: date, event: p.event || '', start: normStart(p.start_text, date), market: p.market || '', pick: p.pick || '',
      price: p.price || '', boosted: p.boosted_price || '', stake: p.stake != null ? String(p.stake) : '', to_win: p.to_win != null ? String(p.to_win) : '',
      warnings: (p.warnings || []).slice(), result: p.result || '', text: text || '', dup: false, note: note || ''
    };
    if (note && /^AI reading failed|^Basic reader/.test(note)) dr.warnings.unshift(note);
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
      return { date: d.date, book: d.book, event: d.event.trim(), start_et: d.start.trim(), market: d.market.trim(), pick: d.pick.trim(), price: d.price.trim(), boosted_price: d.boosted.trim(), stake: d.stake.trim(), to_win: d.to_win.trim(), force: d.dup ? '1' : '' };
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
    S.drafts.forEach(function (d) { if (!d._seen) { d._seen = 1; markDup(d); } });
    $('review').hidden = !S.drafts.length;
    $('rows').innerHTML = S.drafts.map(function (d) {
      var tag = d.kind === 'settled' ? '<span class="tag bad">settled</span>' : d.kind === 'other' ? '<span class="tag bad">not a slip</span>' : d.dup ? '<span class="tag warn">looks like a duplicate' + (d.on ? ' — will be added anyway' : ' — skipped') + '</span>' : (d.warnings.length ? '<span class="tag warn">check</span>' : '<span class="tag ok">' + (d.note === 'Read by AI' ? 'AI read ✓' : 'looks good') + '</span>');
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

  renderGh(); renderAi(); loadExisting(); updateSend();
})();
