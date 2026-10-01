
// =====================================================================
// Secondary Sales — field activity for one person.
//
// Deliberately a SEPARATE dataset from receivables: the two sources spell
// names differently and cover different staff, so nothing is force-matched
// between them. This section has its own person list, its own period, and
// its own tabs.
// =====================================================================
(function () {
  'use strict';

  var S = window.SEC_DATA;
  if (!S) return;

  var POOL = S.pools;
  function pv(kind, i) {
    var list = POOL[kind];
    return (list && list[i] != null) ? list[i] : '—';
  }

  // column layouts, mirroring build_sec_data.py
  var V = { P: 0, DAY: 1, TYPE: 2, CITY: 3, CHAN: 4, BUYER: 5, MINS: 6 };
  var DM = { P: 0, DAY: 1, BUYER: 2, REGION: 3, STAGE: 4, STATUS: 5, CONV: 6, VAL: 7 };
  var LD = { P: 0, DAY: 1, BUYER: 2, CITY: 3, STAGE: 4, STATUS: 5, TYPE: 6, VAL: 7 };
  var TR = { P: 0, DAY: 1, WORK: 2, TOTAL: 3 };
  var EX = { P: 0, DAY: 1, REGION: 2, AMT: 3 };
  var SL = { P: 0, DAY: 1, BUYER: 2, PGROUP: 3, CITY: 4, QTY: 5, VAL: 6 };

  // ---------------------------------------------------------------- index
  var byPerson = {};
  function bucket(p) {
    return byPerson[p] || (byPerson[p] = { visits: [], demos: [], leads: [],
                                           travel: [], expenses: [], sales: [] });
  }
  S.visits.forEach(function (r) { bucket(r[0]).visits.push(r); });
  S.demos.forEach(function (r) { bucket(r[0]).demos.push(r); });
  S.leads.forEach(function (r) { bucket(r[0]).leads.push(r); });
  S.travel.forEach(function (r) { bucket(r[0]).travel.push(r); });
  S.expenses.forEach(function (r) { bucket(r[0]).expenses.push(r); });
  S.sales.forEach(function (r) { bucket(r[0]).sales.push(r); });

  var roster = S.people.map(function (name, i) {
    var b = bucket(i);
    return {
      ix: i, name: name, d: b,
      visits: b.visits.length,
      salesValue: b.sales.reduce(function (a, r) { return a + r[SL.VAL]; }, 0)
    };
  }).sort(function (a, b) {
    // people with activity first, then the rest alphabetically
    var ah = a.visits || a.salesValue, bh = b.visits || b.salesValue;
    if (!ah !== !bh) return ah ? -1 : 1;
    return (b.visits - a.visits) || (b.salesValue - a.salesValue) ||
           a.name.localeCompare(b.name);
  });

  // ---------------------------------------------------------------- utils
  function money(n) {
    var v = Math.round(n || 0);
    return (v < 0 ? '−₹' : '₹') + Math.abs(v).toLocaleString('en-IN');
  }
  function compact(n) {
    var a = Math.abs(n || 0), s = n < 0 ? '−' : '';
    if (a >= 1e7) return s + '₹' + (a / 1e7).toFixed(2) + ' Cr';
    if (a >= 1e5) return s + '₹' + (a / 1e5).toFixed(2) + ' L';
    return money(n);
  }
  function pctOf(part, whole) {
    if (!whole) return '0%';
    return (Math.abs(part) / Math.abs(whole) * 100).toFixed(1) + '%';
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
  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function periodLabel() {
    var a = S.periodFrom.split('-'), b = S.periodTo.split('-');
    return a[2] + '–' + b[2] + ' ' + MON[+a[1] - 1] + ' ' + a[0];
  }
  function dayLabel(d) {
    if (!d) return '—';
    var a = S.periodFrom.split('-');
    return String(d).padStart(2, '0') + '-' + MON[+a[1] - 1];
  }

  // shared card/tile helpers, matching the receivables section's look
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
  function kpi(label, value, sub, hero) {
    var k = el('div', 'kpi' + (hero ? ' hero' : ''));
    k.appendChild(el('div', 'kpi-label', label));
    k.appendChild(el('div', 'kpi-value num', value));
    if (sub) { var s = el('div', 'kpi-sub'); s.innerHTML = sub; k.appendChild(s); }
    return k;
  }

  var tipEl = document.getElementById('tip');
  function bindTip(node, text) {
    node.addEventListener('mouseenter', function () {
      tipEl.textContent = text; tipEl.classList.add('on');
    });
    node.addEventListener('mousemove', function (e) {
      tipEl.style.left = e.clientX + 'px'; tipEl.style.top = e.clientY + 'px';
    });
    node.addEventListener('mouseleave', function () { tipEl.classList.remove('on'); });
  }

  function barRow(name, value, scale, colour, tip, fmt) {
    var row = el('div', 'bar-row');
    row.appendChild(el('div', 'bar-name', name));
    var track = el('div', 'bar-track');
    var fill = el('div', 'bar-fill');
    fill.style.width = (scale ? Math.max(1, Math.abs(value) / scale * 100) : 0) + '%';
    fill.style.background = colour;
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el('div', 'bar-val num', (fmt || money)(value)));
    if (tip) bindTip(track, tip);
    return row;
  }

  function table(cols, rows, numFrom) {
    var scroll = el('div', 'table-scroll');
    var t = el('table', 'mini');
    var thead = el('thead'), tr = el('tr');
    cols.forEach(function (c, i) { tr.appendChild(el('th', i >= numFrom ? 'n' : null, c)); });
    thead.appendChild(tr); t.appendChild(thead);
    var tb = el('tbody');
    rows.forEach(function (r) {
      var x = el('tr');
      r.forEach(function (cell, i) { x.appendChild(el('td', i >= numFrom ? 'n' : null, cell)); });
      tb.appendChild(x);
    });
    t.appendChild(tb); scroll.appendChild(t);
    return scroll;
  }

  // ---------------------------------------------------------------- summary
  function summarise(d) {
    var s = {
      visits: d.visits.length,
      visitDays: {}, byType: {}, byCity: {}, byChannel: {},
      demos: d.demos.length, demosConv: 0, demoValue: 0,
      leads: d.leads.length, leadValue: 0, byLeadStage: {},
      km: 0, workKm: 0, travelDays: d.travel.length,
      expense: 0,
      salesValue: 0, salesQty: 0, byProduct: {}, byBuyer: {},
      outlets: {}
    };
    d.visits.forEach(function (r) {
      s.visitDays[r[V.DAY]] = 1;
      s.byType[pv('vtype', r[V.TYPE])] = (s.byType[pv('vtype', r[V.TYPE])] || 0) + 1;
      s.byCity[pv('city', r[V.CITY])] = (s.byCity[pv('city', r[V.CITY])] || 0) + 1;
      s.byChannel[pv('channel', r[V.CHAN])] = (s.byChannel[pv('channel', r[V.CHAN])] || 0) + 1;
      s.outlets[r[V.BUYER]] = 1;
    });
    d.demos.forEach(function (r) {
      s.demoValue += r[DM.VAL];
      if (r[DM.CONV]) s.demosConv++;
    });
    d.leads.forEach(function (r) {
      s.leadValue += r[LD.VAL];
      var k = pv('lstage', r[LD.STAGE]);
      s.byLeadStage[k] = (s.byLeadStage[k] || 0) + 1;
    });
    d.travel.forEach(function (r) { s.km += r[TR.TOTAL]; s.workKm += r[TR.WORK]; });
    d.expenses.forEach(function (r) { s.expense += r[EX.AMT]; });
    d.sales.forEach(function (r) {
      s.salesValue += r[SL.VAL];
      s.salesQty += r[SL.QTY];
      var p = pv('pgroup', r[SL.PGROUP]);
      s.byProduct[p] = (s.byProduct[p] || 0) + r[SL.VAL];
      var b = pv('buyer', r[SL.BUYER]);
      s.byBuyer[b] = (s.byBuyer[b] || 0) + r[SL.VAL];
    });
    s.activeDays = Object.keys(s.visitDays).length;
    s.outletCount = Object.keys(s.outlets).length;
    return s;
  }

  function topEntries(obj, n) {
    return Object.keys(obj).map(function (k) { return [k, obj[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, n || 10);
  }

  // ---------------------------------------------------------------- views
  function renderOverview(person, s) {
    var host = document.getElementById('sec-overview');
    host.textContent = '';

    var nothing = !s.visits && !s.demos && !s.leads && !s.salesValue &&
                  !s.km && !s.expense;
    if (nothing) {
      var nc = card(person.name, periodLabel());
      var box = el('div', 'notice');
      box.innerHTML = '<strong>No activity recorded in this period.</strong> ' +
        'This person has no visits, demos, leads, secondary sales, travel or ' +
        'expenses between ' + periodLabel() + '. They still appear here because ' +
        'they are on the current employee list.';
      nc.body.appendChild(box);
      host.appendChild(nc.root);
      return;
    }

    var k = el('div', 'kpis');
    k.appendChild(kpi('Secondary sales', money(s.salesValue),
      compact(s.salesValue) + ' · ' + s.salesQty.toLocaleString('en-IN') + ' units', true));
    k.appendChild(kpi('Visits', String(s.visits),
      s.outletCount + ' outlets · ' + s.activeDays + ' active days'));
    k.appendChild(kpi('Demos', String(s.demos),
      !s.demos ? '<span class="chip neutral">none this period</span>'
        : s.demosConv
          ? '<span class="chip ok">' + s.demosConv + ' converted</span>'
          : '<span class="chip neutral">none converted yet</span>'));
    k.appendChild(kpi('Leads', String(s.leads),
      s.leadValue ? compact(s.leadValue) + ' pipeline' : 'no value recorded'));
    host.appendChild(k);

    // ---- visit mix + daily rhythm
    var g = el('div', 'grid-2');

    var vt = card('Visit types', s.visits + ' visits');
    var types = topEntries(s.byType, 10);
    if (!types.length) {
      vt.body.appendChild(el('p', 'card-note', 'No visits recorded in this period.'));
    } else {
      var vmax = types[0][1];
      var vb = el('div', 'bars');
      types.forEach(function (t) {
        vb.appendChild(barRow(t[0], t[1], vmax, 'var(--accent)',
          t[0] + ' · ' + t[1] + ' visits · ' + pctOf(t[1], s.visits) + ' of activity',
          function (n) { return String(n); }));
      });
      vt.body.appendChild(vb);
    }
    g.appendChild(vt.root);

    var dc = card('Daily activity', 'visits per day');
    var days = [];
    for (var i = 1; i <= 31; i++) days.push(0);
    person.d.visits.forEach(function (r) { if (r[V.DAY]) days[r[V.DAY] - 1]++; });
    var dmax = Math.max.apply(null, days) || 1;
    var SPARK_H = 110;   // px — percentage heights do not resolve in this flex row
    var spark = el('div', 'spark');
    days.forEach(function (v, i) {
      var b = el('div', 'spark-bar');
      b.style.height = Math.max(3, Math.round(v / dmax * SPARK_H)) + 'px';
      if (!v) b.classList.add('spark-zero');
      bindTip(b, dayLabel(i + 1) + ' · ' + v + ' visit' + (v === 1 ? '' : 's'));
      spark.appendChild(b);
    });
    dc.body.appendChild(spark);
    var legend = el('p', 'card-note');
    legend.style.marginTop = '10px';
    legend.textContent = 'Busiest day ' + dmax + ' visits · ' + s.activeDays +
                         ' of 31 days had activity';
    dc.body.appendChild(legend);
    g.appendChild(dc.root);
    host.appendChild(g);

    // ---- top customers by sales value
    var buyers = topEntries(s.byBuyer, 10);
    var bc = card('Top customers by secondary sales', buyers.length + ' of ' +
      Object.keys(s.byBuyer).length + ' shown');
    if (!buyers.length) {
      bc.body.appendChild(el('p', 'card-note', 'No secondary sales recorded for this person.'));
    } else {
      var bmax = buyers[0][1];
      var bb = el('div', 'bars');
      buyers.forEach(function (b) {
        bb.appendChild(barRow(b[0], b[1], bmax, 'var(--ok)',
          b[0] + ' · ' + money(b[1]) + ' · ' + pctOf(b[1], s.salesValue) + ' of sales'));
      });
      bc.body.appendChild(bb);
    }
    host.appendChild(bc.root);

    // ---- product mix + effort
    var g2 = el('div', 'grid-2');
    var pc = card('Product groups', 'share of sales value');
    var prods = topEntries(s.byProduct, 8);
    if (!prods.length) {
      pc.body.appendChild(el('p', 'card-note', 'No sales to break down.'));
    } else {
      var pmax = prods[0][1];
      var pb = el('div', 'bars');
      prods.forEach(function (p) {
        pb.appendChild(barRow(p[0], p[1], pmax, 'var(--sev-2)',
          p[0] + ' · ' + money(p[1]) + ' · ' + pctOf(p[1], s.salesValue)));
      });
      pc.body.appendChild(pb);
    }
    g2.appendChild(pc.root);

    var ec = card('Effort and cost', periodLabel());
    ec.body.appendChild(table(['Measure', 'Value'], [
      ['Distance travelled', Math.round(s.km).toLocaleString('en-IN') + ' km'],
      ['Working distance', Math.round(s.workKm).toLocaleString('en-IN') + ' km'],
      ['Days with travel logged', String(s.travelDays)],
      ['Expenses claimed', money(s.expense)],
      ['Visits per active day', s.activeDays ? (s.visits / s.activeDays).toFixed(1) : '—'],
      ['Sales per visit', s.visits ? money(s.salesValue / s.visits) : '—'],
      ['Cost per visit', s.visits && s.expense ? money(s.expense / s.visits) : '—'],
    ], 1));
    g2.appendChild(ec.root);
    host.appendChild(g2);
  }

  function renderActivity(person, s) {
    var host = document.getElementById('sec-activity');
    host.textContent = '';
    var d = person.d;

    // ---- visits
    var vc = card('Visits', d.visits.length + ' in ' + periodLabel());
    if (!d.visits.length) {
      vc.body.appendChild(el('p', 'card-note', 'No visits recorded.'));
    } else {
      var vrows = d.visits.slice().sort(function (a, b) { return a[V.DAY] - b[V.DAY]; })
        .slice(0, 200).map(function (r) {
          return [dayLabel(r[V.DAY]), pv('buyer', r[V.BUYER]), pv('vtype', r[V.TYPE]),
                  pv('city', r[V.CITY]), pv('channel', r[V.CHAN]),
                  r[V.MINS] ? r[V.MINS] + ' min' : '—'];
        });
      vc.body.appendChild(table(['Date', 'Outlet', 'Type', 'City', 'Channel', 'Duration'],
        vrows, 5));
      if (d.visits.length > 200) {
        vc.body.appendChild(el('p', 'card-note', '+ ' + (d.visits.length - 200) + ' more not shown'));
      }
    }
    host.appendChild(vc.root);

    // ---- demos
    var dc = card('Demos', d.demos.length + ' in ' + periodLabel());
    if (!d.demos.length) {
      dc.body.appendChild(el('p', 'card-note', 'No demos recorded.'));
    } else {
      var drows = d.demos.slice().sort(function (a, b) { return b[DM.VAL] - a[DM.VAL]; })
        .map(function (r) {
          return [dayLabel(r[DM.DAY]), pv('buyer', r[DM.BUYER]), pv('region', r[DM.REGION]),
                  pv('stage', r[DM.STAGE]), r[DM.CONV] ? 'Yes' : 'No', money(r[DM.VAL])];
        });
      dc.body.appendChild(table(['Date', 'Customer', 'Region', 'Stage', 'Converted', 'Est. value'],
        drows, 5));
    }
    host.appendChild(dc.root);

    // ---- leads
    var lc = card('Leads', d.leads.length + ' in ' + periodLabel());
    if (!d.leads.length) {
      lc.body.appendChild(el('p', 'card-note', 'No leads recorded.'));
    } else {
      var lrows = d.leads.slice().sort(function (a, b) { return b[LD.VAL] - a[LD.VAL]; })
        .map(function (r) {
          return [dayLabel(r[LD.DAY]), pv('buyer', r[LD.BUYER]), pv('city', r[LD.CITY]),
                  pv('lstage', r[LD.STAGE]), pv('status', r[LD.STATUS]), money(r[LD.VAL])];
        });
      lc.body.appendChild(table(['Date', 'Company', 'City', 'Stage', 'Status', 'Est. value'],
        lrows, 5));
    }
    host.appendChild(lc.root);

    // ---- expenses and travel
    var ec = card('Expenses and travel', periodLabel());
    var erows = d.expenses.map(function (r) {
      return ['Expense claim', pv('region', r[EX.REGION]), money(r[EX.AMT])];
    });
    erows.push(['Total distance', '—', Math.round(s.km).toLocaleString('en-IN') + ' km']);
    erows.push(['Working distance', '—', Math.round(s.workKm).toLocaleString('en-IN') + ' km']);
    ec.body.appendChild(table(['Item', 'Region', 'Value'], erows, 2));
    host.appendChild(ec.root);
  }

  // ---------------------------------------------------------------- picker
  var input = document.getElementById('sec-picker');
  var list = document.getElementById('sec-picker-list');
  var clearBtn = document.getElementById('sec-picker-clear');
  var current = null, cursor = -1, filtered = [];
  var view = 'overview';

  function openList(q) {
    q = (q || '').trim().toLowerCase();
    filtered = roster.filter(function (r) { return r.name.toLowerCase().indexOf(q) !== -1; });
    list.textContent = '';
    if (!filtered.length) {
      list.appendChild(el('div', 'opt-empty', 'No one matches “' + q + '”'));
    } else {
      filtered.forEach(function (r, i) {
        var o = el('div', 'opt' + (i === cursor ? ' active' : ''));
        o.setAttribute('role', 'option');
        var n = el('div', 'opt-name');
        if (q) {
          var ix = r.name.toLowerCase().indexOf(q);
          n.innerHTML = esc(r.name.slice(0, ix)) + '<mark>' +
            esc(r.name.slice(ix, ix + q.length)) + '</mark>' + esc(r.name.slice(ix + q.length));
        } else {
          n.textContent = r.name;
        }
        o.appendChild(n);
        o.appendChild(el('div', 'opt-val' + (r.visits ? ' num' : ''),
          r.visits ? r.visits + ' visits'
                   : (r.salesValue ? compact(r.salesValue) : 'no activity')));
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
    try { localStorage.setItem('nutaste-sec-person', r.name); } catch (e) { /* ignore */ }
  }
  function clearSelection() {
    current = null;
    input.value = '';
    clearBtn.hidden = true;
    document.getElementById('sec-views').hidden = true;
    document.getElementById('sec-empty').hidden = false;
    try { localStorage.removeItem('nutaste-sec-person'); } catch (e) { /* ignore */ }
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
      var a = list.children[cursor];
      if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' });
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

  document.querySelectorAll('.sec-tab').forEach(function (t) {
    t.addEventListener('click', function () {
      view = t.dataset.view;
      document.querySelectorAll('.sec-tab').forEach(function (o) {
        o.setAttribute('aria-selected', String(o === t));
      });
      ['overview', 'activity'].forEach(function (v) {
        document.getElementById('sec-' + v).hidden = (v !== view);
      });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  function render() {
    if (!current) return;
    var s = summarise(current.d);
    document.getElementById('sec-empty').hidden = true;
    document.getElementById('sec-views').hidden = false;
    renderOverview(current, s);
    renderActivity(current, s);
    ['overview', 'activity'].forEach(function (v) {
      document.getElementById('sec-' + v).hidden = (v !== view);
    });
  }

  // ---------------------------------------------------------------- boot
  document.getElementById('sec-period').textContent = periodLabel();
  var saved = null;
  try { saved = localStorage.getItem('nutaste-sec-person'); } catch (e) { /* ignore */ }
  if (saved) {
    var m = roster.filter(function (r) { return r.name === saved; })[0];
    if (m) select(m);
  }
})();

