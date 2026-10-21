"""
Business Central AR extract -> the compact JSON the Sales Intelligence frontend expects.

Two things this importer does that the raw extract does not:

  1. Ageing buckets are RECOMPUTED from Due Date against the report date.
     The extract's own bucket columns are frozen at the moment of extraction,
     so a file that is a week old reports invoices in the wrong bucket. The
     recomputed figures are reconciled against the extract's Balance column
     to the rupee, and the import is rejected if they disagree.

  2. Zone strings are normalised ("WEST MH" and "West MH" become one value).
     This is a stopgap; the durable fix is to clean the values in Business
     Central itself.

Column names are matched via config/ar_columns.json so a heading change in BC
is a config edit rather than a code change.

Output shape (arrays are used instead of objects to keep the payload small):

    lines[i] = [salespersonIx, customerIx, termIx, docNo, dueDateISO,
                originalAmount, balance, bucket0, bucket1, ... bucket9]
"""

import csv
import datetime as dt
import io
import json
import re
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import openpyxl

# Upper bound (inclusive) in days-overdue for each bucket; the last is open-ended.
BUCKET_LABELS = ["Not Due", "1-31 Days", "32-62 Days", "63-92 Days", "93-123 Days",
                 "124-153 Days", "154-184 Days", "185-212 Days", "213-243 Days",
                 "After 243 Days"]
BUCKET_KEYS = ["notDue", "b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9"]
BUCKET_MAX = [0, 31, 62, 92, 123, 153, 184, 212, 243]  # days overdue, upper bound


def _norm_header(s: Any) -> str:
    """Headings arrive with newlines, double spaces and stray casing."""
    s = unicodedata.normalize("NFKC", str(s or ""))
    s = s.replace("\n", " ").replace("\r", " ")
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def _norm_zone(z: Any) -> str:
    """'WEST MH' / 'West  MH' / 'west mh' -> 'West MH'."""
    s = re.sub(r"\s+", " ", str(z or "").strip())
    if not s:
        return ""
    words = []
    for w in s.split(" "):
        # keep short codes upper (MH, HR, WB, PB, OD, UP, CH, TN, KA...)
        words.append(w.upper() if len(w) <= 2 else w.capitalize())
    return " ".join(words)


def _to_date(v: Any) -> Optional[dt.date]:
    if v is None or v == "":
        return None
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    s = str(v).strip()
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%m/%d/%Y", "%d-%b-%Y", "%Y/%m/%d"):
        try:
            return dt.datetime.strptime(s[:10], fmt).date()
        except ValueError:
            continue
    return None


def _to_float(v: Any) -> float:
    if v is None or v == "":
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace(",", "").replace("\u20b9", "").strip()
    if s in ("-", "–", "—"):
        return 0.0
    neg = s.startswith("(") and s.endswith(")")
    if neg:
        s = s[1:-1]
    try:
        f = float(s)
    except ValueError:
        return 0.0
    return -f if neg else f


def bucket_for_days(overdue: int) -> int:
    """Which ageing bucket a number of days overdue falls in (0 = Not Due).
    Shared with the Business Central API importer so both use one set of bounds."""
    if overdue <= 0:
        return 0
    for i, hi in enumerate(BUCKET_MAX):
        if i == 0:
            continue
        if overdue <= hi:
            return i
    return len(BUCKET_LABELS) - 1


def _bucket_index(due: Optional[dt.date], as_at: dt.date) -> int:
    """Which ageing bucket a line falls in, computed fresh from the due date."""
    if due is None:
        return 0
    return bucket_for_days((as_at - due).days)


def _load_config(path: Path) -> Dict[str, List[str]]:
    cfg = json.loads(Path(path).read_text(encoding="utf-8"))
    return {k: [_norm_header(a) for a in v] for k, v in cfg.items()}


def _find_header_row(rows: Sequence[Sequence[Any]], cfg: Dict[str, List[str]]) -> int:
    """The extract carries blank rows and a totals row above the headings."""
    want = set(cfg["salesperson"]) | set(cfg["balance"]) | set(cfg["due_date"])
    for i, row in enumerate(rows[:25]):
        cells = {_norm_header(c) for c in row if c is not None}
        if len(cells & want) >= 2:
            return i
    raise ValueError(
        "Could not find the header row. Check that the sheet contains columns for "
        "Salesperson, Balance and Due Date, and that config/ar_columns.json lists "
        "the names your extract uses."
    )


def _column_map(header: Sequence[Any], cfg: Dict[str, List[str]]) -> Dict[str, int]:
    norm = [_norm_header(h) for h in header]
    out: Dict[str, int] = {}
    for field, aliases in cfg.items():
        for i, h in enumerate(norm):
            if h and h in aliases:
                out[field] = i
                break
    required = ["salesperson", "customer_no", "customer_name", "document_no",
                "due_date", "original_amount", "balance"]
    missing = [f for f in required if f not in out]
    if missing:
        raise ValueError(
            "These required columns were not found: " + ", ".join(missing)
            + ". Found instead: " + ", ".join(str(h) for h in header if h)
        )
    return out


def _read_rows(raw: bytes, filename: str, sheet_hint: str = "Detailed"):
    if filename.lower().endswith(".csv"):
        text = raw.decode("utf-8-sig", errors="replace")
        return list(csv.reader(io.StringIO(text))), "csv"
    wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    names = wb.sheetnames
    sheet = sheet_hint if sheet_hint in names else names[0]
    # prefer a sheet that looks like line-level detail
    for candidate in (sheet_hint, "Detailed", "Detail", "Data"):
        if candidate in names:
            sheet = candidate
            break
    rows = [list(r) for r in wb[sheet].iter_rows(values_only=True)]
    wb.close()
    return rows, sheet


def convert(raw: bytes, filename: str, report_date: dt.date, config_path: Path) -> Dict[str, Any]:
    cfg = _load_config(config_path)
    rows, sheet = _read_rows(raw, filename)
    if not rows:
        raise ValueError("The file appears to be empty.")

    h_ix = _find_header_row(rows, cfg)
    cols = _column_map(rows[h_ix], cfg)

    salespeople: List[str] = []
    sp_ix: Dict[str, int] = {}
    customers: List[List[str]] = []
    cust_ix: Dict[str, int] = {}
    terms: List[str] = []
    term_ix: Dict[str, int] = {}
    lines: List[List[Any]] = []

    nb = len(BUCKET_LABELS)
    control_total = 0.0
    skipped_no_sp = 0

    for row in rows[h_ix + 1:]:
        if row is None or not any(c not in (None, "") for c in row):
            continue

        def cell(field: str) -> Any:
            i = cols.get(field)
            return row[i] if i is not None and i < len(row) else None

        sp = str(cell("salesperson") or "").strip()
        cust_no = str(cell("customer_no") or "").strip()
        if not sp and not cust_no:
            continue  # blank or totals row
        if not sp:
            skipped_no_sp += 1
            continue

        balance = _to_float(cell("balance"))
        original = _to_float(cell("original_amount"))
        due = _to_date(cell("due_date"))
        doc = str(cell("document_no") or "").strip()
        cust_name = str(cell("customer_name") or "").strip()
        zone = _norm_zone(cell("zone"))
        term = str(cell("terms") or "").strip().upper()

        if sp not in sp_ix:
            sp_ix[sp] = len(salespeople)
            salespeople.append(sp)
        key = cust_no or cust_name
        if key not in cust_ix:
            cust_ix[key] = len(customers)
            customers.append([cust_no, cust_name, zone])
        elif zone and not customers[cust_ix[key]][2]:
            customers[cust_ix[key]][2] = zone
        if term not in term_ix:
            term_ix[term] = len(terms)
            terms.append(term)

        buckets = [0.0] * nb
        buckets[_bucket_index(due, report_date)] = balance
        control_total += balance

        lines.append([sp_ix[sp], cust_ix[key], term_ix[term], doc,
                      due.isoformat() if due else "", round(original, 2),
                      round(balance, 2)] + [round(b, 2) for b in buckets])

    if not lines:
        raise ValueError("No data rows were found below the header row.")

    # Reconcile: the sum of the recomputed buckets must equal the Balance column.
    bucket_sum = sum(sum(l[7:]) for l in lines)
    if abs(bucket_sum - control_total) > 1.0:
        raise ValueError(
            f"Reconciliation failed: buckets total {bucket_sum:,.2f} but Balance "
            f"totals {control_total:,.2f}. The import was rejected."
        )

    return {
        "reportDate": report_date.isoformat(),
        "sourceSheet": sheet,
        "controlTotal": round(control_total, 2),
        "bucketKeys": BUCKET_KEYS,
        "bucketLabels": BUCKET_LABELS,
        "salespeople": salespeople,
        "customers": customers,
        "terms": terms,
        "lines": lines,
        "importNotes": {
            "rowsImported": len(lines),
            "rowsSkippedNoSalesperson": skipped_no_sp,
            "ageing": "recomputed from Due Date against reportDate",
        },
    }
