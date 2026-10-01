
// Top-level module switch: Receivables <-> Secondary Sales.
// Each module keeps its own person picker, because the two datasets use
// different name spellings and cover different staff.
(function () {
  'use strict';

  var MODULES = {
    ar:  { module: 'ar-module',  tabbar: 'ar-tabbar',  picker: 'picker',
           sub: 'Receivables Desk',    asof: true  },
    sec: { module: 'sec-module', tabbar: 'sec-tabbar', picker: 'sec-picker-wrap',
           sub: 'Secondary Sales',     asof: false }
  };

  var brandSub = document.querySelector('.brand-sub');
  var asof = document.querySelector('.asof');
  var arPicker = document.getElementById('picker');

  function show(key) {
    Object.keys(MODULES).forEach(function (k) {
      var m = MODULES[k];
      var on = (k === key);
      document.getElementById(m.module).hidden = !on;
      document.getElementById(m.tabbar).hidden = !on;
      var p = document.getElementById(m.picker);
      // the receivables picker is the bare input; the secondary one is wrapped
      (p.classList.contains('picker') ? p : p.parentNode).hidden = !on;
    });

    // Controls that belong to one module only, e.g. the Secondary Sales month.
    document.querySelectorAll('[data-module-only]').forEach(function (n) {
      n.hidden = n.getAttribute('data-module-only') !== key || !n.dataset.ready;
    });

    var cfg = MODULES[key];
    if (brandSub) brandSub.textContent = cfg.sub;
    if (asof) asof.hidden = !cfg.asof;

    document.querySelectorAll('.section-btn').forEach(function (b) {
      b.setAttribute('aria-selected', String(b.dataset.section === key));
    });

    try { localStorage.setItem('nutaste-module', key); } catch (e) { /* ignore */ }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  document.querySelectorAll('.section-btn').forEach(function (b) {
    b.addEventListener('click', function () { show(b.dataset.section); });
  });

  // The receivables picker sits outside a wrapper, so give it one to toggle.
  if (arPicker && arPicker.parentNode.classList.contains('picker')) {
    arPicker.parentNode.id = arPicker.parentNode.id || 'ar-picker-wrap';
    MODULES.ar.picker = arPicker.parentNode.id;
  }

  var saved = null;
  try { saved = localStorage.getItem('nutaste-module'); } catch (e) { /* ignore */ }
  show(MODULES[saved] ? saved : 'ar');
})();

