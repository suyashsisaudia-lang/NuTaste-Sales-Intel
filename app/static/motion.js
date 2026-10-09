
// Motion layer for NuTaste Sales Intel.
//
// Purely decorative: it never changes data or layout, and receivables.js /
// secondary.js know nothing about it. It watches the view containers for newly
// rendered blocks and animates them in — staggered scroll reveals, bars that
// grow from their baseline, KPI figures that count up — plus a sliding
// indicator under the module switch and view tabs.
//
// Every effect is skipped when the user asks for reduced motion, and if this
// file fails to load the page simply renders without animation.
(function () {
  'use strict';

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Logo intro (apple drop-and-bounce) removed from the dashboard by request;
  // the sign-in page keeps its own apple animations in login.js / brand.js.

  // --------------------------------------------------- header scroll shadow
  var chrome = document.getElementById('chrome');
  if (chrome) {
    var onScroll = function () { chrome.classList.toggle('is-scrolled', window.scrollY > 4); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // On phones the top row (logo, search, sign-out) scrolls away and the
    // module switch + tabs stay pinned; app.css uses this height as a negative
    // sticky offset. It is re-measured because the row wraps differently per module.
    var topbar = chrome.querySelector('.topbar');
    if (topbar) {
      var measure = function () {
        chrome.style.setProperty('--topbar-h', topbar.offsetHeight + 'px');
      };
      measure();
      window.addEventListener('resize', measure, { passive: true });
      if (window.ResizeObserver) new ResizeObserver(measure).observe(topbar);
    }
  }

  // ------------------------------------------------------ sliding tab ink
  // One indicator per tab list, moved to whichever tab is aria-selected.
  function setupInk(list, tabSel) {
    if (!list) return;
    var ink = document.createElement('span');
    ink.className = 'ink';
    ink.setAttribute('aria-hidden', 'true');
    list.insertBefore(ink, list.firstChild);
    list.classList.add('has-ink');

    var first = true;
    function place() {
      var on = list.querySelector(tabSel + '[aria-selected="true"]');
      // Hidden tab bars measure as zero; they are re-placed when shown.
      if (!on || !on.offsetWidth) { ink.style.opacity = '0'; return; }
      if (first) ink.style.transition = 'none';
      var pill = !!list.closest('.sectionbar');
      ink.style.width = on.offsetWidth + 'px';
      if (pill) ink.style.height = on.offsetHeight + 'px';
      ink.style.transform = 'translate(' + on.offsetLeft + 'px,' + (pill ? on.offsetTop : 0) + 'px)';
      ink.style.opacity = '1';
      if (first) { ink.offsetWidth; ink.style.transition = ''; first = false; }
    }

    new MutationObserver(place).observe(list, { attributes: true, subtree: true, attributeFilter: ['aria-selected'] });
    var bar = list.closest('nav');
    if (bar) new MutationObserver(place).observe(bar, { attributes: true, attributeFilter: ['hidden'] });
    window.addEventListener('resize', place);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(place);
    place();
  }
  setupInk(document.querySelector('.sectionbar-inner'), '.section-btn');
  document.querySelectorAll('.tabbar-inner').forEach(function (l) { setupInk(l, '.tab'); });

  // ------------------------------------------------------ KPI spotlight
  document.addEventListener('pointermove', function (e) {
    var k = e.target.closest && e.target.closest('.kpi');
    if (!k) return;
    var r = k.getBoundingClientRect();
    k.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    k.style.setProperty('--my', (e.clientY - r.top) + 'px');
  }, { passive: true });

  if (reduce || !('IntersectionObserver' in window) || !('MutationObserver' in window)) return;

  // ------------------------------------------------------------ count-up
  // Animates the first number in a figure such as "₹12,34,567" or "₹1.23 Cr"
  // from zero, then restores the exact original text. If the app re-renders
  // the element mid-animation, the animation stops and leaves the new text.
  var COUNT_SEL = '.kpi-value, .leg-value, .answer-big';

  function countUp(node, delay) {
    var orig = node.textContent;
    var m = orig.match(/\d[\d,]*(\.\d+)?/);
    if (!m) return;
    var target = parseFloat(m[0].replace(/,/g, ''));
    if (!isFinite(target) || target === 0) return;
    var decimals = m[1] ? m[1].length - 1 : 0;
    var grouped = m[0].indexOf(',') >= 0;
    var pre = orig.slice(0, m.index), post = orig.slice(m.index + m[0].length);
    var fmt = function (v) {
      return v.toLocaleString('en-IN', {
        minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: grouped
      });
    };
    var DUR = 1100, start = null, last = null;

    function frame(t) {
      if (last !== null && node.textContent !== last) return;   // re-rendered: stop
      if (start === null) start = t;
      var p = Math.min(1, (t - start) / DUR);
      var eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);      // ease-out expo
      if (p < 1) {
        last = pre + fmt(target * eased) + post;
        node.textContent = last;
        requestAnimationFrame(frame);
      } else {
        node.textContent = orig;
      }
    }
    // The text only ever changes inside an animation frame, and a backstop
    // timer puts the true figure back regardless. So if frames stop (a
    // background tab, a throttled browser) a stale in-between number can
    // never be left on screen.
    setTimeout(function () {
      if (node.textContent !== orig) return;
      requestAnimationFrame(frame);
      setTimeout(function () {
        if (last !== null && node.textContent === last) node.textContent = orig;
      }, DUR + 300);
    }, delay);
  }

  // ------------------------------------------------------ donut arcs
  function sweepDonuts(block, delay) {
    if (!block.animate) return;
    block.querySelectorAll('svg.donut circle[stroke-dasharray]').forEach(function (c, i) {
      var dash = c.getAttribute('stroke-dasharray');
      var total = dash.split(/[ ,]+/).reduce(function (a, b) { return a + (parseFloat(b) || 0); }, 0);
      c.animate([{ strokeDasharray: '0 ' + total }, { strokeDasharray: dash }],
        { duration: 1200, delay: delay + 150 + i * 180, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' });
    });
  }

  // ------------------------------------------------------ scroll reveal
  var queue = [], flushTimer = null, pending = new Set();

  function reveal(node) {
    if (!pending.has(node)) return;
    pending.delete(node);
    io.unobserve(node);
    queue.push(node);
    // Blocks that enter together are revealed together, one after another.
    if (!flushTimer) flushTimer = setTimeout(flush, 16);
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) reveal(e.target); });
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.01 });

  // Safety net: content must never stay invisible because an observer event
  // was missed. Anything shown and at or above the fold is revealed directly.
  setInterval(function () {
    pending.forEach(function (n) {
      if (!n.isConnected) { pending.delete(n); io.unobserve(n); return; }
      if (n.offsetParent === null) return;                    // in a hidden tab
      if (n.getBoundingClientRect().top < window.innerHeight) reveal(n);
    });
  }, 700);

  function flush() {
    flushTimer = null;
    var batch = queue.splice(0);
    batch.forEach(function (node, i) {
      var d = Math.min(i, 8) * 70;
      node.style.setProperty('--rv-d', d + 'ms');
      node.querySelectorAll('.spark-bar').forEach(function (b, j) { b.style.setProperty('--i', j); });
      node.classList.add('rv-in');
      node.querySelectorAll(COUNT_SEL).forEach(function (n) { countUp(n, d + 120); });
      if (node.matches(COUNT_SEL)) countUp(node, d + 120);
      sweepDonuts(node, d);
      // Drop the helper classes once finished, so hover transitions on cards
      // and tiles behave normally again.
      setTimeout(function () {
        node.classList.remove('rv', 'rv-in');
        node.style.removeProperty('--rv-d');
      }, d + 2000);
    });
  }

  function register(node) {
    if (node.nodeType !== 1 || node.classList.contains('rv')) return;
    // Grids reveal tile by tile rather than as one slab.
    if (node.matches('.kpis, .grid-2, .qgrid')) {
      Array.prototype.forEach.call(node.children, register);
      return;
    }
    node.classList.add('rv');
    // Blurring a full invoice table while it fades is costly; fade it plainly.
    if (node.querySelector('table.rep')) node.classList.add('rv-lite');
    pending.add(node);
    io.observe(node);
  }

  // Views render into these hosts; Ask answers render into an answer slot.
  function isHost(n) {
    return n && n.nodeType === 1 &&
      (n.matches('#views > section, #sec-views > section') || /answer-slot$/.test(n.id || ''));
  }

  var mo = new MutationObserver(function (records) {
    records.forEach(function (r) {
      if (!isHost(r.target)) return;
      Array.prototype.forEach.call(r.addedNodes, register);
    });
  });
  ['views', 'sec-views'].forEach(function (id) {
    var root = document.getElementById(id);
    if (!root) return;
    mo.observe(root, { childList: true, subtree: true });
    // Anything rendered before this script ran (e.g. a remembered selection).
    root.querySelectorAll('section').forEach(function (s) {
      Array.prototype.forEach.call(s.children, register);
    });
  });
})();
