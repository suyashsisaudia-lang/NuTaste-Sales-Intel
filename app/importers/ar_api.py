"""
Business Central AgedReceivables OData records -> the same compact JSON that
importers/ar_excel.py produces, so the frontend shows API data exactly as it
shows an uploaded extract.

The one difference from the Excel path is where the ageing comes from. The API
does not carry bucket columns; it carries the total days overdue for each line,
already computed by Business Central. Each line is placed in a bucket by that
figure (33 days -> "32-62 Days"), using the same bucket bounds as the Excel
importer.

Only fields the API actually returns are used. Field names are matched through
config/ar_columns.json, ignoring case, spaces and punctuation, so the OData
name "Remaining_Amount" matches the alias "Remaining Amount". Optional fields
the API does not have (zone, payment terms, due date, original amount) are left
blank rather than guessed.
"""

import datetime as dt
import json
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from .ar_excel import (BUCKET_KEYS, BUCKET_LABELS, _norm_header, _norm_zone,
                       _to_date, _to_float, bucket_for_days)

REQUIRED = ["salesperson", "document_no", "balance", "overdue_days"]


def _load_aliases(path: Path) -> Dict[str, List[str]]:
    """Alias lists in file order; the first alias a record has wins."""
    cfg = json.loads(Path(path).read_text(encoding="utf-8"))
    return {k: [_norm_header(a) for a in v] for k, v in cfg.items()}


def map_fields(field_names: Iterable[str], config_path: Path) -> Dict[str, str]:
    """{our field: API field name} for every configured field the API has."""
    by_norm: Dict[str, str] = {}
    for name in field_names:
        if not name.startswith("@"):            # @odata.etag and friends
            by_norm.setdefault(_norm_header(name), name)
    out: Dict[str, str] = {}
    for field, aliases in _load_aliases(config_path).items():
        for alias in aliases:
            if alias in by_norm:
                out[field] = by_norm[alias]
                break
    return out


def _check_required(fields: Dict[str, str], found: Iterable[str]) -> None:
    missing = [f for f in REQUIRED if f not in fields]
    if "customer_no" not in fields and "customer_name" not in fields:
        missing.append("customer_no or customer_name")
    if missing:
        raise ValueError(
            "The API response is missing these fields: " + ", ".join(missing)
            + ". It returned: " + ", ".join(sorted(n for n in found if not n.startswith("@")))
            + ". Add the API's name to config/ar_columns.json if a field is only named differently."
        )


def convert(records: List[Dict[str, Any]], report_date: dt.date,
            config_path: Path) -> Dict[str, Any]:
    if not records:
        raise ValueError("The API returned no records.")

    seen = {k for r in records[:50] for k in r}
    fields = map_fields(seen, config_path)
    _check_required(fields, seen)

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
    skipped_zero = 0

    for rec in records:
        def get(field: str) -> Any:
            name = fields.get(field)
            return rec.get(name) if name else None

        sp = str(get("salesperson") or "").strip()
        cust_no = str(get("customer_no") or "").strip()
        cust_name = str(get("customer_name") or "").strip()
        if not sp and not (cust_no or cust_name):
            continue
        if not sp:
            skipped_no_sp += 1
            continue

        balance = _to_float(get("balance"))
        if balance == 0:
            skipped_zero += 1                   # fully settled; no bucket to show
            continue
        original = _to_float(get("original_amount"))
        due: Optional[dt.date] = _to_date(get("due_date"))
        overdue = int(round(_to_float(get("overdue_days"))))
        doc = str(get("document_no") or "").strip()
        zone = _norm_zone(get("zone"))
        term = str(get("terms") or "").strip().upper()

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
        buckets[bucket_for_days(overdue)] = balance
        control_total += balance

        lines.append([sp_ix[sp], cust_ix[key], term_ix[term], doc,
                      due.isoformat() if due else "", round(original, 2),
                      round(balance, 2)] + [round(b, 2) for b in buckets])

    if not lines:
        raise ValueError("The API returned records, but none had a salesperson and a non-zero balance.")

    bucket_sum = sum(sum(l[7:]) for l in lines)
    if abs(bucket_sum - control_total) > 1.0:
        raise ValueError(
            f"Reconciliation failed: buckets total {bucket_sum:,.2f} but Balance "
            f"totals {control_total:,.2f}. The import was rejected."
        )

    return {
        "reportDate": report_date.isoformat(),
        "sourceSheet": "Business Central API (AgedReceivables)",
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
            "rowsSkippedZeroBalance": skipped_zero,
            "ageing": "bucketed from the API's total overdue days",
            "fieldMap": fields,
        },
    }
