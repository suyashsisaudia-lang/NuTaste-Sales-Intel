
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
  // Both sizes as a srcset, so each device downloads what its screen needs:
  // the 600px copy where it is sharp enough, the full photo on dense (Retina)
  // or wide screens. Full photos are 1020px, the two landscape shots 1200px.
  var FULL_W = { 'spring-showcase': 1200, 'syrups': 1200 };
  PRODUCTS.forEach(function (p) { p.srcset = p.sm + ' 600w, ' + p.img + ' ' + (FULL_W[p.id] || 1020) + 'w'; });
  var byId = {};
  PRODUCTS.forEach(function (p) { byId[p.id] = p; });

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function img(src, alt, lazy, srcset, sizes) {
    var i = el('img');
    // sizes and srcset go before src so the browser picks once, not twice
    if (srcset) { i.sizes = sizes; i.srcset = srcset; }
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
      // the banner photo spans the page on phones and ~2/3 of it above 900px
      im.sizes = '(max-width: 900px) 100vw, 66vw';
      im.setAttribute('data-src', p.img);
      im.setAttribute('data-srcset', p.srcset);
      if (i === 0 || i === 4) { im.srcset = p.srcset; im.src = p.img; }
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
      if (!im.getAttribute('src')) {
        im.srcset = im.getAttribute('data-srcset');
        im.src = im.getAttribute('data-src');
      }
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
    var ctxEl = hero.querySelector('#hs-context'), ctxPerson = hero.querySelector('#hs-ctx-person'),
        ctxPeriod = hero.querySelector('#hs-ctx-period');
    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                  'August', 'September', 'October', 'November', 'December'];

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
        dateEl.textContent = asof && asof.textContent !== '—' ? 'refreshed ' + asof.textContent : '';
      }
      dateEl.previousElementSibling.hidden = !dateEl.textContent;

      // The salesperson being viewed and the period, under the greeting.
      if (ctxEl) {
        var period = '';
        if (mod === 'sec') {
          var ms = document.getElementById('sec-month');
          var mk = /^(\d{4})-(\d{2})$/.exec(ms && ms.value || '');
          period = mk ? MONTHS[+mk[2] - 1] + ' ' + mk[1] : '';
        } else {
          var ad = document.getElementById('asof-date');
          period = ad && ad.textContent !== '—' ? 'as at ' + ad.textContent : '';
        }
        ctxPerson.textContent = name;
        ctxPeriod.textContent = period;
        ctxPeriod.hidden = ctxPeriod.previousElementSibling.hidden = !period;
        ctxEl.hidden = !name;
      }

      subEl.textContent = name ? (SUBS[mod][view] || SUBS[mod].overview)
        : 'Search your name above to open your ' + (mod === 'sec' ? 'month.' : 'book.');

      // Greet the signed-in user, not the book being viewed.
      var who = document.querySelector('.whoami');
      var me = who ? who.textContent.trim() : '';
      var first = me ? me.split(/\s+/)[0] : '';
      first = first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : '';
      if (first !== lastName) {
        greetEl.textContent = greeting();
        splitRise(nameEl, first);
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
        box.appendChild(img(p.sm, run ? '' : p.name, true, p.srcset, '(max-width: 640px) 170px, 230px'));
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
          t.appendChild(img(byId[id].sm, '', false, byId[id].srcset,
            '(min-width: 1600px) 240px, (max-width: 1133px) 170px, 15vw'));
          inner.appendChild(t);
        });
      }
      row.appendChild(inner);
      wall.appendChild(row);
    });
    requestAnimationFrame(function () { wall.classList.add('on'); });
  }

  // ------------------------------------------------------- apple flight
  // On opening the page, a big apple pops up in the middle of the screen,
  // ricochets around it under gravity (spinning, squashing on each hit), then
  // glides home on a slow curve — rising just above its place and floating down
  // onto it while shrinking — and touches down with a soft springy squash before
  // the real apple takes over. Purely visual: it never takes clicks, and the real
  // apple is always restored, even if something goes wrong mid-flight.
  function appleFlight(target, hideEl, startDelay) {
    if (reduce || !target || !window.requestAnimationFrame) return;
    hideEl = hideEl || target;
    hideEl.style.visibility = 'hidden';
    var restored = false;
    function restore() {
      if (restored) return;
      restored = true;
      hideEl.style.visibility = '';
      if (flyer.parentNode) flyer.parentNode.removeChild(flyer);
    }
    setTimeout(restore, startDelay + 9500);        // safety net

    var flyer = el('div', 'apple-flyer');
    flyer.setAttribute('aria-hidden', 'true');
    var im = img('/static/brand/nutaste-apple-hd.png', '', false);
    flyer.appendChild(im);

    var RATIO = 127 / 90;                          // apple artwork height / width
    // Bounce around, glide home on a high arc, then bounce to rest in place.
    var BOUNCE_MS = 3000, RETURN_MS = 1900;

    setTimeout(function () {
      var W = window.innerWidth, H = window.innerHeight;
      var w0 = Math.max(120, Math.min(240, Math.min(W, H) * 0.26)), h0 = w0 * RATIO;
      flyer.style.width = w0 + 'px';
      flyer.style.height = h0 + 'px';
      // Start centred at zero size, so it never flashes in the corner before
      // the first frame positions it.
      flyer.style.transform = 'translate(' + (W / 2 - w0 / 2) + 'px,' + (H / 2 - h0 / 2) + 'px) scale(0)';
      document.body.appendChild(flyer);

      var cx = W / 2, cy = H / 2;
      var dir = Math.random() < 0.5 ? -1 : 1;
      var vx = dir * (600 + Math.random() * 200), vy = -(620 + Math.random() * 200);
      var G = 2000, rot = 0, hitAt = -1e9, hitAxis = 'y';
      var t0 = null, last = null, from = null, lb = null;

      function squash(now) {
        var k = 0.22 * Math.exp(-(now - hitAt) / 90);
        return hitAxis === 'y' ? [1 + k * 0.8, 1 - k] : [1 - k, 1 + k * 0.8];
      }
      function place(x, y, r, sx, sy, s) {
        flyer.style.transform = 'translate(' + (x - w0 / 2).toFixed(1) + 'px,' + (y - h0 / 2).toFixed(1) + 'px) ' +
          'rotate(' + r.toFixed(2) + 'deg) scale(' + (s * sx).toFixed(4) + ',' + (s * sy).toFixed(4) + ')';
      }
      function inOutSine(p)  { return -(Math.cos(Math.PI * p) - 1) / 2; }
      function inOutCubic(p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; }
      function outCubic(p)   { return 1 - Math.pow(1 - p, 3); }
      function bez(a, b, c, d, u) { var v = 1 - u; return v * v * v * a + 3 * v * v * u * b + 3 * v * u * u * c + u * u * u * d; }

      function frame(now) {
        if (restored) return;
        if (t0 === null) { t0 = last = now; }
        var t = now - t0, dt = Math.min(0.033, (now - last) / 1000);
        last = now;
        W = window.innerWidth; H = window.innerHeight;

        if (t < BOUNCE_MS) {
          // ---- phase 1: bounce around the screen
          vy += G * dt; cx += vx * dt; cy += vy * dt;
          rot += vx * dt * 0.22;
          var hw = w0 / 2, hh = h0 / 2;
          if (cx - hw < 0)  { cx = hw;     vx = Math.abs(vx) * 0.92; hitAt = now; hitAxis = 'x'; }
          if (cx + hw > W)  { cx = W - hw; vx = -Math.abs(vx) * 0.92; hitAt = now; hitAxis = 'x'; }
          if (cy - hh < 0)  { cy = hh;     vy = Math.abs(vy) * 0.8;  hitAt = now; hitAxis = 'y'; }
          if (cy + hh > H)  {
            cy = H - hh; vy = -Math.abs(vy) * 0.82; vx *= 0.97; hitAt = now; hitAxis = 'y';
            if (vy > -820) vy = -(820 + Math.random() * 180);   // keep it lively
          }
          var pop = Math.min(1, t / 320), s = pop < 1 ? outCubic(pop) + Math.sin(pop * Math.PI) * 0.1 : 1;
          var sq = squash(now);
          place(cx, cy, rot, sq[0], sq[1], s);
        } else {
          var tr = target.getBoundingClientRect();              // tracks scrolling, too
          var tx = tr.left + tr.width / 2, ty = tr.top + tr.height / 2, ts = tr.width / w0;
          if (!from) {
            // Carry the apple's momentum into the glide: the first control point
            // lies along its current velocity, so it curves round rather than
            // snapping toward home.
            var lead = Math.min(1, 300 / (Math.hypot(vx, vy) || 1)) * 0.35;
            from = { x: cx, y: cy, r: ((rot % 360) + 540) % 360 - 180,
                     c1x: Math.max(w0 / 2, Math.min(W - w0 / 2, cx + vx * lead)),
                     c1y: Math.max(h0 / 2, Math.min(H - h0 / 2, cy + vy * lead)) };
          }
          var p = Math.min(1, (t - BOUNCE_MS) / RETURN_MS);
          if (p < 1) {
            // ---- phase 2: glide home on a high arc — it climbs well above the
            // line between start and home, then floats down onto its place.
            var u = inOutSine(p);
            var sc = 1 + (ts - 1) * inOutCubic(p);
            var halfMid = h0 * (1 + ts) / 4;                   // its half-height mid-flight
            var rise = Math.max(0, Math.min(H * 0.45, (from.y + ty) / 2 - halfMid - 16));
            var x = bez(from.x, from.c1x, tx, tx, u);
            var y = from.y + (ty - from.y) * u - rise * Math.sin(Math.PI * u)
                  + (from.c1y - from.y) * 3 * u * (1 - u) * (1 - u);   // carries its momentum
            var r = from.r * (1 - outCubic(p)) + Math.sin(p * Math.PI * 2) * 4 * (1 - p);
            place(x, y, r, 1, 1, sc);
          } else {
            // ---- phase 3: bounce to rest — up about half its height, then
            // smaller and smaller, squashing a little on every touch.
            var ht = h0 * ts, g = ht * 40;
            if (lb === null) {
              lb = { off: 0, v: -Math.sqrt(2 * g * 0.5 * ht), n: 0, done: null };
              hitAt = now; hitAxis = 'y';
            }
            if (lb.done === null) {
              lb.v += g * dt; lb.off += lb.v * dt;
              if (lb.off >= 0) {
                lb.off = 0; lb.n++; hitAt = now; hitAxis = 'y';
                if (lb.n >= 4) { lb.v = 0; lb.done = now; } else lb.v = -Math.abs(lb.v) * 0.55;
              }
            }
            var sqB = squash(now);
            // squash about the base, so it looks planted when it lands
            place(tx, ty + lb.off + ht * (1 - sqB[1]) / 2, 0, sqB[0], sqB[1], ts);
            if (lb.done !== null && now - lb.done > 240) { restore(); return; }
          }
        }
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }, startDelay);
  }

  // The apple flight is no longer run anywhere (removed by request); the
  // function is kept above in case it is wanted back.
})();
