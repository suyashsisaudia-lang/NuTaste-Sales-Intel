
// Brand layer: product photography and the showpiece pieces built from it —
// the intro splash, the rotating product banner above every view, the product
// card fan on the welcome screen, the "NuTaste range" gallery and, on the
// sign-in page, the moving wall of products.
//
// Decoration only. It reads the page (which module and tab are open, whose
// name is picked) but never touches data, and each piece is skipped quietly if
// its container is missing from the page.
(function () {
  'use strict';

  var BASE = '/static/brand/products/';
  // `pos` is the object-position that keeps the pack in frame when a square
  // photo is cropped into a wide banner.
  var PRODUCTS = [
    { id: 'creamy-vanilla', name: 'Creamy Vanilla', tag: 'Frappe · Cold Coffee',       pos: '58% 55%' },
    { id: 'choco-brownie',  name: 'Choco Brownie',  tag: 'Gourmet Baking Premix',      pos: '66% 50%' },
    { id: 'cookie',         name: 'Cookie',         tag: 'Topping · Inclusion',        pos: '42% 55%' },
    { id: 'syrups',         name: 'Watermelon & Mint Mojito', tag: 'Beverage Syrups',  pos: '50% 50%' },
    { id: 'lime',           name: 'Lime',           tag: 'Sprinkler · Beverage',       pos: '30% 55%' },
    { id: 'numax',          name: 'Numax',          tag: 'Pre-marinade',               pos: '32% 60%' },
    { id: 'premium-aromat', name: 'Premium Aromat', tag: 'Flavour Enhancer · Cooking', pos: '35% 45%' },
    { id: 'spring-showcase',name: 'The NuTaste range', tag: 'Spring showcase',         pos: '50% 45%' }
  ];
  PRODUCTS.forEach(function (p) { p.img = BASE + p.id + '.jpg'; p.sm = BASE + p.id + '-sm.jpg'; });
  var byId = {};
  PRODUCTS.forEach(function (p) { byId[p.id] = p; });

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function img(src, alt, lazy) {
    var i = el('img');
    i.src = src; i.alt = alt || ''; i.decoding = 'async';
    if (lazy) i.loading = 'lazy';
    return i;
  }

  window.NT = { products: PRODUCTS };

  // ---------------------------------------------------------------- splash
  // Shown once per browser session; the inline script in <head> decides.
  var root = document.documentElement;
  var splash = document.getElementById('splash');
  if (splash && root.classList.contains('splash-on')) {
    try { sessionStorage.setItem('nt-splash', '1'); } catch (e) { /* ignore */ }
    var closeSplash = function () {
      if (splash.classList.contains('out')) return;
      splash.classList.add('out');
      setTimeout(function () { root.classList.remove('splash-on'); }, 950);
    };
    splash.addEventListener('click', closeSplash);
    setTimeout(closeSplash, 1900);
  }

  // ------------------------------------------------------- button → focus
  document.querySelectorAll('[data-focus]').forEach(function (b) {
    b.addEventListener('click', function () {
      var t = document.getElementById(b.getAttribute('data-focus'));
      if (t) { window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }); t.focus(); }
    });
  });

  // ------------------------------------------------------- 3D tilt on fans
  document.querySelectorAll('.fan').forEach(function (fan) {
    fan.addEventListener('pointermove', function (e) {
      var r = fan.getBoundingClientRect();
      fan.style.setProperty('--tx', ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
      fan.style.setProperty('--ty', ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
    });
    fan.addEventListener('pointerleave', function () {
      fan.style.setProperty('--tx', 0); fan.style.setProperty('--ty', 0);
    });
  });

  // ------------------------------------------------------- product banner
  var hero = document.getElementById('hero-strip');
  if (hero) buildHero(hero);

  function buildHero(hero) {
    var media = hero.querySelector('.hs-media');
    var dotsBox = hero.querySelector('.hs-dots');
    var pTag = hero.querySelector('.hs-p-tag'), pName = hero.querySelector('.hs-p-name');
    var product = hero.querySelector('.hs-product');
    var slides = [], dots = [], at = -1, timer = null;

    PRODUCTS.forEach(function (p, i) {
      var s = el('div', 'hs-slide');
      // The two lead photos (one per module) load at once; the rest follow
      // after page load, and any slide fetches its photo the moment it shows.
      var im = el('img');
      im.alt = ''; im.decoding = 'async';
      im.setAttribute('data-src', p.img);
      if (i === 0 || i === 4) im.src = p.img;
      im.style.objectPosition = p.pos;
      // Each slide drifts a slightly different way.
      s.style.setProperty('--kx', ((i % 3) - 1) * 2 + '%');
      s.style.setProperty('--ky', ((i % 2) ? -1.5 : 1.5) + '%');
      s.appendChild(im);
      media.appendChild(s);
      slides.push(s);

      var d = el('button', 'hs-dot');
      d.type = 'button';
      d.setAttribute('aria-label', 'Show ' + p.name);
      d.addEventListener('click', function () { go(i); restart(); });
      dotsBox.appendChild(d);
      dots.push(d);
    });

    function go(i) {
      if (i === at) return;
      if (at >= 0) { slides[at].classList.remove('on'); dots[at].classList.remove('on'); }
      at = (i + slides.length) % slides.length;
      loadSlide(at);
      loadSlide((at + 1) % slides.length);
      slides[at].classList.add('on');
      dots[at].classList.add('on');
      var p = PRODUCTS[at];
      product.classList.remove('swap');
      void product.offsetWidth;                // restart the label animation
      pTag.textContent = p.tag;
      pName.textContent = p.name;
      product.classList.add('swap');
    }
    function loadSlide(k) {
      var im = slides[k].querySelector('img');
      if (!im.getAttribute('src')) im.src = im.getAttribute('data-src');
    }
    window.addEventListener('load', function () {
      setTimeout(function () { slides.forEach(function (s, k) { loadSlide(k); }); }, 400);
    });
    function restart() {
      if (reduce) return;
      clearInterval(timer);
      timer = setInterval(function () { if (!document.hidden) go(at + 1); }, 5200);
    }
    // Each module opens on its own lead product.
    go(0);
    restart();

    // ---- copy: greeting, whose book, which view
    var modLabel = hero.querySelector('#hs-module'), dateEl = hero.querySelector('#hs-date');
    var greetEl = hero.querySelector('#hs-greet'), nameEl = hero.querySelector('#hs-name');
    var subEl = hero.querySelector('#hs-sub');

    var SUBS = {
      ar:  { overview: 'Your receivables at a glance — balance, ageing and top customers.',
             report:   'Every open invoice, line by line, grouped by customer.',
             ask:      'Ask a question about your book in plain English.' },
      sec: { overview: 'Visits, demos, leads and secondary sales for the month.',
             activity: 'Every visit and activity, day by day.',
             ask:      'Ask a question about your month in plain English.' }
    };
    var LEAD = { ar: 0, sec: 4 };
    var lastMod = null, lastName = null;

    function greeting() {
      var h = new Date().getHours();
      return h < 12 ? 'Good morning' : (h < 17 ? 'Good afternoon' : 'Good evening');
    }
    function update() {
      var mod = document.getElementById('sec-module') && !document.getElementById('sec-module').hidden ? 'sec' : 'ar';
      var tabbar = document.getElementById(mod === 'sec' ? 'sec-tabbar' : 'ar-tabbar');
      var tab = tabbar && tabbar.querySelector('[aria-selected="true"]');
      var view = tab ? tab.getAttribute('data-view') : 'overview';
      var views = document.getElementById(mod === 'sec' ? 'sec-views' : 'views');
      var input = document.getElementById(mod === 'sec' ? 'sec-picker' : 'picker');
      var name = views && !views.hidden && input ? input.value.trim() : '';

      modLabel.textContent = mod === 'sec' ? 'Secondary Sales' : 'Receivables Desk';
      if (mod === 'sec') {
        var sel = document.getElementById('sec-month');
        dateEl.textContent = sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].text.replace(/\s*\(.*\)$/, '') : '';
      } else {
        var asof = document.getElementById('asof-date');
        dateEl.textContent = asof && asof.textContent !== '—' ? 'as at ' + asof.textContent : '';
      }
      dateEl.previousElementSibling.hidden = !dateEl.textContent;

      subEl.textContent = name ? (SUBS[mod][view] || SUBS[mod].overview)
        : 'Search your name above to open your ' + (mod === 'sec' ? 'month.' : 'book.');

      var first = name ? name.split(/\s+/)[0] : '';
      first = first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : '';
      if (first !== lastName) {
        greetEl.textContent = greeting() + (first ? ',' : '.');
        splitRise(nameEl, first ? first + '.' : '');
        lastName = first;
      }
      if (mod !== lastMod) {
        if (lastMod !== null) { go(LEAD[mod]); restart(); }
        hero.setAttribute('data-mod', mod);
        lastMod = mod;
      }
    }
    // Letters of the name rise in, like the sign-in headline.
    function splitRise(node, text) {
      node.textContent = '';
      Array.prototype.forEach.call(text, function (c, i) {
        var s = el('span', 'ch', c);
        s.style.setProperty('--i', i);
        node.appendChild(s);
      });
    }

    var pending = null;
    var soon = function () { if (!pending) pending = setTimeout(function () { pending = null; update(); }, 30); };
    var mo = new MutationObserver(soon);
    ['ar-module', 'sec-module', 'views', 'sec-views'].forEach(function (id) {
      var n = document.getElementById(id);
      if (n) mo.observe(n, { attributes: true, attributeFilter: ['hidden'] });
    });
    ['views', 'sec-views'].forEach(function (id) {
      var n = document.getElementById(id);
      if (n) mo.observe(n, { childList: true, subtree: true });
    });
    document.querySelectorAll('.tabbar-inner').forEach(function (n) {
      mo.observe(n, { attributes: true, subtree: true, attributeFilter: ['aria-selected'] });
    });
    var asofEl = document.getElementById('asof-date');
    if (asofEl) mo.observe(asofEl, { childList: true, characterData: true, subtree: true });
    var monthSel = document.getElementById('sec-month');
    if (monthSel) { monthSel.addEventListener('change', soon); mo.observe(monthSel, { childList: true }); }
    update();

    // ---- scroll parallax: photo drifts slower than the page, copy fades
    if (!reduce) {
      var copy = hero.querySelector('.hs-copy');
      var ticking = false;
      window.addEventListener('scroll', function () {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(function () {
          ticking = false;
          var y = Math.min(window.scrollY, 420);
          media.style.transform = 'translateY(' + (y * 0.22).toFixed(1) + 'px)';
          copy.style.transform = 'translateY(' + (y * 0.1).toFixed(1) + 'px)';
          copy.style.opacity = String(Math.max(0, 1 - y / 320));
        });
      }, { passive: true });
    }
  }

  // ------------------------------------------------------- range gallery
  var track = document.getElementById('range-track');
  if (track) {
    // Two identical runs make the marquee loop seamlessly.
    for (var run = 0; run < 2; run++) {
      PRODUCTS.forEach(function (p) {
        var c = el('figure', 'range-card');
        if (run) c.setAttribute('aria-hidden', 'true');
        var box = el('div', 'range-img');
        box.appendChild(img(p.sm, run ? '' : p.name, true));
        c.appendChild(box);
        var cap = el('figcaption');
        cap.appendChild(el('strong', null, p.name));
        cap.appendChild(el('span', null, p.tag));
        c.appendChild(cap);
        track.appendChild(c);
      });
    }
  }

  // ------------------------------------------------------- sign-in wall
  var wall = document.getElementById('wall');
  if (wall) {
    var order = [
      ['creamy-vanilla', 'lime', 'choco-brownie', 'numax', 'syrups', 'cookie'],
      ['premium-aromat', 'spring-showcase', 'cookie', 'creamy-vanilla', 'lime', 'choco-brownie'],
      ['numax', 'syrups', 'premium-aromat', 'choco-brownie', 'spring-showcase', 'creamy-vanilla']
    ];
    order.forEach(function (ids, r) {
      var row = el('div', 'wall-row' + (r % 2 ? ' rev' : ''));
      var inner = el('div', 'wall-track');
      for (var k = 0; k < 2; k++) {
        ids.forEach(function (id) {
          var t = el('div', 'wall-tile');
          t.appendChild(img(byId[id].sm, '', false));
          inner.appendChild(t);
        });
      }
      row.appendChild(inner);
      wall.appendChild(row);
    });
    requestAnimationFrame(function () { wall.classList.add('on'); });
  }
})();
