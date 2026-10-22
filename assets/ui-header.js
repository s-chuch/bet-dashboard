/* ui-header: compact summary bar, balances drawer, a11y. Registers via window.LiveUI. */
(function () {
  'use strict';
  var KEY = 'bt.ui.bal';
  function lsGet() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function lsSet(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
  function fmt(n) {
    try { if (typeof money === 'function') return money(n); } catch (e) {}
    return n == null ? '' : '$' + Number(n).toFixed(2);
  }
  function setAttr(el, k, v) { if (el.getAttribute(k) !== v) el.setAttribute(k, v); }

  var lastTotal = null;
  function syncBtn(btn, bal) {
    var open = !bal.classList.contains('bal-collapsed');
    var html = 'Balances' + (lastTotal != null ? ' · <b>' + fmt(lastTotal) + '</b>' : '') + '<span aria-hidden="true">' + (open ? ' ▴' : ' ▾') + '</span>';
    if (btn.getAttribute('data-h') !== html) { btn.innerHTML = html; btn.setAttribute('data-h', html); }
    setAttr(btn, 'aria-expanded', open ? 'true' : 'false');
  }

  function balances(ctx) {
    var bal = document.getElementById('bal');
    if (!bal) return;
    if (ctx && ctx.DATA) lastTotal = ctx.DATA.total;
    var btn = document.getElementById('balToggle');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button'; btn.id = 'balToggle'; btn.className = 'bal-toggle';
      btn.setAttribute('aria-controls', 'bal');
      bal.parentNode.insertBefore(btn, bal);
      if (lsGet() !== '1') bal.classList.add('bal-collapsed');
      btn.addEventListener('click', function () {
        var shut = bal.classList.toggle('bal-collapsed');
        lsSet(shut ? '0' : '1');
        syncBtn(btn, bal);
      });
    }
    syncBtn(btn, bal);
  }

  function syncRows() {
    var rows = document.querySelectorAll('.crow');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], card = r.closest('.card');
      setAttr(r, 'role', 'button'); setAttr(r, 'tabindex', '0');
      setAttr(r, 'aria-expanded', card && card.classList.contains('open') ? 'true' : 'false');
    }
    var heads = document.querySelectorAll('.sechead');
    for (var j = 0; j < heads.length; j++) {
      var h = heads[j], sec = h.closest('.sec'), exp = true;
      if (sec) exp = sec.classList.contains('fold') ? !sec.classList.contains('shut') : sec.classList.contains('open');
      setAttr(h, 'role', 'button'); setAttr(h, 'tabindex', '0');
      setAttr(h, 'aria-expanded', exp ? 'true' : 'false');
    }
  }

  function live() {
    ['meta', 'livepl'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      setAttr(el, 'aria-live', 'polite'); setAttr(el, 'aria-atomic', 'true');
    });
    var rf = document.getElementById('refresh');
    if (rf && !rf.getAttribute('aria-label')) rf.setAttribute('aria-label', 'Refresh now');
  }

  if (!window.__uiHeaderKeys) {
    window.__uiHeaderKeys = true;
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var t = e.target;
      if (!t || !t.matches || !t.matches('.crow,.sechead')) return;
      e.preventDefault();
      t.click();
    });
    document.addEventListener('click', function () { setTimeout(syncRows, 0); });
  }

  window.LiveUI = window.LiveUI || { afterRender: [] };
  (window.LiveUI.afterRender = window.LiveUI.afterRender || []).push(function (ctx) {
    balances(ctx); syncRows(); live();
  });
})();
