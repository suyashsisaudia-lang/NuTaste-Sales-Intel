"""
The Secondary Sales Ask box, in two modes.

ANALYST MODE (the live path for typed questions). The model is given this
person's actual rows — real outlets, real rupees, real kilometres — plus a set
of exact subtotals computed here in Python, and is asked to answer the question
directly: rank, compare, draw a conclusion, state a figure. It is the mode this
application now leads with, at the explicit request of its owner.

  The trade is deliberate and worth stating plainly: figures in an analyst
  answer are produced by the model, not computed from the rows by this
  application. They can disagree with the Overview tab and with Excel. The
  exact aggregates below exist to narrow that gap — the model is told to quote
  them rather than re-add anything itself — but they do not close it. Every
  analyst answer is labelled in the UI so a reader knows which kind they have.

SPEC MODE (retained, and still exact). The model returns only a filter — which
table, which grouping, which slice — and `runSecQuery` in static/secondary.js
computes every figure from the real rows. Nothing it returns can invent a
number. This is what `/api/ask/sec` still serves, and what the built-in parser
falls back to when no model is reachable.

Both modes are scoped to ONE person, and both resolve names against that
person's own rows, so neither can reach another person's activity. Spec mode
covers the month on screen only. Analyst mode also receives that person's
full calendar year as exact aggregates (see `build_year_summary`) — rows for the
month on screen, totals for the year — so it can answer year questions too.
"""
import calendar
import re
from typing import Any, Dict, List, Optional

MAX_NAMES_IN_PROMPT = 150
MAX_SMALL_POOL = 60

DATASETS = ("sales", "visits", "demos", "leads", "travel", "expenses")
METRICS = ("value", "count", "quantity", "minutes", "km", "workKm")
SORTS = ("largest", "smallest", "earliest", "latest")

# Column layouts, mirroring importers/sec_excel.py and static/secondary.js.
V = {"P": 0, "DAY": 1, "TYPE": 2, "CITY": 3, "CHAN": 4, "BUYER": 5, "MINS": 6}
DM = {"P": 0, "DAY": 1, "BUYER": 2, "REGION": 3, "STAGE": 4, "STATUS": 5, "CONV": 6, "VAL": 7}
LD = {"P": 0, "DAY": 1, "BUYER": 2, "CITY": 3, "STAGE": 4, "STATUS": 5, "TYPE": 6, "VAL": 7}
TR = {"P": 0, "DAY": 1, "WORK": 2, "TOTAL": 3}
EX = {"P": 0, "DAY": 1, "REGION": 2, "AMT": 3}
# ITEM and PCAT were added later; files written before them end at VAL.
SL = {"P": 0, "DAY": 1, "BUYER": 2, "PGROUP": 3, "CITY": 4, "QTY": 5, "VAL": 6,
      "ITEM": 7, "PCAT": 8}

# Which filter fields and groupings each table actually carries. A spec field
# the chosen table has no column for is dropped in validation rather than
# silently ignored by the browser.
FIELDS: Dict[str, Dict[str, Any]] = {
    "visits":   {"filters": {"customers", "city", "channel", "visitType"},
                 "groups": {"customer", "city", "channel", "visitType", "day"},
                 "metrics": {"count", "minutes"}, "default_metric": "count"},
    "demos":    {"filters": {"customers", "region", "stage", "status", "converted"},
                 "groups": {"customer", "region", "stage", "status", "day"},
                 "metrics": {"count", "value"}, "default_metric": "count"},
    "leads":    {"filters": {"customers", "city", "stage", "status", "leadType"},
                 "groups": {"customer", "city", "stage", "status", "leadType", "day"},
                 "metrics": {"count", "value"}, "default_metric": "count"},
    "travel":   {"filters": set(),
                 "groups": {"day"},
                 "metrics": {"count", "km", "workKm"}, "default_metric": "km"},
    "expenses": {"filters": {"region"},
                 "groups": {"region", "day"},
                 "metrics": {"count", "value"}, "default_metric": "value"},
    "sales":    {"filters": {"customers", "city", "productGroup", "item", "productCategory"},
                 "groups": {"customer", "city", "productGroup", "item", "productCategory",
                            "day"},
                 "metrics": {"count", "value", "quantity"}, "default_metric": "value"},
}

# Spec field -> (pool name, resolved key). `stage` reads a different pool for
# demos than for leads, so it is resolved per dataset below.
POOL_OF = {
    "city": "city",
    "channel": "channel",
    "visitType": "vtype",
    "region": "region",
    "status": "status",
    "leadType": "ltype",
    "productGroup": "pgroup",
    "item": "item",
    "productCategory": "pcat",
}


# --------------------------------------------------------------------- context
# The "All" entry in the name picker: every person the viewer can see, taken
# together. `sec` is already scoped to the viewer, so "all" never reaches beyond
# what the page itself shows.
ALL_PEOPLE = -1


def _valid_person(people: list, person_index: Any) -> bool:
    return isinstance(person_index, int) and (
        (person_index == ALL_PEOPLE and len(people) > 0) or 0 <= person_index < len(people))


def _person_label(people: list, person_index: int) -> str:
    if person_index == ALL_PEOPLE:
        return (f"All - the combined activity of a team of {len(people)} people "
                f"(read 'I', 'me' and 'my' as the whole team)")
    return people[person_index]


def _rows_for(sec: dict, key: str, person_index: int) -> List[list]:
    return [r for r in (sec.get(key) or [])
            if r and (person_index == ALL_PEOPLE or r[0] == person_index)]


def _cell(r: list, ix: int) -> Any:
    """A column that older month files do not carry reads as blank."""
    return r[ix] if ix < len(r) else None


def _pool_values(pool: List[str], indices) -> List[str]:
    """Pool labels for a set of indices, in alphabetical order, blanks dropped."""
    out = set()
    for i in indices:
        if isinstance(i, int) and 0 <= i < len(pool):
            v = pool[i]
            if v and v != "—":     # the importer's placeholder for "blank"
                out.add(v)
    return sorted(out)


def build_context(sec: dict, person_index: int) -> Optional[dict]:
    """Everything the model is told about this person's month.

    Names and labels only — no amounts, no quantities, no distances. The model
    needs to recognise which outlet or product group was meant; it never needs
    to know what any of them came to.
    """
    people = sec.get("people") or []
    if not _valid_person(people, person_index):
        return None

    pools = sec.get("pools") or {}
    def pool(name: str) -> List[str]:
        p = pools.get(name)
        return p if isinstance(p, list) else []

    rows = {k: _rows_for(sec, k, person_index) for k in DATASETS}

    buyers = ({r[V["BUYER"]] for r in rows["visits"]} |
              {r[DM["BUYER"]] for r in rows["demos"]} |
              {r[LD["BUYER"]] for r in rows["leads"]} |
              {r[SL["BUYER"]] for r in rows["sales"]})
    cities = ({r[V["CITY"]] for r in rows["visits"]} |
              {r[LD["CITY"]] for r in rows["leads"]} |
              {r[SL["CITY"]] for r in rows["sales"]})
    regions = ({r[DM["REGION"]] for r in rows["demos"]} |
               {r[EX["REGION"]] for r in rows["expenses"]})
    statuses = ({r[DM["STATUS"]] for r in rows["demos"]} |
                {r[LD["STATUS"]] for r in rows["leads"]})

    ctx = {
        "person": _person_label(people, person_index),
        "periodFrom": sec.get("periodFrom"),
        "periodTo": sec.get("periodTo"),
        "counts": {k: len(v) for k, v in rows.items()},
        "customerNames": _pool_values(pool("buyer"), buyers)[:MAX_NAMES_IN_PROMPT],
        "cities": _pool_values(pool("city"), cities)[:MAX_SMALL_POOL],
        "channels": _pool_values(pool("channel"),
                                 {r[V["CHAN"]] for r in rows["visits"]})[:MAX_SMALL_POOL],
        "visitTypes": _pool_values(pool("vtype"),
                                   {r[V["TYPE"]] for r in rows["visits"]})[:MAX_SMALL_POOL],
        "productGroups": _pool_values(pool("pgroup"),
                                      {r[SL["PGROUP"]] for r in rows["sales"]})[:MAX_SMALL_POOL],
        "items": _pool_values(pool("item"),
                              {_cell(r, SL["ITEM"]) for r in rows["sales"]})[:MAX_NAMES_IN_PROMPT],
        "productCategories": _pool_values(pool("pcat"),
                                          {_cell(r, SL["PCAT"]) for r in rows["sales"]})[:MAX_SMALL_POOL],
        "regions": _pool_values(pool("region"), regions)[:MAX_SMALL_POOL],
        "demoStages": _pool_values(pool("stage"),
                                   {r[DM["STAGE"]] for r in rows["demos"]})[:MAX_SMALL_POOL],
        "leadStages": _pool_values(pool("lstage"),
                                   {r[LD["STAGE"]] for r in rows["leads"]})[:MAX_SMALL_POOL],
        "statuses": _pool_values(pool("status"), statuses)[:MAX_SMALL_POOL],
        "leadTypes": _pool_values(pool("ltype"),
                                  {r[LD["TYPE"]] for r in rows["leads"]})[:MAX_SMALL_POOL],
        # Kept for label -> index resolution; never put in a prompt.
        "_pools": pools,
    }
    return ctx


def has_any_activity(ctx: dict) -> bool:
    return any(ctx["counts"].values())


ANALYST_MAX_ROWS_PER_TABLE = 400

ANALYST_COLUMNS = {
    "sales":    "day,outlet,item,category,product_group,city,qty,value_rs",
    "visits":   "day,outlet,visit_type,city,channel,minutes",
    "demos":    "day,customer,region,stage,status,converted,est_value_rs",
    "leads":    "day,company,city,stage,status,lead_type,est_value_rs",
    "travel":   "day,working_km,total_km",
    "expenses": "day,region,amount_rs",
}

def _csv_cell(v: Any) -> str:
    """A pool label can contain a comma, which would shift every later column."""
    s = "" if v is None else str(v)
    return '"' + s.replace('"', "'") + '"' if ("," in s or '"' in s) else s

def _table_rows(rows: List[list], pools: dict, kind: str) -> List[str]:
    def lab(name: str, ix: Any) -> str:
        pool = pools.get(name)
        return pool[ix] if isinstance(pool, list) and isinstance(ix, int) and 0 <= ix < len(pool) else ""

    out = []
    for r in rows:
        if kind == "sales":
            cells = [r[SL["DAY"]], lab("buyer", r[SL["BUYER"]]),
                     lab("item", _cell(r, SL["ITEM"])), lab("pcat", _cell(r, SL["PCAT"])),
                     lab("pgroup", r[SL["PGROUP"]]),
                     lab("city", r[SL["CITY"]]), r[SL["QTY"]], r[SL["VAL"]]]
        elif kind == "visits":
            cells = [r[V["DAY"]], lab("buyer", r[V["BUYER"]]), lab("vtype", r[V["TYPE"]]),
                     lab("city", r[V["CITY"]]), lab("channel", r[V["CHAN"]]), r[V["MINS"]]]
        elif kind == "demos":
            cells = [r[DM["DAY"]], lab("buyer", r[DM["BUYER"]]), lab("region", r[DM["REGION"]]),
                     lab("stage", r[DM["STAGE"]]), lab("status", r[DM["STATUS"]]),
                     "yes" if r[DM["CONV"]] else "no", r[DM["VAL"]]]
        elif kind == "leads":
            cells = [r[LD["DAY"]], lab("buyer", r[LD["BUYER"]]), lab("city", r[LD["CITY"]]),
                     lab("lstage", r[LD["STAGE"]]), lab("status", r[LD["STATUS"]]),
                     lab("ltype", r[LD["TYPE"]]), r[LD["VAL"]]]
        elif kind == "travel":
            cells = [r[TR["DAY"]], r[TR["WORK"]], r[TR["TOTAL"]]]
        else:
            cells = [r[EX["DAY"]], lab("region", r[EX["REGION"]]), r[EX["AMT"]]]
        out.append(",".join(_csv_cell(c) for c in cells))
    return out


def _totals(rows: List[list], cols: Dict[str, int]) -> Dict[str, float]:
    """Exact column sums. Computed here so the model never has to add up a list."""
    return {name: round(sum(r[ix] or 0 for r in rows), 2) for name, ix in cols.items()}


def _breakdown(rows: List[list], key_ix: int, val_ix: Optional[int],
               pools: dict, pool_name: str) -> List[tuple]:
    """Exact per-group totals and counts, largest first."""
    agg: Dict[Any, List[float]] = {}
    for r in rows:
        slot = agg.setdefault(r[key_ix], [0.0, 0])
        slot[0] += (r[val_ix] or 0) if val_ix is not None else 0
        slot[1] += 1
    pool = pools.get(pool_name)
    out = []
    for ix, (total, n) in agg.items():
        label = pool[ix] if isinstance(pool, list) and isinstance(ix, int) and 0 <= ix < len(pool) else str(ix)
        out.append((label, round(total, 2), n))
    out.sort(key=lambda t: (-t[1], -t[2]))
    return out


def _items(rows: List[list], pools: dict) -> List[tuple]:
    """Exact per-item value, units and line count, largest value first."""
    agg: Dict[str, List[float]] = {}
    for r in rows:
        label = _label(pools, "item", _cell(r, SL["ITEM"])) or "—"
        slot = agg.setdefault(label, [0.0, 0.0, 0])
        slot[0] += r[SL["VAL"]] or 0
        slot[1] += r[SL["QTY"]] or 0
        slot[2] += 1
    out = [(k, round(v[0], 2), round(v[1], 2), int(v[2])) for k, v in agg.items()]
    out.sort(key=lambda t: (-t[1], -t[2]))
    return out


def _fmt_items(items: List[tuple], limit: int) -> List[str]:
    out = [f"    {name}: ₹{_inr(value)}, {_inr(qty)} units across {n} line(s)"
           for name, value, qty, n in items[:limit]]
    if len(items) > limit:
        rest = items[limit:]
        out.append(f"    ...and {len(rest)} more item(s), ₹{_inr(sum(t[1] for t in rest))} "
                   f"between them")
    return out


def build_analyst_payload(sec: dict, person_index: int) -> Optional[dict]:
    """This person's real rows, plus the subtotals the model should quote.

    Unlike `build_context`, this DOES carry amounts — that is the whole point of
    analyst mode. It is still one person and one month: rows are filtered by
    person_index before anything else happens, so no prompt can carry another
    person's activity.
    """
    people = sec.get("people") or []
    if not _valid_person(people, person_index):
        return None

    pools = sec.get("pools") or {}
    rows = {k: _rows_for(sec, k, person_index) for k in DATASETS}

    tables = {}
    for kind, rs in rows.items():
        kept = rs[-ANALYST_MAX_ROWS_PER_TABLE:]
        tables[kind] = {
            "columns": ANALYST_COLUMNS[kind],
            "lines": _table_rows(kept, pools, kind),
            "dropped": len(rs) - len(kept),
        }

    exact = {
        "sales": {
            **_totals(rows["sales"], {"value_rs": SL["VAL"], "qty": SL["QTY"]}),
            "lines": len(rows["sales"]),
            "by_outlet": _breakdown(rows["sales"], SL["BUYER"], SL["VAL"], pools, "buyer"),
            "by_product_group": _breakdown(rows["sales"], SL["PGROUP"], SL["VAL"], pools, "pgroup"),
            "by_item": _items(rows["sales"], pools),
            "by_category": _breakdown([r for r in rows["sales"] if len(r) > SL["PCAT"]],
                                      SL["PCAT"], SL["VAL"], pools, "pcat"),
            "by_city": _breakdown(rows["sales"], SL["CITY"], SL["VAL"], pools, "city"),
        },
        "visits": {
            **_totals(rows["visits"], {"minutes": V["MINS"]}),
            "lines": len(rows["visits"]),
            "by_outlet": _breakdown(rows["visits"], V["BUYER"], None, pools, "buyer"),
            "by_visit_type": _breakdown(rows["visits"], V["TYPE"], None, pools, "vtype"),
            "by_city": _breakdown(rows["visits"], V["CITY"], None, pools, "city"),
            "by_channel": _breakdown(rows["visits"], V["CHAN"], None, pools, "channel"),
        },
        "demos": {
            **_totals(rows["demos"], {"est_value_rs": DM["VAL"]}),
            "lines": len(rows["demos"]),
            "converted": sum(1 for r in rows["demos"] if r[DM["CONV"]]),
            "by_stage": _breakdown(rows["demos"], DM["STAGE"], DM["VAL"], pools, "stage"),
            "by_status": _breakdown(rows["demos"], DM["STATUS"], DM["VAL"], pools, "status"),
        },
        "leads": {
            **_totals(rows["leads"], {"est_value_rs": LD["VAL"]}),
            "lines": len(rows["leads"]),
            "by_stage": _breakdown(rows["leads"], LD["STAGE"], LD["VAL"], pools, "lstage"),
            "by_status": _breakdown(rows["leads"], LD["STATUS"], LD["VAL"], pools, "status"),
        },
        "travel": {
            **_totals(rows["travel"], {"total_km": TR["TOTAL"], "working_km": TR["WORK"]}),
            "days": len(rows["travel"]),
        },
        "expenses": {
            **_totals(rows["expenses"], {"amount_rs": EX["AMT"]}),
            "claims": len(rows["expenses"]),
            "by_region": _breakdown(rows["expenses"], EX["REGION"], EX["AMT"], pools, "region"),
        },
    }

    return {
        "person": _person_label(people, person_index),
        "periodFrom": sec.get("periodFrom"),
        "periodTo": sec.get("periodTo"),
        "tables": tables,
        "exact": exact,
    }


# ------------------------------------------------------------ full-year summary
# The analyst also sees the rest of the calendar year, as exact aggregates only.
# A year of rows is far too long to send (one person has over 7,000 sale lines),
# and the figures a year question needs — month by month, outlet by outlet — are
# better computed here than re-added by the model anyway.
YEAR_MAX_OUTLETS = 60
YEAR_MAX_CITIES = 20
YEAR_MAX_VISITED = 30
YEAR_MAX_ITEMS = 60


def _label(pools: dict, name: str, ix: Any) -> str:
    pool = pools.get(name)
    return pool[ix] if isinstance(pool, list) and isinstance(ix, int) and 0 <= ix < len(pool) else ""


def month_name(month: str) -> str:
    """'2026-09' -> 'Sep 2026'."""
    try:
        y, m = month.split("-")
        return f"{calendar.month_abbr[int(m)]} {y}"
    except (ValueError, IndexError):
        return month


def _tally(agg: Dict[str, List[float]], label: str, value: float) -> None:
    slot = agg.setdefault(label or "—", [0.0, 0])
    slot[0] += value or 0
    slot[1] += 1


def _ranked(agg: Dict[str, List[float]]) -> List[tuple]:
    out = [(k, round(v[0], 2), int(v[1])) for k, v in agg.items()]
    out.sort(key=lambda t: (-t[1], -t[2]))
    return out


def build_year_summary(months: List[tuple], person: Optional[str],
                       in_progress: Optional[str] = None) -> Optional[dict]:
    """Exact month-by-month and full-year figures for one person, or for
    everyone in the (already scoped) month files when `person` is None.

    `months` is [(YYYY-MM, sec), ...], oldest first, each `sec` already scoped
    to the viewer. Person indices and pool indices both differ between month
    files, so the person is found by name and every group is keyed by its
    label, never by an index.
    """
    per_month: List[dict] = []
    outlets: Dict[str, dict] = {}
    pgroups: Dict[str, Dict[str, float]] = {}
    pcats: Dict[str, Dict[str, float]] = {}
    items: Dict[str, dict] = {}
    cities: Dict[str, List[float]] = {}
    visited: Dict[str, List[float]] = {}
    demo_stage: Dict[str, List[float]] = {}
    demo_status: Dict[str, List[float]] = {}
    lead_stage: Dict[str, List[float]] = {}
    lead_status: Dict[str, List[float]] = {}
    exp_region: Dict[str, List[float]] = {}
    bought_any, visited_any = set(), set()

    for month, sec in months:
        people = sec.get("people") or []
        if (person is None and not people) or (person is not None and person not in people):
            per_month.append({"month": month, "absent": True})
            continue
        ix = ALL_PEOPLE if person is None else people.index(person)
        pools = sec.get("pools") or {}
        rows = {k: _rows_for(sec, k, ix) for k in DATASETS}

        bought = set()
        for r in rows["sales"]:
            buyer = _label(pools, "buyer", r[SL["BUYER"]]) or "—"
            bought.add(buyer)
            o = outlets.setdefault(buyer, {"value": 0.0, "lines": 0, "months": set()})
            o["value"] += r[SL["VAL"]] or 0
            o["lines"] += 1
            o["months"].add(month)
            pg = _label(pools, "pgroup", r[SL["PGROUP"]]) or "—"
            pgroups.setdefault(pg, {})
            pgroups[pg][month] = pgroups[pg].get(month, 0) + (r[SL["VAL"]] or 0)
            pc = _label(pools, "pcat", _cell(r, SL["PCAT"])) or "—"
            pcats.setdefault(pc, {})
            pcats[pc][month] = pcats[pc].get(month, 0) + (r[SL["VAL"]] or 0)
            it = items.setdefault(_label(pools, "item", _cell(r, SL["ITEM"])) or "—",
                                  {"value": 0.0, "qty": 0.0, "months": set(), "outlets": set()})
            it["value"] += r[SL["VAL"]] or 0
            it["qty"] += r[SL["QTY"]] or 0
            it["months"].add(month)
            it["outlets"].add(buyer)
            _tally(cities, _label(pools, "city", r[SL["CITY"]]), r[SL["VAL"]])
        seen = set()
        for r in rows["visits"]:
            buyer = _label(pools, "buyer", r[V["BUYER"]]) or "—"
            seen.add(buyer)
            _tally(visited, buyer, 0)
        for r in rows["demos"]:
            _tally(demo_stage, _label(pools, "stage", r[DM["STAGE"]]), r[DM["VAL"]])
            _tally(demo_status, _label(pools, "status", r[DM["STATUS"]]), r[DM["VAL"]])
        for r in rows["leads"]:
            _tally(lead_stage, _label(pools, "lstage", r[LD["STAGE"]]), r[LD["VAL"]])
            _tally(lead_status, _label(pools, "status", r[LD["STATUS"]]), r[LD["VAL"]])
        for r in rows["expenses"]:
            _tally(exp_region, _label(pools, "region", r[EX["REGION"]]), r[EX["AMT"]])
        bought_any |= bought
        visited_any |= seen

        def total(kind: str, col: int) -> float:
            return round(sum(r[col] or 0 for r in rows[kind]), 2)

        per_month.append({
            "month": month,
            "sales_rs": total("sales", SL["VAL"]), "qty": total("sales", SL["QTY"]),
            "sale_lines": len(rows["sales"]), "outlets_bought": len(bought),
            "visits": len(rows["visits"]), "visit_minutes": total("visits", V["MINS"]),
            "outlets_visited": len(seen),
            "demos": len(rows["demos"]),
            "demos_converted": sum(1 for r in rows["demos"] if r[DM["CONV"]]),
            "demo_rs": total("demos", DM["VAL"]),
            "leads": len(rows["leads"]), "lead_rs": total("leads", LD["VAL"]),
            "km": total("travel", TR["TOTAL"]), "work_km": total("travel", TR["WORK"]),
            "travel_days": len(rows["travel"]),
            "expense_rs": total("expenses", EX["AMT"]), "claims": len(rows["expenses"]),
        })

    present = [m for m in per_month if not m.get("absent")]
    if not present:
        return None

    summed = ("sales_rs", "qty", "sale_lines", "visits", "visit_minutes", "demos",
              "demos_converted", "demo_rs", "leads", "lead_rs", "km", "work_km",
              "travel_days", "expense_rs", "claims")
    year_total = {k: round(sum(m[k] for m in present), 2) for k in summed}
    year_total["outlets_bought"] = len(bought_any)
    year_total["outlets_visited"] = len(visited_any)

    outlet_rows = sorted(
        ((name, round(o["value"], 2), o["lines"], len(o["months"]), max(o["months"]))
         for name, o in outlets.items()),
        key=lambda t: (-t[1], -t[2]))

    return {
        "months": [m for m, _ in months],
        "inProgress": in_progress,
        "perMonth": per_month,
        "total": year_total,
        "outlets": outlet_rows,
        "productGroups": sorted(
            ((pg, round(sum(v.values()), 2), {m: round(x, 2) for m, x in v.items()})
             for pg, v in pgroups.items()), key=lambda t: -t[1]),
        "categories": sorted(
            ((pc, round(sum(v.values()), 2), {m: round(x, 2) for m, x in v.items()})
             for pc, v in pcats.items()), key=lambda t: -t[1]),
        "items": sorted(
            ((name, round(i["value"], 2), round(i["qty"], 2), len(i["months"]),
              max(i["months"]), len(i["outlets"])) for name, i in items.items()),
            key=lambda t: -t[1]),
        "cities": _ranked(cities),
        "visited": _ranked(visited),
        "demoStage": _ranked(demo_stage), "demoStatus": _ranked(demo_status),
        "leadStage": _ranked(lead_stage), "leadStatus": _ranked(lead_status),
        "expenseRegion": _ranked(exp_region),
    }


def _year_lines(y: dict) -> List[str]:
    first, last = month_name(y["months"][0]), month_name(y["months"][-1])
    t = y["total"]
    L = [
        "",
        f"=== FULL CALENDAR YEAR: {first} to {last} (EXACT — computed by the application; "
        f"no individual rows are given for the year) ===",
    ]
    if y.get("inProgress"):
        L.append(f"{month_name(y['inProgress'])} is the current month and is still in "
                 f"progress, so its figures are partial.")
    L += [
        "",
        "MONTH BY MONTH:",
        "  month | sales_rs | units | sale_lines | outlets_bought | visits | visit_min | "
        "outlets_visited | demos | converted | demo_est_rs | leads | lead_est_rs | km | "
        "working_km | travel_days | expenses_rs | claims",
    ]
    for m in y["perMonth"]:
        if m.get("absent"):
            L.append(f"  {month_name(m['month'])} | not on this month's data — no activity recorded")
            continue
        L.append("  " + " | ".join([
            month_name(m["month"]), f"₹{_inr(m['sales_rs'])}", _inr(m["qty"]),
            str(m["sale_lines"]), str(m["outlets_bought"]), str(m["visits"]),
            _inr(m["visit_minutes"]), str(m["outlets_visited"]), str(m["demos"]),
            str(m["demos_converted"]), f"₹{_inr(m['demo_rs'])}", str(m["leads"]),
            f"₹{_inr(m['lead_rs'])}", _inr(m["km"]), _inr(m["work_km"]),
            str(m["travel_days"]), f"₹{_inr(m['expense_rs'])}", str(m["claims"])]))
    L += [
        "",
        f"YEAR TOTAL: sales ₹{_inr(t['sales_rs'])}, {_inr(t['qty'])} units, "
        f"{t['sale_lines']:.0f} sale lines, {t['outlets_bought']} distinct outlets bought; "
        f"{t['visits']:.0f} visits ({_inr(t['visit_minutes'])} min) to "
        f"{t['outlets_visited']} distinct outlets; {t['demos']:.0f} demos, "
        f"{t['demos_converted']:.0f} converted, ₹{_inr(t['demo_rs'])} est.; "
        f"{t['leads']:.0f} leads, ₹{_inr(t['lead_rs'])} est.; {_inr(t['km'])} km "
        f"({_inr(t['work_km'])} working) over {t['travel_days']:.0f} day(s); "
        f"expenses ₹{_inr(t['expense_rs'])} across {t['claims']:.0f} claim(s)",
        "",
        f"YEAR SALES BY OUTLET (largest first; 'last bought' is the latest month with a sale):",
    ]
    for name, value, lines, n_months, last_m in y["outlets"][:YEAR_MAX_OUTLETS]:
        L.append(f"    {name}: ₹{_inr(value)} across {lines} line(s); bought in "
                 f"{n_months} month(s); last bought {month_name(last_m)}")
    rest = y["outlets"][YEAR_MAX_OUTLETS:]
    if rest:
        L.append(f"    ...and {len(rest)} more outlet(s), ₹{_inr(sum(r[1] for r in rest))} "
                 f"between them")
    L.append("")
    L.append("YEAR SALES BY PRODUCT GROUP (year total, then month by month):")
    for pg, total, by_m in y["productGroups"]:
        months = ", ".join(f"{month_name(m)} ₹{_inr(by_m[m])}" for m in sorted(by_m))
        L.append(f"    {pg}: ₹{_inr(total)} | {months}")
    L.append("")
    L.append("YEAR SALES BY PRODUCT CATEGORY (year total, then month by month):")
    for pc, total, by_m in y["categories"]:
        months = ", ".join(f"{month_name(m)} ₹{_inr(by_m[m])}" for m in sorted(by_m))
        L.append(f"    {pc}: ₹{_inr(total)} | {months}")
    L.append("")
    L.append("YEAR SALES BY ITEM (largest first):")
    for name, value, qty, n_months, last_m, n_outlets in y["items"][:YEAR_MAX_ITEMS]:
        L.append(f"    {name}: ₹{_inr(value)}, {_inr(qty)} units; sold in {n_months} month(s), "
                 f"last {month_name(last_m)}; to {n_outlets} outlet(s)")
    rest = y["items"][YEAR_MAX_ITEMS:]
    if rest:
        L.append(f"    ...and {len(rest)} more item(s), ₹{_inr(sum(r[1] for r in rest))} "
                 f"between them")
    L += ["", "YEAR SALES BY CITY:", *_fmt_breakdown(y["cities"], "₹", YEAR_MAX_CITIES),
          "", "YEAR VISITS BY OUTLET:", *_fmt_breakdown(y["visited"], "count", YEAR_MAX_VISITED),
          "", "YEAR DEMOS by stage:", *_fmt_breakdown(y["demoStage"], "₹"),
          "  by status:", *_fmt_breakdown(y["demoStatus"], "₹"),
          "", "YEAR LEADS by stage:", *_fmt_breakdown(y["leadStage"], "₹"),
          "  by status:", *_fmt_breakdown(y["leadStatus"], "₹"),
          "", "YEAR EXPENSES by region:", *_fmt_breakdown(y["expenseRegion"], "₹")]
    return L


ANALYST_SYSTEM = """\
You are a sales analyst. You are given one salesperson's field activity in two
scopes, and your job is to answer the question put to you — directly, with
figures, and with a conclusion.

- THE MONTH ON SCREEN: every row for that one calendar month, plus exact totals.
- THE FULL CALENDAR YEAR (when provided): exact month-by-month totals and
  full-year breakdowns computed by the application. No rows are given for it.

Choosing the scope:
- If the question mentions the year, YTD, "so far", all / every / each month,
  a month other than the one on screen, a trend, growth, or a comparison between
  months, answer from the FULL CALENDAR YEAR section.
- Otherwise answer for the month on screen.
- Always say which period your figures cover, e.g. "Jan–Oct 2026" or
  "September 2026". Never present one month's figure as the year's.
- The year section has no rows. If a year question needs detail it does not
  carry (for example one outlet's product mix across the year), say so in one
  line and answer the closest thing it does carry.

Answer the question. Rank, compare, total, work out a rate, name the outlet or
the product group, and say what it means. Do not deflect a question you can
reasonably address from these rows.

On figures:
- An "EXACT TOTALS" section is provided. Every number in it was computed from
  the rows by the application and is correct. Quote those figures rather than
  adding anything up yourself whenever one covers what you were asked.
- Where no exact total covers it, work it out from the rows and say that you
  did, so the reader knows which figures came from where.
- Write rupee amounts in Indian digit grouping, e.g. ₹1,49,818.
- Never add minutes to rupees, or kilometres to units. The six tables measure
  different things and only combine in a rate, like rupees per visit.

On honesty:
- Use only the rows you are given. Do not import outside knowledge about these
  outlets, products, cities or the market.
- This is ONE person. There is nothing before January of this calendar year (so
  no year-on-year comparison), no target, no stock position and no competitor
  data. If the question needs one of those, say so in one line, then answer the
  closest thing the data DOES support and label it as a proxy — for example, a
  question about losing customers can be answered with outlets that bought in
  earlier months but not recently (see "last bought" in the year section), or
  that were visited without buying.
- A month marked as still in progress has partial figures; do not call it a
  decline.
- State your assumptions where a question is open to reading more than one way.
- If a figure is weak because it rests on very few rows, say so.

Format: short markdown. Lead with the answer in one or two sentences, then the
supporting figures as a short list or table, then one line on what to do about
it. Use **bold** for key figures. Keep it under 250 words unless the question
genuinely needs more.
"""

ANALYST_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "answer": {
            "type": "STRING",
            "description": "The analysis, as short markdown. Leads with the answer.",
        },
        "usedExactTotals": {
            "type": "BOOLEAN",
            "description": "True if every figure quoted came from the EXACT TOTALS section; "
                           "false if any figure was worked out from the rows.",
        },
        "caveat": {
            "type": "STRING",
            "description": "One short line naming anything the data could not support, or "
                           "any assumption made. Empty if there is none.",
        },
    },
    "required": ["answer"],
}


def _inr(n: float) -> str:
    """Indian digit grouping: 446709 -> 4,46,709.

    Written the way the rest of the app writes money, so a figure the model
    quotes from EXACT TOTALS matches the Overview tab character for character
    and a reader can see at a glance that the two agree.
    """
    neg, n = n < 0, abs(round(n))
    s = str(int(n))
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        s = ",".join(parts) + "," + tail
    return ("-" if neg else "") + s


def _fmt_breakdown(pairs: List[tuple], unit: str, limit: int = 20) -> List[str]:
    out = []
    for label, total, n in pairs[:limit]:
        if unit == "count":
            out.append(f"    {label}: {n}")
        else:
            out.append(f"    {label}: {unit}{_inr(total)} across {n} row(s)")
    if len(pairs) > limit:
        out.append(f"    ...and {len(pairs) - limit} more")
    return out


def build_analyst_prompt(payload: dict, question: str) -> str:
    e = payload["exact"]
    L: List[str] = [
        f"Salesperson: {payload['person']}",
        f"Month on screen: {payload['periodFrom']} to {payload['periodTo']} "
        f"({month_name(str(payload['periodFrom'])[:7])}).",
        "",
        "=== MONTH ON SCREEN — EXACT TOTALS (computed from the rows by the application "
        "— quote these) ===",
        "",
        f"SALES: ₹{_inr(e['sales']['value_rs'])} total, {e['sales']['qty']:,.0f} units, "
        f"{e['sales']['lines']} sale lines",
        "  by outlet:", *_fmt_breakdown(e["sales"]["by_outlet"], "₹"),
        "  by product group:", *_fmt_breakdown(e["sales"]["by_product_group"], "₹"),
        "  by product category:", *_fmt_breakdown(e["sales"]["by_category"], "₹"),
        "  by item:", *_fmt_items(e["sales"]["by_item"], 60),
        "  by city:", *_fmt_breakdown(e["sales"]["by_city"], "₹"),
        "",
        f"VISITS: {e['visits']['lines']} visits, {_inr(e['visits']['minutes'])} minutes total",
        "  by outlet:", *_fmt_breakdown(e["visits"]["by_outlet"], "count"),
        "  by visit type:", *_fmt_breakdown(e["visits"]["by_visit_type"], "count"),
        "  by city:", *_fmt_breakdown(e["visits"]["by_city"], "count"),
        "  by channel:", *_fmt_breakdown(e["visits"]["by_channel"], "count"),
        "",
        f"DEMOS: {e['demos']['lines']} demos, {e['demos']['converted']} converted, "
        f"₹{_inr(e['demos']['est_value_rs'])} estimated value",
        "  by stage:", *_fmt_breakdown(e["demos"]["by_stage"], "₹"),
        "  by status:", *_fmt_breakdown(e["demos"]["by_status"], "₹"),
        "",
        f"LEADS: {e['leads']['lines']} leads, ₹{_inr(e['leads']['est_value_rs'])} estimated value",
        "  by stage:", *_fmt_breakdown(e["leads"]["by_stage"], "₹"),
        "  by status:", *_fmt_breakdown(e["leads"]["by_status"], "₹"),
        "",
        f"TRAVEL: {_inr(e['travel']['total_km'])} km total, "
        f"{_inr(e['travel']['working_km'])} working km, over {e['travel']['days']} day(s)",
        f"EXPENSES: ₹{_inr(e['expenses']['amount_rs'])} across {e['expenses']['claims']} claim(s)",
        "  by region:", *_fmt_breakdown(e["expenses"]["by_region"], "₹"),
        "",
        "=== MONTH ON SCREEN — ROWS (day is the day of the month, 1-31) ===",
    ]

    for kind in DATASETS:
        t = payload["tables"][kind]
        if not t["lines"]:
            L += ["", f"{kind.upper()}: no rows."]
            continue
        L += ["", f"{kind.upper()} — {t['columns']}"]
        L += ["  " + ln for ln in t["lines"]]
        if t["dropped"]:
            L.append(f"  (earliest {t['dropped']} row(s) omitted for length; "
                     f"the EXACT TOTALS above still cover all of them)")

    if payload.get("year"):
        L += _year_lines(payload["year"])

    L += ["", "=== QUESTION ===", question]
    return "\n".join(L)


# ---------------------------------------------------------------------- schema
SPEC_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "dataset": {
            "type": "STRING", "enum": list(DATASETS),
            "description": "Which table the question is about. sales = secondary sales "
                           "(rupees and units sold through outlets); visits = field "
                           "calls; demos = product demonstrations; leads = pipeline "
                           "enquiries; travel = kilometres; expenses = claims.",
        },
        "metric": {
            "type": "STRING", "enum": list(METRICS),
            "description": "What to total: 'value' for rupees, 'quantity' for units "
                           "sold, 'minutes' for visit duration, 'km' for distance "
                           "travelled, 'workKm' for working distance, 'count' to count "
                           "rows. Omit to use the table's natural measure.",
        },
        "customers": {
            "type": "ARRAY",
            "description": "Outlet or customer names, copied EXACTLY from the provided "
                           "list. Omit if the question names none.",
            "items": {"type": "STRING"},
        },
        "city": {"type": "STRING", "description": "Exactly one city from the provided list."},
        "channel": {"type": "STRING", "description": "Exactly one channel from the provided list."},
        "visitType": {"type": "STRING", "description": "Exactly one visit type from the provided list."},
        "region": {"type": "STRING", "description": "Exactly one region from the provided list."},
        "stage": {"type": "STRING", "description": "Exactly one stage from the provided list "
                                                   "for the chosen table."},
        "status": {"type": "STRING", "description": "Exactly one status from the provided list."},
        "leadType": {"type": "STRING", "description": "Exactly one lead type from the provided list."},
        "productGroup": {"type": "STRING", "description": "Exactly one product group from the provided list."},
        "item": {"type": "STRING", "description": "Exactly one item (product name) from the provided list."},
        "productCategory": {"type": "STRING",
                            "description": "Exactly one product category from the provided list."},
        "converted": {"type": "BOOLEAN",
                      "description": "Demos only. True for converted demos, false for "
                                     "demos not converted."},
        "dayFrom": {"type": "INTEGER", "description": "Day of month the question starts at, 1-31."},
        "dayTo": {"type": "INTEGER", "description": "Day of month the question ends at, 1-31."},
        "groupBy": {
            "type": "STRING",
            "enum": ["customer", "city", "channel", "visitType", "region", "stage",
                     "status", "leadType", "productGroup", "item", "productCategory", "day"],
            "description": "Break the answer down by this. Use it for 'which/by/per/top' "
                           "questions.",
        },
        "sort": {"type": "STRING", "enum": list(SORTS)},
        "topN": {"type": "INTEGER", "description": "Explicit 'top N' / 'bottom N' count only."},
        "countOnly": {"type": "BOOLEAN", "description": "True for 'how many' questions."},
        "superlative": {"type": "BOOLEAN",
                        "description": "True when the question asks for a single record "
                                       "('my biggest outlet', 'my busiest day')."},
        "unsupported": {
            "type": "STRING",
            "description": "If part of the question cannot be expressed in these fields, "
                           "describe that part in a short phrase. Empty otherwise.",
        },
        "refusal": {
            "type": "STRING",
            "description": "If the question cannot be answered from this activity data at "
                           "all (targets, incentives, stock, primary sales, receivables, "
                           "other people, other months, anything outside these six "
                           "tables), explain briefly why in one sentence. Empty otherwise.",
        },
    },
    "required": ["dataset"],
}


# ---------------------------------------------------------------------- prompt
SYSTEM = """\
You translate a question about ONE person's field-sales activity for ONE month into
a JSON filter specification. You are a translator, not an analyst.

Hard rules:
- NEVER compute, estimate or state any amount, count, quantity, distance or total.
  The application computes every number from the real rows using your filter.
- Pick exactly one `dataset`. The tables are separate and are never combined: a
  question that needs two of them at once cannot be answered, so say so in
  `unsupported` and pick the table the question leads with.
- Only ever use customer, city, channel, visit type, region, stage, status, lead
  type, product group, product category and item values copied exactly from the
  lists you are given. If a
  value the question names is not in the list, leave that field empty and say so
  in `unsupported`.
- The data covers ONE person and ONE calendar month. It has NO targets, NO
  incentives, NO stock, NO primary sales, NO receivables, NO other months and NO
  other people. If a question needs any of those, put a one-sentence explanation
  in `refusal` and leave the filters empty.
- Omit any field the question does not constrain. Do not guess.
- Set `groupBy` whenever the question asks which customer, city, product group,
  product category, item, visit type, channel, region, stage, status or day — that
  is what turns a single total into a ranked breakdown. "Product", "item" and
  "SKU" mean item; "category" means product category.
- Set `superlative` for a question about one record ("my biggest outlet"), and
  `topN` only when the question names an explicit count.
"""


def _listing(label: str, values: List[str]) -> str:
    return f"{label}: {', '.join(values) if values else '(none)'}"


def build_prompt(ctx: dict, question: str) -> str:
    c = ctx["counts"]
    lines = [
        f"Person: {ctx['person']}",
        f"Period: {ctx['periodFrom']} to {ctx['periodTo']} (one calendar month; "
        f"days are 1-31 within it).",
        "",
        "Rows this person has, by table:",
        f"  sales: {c['sales']} (outlet, item, product category, product group, city, "
        f"quantity, value)",
        f"  visits: {c['visits']} (outlet, visit type, city, channel, duration in minutes)",
        f"  demos: {c['demos']} (customer, region, stage, status, converted yes/no, value)",
        f"  leads: {c['leads']} (company, city, stage, status, lead type, value)",
        f"  travel: {c['travel']} (working km, total km, per day)",
        f"  expenses: {c['expenses']} (region, amount)",
        "",
        _listing("Cities", ctx["cities"]),
        _listing("Channels", ctx["channels"]),
        _listing("Visit types", ctx["visitTypes"]),
        _listing("Product groups", ctx["productGroups"]),
        _listing("Product categories", ctx["productCategories"]),
        _listing("Items", ctx["items"]),
        _listing("Regions", ctx["regions"]),
        _listing("Demo stages", ctx["demoStages"]),
        _listing("Lead stages", ctx["leadStages"]),
        _listing("Statuses", ctx["statuses"]),
        _listing("Lead types", ctx["leadTypes"]),
        "",
        "Customers and outlets for this person (use these names exactly):",
    ]
    lines += [f"  - {n}" for n in ctx["customerNames"]] or ["  (none)"]
    lines += ["", f"Question: {question}"]
    return "\n".join(lines)


# ------------------------------------------------------------------ validation
def _clean_int(v: Any, lo: int, hi: int) -> Optional[int]:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    n = int(v)
    return n if lo <= n <= hi else None


def _pool_index(pools: dict, name: str, value: Any, allowed: List[str]) -> Optional[int]:
    """Pool position for a label, but only if this person actually has it.

    `allowed` is the list the model was shown, so a label that exists somewhere
    in the dataset but not on this person's rows is rejected the same way an
    invented one is.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    want = value.strip().lower()
    if want not in {a.lower() for a in allowed}:
        return None
    pool = pools.get(name)
    if not isinstance(pool, list):
        return None
    for i, label in enumerate(pool):
        if isinstance(label, str) and label.lower() == want:
            return i
    return None


def validate_spec(raw: dict, ctx: dict) -> dict:
    """Reduce the model's output to values this person's rows can honour.

    Anything unrecognised is dropped silently — the query then covers more than
    was asked, which the page flags, rather than filtering on a value that does
    not exist and reporting a confident zero.
    """
    pools = ctx["_pools"]
    spec: Dict[str, Any] = {}

    dataset = raw.get("dataset")
    if dataset not in DATASETS:
        # The schema requires it, so an absent or unknown table means the model
        # did not place the question at all. Sales is assumed so the rest of the
        # spec still validates, but the flag lets the caller prefer the built-in
        # parser over a confident answer about a table nobody chose.
        dataset = "sales"
        spec["guessedDataset"] = True
    spec["dataset"] = dataset
    shape = FIELDS[dataset]

    metric = raw.get("metric")
    if metric not in shape["metrics"]:
        metric = shape["default_metric"]
    spec["metric"] = metric

    # ---- customers, resolved to pool indices so the browser never re-matches text
    names = raw.get("customers")
    if "customers" in shape["filters"] and isinstance(names, list) and names:
        wanted = {str(n).strip().lower() for n in names if isinstance(n, str)}
        on_book = {n.lower() for n in ctx["customerNames"]}
        pool = pools.get("buyer") or []
        ids = [i for i, label in enumerate(pool)
               if isinstance(label, str) and label.lower() in wanted
               and label.lower() in on_book]
        if ids:
            spec["buyerIds"] = sorted(ids)
            spec["buyerNames"] = [pool[i] for i in spec["buyerIds"]]

    # ---- single-value pool filters
    allowed_for = {
        "city": ctx["cities"], "channel": ctx["channels"],
        "visitType": ctx["visitTypes"], "region": ctx["regions"],
        "status": ctx["statuses"], "leadType": ctx["leadTypes"],
        "productGroup": ctx["productGroups"],
        "item": ctx["items"], "productCategory": ctx["productCategories"],
    }
    for field, pool_name in POOL_OF.items():
        if field not in shape["filters"]:
            continue
        ix = _pool_index(pools, pool_name, raw.get(field), allowed_for[field])
        if ix is not None:
            spec[field] = {"ix": ix, "label": pools[pool_name][ix]}

    # `stage` reads a different pool depending on the table.
    if "stage" in shape["filters"]:
        pool_name = "stage" if dataset == "demos" else "lstage"
        allowed = ctx["demoStages"] if dataset == "demos" else ctx["leadStages"]
        ix = _pool_index(pools, pool_name, raw.get("stage"), allowed)
        if ix is not None:
            spec["stage"] = {"ix": ix, "label": pools[pool_name][ix]}

    if "converted" in shape["filters"] and isinstance(raw.get("converted"), bool):
        spec["converted"] = raw["converted"]

    day_from = _clean_int(raw.get("dayFrom"), 1, 31)
    day_to = _clean_int(raw.get("dayTo"), 1, 31)
    if day_from is not None and day_to is not None and day_from > day_to:
        day_from, day_to = day_to, day_from
    if day_from is not None:
        spec["dayFrom"] = day_from
    if day_to is not None:
        spec["dayTo"] = day_to

    group_by = raw.get("groupBy")
    if group_by in shape["groups"]:
        spec["groupBy"] = group_by

    if raw.get("sort") in SORTS:
        spec["sort"] = raw["sort"]
    top_n = _clean_int(raw.get("topN"), 1, 500)
    if top_n:
        spec["topN"] = top_n
    if raw.get("countOnly") is True:
        spec["countOnly"] = True
    if raw.get("superlative") is True:
        spec["superlative"] = True
    # A superlative and an explicit count contradict each other; the explicit
    # count is the clearer instruction.
    if spec.get("topN") or spec.get("countOnly"):
        spec.pop("superlative", None)

    for key in ("unsupported", "refusal"):
        val = raw.get(key)
        if isinstance(val, str) and val.strip():
            spec[key] = val.strip()[:400]

    return spec


# Fields that actually narrow or shape the query. `dataset` and `metric` are
# always present, so they do not count as narrowing on their own; without any of
# these the question landed nowhere. Mirrors SEC_FILTER_KEYS in
# static/secondary.js.
NARROWING_KEYS = ("buyerIds", "city", "channel", "visitType", "region", "stage",
                  "status", "leadType", "productGroup", "item", "productCategory",
                  "converted",
                  "dayFrom", "dayTo", "groupBy", "sort", "topN", "countOnly",
                  "superlative")


def narrows(spec: dict) -> bool:
    return any(spec.get(k) not in (None, False, [], "", {}) for k in NARROWING_KEYS)