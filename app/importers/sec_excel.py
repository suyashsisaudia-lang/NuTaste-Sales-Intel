"""
Secondary Sales workbook -> the compact JSON the Sales Intelligence frontend expects.

The workbook holds several years of activity across nine sheets. One reporting
period is extracted at a time (default: the latest complete month present in
the sales sheet).

Name handling is the awkward part. The sheets disagree about how people are
named: the visit and travel exports use the full HR name ("Shrish Pratap
Singh"), while the sales sheet's FPR 1 column uses a short form ("Shiris
Pratap"). Rather than force-matching on spelling, aliases are resolved against
the employee roster and anything unresolved is reported back to the admin, so a
misspelling shows up as a warning instead of silently losing a person's sales.

Row encodings (positional, to keep the payload small):

    visits[i]   = [personIx, day, vtypeIx, cityIx, channelIx, buyerIx, minutes]
    demos[i]    = [personIx, day, buyerIx, regionIx, stageIx, statusIx, converted, value]
    leads[i]    = [personIx, day, buyerIx, cityIx, lstageIx, statusIx, ltypeIx, value]
    travel[i]   = [personIx, day, workingKm, totalKm]
    expenses[i] = [personIx, day, regionIx, amount]
    sales[i]    = [personIx, day, buyerIx, pgroupIx, cityIx, qty, value, itemIx, pcatIx]

The two item columns were added after the first five: files written before them
end at `value`, and readers treat a missing item or category as blank.
"""

import calendar
import datetime as dt
import io
import re
import unicodedata
from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional, Tuple

import openpyxl

SHEETS = {
    "sales": "Secondary sale",
    "visits": "Visit_report",
    "demos": "Demos",
    "leads": "Leads Header",
    "travel": "Travel",
    "expenses": "Expenses",
    "employees": "Channelier Employees",
}


# ------------------------------------------------------------------ utilities
def _clean(v: Any) -> str:
    if v is None:
        return ""
    s = unicodedata.normalize("NFKC", str(v)).strip()
    return re.sub(r"\s+", " ", s)


def _key(name: str) -> str:
    """Comparison key for a person's name: lowercase alphabetic tokens only."""
    return " ".join(sorted(re.findall(r"[a-z]+", _clean(name).lower())))


def _to_date(v: Any) -> Optional[dt.date]:
    if v is None or v == "":
        return None
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    s = str(v).strip()
    if s.startswith("0000"):
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%d-%m-%Y %H:%M:%S", "%d-%m-%Y",
                "%d/%m/%Y", "%Y/%m/%d"):
        try:
            return dt.datetime.strptime(s[:19] if " " in s else s[:10], fmt).date()
        except ValueError:
            continue
    return None


def _to_dt(v: Any) -> Optional[dt.datetime]:
    if isinstance(v, dt.datetime):
        return v
    s = str(v or "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return dt.datetime.strptime(s[:19], fmt)
        except ValueError:
            continue
    return None


def _num(v: Any) -> float:
    if v is None or v == "":
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace(",", "").replace("\u20b9", "").strip()
    try:
        return float(s)
    except ValueError:
        return 0.0

class Pool:
    """Deduplicating string table; rows store indices into it."""

    def __init__(self) -> None:
        self.items: List[str] = []
        self._ix: Dict[str, int] = {}

    def add(self, value: Any, blank: str = "\u2014") -> int:
        s = _clean(value) or blank
        if s not in self._ix:
            self._ix[s] = len(self.items)
            self.items.append(s)
        return self._ix[s]


def _headers(ws) -> Tuple[Dict[str, int], Any]:
    it = ws.iter_rows(values_only=True)
    header = list(next(it))
    ix = {}
    for i, h in enumerate(header):
        k = re.sub(r"[^a-z0-9]+", "", str(h or "").lower())
        if k and k not in ix:
            ix[k] = i
    return ix, it


def _get(row: Tuple, ix: Dict[str, int], *names: str) -> Any:
    for n in names:
        k = re.sub(r"[^a-z0-9]+", "", n.lower())
        if k in ix and ix[k] < len(row):
            return row[ix[k]]
    return None


# ------------------------------------------------------------------- main API
def _lead_date(row: Tuple, ix: Dict[str, int]) -> Optional[dt.date]:
    # A lead is counted in the month it was RAISED, using the split
    # year/month/day columns. follow_up_date is a forward-looking date
    # and would pull leads into a month they were not created in.
    yy, mm, dd = (_get(row, ix, "date_added_year"),
                  _get(row, ix, "date_added_month"),
                  _get(row, ix, "date_added_day"))
    try:
        return dt.date(int(yy), int(mm), int(dd))
    except (TypeError, ValueError):
        return _to_date(_get(row, ix, "follow_up_date"))


# sheet key -> function giving the date that places a row in a month
_DATE_OF = {
    "sales": lambda row, ix: _to_date(_get(row, ix, "Billing Date")),
    "visits": lambda row, ix: _to_date(_get(row, ix, "date")),
    "demos": lambda row, ix: _to_date(_get(row, ix, "Date Added")),
    "leads": _lead_date,
    "travel": lambda row, ix: _to_date(_get(row, ix, "Date")),
    "expenses": lambda row, ix: _to_date(_get(row, ix, "Period")),
}


def _parse(raw: bytes) -> Dict[str, Any]:
    """Read the workbook once: the roster, and every dated row grouped by month.

    Reading is the slow part (~20 s for the full workbook); building a month
    from the grouped rows is quick, so all months cost little more than one.
    """
    wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    if SHEETS["sales"] not in wb.sheetnames:
        raise ValueError(f"Sheet '{SHEETS['sales']}' not found. Sheets present: {wb.sheetnames}")

    roster: Dict[str, Dict[str, str]] = {}
    by_key: Dict[str, str] = {}
    if SHEETS["employees"] in wb.sheetnames:
        ix, it = _headers(wb[SHEETS["employees"]])
        for row in it:
            name = _clean(_get(row, ix, "Name"))
            if not name:
                continue
            roster[name] = {
                "id": _clean(_get(row, ix, "Employee ID")),
                "designation": _clean(_get(row, ix, "Designation")),
                "region": _clean(_get(row, ix, "Region")) or _clean(_get(row, ix, "Sub-Region")),
                "status": _clean(_get(row, ix, "Status")).lower() or "unknown",
            }
            by_key.setdefault(_key(name), name)

    # sheet key -> (header index, {(year, month): [(date, row), ...]})
    sheets: Dict[str, Tuple[Dict[str, int], Dict[Tuple[int, int], List]]] = {}
    for key, date_of in _DATE_OF.items():
        if SHEETS[key] not in wb.sheetnames:
            continue
        ix, it = _headers(wb[SHEETS[key]])
        grouped: Dict[Tuple[int, int], List] = defaultdict(list)
        for row in it:
            d = date_of(row, ix)
            if d:
                grouped[(d.year, d.month)].append((d, row))
        sheets[key] = (ix, grouped)
    wb.close()

    months = sorted(sheets["sales"][1])
    if not months:
        raise ValueError("No dated rows found in the secondary sales sheet.")
    return {"roster": roster, "by_key": by_key, "sheets": sheets, "months": months}


def convert(raw: bytes, period: Optional[str] = None) -> Dict[str, Any]:
    """
    period: 'YYYY-MM' to extract. Defaults to the latest month in the sales sheet.
    """
    parsed = _parse(raw)
    months = parsed["months"]
    if period:
        try:
            y, m = (int(x) for x in period.split("-")[:2])
        except ValueError:
            raise ValueError("Period must look like 2026-08.")
        if (y, m) not in months:
            have = ", ".join(f"{a}-{b:02d}" for a, b in months)
            raise ValueError(f"No sales rows for {period}. Periods available: {have}")
    else:
        y, m = months[-1]
    return _build(parsed, y, m)


def convert_all(raw: bytes) -> Dict[str, Dict[str, Any]]:
    """Every month that has sales rows, as {'YYYY-MM': dataset}, oldest first."""
    parsed = _parse(raw)
    return {f"{y}-{m:02d}": _build(parsed, y, m) for y, m in parsed["months"]}


def _build(parsed: Dict[str, Any], y: int, m: int) -> Dict[str, Any]:
    """One month's dataset from the grouped rows."""
    roster, by_key, sheets = parsed["roster"], parsed["by_key"], parsed["sheets"]

    def rows_of(key: str):
        """(header index, this month's rows) for one sheet; empty if absent."""
        if key not in sheets:
            return {}, []
        ix, grouped = sheets[key]
        return ix, grouped.get((y, m), [])

    people: List[str] = []
    people_ix: Dict[str, int] = {}
    alias_cache: Dict[str, Optional[int]] = {}
    unresolved: Counter = Counter()

    def person(raw_name: Any) -> Optional[int]:
        """Resolve a name from any sheet to a single index in `people`."""
        s = _clean(raw_name)
        if not s or s in ("0", "-"):
            return None
        if s in alias_cache:
            return alias_cache[s]

        canonical = by_key.get(_key(s))
        if canonical is None:
            # Short forms: match when every token of the shorter name appears
            # in the longer one (so "Shiris Pratap" reaches "Shrish Pratap Singh").
            toks = set(_key(s).split())
            best, best_score = None, 0
            for k, full in by_key.items():
                other = set(k.split())
                shared = toks & other
                if not shared:
                    continue
                score = len(shared) / max(1, min(len(toks), len(other)))
                if score >= 0.5 and score > best_score:
                    best, best_score = full, score
            canonical = best
        if canonical is None:
            canonical = s  # keep the person rather than dropping their rows
            unresolved[s] += 1

        if canonical not in people_ix:
            people_ix[canonical] = len(people)
            people.append(canonical)
        alias_cache[s] = people_ix[canonical]
        return alias_cache[s]

    first = dt.date(y, m, 1)
    last = dt.date(y, m, calendar.monthrange(y, m)[1])

    pools = {k: Pool() for k in
             ("vtype", "city", "channel", "buyer", "region", "stage", "status",
              "lstage", "ltype", "pgroup", "item", "pcat")}
    out: Dict[str, List] = {k: [] for k in
                            ("visits", "demos", "leads", "travel", "expenses", "sales")}

    # ------------------------------------------------------------- sales
    ix, rows = rows_of("sales")
    for d, row in rows:
        p = person(_get(row, ix, "FPR 1"))
        if p is None:
            continue
        out["sales"].append([
            p, d.day,
            pools["buyer"].add(_get(row, ix, "Original Buyer Name")),
            pools["pgroup"].add(_get(row, ix, "Product Group")),
            pools["city"].add(_get(row, ix, "City")),
            round(_num(_get(row, ix, "Qty")), 2),
            round(_num(_get(row, ix, "Total DB Selling Value")), 2),
            pools["item"].add(_get(row, ix, "Product Name")),
            pools["pcat"].add(_get(row, ix, "Product Cat")),
        ])

    # ------------------------------------------------------------ visits
    ix, rows = rows_of("visits")
    if rows:
        for d, row in rows:
            p = person(_get(row, ix, "employee_name"))
            if p is None:
                continue
            cin, cout = _to_dt(_get(row, ix, "checkin_at")), _to_dt(_get(row, ix, "checkout_at"))
            mins = 0
            if cin and cout and cout > cin:
                mins = int(round((cout - cin).total_seconds() / 60))
            out["visits"].append([
                p, d.day,
                pools["vtype"].add(_get(row, ix, "visit_type")),
                pools["city"].add(_get(row, ix, "buyer_city")),
                pools["channel"].add(_get(row, ix, "channel_name")),
                pools["buyer"].add(_get(row, ix, "buyer_name")),
                mins,
            ])

    # ------------------------------------------------------------- demos
    ix, rows = rows_of("demos")
    if rows:
        for d, row in rows:
            p = person(_get(row, ix, "employee_name"))
            if p is None:
                continue
            out["demos"].append([
                p, d.day,
                pools["buyer"].add(_get(row, ix, "Company Name")),
                pools["region"].add(_get(row, ix, "Sub-Region") or _get(row, ix, "Region")),
                pools["stage"].add(_get(row, ix, "Stage")),
                pools["status"].add(_get(row, ix, "Status")),
                1 if _clean(_get(row, ix, "Converted")).lower() in ("yes", "y", "true", "1") else 0,
                round(_num(_get(row, ix, "Estimated Value")), 2),
            ])

    # ------------------------------------------------------------- leads
    ix, rows = rows_of("leads")      # dated by _lead_date: the month it was raised
    if rows:
        for d, row in rows:
            p = person(_get(row, ix, "employee"))
            if p is None:
                continue
            out["leads"].append([
                p, d.day,
                pools["buyer"].add(_get(row, ix, "company_name")),
                pools["city"].add(_get(row, ix, "company_city")),
                pools["lstage"].add(_get(row, ix, "lead_stage")),
                pools["status"].add(_get(row, ix, "lead_status")),
                pools["ltype"].add(_get(row, ix, "lead_type")),
                round(_num(_get(row, ix, "lead_estimated_value")), 2),
            ])

    # ------------------------------------------------------------ travel
    ix, rows = rows_of("travel")
    if rows:
        for d, row in rows:
            p = person(_get(row, ix, "Employee Name"))
            if p is None:
                continue
            out["travel"].append([
                p, d.day,
                round(_num(_get(row, ix, "Working Distance (KM)")), 2),
                round(_num(_get(row, ix, "Total Distance (KM)")), 2),
            ])

    # ---------------------------------------------------------- expenses
    ix, rows = rows_of("expenses")
    if rows:
        for d, row in rows:
            p = person(_get(row, ix, "Employee"))
            if p is None:
                continue
            out["expenses"].append([
                p, d.day,
                pools["region"].add(_get(row, ix, "Region")),
                round(_num(_get(row, ix, "Amount")), 2),
            ])

    # Everyone enabled on the current employee list is listed every month, so a
    # person with no rows of their own (a manager whose name is only in the
    # supervisor / FPR 2 columns) gets a "No activity" page instead of vanishing.
    # Disabled accounts, and Channelier "Administrator" logins (back-office
    # users, not salespeople), appear only in months where they have activity.
    def enabled(name: str) -> bool:
        r = roster.get(name) or {}
        return r.get("status") == "enabled" and r.get("designation", "").lower() != "administrator"

    for name in roster:
        if enabled(name) and name not in people_ix:
            people_ix[name] = len(people)
            people.append(name)

    active = {r[0] for rows in out.values() for r in rows}
    keep = sorted(range(len(people)), key=lambda i: people[i].lower())
    remap = {}
    new_people = []
    for i in keep:
        if i in active or enabled(people[i]):
            remap[i] = len(new_people)
            new_people.append(people[i])
    for rows in out.values():
        for r in rows:
            r[0] = remap[r[0]]
        rows.sort(key=lambda r: (r[0], r[1]))

    return {
        "periodFrom": first.isoformat(),
        "periodTo": last.isoformat(),
        "people": new_people,
        "roster": {n: roster[n] for n in new_people if n in roster},
        "pools": {k: p.items for k, p in pools.items()},
        **out,
        "importNotes": {
            "period": f"{y}-{m:02d}",
            "periodsAvailable": [f"{a}-{b:02d}" for a, b in parsed["months"]],
            "unresolvedNames": [n for n, _ in unresolved.most_common(25)],
            "counts": {k: len(v) for k, v in out.items()},
        },
    }
