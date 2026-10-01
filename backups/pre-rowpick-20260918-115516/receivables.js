
(function () {
  'use strict';

  var D = window.AR_DATA;
  var L = { SP: 0, CUST: 1, TERM: 2, DOC: 3, DUE: 4, ORIG: 5, BAL: 6, B0: 7 };
  var NB = D.bucketLabels.length;

  // Each bucket keeps a fixed severity tier, so a colour always means the same
  // thing regardless of which salesperson (or how many buckets) is on screen.
  var TIER = [0, 1, 1, 2, 2, 3, 3, 4, 4, 4];
  var TIER_VAR = ['var(--ok)', 'var(--sev-1)', 'var(--sev-2)', 'var(--sev-3)', 'var(--sev-4)'];

  // ---------------------------------------------------------------- utils
  function money(n) {
    var v = Math.round(n || 0);
    var s = Math.abs(v).toLocaleString('en-IN');
    return (v < 0 ? '−₹' : '₹') + s;
  }
  function compact(n) {
    var a = Math.abs(n || 0), sign = n < 0 ? '−' : '';
    if (a >= 1e7) return sign + '₹' + (a / 1e7).toFixed(2) + ' Cr';
    if (a >= 1e5) return sign + '₹' + (a / 1e5).toFixed(2) + ' L';
    return money(n);
  }
  function pct(part, whole) {
    if (!whole) return '0%';
    return (Math.abs(part) / Math.abs(whole) * 100).toFixed(1) + '%';
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    var p = iso.split('-'), m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return p[2] + '-' + m[+p[1] - 1] + '-' + p[0];
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function negClass(n) { return n < 0 ? 'n neg' : 'n'; }
  // The Excel report renders zero as a dash in every money column; match it.
  function m0(v) { return v === 0 ? '–' : money(v); }

  // ---------------------------------------------------------------- index
  var bySp = {};
  D.lines.forEach(function (ln) {
    (bySp[ln[L.SP]] = bySp[ln[L.SP]] || []).push(ln);
  });

  var roster = D.salespeople.map(function (name, i) {
    var lines = bySp[i] || [];
    var bal = 0, custs = {};
    lines.forEach(function (ln) { bal += ln[L.BAL]; custs[ln[L.CUST]] = 1; });
    return { ix: i, name: name, lines: lines, balance: bal, customers: Object.keys(custs).length };
  }).sort(function (a, b) {
    // people with receivables first, then everyone else alphabetically
    if (!a.lines.length !== !b.lines.length) return a.lines.length ? -1 : 1;
    return (b.balance - a.balance) || a.name.localeCompare(b.name);
  });

  function summarise(lines) {
    var s = { balance: 0, original: 0, buckets: new Array(NB).fill(0), byCust: {}, byTerm: {} };
    lines.forEach(function (ln) {
      s.balance += ln[L.BAL];
      s.original += ln[L.ORIG];
      for (var b = 0; b < NB; b++) s.buckets[b] += ln[L.B0 + b];

      var c = s.byCust[ln[L.CUST]] || (s.byCust[ln[L.CUST]] = { bal: 0, lines: 0, overdue: 0 });
      c.bal += ln[L.BAL]; c.lines++;
      for (var k = 1; k < NB; k++) c.overdue += ln[L.B0 + k];

      var t = D.terms[ln[L.TERM]];
      var tt = s.byTerm[t] || (s.byTerm[t] = { bal: 0, lines: 0 });
      tt.bal += ln[L.BAL]; tt.lines++;
    });
    s.notDue = s.buckets[0];
    s.overdue = s.buckets.slice(1).reduce(function (a, b) { return a + b; }, 0);
    return s;
  }

  function activeBuckets(s) {
    var out = [];
    for (var b = 0; b < NB; b++) if (s.buckets[b] !== 0) out.push(b);
    return out;
  }

  // ---------------------------------------------------------------- tooltip
  var tipEl = document.getElementById('tip');
  function bindTip(node, text) {
    node.addEventListener('mouseenter', function () {
      tipEl.textContent = text;
      tipEl.classList.add('on');
    });
    node.addEventListener('mousemove', function (e) {
      tipEl.style.left = e.clientX + 'px';
      tipEl.style.top = e.clientY + 'px';
    });
    node.addEventListener('mouseleave', function () { tipEl.classList.remove('on'); });
  }

  // ---------------------------------------------------------------- pieces
  function card(title, note) {
    var c = el('div', 'card');
    var h = el('div', 'card-head');
    h.appendChild(el('h3', 'card-title', title));
    if (note) h.appendChild(el('span', 'card-note', note));
    c.appendChild(h);
    var b = el('div', 'card-body');
    c.appendChild(b);
    return { root: c, body: b };
  }

  function kpiTile(label, value, sub, hero) {
    var k = el('div', 'kpi' + (hero ? ' hero' : ''));
    k.appendChild(el('div', 'kpi-label', label));
    k.appendChild(el('div', 'kpi-value num', value));
    if (sub) {
      var s = el('div', 'kpi-sub');
      s.innerHTML = sub;
      k.appendChild(s);
    }
    return k;
  }

  function donut(notDue, overdue) {
    var NS = 'http://www.w3.org/2000/svg';
    var a = Math.max(0, notDue), b = Math.max(0, overdue), tot = a + b;
    var R = 54, C = 2 * Math.PI * R, GAP = 4;

    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 140 140');
    svg.setAttribute('width', '140'); svg.setAttribute('height', '140');
    svg.setAttribute('class', 'donut');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Not due ' + money(notDue) + ', overdue ' + money(overdue));

    var track = document.createElementNS(NS, 'circle');
    track.setAttribute('cx', 70); track.setAttribute('cy', 70); track.setAttribute('r', R);
    track.setAttribute('fill', 'none'); track.setAttribute('stroke', 'var(--surface-2)');
    track.setAttribute('stroke-width', 20);
    svg.appendChild(track);

    if (tot > 0) {
      var offset = 0;
      [[a, 'var(--ok)'], [b, 'var(--sev-3)']].forEach(function (seg) {
        if (seg[0] <= 0) return;
        var len = seg[0] / tot * C;
        var arc = document.createElementNS(NS, 'circle');
        arc.setAttribute('cx', 70); arc.setAttribute('cy', 70); arc.setAttribute('r', R);
        arc.setAttribute('fill', 'none');
        arc.setAttribute('stroke', seg[1]);
        arc.setAttribute('stroke-width', 20);
        arc.setAttribute('stroke-dasharray', Math.max(0, len - GAP) + ' ' + (C - Math.max(0, len - GAP)));
        arc.setAttribute('stroke-dashoffset', -offset);
        arc.setAttribute('transform', 'rotate(-90 70 70)');
        svg.appendChild(arc);
        offset += len;
      });
    }
    return svg;
  }

  function legendRow(colour, label, value, sub) {
    var r = el('div', 'leg-row');
    var d = el('span', 'dot');
    d.style.background = colour;
    d.style.marginTop = '5px';
    r.appendChild(d);
    var b = el('div', 'leg-body');
    b.appendChild(el('div', 'leg-label', label));
    b.appendChild(el('div', 'leg-value num', value));
    if (sub) b.appendChild(el('div', 'leg-pct', sub));
    r.appendChild(b);
    return r;
  }

  function barRow(name, value, scale, colour, tipText, extra) {
    var row = el('div', 'bar-row' + (extra ? ' ' + extra : ''));
    row.appendChild(el('div', 'bar-name', name));
    var track = el('div', 'bar-track');
    var fill = el('div', 'bar-fill' + (value < 0 ? ' neg' : ''));
    fill.style.width = (scale ? Math.max(1, Math.abs(value) / scale * 100) : 0) + '%';
    fill.style.background = value < 0 ? 'var(--credit)' : colour;
    track.appendChild(fill);
    row.appendChild(track);
    var v = el('div', 'bar-val num' + (value < 0 ? ' neg' : ''), money(value));
    row.appendChild(v);
    if (tipText) bindTip(track, tipText);
    return row;
  }

  // ---------------------------------------------------------------- views
  function renderOverview(person, s) {
    var host = document.getElementById('view-overview');
    host.textContent = '';

    if (!person.lines.length) {
      var nc = card(person.name, 'as at ' + fmtDate(D.reportDate));
      var box = el('div', 'notice');
      box.innerHTML = '<strong>Nothing outstanding.</strong> This person has no ' +
        'open receivables in the current extract. They still appear here because ' +
        'they are on the current employee list.';
      nc.body.appendChild(box);
      host.appendChild(nc.root);
      return;
    }

    // -- KPIs
    var kpis = el('div', 'kpis');
    kpis.appendChild(kpiTile('Total outstanding', money(s.balance),
      compact(s.balance) + ' · ' + person.lines.length + ' invoice lines', true));
    kpis.appendChild(kpiTile('Not due', money(s.notDue),
      '<span class="chip ok"><span class="dot" style="background:var(--ok)"></span>' +
      pct(s.notDue, s.balance) + ' of book</span>'));
    kpis.appendChild(kpiTile('Overdue', money(s.overdue),
      '<span class="chip ' + (s.overdue > 0 ? 'bad' : 'neutral') + '">' +
      pct(s.overdue, s.balance) + ' of book</span>'));
    kpis.appendChild(kpiTile('Customers', String(person.customers),
      'across ' + new Set(person.lines.map(function (l) { return D.customers[l[L.CUST]][2]; })).size + ' zone(s)'));
    host.appendChild(kpis);

    // -- split + ageing
    var grid = el('div', 'grid-2');

    var dc = card('Not due vs overdue', 'share of balance');
    var dw = el('div', 'donut-wrap');
    dw.appendChild(donut(s.notDue, s.overdue));
    var lg = el('div', 'donut-legend');
    lg.appendChild(legendRow('var(--ok)', 'Not due', money(s.notDue), pct(s.notDue, s.notDue + s.overdue) + ' of total'));
    lg.appendChild(legendRow('var(--sev-3)', 'Overdue', money(s.overdue), pct(s.overdue, s.notDue + s.overdue) + ' of total'));
    dw.appendChild(lg);
    dc.body.appendChild(dw);
    if (s.notDue < 0 || s.overdue < 0) {
      var w = el('p', 'card-note', 'One component is a net credit, so the ring shows only the positive share.');
      w.style.marginTop = '12px';
      dc.body.appendChild(w);
    }
    grid.appendChild(dc.root);

    var ac = card('Ageing breakdown', 'by days past due');
    var act = activeBuckets(s);
    if (!act.length) {
      ac.body.appendChild(el('p', 'card-note', 'No balance to age.'));
    } else {
      var scale = Math.max.apply(null, act.map(function (b) { return Math.abs(s.buckets[b]); })) || 1;
      var bars = el('div', 'bars');
      act.forEach(function (b) {
        bars.appendChild(barRow(
          D.bucketLabels[b], s.buckets[b], scale, TIER_VAR[TIER[b]],
          D.bucketLabels[b] + ' · ' + money(s.buckets[b]) + ' · ' + pct(s.buckets[b], s.balance) + ' of book'
        ));
      });
      ac.body.appendChild(bars);
      var omitted = NB - act.length;
      if (omitted) ac.root.querySelector('.card-note').textContent = omitted + ' empty bucket(s) hidden';
    }
    grid.appendChild(ac.root);
    host.appendChild(grid);

    // -- top customers
    var tops = Object.keys(s.byCust).map(function (ci) {
      return { ci: +ci, bal: s.byCust[ci].bal, overdue: s.byCust[ci].overdue, lines: s.byCust[ci].lines };
    }).sort(function (a, b) { return b.bal - a.bal; });
    var shown = tops.slice(0, 10);

    var tc = card('Top customers by outstanding',
      shown.length + ' of ' + tops.length + ' shown');
    if (!shown.length) {
      tc.body.appendChild(el('p', 'card-note', 'No customers to show.'));
    } else {
      var cscale = Math.max.apply(null, shown.map(function (t) { return Math.abs(t.bal); })) || 1;
      var cb = el('div', 'bars cust-bars');
      shown.forEach(function (t, i) {
        var c = D.customers[t.ci];
        var row = el('div', 'bar-row cust-row');

        var meta = el('div', 'bar-meta');
        meta.appendChild(el('span', 'bar-rank', String(i + 1)));
        meta.appendChild(el('span', 'bar-name', c[1]));
        meta.appendChild(el('span', 'bar-zone', c[2]));

        var line = el('div', 'bar-line');
        var track = el('div', 'bar-track');
        var fill = el('div', 'bar-fill' + (t.bal < 0 ? ' neg' : ''));
        fill.style.width = Math.max(1, Math.abs(t.bal) / cscale * 100) + '%';
        fill.style.background = t.bal < 0 ? 'var(--credit)'
          : (t.overdue > 0 ? 'var(--sev-3)' : 'var(--ok)');
        track.appendChild(fill);
        bindTip(track, c[1] + ' · ' + money(t.bal) + ' · ' + t.lines + ' line(s)' +
          (t.overdue > 0 ? ' · ' + money(t.overdue) + ' overdue' : ' · nothing overdue'));
        line.appendChild(track);
        line.appendChild(el('div', 'bar-val num' + (t.bal < 0 ? ' neg' : ''), money(t.bal)));

        row.appendChild(meta);
        row.appendChild(line);
        cb.appendChild(row);
      });
      tc.body.appendChild(cb);

      var key = el('p', 'card-note');
      key.style.marginTop = '14px';
      key.innerHTML = '<span class="chip ok"><span class="dot" style="background:var(--ok)"></span>nothing overdue</span> ' +
        '<span class="chip bad"><span class="dot" style="background:var(--sev-3)"></span>has overdue</span> ' +
        '<span class="chip neutral"><span class="dot" style="background:var(--credit)"></span>net credit</span>';
      tc.body.appendChild(key);
    }
    host.appendChild(tc.root);
  }

  function renderReport(person, s) {
    var host = document.getElementById('view-report');
    host.textContent = '';

    var act = activeBuckets(s);
    var c = card('Accounts Receivable — Salesperson Statement',
      person.lines.length + ' lines · ' + person.customers + ' customers');

    var scroll = el('div', 'table-scroll');
    var t = el('table', 'rep');
    var cols = ['Customer No.', 'Customer Name', 'Zone', 'Document No.', 'Due Date',
      'Original Amount', 'Balance'].concat(act.map(function (b) { return D.bucketLabels[b]; }));

    var thead = el('thead'), htr = el('tr');
    cols.forEach(function (name) { htr.appendChild(el('th', null, name)); });
    thead.appendChild(htr);
    t.appendChild(thead);

    var tbody = el('tbody');
    var groups = {};
    person.lines.forEach(function (ln) { (groups[ln[L.CUST]] = groups[ln[L.CUST]] || []).push(ln); });

    Object.keys(groups)
      .sort(function (a, b) {
        return D.customers[a][1].toLowerCase() < D.customers[b][1].toLowerCase() ? -1 : 1;
      })
      .forEach(function (ci) {
        var cust = D.customers[ci];
        var rows = groups[ci].slice().sort(function (a, b) {
          return (a[L.DUE] || '') < (b[L.DUE] || '') ? -1 : 1;
        });

        var ctr = el('tr', 'cust');
        ctr.appendChild(el('td', null, cust[0]));
        ctr.appendChild(el('td', null, cust[1]));
        ctr.appendChild(el('td', null, cust[2]));
        for (var k = 3; k < cols.length; k++) ctr.appendChild(el('td'));
        tbody.appendChild(ctr);

        var sub = { orig: 0, bal: 0, b: new Array(NB).fill(0) };
        rows.forEach(function (ln, i) {
          var tr = el('tr', i % 2 ? 'alt' : null);
          tr.appendChild(el('td'));
          tr.appendChild(el('td'));
          tr.appendChild(el('td'));
          tr.appendChild(el('td', null, ln[L.DOC]));
          tr.appendChild(el('td', null, fmtDate(ln[L.DUE])));
          tr.appendChild(el('td', negClass(ln[L.ORIG]), m0(ln[L.ORIG])));
          tr.appendChild(el('td', negClass(ln[L.BAL]), m0(ln[L.BAL])));
          act.forEach(function (b) {
            var v = ln[L.B0 + b];
            tr.appendChild(el('td', negClass(v), m0(v)));
          });
          tbody.appendChild(tr);

          sub.orig += ln[L.ORIG]; sub.bal += ln[L.BAL];
          for (var b2 = 0; b2 < NB; b2++) sub.b[b2] += ln[L.B0 + b2];
        });

        var str = el('tr', 'sub');
        var lbl = el('td', 'lbl', 'Subtotal — ' + cust[1]);
        lbl.colSpan = 5;
        str.appendChild(lbl);
        str.appendChild(el('td', negClass(sub.orig), m0(sub.orig)));
        str.appendChild(el('td', negClass(sub.bal), m0(sub.bal)));
        act.forEach(function (b) { str.appendChild(el('td', negClass(sub.b[b]), m0(sub.b[b]))); });
        tbody.appendChild(str);
      });

    var gtr = el('tr', 'grand');
    var glbl = el('td', 'lbl', 'GRAND TOTAL');
    glbl.colSpan = 5;
    gtr.appendChild(glbl);
    gtr.appendChild(el('td', 'n', m0(s.original)));
    gtr.appendChild(el('td', 'n', m0(s.balance)));
    act.forEach(function (b) { gtr.appendChild(el('td', 'n', m0(s.buckets[b]))); });
    tbody.appendChild(gtr);

    t.appendChild(tbody);
    scroll.appendChild(t);
    c.body.appendChild(scroll);

    var omitted = NB - act.length;
    var n = el('p', 'notes');
    n.style.marginTop = '14px';
    n.innerHTML = '<strong>Notes.</strong> Figures are as at ' + fmtDate(D.reportDate) +
      ' and do not re-age with time. Negative amounts are payments or credit notes applied to the account.' +
      (omitted ? ' ' + omitted + ' ageing bucket(s) with no activity are hidden.' : '');
    c.body.appendChild(n);

    host.appendChild(c.root);
  }

  // ================================================================
  // Free-text question engine
  //
  // Answers are COMPUTED from the loaded data — never generated. The parser
  // extracts filters (customer, zone, payment terms, ageing threshold, sign)
  // and an aggregation intent, then runs a real query. Whatever it understood
  // is shown back as chips so the reader can check the interpretation, and an
  // unrecognised question says so rather than guessing.
  // ================================================================

  // Lower bound, in days past due, of each ageing bucket (index 0 = not due).
  var BUCKET_LOWER = [null, 1, 32, 62, 93, 123, 154, 182, 213, 244];
  var BUCKET_UPPER = [null, 31, 61, 92, 122, 153, 181, 212, 243, 9999];

  // Words too common across customer names to identify one.
  var NAME_STOP = {
    private: 1, limited: 1, ltd: 1, pvt: 1, company: 1, india: 1, indian: 1,
    food: 1, foods: 1, foodstuff: 1, enterprise: 1, enterprises: 1, agency: 1,
    agencies: 1, trader: 1, traders: 1, trading: 1, sales: 1, marketing: 1,
    distributor: 1, distributors: 1, industries: 1, products: 1, product: 1,
    services: 1, service: 1, solution: 1, solutions: 1, hospitality: 1,
    restaurant: 1, restaurants: 1, retail: 1, store: 1, stores: 1, and: 1,
    the: 1, for: 1, with: 1, from: 1, corporation: 1, group: 1, brands: 1
  };

  // Words that carry query meaning must never be treated as part of a customer
  // name, or "which customer has the HIGHest overdue" matches "The High Life
  // Cuisine" and returns a confident wrong answer.
  var QUERY_WORDS = {
    high: 1, highest: 1, low: 1, lowest: 1, most: 1, least: 1, more: 1, less: 1,
    top: 1, best: 1, worst: 1, large: 1, largest: 1, small: 1, smallest: 1,
    big: 1, bigger: 1, biggest: 1, old: 1, older: 1, oldest: 1, new: 1,
    newest: 1, late: 1, latest: 1, due: 1, overdue: 1, total: 1, balance: 1,
    amount: 1, value: 1, invoice: 1, invoices: 1, customer: 1, customers: 1,
    zone: 1, zones: 1, days: 1, credit: 1, credits: 1, payment: 1, payments: 1,
    terms: 1, show: 1, list: 1, give: 1, what: 1, which: 1, have: 1, has: 1,
    many: 1, much: 1, mine: 1, my: 1, me: 1, all: 1, sum: 1, count: 1,
    average: 1, percent: 1, percentage: 1, share: 1, split: 1, breakup: 1,
    breakdown: 1, wise: 1, unpaid: 1, paid: 1, outstanding: 1, pending: 1
  };

  function matchCustomers(q, custIds) {
    var hits = [], seen = {};
    custIds.forEach(function (ci) {
      var full = D.customers[ci][1].toLowerCase().trim();
      if (full.length > 3 && q.indexOf(full) !== -1) {
        if (!seen[ci]) { seen[ci] = 1; hits.push({ ci: +ci, score: full.length }); }
      }
    });
    if (hits.length) return hits.sort(function (a, b) { return b.score - a.score; });

    custIds.forEach(function (ci) {
      var toks = D.customers[ci][1].toLowerCase().split(/[^a-z0-9]+/);
      var best = 0;
      toks.forEach(function (t) {
        if (t.length >= 4 && !NAME_STOP[t] && !QUERY_WORDS[t] &&
            new RegExp('(^|[^a-z])' + t + '([^a-z]|$)').test(q) && t.length > best) {
          best = t.length;
        }
      });
      if (best && !seen[ci]) { seen[ci] = 1; hits.push({ ci: +ci, score: best }); }
    });
    return hits.sort(function (a, b) { return b.score - a.score; });
  }

  // ================================================================
  // Intent handlers
  //
  // These run BEFORE the generic filter parser. Each recognises a whole
  // question shape and computes a purpose-built answer, so a question like
  // "which customers should I call first" is never reduced to a keyword.
  //
  // Anything that cannot be answered from this data is refused explicitly
  // rather than answered narrowly — a confident wrong number is worse than
  // an honest "not in this data".
  // ================================================================

  function customerRollup(person) {
    var m = {};
    person.lines.forEach(function (ln) {
      var k = ln[L.CUST];
      var c = m[k] || (m[k] = { ci: k, name: D.customers[k][1], zone: D.customers[k][2],
                                bal: 0, overdue: 0, notDue: 0, lines: 0,
                                oldestDue: null, buckets: new Array(NB).fill(0),
                                terms: {} });
      c.bal += ln[L.BAL];
      c.notDue += ln[L.B0];
      c.lines++;
      c.terms[D.terms[ln[L.TERM]]] = 1;
      for (var b = 0; b < NB; b++) c.buckets[b] += ln[L.B0 + b];
      for (var k2 = 1; k2 < NB; k2++) c.overdue += ln[L.B0 + k2];
      if (ln[L.DUE] && (!c.oldestDue || ln[L.DUE] < c.oldestDue)) c.oldestDue = ln[L.DUE];
    });
    return Object.keys(m).map(function (k) { return m[k]; });
  }

  // Weighted midpoint age of each bucket, for "how old is my book" answers.
  var BUCKET_MID = [0, 16, 46, 77, 107, 138, 167, 197, 228, 300];

  function weightedAge(buckets) {
    var num = 0, den = 0;
    for (var b = 1; b < NB; b++) {
      if (buckets[b] > 0) { num += buckets[b] * BUCKET_MID[b]; den += buckets[b]; }
    }
    return den ? num / den : 0;
  }

  function daysBetween(aIso, bIso) {
    var a = new Date(aIso), b = new Date(bIso);
    return Math.round((a - b) / 86400000);
  }

  function refuse(head, why) {
    return { refusal: true, head: head, why: why };
  }

  // ---------------------------------------------------------------- handlers
  // Each entry: test(q) -> boolean, run(person, s) -> answer object.
  var HANDLERS = [

    // ---- things this data genuinely cannot answer -----------------------
    {
      id: 'other-salespeople',
      test: function (q) {
        return /\b(salesperson|salespersons|sales person|sales people|colleague|team|other reps?|rank me|where do i rank|compared with other|vs other)\b/.test(q);
      },
      run: function () {
        return refuse('Not available in your view',
          'This portal shows your own book only. Comparisons against other salespeople ' +
          'would mean loading the whole company ledger, which this view deliberately does not do. ' +
          'Your sales manager can produce a team comparison from the full report.');
      }
    },
    {
      id: 'posting-group',
      test: function (q) {
        return /\b(posting group|gen\.? bus|business group|key account|foodoo|nutrition|ingredients|direct sales|business line|category)\b/.test(q);
      },
      run: function () {
        return refuse('Not in this dataset',
          'This report covers Foodoo channel business only, so there is nothing to compare ' +
          'against Key Account, Nutrition, Ingredients or Direct Sales. Those sit in the ' +
          'wider company extract.');
      }
    },
    {
      id: 'posting-date',
      test: function (q) {
        return /\b(posted|posting date|posting month|financial year|fy ?20|invoiced (?:in|during)|raised (?:in|during)|which month generated|month generated)\b/.test(q);
      },
      run: function () {
        return refuse('Not in this dataset',
          'This view carries due dates but not posting dates, so questions about when an ' +
          'invoice was raised, or which month it belongs to, cannot be answered here.');
      }
    },
    {
      id: 'payment-history',
      test: function (q) {
        return /\b(pays on time|pay on time|payment history|how (?:quickly|fast|soon) .* pay|payment behaviou?r|payment trend|usually pays?|paid (?:on|in) time|settlement history|days sales outstanding|dso)\b/.test(q)
            || /\bshorter payment terms .*(?:more overdue|than)\b/.test(q);
      },
      run: function () {
        return refuse('Not in this dataset',
          'This is a snapshot of what is currently open. It holds no record of when past ' +
          'invoices were settled, so payment behaviour and speed cannot be worked out from it.');
      }
    },

    // ---- portfolio summary ---------------------------------------------
    {
      id: 'summary',
      test: function (q) {
        return /\b(complete summary|full summary|overall summary|summary of my (?:accounts )?receivable|ar position|receivables position|briefing|brief me|executive summary|update i can send|three most important|most important things|what should i know)\b/.test(q);
      },
      run: function (person, s) {
        var cust = customerRollup(person);
        var withOd = cust.filter(function (c) { return c.overdue > 0; });
        var clean = cust.filter(function (c) { return c.overdue <= 0; });
        var top = cust.slice().sort(function (a, b) { return b.bal - a.bal; })[0];
        var worstOd = withOd.slice().sort(function (a, b) { return b.overdue - a.overdue; })[0];
        var old90 = 0;
        for (var b = 4; b < NB; b++) old90 += s.buckets[b];
        var age = weightedAge(s.buckets);

        return {
          big: money(s.balance),
          head: 'Your receivables at a glance',
          note: pct(s.overdue, s.balance) + ' of your book is overdue (' + money(s.overdue) + '), ' +
                'across ' + person.customers + ' customers and ' + person.lines.length + ' open documents.',
          table: ['Measure', 'Value', 'Note'],
          body: [
            ['Total outstanding', money(s.balance), person.lines.length + ' open documents'],
            ['Not due', money(s.notDue), pct(s.notDue, s.balance) + ' of book'],
            ['Overdue', money(s.overdue), pct(s.overdue, s.balance) + ' of book'],
            ['Beyond 90 days', money(old90), old90 ? pct(old90, s.balance) + ' of book' : 'nothing this old'],
            ['Customers with overdue', String(withOd.length), 'of ' + cust.length + ' total'],
            ['Fully up to date', String(clean.length), 'no overdue at all'],
            ['Largest balance', top ? top.name : '—', top ? money(top.bal) : ''],
            ['Largest overdue', worstOd ? worstOd.name : 'none', worstOd ? money(worstOd.overdue) : ''],
            ['Average overdue age', age ? Math.round(age) + ' days' : 'n/a', 'weighted by amount'],
          ],
          more: 0
        };
      }
    },

    // ---- collection priority -------------------------------------------
    {
      id: 'priority',
      test: function (q) {
        return /\b(call first|contact first|priority|prioriti[sz]e|chase first|follow up with|escalat\w*|focus (?:on|for)|collection sequence|who should i (?:call|chase|contact)|need immediate attention|biggest (?:collection )?risks?|where most of my overdue|attention)\b/.test(q)
            || /\brank my customers\b/.test(q) && /\b(aging|ageing|age|overdue)\b/.test(q);
      },
      run: function (person, s) {
        var cust = customerRollup(person).filter(function (c) { return c.overdue > 0; });
        if (!cust.length) {
          return { big: '0', head: 'Nothing to chase',
                   note: 'No customer in your book currently has an overdue balance.',
                   table: [], body: [], more: 0 };
        }
        cust.forEach(function (c) {
          c.age = weightedAge(c.buckets);
          c.score = c.overdue * (1 + c.age / 90);   // amount, weighted by how old it is
        });
        cust.sort(function (a, b) { return b.score - a.score; });
        var band = function (i) { return i < 3 ? 'High' : (i < 8 ? 'Medium' : 'Low'); };
        return {
          big: money(cust.reduce(function (a, c) { return a + c.overdue; }, 0)),
          head: 'Collection priority — ' + cust.length + ' customers with overdue',
          note: 'Ranked by overdue amount weighted by how old it is (older debt scores higher). ' +
                'The top three carry ' +
                money(cust.slice(0, 3).reduce(function (a, c) { return a + c.overdue; }, 0)) + '.',
          rule: 'priority score = overdue amount × (1 + average age in days ÷ 90)',
          table: ['Priority', 'Customer', 'Avg age', 'Overdue'],
          body: cust.slice(0, 20).map(function (c, i) {
            return [band(i) + ' · ' + (i + 1), c.name, Math.round(c.age) + ' days', money(c.overdue)];
          }),
          more: cust.length > 20 ? cust.length - 20 : 0
        };
      }
    },

    // ---- concentration / risk ------------------------------------------
    {
      id: 'banding',
      test: function (q) {
        return /\b(healthy watchlist|watchlist and critical|healthy.*critical|risk ranking|customer risk|divide my portfolio|segment my customers)\b/.test(q);
      },
      run: function (person, s) {
        var cust = customerRollup(person).filter(function (c) { return c.bal > 0; });
        cust.forEach(function (c) {
          c.age = weightedAge(c.buckets);
          c.ratio = c.bal ? c.overdue / c.bal : 0;
          c.band = (c.overdue <= 0) ? 'Healthy'
                 : (c.age > 90 || c.ratio > 0.6) ? 'Critical' : 'Watchlist';
        });
        var order = { Critical: 0, Watchlist: 1, Healthy: 2 };
        cust.sort(function (a, b) { return order[a.band] - order[b.band] || b.bal - a.bal; });
        var count = function (b) { return cust.filter(function (c) { return c.band === b; }).length; };
        var sumOf = function (b) {
          return cust.filter(function (c) { return c.band === b; })
                     .reduce(function (a, c) { return a + c.bal; }, 0);
        };
        return {
          big: String(count('Critical')),
          head: 'Critical accounts needing attention',
          note: 'Critical ' + count('Critical') + ' (' + money(sumOf('Critical')) + ') · ' +
                'Watchlist ' + count('Watchlist') + ' (' + money(sumOf('Watchlist')) + ') · ' +
                'Healthy ' + count('Healthy') + ' (' + money(sumOf('Healthy')) + ').',
          rule: 'Critical = overdue older than 90 days on average, or more than 60% of the balance past due · Watchlist = any overdue · Healthy = none',
          table: ['Band', 'Customer', 'Overdue %', 'Balance'],
          body: cust.slice(0, 25).map(function (c) {
            return [c.band, c.name, c.bal ? pct(c.overdue, c.bal) : '—', money(c.bal)];
          }),
          more: cust.length > 25 ? cust.length - 25 : 0
        };
      }
    },

    {
      id: 'concentration',
      test: function (q) {
        return /\b(concentration|depend(?:ent|ency)|share of my receivables|80%|major concentration|what share of my)\b/.test(q)
            || /\bshare .* top (?:five|5|three|3|ten|10)\b/.test(q)
            || /\btop (?:five|5|three|3|ten|10) customers\b/.test(q) && /\b(share|percent|account for|concentration|most of)\b/.test(q);
      },
      run: function (person, s) {
        var cust = customerRollup(person).sort(function (a, b) { return b.bal - a.bal; });
        var pos = cust.filter(function (c) { return c.bal > 0; });
        var totalPos = pos.reduce(function (a, c) { return a + c.bal; }, 0);
        var run = 0, n80 = 0;
        for (var i = 0; i < pos.length; i++) {
          run += pos[i].bal; n80++;
          if (run >= totalPos * 0.8) break;
        }
        var top5 = pos.slice(0, 5).reduce(function (a, c) { return a + c.bal; }, 0);
        return {
          big: pos.length ? pct(pos[0].bal, totalPos) : '0%',
          head: pos.length ? 'Largest customer share — ' + pos[0].name : 'No positive balances',
          note: 'Top 5 customers hold ' + money(top5) + ' (' + pct(top5, totalPos) + '). ' +
                n80 + ' of ' + pos.length + ' customers make up 80% of your book.',
          table: ['Customer', 'Zone', 'Share', 'Balance'],
          body: pos.slice(0, 15).map(function (c) {
            return [c.name, c.zone, pct(c.bal, totalPos), money(c.bal)];
          }),
          more: pos.length > 15 ? pos.length - 15 : 0
        };
      }
    },

    // ---- portfolio banding ---------------------------------------------
    // ---- high value + old overdue ---------------------------------------
    {
      id: 'high-and-old',
      test: function (q) {
        return /\b(high balance and .*old|high value .*overdue .*aging|combine high|low balances? but .*old|small balances? but .*old|escalat|responsible for most of my 90)\b/.test(q);
      },
      run: function (person, s, rawQ) {
        var lowFirst = /\blow balances?|small balances?\b/.test(rawQ.toLowerCase());
        var cust = customerRollup(person).filter(function (c) { return c.overdue > 0; });
        cust.forEach(function (c) {
          c.age = weightedAge(c.buckets);
          c.old90 = 0;
          for (var b = 4; b < NB; b++) c.old90 += c.buckets[b];
        });
        var list = lowFirst
          ? cust.filter(function (c) { return c.age > 90; }).sort(function (a, b) { return a.bal - b.bal; })
          : cust.slice().sort(function (a, b) { return (b.bal * b.age) - (a.bal * a.age); });
        return {
          big: money(list.reduce(function (a, c) { return a + c.overdue; }, 0)),
          head: lowFirst ? 'Small balances, long overdue' : 'High value with old overdue',
          note: list.length + ' customer(s). ' + (lowFirst
            ? 'Small amounts sitting past 90 days — often worth writing off or settling quickly.'
            : 'Ranked by balance weighted by how old the overdue is.'),
          rule: lowFirst ? 'average overdue age over 90 days, smallest balance first'
                         : 'balance × average overdue age in days',
          table: ['Customer', 'Avg age', 'Beyond 90d', 'Balance'],
          body: list.slice(0, 20).map(function (c) {
            return [c.name, Math.round(c.age) + ' days', money(c.old90), money(c.bal)];
          }),
          more: list.length > 20 ? list.length - 20 : 0
        };
      }
    },

    // ---- recovery from top overdue customers ----------------------------
    {
      id: 'recover-top',
      test: function (q) { return /\b(could i recover|how much .*recover|recover .*targeting|targeting my top)\b/.test(q); },
      run: function (person, s, rawQ) {
        var m = rawQ.toLowerCase().match(/top\s+(\w+)/);
        var WORD = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };
        var k = m ? (WORD[m[1]] || parseInt(m[1], 10) || 5) : 5;
        var cust = customerRollup(person).filter(function (c) { return c.overdue > 0; })
                    .sort(function (a, b) { return b.overdue - a.overdue; }).slice(0, k);
        var sum = cust.reduce(function (a, c) { return a + c.overdue; }, 0);
        return {
          big: money(sum),
          head: 'Recoverable from your top ' + cust.length + ' overdue customers',
          note: 'That is ' + pct(sum, s.overdue) + ' of your total overdue of ' + money(s.overdue) + '.',
          table: ['Customer', 'Zone', 'Overdue', 'Balance'],
          body: cust.map(function (c) { return [c.name, c.zone, money(c.overdue), money(c.bal)]; }),
          more: 0
        };
      }
    },

    // ---- what-if scenarios ---------------------------------------------
    {
      id: 'whatif',
      test: function (q) { return /\bif (?:i|my|all)\b.*\b(collect|pay|paid|recover)/.test(q); },
      run: function (person, s, rawQ) {
        var lq = rawQ.toLowerCase();
        var removed = 0, what = '';

        var dm = lq.match(/(?:over|more than|beyond|older than)\s+(\d{1,3})\s*days?/);
        var bucketPhrase = lq.match(/(\d{1,3})\s*-\s*(\d{1,3})\s*days?/);
        var topN = lq.match(/top\s+(\w+)\s+/);
        var WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10 };

        if (dm) {
          var n = +dm[1];
          for (var b = 1; b < NB; b++) if (BUCKET_LOWER[b] >= n) removed += s.buckets[b];
          what = 'all overdue beyond ' + n + ' days';
        } else if (bucketPhrase) {
          for (var b2 = 1; b2 < NB; b2++) {
            if (BUCKET_LOWER[b2] >= +bucketPhrase[1] && BUCKET_UPPER[b2] <= +bucketPhrase[2]) {
              removed += s.buckets[b2];
            }
          }
          what = 'the ' + bucketPhrase[1] + '-' + bucketPhrase[2] + ' day bucket';
        } else if (topN) {
          var k = WORD[topN[1]] || parseInt(topN[1], 10) || 3;
          var cs = customerRollup(person).filter(function (c) { return c.overdue > 0; })
                    .sort(function (a, b) { return b.overdue - a.overdue; }).slice(0, k);
          removed = cs.reduce(function (a, c) { return a + c.overdue; }, 0);
          what = 'the top ' + k + ' overdue customers paying their overdue in full';
        } else {
          removed = s.overdue;
          what = 'all overdue';
        }

        var remainOd = s.overdue - removed;
        return {
          big: money(remainOd),
          head: 'Overdue remaining after collecting ' + what,
          note: 'Collecting ' + money(removed) + ' would take overdue from ' + money(s.overdue) +
                ' to ' + money(remainOd) + ', and total outstanding from ' + money(s.balance) +
                ' to ' + money(s.balance - removed) + '. This is arithmetic on today\'s figures, ' +
                'not a forecast.',
          rule: 'remaining = current overdue − amount collected',
          table: ['Measure', 'Now', 'After'],
          body: [
            ['Overdue', money(s.overdue), money(remainOd)],
            ['Total outstanding', money(s.balance), money(s.balance - removed)],
            ['Overdue share of book', pct(s.overdue, s.balance),
             s.balance - removed ? pct(remainOd, s.balance - removed) : '0%'],
          ],
          more: 0
        };
      }
    },

    // ---- customers fully overdue / mixed --------------------------------
    {
      id: 'fully-overdue',
      test: function (q) { return /\bentire (?:outstanding|balance) is overdue|fully overdue|completely overdue\b/.test(q); },
      run: function (person) {
        var cust = customerRollup(person).filter(function (c) {
          return c.bal > 0 && Math.abs(c.overdue - c.bal) < 1;
        }).sort(function (a, b) { return b.bal - a.bal; });
        return {
          big: money(cust.reduce(function (a, c) { return a + c.bal; }, 0)),
          head: cust.length + ' customer(s) with nothing left within terms',
          note: 'Every rupee outstanding with these customers is already past its due date.',
          table: ['Customer', 'Zone', 'Lines', 'Overdue'],
          body: cust.map(function (c) { return [c.name, c.zone, String(c.lines), money(c.overdue)]; }),
          more: 0
        };
      }
    },
    {
      id: 'mixed-buckets',
      test: function (q) { return /\bboth overdue and not.?due|mix of overdue|spread across (?:multiple|several) aging|three or more aging|multiple aging (?:periods|buckets)\b/.test(q); },
      run: function (person, s, rawQ) {
        var wantN = /three or more/.test(rawQ.toLowerCase()) ? 3 : 2;
        var cust = customerRollup(person).map(function (c) {
          c.spread = c.buckets.filter(function (v) { return v !== 0; }).length;
          return c;
        }).filter(function (c) { return c.spread >= wantN; })
          .sort(function (a, b) { return b.spread - a.spread || b.bal - a.bal; });
        return {
          big: String(cust.length),
          head: 'Customers with balances in ' + wantN + '+ ageing buckets',
          note: 'A spread across several buckets usually means repeated part-payment or ' +
                'a rolling account rather than one disputed invoice.',
          table: ['Customer', 'Buckets', 'Overdue', 'Balance'],
          body: cust.slice(0, 20).map(function (c) {
            return [c.name, String(c.spread), money(c.overdue), money(c.bal)];
          }),
          more: cust.length > 20 ? cust.length - 20 : 0
        };
      }
    },

    // ---- overdue percentage per customer --------------------------------
    {
      id: 'overdue-pct-customer',
      test: function (q) { return /\bhighest overdue percentage|overdue percentage relative|worst overdue ratio\b/.test(q); },
      run: function (person) {
        var cust = customerRollup(person).filter(function (c) { return c.bal > 0 && c.overdue > 0; });
        cust.forEach(function (c) { c.ratio = c.overdue / c.bal; });
        cust.sort(function (a, b) { return b.ratio - a.ratio || b.overdue - a.overdue; });
        return {
          big: cust.length ? (cust[0].ratio * 100).toFixed(1) + '%' : '0%',
          head: cust.length ? cust[0].name + ' — highest overdue share' : 'No overdue customers',
          note: 'Share of each customer\'s own balance that is past due.',
          table: ['Customer', 'Overdue %', 'Overdue', 'Balance'],
          body: cust.slice(0, 20).map(function (c) {
            return [c.name, (c.ratio * 100).toFixed(1) + '%', money(c.overdue), money(c.bal)];
          }),
          more: cust.length > 20 ? cust.length - 20 : 0
        };
      }
    },

    // ---- customer detail ------------------------------------------------
    {
      id: 'customer-detail',
      test: function (q) {
        return /\b(complete ar status|ar status of|full status|aging breakup for|ageing breakup for|payment terms (?:are )?assigned|which zone does|customer number for|customer code|corresponds to customer)\b/.test(q);
      },
      run: function (person, s, rawQ) {
        var lq = ' ' + rawQ.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
        var cust = customerRollup(person);

        var code = rawQ.toUpperCase().match(/CUS\d{3,5}/);
        var hit = null;
        if (code) {
          hit = cust.filter(function (c) { return D.customers[c.ci][0] === code[0]; })[0];
        }
        if (!hit) {
          var m = matchCustomers(lq, cust.map(function (c) { return c.ci; }));
          if (m.length) hit = cust.filter(function (c) { return c.ci === m[0].ci; })[0];
        }
        if (!hit) {
          return refuse('Which customer?',
            'Name a customer, for example “AR status of Om Sweets”, or give a code like CUS0007.');
        }

        var rows = [
          ['Customer number', D.customers[hit.ci][0]],
          ['Zone', hit.zone],
          ['Payment terms', Object.keys(hit.terms).join(', ')],
          ['Open documents', String(hit.lines)],
          ['Total balance', money(hit.bal)],
          ['Not due', money(hit.notDue)],
          ['Overdue', money(hit.overdue)],
          ['Status', hit.overdue > 0 ? 'Overdue' : 'Within terms'],
          ['Oldest due date', hit.oldestDue ? fmtDate(hit.oldestDue) : '—'],
        ];
        for (var b = 0; b < NB; b++) {
          if (hit.buckets[b] !== 0) rows.push([D.bucketLabels[b], money(hit.buckets[b])]);
        }
        return {
          big: money(hit.bal),
          head: hit.name,
          note: hit.overdue > 0
            ? money(hit.overdue) + ' of this is past due (' + pct(hit.overdue, hit.bal) + ').'
            : 'Nothing past due — this account is within its credit terms.',
          table: ['Field', 'Value'],
          body: rows,
          more: 0
        };
      }
    },

    // ---- compare two customers ------------------------------------------
    {
      id: 'compare-customers',
      test: function (q) { return /\bcompare\b/.test(q) && /\band\b/.test(q); },
      run: function (person, s, rawQ) {
        var lq = ' ' + rawQ.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
        var cust = customerRollup(person);
        var parts = lq.split(/\band\b/);
        var picked = [];
        parts.forEach(function (part) {
          var m = matchCustomers(' ' + part.trim() + ' ', cust.map(function (c) { return c.ci; }));
          if (m.length) {
            var c = cust.filter(function (x) { return x.ci === m[0].ci; })[0];
            if (c && picked.indexOf(c) === -1) picked.push(c);
          }
        });
        if (picked.length < 2) {
          return refuse('Name two customers',
            'Try “compare Aayu Food Product and Om Sweets”. Both names must be in your book.');
        }
        var a = picked[0], b = picked[1];
        return {
          big: money(a.bal - b.bal),
          head: a.name + ' vs ' + b.name,
          note: (a.bal >= b.bal ? a.name : b.name) + ' carries the larger balance, by ' +
                money(Math.abs(a.bal - b.bal)) + '.',
          table: ['Measure', a.name, b.name],
          body: [
            ['Balance', money(a.bal), money(b.bal)],
            ['Not due', money(a.notDue), money(b.notDue)],
            ['Overdue', money(a.overdue), money(b.overdue)],
            ['Overdue %', a.bal ? pct(a.overdue, a.bal) : '—', b.bal ? pct(b.overdue, b.bal) : '—'],
            ['Open documents', String(a.lines), String(b.lines)],
            ['Zone', a.zone, b.zone],
            ['Payment terms', Object.keys(a.terms).join(', '), Object.keys(b.terms).join(', ')],
            ['Oldest due', a.oldestDue ? fmtDate(a.oldestDue) : '—', b.oldestDue ? fmtDate(b.oldestDue) : '—'],
          ],
          more: 0
        };
      }
    },

    // ---- upcoming due ----------------------------------------------------
    {
      id: 'upcoming',
      test: function (q) {
        return /\b(due next|next \d+ days|becoming due|coming due|due soon|before their due date|upcoming due|calendar)\b/.test(q);
      },
      run: function (person, s, rawQ) {
        var lq = rawQ.toLowerCase();
        var nm = lq.match(/next\s+(\d{1,3})\s*days?/);
        var win = nm ? +nm[1] : 30;
        var base = D.reportDate;
        var rows = person.lines.filter(function (ln) {
          if (!ln[L.DUE] || ln[L.BAL] <= 0) return false;
          var d = daysBetween(ln[L.DUE], base);
          return d >= 0 && d <= win;
        }).sort(function (a, b) { return a[L.DUE] < b[L.DUE] ? -1 : 1; });
        var tot = rows.reduce(function (a, ln) { return a + ln[L.BAL]; }, 0);
        return {
          big: money(tot),
          head: 'Falling due within ' + win + ' days of ' + fmtDate(base),
          note: rows.length
            ? rows.length + ' document(s), earliest ' + fmtDate(rows[0][L.DUE]) + '.'
            : 'Nothing falls due in that window.',
          table: ['Customer', 'Document', 'Due date', 'Amount'],
          body: rows.slice(0, 25).map(function (ln) {
            return [D.customers[ln[L.CUST]][1], ln[L.DOC], fmtDate(ln[L.DUE]), money(ln[L.BAL])];
          }),
          more: rows.length > 25 ? rows.length - 25 : 0
        };
      }
    },

    // ---- aging profile ---------------------------------------------------
    {
      id: 'aging-profile',
      test: function (q) {
        return /\b(complete aging|full aging|aging breakup of my|ageing breakup of my|aging profile|which aging bucket|largest aging bucket|average age of my|fresh versus|fresh vs)\b/.test(q);
      },
      run: function (person, s) {
        var act = [];
        for (var b = 0; b < NB; b++) if (s.buckets[b] !== 0) act.push(b);
        var biggest = act.slice().sort(function (a, b) { return Math.abs(s.buckets[b]) - Math.abs(s.buckets[a]); })[0];
        var fresh = s.notDue + s.buckets[1];
        var aged = 0;
        for (var b2 = 4; b2 < NB; b2++) aged += s.buckets[b2];
        return {
          big: money(s.balance),
          head: 'Ageing profile — largest bucket is ' + (biggest != null ? D.bucketLabels[biggest] : 'n/a'),
          note: 'Fresh (not due or under a month) ' + money(fresh) + '. ' +
                'Seriously aged (beyond 90 days) ' + money(aged) + '. ' +
                'Average overdue age ' + Math.round(weightedAge(s.buckets)) + ' days, weighted by amount.',
          table: ['Bucket', 'Amount', 'Share of book'],
          body: act.map(function (b) {
            return [D.bucketLabels[b], money(s.buckets[b]), pct(s.buckets[b], s.balance)];
          }),
          more: 0
        };
      }
    },

    // ---- outliers --------------------------------------------------------
    {
      id: 'outliers',
      test: function (q) {
        if (/\bnegative\b/.test(q)) return false;   // that is a data-quality question
        return /\bunusually (?:large|big|high)|outlier|unusual(?:ly)? .*(?:balance|amount)|stands? out|abnormal\b/.test(q);
      },
      run: function (person) {
        var vals = person.lines.filter(function (ln) { return ln[L.BAL] > 0; });
        if (!vals.length) return { big: '0', head: 'No positive balances', note: '', table: [], body: [], more: 0 };
        var amts = vals.map(function (ln) { return ln[L.BAL]; });
        var mean = amts.reduce(function (a, b) { return a + b; }, 0) / amts.length;
        var sd = Math.sqrt(amts.reduce(function (a, v) { return a + (v - mean) * (v - mean); }, 0) / amts.length);
        var cut = mean + 2 * sd;
        var out = vals.filter(function (ln) { return ln[L.BAL] > cut; })
                      .sort(function (a, b) { return b[L.BAL] - a[L.BAL]; });
        return {
          big: String(out.length),
          head: 'Documents far larger than the rest',
          note: 'Average open document is ' + money(mean) + '. These sit above ' + money(cut) +
                ' — more than two standard deviations from the average.',
          rule: 'balance greater than mean + 2 × standard deviation',
          table: ['Customer', 'Document', 'Due date', 'Balance'],
          body: out.slice(0, 20).map(function (ln) {
            return [D.customers[ln[L.CUST]][1], ln[L.DOC], fmtDate(ln[L.DUE]), money(ln[L.BAL])];
          }),
          more: out.length > 20 ? out.length - 20 : 0
        };
      }
    },

    // ---- data quality ----------------------------------------------------
    {
      id: 'data-quality',
      test: function (q) {
        return /\b(data.?quality|missing (?:salesperson|zone|zones)|blank|duplicate document|does not reconcile|reconcile with the aging|inconsistent zone|anomal)\b/.test(q);
      },
      run: function (person) {
        var issues = [];
        var docs = {}, dupes = 0;
        var badSum = 0, negBucket = 0, noZone = 0, noTerms = 0, noDue = 0;
        person.lines.forEach(function (ln) {
          if (docs[ln[L.DOC]]) dupes++; else docs[ln[L.DOC]] = 1;
          var sum = 0;
          for (var b = 0; b < NB; b++) {
            sum += ln[L.B0 + b];
            if (ln[L.B0 + b] < 0) negBucket++;
          }
          if (Math.abs(sum - ln[L.BAL]) > 1) badSum++;
          if (!D.customers[ln[L.CUST]][2]) noZone++;
          if (D.terms[ln[L.TERM]] === 'Not set') noTerms++;
          if (!ln[L.DUE]) noDue++;
        });
        issues.push(['Buckets not matching balance', String(badSum), badSum ? 'check these rows' : 'all reconcile']);
        issues.push(['Duplicate document numbers', String(dupes), dupes ? 'investigate' : 'none']);
        issues.push(['Negative amounts in buckets', String(negBucket), negBucket ? 'credits applied to a period' : 'none']);
        issues.push(['Missing zone', String(noZone), noZone ? 'fix at source' : 'none']);
        issues.push(['Payment terms not set', String(noTerms), noTerms ? 'fix at source' : 'none']);
        issues.push(['Missing due date', String(noDue), noDue ? 'ageing may be wrong' : 'none']);
        var bad = badSum + dupes + noZone + noTerms + noDue;
        return {
          big: String(bad),
          head: bad ? 'Data issues found in your book' : 'No data issues found',
          note: 'Checks run over your ' + person.lines.length + ' open documents.',
          table: ['Check', 'Count', 'Note'],
          body: issues,
          more: 0
        };
      }
    },

    // ---- original vs balance ---------------------------------------------
    {
      id: 'original-vs-balance',
      test: function (q) {
        return /\b(original .*(?:versus|vs|against).*balance|balance .*(?:versus|vs).*original|partially outstanding|part.?paid)\b/.test(q)
            || /\balready been (?:adjusted|received|recovered|collected)\b/.test(q)
            || /\bhas already been\b/.test(q) && /\boriginal\b/.test(q)
            || /\boriginal amount\b/.test(q) && /\b(adjusted|received|recovered|collected)\b/.test(q);
      },
      run: function (person, s, rawQ) {
        if (/partially|part.?paid/.test(rawQ.toLowerCase())) {
          var part = person.lines.filter(function (ln) {
            return ln[L.ORIG] > 0 && ln[L.BAL] > 0 && ln[L.BAL] < ln[L.ORIG] - 1;
          }).sort(function (a, b) { return (b[L.ORIG] - b[L.BAL]) - (a[L.ORIG] - a[L.BAL]); });
          return {
            big: String(part.length),
            head: 'Partially settled documents',
            note: 'Original value exceeds the remaining balance, so a part-payment has been applied.',
            table: ['Customer', 'Document', 'Original', 'Still open'],
            body: part.slice(0, 25).map(function (ln) {
              return [D.customers[ln[L.CUST]][1], ln[L.DOC], money(ln[L.ORIG]), money(ln[L.BAL])];
            }),
            more: part.length > 25 ? part.length - 25 : 0
          };
        }
        var recovered = s.original - s.balance;
        return {
          big: money(recovered),
          head: 'Already adjusted or received',
          note: 'Original billed ' + money(s.original) + ' against ' + money(s.balance) +
                ' still open — ' + pct(recovered, s.original) + ' of the original value has been settled.',
          table: ['Measure', 'Amount'],
          body: [
            ['Original billed', money(s.original)],
            ['Still outstanding', money(s.balance)],
            ['Settled or adjusted', money(recovered)],
          ],
          more: 0
        };
      }
    },
  ];

  function tryHandlers(rawQ, person, s) {
    var q = ' ' + rawQ.toLowerCase().replace(/[^a-z0-9%+\s.-]/g, ' ').replace(/\s+/g, ' ') + ' ';
    for (var i = 0; i < HANDLERS.length; i++) {
      try {
        if (HANDLERS[i].test(q)) return HANDLERS[i].run(person, s, rawQ);
      } catch (e) {
        return null;   // fall through to the generic parser
      }
    }
    return null;
  }

  function parseQuestion(rawQ, person, s) {
    var q = ' ' + rawQ.toLowerCase().replace(/[^a-z0-9+\-\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
    var f = { chips: [], buckets: null, custIds: null, zone: null, term: null,
              sign: null, sort: null, topN: 0, groupByCustomer: false, countOnly: false };
    var understood = false;

    // ---- ageing threshold: "over 90 days", "90+ days", "more than 60 days"
    // "between 30 and 90 days" must be read before the single-sided forms,
    // otherwise "between 30 and 90 days" matches nothing and the range is lost.
    var dayRange = q.match(/between\s+(\d{1,3})\s*(?:and|to|-)\s*(\d{1,3})\s*days?/);
    var over = q.match(/(?:over|more than|beyond|older than|greater than|above|past)\s+(\d{1,3})\s*(?:\+)?\s*days?/) ||
               q.match(/(\d{1,3})\s*\+\s*days?/);
    var under = q.match(/(?:under|less than|within|below|inside)\s+(\d{1,3})\s*days?/);

    if (dayRange) {
      var dlo = Math.min(+dayRange[1], +dayRange[2]);
      var dhi = Math.max(+dayRange[1], +dayRange[2]);
      var bsr = [];
      for (var br = 1; br < NB; br++) {
        if (BUCKET_LOWER[br] >= dlo && BUCKET_UPPER[br] <= dhi) bsr.push(br);
      }
      if (bsr.length) {
        f.buckets = bsr;
        f.chips.push('between ' + dlo + ' and ' + dhi + ' days past due');
        understood = true;
      }
    } else if (over) {
      var n = +over[1], bs = [];
      for (var b = 1; b < NB; b++) if (BUCKET_LOWER[b] >= n) bs.push(b);
      if (bs.length) { f.buckets = bs; f.chips.push('more than ' + n + ' days past due'); understood = true; }
    } else if (under) {
      var u = +under[1], bs2 = [];
      for (var b2 = 1; b2 < NB; b2++) if (BUCKET_UPPER[b2] <= u) bs2.push(b2);
      if (bs2.length) { f.buckets = bs2; f.chips.push('under ' + u + ' days past due'); understood = true; }
    }

    // ---- overdue / not due
    if (!f.buckets) {
      if (/\b(not due|notdue|not yet due|current|undue)\b/.test(q)) {
        f.buckets = [0]; f.chips.push('not due'); understood = true;
      } else if (/\b(overdue|over due|past due|late|delayed|pending|pending payment|outstanding overdue|not paid|unpaid|non[- ]?paying|defaulter|defaulters|chase|risky|stuck|recover|collect from)\b/.test(q)) {
        f.buckets = []; for (var b3 = 1; b3 < NB; b3++) f.buckets.push(b3);
        f.chips.push('overdue only'); understood = true;
      }
    }

    // ---- named bucket, e.g. "after 243", "1-31"
    if (!f.buckets) {
      for (var b4 = 0; b4 < NB; b4++) {
        var key = D.bucketLabels[b4].toLowerCase().replace(/\s*days?\s*/g, ' ').trim();
        if (key && q.indexOf(key) !== -1) {
          f.buckets = [b4]; f.chips.push(D.bucketLabels[b4]); understood = true; break;
        }
      }
    }

    // ---- customer
    var custIds = Object.keys(s.byCust);
    var hits = matchCustomers(q, custIds);
    if (hits.length) {
      var top = hits[0].score;
      var chosen = hits.filter(function (h) { return h.score === top; });
      f.custIds = chosen.map(function (h) { return h.ci; });
      f.chips.push(chosen.length === 1
        ? 'customer: ' + D.customers[f.custIds[0]][1]
        : chosen.length + ' matching customers');
      understood = true;
    }

    // ---- zone
    var zones = {};
    person.lines.forEach(function (ln) { zones[D.customers[ln[L.CUST]][2]] = 1; });
    Object.keys(zones).forEach(function (z) {
      if (!f.zone && q.indexOf(z.toLowerCase()) !== -1) {
        f.zone = z; f.chips.push('zone: ' + z); understood = true;
      }
    });

    // ---- payment terms (longest label first, so "30D INV" wins over "30D")
    D.terms.slice().sort(function (a, b) { return b.length - a.length; }).forEach(function (t) {
      if (f.term) return;
      var tl = t.toLowerCase();
      if (tl !== 'not set' && new RegExp('(^| )' + tl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)').test(q)) {
        f.term = t; understood = true;
        // "30D" alone would exclude "30D INV" and report zero, which reads as
        // "nobody is on 30-day terms". Treat a bare code as a family prefix.
        var family = D.terms.filter(function (o) {
          return o.toLowerCase() === tl || o.toLowerCase().indexOf(tl + ' ') === 0;
        });
        if (family.length > 1) {
          f.termFamily = family;
          f.chips.push('terms: ' + family.join(' + '));
        } else {
          f.chips.push('terms: ' + t);
        }
      }
    });

    // ---- sign
    if (/\b(credit|credits|credit note|negative|advance|advances|refund|overpaid|overpayment)\b/.test(q)) {
      f.sign = 'neg'; f.chips.push('credits only'); understood = true;
    }

    // ---- ordering
    if (/\b(oldest|earliest|longest|first)\b/.test(q)) { f.sort = 'oldest'; f.chips.push('oldest first'); understood = true; }
    else if (/\b(newest|latest|recent|most recent)\b/.test(q)) { f.sort = 'newest'; f.chips.push('newest first'); understood = true; }
    else if (/\b(largest|biggest|highest|most|top|worst|maximum|max)\b/.test(q)) { f.sort = 'largest'; understood = true; }
    else if (/\b(smallest|lowest|least|minimum|min)\b/.test(q)) { f.sort = 'smallest'; understood = true; }


    // ---- top N
    var tn = q.match(/\btop\s+(\d{1,3})\b/);
    if (tn) { f.topN = +tn[1]; f.chips.push('top ' + f.topN); understood = true; }

    var bn = q.match(/\b(?:bottom|last|lowest|smallest)\s+(\d{1,3})\b/);
    if (bn) {
      f.topN = +bn[1];
      f.sort = 'smallest';
      f.chips.push('bottom ' + f.topN);
      understood = true;
    } else if (/\bbottom\b/.test(q)) {
      f.sort = 'smallest'; f.chips.push('smallest first'); understood = true;
    }

    // ---- group by zone / payment terms / customer
    if (/\bzones?\b/.test(q) && !f.zone) {
      f.groupBy = 'zone'; understood = true;
    } else if (/\b(payment\s*)?terms?\b/.test(q) && !f.term) {
      f.groupBy = 'term'; understood = true;
    } else if (/\b(customers?|clients?|parties|accounts?|distributors?|defaulters?|payers?)\b/.test(q) &&
               !/\b(invoice|document|bill|line)\b/.test(q)) {
      f.groupBy = 'customer'; f.groupByCustomer = true; understood = true;
    }

    // ---- due-date period: "due in september", "due this month", "due in 2026"
    var MONTHS = ['january','february','march','april','may','june','july',
                  'august','september','october','november','december'];
    for (var mi = 0; mi < 12; mi++) {
      var m3 = MONTHS[mi].slice(0, 3);
      var mRe = new RegExp('(^| )(before|after|until|till|upto|up to|by|from|since)?\\s*(' +
                           MONTHS[mi] + '|' + m3 + ')( |$)');
      var mm = q.match(mRe);
      if (mm) {
        var Mname = MONTHS[mi].charAt(0).toUpperCase() + MONTHS[mi].slice(1);
        var dir = (mm[2] || '').trim();
        if (dir === 'before' || dir === 'until' || dir === 'till' ||
            dir === 'upto' || dir === 'up to' || dir === 'by') {
          f.dueBefore = mi + 1;
          f.chips.push('due before ' + Mname);
        } else if (dir === 'after' || dir === 'from' || dir === 'since') {
          f.dueAfter = mi + 1;
          f.chips.push('due from ' + Mname + ' onwards');
        } else {
          f.dueMonth = mi + 1;
          f.chips.push('due in ' + Mname);
        }
        understood = true;
        break;
      }
    }
    var yr = q.match(/(^| )(20\d\d)( |$)/);
    if (yr) { f.dueYear = +yr[2]; f.chips.push('due in ' + yr[2]); understood = true; }

    if (/\b(this month|current month)\b/.test(q)) {
      var rd = (D.reportDate || '').split('-');
      if (rd.length === 3) {
        f.dueYear = +rd[0]; f.dueMonth = +rd[1];
        f.chips.push('due in the report month');
        understood = true;
      }
    }

    // ---- aggregate style
    if (/\b(average|avg|mean)\b/.test(q)) { f.aggregate = 'average'; understood = true; }
    else if (/\b(percent|percentage|share|proportion)\b/.test(q)) { f.aggregate = 'percent'; understood = true; }

    // ---- catch-all: a plain request for everything
    if (!understood && /\b(all|everything|total|balance|outstanding|book|list|show|summary|exposure|owes?|owed|owe|due|details?|position|status|receivable|receivables)\b/.test(q)) {
      understood = true;   // no filters — answer over the whole book
    }

    // ---- amount threshold: "less than 1000", "over ₹50,000", "above 1 lakh"
    // Runs AFTER the day-threshold rules so "over 90 days" is never read as money.
    // Remove any "<n> days" phrase first — otherwise "over 90 days" leaves a
    // stray digit that the money matcher below would read as an amount.
    var qMoney = q.replace(/\d{1,4}\s*\+?\s*days?\b/g, ' ');
    qMoney = qMoney.replace(/(\d[\d,]*)\s*(?:lakh|lac|l)\b/g, function (_, n) {
      return String(Math.round(parseFloat(n.replace(/,/g, '')) * 100000));
    }).replace(/(\d[\d,]*(?:\.\d+)?)\s*(?:crore|cr)\b/g, function (_, n) {
      return String(Math.round(parseFloat(n.replace(/,/g, '')) * 10000000));
    });

    var amtLess = qMoney.match(/(?:less than|under|below|smaller than|upto|up to|at most|within)\s*(?:rs\.?|inr)?\s*(\d[\d,]*)(?!\s*(?:days?|day))/);
    var amtMore = qMoney.match(/(?:more than|over|above|greater than|exceeding|at least|bigger than)\s*(?:rs\.?|inr)?\s*(\d[\d,]*)(?!\s*(?:days?|day))/);

    var amtBetween = qMoney.match(/between\s*(?:rs\.?|inr)?\s*(\d[\d,]*)\s*(?:and|to|-)\s*(?:rs\.?|inr)?\s*(\d[\d,]*)/);
    if (amtBetween) {
      var lo = parseFloat(amtBetween[1].replace(/,/g, ''));
      var hi = parseFloat(amtBetween[2].replace(/,/g, ''));
      f.amtMin = Math.min(lo, hi);
      f.amtMax = Math.max(lo, hi);
      f.chips.push('between ' + money(f.amtMin) + ' and ' + money(f.amtMax));
      understood = true;
    }

    if (!amtBetween && amtLess) {
      f.amtMax = parseFloat(amtLess[1].replace(/,/g, ''));
      f.chips.push('below ' + money(f.amtMax));
      understood = true;
    }
    if (!amtBetween && amtMore) {
      f.amtMin = parseFloat(amtMore[1].replace(/,/g, ''));
      f.chips.push('above ' + money(f.amtMin));
      understood = true;
    }

    // ---- count vs total
    if (/\b(how many|number of|count)\b/.test(q)) { f.countOnly = true; understood = true; }

    // A superlative asked without a count, an explicit "top N", or a summing word
    // is a question about ONE record, so the headline should be that record
    // rather than the total of everything matched.
    // Grouped queries have their own superlative branch (naming one customer),
    // so grouping no longer blocks this — only an explicit count, an explicit
    // "top N"/"bottom N", or a summing word does.
    if ((f.sort === 'oldest' || f.sort === 'newest' || f.sort === 'largest' || f.sort === 'smallest') &&
        !f.countOnly && !f.topN &&
        !/\b(total|sum|altogether|overall|how much|value of|list|all|breakup|breakdown|wise)\b/.test(q)) {
      f.superlative = true;
    }

    // ---- what did we fail to use?
    // Numbers and comparison words are the parts most likely to carry a
    // condition. If one is present but nothing consumed it, say so rather than
    // answering a narrower question than was asked.
    var ignored = [];
    var strippedNums = qMoney;   // day phrases are already removed from qMoney
    if (f.topN) strippedNums = strippedNums.replace(/top\s+\d{1,3}/g, ' ');
    if (f.amtMax != null) strippedNums = strippedNums.replace(String(f.amtMax), ' ');
    if (f.amtMin != null) strippedNums = strippedNums.replace(String(f.amtMin), ' ');
    if (f.term) strippedNums = strippedNums.replace(new RegExp(f.term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), ' ');
    if (f.custIds) {
      f.custIds.forEach(function (ci) {
        strippedNums = strippedNums.replace(D.customers[ci][1].toLowerCase(), ' ');
      });
    }
    var leftoverNum = strippedNums.match(/(?<![a-z0-9\/-])\d[\d,]*(?:\.\d+)?(?![\d\/-])/);
    if (leftoverNum) ignored.push('the number “' + leftoverNum[0].trim() + '”');

    if (/\b(less than|more than|under|over|above|below|at least|at most|between)\b/.test(q) &&
        !over && !under && f.amtMax == null && f.amtMin == null && !f.topN) {
      ignored.push('a comparison it could not attach to a value');
    }

    f.ignored = ignored;

    return { f: f, understood: understood };
  }

  function sortForDisplay(lines, amountOf, f) {
    var out = lines.slice();
    if (f.sort === 'oldest') out.sort(function (a, b) { return (a[L.DUE] || '') < (b[L.DUE] || '') ? -1 : 1; });
    else if (f.sort === 'newest') out.sort(function (a, b) { return (a[L.DUE] || '') > (b[L.DUE] || '') ? -1 : 1; });
    else if (f.sort === 'smallest') out.sort(function (a, b) { return amountOf(a) - amountOf(b); });
    else out.sort(function (a, b) { return amountOf(b) - amountOf(a); });
    return out;
  }

  function runQuery(f, person, s) {
    var buckets = f.buckets;

    var lines = person.lines.filter(function (ln) {
      if (f.custIds && f.custIds.indexOf(ln[L.CUST]) === -1) return false;
      if (f.zone && D.customers[ln[L.CUST]][2] !== f.zone) return false;
      if (f.termFamily) {
        if (f.termFamily.indexOf(D.terms[ln[L.TERM]]) === -1) return false;
      } else if (f.term && D.terms[ln[L.TERM]] !== f.term) return false;
      if (f.dueMonth || f.dueYear || f.dueBefore || f.dueAfter) {
        var dd = (ln[L.DUE] || '').split('-');
        if (dd.length !== 3) return false;
        if (f.dueYear && +dd[0] !== f.dueYear) return false;
        if (f.dueMonth && +dd[1] !== f.dueMonth) return false;
        // "before/after <month>" compares on year-month against the report year.
        var rY = +((D.reportDate || '').split('-')[0] || dd[0]);
        var ym = +dd[0] * 12 + +dd[1];
        if (f.dueBefore && !(ym < rY * 12 + f.dueBefore)) return false;
        if (f.dueAfter && !(ym >= rY * 12 + f.dueAfter)) return false;
      }
      if (buckets) {
        var v = 0;
        buckets.forEach(function (b) { v += ln[L.B0 + b]; });
        if (v === 0) return false;
      }
      var amt = buckets ? buckets.reduce(function (a, b) { return a + ln[L.B0 + b]; }, 0) : ln[L.BAL];
      if (f.sign === 'neg' && amt >= 0) return false;
      // Line-level amount filter. Skipped when grouping by customer, where the
      // threshold is applied to each customer's total instead.
      if (!f.groupByCustomer) {
        if (f.amtMax != null && !(amt < f.amtMax)) return false;
        if (f.amtMin != null && !(amt > f.amtMin)) return false;
      }
      return true;
    });

    function amountOf(ln) {
      return buckets ? buckets.reduce(function (a, b) { return a + ln[L.B0 + b]; }, 0) : ln[L.BAL];
    }

    var total = lines.reduce(function (a, ln) { return a + amountOf(ln); }, 0);
    var measure = buckets
      ? (buckets.length === 1 ? D.bucketLabels[buckets[0]] : 'Filtered balance')
      : 'Balance';

    // ---- aggregates that are not a filtered list
    if (f.aggregate === 'average' && lines.length) {
      return {
        big: money(total / lines.length),
        head: 'Average per invoice line',
        note: money(total) + ' across ' + lines.length + ' line(s).',
        table: ['Customer', 'Document', 'Due date', measure],
        body: sortForDisplay(lines, amountOf, f).slice(0, 25).map(function (ln) {
          return [D.customers[ln[L.CUST]][1], ln[L.DOC], fmtDate(ln[L.DUE]), money(amountOf(ln))];
        }),
        more: lines.length > 25 ? lines.length - 25 : 0,
        empty: false
      };
    }
    if (f.aggregate === 'percent') {
      return {
        big: pct(total, s.balance),
        head: 'Share of your total book',
        note: money(total) + ' of ' + money(s.balance) + ', across ' + lines.length + ' line(s).',
        table: [], body: [], more: 0, empty: false
      };
    }

    // ---- grouped by zone or payment terms
    if (f.groupBy === 'zone' || f.groupBy === 'term') {
      var byKey = {};
      lines.forEach(function (ln) {
        var k = f.groupBy === 'zone' ? D.customers[ln[L.CUST]][2] : D.terms[ln[L.TERM]];
        (byKey[k] = byKey[k] || { bal: 0, lines: 0, custs: {} });
        byKey[k].bal += amountOf(ln);
        byKey[k].lines++;
        byKey[k].custs[ln[L.CUST]] = 1;
      });
      var krows = Object.keys(byKey).map(function (k) {
        return { k: k, bal: byKey[k].bal, lines: byKey[k].lines,
                 custs: Object.keys(byKey[k].custs).length };
      }).sort(function (a, b) {
        return f.sort === 'smallest' ? a.bal - b.bal : b.bal - a.bal;
      });
      var label = f.groupBy === 'zone' ? 'Zone' : 'Payment terms';
      return {
        big: krows.length ? money(krows[0].bal) : money(0),
        head: krows.length ? (label + ' with the most: ' + krows[0].k) : 'Nothing to group',
        note: krows.length
          ? measure + ' totals ' + money(total) + ' across ' + krows.length + ' ' +
            label.toLowerCase() + ' value(s).'
          : 'No matching lines.',
        table: [label, 'Customers', 'Lines', measure],
        body: krows.map(function (r) {
          return [r.k, String(r.custs), String(r.lines), money(r.bal)];
        }),
        more: 0,
        empty: !krows.length
      };
    }

    // ---- grouped by customer
    if (f.groupByCustomer) {
      var g = {};
      lines.forEach(function (ln) {
        var k = ln[L.CUST];
        (g[k] = g[k] || { bal: 0, lines: 0 });
        g[k].bal += amountOf(ln); g[k].lines++;
      });
      var rows = Object.keys(g).map(function (ci) {
        return { c: D.customers[ci], bal: g[ci].bal, lines: g[ci].lines };
      });
      // An amount condition in a question about customers applies to each
      // customer's total, not to individual invoice lines.
      if (f.amtMax != null) rows = rows.filter(function (r) { return r.bal < f.amtMax; });
      if (f.amtMin != null) rows = rows.filter(function (r) { return r.bal > f.amtMin; });
      total = rows.reduce(function (a, r) { return a + r.bal; }, 0);
      rows.sort(function (a, b) {
        return f.sort === 'smallest' ? a.bal - b.bal : b.bal - a.bal;
      });
      var limit = f.topN || 15;
      // "biggest defaulter", "worst customer" — name the customer, don't show
      // the whole book's total as though it were one customer's.
      if (f.superlative && rows.length && !f.countOnly) {
        return {
          big: money(rows[0].bal),
          head: rows[0].c[1],
          note: rows[0].c[2] + ' · ' + rows[0].lines + ' line(s) · ' +
                pct(rows[0].bal, s.balance) + ' of your book. Others follow, same order.',
          table: ['Customer', 'Zone', 'Lines', measure],
          body: rows.slice(0, limit).map(function (r) {
            return [r.c[1], r.c[2], String(r.lines), money(r.bal)];
          }),
          more: rows.length > limit ? rows.length - limit : 0,
          empty: false
        };
      }
      return {
        big: f.countOnly ? String(rows.length) : money(total),
        head: f.countOnly ? 'Customers matching' : measure + ' across ' + rows.length + ' customer(s)',
        note: rows.length
          ? 'Covering ' + lines.length + ' invoice line(s).'
          : 'No customers match that.',
        table: ['Customer', 'Zone', 'Lines', measure],
        body: rows.slice(0, limit).map(function (r) {
          return [r.c[1], r.c[2], String(r.lines), money(r.bal)];
        }),
        more: rows.length > limit ? rows.length - limit : 0,
        empty: !rows.length
      };
    }

    // ---- line level
    var sorted = lines.slice();
    if (f.sort === 'oldest') sorted.sort(function (a, b) { return (a[L.DUE] || '') < (b[L.DUE] || '') ? -1 : 1; });
    else if (f.sort === 'newest') sorted.sort(function (a, b) { return (a[L.DUE] || '') > (b[L.DUE] || '') ? -1 : 1; });
    else if (f.sort === 'smallest') sorted.sort(function (a, b) { return amountOf(a) - amountOf(b); });
    else sorted.sort(function (a, b) { return amountOf(b) - amountOf(a); });

    var lim = f.topN || 25;

    // Superlative: answer with the single top record, then list the rest for context.
    if (f.superlative && sorted.length) {
      var one = sorted[0];
      return {
        big: money(amountOf(one)),
        // Name the record as an invoice, not just a customer — otherwise a
        // single line's amount reads as that customer's whole balance.
        head: D.customers[one[L.CUST]][1] + ' — one invoice',
        note: 'Document ' + one[L.DOC] + ', due ' + fmtDate(one[L.DUE]) + '. ' +
          (sorted.length > 1 ? 'The rest of the matching lines follow, in the same order.'
                             : 'The only line matching.'),
        table: ['Customer', 'Document', 'Due date', measure],
        body: sorted.slice(0, lim).map(function (ln) {
          return [D.customers[ln[L.CUST]][1], ln[L.DOC], fmtDate(ln[L.DUE]), money(amountOf(ln))];
        }),
        more: sorted.length > lim ? sorted.length - lim : 0,
        empty: false
      };
    }

    return {
      big: f.countOnly ? String(lines.length) : money(total),
      head: f.countOnly ? 'Invoice lines matching' : measure,
      note: lines.length
        ? lines.length + ' invoice line(s)' +
          (s.balance ? ' · ' + pct(total, s.balance) + ' of your book' : '') + '.'
        : 'Nothing in your book matches that.',
      table: ['Customer', 'Document', 'Due date', measure],
      body: sorted.slice(0, lim).map(function (ln) {
        return [D.customers[ln[L.CUST]][1], ln[L.DOC], fmtDate(ln[L.DUE]), money(amountOf(ln))];
      }),
      more: lines.length > lim ? lines.length - lim : 0,
      empty: !lines.length
    };
  }

  // ================================================================
  // AI question understanding
  //
  // The model never produces a number. It reads the question and returns a
  // filter spec — the same shape parseQuestion builds — and runQuery then
  // executes that spec against the real invoice lines. Every figure on screen
  // is still computed here, locally; the model only decides WHICH lines to
  // compute over, and its interpretation is shown back as chips.
  //
  // When the model is switched off, slow, rate-limited or returns something
  // unusable, the built-in parser answers instead and the card says so.
  // ================================================================

  // Overwritten from /api/ask/status, so the server's ASK_TIMEOUT_SECONDS is
  // the single place this is configured. The value here only covers the
  // window before that first status call returns.
  var aiTimeoutMs = 15000;
  var aiEnabled = null;        // null until /api/ask/status has been checked

  function aiStatus() {
    if (aiEnabled !== null) return Promise.resolve(aiEnabled);
    return fetch('/api/ask/status', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { enabled: false }; })
      .then(function (j) {
        aiEnabled = !!j.enabled;
        if (j.timeoutMs > 0) aiTimeoutMs = j.timeoutMs;
        return aiEnabled;
      })
      .catch(function () { aiEnabled = false; return false; });
  }

  // ---- model selection
  // '' means Auto: the server walks its preference order and skips any model
  // whose quota is spent. A specific id pins the question to that model.
  var MODEL_STORE_KEY = 'nsd.askModel';
  var chosenModel = '';
  try { chosenModel = window.localStorage.getItem(MODEL_STORE_KEY) || ''; } catch (e) { chosenModel = ''; }

  function rememberModel(id) {
    chosenModel = id || '';
    try { window.localStorage.setItem(MODEL_STORE_KEY, chosenModel); } catch (e) { /* private mode */ }
  }

  function loadModels() {
    return fetch('/api/ask/models', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { enabled: false, models: [] }; })
      .catch(function () { return { enabled: false, models: [] }; });
  }

  // Resolves to { spec, model }, or null when the built-in parser should take
  // over. Never rejects — a failure here must not break the Ask box.
  function askAI(text, person) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, aiTimeoutMs);
    return fetch('/api/ask', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: text, salesperson: person.ix, model: chosenModel }),
      signal: ctl.signal
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        return (j && j.ok && j.spec) ? { spec: j.spec, model: j.model } : null;
      })
      .catch(function () { return null; })
      .then(function (out) { clearTimeout(timer); return out; });
  }

  // Turn the validated spec into the filter object runQuery already understands,
  // and describe it in chips. The chips are built HERE, from the fields that
  // will actually be applied — never from anything the model wrote — so the
  // "Read as" line can never describe a filter the query did not run.
  function specToFilter(spec) {
    var f = { chips: [], buckets: null, custIds: null, zone: null, term: null,
              sign: null, sort: null, topN: 0, groupByCustomer: false, countOnly: false };

    if (spec.buckets && spec.buckets.length) {
      f.buckets = spec.buckets;
      var allOverdue = spec.buckets.length === NB - 1 && spec.buckets.indexOf(0) === -1;
      if (allOverdue) f.chips.push('overdue only');
      else if (spec.buckets.length === 1 && spec.buckets[0] === 0) f.chips.push('not due');
      else f.chips.push(spec.buckets.map(function (b) { return D.bucketLabels[b]; }).join(' + '));
    }

    if (spec.custIds && spec.custIds.length) {
      f.custIds = spec.custIds;
      f.chips.push(spec.custIds.length === 1
        ? 'customer: ' + D.customers[spec.custIds[0]][1]
        : spec.custIds.length + ' matching customers');
    }

    if (spec.zone) { f.zone = spec.zone; f.chips.push('zone: ' + spec.zone); }

    if (spec.term) {
      f.term = spec.term;
      if (spec.termFamily && spec.termFamily.length > 1) {
        f.termFamily = spec.termFamily;
        f.chips.push('terms: ' + spec.termFamily.join(' + '));
      } else {
        f.chips.push('terms: ' + spec.term);
      }
    }

    if (spec.sign === 'neg') { f.sign = 'neg'; f.chips.push('credits only'); }

    if (spec.sort) {
      f.sort = spec.sort;
      if (spec.sort === 'oldest') f.chips.push('oldest first');
      else if (spec.sort === 'newest') f.chips.push('newest first');
      else if (spec.sort === 'smallest') f.chips.push('smallest first');
    }

    if (spec.topN) { f.topN = spec.topN; f.chips.push('top ' + spec.topN); }
    if (spec.groupBy) {
      f.groupBy = spec.groupBy;
      f.groupByCustomer = spec.groupBy === 'customer';
      f.chips.push('by ' + (spec.groupBy === 'term' ? 'payment terms' : spec.groupBy));
    }
    if (spec.countOnly) f.countOnly = true;
    if (spec.superlative) f.superlative = true;
    if (spec.aggregate) {
      f.aggregate = spec.aggregate;
      f.chips.push(spec.aggregate === 'average' ? 'average per line' : 'as a percentage');
    }

    if (spec.amtMin != null && spec.amtMax != null) {
      f.amtMin = spec.amtMin; f.amtMax = spec.amtMax;
      f.chips.push('between ' + money(spec.amtMin) + ' and ' + money(spec.amtMax));
    } else if (spec.amtMax != null) {
      f.amtMax = spec.amtMax; f.chips.push('below ' + money(spec.amtMax));
    } else if (spec.amtMin != null) {
      f.amtMin = spec.amtMin; f.chips.push('above ' + money(spec.amtMin));
    }

    var MON = ['January','February','March','April','May','June','July',
               'August','September','October','November','December'];
    if (spec.dueMonth) { f.dueMonth = spec.dueMonth; f.chips.push('due in ' + MON[spec.dueMonth - 1]); }
    if (spec.dueYear) { f.dueYear = spec.dueYear; f.chips.push('due in ' + spec.dueYear); }
    if (spec.dueBefore) { f.dueBefore = spec.dueBefore; f.chips.push('due before ' + MON[spec.dueBefore - 1]); }
    if (spec.dueAfter) { f.dueAfter = spec.dueAfter; f.chips.push('due from ' + MON[spec.dueAfter - 1] + ' onwards'); }

    f.ignored = spec.unsupported ? [spec.unsupported] : [];
    return f;
  }

  function renderThinking(slot, text) {
    slot.textContent = '';
    var c = card(text);
    var w = el('div', 'thinking');
    var dots = el('span', 'thinking-dots');
    dots.appendChild(el('i')); dots.appendChild(el('i')); dots.appendChild(el('i'));
    w.appendChild(dots);
    w.appendChild(el('span', null, 'Reading your question…'));
    c.body.appendChild(w);
    slot.appendChild(c.root);
  }

  // Second pass: hand the COMPUTED result back for wording. The figures are
  // already rendered and correct, so this only ever adds a paragraph — if it
  // fails, is switched off, or quotes a number the server cannot find in the
  // result, nothing appears and the card stands as it is.
  function narrate(question, result, slot) {
    var box = el('div', 'narrative is-loading');
    box.appendChild(el('span', 'narrative-dot'));
    box.appendChild(el('span', 'narrative-text', 'Writing a summary…'));
    var answer = slot.querySelector('.answer');
    if (!answer) return;
    answer.insertBefore(box, answer.firstChild);

    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, aiTimeoutMs);

    fetch('/api/ask/narrate', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: question,
        headline: String(result.big || ''),
        heading: String(result.head || ''),
        note: String(result.note || ''),
        columns: result.table || [],
        rows: (result.body || []).slice(0, 25).map(function (r) {
          return r.map(function (c) { return String(c); });
        }),
        more: result.more || 0,
        model: chosenModel
      }),
      signal: ctl.signal
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (j) {
        clearTimeout(timer);
        if (!j || !j.ok || !j.text) { box.remove(); return; }
        box.textContent = '';
        box.className = 'narrative';
        box.appendChild(el('p', 'narrative-text', j.text));
      });
  }

  // Provenance shown at the foot of every answer card, so a reader always knows
  // which engine read the question.
  var LOCAL_SRC = { ai: false, label: 'Answered by the built-in engine' };
  var FALLBACK_SRC = { ai: false, label: 'Answered by the built-in engine — AI was unavailable' };
  var EMPTY_SRC = { ai: false, label: 'Answered by the built-in engine — AI found nothing to filter on' };

  // Fields that actually narrow the query. `unsupported` and `refusal` are
  // commentary, so a spec carrying only those is still an empty query.
  var FILTER_KEYS = ['buckets', 'custIds', 'zone', 'term', 'sign', 'sort', 'topN',
                     'groupBy', 'countOnly', 'superlative', 'aggregate',
                     'amtMin', 'amtMax', 'dueMonth', 'dueYear', 'dueBefore', 'dueAfter'];

  function hasFilter(spec) {
    for (var i = 0; i < FILTER_KEYS.length; i++) {
      var v = spec[FILTER_KEYS[i]];
      if (v === undefined || v === null || v === false) continue;
      if (Array.isArray(v) && !v.length) continue;
      return true;
    }
    return false;
  }

  // Entry point for a typed question. Tries the model first, then falls back.
  function askFreeText(text, person, s) {
    var slot = document.getElementById('answer-slot');
    if (!slot) return;

    aiStatus().then(function (on) {
      if (!on) { askLocal(text, person, s); return; }
      renderThinking(slot, text);
      askAI(text, person).then(function (res) {
        if (!res) { askLocal(text, person, s, true); return; }
        var spec = res.spec;
        // Name the model that actually answered. Under Auto that may not be
        // the one at the top of the list, so it is worth showing.
        var srcAI = { ai: true, label: 'Interpreted by ' + (res.model || 'AI') +
                                       ' · figures computed from your data' };

        // The model can also decide the question is outside what an ageing
        // snapshot holds — a payment history or a forecast, say. That is a
        // better answer than a narrow one computed from the wrong column.
        if (spec.refusal) {
          renderRefusal(slot, text, { head: 'Not in this data', why: spec.refusal }, srcAI);
          return;
        }
        // Validation can strip a spec down to nothing — a question naming a
        // customer who is not on this book, say. An empty spec would quietly
        // widen the query to the entire book and look like a real answer, so
        // the built-in parser gets a turn instead.
        if (!hasFilter(spec)) { askLocal(text, person, s, false, EMPTY_SRC); return; }

        var f = specToFilter(spec);
        var result = runQuery(f, person, s);
        renderAnswer(slot, text, result, f.chips, f.ignored, null, srcAI);
        // The figures are already on screen and correct. The narrative is a
        // second, optional pass that only rewords them, so it arrives late and
        // its absence changes nothing.
        if (res.narrate) narrate(text, result, slot);
      });
    });
  }

  function askLocal(text, person, s, wasFallback, srcOverride) {
    var slot = document.getElementById('answer-slot');
    if (!slot) return;
    var src = srcOverride || (wasFallback ? FALLBACK_SRC : LOCAL_SRC);

    // Purpose-built handlers run first: they recognise a whole question shape
    // instead of reducing it to a keyword, and they refuse what this data
    // genuinely cannot answer.
    var handled = tryHandlers(text, person, s);
    if (handled) {
      if (handled.refusal) { renderRefusal(slot, text, handled, src); return; }
      renderAnswer(slot, text, handled, null, null, handled.rule, src);
      return;
    }

    var parsed = parseQuestion(text, person, s);

    if (!parsed.understood) {
      slot.textContent = '';
      var c0 = card('Not sure about that one');
      var w = el('div', 'answer');
      w.appendChild(el('div', 'answer-note',
        'I could not find anything to search on in that question. I answer by filtering your ' +
        'own invoice data, so try naming one of these:'));
      var ul = el('ul', 'notes');
      ul.style.margin = '0';
      ul.style.paddingLeft = '18px';
      [
        'a customer — “how much does Aayu Food Product owe me?”',
        'an ageing threshold — “what is over 90 days?”',
        'overdue or not due — “show my overdue invoices”',
        'a zone — “what is outstanding in North HR?”',
        'payment terms — “how much is on 30D INV?”',
        'a ranking — “top 5 customers” or “my oldest invoice”',
        'a count — “how many invoices are overdue?”'
      ].forEach(function (t) { ul.appendChild(el('li', null, t)); });
      w.appendChild(ul);
      appendSource(w, src);
      c0.body.appendChild(w);
      slot.appendChild(c0.root);
      return;
    }

    var r = runQuery(parsed.f, person, s);
    renderAnswer(slot, text, r, parsed.f.chips, parsed.f.ignored, null, src);
  }

  // Provenance line. Every answer carries one, so "the AI said so" and "the
  // built-in engine said so" are never confusable.
  function appendSource(container, src) {
    if (!src) return;
    var line = el('div', 'srcline' + (src.ai ? '' : ' is-local'));
    line.appendChild(el('span', 'srcline-dot'));
    line.appendChild(el('span', null, src.label));
    container.appendChild(line);
  }

  function renderRefusal(slot, title, r, src) {
    slot.textContent = '';
    var c = card(title);
    var a = el('div', 'answer');
    var box = el('div', 'notice');
    box.innerHTML = '<strong>' + esc(r.head) + '.</strong> ' + esc(r.why);
    a.appendChild(box);
    appendSource(a, src);
    c.body.appendChild(a);
    slot.appendChild(c.root);
  }

  function renderAnswer(slot, title, r, chips, ignored, rule, src) {
    slot.textContent = '';
    var c = card(title);
    var a = el('div', 'answer');

    if (chips && chips.length) {
      var cw = el('div', 'chiprow');
      cw.appendChild(el('span', 'chiprow-lbl', 'Read as'));
      chips.forEach(function (t) { cw.appendChild(el('span', 'chip neutral', t)); });
      a.appendChild(cw);
    }

    if (ignored && ignored.length) {
      var warn = el('div', 'notice');
      warn.innerHTML = '<strong>Part of your question was not used.</strong> This answer ignores ' +
        ignored.join(' and ') + ', so it may be broader than what you asked. ' +
        'Try rephrasing, for example “customers with overdue less than 1000”.';
      a.appendChild(warn);
    }

    a.appendChild(el('div', 'answer-big num', r.big));
    a.appendChild(el('div', 'answer-head', r.head));
    a.appendChild(el('div', 'answer-note', r.note));

    // Judgement answers state the rule they used, so the reader can weigh it
    // rather than take a ranking on trust.
    if (rule) {
      var rl = el('div', 'rule');
      rl.innerHTML = '<span class="rule-lbl">Ranked by</span> ' + esc(rule);
      a.appendChild(rl);
    }

    if (r.body && r.body.length) {
      var scroll = el('div', 'table-scroll');
      var t = el('table', 'mini');
      var thead = el('thead'), tr = el('tr');
      r.table.forEach(function (h, i) { tr.appendChild(el('th', i >= 2 ? 'n' : null, h)); });
      thead.appendChild(tr);
      t.appendChild(thead);
      var tb = el('tbody');
      r.body.forEach(function (row) {
        var x = el('tr');
        row.forEach(function (cell, i) {
          var isNum = i >= 2;
          x.appendChild(el('td', isNum ? (String(cell).indexOf('−') === 0 ? 'n neg' : 'n') : null, cell));
        });
        tb.appendChild(x);
      });
      t.appendChild(tb);
      scroll.appendChild(t);
      a.appendChild(scroll);
      if (r.more) a.appendChild(el('p', 'card-note', '+ ' + r.more + ' more not shown'));
    }

    appendSource(a, src);
    c.body.appendChild(a);
    slot.appendChild(c.root);
  }

  // ---------------------------------------------------------------- ask
  var QUESTIONS = [
    {
      id: 'overdue', label: "What's overdue right now?",
      run: function (p, s) {
        var rows = p.lines.filter(function (ln) {
          for (var b = 1; b < NB; b++) if (ln[L.B0 + b] !== 0) return true;
          return false;
        }).map(function (ln) {
          var od = 0;
          for (var b = 1; b < NB; b++) od += ln[L.B0 + b];
          return { ln: ln, od: od };
        }).sort(function (a, b) { return b.od - a.od; });
        return {
          big: money(s.overdue),
          head: 'Overdue balance',
          note: pct(s.overdue, s.balance) + ' of your book, across ' + rows.length + ' invoice line(s).',
          table: ['Customer', 'Document', 'Due date', 'Overdue'],
          body: rows.slice(0, 25).map(function (r) {
            return [D.customers[r.ln[L.CUST]][1], r.ln[L.DOC], fmtDate(r.ln[L.DUE]), money(r.od)];
          }),
          more: rows.length > 25 ? rows.length - 25 : 0
        };
      }
    },
    {
      id: 'sev90', label: 'Which invoices are 90+ days overdue?',
      run: function (p) {
        var rows = p.lines.map(function (ln) {
          var v = 0;
          for (var b = 4; b < NB; b++) v += ln[L.B0 + b];
          return { ln: ln, v: v };
        }).filter(function (r) { return r.v !== 0; })
          .sort(function (a, b) { return b.v - a.v; });
        var tot = rows.reduce(function (a, r) { return a + r.v; }, 0);
        return {
          big: money(tot),
          head: 'Sitting beyond 90 days',
          note: rows.length ? rows.length + ' invoice line(s) in the 93+ day buckets — these need the most attention.'
            : 'Nothing in your book is more than 90 days past due.',
          table: ['Customer', 'Document', 'Due date', 'Amount'],
          body: rows.slice(0, 25).map(function (r) {
            return [D.customers[r.ln[L.CUST]][1], r.ln[L.DOC], fmtDate(r.ln[L.DUE]), money(r.v)];
          }),
          more: rows.length > 25 ? rows.length - 25 : 0
        };
      }
    },
    {
      id: 'worst', label: 'Which customers owe me the most?',
      run: function (p, s) {
        var rows = Object.keys(s.byCust).map(function (ci) {
          return { c: D.customers[ci], d: s.byCust[ci] };
        }).sort(function (a, b) { return b.d.bal - a.d.bal; });
        return {
          big: rows.length ? money(rows[0].d.bal) : money(0),
          head: rows.length ? 'Largest balance: ' + rows[0].c[1] : 'No customers',
          note: 'Your book is spread across ' + rows.length + ' customer(s). The top five carry ' +
            pct(rows.slice(0, 5).reduce(function (a, r) { return a + r.d.bal; }, 0), s.balance) + ' of it.',
          table: ['Customer', 'Zone', 'Lines', 'Overdue', 'Balance'],
          body: rows.slice(0, 15).map(function (r) {
            return [r.c[1], r.c[2], String(r.d.lines), money(r.d.overdue), money(r.d.bal)];
          }),
          more: rows.length > 15 ? rows.length - 15 : 0
        };
      }
    },
    {
      id: 'clean', label: 'Which customers are fully up to date?',
      run: function (p, s) {
        var rows = Object.keys(s.byCust).map(function (ci) {
          return { c: D.customers[ci], d: s.byCust[ci] };
        }).filter(function (r) { return r.d.overdue === 0; })
          .sort(function (a, b) { return b.d.bal - a.d.bal; });
        var tot = rows.reduce(function (a, r) { return a + r.d.bal; }, 0);
        return {
          big: String(rows.length),
          head: 'Customers with nothing overdue',
          note: rows.length
            ? 'They hold ' + money(tot) + ' of not-yet-due balance — worth protecting.'
            : 'Every customer in your book has something past due.',
          table: ['Customer', 'Zone', 'Lines', 'Balance'],
          body: rows.slice(0, 20).map(function (r) {
            return [r.c[1], r.c[2], String(r.d.lines), money(r.d.bal)];
          }),
          more: rows.length > 20 ? rows.length - 20 : 0
        };
      }
    },
    {
      id: 'terms', label: 'How does my book split by payment terms?',
      run: function (p, s) {
        var rows = Object.keys(s.byTerm).map(function (t) {
          return { t: t, d: s.byTerm[t] };
        }).sort(function (a, b) { return b.d.bal - a.d.bal; });
        return {
          big: String(rows.length),
          head: 'Payment terms in use',
          note: 'Your customers sit on ' + rows.length + ' different term(s).',
          table: ['Payment terms', 'Lines', 'Balance', 'Share'],
          body: rows.map(function (r) {
            return [r.t, String(r.d.lines), money(r.d.bal), pct(r.d.bal, s.balance)];
          }),
          more: 0
        };
      }
    },
    {
      id: 'oldest', label: "What's my oldest outstanding invoice?",
      run: function (p) {
        var rows = p.lines.filter(function (ln) { return ln[L.DUE] && ln[L.BAL] > 0; })
          .sort(function (a, b) { return a[L.DUE] < b[L.DUE] ? -1 : 1; });
        if (!rows.length) {
          return { big: '—', head: 'No dated open invoices', note: 'Nothing to show.', table: [], body: [], more: 0 };
        }
        var o = rows[0];
        return {
          big: money(o[L.BAL]),
          head: D.customers[o[L.CUST]][1],
          note: 'Document ' + o[L.DOC] + ', due ' + fmtDate(o[L.DUE]) + ' — the oldest still open in your book.',
          table: ['Customer', 'Document', 'Due date', 'Balance'],
          body: rows.slice(0, 15).map(function (ln) {
            return [D.customers[ln[L.CUST]][1], ln[L.DOC], fmtDate(ln[L.DUE]), money(ln[L.BAL])];
          }),
          more: rows.length > 15 ? rows.length - 15 : 0
        };
      }
    }
  ];

  function renderAsk(person, s) {
    var host = document.getElementById('view-ask');
    host.textContent = '';

    // ---- free-text box
    var fc = card('Ask your own question', 'every figure is computed from your data');
    // The subtitle tells the reader which engine is live before they type. It
    // is set once the status check lands, so the card never claims an AI that
    // is switched off.
    aiStatus().then(function (on) {
      var note = fc.root.querySelector('.card-note');
      if (note) {
        note.textContent = on
          ? 'ask in your own words — every figure is computed from your data'
          : 'every figure is computed from your data';
      }
    });
    var form = el('form', 'askbox');
    var inp = el('input', 'askbox-input');
    inp.type = 'text';
    inp.placeholder = 'e.g. which customers over 90 days should I chase in North HR?';
    inp.setAttribute('aria-label', 'Ask a question about your account');
    var go = el('button', 'askbox-go', 'Ask');
    go.type = 'submit';
    form.appendChild(inp);
    form.appendChild(go);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = inp.value.trim();
      if (!v) return;
      document.querySelectorAll('.qbtn').forEach(function (o) { o.setAttribute('aria-pressed', 'false'); });
      askFreeText(v, person, s);
      document.getElementById('answer-slot').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    fc.body.appendChild(form);

    var ex = el('div', 'examples');
    ex.appendChild(el('span', 'examples-lbl', 'Try'));
    [
      'top 5 customers',
      'what is over 90 days?',
      'how many invoices are overdue?',
      'show my credits',
      'my oldest invoice',
      'how much is on 30D INV?'
    ].forEach(function (t) {
      var b = el('button', 'example');
      b.type = 'button';
      b.textContent = t;
      b.addEventListener('click', function () {
        inp.value = t;
        document.querySelectorAll('.qbtn').forEach(function (o) { o.setAttribute('aria-pressed', 'false'); });
        askFreeText(t, person, s);
        document.getElementById('answer-slot').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      ex.appendChild(b);
    });
    fc.body.appendChild(ex);

    // ---- model picker. Only rendered once the server confirms AI is on, so
    // a deployment without a key shows no dead control.
    var picker = el('div', 'modelbar');
    picker.hidden = true;
    fc.body.appendChild(picker);

    loadModels().then(function (info) {
      if (!info.enabled || !info.models || !info.models.length) return;
      picker.textContent = '';
      picker.hidden = false;
      picker.appendChild(el('span', 'modelbar-lbl', 'Model'));

      var sel = el('select', 'modelsel');
      sel.setAttribute('aria-label', 'Which model answers your question');

      var auto = el('option', null, 'Auto — use the first one available');
      auto.value = '';
      sel.appendChild(auto);

      var stillValid = false;
      info.models.forEach(function (m) {
        var o = el('option', null,
          m.label + (m.recommended ? ' (recommended)' : '') +
          (m.available ? '' : ' — quota spent'));
        o.value = m.id;
        sel.appendChild(o);
        if (m.id === chosenModel) stillValid = true;
      });

      // A model remembered from a previous visit may no longer be offered.
      if (chosenModel && !stillValid) rememberModel('');
      sel.value = chosenModel;

      sel.addEventListener('change', function () {
        rememberModel(sel.value);
        hint.textContent = sel.value
          ? 'Every question goes to this model. If its quota runs out, answers fall back to the built-in engine.'
          : 'Tries each model in turn and skips any whose quota is spent.';
      });
      picker.appendChild(sel);

      var hint = el('span', 'modelbar-hint', chosenModel
        ? 'Every question goes to this model. If its quota runs out, answers fall back to the built-in engine.'
        : 'Tries each model in turn and skips any whose quota is spent.');
      picker.appendChild(hint);
    });

    host.appendChild(fc.root);

    var qc = card('Common questions', 'tap one for an answer from your data');
    var grid = el('div', 'qgrid');
    QUESTIONS.forEach(function (q) {
      var b = el('button', 'qbtn');
      b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" ' +
        'stroke-width="1.8" stroke-linecap="round"><circle cx="10" cy="10" r="7.5"/>' +
        '<path d="M7.8 7.8a2.3 2.3 0 1 1 2.9 2.9v1"/><path d="M10 14.2v.01"/></svg>';
      b.appendChild(document.createTextNode(q.label));
      b.addEventListener('click', function () {
        grid.querySelectorAll('.qbtn').forEach(function (o) { o.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
        showAnswer(q, person, s);
      });
      grid.appendChild(b);
    });
    qc.body.appendChild(grid);
    host.appendChild(qc.root);

    var slot = el('div');
    slot.id = 'answer-slot';
    host.appendChild(slot);

    showAnswer(QUESTIONS[0], person, s);
    grid.querySelector('.qbtn').setAttribute('aria-pressed', 'true');
  }

  function showAnswer(q, person, s) {
    var slot = document.getElementById('answer-slot');
    if (!slot) return;
    renderAnswer(slot, q.label, q.run(person, s), null);
  }

  // ---------------------------------------------------------------- picker
  var input = document.getElementById('picker');
  var list = document.getElementById('picker-list');
  var clearBtn = document.getElementById('picker-clear');
  var current = null, cursor = -1, filtered = [];

  function openList(q) {
    q = (q || '').trim().toLowerCase();
    filtered = roster.filter(function (r) { return r.name.toLowerCase().indexOf(q) !== -1; });
    list.textContent = '';
    if (!filtered.length) {
      list.appendChild(el('div', 'opt-empty', 'No salesperson matches “' + q + '”'));
    } else {
      filtered.forEach(function (r, i) {
        var o = el('div', 'opt' + (i === cursor ? ' active' : ''));
        o.setAttribute('role', 'option');
        var n = el('div', 'opt-name');
        if (q) {
          var ix = r.name.toLowerCase().indexOf(q);
          n.innerHTML = esc(r.name.slice(0, ix)) + '<mark>' + esc(r.name.slice(ix, ix + q.length)) +
            '</mark>' + esc(r.name.slice(ix + q.length));
        } else {
          n.textContent = r.name;
        }
        o.appendChild(n);
        o.appendChild(el('div', 'opt-val' + (r.lines.length ? ' num' : ''),
          r.lines.length ? compact(r.balance) : 'no receivables'));
        o.addEventListener('mousedown', function (e) { e.preventDefault(); select(r); });
        list.appendChild(o);
      });
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function closeList() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    cursor = -1;
  }

  function select(r) {
    current = r;
    input.value = r.name;
    clearBtn.hidden = false;
    closeList();
    render();
    try { localStorage.setItem('nutaste-ar-sp', r.name); } catch (e) { /* storage may be unavailable */ }
  }

  function clearSelection() {
    current = null;
    input.value = '';
    clearBtn.hidden = true;
    document.getElementById('views').hidden = true;
    document.getElementById('empty').hidden = false;
    try { localStorage.removeItem('nutaste-ar-sp'); } catch (e) { /* ignore */ }
    input.focus();
  }

  input.addEventListener('focus', function () { openList(current ? '' : input.value); });
  input.addEventListener('input', function () { cursor = -1; openList(input.value); });
  input.addEventListener('blur', function () { setTimeout(closeList, 120); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) openList(input.value);
      if (!filtered.length) return;
      cursor += (e.key === 'ArrowDown' ? 1 : -1);
      if (cursor < 0) cursor = filtered.length - 1;
      if (cursor >= filtered.length) cursor = 0;
      openList(input.value);
      var act = list.children[cursor];
      if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (!list.hidden && filtered.length) {
        e.preventDefault();
        select(filtered[cursor >= 0 ? cursor : 0]);
      }
    } else if (e.key === 'Escape') {
      closeList();
    }
  });
  clearBtn.addEventListener('click', clearSelection);

  // ---------------------------------------------------------------- tabs
  var currentView = 'overview';
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      currentView = t.dataset.view;
      document.querySelectorAll('.tab').forEach(function (o) {
        o.setAttribute('aria-selected', String(o === t));
      });
      ['overview', 'report', 'ask'].forEach(function (v) {
        document.getElementById('view-' + v).hidden = (v !== currentView);
      });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  function render() {
    if (!current) return;
    var s = summarise(current.lines);
    document.getElementById('empty').hidden = true;
    document.getElementById('views').hidden = false;
    renderOverview(current, s);
    renderReport(current, s);
    renderAsk(current, s);
    ['overview', 'report', 'ask'].forEach(function (v) {
      document.getElementById('view-' + v).hidden = (v !== currentView);
    });
  }

  // ---------------------------------------------------------------- boot
  document.getElementById('asof-date').textContent = fmtDate(D.reportDate);

  var saved = null;
  try { saved = localStorage.getItem('nutaste-ar-sp'); } catch (e) { /* ignore */ }
  if (saved) {
    var match = roster.filter(function (r) { return r.name === saved; })[0];
    if (match) select(match);
  }
})();

