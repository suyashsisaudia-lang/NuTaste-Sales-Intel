
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
  // ITEM and PCAT came later; a file written before them simply ends at VAL,
  // and pv() reads the missing index as blank.
  var SL = { P: 0, DAY: 1, BUYER: 2, PGROUP: 3, CITY: 4, QTY: 5, VAL: 6, ITEM: 7, PCAT: 8 };

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

  // "All": everyone this viewer can see, taken together. S is already scoped
  // on the server to the viewer and the people below them, so its tables are
  // the whole team. Ask AI sends person -1 for it, which the server reads the
  // same way.
  var teamEntry = null;
  if (roster.length > 1) {
    teamEntry = {
      ix: -1, name: 'All', team: true, people: roster.length,
      d: { visits: S.visits, demos: S.demos, leads: S.leads,
           travel: S.travel, expenses: S.expenses, sales: S.sales },
      visits: S.visits.length,
      salesValue: S.sales.reduce(function (a, r) { return a + r[SL.VAL]; }, 0)
    };
  }
  function title(person) {
    return person.team ? 'All · ' + person.people + ' people' : person.name;
  }
  // How a sentence names the selection: "Asha Rao has no demos", "This team has no demos".
  function who(person) { return person.team ? 'This team' : person.name; }

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
  // Tooltips: hover with a mouse; on a phone or tablet a tap shows the same
  // text for a few seconds. Either way the box is kept inside the screen.
  var tipHide = null;
  function placeTip(x, y) {
    tipEl.style.left = x + 'px';
    tipEl.style.top = y + 'px';
    var w = tipEl.offsetWidth, h = tipEl.offsetHeight, m = 8;
    tipEl.style.left = Math.min(Math.max(x, w / 2 + m), window.innerWidth - w / 2 - m) + 'px';
    tipEl.style.top = Math.max(y, h + 9 + m) + 'px';
  }
  window.addEventListener('scroll', function () { tipEl.classList.remove('on'); }, { passive: true });
  function bindTip(node, text) {
    node.addEventListener('mouseenter', function () {
      tipEl.textContent = text; tipEl.classList.add('on');
    });
    node.addEventListener('mousemove', function (e) { placeTip(e.clientX, e.clientY); });
    node.addEventListener('mouseleave', function () { tipEl.classList.remove('on'); });
    node.addEventListener('pointerup', function (e) {
      if (e.pointerType === 'mouse') return;
      tipEl.textContent = text;
      tipEl.classList.add('on');
      placeTip(e.clientX, e.clientY);
      clearTimeout(tipHide);
      tipHide = setTimeout(function () { tipEl.classList.remove('on'); }, 2800);
    });
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
      r.forEach(function (cell, i) {
        var td = el('td', i >= numFrom ? 'n' : null, cell);
        td.setAttribute('data-label', cols[i] || '');   // phones show each row as a labelled card
        x.appendChild(td);
      });
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
      byItem: {}, byCat: {},
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
      var c = pv('pcat', r[SL.PCAT]);
      s.byCat[c] = (s.byCat[c] || 0) + r[SL.VAL];
      var it = pv('item', r[SL.ITEM]);
      var e = s.byItem[it] || (s.byItem[it] = { value: 0, qty: 0, cat: c, outlets: {} });
      e.value += r[SL.VAL];
      e.qty += r[SL.QTY];
      e.outlets[r[SL.BUYER]] = 1;
    });
    s.activeDays = Object.keys(s.visitDays).length;
    s.outletCount = Object.keys(s.outlets).length;
    return s;
  }

  function topEntries(obj, n) {
    return Object.keys(obj).map(function (k) { return [k, obj[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, n || 10);
  }

  // "All" only: each person's secondary sales and field activity, largest
  // sales first. A row opens that person's own view.
  var TEAM_SHOWN = 10;
  function teamCard(s) {
    var rows = roster.filter(function (r) {
      var d = r.d;
      return d.visits.length || d.demos.length || d.leads.length || d.sales.length ||
             d.travel.length || d.expenses.length;
    }).slice().sort(function (a, b) {
      return (b.salesValue - a.salesValue) || (b.visits - a.visits) || a.name.localeCompare(b.name);
    });
    var idle = roster.length - rows.length;

    var c = card('By person', rows.length + ' with activity' +
      (idle ? ' · ' + idle + ' with none' : ''));
    if (!rows.length) {
      c.body.appendChild(el('p', 'card-note', 'No one has activity in this period.'));
      return c.root;
    }
    var scale = Math.max.apply(null, rows.map(function (r) { return Math.abs(r.salesValue); })) || 1;
    var bars = el('div', 'bars cust-bars team-bars');
    rows.forEach(function (r, i) {
      var row = el('div', 'bar-row cust-row team-row');
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.title = 'Open ' + r.name;

      var meta = el('div', 'bar-meta');
      meta.appendChild(el('span', 'bar-rank', String(i + 1)));
      meta.appendChild(el('span', 'bar-name', r.name));
      meta.appendChild(el('span', 'bar-zone', r.visits + ' visit' + (r.visits === 1 ? '' : 's') +
        ' · ' + r.d.demos.length + ' demo' + (r.d.demos.length === 1 ? '' : 's') +
        ' · ' + r.d.leads.length + ' lead' + (r.d.leads.length === 1 ? '' : 's')));

      var line = el('div', 'bar-line');
      var track = el('div', 'bar-track');
      var fill = el('div', 'bar-fill');
      fill.style.width = (r.salesValue ? Math.max(1, Math.abs(r.salesValue) / scale * 100) : 0) + '%';
      fill.style.background = 'var(--ok)';
      track.appendChild(fill);
      bindTip(track, r.name + ' · ' + money(r.salesValue) + ' · ' +
        pctOf(r.salesValue, s.salesValue) + ' of team sales');
      line.appendChild(track);
      line.appendChild(el('div', 'bar-val num', money(r.salesValue)));

      row.appendChild(meta);
      row.appendChild(line);
      row.addEventListener('click', function () { select(r); window.scrollTo({ top: 0, behavior: 'smooth' }); });
      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
      });
      bars.appendChild(row);
    });
    c.body.appendChild(bars);
    if (rows.length > TEAM_SHOWN) {
      var hidden = [].slice.call(bars.children, TEAM_SHOWN);
      hidden.forEach(function (n) { n.hidden = true; });
      var more = el('button', 'team-more', 'Show all ' + rows.length);
      more.type = 'button';
      more.addEventListener('click', function () {
        var open = more.getAttribute('aria-expanded') !== 'true';
        hidden.forEach(function (n) { n.hidden = !open; });
        more.setAttribute('aria-expanded', String(open));
        more.textContent = open ? 'Show top ' + TEAM_SHOWN : 'Show all ' + rows.length;
      });
      c.body.appendChild(more);
    }
    return c.root;
  }

  // ---------------------------------------------------------------- views
  function renderOverview(person, s) {
    var host = document.getElementById('sec-overview');
    host.textContent = '';

    var nothing = !s.visits && !s.demos && !s.leads && !s.salesValue &&
                  !s.km && !s.expense;
    if (nothing) {
      var nc = card(title(person), periodLabel());
      var box = el('div', 'notice');
      box.innerHTML = person.team
        ? '<strong>No activity recorded in this period.</strong> No one in this team ' +
          'has visits, demos, leads, secondary sales, travel or expenses between ' +
          periodLabel() + '.'
        : '<strong>No activity recorded in this period.</strong> ' +
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
      var vb = el('div', 'bars bars-fit');
      types.forEach(function (t) {
        vb.appendChild(barRow(t[0], t[1], vmax, 'var(--accent)',
          t[0] + ' · ' + t[1] + ' visits · ' + pctOf(t[1], s.visits) + ' of activity',
          function (n) { return String(n); }));
      });
      vt.body.appendChild(vb);
    }
    g.appendChild(vt.root);

    var dc = card('Daily activity', 'visits per day');
    var ym = S.periodFrom.split('-');
    var monthDays = new Date(+ym[0], +ym[1], 0).getDate();   // 28-31 for the month shown
    var monName = MON[+ym[1] - 1];
    var days = [];
    for (var i = 1; i <= monthDays; i++) days.push(0);
    person.d.visits.forEach(function (r) { if (r[V.DAY] && r[V.DAY] <= monthDays) days[r[V.DAY] - 1]++; });
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
    // date axis, one tick per bar: day number over the month ("1" / "Oct").
    // Phones show odd days only, see CSS.
    var axis = el('div', 'spark-axis');
    axis.setAttribute('aria-hidden', 'true');
    days.forEach(function (v, i) {
      var t = el('span', 'spark-tick' + ((i + 1) % 2 ? '' : ' even'));
      t.appendChild(el('b', 'num', String(i + 1)));
      t.appendChild(el('small', null, monName));
      axis.appendChild(t);
    });
    dc.body.appendChild(axis);
    var legend = el('p', 'card-note');
    legend.style.marginTop = '10px';
    legend.textContent = 'Busiest day ' + dmax + ' visits · ' + s.activeDays +
                         ' of ' + monthDays + ' days had activity';
    dc.body.appendChild(legend);
    g.appendChild(dc.root);
    host.appendChild(g);

    if (person.team) host.appendChild(teamCard(s));

    // ---- top customers by sales value
    var buyers = topEntries(s.byBuyer, 10);
    var bc = card('Top customers by secondary sales', buyers.length + ' of ' +
      Object.keys(s.byBuyer).length + ' shown');
    if (!buyers.length) {
      bc.body.appendChild(el('p', 'card-note', 'No secondary sales recorded' + (person.team ? '.' : ' for this person.')));
    } else {
      var bmax = buyers[0][1];
      var bb = el('div', 'bars bars-fit');
      buyers.forEach(function (b) {
        bb.appendChild(barRow(b[0], b[1], bmax, 'var(--ok)',
          b[0] + ' · ' + money(b[1]) + ' · ' + pctOf(b[1], s.salesValue) + ' of sales'));
      });
      bc.body.appendChild(bb);
    }
    host.appendChild(bc.root);

    // ---- top items by sales value
    var itemVals = {};
    Object.keys(s.byItem).forEach(function (k) { itemVals[k] = s.byItem[k].value; });
    var items = topEntries(itemVals, 10);
    var ic = card('Top items by secondary sales', items.length + ' of ' +
      Object.keys(itemVals).length + ' shown');
    if (!items.length) {
      ic.body.appendChild(el('p', 'card-note', 'No secondary sales recorded' + (person.team ? '.' : ' for this person.')));
    } else {
      var imax = items[0][1];
      var ib = el('div', 'bars bars-fit');
      items.forEach(function (t) {
        var e = s.byItem[t[0]];
        ib.appendChild(barRow(t[0], t[1], imax, 'var(--ok)',
          t[0] + ' · ' + money(t[1]) + ' · ' + Math.round(e.qty).toLocaleString('en-IN') +
          ' units · ' + pctOf(t[1], s.salesValue) + ' of sales'));
      });
      ic.body.appendChild(ib);
      ic.body.appendChild(el('p', 'card-note',
        'Every item, with units and outlets, is under Activity detail.'));
    }
    host.appendChild(ic.root);

    // ---- product mix + effort
    var g2 = el('div', 'grid-2');
    var pc = card('Product categories', 'share of sales value');
    var cats = topEntries(s.byCat, 10);
    if (!cats.length) {
      pc.body.appendChild(el('p', 'card-note', 'No sales to break down.'));
    } else {
      var pmax = cats[0][1];
      var pb = el('div', 'bars bars-fit');
      cats.forEach(function (p) {
        pb.appendChild(barRow(p[0], p[1], pmax, 'var(--sev-2)',
          p[0] + ' · ' + money(p[1]) + ' · ' + pctOf(p[1], s.salesValue)));
      });
      pc.body.appendChild(pb);
      // The two product groups sit above the categories; kept as one line.
      var groups = topEntries(s.byProduct, 8);
      pc.body.appendChild(el('p', 'card-note', 'Product groups: ' + groups.map(function (p) {
        return p[0] + ' ' + money(p[1]) + ' (' + pctOf(p[1], s.salesValue) + ')';
      }).join(' · ')));
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
    // On "All", put the person's name after the date so every row says whose it is.
    function withPerson(cols, rows, numFrom, srcRows) {
      if (!person.team) return table(cols, rows, numFrom);
      return table([cols[0], 'Person'].concat(cols.slice(1)),
        rows.map(function (r, i) { return [r[0], S.people[srcRows[i][0]]].concat(r.slice(1)); }),
        numFrom + 1);
    }

    // ---- items sold, every one of them, largest first
    var itemKeys = Object.keys(s.byItem).sort(function (a, b) {
      return s.byItem[b].value - s.byItem[a].value;
    });
    var sc = card('Items sold', itemKeys.length + ' item' + (itemKeys.length === 1 ? '' : 's') +
      ' in ' + periodLabel());
    if (!itemKeys.length) {
      sc.body.appendChild(el('p', 'card-note', 'No secondary sales recorded.'));
    } else {
      var irows = itemKeys.map(function (k) {
        var e = s.byItem[k];
        return [k, e.cat, Math.round(e.qty).toLocaleString('en-IN'),
                money(e.value), pctOf(e.value, s.salesValue),
                String(Object.keys(e.outlets).length)];
      });
      sc.body.appendChild(table(['Item', 'Category', 'Units', 'Value', 'Share', 'Outlets'],
        irows, 2));
    }
    host.appendChild(sc.root);

    // ---- visits
    var vc = card('Visits', d.visits.length + ' in ' + periodLabel());
    if (!d.visits.length) {
      vc.body.appendChild(el('p', 'card-note', 'No visits recorded.'));
    } else {
      var vsrc = d.visits.slice().sort(function (a, b) { return a[V.DAY] - b[V.DAY]; })
        .slice(0, 200);
      var vrows = vsrc.map(function (r) {
          return [dayLabel(r[V.DAY]), pv('buyer', r[V.BUYER]), pv('vtype', r[V.TYPE]),
                  pv('city', r[V.CITY]), pv('channel', r[V.CHAN]),
                  r[V.MINS] ? r[V.MINS] + ' min' : '—'];
        });
      vc.body.appendChild(withPerson(['Date', 'Outlet', 'Type', 'City', 'Channel', 'Duration'],
        vrows, 5, vsrc));
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
      var dsrc = d.demos.slice().sort(function (a, b) { return b[DM.VAL] - a[DM.VAL]; });
      var drows = dsrc.map(function (r) {
          return [dayLabel(r[DM.DAY]), pv('buyer', r[DM.BUYER]), pv('region', r[DM.REGION]),
                  pv('stage', r[DM.STAGE]), r[DM.CONV] ? 'Yes' : 'No', money(r[DM.VAL])];
        });
      dc.body.appendChild(withPerson(['Date', 'Customer', 'Region', 'Stage', 'Converted', 'Est. value'],
        drows, 5, dsrc));
    }
    host.appendChild(dc.root);

    // ---- leads
    var lc = card('Leads', d.leads.length + ' in ' + periodLabel());
    if (!d.leads.length) {
      lc.body.appendChild(el('p', 'card-note', 'No leads recorded.'));
    } else {
      var lsrc = d.leads.slice().sort(function (a, b) { return b[LD.VAL] - a[LD.VAL]; });
      var lrows = lsrc.map(function (r) {
          return [dayLabel(r[LD.DAY]), pv('buyer', r[LD.BUYER]), pv('city', r[LD.CITY]),
                  pv('lstage', r[LD.STAGE]), pv('status', r[LD.STATUS]), money(r[LD.VAL])];
        });
      lc.body.appendChild(withPerson(['Date', 'Company', 'City', 'Stage', 'Status', 'Est. value'],
        lrows, 5, lsrc));
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

  // ================================================================
  // ASK — natural-language questions about this person's month.
  // (The AI analyst path also sees the full calendar year as exact totals; the
  // built-in engine below stays on the month on screen — see beyondMonth.)
  //
  // Same contract as the receivables Ask box: the model chooses a table and a
  // filter, and every figure on screen is computed HERE from the real rows. No
  // number ever comes back from the model. If the model is unavailable, out of
  // quota or switched off, the built-in parser below answers instead, so the
  // box is never dead.
  // ================================================================

  // ---- one descriptor per table: how to filter it, measure it and print it.
  // The column maps (V, DM, LD, TR, EX, SL) are the ones declared at the top of
  // this file, so a change to the payload shape is made in one place.
  var DSETS = {
    sales: {
      key: 'sales', label: 'secondary sales', one: 'sale line', many: 'sale lines',
      day: SL.DAY,
      fields: { customer: SL.BUYER, city: SL.CITY, productGroup: SL.PGROUP,
                item: SL.ITEM, productCategory: SL.PCAT },
      pools: { customer: 'buyer', city: 'city', productGroup: 'pgroup',
               item: 'item', productCategory: 'pcat' },
      metricCol: { value: SL.VAL, quantity: SL.QTY }, defaultMetric: 'value',
      cols: ['Date', 'Outlet', 'Item', 'City', 'Qty', 'Value'], numFrom: 4,
      row: function (r) {
        return [dayLabel(r[SL.DAY]), pv('buyer', r[SL.BUYER]), pv('item', r[SL.ITEM]),
                pv('city', r[SL.CITY]), r[SL.QTY].toLocaleString('en-IN'), money(r[SL.VAL])];
      }
    },
    visits: {
      key: 'visits', label: 'visits', one: 'visit', many: 'visits',
      day: V.DAY,
      fields: { customer: V.BUYER, city: V.CITY, channel: V.CHAN, visitType: V.TYPE },
      pools: { customer: 'buyer', city: 'city', channel: 'channel', visitType: 'vtype' },
      metricCol: { minutes: V.MINS }, defaultMetric: 'count',
      cols: ['Date', 'Outlet', 'Type', 'City', 'Channel', 'Duration'], numFrom: 5,
      row: function (r) {
        return [dayLabel(r[V.DAY]), pv('buyer', r[V.BUYER]), pv('vtype', r[V.TYPE]),
                pv('city', r[V.CITY]), pv('channel', r[V.CHAN]),
                r[V.MINS] ? r[V.MINS] + ' min' : '—'];
      }
    },
    demos: {
      key: 'demos', label: 'demos', one: 'demo', many: 'demos',
      day: DM.DAY,
      fields: { customer: DM.BUYER, region: DM.REGION, stage: DM.STAGE, status: DM.STATUS },
      pools: { customer: 'buyer', region: 'region', stage: 'stage', status: 'status' },
      metricCol: { value: DM.VAL }, defaultMetric: 'count',
      conv: DM.CONV,
      cols: ['Date', 'Customer', 'Region', 'Stage', 'Converted', 'Est. value'], numFrom: 5,
      row: function (r) {
        return [dayLabel(r[DM.DAY]), pv('buyer', r[DM.BUYER]), pv('region', r[DM.REGION]),
                pv('stage', r[DM.STAGE]), r[DM.CONV] ? 'Yes' : 'No', money(r[DM.VAL])];
      }
    },
    leads: {
      key: 'leads', label: 'leads', one: 'lead', many: 'leads',
      day: LD.DAY,
      fields: { customer: LD.BUYER, city: LD.CITY, stage: LD.STAGE,
                status: LD.STATUS, leadType: LD.TYPE },
      pools: { customer: 'buyer', city: 'city', stage: 'lstage',
               status: 'status', leadType: 'ltype' },
      metricCol: { value: LD.VAL }, defaultMetric: 'value',
      cols: ['Date', 'Company', 'City', 'Stage', 'Status', 'Est. value'], numFrom: 5,
      row: function (r) {
        return [dayLabel(r[LD.DAY]), pv('buyer', r[LD.BUYER]), pv('city', r[LD.CITY]),
                pv('lstage', r[LD.STAGE]), pv('status', r[LD.STATUS]), money(r[LD.VAL])];
      }
    },
    travel: {
      key: 'travel', label: 'travel', one: 'day of travel', many: 'days of travel',
      day: TR.DAY,
      fields: {}, pools: {},
      metricCol: { km: TR.TOTAL, workKm: TR.WORK }, defaultMetric: 'km',
      cols: ['Date', 'Working km', 'Total km'], numFrom: 1,
      row: function (r) {
        return [dayLabel(r[TR.DAY]), Math.round(r[TR.WORK]).toLocaleString('en-IN'),
                Math.round(r[TR.TOTAL]).toLocaleString('en-IN')];
      }
    },
    expenses: {
      key: 'expenses', label: 'expenses', one: 'claim', many: 'claims',
      day: EX.DAY,
      fields: { region: EX.REGION }, pools: { region: 'region' },
      metricCol: { value: EX.AMT }, defaultMetric: 'value',
      cols: ['Date', 'Region', 'Amount'], numFrom: 2,
      row: function (r) {
        return [dayLabel(r[EX.DAY]), pv('region', r[EX.REGION]), money(r[EX.AMT])];
      }
    }
  };

  // Field -> how it reads in a chip or a column heading.
  var FIELD_LABEL = {
    customer: 'customer', city: 'city', channel: 'channel', visitType: 'visit type',
    region: 'region', stage: 'stage', status: 'status', leadType: 'lead type',
    productGroup: 'product group', item: 'item', productCategory: 'product category',
    day: 'day'
  };
  var SEC_FILTER_FIELDS = ['customer', 'city', 'channel', 'visitType', 'region',
                           'stage', 'status', 'leadType', 'productGroup',
                           'item', 'productCategory'];

  function metricFmt(metric) {
    if (metric === 'count') return function (n) { return Math.round(n).toLocaleString('en-IN'); };
    if (metric === 'quantity') return function (n) { return Math.round(n).toLocaleString('en-IN') + ' units'; };
    if (metric === 'minutes') return function (n) { return Math.round(n).toLocaleString('en-IN') + ' min'; };
    if (metric === 'km' || metric === 'workKm') {
      return function (n) { return Math.round(n).toLocaleString('en-IN') + ' km'; };
    }
    return money;
  }
  var METRIC_NOUN = {
    value: 'value', count: 'number of rows', quantity: 'units',
    minutes: 'minutes', km: 'distance', workKm: 'working distance'
  };

  // ---- which tables this person actually has rows in, in a fixed order, as
  // labels: "visits, travel and expenses". Used to explain an empty table
  // rather than leaving it looking like a failed search.
  var DS_ORDER = ['sales', 'visits', 'demos', 'leads', 'travel', 'expenses'];

  function datasetsWithRows(person) {
    return DS_ORDER.filter(function (k) { return (person.d[k] || []).length > 0; });
  }

  function joinLabels(keys) {
    var names = keys.map(function (k) { return DSETS[k].label; });
    if (names.length <= 1) return names[0] || '';
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  // ---- the query engine. `f` is a normalised filter, never the model's raw
  // output: specToSecFilter and the built-in parser both produce this shape.
  function runSecQuery(f, person) {
    var ds = DSETS[f.dataset] || DSETS.sales;
    var all = person.d[ds.key] || [];
    var rows = all.slice();
    // Each table has a natural measure — rupees for sales, a headcount for
    // visits, kilometres for travel — used whenever the question does not name
    // one. It mirrors default_metric in app/ask_sec.py.
    var metric = (f.metric && (f.metric === 'count' || ds.metricCol[f.metric]))
      ? f.metric : ds.defaultMetric;
    var col = ds.metricCol[metric];
    var fmt = metricFmt(metric);

    function valueOf(r) { return metric === 'count' ? 1 : (r[col] || 0); }

    // ---- filter
    rows = rows.filter(function (r) {
      for (var i = 0; i < SEC_FILTER_FIELDS.length; i++) {
        var field = SEC_FILTER_FIELDS[i], want = f[field];
        if (want == null) continue;
        var c = ds.fields[field];
        if (c == null) continue;               // this table has no such column
        if (field === 'customer') {
          if (want.indexOf(r[c]) === -1) return false;
        } else if (r[c] !== want.ix) {
          return false;
        }
      }
      if (f.converted != null && ds.conv != null) {
        if (!!r[ds.conv] !== f.converted) return false;
      }
      var day = r[ds.day];
      if (f.dayFrom != null && day < f.dayFrom) return false;
      if (f.dayTo != null && day > f.dayTo) return false;
      return true;
    });

    var total = rows.reduce(function (a, r) { return a + valueOf(r); }, 0);
    var count = rows.length;
    var period = periodLabel();

    if (!count) {
      // Two very different absences, told apart here. If the table itself is
      // empty for this person, no rewording of the question can ever find a
      // row, so "try widening" would send someone round in circles — say the
      // table is empty and name what they do have instead.
      if (!all.length) {
        var others = datasetsWithRows(person).filter(function (k) { return k !== ds.key; });
        return {
          empty: true, emptyTable: true,
          big: '—', head: 'No ' + ds.many + ' recorded',
          note: who(person) + ' has no ' + ds.many + ' at all in ' + period +
                (others.length
                  ? '. This month only has ' + joinLabels(others) + ' for this person.'
                  : '.'),
          table: [], body: [], more: 0
        };
      }
      return {
        empty: true,
        big: '—', head: 'Nothing matched',
        note: 'This person has ' + all.length + ' ' + (all.length === 1 ? ds.one : ds.many) +
              ' in ' + period + ', but none match these filters. Try widening the question.',
        table: [], body: [], more: 0
      };
    }

    // ---- "how many" — the count is the answer, the rows are the evidence
    if (f.countOnly && !f.groupBy) {
      // Counting rows says nothing about what they came to, so the table's own
      // measure is added alongside: "140 visits, 1,204 minutes between them".
      var alt = Object.keys(ds.metricCol)[0];
      var altNote = alt
        ? 'Together they come to ' + metricFmt(alt)(
            rows.reduce(function (a, r) { return a + (r[ds.metricCol[alt]] || 0); }, 0)) +
          ' in ' + period + '.'
        : 'In ' + period + '.';
      return {
        big: count.toLocaleString('en-IN'),
        head: ds.many.charAt(0).toUpperCase() + ds.many.slice(1) + ' matching',
        note: metric === 'count' ? altNote
          : 'Their combined ' + METRIC_NOUN[metric] + ' is ' + fmt(total) + ', in ' + period + '.',
        table: ds.cols, numFrom: ds.numFrom,
        body: sortRows(rows, ds, valueOf, f).slice(0, 25).map(ds.row),
        more: count > 25 ? count - 25 : 0
      };
    }

    // ---- grouped breakdown
    if (f.groupBy) {
      var groups = groupRows(rows, ds, f.groupBy, valueOf);
      var asc = f.sort === 'smallest';
      if (f.groupBy === 'day') {
        groups.sort(function (a, b) { return a.order - b.order; });
        if (f.sort === 'largest' || f.sort === 'smallest' || f.superlative || f.topN) {
          groups.sort(function (a, b) { return asc ? a.v - b.v : b.v - a.v; });
        }
      } else {
        groups.sort(function (a, b) { return asc ? a.v - b.v : b.v - a.v; });
      }

      // A superlative changes the headline, not the list: the winner is the big
      // figure, and the rest of the ranking stays on screen as the evidence for
      // it. Cutting the table to one row would make the claim unreadable.
      var limit = f.topN || 15;
      var shown = groups.slice(0, limit);
      var head, big, note;

      if (f.superlative && shown.length) {
        big = fmt(shown[0].v);
        head = shown[0].k;
        note = 'The ' + (asc ? 'lowest' : 'highest') + ' of ' + groups.length + ' ' +
               FIELD_LABEL[f.groupBy] + '(s), out of ' + fmt(total) + ' across ' +
               count + ' ' + (count === 1 ? ds.one : ds.many) + ' in ' + period + '.';
      } else if (f.countOnly) {
        big = groups.length.toLocaleString('en-IN');
        head = FIELD_LABEL[f.groupBy].charAt(0).toUpperCase() +
               FIELD_LABEL[f.groupBy].slice(1) + '(s) with activity';
        note = 'Across ' + count + ' ' + (count === 1 ? ds.one : ds.many) +
               ' totalling ' + fmt(total) + ' in ' + period + '.';
      } else {
        big = fmt(total);
        head = ds.label.charAt(0).toUpperCase() + ds.label.slice(1) + ' by ' +
               FIELD_LABEL[f.groupBy];
        note = groups.length + ' ' + FIELD_LABEL[f.groupBy] + '(s) across ' + count +
               ' ' + (count === 1 ? ds.one : ds.many) + ' in ' + period +
               (f.topN ? '. Showing the top ' + Math.min(f.topN, groups.length) + '.' : '.');
      }

      // When the measure IS the row count, the count column and the measure
      // column are the same number twice, so only one is printed.
      var groupCol = FIELD_LABEL[f.groupBy].charAt(0).toUpperCase() +
                     FIELD_LABEL[f.groupBy].slice(1);
      var countCol = ds.many.charAt(0).toUpperCase() + ds.many.slice(1);
      var metricCol = METRIC_NOUN[metric].charAt(0).toUpperCase() +
                      METRIC_NOUN[metric].slice(1);

      return {
        big: big, head: head, note: note,
        table: metric === 'count' ? [groupCol, countCol, 'Share']
                                  : [groupCol, countCol, metricCol, 'Share'],
        numFrom: 1,
        body: shown.map(function (g) {
          return metric === 'count'
            ? [g.k, g.n.toLocaleString('en-IN'), pctOf(g.v, total)]
            : [g.k, g.n.toLocaleString('en-IN'), fmt(g.v), pctOf(g.v, total)];
        }),
        more: groups.length > shown.length ? groups.length - shown.length : 0
      };
    }

    // ---- a single record
    if (f.superlative) {
      var ordered = sortRows(rows, ds, valueOf, { sort: f.sort || 'largest' });
      var top = ordered[0];
      return {
        big: fmt(valueOf(top)),
        head: ds.fields.customer != null ? pv(ds.pools.customer, top[ds.fields.customer])
                                         : dayLabel(top[ds.day]),
        note: 'The ' + (f.sort === 'smallest' ? 'smallest' : 'largest') + ' of ' + count +
              ' ' + (count === 1 ? ds.one : ds.many) + ' in ' + period +
              ', which together come to ' + fmt(total) + '.',
        table: ds.cols, numFrom: ds.numFrom,
        body: ordered.slice(0, 15).map(ds.row),
        more: count > 15 ? count - 15 : 0
      };
    }

    // ---- plain total
    var listed = sortRows(rows, ds, valueOf, f);
    var cap = f.topN || 25;
    return {
      big: fmt(total),
      head: ds.label.charAt(0).toUpperCase() + ds.label.slice(1) + ' — ' + METRIC_NOUN[metric],
      note: 'From ' + count + ' ' + (count === 1 ? ds.one : ds.many) + ' in ' + period + '.',
      table: ds.cols, numFrom: ds.numFrom,
      body: listed.slice(0, cap).map(ds.row),
      more: count > cap ? count - cap : 0
    };
  }

  function sortRows(rows, ds, valueOf, f) {
    var out = rows.slice();
    var sort = f && f.sort;
    if (sort === 'earliest') out.sort(function (a, b) { return a[ds.day] - b[ds.day]; });
    else if (sort === 'latest') out.sort(function (a, b) { return b[ds.day] - a[ds.day]; });
    else if (sort === 'smallest') out.sort(function (a, b) { return valueOf(a) - valueOf(b); });
    else out.sort(function (a, b) { return valueOf(b) - valueOf(a); });
    return out;
  }

  function groupRows(rows, ds, groupBy, valueOf) {
    var acc = {};
    rows.forEach(function (r) {
      var key, order;
      if (groupBy === 'day') {
        order = r[ds.day];
        key = dayLabel(r[ds.day]);
      } else {
        var c = ds.fields[groupBy];
        if (c == null) return;
        key = pv(ds.pools[groupBy], r[c]);
        order = 0;
      }
      var g = acc[key] || (acc[key] = { k: key, v: 0, n: 0, order: order });
      g.v += valueOf(r);
      g.n += 1;
    });
    return Object.keys(acc).map(function (k) { return acc[k]; });
  }

  // ---- AI plumbing. Deliberately a small copy of the receivables version
  // rather than a shared module: the two sections are separate scripts, and a
  // fault in one must not take the other's Ask box down with it. The model
  // choice is shared through localStorage so the picker agrees across sections.
  var aiTimeoutMs = 15000;
  // Analyst mode reads a few hundred rows and writes prose, so it is given a
  // much longer leash than the filter classification ever needed.
  var analystTimeoutMs = 80000;
  var aiEnabled = null;
  var aiAnalyst = false;
  var MODEL_STORE_KEY = 'nsd.askModel';
  var chosenModel = '';
  try { chosenModel = window.localStorage.getItem(MODEL_STORE_KEY) || ''; } catch (e) { chosenModel = ''; }

  function rememberModel(id) {
    chosenModel = id || '';
    try { window.localStorage.setItem(MODEL_STORE_KEY, chosenModel); } catch (e) { /* private mode */ }
  }

  function aiStatus() {
    if (aiEnabled !== null) return Promise.resolve(aiEnabled);
    return fetch('/api/ask/status', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { enabled: false }; })
      .then(function (j) {
        aiEnabled = !!j.enabled;
        aiAnalyst = !!j.analyst;
        if (j.timeoutMs > 0) aiTimeoutMs = j.timeoutMs;
        if (j.analystTimeoutMs > 0) analystTimeoutMs = j.analystTimeoutMs;
        return aiEnabled;
      })
      .catch(function () { aiEnabled = false; return false; });
  }

  function loadModels() {
    return fetch('/api/ask/models', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { enabled: false, models: [] }; })
      .catch(function () { return { enabled: false, models: [] }; });
  }

  // Resolves to { answer, caveat, exactOnly, model } or null. Never rejects: a
  // failure here falls back to the built-in parser like any other AI failure.
  function askAnalystAI(text, person) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, analystTimeoutMs);
    return fetch('/api/ask/sec/analyst', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      // month: person.ix only means something within the month on screen
      body: JSON.stringify({ question: text, person: person.ix, model: chosenModel,
                             month: window.SEC_MONTH || null }),
      signal: ctl.signal
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return (j && j.ok && j.answer) ? j : null; })
      .catch(function () { return null; })
      .then(function (out) { clearTimeout(timer); return out; });
  }

  // Resolves to { spec, model, narrate } or null. Never rejects: a failure here
  // must fall back to the built-in parser, not break the page.
  function askAI(text, person) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, aiTimeoutMs);
    return fetch('/api/ask/sec', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      // month: person.ix only means something within the month on screen
      body: JSON.stringify({ question: text, person: person.ix, model: chosenModel,
                             month: window.SEC_MONTH || null }),
      signal: ctl.signal
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        return (j && j.ok && j.spec)
          ? { spec: j.spec, model: j.model, narrate: j.narrate } : null;
      })
      .catch(function () { return null; })
      .then(function (out) { clearTimeout(timer); return out; });
  }

  // Turn the validated spec into the filter runSecQuery understands, and
  // describe it in chips. The chips are built HERE, from the fields that will
  // actually be applied — never from anything the model wrote — so the "Read as"
  // line can never describe a filter the query did not run.
  function specToSecFilter(spec) {
    var ds = DSETS[spec.dataset] || DSETS.sales;
    var f = { dataset: ds.key, metric: spec.metric, chips: [], ignored: [] };
    f.chips.push(ds.label);

    if (spec.buyerIds && spec.buyerIds.length) {
      f.customer = spec.buyerIds;
      f.chips.push(spec.buyerIds.length === 1
        ? 'customer: ' + (spec.buyerNames ? spec.buyerNames[0] : '1 customer')
        : spec.buyerIds.length + ' matching customers');
    }

    ['city', 'channel', 'visitType', 'region', 'stage', 'status', 'leadType', 'productGroup',
     'item', 'productCategory']
      .forEach(function (field) {
        var v = spec[field];
        if (v && typeof v.ix === 'number') {
          f[field] = v;
          f.chips.push(FIELD_LABEL[field] + ': ' + v.label);
        }
      });

    if (spec.converted === true) { f.converted = true; f.chips.push('converted only'); }
    if (spec.converted === false) { f.converted = false; f.chips.push('not converted'); }

    if (spec.dayFrom != null) { f.dayFrom = spec.dayFrom; }
    if (spec.dayTo != null) { f.dayTo = spec.dayTo; }
    if (spec.dayFrom != null && spec.dayTo != null) {
      f.chips.push('days ' + spec.dayFrom + '–' + spec.dayTo);
    } else if (spec.dayFrom != null) {
      f.chips.push('from day ' + spec.dayFrom);
    } else if (spec.dayTo != null) {
      f.chips.push('up to day ' + spec.dayTo);
    }

    if (spec.groupBy) { f.groupBy = spec.groupBy; f.chips.push('by ' + FIELD_LABEL[spec.groupBy]); }
    if (spec.sort) {
      f.sort = spec.sort;
      if (spec.sort === 'smallest') f.chips.push('smallest first');
      else if (spec.sort === 'earliest') f.chips.push('earliest first');
      else if (spec.sort === 'latest') f.chips.push('latest first');
    }
    if (spec.topN) { f.topN = spec.topN; f.chips.push('top ' + spec.topN); }
    if (spec.countOnly) f.countOnly = true;
    if (spec.superlative) f.superlative = true;
    if (spec.metric && spec.metric !== 'count') f.chips.push('by ' + METRIC_NOUN[spec.metric]);

    if (spec.unsupported) f.ignored.push(spec.unsupported);
    return f;
  }

  // ---- built-in parser. Answers when the model is off, unavailable or out of
  // quota. It recognises the shapes people actually type rather than trying to
  // be clever, and says plainly when it cannot place a question.
  var DS_WORDS = [
    ['sales', /\b(sale|sales|sold|selling|sell|bought|buying|buys|purchase|purchased|secondary|revenue|turnover|billing|value sold|units?)\b/i],
    ['visits', /\b(visit|visits|visited|call|calls|outlet|outlets|coverage|field)\b/i],
    ['demos', /\b(demo|demos|demonstration|demonstrations|sampling|converted)\b/i],
    ['leads', /\b(lead|leads|pipeline|prospect|prospects|enquiry|enquiries|inquiry)\b/i],
    ['travel', /\b(travel|travelled|traveled|km|kms|kilometre|kilometer|distance|mileage)\b/i],
    ['expenses', /\b(expense|expenses|claim|claims|reimbursement|spend|cost)\b/i]
  ];
  var GROUP_WORDS = [
    ['productGroup', /\b(product groups?)\b/i],
    ['productCategory', /\b(product categor(?:y|ies)|categor(?:y|ies))\b/i],
    ['item', /\b(items?|products?|skus?)\b/i],
    ['city', /\b(city|cities|town|towns|location|locations)\b/i],
    ['channel', /\b(channel|channels)\b/i],
    ['visitType', /\b(visit type|type of visit|call type)\b/i],
    ['region', /\b(region|regions|zone|zones)\b/i],
    ['stage', /\b(stage|stages|funnel)\b/i],
    ['status', /\b(status|statuses)\b/i],
    ['leadType', /\b(lead type|type of lead)\b/i],
    ['day', /\b(day|days|daily|date|dates|busiest)\b/i],
    ['customer', /\b(customer|customers|outlet|outlets|buyer|buyers|account|accounts|client|clients|company|companies)\b/i]
  ];
  var NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
                    seven: 7, eight: 8, nine: 9, ten: 10 };

  // ---- concepts this month's activity does not carry at all. The model refuses
  // these itself through `spec.refusal`; the built-in parser needs its own list,
  // because otherwise a question about churn or targets keeps whatever
  // incidental word it happens to share with a real column — "customers" in
  // "which stage did I lose most customers" — and answers on that instead. A
  // confidently wrong total is worse than saying the data cannot support it.
  var OUT_OF_SCOPE = [
    [/\b(lose|loses|losing|lost|churn|churned|churning|attrition|win.?back|stopped buying|dropped off)\b/i,
     'this activity data records no won/lost outcome — the only statuses it holds are ' +
     'Active and Closed — and it covers one month, so there is nothing to have been lost against.'],
    [/\b(target|targets|quota|quotas|budget|budgets|achievement|vs plan|against plan)\b/i,
     'targets, quotas and plan figures are not part of this activity data.'],
    [/\b(incentive|incentives|commission|commissions|payout|salary)\b/i,
     'incentive and commission figures are not part of this activity data.'],
    [/\b(stock|stocks|inventory|expiry|shelf life|damages|breakage)\b/i,
     'stock, inventory and expiry are not part of this activity data.'],
    [/\b(margin|margins|profit|profitability|cogs|cost price|landing price)\b/i,
     'margin and profitability figures are not part of this activity data — only sale value is recorded.'],
    [/\b(competitor|competitors|competition|rival|rivals|market share)\b/i,
     'nothing about competitors or market share is recorded in this activity data.'],
    [/\b(trend|trends|growth|grew|decline|declined|drop(?:ped)? (?:versus|vs|against)|month.on.month|mom\b|year.on.year|yoy\b|last month|previous month|last year|compared to last)\b/i,
     'this data covers a single calendar month, so there is no earlier period to compare against.'],
    [/\b(primary sales|dispatch|dispatches|despatch|invoice raised|billing to distributor)\b/i,
     'primary sales and dispatches are not part of this data, which records secondary sales only.'],
    [/\b(receivable|receivables|outstanding|overdue|ageing|aging|collection|collections|payment received|credit days)\b/i,
     'receivables are not part of this activity data — use the Receivables tab for those.']
  ];

  function outOfScope(q) {
    for (var i = 0; i < OUT_OF_SCOPE.length; i++) {
      if (OUT_OF_SCOPE[i][0].test(q)) return OUT_OF_SCOPE[i][1];
    }
    return null;
  }

  // ---- questions about more than the month on screen. Only the AI analyst
  // sees the full year; the built-in engine reads this one month's rows, and
  // would otherwise answer "sales each month" or "sales in March" with this
  // month's total. The on-screen month's own name is allowed through. "May" is
  // left out: it is far more often the verb than the month.
  var MONTH_WORDS = [
    ['jan', 'january'], ['feb', 'february'], ['mar', 'march'], ['apr', 'april'], null,
    ['jun', 'june'], ['jul', 'july'], ['aug', 'august'], ['sep', 'sept', 'september'],
    ['oct', 'october'], ['nov', 'november'], ['dec', 'december']
  ];
  var BEYOND_MONTH = /\b(year|years|yearly|annual|annually|ytd|year.to.date|so far|all months|every month|each month|per month|by month|monthly|month.?wise|which month|what month|best month|worst month|months?.on.months?|trend|trends|growth|grew|decline|declined)\b/i;

  function beyondMonth(q) {
    if (BEYOND_MONTH.test(q)) return true;
    var shown = +S.periodFrom.split('-')[1] - 1;
    return MONTH_WORDS.some(function (names, i) {
      return names && i !== shown && new RegExp('\\b(' + names.join('|') + ')\\b', 'i').test(q);
    });
  }

  // Tables that can answer a question about a given field, in the order a person
  // most likely means them. Used only when the question names no table itself.
  var DS_FOR_FIELD_ORDER = ['sales', 'visits', 'leads', 'demos', 'expenses', 'travel'];

  function datasetForField(field) {
    for (var i = 0; i < DS_FOR_FIELD_ORDER.length; i++) {
      var key = DS_FOR_FIELD_ORDER[i];
      if (DSETS[key].fields[field] != null) return key;
    }
    return null;
  }

  // The question named no table. Rather than defaulting to sales and then
  // quietly discarding the very word that carried the meaning, let that word
  // pick the table: "which stage" can only mean leads or demos.
  function impliedDataset(q) {
    for (var g = 0; g < GROUP_WORDS.length; g++) {
      var field = GROUP_WORDS[g][0];
      if (field === 'day' || field === 'customer') continue;  // every table has these
      if (!GROUP_WORDS[g][1].test(q)) continue;
      var key = datasetForField(field);
      if (key) return key;
    }
    return null;
  }

  // Words that carry no meaning for a query: grammar, politeness and the verbs
  // people wrap a question in. Everything NOT in here and not matched by a
  // pattern above is treated as a word the engine could not account for, which
  // is what stops it answering a question it only half read.
  var FILLER = {};
  ('how what which who whom whose where when why many much ' +
   'i my me mine we our us you your he she they them their his her its ' +
   'it this that these those there here ' +
   'is are was were am be been being do did does done doing ' +
   'have has had having can could will would shall should may might must ' +
   'get got give given gives show shows showing tell tells list lists find ' +
   'make makes made making go goes going went put take takes taken ' +
   'sit sits sitting stand stands standing come comes coming came ' +
   'look looks looking see sees seen happening happened ' +
   'the a an of in on at to from for by with and or but as than then so if ' +
   'about into over under per each any all some both up down out ' +
   'only just also too very more less most least own ' +
   'total totals overall altogether sum summary figure figures ' +
   'number numbers data report reports please kindly want need know ' +
   'group groups wise name names breakdown split detail details ' +
   'month months period mtd during within across ' +
   'rs inr rupee done far now yet still ever'
  ).split(' ').forEach(function (w) { if (w) FILLER[w] = 1; });

  // Every word a matched pattern accounts for is recorded, so what is left over
  // can be checked. A leftover word means part of the question went unread.
  function leftoverWords(q, seen) {
    var rest = ' ' + q + ' ';
    seen.forEach(function (s) {
      if (!s) return;
      rest = rest.split(String(s).toLowerCase()).join(' ');
    });
    var out = [], dup = {};
    rest.replace(/[^a-z0-9]+/gi, ' ').trim().split(/\s+/).forEach(function (w) {
      w = w.toLowerCase();
      if (!w || w.length < 2 || FILLER[w] || dup[w]) return;
      dup[w] = 1;
      out.push(w);
    });
    return out;
  }

  function poolMatch(person, ds, field, q) {
    // Only values this person actually has are considered, so a question cannot
    // resolve against another person's city or product group.
    var col = ds.fields[field];
    if (col == null) return null;
    var poolName = ds.pools[field];
    var seen = {};
    (person.d[ds.key] || []).forEach(function (r) { seen[r[col]] = 1; });
    var best = null;
    Object.keys(seen).forEach(function (ix) {
      var label = pv(poolName, +ix);
      if (!label || label === '—' || label.length < 3) return;
      if (q.indexOf(label.toLowerCase()) === -1) return;
      if (!best || label.length > best.label.length) best = { ix: +ix, label: label };
    });
    return best;
  }

  function parseSecQuestion(text, person) {
    var q = ' ' + text.toLowerCase().trim() + ' ';
    var f = { chips: [], ignored: [] }, understood = false, seen = [];

    // Run a pattern, and record EVERY word it accounts for — not just the first
    // — so the leftover check at the end sees a question the parser read whole.
    function take(re) {
      var all = q.match(new RegExp(re.source, 'gi'));
      if (all) seen.push.apply(seen, all);
      return all ? all[0] : null;
    }

    // ---- is the question even about something this data holds? Checked first,
    // so a word that merely looks like a column cannot rescue it.
    var why = outOfScope(q);
    if (why) return { understood: false, refusal: why, f: f };

    // ---- which table
    for (var i = 0; i < DS_WORDS.length; i++) {
      if (take(DS_WORDS[i][1])) { f.dataset = DS_WORDS[i][0]; understood = true; break; }
    }
    var datasetNamed = !!f.dataset;
    if (!f.dataset) {
      var implied = impliedDataset(q);
      if (implied) { f.dataset = implied; understood = true; }
    }
    // No longer a silent default: with no table named and none implied, the
    // strict check at the end refuses. Sales is set only so the rest of the
    // parse has a shape to work against.
    var datasetKnown = !!f.dataset;
    if (!f.dataset) f.dataset = 'sales';
    var ds = DSETS[f.dataset];
    f.chips.push(ds.label);

    // ---- what to measure. `named` also decides what "how many" means below:
    // "how many visits" counts rows, but "how many km" totals a column.
    var named = false;
    if (ds.metricCol.quantity && take(/\b(units?|quantity|qty|pieces|cases)\b/i)) {
      f.metric = 'quantity'; named = true;
    } else if (ds.metricCol.minutes && take(/\b(minutes?|duration|time spent)\b/i)) {
      f.metric = 'minutes'; named = true;
    } else if (ds.metricCol.workKm && take(/\bworking\b/i)) {
      f.metric = 'workKm'; named = true;
    } else if (ds.metricCol.km && take(/\b(km|kms|kilometres?|kilometers?|distance|mileage)\b/i)) {
      f.metric = 'km'; named = true;
    } else if (ds.metricCol.value &&
               take(/\b(value|worth|rupees?|revenue|amount|turnover|much)\b/i)) {
      f.metric = 'value'; named = true;
    }
    if (f.metric) { f.chips.push('by ' + METRIC_NOUN[f.metric]); understood = true; }

    // ---- named values from this person's own rows
    SEC_FILTER_FIELDS.forEach(function (field) {
      if (field === 'customer') return;        // handled below, it needs a list
      var hit = poolMatch(person, ds, field, q);
      if (hit) {
        f[field] = hit; f.chips.push(FIELD_LABEL[field] + ': ' + hit.label);
        seen.push(hit.label); understood = true;
      }
    });
    var cust = poolMatch(person, ds, 'customer', q);
    if (cust) {
      f.customer = [cust.ix];
      f.chips.push('customer: ' + cust.label);
      seen.push(cust.label);
      understood = true;
    }

    if (ds.conv != null && take(/\bconverted\b/i)) {
      f.converted = !take(/\b(not converted|unconverted|didn't convert|did not convert)\b/i);
      f.chips.push(f.converted ? 'converted only' : 'not converted');
      understood = true;
    }

    // ---- shape of the answer
    var top = take(/\btop\s+\d+\b/i) || take(/\bfirst\s+\d+\b/i);
    var topWord = take(/\btop\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/i);
    if (top) f.topN = Math.min(500, parseInt(top.replace(/\D+/g, ''), 10));
    else if (topWord) f.topN = NUM_WORDS[topWord.replace(/^top\s+/i, '').trim()];
    if (f.topN) { f.chips.push('top ' + f.topN); understood = true; }

    // "How many km did I travel" is a total, not a tally of rows — a named
    // measure always wins over the counting reading.
    if (take(/\b(how many|number of|count)\b/i)) {
      understood = true;
      if (!named) { f.countOnly = true; f.metric = 'count'; }
    }
    if (take(/\b(smallest|lowest|least|worst|fewest)\b/i)) f.sort = 'smallest';
    else if (take(/\b(earliest|first day)\b/i)) f.sort = 'earliest';
    else if (take(/\b(latest|last day|most recent)\b/i)) f.sort = 'latest';

    // "which city", "by product", "top customers" all want a breakdown
    var wantsGroup = take(/\b(which|what|by|per|top|each|breakdown|split|busiest|best)\b/i);
    var wrongField = null;
    if (wantsGroup) {
      for (var g = 0; g < GROUP_WORDS.length; g++) {
        var field = GROUP_WORDS[g][0];
        if (!take(GROUP_WORDS[g][1])) continue;
        // The chosen table has no such column. That only happens now when the
        // question named the table itself ("sales by stage"), since otherwise
        // the word would have chosen the table above. Say it was dropped rather
        // than moving on to the next word and answering on that — a silent skip
        // here is what turned a pipeline question into a customer ranking.
        if (field !== 'day' && ds.fields[field] == null) {
          // The chosen table has no such column. This is reachable only when the
          // question named the table itself ("sales by stage"), since otherwise
          // the word would have chosen the table above. Stop rather than move on
          // to the next word and answer on that — a silent skip here is what
          // turned a pipeline question into a customer ranking.
          if (datasetNamed && !wrongField) wrongField = field;
          continue;
        }
        // A named value is a filter, not a grouping: "sales in Indore" should
        // total Indore, not break the month down by city.
        if (f[field] && field !== 'day') continue;
        f.groupBy = field;
        f.chips.push('by ' + FIELD_LABEL[field]);
        understood = true;
        break;
      }
    }
    if (!f.topN && !f.countOnly && f.groupBy &&
        take(/\b(biggest|largest|best|highest|most|busiest|top)\b/i) &&
        !/\btop\s+\d/.test(q)) {
      f.superlative = true;
    }

    // ---- strict verdict. Everything above is a guess until it is checked. The
    // engine now answers only a question it read in full: a table it was
    // actually given, no column it cannot supply, and no word left unaccounted
    // for. Anything short of that is reported as uncomputable, because a number
    // derived from the fragment that happened to match is worse than no number.
    if (!datasetKnown) {
      return { understood: false, f: f, uncomputable:
        'the question does not say which part of the activity it is about. Name one — ' +
        'sales, visits, demos, leads, travel or expenses.' };
    }
    if (wrongField) {
      return { understood: false, f: f, uncomputable:
        ds.label + ' does not record ' + FIELD_LABEL[wrongField] + ', so this cannot be ' +
        'broken down that way.' };
    }
    var leftover = leftoverWords(q, seen);
    if (leftover.length) {
      return { understood: false, f: f, uncomputable:
        'nothing in this data matches ' +
        leftover.map(function (w) { return '“' + w + '”'; }).join(', ') +
        '. Every figure here is computed from the recorded rows, so a word it ' +
        'cannot place is left unanswered rather than ignored.' };
    }
    if (!understood) {
      return { understood: false, f: f, uncomputable:
        'the question names nothing to filter, group or measure on.' };
    }

    return { understood: true, f: f };
  }

  // ---- rendering. Mirrors the receivables answer card so the two sections
  // read the same way.
  var LOCAL_SRC = { ai: false, label: 'Answered by the built-in engine' };
  var FALLBACK_SRC = { ai: false, label: 'Answered by the built-in engine — AI was unavailable' };

  function appendSource(container, src) {
    if (!src) return;
    var line = el('div', 'srcline' + (src.ai ? '' : ' is-local'));
    line.appendChild(el('span', 'srcline-dot'));
    line.appendChild(el('span', null, src.label));
    container.appendChild(line);
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

  // ---- analyst answers. The model writes short markdown; only the handful of
  // constructs it is asked for are rendered, and everything is escaped first,
  // so model output can never inject markup into the page.
  function mdInline(s) {
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*($|[^*])/g, '$1<em>$2</em>$3')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  function mdRow(line) {
    return line.replace(/^\s*\|?/, '').replace(/\|?\s*$/, '').split('|')
      .map(function (c) { return c.trim(); });
  }

  function renderMarkdown(src) {
    var wrap = el('div', 'analyst-md');
    var lines = String(src).replace(/\r/g, '').split('\n');
    var i = 0;

    function flushList(ordered) {
      var list = el(ordered ? 'ol' : 'ul', 'analyst-list');
      while (i < lines.length &&
             (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/).test(lines[i])) {
        var li = el('li');
        li.innerHTML = mdInline(lines[i].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/, ''));
        list.appendChild(li);
        i++;
      }
      wrap.appendChild(list);
    }

    while (i < lines.length) {
      var line = lines[i];

      if (!line.trim()) { i++; continue; }

      var h = line.match(/^\s*(#{1,4})\s+(.*)$/);
      if (h) {
        var hd = el('div', 'analyst-h');
        hd.innerHTML = mdInline(h[2]);
        wrap.appendChild(hd);
        i++;
        continue;
      }

      // A pipe table: a header row, a --- separator, then body rows.
      if (line.indexOf('|') !== -1 && i + 1 < lines.length &&
          /^[\s|:-]+$/.test(lines[i + 1]) && lines[i + 1].indexOf('-') !== -1) {
        var head = mdRow(line);
        i += 2;
        var body = [];
        while (i < lines.length && lines[i].indexOf('|') !== -1 && lines[i].trim()) {
          body.push(mdRow(lines[i]));
          i++;
        }
        // Built with the same classes as a computed answer's table, so the two
        // kinds of answer look like one application.
        var scroll = el('div', 'table-scroll');
        var t = el('table', 'mini');
        var thead = el('thead'), htr = el('tr');
        head.forEach(function (c, ci) {
          var th = el('th', ci > 0 ? 'n' : null);
          th.innerHTML = mdInline(c);
          htr.appendChild(th);
        });
        thead.appendChild(htr);
        t.appendChild(thead);
        var tb = el('tbody');
        body.forEach(function (cells) {
          var tr = el('tr');
          cells.forEach(function (c, ci) {
            var td = el('td', ci > 0 ? 'n' : null);
            td.innerHTML = mdInline(c);
            td.setAttribute('data-label', htr.children[ci] ? htr.children[ci].textContent : '');
            tr.appendChild(td);
          });
          tb.appendChild(tr);
        });
        t.appendChild(tb);
        scroll.appendChild(t);
        wrap.appendChild(scroll);
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line)) { flushList(false); continue; }
      if (/^\s*\d+[.)]\s+/.test(line)) { flushList(true); continue; }

      var para = [];
      while (i < lines.length && lines[i].trim() &&
             !/^\s*(#{1,4})\s+/.test(lines[i]) &&
             !/^\s*[-*+]\s+/.test(lines[i]) &&
             !/^\s*\d+[.)]\s+/.test(lines[i]) &&
             lines[i].indexOf('|') === -1) {
        para.push(lines[i].trim());
        i++;
      }
      if (para.length) {
        var p = el('p', 'analyst-p');
        p.innerHTML = mdInline(para.join(' '));
        wrap.appendChild(p);
      } else { i++; }
    }
    return wrap;
  }

  function renderAnalyst(slot, title, res) {
    slot.textContent = '';
    var c = card(title);
    var a = el('div', 'answer');

    a.appendChild(renderMarkdown(res.answer));

    if (res.caveat) {
      var cv = el('div', 'notice');
      cv.innerHTML = '<strong>Note.</strong> ' + esc(res.caveat);
      a.appendChild(cv);
    }

    // Provenance, stated every time. In analyst mode the figures are the
    // model's own, which is the point of the mode and also the one thing a
    // reader must know before acting on them or reconciling with Excel.
    appendSource(a, {
      ai: true,
      label: 'Analysed by ' + (res.model || 'AI') + ' · ' +
             (res.exactOnly
               ? 'figures quoted from totals computed by this app'
               : 'figures are the model’s own — check against Overview before acting')
    });
    c.body.appendChild(a);
    slot.appendChild(c.root);
  }

  // `lead` distinguishes the two ways a question can fail: the data does not
  // hold the concept at all, or it may well do but the engine could not read the
  // question with enough certainty to compute anything. Both beat a number.
  function renderRefusal(slot, title, why, src, lead) {
    slot.textContent = '';
    var c = card(title);
    var a = el('div', 'answer');
    var box = el('div', 'notice');
    box.innerHTML = '<strong>' + esc(lead || 'Not in this data.') + '</strong> ' + esc(why);
    a.appendChild(box);
    appendSource(a, src);
    c.body.appendChild(a);
    slot.appendChild(c.root);
  }

  function renderSecAnswer(slot, title, r, chips, ignored, src) {
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
      warn.innerHTML = '<strong>Part of your question was not used.</strong> This answer ' +
        'ignores ' + esc(ignored.join(' and ')) + ', so it may be broader than what you ' +
        'asked. Try rephrasing, for example “top 5 outlets by sales value”.';
      a.appendChild(warn);
    }

    a.appendChild(el('div', 'answer-big num', r.big));
    a.appendChild(el('div', 'answer-head', r.head));
    a.appendChild(el('div', 'answer-note', r.note));

    if (r.body && r.body.length) {
      a.appendChild(table(r.table, r.body, r.numFrom == null ? 2 : r.numFrom));
      if (r.more) a.appendChild(el('p', 'card-note', '+ ' + r.more + ' more not shown'));
    }

    appendSource(a, src);
    c.body.appendChild(a);
    slot.appendChild(c.root);
  }

  // Second pass: hand the COMPUTED result back for wording only. The figures are
  // already on screen and correct, so if this fails, is switched off, or quotes a
  // number the server cannot find in the result, nothing appears.
  function narrate(question, result, slot) {
    var answer = slot.querySelector('.answer');
    if (!answer) return;
    var box = el('div', 'narrative is-loading');
    box.appendChild(el('span', 'narrative-dot'));
    box.appendChild(el('span', 'narrative-text', 'Writing a summary…'));
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

  // ---- entry point for a typed question: the model first, then the fallback.
  function askFreeText(text, person) {
    var slot = document.getElementById('sec-answer-slot');
    if (!slot) return;

    aiStatus().then(function (on) {
      if (!on) { askLocal(text, person); return; }
      renderThinking(slot, text);

      // Analyst mode: the model reads this person's rows and answers directly.
      // A failure still falls back to the built-in parser, so a spent quota is
      // a plainer answer rather than no answer.
      if (aiAnalyst) {
        askAnalystAI(text, person).then(function (res) {
          if (res) { renderAnalyst(slot, text, res); return; }
          askLocal(text, person, true);
        });
        return;
      }

      askAI(text, person).then(function (res) {
        if (!res) { askLocal(text, person, true); return; }
        var spec = res.spec;
        var srcAI = { ai: true, label: 'Interpreted by ' + (res.model || 'AI') +
                                       ' · figures computed from your data' };

        // The model can decide the question is outside what this month's
        // activity holds — a target or a stock position, say. That is a better
        // answer than a narrow one computed from the wrong table.
        if (spec.refusal) { renderRefusal(slot, text, spec.refusal, srcAI); return; }

        var f = specToSecFilter(spec);
        var result = runSecQuery(f, person);
        renderSecAnswer(slot, text, result, f.chips, f.ignored, srcAI);
        // Nothing to narrate when nothing matched: the note already states the
        // absence plainly, and a rewritten version of it only adds a paragraph
        // that reads like a failed answer.
        if (res.narrate && !result.empty) narrate(text, result, slot);
      });
    });
  }

  function askLocal(text, person, wasFallback) {
    var slot = document.getElementById('sec-answer-slot');
    if (!slot) return;
    var src = wasFallback ? FALLBACK_SRC : LOCAL_SRC;

    if (beyondMonth(text)) {
      renderRefusal(slot, text,
        'The built-in engine reads only ' + periodLabel() + ', the month on screen. ' +
        'Full-year and month-by-month questions are answered by the AI analyst, which ' +
        (wasFallback ? 'could not be reached just now — please try again in a minute.'
                     : 'is not switched on for this server.') +
        ' To look at a single other month, pick it from the month selector.',
        src, 'Full-year questions need the AI analyst.');
      return;
    }

    var parsed = parseSecQuestion(text, person);

    // The same verdict the model gives through `spec.refusal`, reached without
    // it. Rendered identically, so a question outside this data reads the same
    // whether the AI answered or was out of quota.
    if (parsed.refusal) { renderRefusal(slot, text, parsed.refusal, src); return; }

    // Read, but not read with enough certainty to compute anything. Flagged with
    // the reason, then the same list of shapes that do work.
    if (parsed.uncomputable) {
      slot.textContent = '';
      var uc = card(text);
      var uw = el('div', 'answer');
      var ub = el('div', 'notice');
      ub.innerHTML = '<strong>This cannot be computed from this data.</strong> ' +
                     esc(parsed.uncomputable);
      uw.appendChild(ub);
      uw.appendChild(el('div', 'answer-note',
        'Questions this engine can answer about ' + periodLabel() + ' look like:'));
      var ul2 = el('ul', 'notes');
      ul2.style.margin = '0';
      ul2.style.paddingLeft = '18px';
      [
        'a breakdown — “sales by product group”, “visits by city”',
        'a ranking — “top 5 outlets by sales”',
        'a count — “how many visits did I make?”',
        'a measure — “how many units did I sell?”, “how many km did I travel?”',
        'a named value — a city, product group or outlet from this data'
      ].forEach(function (t) { ul2.appendChild(el('li', null, t)); });
      uw.appendChild(ul2);
      appendSource(uw, src);
      uc.body.appendChild(uw);
      slot.appendChild(uc.root);
      return;
    }

    if (!parsed.understood) {
      slot.textContent = '';
      var c = card('Not sure about that one');
      var w = el('div', 'answer');
      w.appendChild(el('div', 'answer-note',
        'I could not find anything to search on in that question. I answer by filtering ' +
        'this person’s own activity for ' + periodLabel() + ', so try naming one of these:'));
      var ul = el('ul', 'notes');
      ul.style.margin = '0';
      ul.style.paddingLeft = '18px';
      [
        'a table — sales, visits, demos, leads, travel or expenses',
        'a breakdown — “sales by product group”, “visits by city”',
        'a ranking — “top 5 outlets by sales”',
        'a count — “how many visits did I make?”',
        'a named value — a city, product group or outlet from this data',
        'a measure — “how many units did I sell?”, “how many km did I travel?”'
      ].forEach(function (t) { ul.appendChild(el('li', null, t)); });
      w.appendChild(ul);
      appendSource(w, src);
      c.body.appendChild(w);
      slot.appendChild(c.root);
      return;
    }

    var r = runSecQuery(parsed.f, person);
    renderSecAnswer(slot, text, r, parsed.f.chips, parsed.f.ignored, src);
  }

  // ---- the canned questions, answered straight from the rows
  var SEC_QUESTIONS = [
    { id: 'top-outlets', label: 'Which outlets bought the most?',
      f: { dataset: 'sales', metric: 'value', groupBy: 'customer', chips: ['secondary sales', 'by customer'] } },
    { id: 'products', label: 'How do my sales split by product group?',
      f: { dataset: 'sales', metric: 'value', groupBy: 'productGroup', chips: ['secondary sales', 'by product group'] } },
    { id: 'items', label: 'Which items sold the most?',
      f: { dataset: 'sales', metric: 'value', groupBy: 'item', chips: ['secondary sales', 'by item'] } },
    { id: 'cities', label: 'Where are my sales coming from?',
      f: { dataset: 'sales', metric: 'value', groupBy: 'city', chips: ['secondary sales', 'by city'] } },
    { id: 'visit-types', label: 'What kind of visits am I making?',
      f: { dataset: 'visits', metric: 'count', groupBy: 'visitType', chips: ['visits', 'by visit type'] } },
    { id: 'busy-days', label: 'Which days were busiest?',
      f: { dataset: 'visits', metric: 'count', groupBy: 'day', sort: 'largest', chips: ['visits', 'by day'] } },
    { id: 'pipeline', label: 'Where are my leads sitting?',
      f: { dataset: 'leads', metric: 'value', groupBy: 'stage', chips: ['leads', 'by stage'] } }
  ];

  function renderSecAsk(person) {
    var host = document.getElementById('sec-ask');
    host.textContent = '';

    // With no rows at all there is nothing to filter, and every question would
    // answer "nothing matched" — which reads like a result rather than an
    // absence of data. Say so once instead.
    var hasRows = Object.keys(DSETS).some(function (k) {
      return (person.d[k] || []).length > 0;
    });
    if (!hasRows) {
      var nc = card('Ask your own question', periodLabel());
      var box = el('div', 'notice');
      box.innerHTML = '<strong>Nothing to ask about yet.</strong> ' + esc(who(person)) +
        ' has no visits, demos, leads, secondary sales, travel or expenses recorded ' +
        'in ' + periodLabel() + ', so there is no data here to answer questions from.';
      nc.body.appendChild(box);
      host.appendChild(nc.root);
      return;
    }

    var fc = card('Ask your own question', 'every figure is computed from this data');
    aiStatus().then(function (on) {
      var note = fc.root.querySelector('.card-note');
      if (note) {
        note.textContent = on && aiAnalyst
          ? 'ask in your own words — about this month or the full year'
          : on ? 'ask in your own words — every figure is computed from this data'
               : 'every figure is computed from this data';
      }
      // Only the analyst sees the year, so only offer a year question with it.
      if (on && aiAnalyst) addExample('which month had my best sales this year?');
    });

    var form = el('form', 'askbox');
    var inp = el('input', 'askbox-input');
    inp.type = 'text';
    inp.placeholder = 'e.g. which product group sold the most in Indore?';
    inp.setAttribute('aria-label', 'Ask a question about this person’s activity');
    var go = el('button', 'askbox-go', 'Ask');
    go.type = 'submit';
    form.appendChild(inp);
    form.appendChild(go);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = inp.value.trim();
      if (!v) return;
      host.querySelectorAll('.qbtn').forEach(function (o) { o.setAttribute('aria-pressed', 'false'); });
      askFreeText(v, person);
      document.getElementById('sec-answer-slot').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    fc.body.appendChild(form);

    var ex = el('div', 'examples');
    ex.appendChild(el('span', 'examples-lbl', 'Try'));
    function addExample(t) {
      var b = el('button', 'example');
      b.type = 'button';
      b.textContent = t;
      b.addEventListener('click', function () {
        inp.value = t;
        host.querySelectorAll('.qbtn').forEach(function (o) { o.setAttribute('aria-pressed', 'false'); });
        askFreeText(t, person);
        document.getElementById('sec-answer-slot').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      ex.appendChild(b);
    }
    [
      'top 5 outlets by sales',
      'top 10 items by sales',
      'sales by product category',
      'how many visits did I make?',
      'how many km did I travel?',
      'which city sold the most?',
      'how many demos converted?'
    ].forEach(addExample);
    fc.body.appendChild(ex);

    // Model picker, rendered only once the server confirms AI is on, so a
    // deployment without a key shows no dead control.
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
        var o = el('option', null, m.label + (m.recommended ? ' (recommended)' : '') +
                                   (m.available ? '' : ' — quota spent'));
        o.value = m.id;
        sel.appendChild(o);
        if (m.id === chosenModel) stillValid = true;
      });
      if (chosenModel && !stillValid) rememberModel('');
      sel.value = chosenModel;

      var hint = el('span', 'modelbar-hint', chosenModel
        ? 'Every question goes to this model. If its quota runs out, answers fall back to the built-in engine.'
        : 'Tries each model in turn and skips any whose quota is spent.');

      sel.addEventListener('change', function () {
        rememberModel(sel.value);
        hint.textContent = sel.value
          ? 'Every question goes to this model. If its quota runs out, answers fall back to the built-in engine.'
          : 'Tries each model in turn and skips any whose quota is spent.';
      });
      picker.appendChild(sel);
      picker.appendChild(hint);
    });

    host.appendChild(fc.root);

    // Only offer a canned question whose table this person actually has rows
    // in. Asking "which outlets bought the most?" of someone with no sale lines
    // can only ever answer "nothing matched", which reads like a fault in the
    // app rather than an absence in the data.
    var present = datasetsWithRows(person);
    var offered = SEC_QUESTIONS.filter(function (q) {
      return present.indexOf(q.f.dataset) !== -1;
    });

    var qc = card('Common questions', 'tap one for an answer from this data');
    var grid = el('div', 'qgrid');
    offered.forEach(function (q) {
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
        showCanned(q, person);
      });
      grid.appendChild(b);
    });
    qc.body.appendChild(grid);

    // A person can have rows only in tables the canned questions do not cover
    // (travel and expenses have no question of their own), so say what is here
    // rather than showing an empty grid.
    var missing = DS_ORDER.filter(function (k) { return present.indexOf(k) === -1; });
    if (missing.length) {
      var gap = el('div', 'notice');
      gap.innerHTML = '<strong>' + esc(who(person)) + ' has no ' + esc(joinLabels(missing)) +
        '</strong> recorded in ' + periodLabel() + ', so questions about ' +
        (missing.length === 1 ? 'that' : 'those') + ' have nothing to answer from. ' +
        'This month has ' + esc(joinLabels(present)) + '.';
      qc.body.appendChild(gap);
    }
    host.appendChild(qc.root);

    var slot = el('div');
    slot.id = 'sec-answer-slot';
    host.appendChild(slot);

    if (offered.length) {
      showCanned(offered[0], person);
      grid.querySelector('.qbtn').setAttribute('aria-pressed', 'true');
    }
  }

  function showCanned(q, person) {
    var slot = document.getElementById('sec-answer-slot');
    if (!slot) return;
    renderSecAnswer(slot, q.label, runSecQuery(q.f, person), null, null, LOCAL_SRC);
  }

  // ================================================================
  // COMPARE — two or three people side by side for the month on screen,
  // plus their year so far from /api/compare/sec. Every figure is worked out
  // from the same rows as the Overview tab; the written findings only restate
  // those figures. Nothing is estimated and no measure is weighted.
  // ================================================================
  var CMP_MAX = 3;
  var CMP_STORE_KEY = 'nutaste-sec-compare';
  var cmpPicked = [];        // { r: roster entry, slot: 1-3 }, in the order picked
  var cmpYearCache = {};     // "month|name|name" -> /api/compare/sec reply
  var cmpSeq = 0;            // a slow year reply is dropped once the picks change
  var cmpUi = null;          // the picker card, built on first visit to the tab
  var cmpCursor = -1, cmpFiltered = [];

  function intFmt(n) { return Math.round(n || 0).toLocaleString('en-IN'); }
  function pctFmt(n) { return (n * 100).toFixed(1) + '%'; }
  function pct2Fmt(n) { return (n * 100).toFixed(2) + '%'; }   // expense ratios sit close together
  function kmFmt(n) { return intFmt(n) + ' km'; }
  function plural(n, one, many) { return intFmt(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
  function ratio(a, b) { return b ? a / b : null; }
  function monthName(mk) { var p = mk.split('-'); return MON[+p[1] - 1] + ' ' + p[0]; }
  function monShort(mk) { return MON[+mk.split('-')[1] - 1]; }
  // Each person keeps their colour while picked; it carries identity only,
  // so every figure beside it is still named in text.
  function swatch(slot) {
    var d = el('span', 'cmp-swatch');
    d.style.background = 'var(--cmp-' + slot + ')';
    d.setAttribute('aria-hidden', 'true');
    return d;
  }
  function strongName(c) { return '<strong>' + esc(c.name) + '</strong>'; }
  function joinList(parts) {
    return parts.length <= 1 ? (parts[0] || '')
      : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  }

  // ---- one person's month, in the shape the scorecard reads
  function cmpStats(p) {
    var d = p.r.d, s = summarise(d);
    var ym = S.periodFrom.split('-');
    var days = new Date(+ym[0], +ym[1], 0).getDate();
    var weeks = [];
    for (var w = 0; w * 7 < days; w++) {
      weeks.push({ from: w * 7 + 1, to: Math.min(days, w * 7 + 7), value: 0, visits: 0 });
    }
    function weekOf(day) { return weeks[Math.min(weeks.length - 1, Math.floor((day - 1) / 7))]; }
    var billed = {}, billDays = {};
    d.sales.forEach(function (x) {
      billed[x[SL.BUYER]] = 1;
      if (x[SL.DAY]) { billDays[x[SL.DAY]] = 1; weekOf(x[SL.DAY]).value += x[SL.VAL]; }
    });
    d.visits.forEach(function (x) { if (x[V.DAY]) weekOf(x[V.DAY]).visits++; });
    var top = topEntries(s.byBuyer, 5);
    return {
      name: p.r.name, slot: p.slot, d: d, s: s, weeks: weeks, billed: billed,
      outletsBilled: Object.keys(billed).length,
      billDays: Object.keys(billDays).length,
      // No "visited outlets that bought": the visit log and the billing data
      // name outlets differently (25 of ~3,000 names match), so it would read
      // as near zero for almost everyone.
      mins: d.visits.reduce(function (a, x) { return a + (x[V.MINS] || 0); }, 0),
      topBuyer: top[0] || null,
      top5: top.reduce(function (a, t) { return a + t[1]; }, 0)
    };
  }

  // ---- scorecard rows. better: 'high' or 'low' marks a best figure; null
  // rows are context only (more kilometres is neither good nor bad).
  var CMP_MONTH_METRICS = [
    { group: 'Sales' },
    { label: 'Secondary sales', get: function (c) { return c.s.salesValue; }, fmt: money, better: 'high' },
    { label: 'Units sold', get: function (c) { return c.s.salesQty; }, fmt: intFmt, better: 'high' },
    { label: 'Outlets billed', get: function (c) { return c.outletsBilled; }, fmt: intFmt, better: 'high' },
    { label: 'Days with sales', get: function (c) { return c.billDays; }, fmt: intFmt, better: 'high' },
    { label: 'Average sale per outlet', get: function (c) { return ratio(c.s.salesValue, c.outletsBilled); },
      fmt: money, better: 'high' },
    { label: 'Top customer’s share of sales', fmt: pctFmt, better: 'low',
      get: function (c) { return c.topBuyer && c.s.salesValue > 0 ? c.topBuyer[1] / c.s.salesValue : null; } },
    { group: 'Field activity' },
    { label: 'Visits', get: function (c) { return c.s.visits; }, fmt: intFmt, better: 'high' },
    { label: 'Active days', get: function (c) { return c.s.activeDays; }, fmt: intFmt, better: 'high' },
    { label: 'Visits per active day', get: function (c) { return ratio(c.s.visits, c.s.activeDays); },
      fmt: function (n) { return n.toFixed(1); }, better: 'high' },
    { label: 'Outlets visited', get: function (c) { return c.s.outletCount; }, fmt: intFmt, better: 'high' },
    { label: 'Sales per visit', get: function (c) { return ratio(c.s.salesValue, c.s.visits); },
      fmt: money, better: 'high' },
    { label: 'Average visit length', get: function (c) { return c.mins ? c.mins / c.s.visits : null; },
      fmt: function (n) { return Math.round(n) + ' min'; }, better: null },
    { group: 'Demos and leads' },
    { label: 'Demos', get: function (c) { return c.s.demos; }, fmt: intFmt, better: 'high' },
    { label: 'Demos converted', get: function (c) { return c.s.demosConv; }, fmt: intFmt, better: 'high' },
    { label: 'Demo conversion rate', get: function (c) { return ratio(c.s.demosConv, c.s.demos); },
      fmt: pctFmt, better: 'high' },
    { label: 'Leads', get: function (c) { return c.s.leads; }, fmt: intFmt, better: 'high' },
    { label: 'Lead pipeline value', get: function (c) { return c.s.leadValue; }, fmt: money, better: 'high' },
    { group: 'Travel and cost' },
    { label: 'Distance travelled', get: function (c) { return c.s.km; }, fmt: kmFmt, better: null },
    { label: 'Expenses claimed', get: function (c) { return c.s.expense; }, fmt: money, better: null },
    { label: 'Cost per visit', fmt: money, better: 'low',
      get: function (c) { return c.s.expense && c.s.visits ? c.s.expense / c.s.visits : null; } },
    { label: 'Expenses as a share of sales', fmt: pct2Fmt, better: 'low',
      get: function (c) { return c.s.expense && c.s.salesValue > 0 ? c.s.expense / c.s.salesValue : null; } }
  ];

  // Year-to-date rows read c.t, the server's exact year totals, and c.m, the
  // months on file (null where the person is not on that month's data).
  function yrMonths(c) { return c.m.filter(Boolean); }
  var CMP_YEAR_METRICS = [
    { group: 'Sales' },
    { label: 'Secondary sales', get: function (c) { return c.t.sales_rs; }, fmt: money, better: 'high' },
    { label: 'Average per month on file', fmt: money, better: 'high',
      get: function (c) { return ratio(c.t.sales_rs, yrMonths(c).length); } },
    { label: 'Best month', fmt: money, better: 'high', note: function (c) {
        var b = null;
        yrMonths(c).forEach(function (m) { if (!b || m.sales_rs > b.sales_rs) b = m; });
        return b ? monShort(b.month) : '';
      },
      get: function (c) { return Math.max.apply(null, yrMonths(c).map(function (m) { return m.sales_rs; })); } },
    { label: 'Months with sales', fmt: intFmt, better: 'high',
      get: function (c) { return yrMonths(c).filter(function (m) { return m.sales_rs > 0; }).length; } },
    { label: 'Units sold', get: function (c) { return c.t.qty; }, fmt: intFmt, better: 'high' },
    { label: 'Different outlets billed', get: function (c) { return c.t.outlets_bought; }, fmt: intFmt, better: 'high' },
    { group: 'Activity' },
    { label: 'Visits', get: function (c) { return c.t.visits; }, fmt: intFmt, better: 'high' },
    { label: 'Sales per visit', get: function (c) { return ratio(c.t.sales_rs, c.t.visits); }, fmt: money, better: 'high' },
    { label: 'Demos', get: function (c) { return c.t.demos; }, fmt: intFmt, better: 'high' },
    { label: 'Demo conversion rate', get: function (c) { return ratio(c.t.demos_converted, c.t.demos); },
      fmt: pctFmt, better: 'high' },
    { label: 'Leads', get: function (c) { return c.t.leads; }, fmt: intFmt, better: 'high' },
    { group: 'Cost' },
    { label: 'Distance travelled', get: function (c) { return c.t.km; }, fmt: kmFmt, better: null },
    { label: 'Expenses claimed', get: function (c) { return c.t.expense_rs; }, fmt: money, better: null },
    { label: 'Expenses as a share of sales', fmt: pct2Fmt, better: 'low',
      get: function (c) { return c.t.expense_rs && c.t.sales_rs > 0 ? c.t.expense_rs / c.t.sales_rs : null; } }
  ];

  // Measures down the side, people across. The best figure in a row is marked
  // "Best" in words as well as weight, so it never rests on colour; a row
  // where everyone is level, or fewer than two have a figure, marks no one.
  function scorecard(metrics, cols) {
    var led = cols.map(function () { return 0; }), judged = 0;
    var scroll = el('div', 'table-scroll');
    var t = el('table', 'mini cmp-score');
    var thead = el('thead'), hr = el('tr');
    hr.appendChild(el('th', null, 'Measure'));
    cols.forEach(function (c) {
      var th = el('th', 'n');
      th.appendChild(swatch(c.slot));
      th.appendChild(document.createTextNode(c.name));
      hr.appendChild(th);
    });
    thead.appendChild(hr); t.appendChild(thead);
    var tb = el('tbody');
    metrics.forEach(function (m) {
      var tr = el('tr');
      if (m.group) {
        tr.className = 'cmp-group';
        var g = el('td', null, m.group);
        g.colSpan = cols.length + 1;
        tr.appendChild(g); tb.appendChild(tr);
        return;
      }
      var vals = cols.map(function (c) {
        var v = m.get(c);
        return (v == null || !isFinite(v)) ? null : v;
      });
      var have = vals.filter(function (v) { return v != null; });
      // Judged on the figure as shown, so 0.675% and 0.678% (both "0.68%")
      // count as level rather than one quietly beating the other.
      var best = null;
      if (m.better && have.length >= 2) {
        best = m.fmt(m.better === 'low' ? Math.min.apply(null, have) : Math.max.apply(null, have));
        if (have.every(function (v) { return m.fmt(v) === best; })) best = null;
        else judged++;
      }
      tr.appendChild(el('td', null, m.label));
      vals.forEach(function (v, i) {
        var td = el('td', 'n', v == null ? '—' : m.fmt(v) + (m.note ? ' · ' + m.note(cols[i]) : ''));
        td.setAttribute('data-label', cols[i].name);   // phones show each row as a labelled card
        if (best != null && v != null && m.fmt(v) === best) {
          td.classList.add('cmp-best');
          td.appendChild(el('span', 'chip ok cmp-best-tag', 'Best'));
          led[i]++;
        }
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    t.appendChild(tb); scroll.appendChild(t);
    return { node: scroll, led: led, judged: judged };
  }

  // ---- what the month's figures say, in sentences. Returns HTML strings;
  // every name goes through esc().
  function monthFindings(cs, score) {
    var out = [], watch = [];
    var total = cs.reduce(function (a, c) { return a + c.s.salesValue; }, 0);
    var bySales = cs.slice().sort(function (a, b) { return b.s.salesValue - a.s.salesValue; });
    var lead = bySales[0];

    if (lead.s.salesValue <= 0) {
      out.push('None of the ' + cs.length + ' has secondary sales recorded in ' + periodLabel() + '.');
    } else {
      out.push(strongName(lead) + ' leads on secondary sales with ' + money(lead.s.salesValue) +
        ', ' + pctOf(lead.s.salesValue, total) + ' of the ' + compact(total) + ' the ' + cs.length +
        ' sold between them. ' + joinList(bySales.slice(1).map(function (c) {
          return strongName(c) + (c.s.salesValue > 0
            ? ' follows at ' + money(c.s.salesValue) + ' (' + compact(lead.s.salesValue - c.s.salesValue) +
              ' behind; the leader sold ' + Math.round((lead.s.salesValue / c.s.salesValue - 1) * 100) + '% more)'
            : ' has no secondary sales recorded');
        })) + '.');
    }

    if (score.judged) {
      var ranked = cs.map(function (c, i) { return { c: c, n: score.led[i] }; })
        .sort(function (a, b) { return b.n - a.n; });
      out.push('Of the ' + score.judged + ' scorecard measures with a clear best, ' +
        joinList(ranked.map(function (x) { return strongName(x.c) + ' is best on ' + x.n; })) +
        ' (a tie counts for each).');
    }

    // the best of the group on one measure, with everyone's figure for context
    function bestOn(get, sentence, fmt) {
      var rows = cs.map(function (c) { return { c: c, v: get(c) }; })
        .filter(function (x) { return x.v != null && isFinite(x.v); });
      if (rows.length < 2) return;
      rows.sort(function (a, b) { return b.v - a.v; });
      if (rows[0].v === rows[rows.length - 1].v) return;
      out.push(sentence(rows[0].c, rows[0].v) + ' ' + joinList(rows.slice(1).map(function (x) {
        return esc(x.c.name) + ' ' + fmt(x.v);
      })) + ' for comparison.');
    }
    bestOn(function (c) { return c.s.visits && c.s.salesValue > 0 ? c.s.salesValue / c.s.visits : null; },
      function (c, v) { return strongName(c) + ' gets the most from each visit: ' + money(v) + ' of sales per visit;'; },
      money);
    bestOn(function (c) { return c.outletsBilled || null; },
      function (c, v) {
        return strongName(c) + ' has the widest reach, billing ' + plural(v, 'outlet') +
          ' at ' + money(c.s.salesValue / v) + ' each on average;';
      }, function (v) { return plural(v, 'outlet'); });
    bestOn(function (c) { return c.s.activeDays ? c.s.visits / c.s.activeDays : null; },
      function (c, v) {
        return strongName(c) + ' covers the most ground: ' + plural(c.s.visits, 'visit') + ' over ' +
          plural(c.s.activeDays, 'active day') + ' (' + v.toFixed(1) + ' a day);';
      }, function (v) { return v.toFixed(1) + ' a day'; });
    if (cs.some(function (c) { return c.s.demos; })) {
      out.push('Demos: ' + joinList(cs.map(function (c) {
        return esc(c.name) + ' ' + (c.s.demos
          ? c.s.demosConv + ' of ' + c.s.demos + ' converted (' + pctFmt(c.s.demosConv / c.s.demos) + ')'
          : 'no demos');
      })) + '.');
    }
    // Lower is better here, so flip the sign to reuse bestOn's ordering.
    bestOn(function (c) { return c.s.expense && c.s.salesValue > 0 ? -c.s.expense / c.s.salesValue : null; },
      function (c, v) {
        return strongName(c) + ' runs leanest: expenses were ' + pct2Fmt(-v) + ' of sales;';
      }, function (v) { return pct2Fmt(-v); });

    cs.forEach(function (c) {
      var s = c.s;
      if (c.topBuyer && s.salesValue > 0 && c.topBuyer[1] / s.salesValue > 0.4) {
        watch.push(strongName(c) + ': one customer, ' + esc(c.topBuyer[0]) + ', made up ' +
          pctOf(c.topBuyer[1], s.salesValue) + ' of sales. Losing it would take a large share of the month.');
      }
      if (s.visits >= 5 && s.salesValue <= 0) {
        watch.push(strongName(c) + ' logged ' + plural(s.visits, 'visit') + ' but no secondary sales.');
      }
      if (s.salesValue > 0 && !s.visits) {
        watch.push(strongName(c) + ' has ' + money(s.salesValue) +
          ' of sales but no visits logged. Worth checking that visits are being recorded.');
      }
      if (s.expense > 0 && s.salesValue <= 0) {
        watch.push(strongName(c) + ' claimed ' + money(s.expense) + ' of expenses with no secondary sales.');
      }
    });
    var shared = 0, seen = {};
    cs.forEach(function (c) {
      Object.keys(c.billed).forEach(function (k) { seen[k] = (seen[k] || 0) + 1; });
    });
    Object.keys(seen).forEach(function (k) { if (seen[k] > 1) shared++; });
    if (shared) {
      watch.push(plural(shared, 'outlet') + ' bought from more than one of them this month. ' +
        'Usually a shared territory; check that the sales are not counted twice.');
    }
    return { out: out, watch: watch };
  }

  // ---- year so far, in sentences
  function yearFindings(rows, months, inProgress) {
    var out = [];
    var withData = rows.filter(function (c) { return c.t; });
    if (!withData.length) return out;
    var bySales = withData.slice().sort(function (a, b) { return b.t.sales_rs - a.t.sales_rs; });
    var span = monShort(months[0]) + '–' + monthName(months[months.length - 1]);
    out.push('Year to date (' + span + '), ' + strongName(bySales[0]) + ' leads with ' +
      money(bySales[0].t.sales_rs) + (bySales.length > 1 ? ', then ' + joinList(bySales.slice(1).map(function (c) {
        return strongName(c) + ' ' + money(c.t.sales_rs);
      })) : '') + '.');

    // who had the highest sales, month by month
    var tops = rows.map(function () { return 0; }), contested = 0;
    months.forEach(function (mk, i) {
      var best = -1, who = -1;
      rows.forEach(function (c, j) {
        var m = c.m[i];
        if (m && m.sales_rs > best) { best = m.sales_rs; who = j; }
      });
      if (who >= 0 && best > 0) { tops[who]++; contested++; }
    });
    if (contested && rows.length > 1) {
      out.push('Highest sales of the group, month by month: ' + joinList(rows.map(function (c, j) {
        return strongName(c) + ' in ' + tops[j] + ' of ' + contested + ' months';
      })) + '.');
    }

    // the last two finished months, so a month still in progress never reads as a fall
    var done = months.filter(function (mk) { return mk !== inProgress; });
    if (done.length >= 2) {
      var a = done.length - 2, b = done.length - 1;
      var ia = months.indexOf(done[a]), ib = months.indexOf(done[b]);
      out.push(monShort(done[b]) + ' against ' + monShort(done[a]) + ': ' + joinList(rows.map(function (c) {
        var x = c.m[ia], y = c.m[ib];
        if (!y) return strongName(c) + ' not on ' + monShort(done[b]) + '’s data';
        if (!(y.sales_rs > 0) && !(x && x.sales_rs > 0)) return strongName(c) + ' no sales in either month';
        if (!x || !(x.sales_rs > 0)) return strongName(c) + ' ' + compact(y.sales_rs) + ' (no sales in ' + monShort(done[a]) + ')';
        var ch = (y.sales_rs / x.sales_rs - 1) * 100;
        return strongName(c) + ' ' + (ch >= 0 ? '+' : '−') + Math.abs(Math.round(ch)) + '% (' +
          compact(x.sales_rs) + ' → ' + compact(y.sales_rs) + ')';
      })) + '.');
    }

    rows.forEach(function (c) {
      var gone = months.filter(function (mk, i) { return !c.m[i]; });
      if (gone.length && gone.length < months.length) {
        out.push(strongName(c) + ' is not on the data for ' + gone.map(monShort).join(', ') +
          ', so those months count as nothing recorded rather than as a fall.');
      }
    });
    return out;
  }

  function findingsList(cls, items) {
    var ul = el('ul', cls);
    items.forEach(function (h) { var li = el('li'); li.innerHTML = h; ul.appendChild(li); });
    return ul;
  }

  // ---- monthly sales lines. The lines sit in an SVG stretched to the box;
  // points, gridline labels and month names are HTML, so they keep their
  // shape at any width. The step into a month still in progress is dashed
  // and its point hollow.
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function niceStep(x) {
    if (!(x > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log(x) / Math.LN10)), n = x / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }
  function trendChart(rows, months, inProgress) {
    var wrap = el('div', 'cmp-trend');
    var leg = el('div', 'cmp-legend');
    rows.forEach(function (c) {
      var i = el('span', 'cmp-leg');
      i.appendChild(swatch(c.slot));
      i.appendChild(document.createTextNode(c.name));
      leg.appendChild(i);
    });
    if (inProgress) leg.appendChild(el('span', 'cmp-leg cmp-leg-note', 'Hollow point: ' + monShort(inProgress) + ' to date'));
    wrap.appendChild(leg);

    var vals = [0];
    rows.forEach(function (c) { c.m.forEach(function (m) { if (m) vals.push(m.sales_rs); }); });
    var step = niceStep(Math.max.apply(null, vals) / 4);
    var top = step * 4;
    var n = months.length;
    function x(i) { return (i + 0.5) / n * 100; }
    function y(v) { return Math.max(0, Math.min(100, v / top * 100)); }

    var plot = el('div', 'cmp-plot');
    for (var g = 0; g <= 4; g++) {
      var gl = el('div', 'cmp-gl');
      gl.style.bottom = (g * 25) + '%';
      gl.appendChild(el('span', 'cmp-gl-lbl num', g ? compact(step * g).replace('.00 ', ' ') : '₹0'));
      plot.appendChild(gl);
    }
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'cmp-lines');
    svg.setAttribute('aria-hidden', 'true');
    rows.forEach(function (c) {
      for (var i = 1; i < n; i++) {
        var a = c.m[i - 1], b = c.m[i];
        if (!a || !b) continue;              // not on that month's data: leave a gap
        var ln = document.createElementNS(SVG_NS, 'line');
        ln.setAttribute('x1', x(i - 1)); ln.setAttribute('y1', 100 - y(a.sales_rs));
        ln.setAttribute('x2', x(i));     ln.setAttribute('y2', 100 - y(b.sales_rs));
        ln.setAttribute('vector-effect', 'non-scaling-stroke');
        ln.setAttribute('class', 'cmp-ln' + (months[i] === inProgress ? ' cmp-ln-mtd' : ''));
        ln.style.stroke = 'var(--cmp-' + c.slot + ')';
        svg.appendChild(ln);
      }
    });
    plot.appendChild(svg);
    rows.forEach(function (c) {
      c.m.forEach(function (m, i) {
        if (!m) return;
        var mtd = months[i] === inProgress;
        var pt = el('span', 'cmp-pt' + (mtd ? ' cmp-pt-mtd' : ''));
        pt.style.left = x(i) + '%';
        pt.style.bottom = y(m.sales_rs) + '%';
        pt.style.setProperty('--c', 'var(--cmp-' + c.slot + ')');
        bindTip(pt, c.name + ' · ' + monthName(months[i]) + (mtd ? ' to date' : '') + ' · ' +
          money(m.sales_rs) + ' · ' + plural(m.visits, 'visit'));
        plot.appendChild(pt);
      });
    });
    wrap.appendChild(plot);
    var xa = el('div', 'cmp-xaxis');
    xa.setAttribute('aria-hidden', 'true');
    months.forEach(function (mk) { xa.appendChild(el('span', null, monShort(mk))); });
    wrap.appendChild(xa);
    return wrap;
  }

  function loadYear(names) {
    var month = window.SEC_MONTH || S.periodFrom.slice(0, 7);
    var key = month + '|' + names.join('|');
    if (cmpYearCache[key]) return Promise.resolve(cmpYearCache[key]);
    return fetch('/api/compare/sec', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ people: names, month: month })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (j) {
        if (!(j && j.ok)) return null;
        cmpYearCache[key] = j;
        return j;
      });
  }

  function yearCard(cs) {
    var c = card('Year so far', 'loading…');
    var wait = el('div', 'thinking');
    wait.innerHTML = '<span class="thinking-dots"><i></i><i></i><i></i></span>Loading each month of the year…';
    c.body.appendChild(wait);
    var seq = cmpSeq;
    loadYear(cs.map(function (x) { return x.name; })).then(function (j) {
      if (seq !== cmpSeq) return;            // the picks changed while this was loading
      c.body.textContent = '';
      var note = c.root.querySelector('.card-note');
      if (!j || !j.months || !j.months.length) {
        note.textContent = '';
        c.body.appendChild(el('p', 'card-note',
          'The rest of the year could not be loaded just now. The month above is unaffected.'));
        return;
      }
      var months = j.months;
      note.textContent = monShort(months[0]) + '–' + monthName(months[months.length - 1]) +
        (j.inProgress ? ' · ' + monShort(j.inProgress) + ' is month to date' : '');
      var rows = cs.map(function (x) {
        var y = j.people[x.name], byMonth = {};
        (y ? y.perMonth : []).forEach(function (m) { if (!m.absent) byMonth[m.month] = m; });
        return { name: x.name, slot: x.slot, t: y ? y.total : null,
                 m: months.map(function (mk) { return byMonth[mk] || null; }) };
      });

      c.body.appendChild(findingsList('cmp-findings', yearFindings(rows, months, j.inProgress)));
      c.body.appendChild(el('h4', 'cmp-sub', 'Secondary sales by month'));
      c.body.appendChild(trendChart(rows, months, j.inProgress));
      c.body.appendChild(table(['Month'].concat(rows.map(function (r) { return r.name; })),
        months.map(function (mk, i) {
          return [monthName(mk) + (mk === j.inProgress ? ' (to date)' : '')].concat(rows.map(function (r) {
            return r.m[i] ? money(r.m[i].sales_rs) : '—';
          }));
        }), 1));
      var known = rows.filter(function (r) { return r.t; });
      if (known.length >= 2) {
        c.body.appendChild(el('h4', 'cmp-sub', 'Year-to-date scorecard'));
        c.body.appendChild(scorecard(CMP_YEAR_METRICS, known).node);
      }
      c.body.appendChild(el('p', 'card-note cmp-foot',
        '— means not on that month’s data, or no figure to work from. ' +
        'The average counts only the months a person is on the data' +
        (j.inProgress ? ', including ' + monShort(j.inProgress) + ' to date.' : '.')));
    });
    return c.root;
  }

  // ---- the report under the picker
  function renderCmpReport(host, cs) {
    var names = cs.map(function (c) { return c.name; });
    var score = scorecard(CMP_MONTH_METRICS, cs);
    var total = cs.reduce(function (a, c) { return a + c.s.salesValue; }, 0);

    // one tile per person
    var tiles = el('div', 'cmp-people');
    cs.forEach(function (c, i) {
      var k = el('div', 'kpi cmp-person');
      k.style.setProperty('--c', 'var(--cmp-' + c.slot + ')');
      var head = el('div', 'cmp-person-head');
      head.appendChild(swatch(c.slot));
      head.appendChild(el('span', 'cmp-person-name', c.name));
      k.appendChild(head);
      var info = S.roster[c.name] || {};
      var role = [info.designation, info.region].filter(Boolean).join(' · ');
      if (role) k.appendChild(el('div', 'kpi-sub', role));
      k.appendChild(el('div', 'kpi-label', 'Secondary sales'));
      k.appendChild(el('div', 'kpi-value num', money(c.s.salesValue)));
      k.appendChild(el('div', 'kpi-sub', plural(c.s.visits, 'visit') + ' · ' +
        plural(c.outletsBilled, 'outlet') + ' billed · ' + pctOf(c.s.salesValue, total) + ' of the group'));
      if (score.judged) {
        var led = el('div', 'kpi-sub');
        led.appendChild(el('span', 'chip ' + (score.led[i] === Math.max.apply(null, score.led) ? 'ok' : 'neutral'),
          'Best on ' + score.led[i] + ' of ' + score.judged + ' measures'));
        k.appendChild(led);
      }
      tiles.appendChild(k);
    });
    host.appendChild(tiles);

    // key findings
    var f = monthFindings(cs, score);
    var fc = card('Key findings', periodLabel());
    fc.body.appendChild(findingsList('cmp-findings', f.out));
    if (f.watch.length) {
      fc.body.appendChild(el('h4', 'cmp-sub', 'Watch points'));
      fc.body.appendChild(findingsList('cmp-watch', f.watch));
    }
    if (window.SEC_MONTH === new Date().toISOString().slice(0, 7)) {
      fc.body.appendChild(el('p', 'card-note cmp-foot', monthName(window.SEC_MONTH) +
        ' is still in progress, so these are month-to-date figures.'));
    }
    host.appendChild(fc.root);

    // scorecard
    var sc = card('Scorecard', periodLabel());
    sc.body.appendChild(score.node);
    sc.body.appendChild(el('p', 'card-note cmp-foot',
      '“Best” marks the strongest figure in each row; for top customer’s share, cost per visit and ' +
      'expenses as a share of sales, lower is better. ' +
      '— means there is nothing to work it out from, such as no expenses claimed.'));
    host.appendChild(sc.root);

    // at a glance: the same people on three measures
    var gc = card('At a glance', compact(total) + ' sold between them');
    function glance(title, get, fmt) {
      gc.body.appendChild(el('h4', 'cmp-sub', title));
      var scale = Math.max.apply(null, cs.map(function (c) { return Math.abs(get(c)); })) || 1;
      var bars = el('div', 'bars bars-fit');
      cs.forEach(function (c) {
        bars.appendChild(barRow(c.name, get(c), scale, 'var(--cmp-' + c.slot + ')',
          c.name + ' · ' + title + ' · ' + fmt(get(c)), fmt));
      });
      gc.body.appendChild(bars);
    }
    glance('Secondary sales', function (c) { return c.s.salesValue; }, money);
    glance('Visits', function (c) { return c.s.visits; }, intFmt);
    glance('Outlets billed', function (c) { return c.outletsBilled; }, intFmt);
    host.appendChild(gc.root);

    // week by week
    var mon = MON[+S.periodFrom.split('-')[1] - 1];
    var wc = card('Week by week', 'secondary sales and visits');
    wc.body.appendChild(table(['Week'].concat(names), cs[0].weeks.map(function (w, i) {
      return [w.from + '–' + w.to + ' ' + mon].concat(cs.map(function (c) {
        return money(c.weeks[i].value) + ' · ' + plural(c.weeks[i].visits, 'visit');
      }));
    }), 1));
    wc.body.appendChild(el('p', 'card-note cmp-foot', 'Strongest week for sales: ' + joinList(cs.map(function (c) {
      var b = c.weeks.reduce(function (a, w) { return w.value > a.value ? w : a; }, c.weeks[0]);
      return c.name + ' ' + (b.value > 0 ? b.from + '–' + b.to + ' ' + mon : 'none');
    })) + '.'));
    host.appendChild(wc.root);

    // product category mix, each as a share of that person's own sales
    var catTotal = {};
    cs.forEach(function (c) {
      Object.keys(c.s.byCat).forEach(function (k) { catTotal[k] = (catTotal[k] || 0) + c.s.byCat[k]; });
    });
    var cats = topEntries(catTotal, 1e9).map(function (e) { return e[0]; });
    var shown = cats.slice(0, 8), rest = cats.slice(8);
    var pc = card('Product category mix', 'share of each person’s own sales');
    if (!cats.length) {
      pc.body.appendChild(el('p', 'card-note', 'No secondary sales to break down.'));
    } else {
      var crow = function (label, keys) {
        return [label].concat(cs.map(function (c) {
          var v = keys.reduce(function (a, k) { return a + (c.s.byCat[k] || 0); }, 0);
          return v ? money(v) + ' · ' + pctOf(v, c.s.salesValue) : '—';
        }));
      };
      var crows = shown.map(function (k) { return crow(k, [k]); });
      if (rest.length) crows.push(crow('Other categories (' + rest.length + ')', rest));
      pc.body.appendChild(table(['Category'].concat(names), crows, 1));
    }
    host.appendChild(pc.root);

    // customer base
    var seen = {};
    cs.forEach(function (c) { Object.keys(c.billed).forEach(function (k) { seen[k] = (seen[k] || 0) + 1; }); });
    var ub = card('Customer base', periodLabel());
    ub.body.appendChild(table(['Measure'].concat(names), [
      ['Outlets billed'].concat(cs.map(function (c) { return intFmt(c.outletsBilled); })),
      ['Largest customer'].concat(cs.map(function (c) {
        return c.topBuyer ? c.topBuyer[0] + ' · ' + pctOf(c.topBuyer[1], c.s.salesValue) : '—';
      })),
      ['Top 5 customers’ share'].concat(cs.map(function (c) {
        return c.s.salesValue > 0 ? pctOf(c.top5, c.s.salesValue) : '—';
      })),
      ['Outlets also billed by another person here'].concat(cs.map(function (c) {
        return intFmt(Object.keys(c.billed).filter(function (k) { return seen[k] > 1; }).length);
      }))
    ], 1));
    host.appendChild(ub.root);

    // top items, one column each, on one scale so bar lengths compare
    var ic = card('Top items', 'five largest by value for each person');
    var cols = el('div', 'cmp-cols');
    var tops = cs.map(function (c) {
      var vals = {};
      Object.keys(c.s.byItem).forEach(function (k) { vals[k] = c.s.byItem[k].value; });
      return topEntries(vals, 5);
    });
    var imax = Math.max.apply(null, tops.map(function (t) { return t.length ? Math.abs(t[0][1]) : 0; })) || 1;
    cs.forEach(function (c, i) {
      var col = el('div', 'cmp-col');
      var h = el('div', 'cmp-col-head');
      h.appendChild(swatch(c.slot));
      h.appendChild(document.createTextNode(c.name));
      col.appendChild(h);
      if (!tops[i].length) {
        col.appendChild(el('p', 'card-note', 'No secondary sales recorded.'));
      } else {
        var b = el('div', 'bars bars-fit');
        tops[i].forEach(function (t) {
          b.appendChild(barRow(t[0], t[1], imax, 'var(--cmp-' + c.slot + ')',
            c.name + ' · ' + t[0] + ' · ' + money(t[1]) + ' · ' + pctOf(t[1], c.s.salesValue) + ' of their sales'));
        });
        col.appendChild(b);
      }
      cols.appendChild(col);
    });
    ic.body.appendChild(cols);
    host.appendChild(ic.root);

    host.appendChild(yearCard(cs));
  }

  // ---- the picker card: chosen people as chips, a search box to add more
  function cmpSave() {
    try {
      localStorage.setItem(CMP_STORE_KEY, JSON.stringify(cmpPicked.map(function (p) { return p.r.name; })));
    } catch (e) { /* ignore */ }
  }
  function cmpAdd(r) {
    if (cmpPicked.length >= CMP_MAX || cmpPicked.some(function (p) { return p.r === r; })) return;
    var slot = 1;
    while (cmpPicked.some(function (p) { return p.slot === slot; })) slot++;   // lowest free colour
    cmpPicked.push({ r: r, slot: slot });
    cmpSave();
    cmpRefresh();
  }
  function cmpRemove(r) {
    cmpPicked = cmpPicked.filter(function (p) { return p.r !== r; });
    cmpSave();
    cmpRefresh();
  }

  function cmpOpenList(q) {
    var u = cmpUi;
    q = (q || '').trim().toLowerCase();
    cmpFiltered = roster.filter(function (r) {
      return r.name.toLowerCase().indexOf(q) !== -1 &&
             !cmpPicked.some(function (p) { return p.r === r; });
    });
    u.list.textContent = '';
    if (!cmpFiltered.length) {
      u.list.appendChild(el('div', 'opt-empty', q ? 'No one matches “' + q + '”' : 'No one else to add'));
    } else {
      cmpFiltered.forEach(function (r, i) {
        var o = el('div', 'opt' + (i === cmpCursor ? ' active' : ''));
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
        o.appendChild(el('div', 'opt-val' + (r.salesValue ? ' num' : ''),
          r.salesValue ? compact(r.salesValue) + ' · ' + plural(r.visits, 'visit')
                       : r.visits ? plural(r.visits, 'visit') : 'no activity'));
        o.addEventListener('mousedown', function (e) {
          e.preventDefault();
          u.input.value = '';
          cmpCloseList();
          cmpAdd(r);
        });
        u.list.appendChild(o);
      });
    }
    u.list.hidden = false;
    u.input.setAttribute('aria-expanded', 'true');
  }
  function cmpCloseList() {
    cmpUi.list.hidden = true;
    cmpUi.input.setAttribute('aria-expanded', 'false');
    cmpCursor = -1;
  }

  function buildCmpPicker(host) {
    var c = card('Compare salespeople', 'up to ' + CMP_MAX + ' people · ' + periodLabel());
    c.root.classList.add('cmp-pickcard');
    var chosen = el('div', 'cmp-chosen');
    c.body.appendChild(chosen);
    var u = { root: c.root, chosen: chosen };

    if (roster.length < 2) {
      var box = el('div', 'notice');
      box.innerHTML = '<strong>Nobody to compare with.</strong> You can see only your own figures here. ' +
        'Managers can compare the people in their team.';
      c.body.appendChild(box);
      host.appendChild(c.root);
      return u;
    }

    var tools = el('div', 'cmp-tools');
    var wrap = el('div', 'picker cmp-picker');
    wrap.innerHTML = '<svg class="picker-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" aria-hidden="true"><circle cx="9" cy="9" r="5.5"></circle>' +
      '<path d="M13.5 13.5 17.5 17.5" stroke-linecap="round"></path></svg>';
    var input = el('input', 'picker-input');
    input.type = 'text';
    input.id = 'cmp-input';
    input.autocomplete = 'off';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', 'cmp-list');
    input.setAttribute('aria-label', 'Add a person to compare');
    var lst = el('div', 'picker-list');
    lst.id = 'cmp-list';
    lst.setAttribute('role', 'listbox');
    lst.hidden = true;
    wrap.appendChild(input);
    wrap.appendChild(lst);
    tools.appendChild(wrap);
    var print = el('button', 'team-more cmp-print', 'Print or save as PDF');
    print.type = 'button';
    print.addEventListener('click', function () { window.print(); });
    tools.appendChild(print);
    c.body.appendChild(tools);
    var hint = el('p', 'card-note cmp-hint');
    c.body.appendChild(hint);
    host.appendChild(c.root);

    u.input = input; u.list = lst; u.print = print; u.hint = hint;
    cmpUi = u;
    input.addEventListener('focus', function () { cmpOpenList(input.value); });
    input.addEventListener('input', function () { cmpCursor = -1; cmpOpenList(input.value); });
    input.addEventListener('blur', function () { setTimeout(cmpCloseList, 120); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (lst.hidden) cmpOpenList(input.value);
        if (!cmpFiltered.length) return;
        cmpCursor += (e.key === 'ArrowDown' ? 1 : -1);
        if (cmpCursor < 0) cmpCursor = cmpFiltered.length - 1;
        if (cmpCursor >= cmpFiltered.length) cmpCursor = 0;
        cmpOpenList(input.value);
        var a = lst.children[cmpCursor];
        if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        if (!lst.hidden && cmpFiltered.length) {
          e.preventDefault();
          var r = cmpFiltered[cmpCursor >= 0 ? cmpCursor : 0];
          input.value = '';
          cmpCloseList();
          cmpAdd(r);
        }
      } else if (e.key === 'Escape') {
        cmpCloseList();
      }
    });
    return u;
  }

  function cmpRefresh() {
    var host = document.getElementById('sec-compare');
    if (!cmpUi) cmpUi = buildCmpPicker(host);
    var u = cmpUi;
    // everything after the picker card is the report, rebuilt on each change
    while (u.root.nextSibling) host.removeChild(u.root.nextSibling);
    cmpSeq++;
    host.setAttribute('data-names', cmpPicked.length >= 2
      ? cmpPicked.map(function (p) { return p.r.name; }).join(' vs ') : '');

    u.chosen.textContent = '';
    if (!u.input) return;                    // nobody to compare with: the notice says so
    cmpPicked.forEach(function (p) {
      var chip = el('span', 'cmp-chip');
      chip.appendChild(swatch(p.slot));
      chip.appendChild(el('span', null, p.r.name));
      var x = el('button');
      x.type = 'button';
      x.setAttribute('aria-label', 'Remove ' + p.r.name);
      x.innerHTML = '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round"><path d="M5.5 5.5l9 9m0-9l-9 9"></path></svg>';
      x.addEventListener('click', function () { cmpRemove(p.r); });
      chip.appendChild(x);
      u.chosen.appendChild(chip);
    });

    var full = cmpPicked.length >= CMP_MAX;
    u.input.disabled = full;
    u.input.placeholder = full ? 'Remove someone to add another'
      : cmpPicked.length ? 'Add another person…' : 'Search a name to add…';
    u.print.hidden = cmpPicked.length < 2;
    u.hint.textContent = !cmpPicked.length
      ? 'Pick two or three people to see them side by side. Only people you can see on this site are listed.'
      : cmpPicked.length === 1
        ? 'Add one or two more people to compare with ' + cmpPicked[0].r.name + '.'
        : 'Figures are for ' + periodLabel() + ', plus the year so far at the bottom. ' +
          'Change the month at the top to compare another month.';
    if (cmpPicked.length >= 2) renderCmpReport(host, cmpPicked.map(cmpStats));
  }

  // Built the first time the tab opens. Restores the last comparison, or
  // starts from the person already open in the other tabs.
  var cmpBooted = false;
  function ensureCompare() {
    if (cmpBooted) return;
    cmpBooted = true;
    var names = [];
    try { names = JSON.parse(localStorage.getItem(CMP_STORE_KEY) || '[]') || []; } catch (e) { names = []; }
    names.forEach(function (n) {
      var r = roster.filter(function (x) { return x.name === n; })[0];
      if (r && cmpPicked.length < CMP_MAX && cmpPicked.every(function (p) { return p.r !== r; })) {
        cmpPicked.push({ r: r, slot: cmpPicked.length + 1 });
      }
    });
    if (!cmpPicked.length && current && !current.team) cmpPicked.push({ r: current, slot: 1 });
    cmpRefresh();
  }

  // ---------------------------------------------------------------- picker
  var input = document.getElementById('sec-picker');
  var list = document.getElementById('sec-picker-list');
  var clearBtn = document.getElementById('sec-picker-clear');
  var current = null, cursor = -1, filtered = [];
  var view = 'overview';
  var SEC_VIEWS = ['overview', 'activity', 'ask', 'compare'];

  // The person tabs need someone picked in the header; Compare has its own
  // picker, so it shows whether or not anyone is.
  function showViews() {
    var on = !!current || view === 'compare';
    document.getElementById('sec-empty').hidden = on;
    document.getElementById('sec-views').hidden = !on;
    SEC_VIEWS.forEach(function (v) {
      document.getElementById('sec-' + v).hidden = (v !== view);
    });
  }

  function openList(q) {
    q = (q || '').trim().toLowerCase();
    filtered = (teamEntry ? [teamEntry] : []).concat(roster)
      .filter(function (r) { return r.name.toLowerCase().indexOf(q) !== -1; });
    list.textContent = '';
    if (!filtered.length) {
      list.appendChild(el('div', 'opt-empty', 'No one matches “' + q + '”'));
    } else {
      filtered.forEach(function (r, i) {
        var o = el('div', 'opt' + (r.team ? ' opt-team' : '') + (i === cursor ? ' active' : ''));
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
          r.team ? r.people + ' people · ' + compact(r.salesValue)
                 : r.visits ? r.visits + ' visits'
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
  // The Excel link downloads the month on screen for whoever is picked;
  // nobody or "All" means everyone this viewer can see.
  function setDownload() {
    var a = document.getElementById('sec-xlsx');
    if (!a) return;
    var one = current && !current.team;
    var month = window.SEC_MONTH || S.periodFrom.slice(0, 7);
    a.href = '/api/export/sec.xlsx?month=' + encodeURIComponent(month) +
      (one ? '&person=' + encodeURIComponent(current.name) : '');
    a.title = 'Download ' + periodLabel() + (one ? ' for ' + current.name : '') +
      ' as Excel: sales, visits, demos, leads, travel and expenses';
  }

  function select(r) {
    current = r;
    input.value = r.name;
    clearBtn.hidden = false;
    closeList();
    render();
    setDownload();
    try { localStorage.setItem('nutaste-sec-person', r.name); } catch (e) { /* ignore */ }
  }
  function clearSelection() {
    current = null;
    input.value = '';
    clearBtn.hidden = true;
    showViews();
    setDownload();
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
      if (view === 'compare') ensureCompare();
      showViews();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  function render() {
    if (!current) return;
    var s = summarise(current.d);
    renderOverview(current, s);
    renderActivity(current, s);
    renderSecAsk(current);
    showViews();
  }

  // ---------------------------------------------------------- month picker
  // Each month is its own dataset (person indices differ between months), so
  // choosing one reloads the page with ?month=. The person is remembered by
  // name and the open tab by sessionStorage, so the same view comes back.
  var VIEW_STORE_KEY = 'nutaste-sec-view';
  (function monthPicker() {
    var wrap = document.getElementById('sec-month-wrap');
    var sel = document.getElementById('sec-month');
    var months = (window.SEC_MONTHS || []).slice().sort().reverse();   // newest first
    var shown = window.SEC_MONTH || S.periodFrom.slice(0, 7);
    if (!wrap || !sel || !months.length) return;
    months.forEach(function (mk, i) {
      var p = mk.split('-');
      var o = el('option', null, MON[+p[1] - 1] + ' ' + p[0] + (i === 0 ? ' (latest)' : ''));
      o.value = mk;
      if (mk === shown) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      try { sessionStorage.setItem(VIEW_STORE_KEY, view); } catch (e) { /* ignore */ }
      // the latest month is the default, so it gets the plain address
      window.location.href = sel.value === months[0] ? '/' : '/?month=' + encodeURIComponent(sel.value);
    });
    wrap.dataset.ready = '1';      // switch.js shows it in this section only
  })();

  // ------------------------------------------------------- last refreshed
  // SEC_UPDATED is "YYYY-MM-DD HH:MM:SS" from meta.json; the block stays
  // hidden when the server does not send it.
  (function lastRefreshed() {
    var wrap = document.getElementById('sec-asof');
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(window.SEC_UPDATED || '');
    if (!wrap || !m) return;
    var out = document.getElementById('sec-asof-date');
    out.textContent = m[3] + '-' + MON[+m[2] - 1] + '-' + m[1];
    out.title = window.SEC_UPDATED;
    wrap.dataset.ready = '1';      // switch.js shows it in this section only
  })();

  // ---------------------------------------------------------------- boot
  document.getElementById('sec-period').textContent = periodLabel();
  setDownload();
  var savedView = null;
  try {
    savedView = sessionStorage.getItem(VIEW_STORE_KEY);
    sessionStorage.removeItem(VIEW_STORE_KEY);
  } catch (e) { /* ignore */ }
  if (SEC_VIEWS.indexOf(savedView) !== -1) {
    var tab = document.querySelector('.sec-tab[data-view="' + savedView + '"]');
    if (tab) tab.click();
  }
  var saved = null;
  try { saved = localStorage.getItem('nutaste-sec-person'); } catch (e) { /* ignore */ }
  if (saved) {
    var m = (teamEntry && saved === teamEntry.name) ? teamEntry
      : roster.filter(function (r) { return r.name === saved; })[0];
    if (m) select(m);
  }
  // Someone who can see only their own activity has nothing to pick.
  if (!current && roster.length === 1) select(roster[0]);
})();

