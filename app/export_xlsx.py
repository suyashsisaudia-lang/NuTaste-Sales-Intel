"""
Excel downloads of the two datasets, built from the same scoped payloads the
page receives — so a workbook never holds a row its reader could not already
see on screen.

    build_ar(ar, person, prepared_for)   -> .xlsx bytes: Summary + Full report
    build_sec(sec, person, prepared_for) -> .xlsx bytes: Summary + one sheet per table

`person` is a name from the scoped payload, or None for everyone in it ("All").
The positional row layouts are documented in importers/ar_excel.py and
importers/sec_excel.py.
"""

import datetime as dt
import io
import re
from typing import Any, Dict, List, Optional, Sequence

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

MONEY = '#,##0;[Red]-#,##0'
NUMBER = '#,##0'
DECIMAL = '#,##0.0'
DATE = 'dd-mmm-yyyy'

_HEAD_FONT = Font(bold=True, color="FFFFFF")
_HEAD_FILL = PatternFill("solid", fgColor="0C843A")      # the site's accent green
_TOTAL_FONT = Font(bold=True)
_TOTAL_FILL = PatternFill("solid", fgColor="E8F3EC")
_TITLE_FONT = Font(bold=True, size=14)


def safe_filename(*parts: str) -> str:
    """'NuTaste', 'Receivables', 'Asha Rao' -> 'NuTaste-Receivables-Asha-Rao'."""
    return "-".join(re.sub(r"[^A-Za-z0-9]+", "-", p).strip("-") for p in parts if p)


class _Sheet:
    """A table on one worksheet: header row, typed columns, frozen and filterable."""

    def __init__(self, wb: Workbook, title: str, columns: Sequence[tuple], first: bool = False,
                 start_row: int = 1):
        self.ws = wb.active if first else wb.create_sheet()
        self.ws.title = title
        self.columns = columns            # [(heading, width, number_format or None)]
        self.head_row = start_row
        self.row = start_row
        for c, (name, width, _) in enumerate(columns, 1):
            cell = self.ws.cell(self.row, c, name)
            cell.font, cell.fill = _HEAD_FONT, _HEAD_FILL
            cell.alignment = Alignment(vertical="center", wrap_text=True)
            self.ws.column_dimensions[get_column_letter(c)].width = width
        self.ws.freeze_panes = self.ws.cell(self.row + 1, 1)

    def add(self, values: Sequence[Any], total: bool = False) -> None:
        self.row += 1
        for c, v in enumerate(values, 1):
            cell = self.ws.cell(self.row, c, v)
            fmt = self.columns[c - 1][2]
            if fmt and v is not None and v != "":
                cell.number_format = fmt
            if total:
                cell.font, cell.fill = _TOTAL_FONT, _TOTAL_FILL

    def finish(self, filter_rows: bool = True) -> None:
        if filter_rows and self.row > self.head_row:
            last = get_column_letter(len(self.columns))
            self.ws.auto_filter.ref = f"A{self.head_row}:{last}{self.row}"


def _info(ws, rows: Sequence[tuple]) -> int:
    """Title block above a table. Returns the first free row after a gap."""
    ws.cell(1, 1, rows[0][0]).font = _TITLE_FONT
    for r, (label, value) in enumerate(rows[1:], 2):
        ws.cell(r, 1, label).font = Font(bold=True)
        ws.cell(r, 2, value)
    return len(rows) + 2


def _save(wb: Workbook) -> bytes:
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _iso(s: Any) -> Optional[dt.date]:
    try:
        return dt.date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def _person_ix(names: List[str], person: Optional[str]) -> Optional[int]:
    """Index of `person` in the scoped list; None for everyone. KeyError if unknown."""
    if not person:
        return None
    if person not in names:
        raise KeyError(person)
    return names.index(person)


# ------------------------------------------------------------------ receivables
def build_ar(ar: dict, person: Optional[str], prepared_for: str) -> bytes:
    names = ar.get("salespeople", [])
    only = _person_ix(names, person)
    labels = ar.get("bucketLabels", [])
    nb = len(labels)
    customers = ar.get("customers", [])
    report = _iso(ar.get("reportDate"))
    lines = [ln for ln in ar.get("lines", []) if only is None or ln[0] == only]

    wb = Workbook()

    # ---- Summary: one row per salesperson, ageing across the buckets
    start = _info(wb.active, [
        ("NuTaste — Receivables", None),
        ("Ageing as at", report.strftime("%d-%b-%Y") if report else ar.get("reportDate", "")),
        ("Salesperson", person or f"All · {len(names)} salespeople"),
        ("Prepared for", prepared_for),
        ("Downloaded", dt.datetime.now().strftime("%d-%b-%Y %H:%M")),
    ])
    summ = _Sheet(wb, "Summary", [("Salesperson", 30, None), ("Customers", 11, NUMBER),
                                  ("Invoices", 10, NUMBER), ("Original Amount", 16, MONEY),
                                  ("Balance", 16, MONEY)] +
                  [(lb, 14, MONEY) for lb in labels], first=True, start_row=start)
    per: Dict[int, dict] = {}
    for ln in lines:
        p = per.setdefault(ln[0], {"cust": set(), "n": 0, "orig": 0.0, "bal": 0.0, "b": [0.0] * nb})
        p["cust"].add(ln[1])
        p["n"] += 1
        p["orig"] += ln[5]
        p["bal"] += ln[6]
        for b in range(nb):
            p["b"][b] += ln[7 + b]
    for ix in sorted(per, key=lambda i: -per[i]["bal"]):
        p = per[ix]
        summ.add([names[ix], len(p["cust"]), p["n"], round(p["orig"], 2), round(p["bal"], 2)] +
                 [round(v, 2) for v in p["b"]])
    summ.finish()
    if len(per) > 1:
        summ.add(["Total", len({ln[1] for ln in lines}), len(lines),
                  round(sum(ln[5] for ln in lines), 2), round(sum(ln[6] for ln in lines), 2)] +
                 [round(sum(ln[7 + b] for ln in lines), 2) for b in range(nb)], total=True)

    # ---- Full report: every invoice line
    full = _Sheet(wb, "Full report", [
        ("Salesperson", 26, None), ("Customer No.", 13, None), ("Customer Name", 40, None),
        ("Zone", 12, None), ("Document No.", 20, None), ("Due Date", 13, DATE),
        ("Days Overdue", 10, NUMBER), ("Original Amount", 16, MONEY), ("Balance", 16, MONEY),
    ] + [(lb, 14, MONEY) for lb in labels])

    def order(ln):
        return (names[ln[0]].lower(), customers[ln[1]][1].lower(), ln[4] or "")

    for ln in sorted(lines, key=order):
        cust = customers[ln[1]]
        due = _iso(ln[4])
        overdue = max((report - due).days, 0) if (report and due) else None
        full.add([names[ln[0]], cust[0], cust[1], cust[2], ln[3], due, overdue,
                  ln[5], ln[6]] + list(ln[7:7 + nb]))
    full.finish()
    return _save(wb)


# ---------------------------------------------------------- secondary sales
# (sheet title, payload table, [(heading, width, format)], row -> values)
def _sec_tables(pool, day_of):
    return [
        ("Secondary Sales", "sales",
         [("Date", 13, DATE), ("Outlet", 38, None), ("Product Group", 20, None),
          ("Item", 34, None), ("Product Category", 20, None), ("City", 18, None),
          ("Qty", 10, DECIMAL), ("Value", 14, MONEY)],
         lambda r: [day_of(r[1]), pool("buyer", r[2]), pool("pgroup", r[3]),
                    pool("item", r[7] if len(r) > 7 else None),
                    pool("pcat", r[8] if len(r) > 8 else None),
                    pool("city", r[4]), r[5], r[6]]),
        ("Visits", "visits",
         [("Date", 13, DATE), ("Outlet", 38, None), ("Visit Type", 20, None),
          ("City", 18, None), ("Channel", 18, None), ("Duration (min)", 12, NUMBER)],
         lambda r: [day_of(r[1]), pool("buyer", r[5]), pool("vtype", r[2]),
                    pool("city", r[3]), pool("channel", r[4]), r[6]]),
        ("Demos", "demos",
         [("Date", 13, DATE), ("Customer", 38, None), ("Region", 16, None),
          ("Stage", 18, None), ("Status", 16, None), ("Converted", 11, None),
          ("Est. Value", 14, MONEY)],
         lambda r: [day_of(r[1]), pool("buyer", r[2]), pool("region", r[3]),
                    pool("stage", r[4]), pool("status", r[5]),
                    "Yes" if r[6] else "No", r[7]]),
        ("Leads", "leads",
         [("Date", 13, DATE), ("Company", 38, None), ("City", 18, None),
          ("Stage", 18, None), ("Status", 16, None), ("Lead Type", 16, None),
          ("Est. Value", 14, MONEY)],
         lambda r: [day_of(r[1]), pool("buyer", r[2]), pool("city", r[3]),
                    pool("lstage", r[4]), pool("status", r[5]), pool("ltype", r[6]), r[7]]),
        ("Travel", "travel",
         [("Date", 13, DATE), ("Working km", 12, DECIMAL), ("Total km", 12, DECIMAL)],
         lambda r: [day_of(r[1]), r[2], r[3]]),
        ("Expenses", "expenses",
         [("Date", 13, DATE), ("Region", 16, None), ("Amount", 14, MONEY)],
         lambda r: [day_of(r[1]), pool("region", r[2]), r[3]]),
    ]


def build_sec(sec: dict, person: Optional[str], prepared_for: str) -> bytes:
    names = sec.get("people", [])
    only = _person_ix(names, person)
    roster = sec.get("roster", {})
    pools = sec.get("pools", {})
    month_start = _iso(sec.get("periodFrom"))

    def pool(name: str, ix: Any) -> str:
        items = pools.get(name, [])
        return items[ix] if isinstance(ix, int) and 0 <= ix < len(items) else ""

    def day_of(d: Any) -> Optional[dt.date]:
        if not (month_start and d):
            return None
        return month_start.replace(day=int(d))

    rows = {t: [r for r in sec.get(t, []) if only is None or r[0] == only]
            for t in ("sales", "visits", "demos", "leads", "travel", "expenses")}

    wb = Workbook()
    start = _info(wb.active, [
        ("NuTaste — Secondary Sales", None),
        ("Month", month_start.strftime("%B %Y") if month_start else sec.get("periodFrom", "")),
        ("Person", person or f"All · {len(names)} people"),
        ("Prepared for", prepared_for),
        ("Downloaded", dt.datetime.now().strftime("%d-%b-%Y %H:%M")),
    ])

    # ---- Summary: one row per person, the month's totals for each table
    summ = _Sheet(wb, "Summary", [
        ("Person", 28, None), ("Employee ID", 12, None), ("Designation", 30, None),
        ("Region", 12, None), ("Status", 10, None),
        ("Sales Value", 14, MONEY), ("Sales Qty", 11, DECIMAL), ("Visits", 9, NUMBER),
        ("Visit Minutes", 11, NUMBER), ("Demos", 9, NUMBER), ("Demos Converted", 11, NUMBER),
        ("Leads", 9, NUMBER), ("Lead Value", 14, MONEY), ("Working km", 12, NUMBER),
        ("Total km", 12, NUMBER), ("Expenses", 13, MONEY),
    ], first=True, start_row=start)

    def totals(pick) -> list:
        sl, vi, de, le, tr, ex = (list(filter(pick, rows[t])) for t in
                                  ("sales", "visits", "demos", "leads", "travel", "expenses"))
        return [round(sum(r[6] for r in sl), 2), round(sum(r[5] for r in sl), 2), len(vi),
                sum(r[6] or 0 for r in vi), len(de), sum(1 for r in de if r[6]), len(le),
                round(sum(r[7] or 0 for r in le), 2), round(sum(r[2] for r in tr), 1),
                round(sum(r[3] for r in tr), 1), round(sum(r[3] for r in ex), 2)]

    people = [only] if only is not None else range(len(names))
    for ix in sorted(people, key=lambda i: names[i].lower()):
        info = roster.get(names[ix]) or {}
        summ.add([names[ix], info.get("id", ""), info.get("designation", ""),
                  info.get("region", ""), info.get("status", "")] +
                 totals(lambda r, ix=ix: r[0] == ix))
    summ.finish()
    if only is None and len(names) > 1:
        summ.add(["Total", "", "", "", ""] + totals(lambda r: True), total=True)

    # ---- one sheet per table, every row, person first
    for title, key, cols, values in _sec_tables(pool, day_of):
        sheet = _Sheet(wb, title, [("Person", 26, None)] + cols)
        for r in sorted(rows[key], key=lambda r: (names[r[0]].lower(), r[1])):
            sheet.add([names[r[0]]] + values(r))
        sheet.finish()
    return _save(wb)
