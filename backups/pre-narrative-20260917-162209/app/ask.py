"""
Question -> filter spec, for the receivables Ask box.

The model NEVER produces a number. It only decides which slice of the book the
question is about; `runQuery` in static/receivables.js then computes the answer
from the real invoice lines, exactly as it does for a typed question today.
That split is deliberate: a language model asked to add up a column will
sometimes be confidently wrong, and a wrong receivables figure is worse than no
answer at all.

Everything the model returns is validated against the live dataset here. A
zone, payment term or customer that does not exist is dropped rather than
passed through, so a hallucinated filter can at worst widen the query — it can
never invent a filter the data does not support.
"""
import re
from typing import Any, Dict, List, Optional, Tuple

# The most customers we will name in a prompt. A salesperson typically has
# 10-20; the cap stops one outlier rep from sending a huge prompt.
MAX_CUSTOMERS_IN_PROMPT = 120

SORTS = {"oldest", "newest", "largest", "smallest"}
GROUP_BYS = {"zone", "term", "customer"}
AGGREGATES = {"average", "percent"}


# --------------------------------------------------------------------- context
def _bucket_ranges(labels: List[str]) -> List[Tuple[Optional[int], Optional[int]]]:
    """Day range of each ageing bucket, read from its label.

    Derived rather than hardcoded so a future report with different buckets
    keeps working without a code change.
    """
    out: List[Tuple[Optional[int], Optional[int]]] = []
    for lab in labels:
        span = re.search(r"(\d+)\s*-\s*(\d+)", lab)
        after = re.search(r"(?:after|over|beyond|\+)\s*(\d+)", lab, re.I)
        if span:
            out.append((int(span.group(1)), int(span.group(2))))
        elif after:
            out.append((int(after.group(1)) + 1, 9999))
        else:
            out.append((None, None))  # "Not Due"
    return out


def build_context(ar: dict, sp_index: int) -> Optional[dict]:
    """Everything the model is told about this salesperson's book.

    Names only — no amounts, no due dates, no document numbers. The model needs
    to recognise which customer was meant; it never needs to know what they owe.
    """
    people = ar.get("salespeople") or []
    if not isinstance(sp_index, int) or not 0 <= sp_index < len(people):
        return None

    customers = ar.get("customers") or []
    labels = ar.get("bucketLabels") or []

    # Only the customers and zones this person actually has lines for. A rep
    # asking about "Sharma" should not be able to resolve it against another
    # rep's account.
    cust_ids = {ln[1] for ln in ar.get("lines", []) if ln[0] == sp_index}
    names, zones = [], set()
    for ci in sorted(cust_ids):
        if 0 <= ci < len(customers):
            names.append(customers[ci][1])
            if customers[ci][2]:
                zones.add(customers[ci][2])

    return {
        "salesperson": people[sp_index],
        "reportDate": ar.get("reportDate"),
        "bucketLabels": labels,
        "bucketRanges": _bucket_ranges(labels),
        "zones": sorted(zones),
        "terms": [t for t in (ar.get("terms") or []) if t and t.lower() != "not set"],
        "customerNames": sorted(names)[:MAX_CUSTOMERS_IN_PROMPT],
        "_customers": customers,   # kept for name -> id resolution, never prompted
        "_spIndex": sp_index,
        "_custIds": cust_ids,
    }


# ---------------------------------------------------------------------- schema
def spec_schema(n_buckets: int) -> dict:
    """Response schema handed to the model, in the OpenAPI subset it accepts."""
    return {
        "type": "OBJECT",
        "properties": {
            "buckets": {
                "type": "ARRAY",
                "description": f"Ageing bucket indices 0..{n_buckets - 1} the question is "
                               "about. 0 is not-due. Omit for the whole balance.",
                "items": {"type": "INTEGER"},
            },
            "customers": {
                "type": "ARRAY",
                "description": "Customer names, copied EXACTLY from the provided list. "
                               "Omit if the question is not about specific customers.",
                "items": {"type": "STRING"},
            },
            "zone": {"type": "STRING", "description": "Exactly one zone from the provided list."},
            "term": {"type": "STRING", "description": "Exactly one payment term from the provided list."},
            "sign": {"type": "STRING", "enum": ["neg"],
                     "description": "'neg' for credits, advances, refunds or negative balances only."},
            "sort": {"type": "STRING", "enum": sorted(SORTS)},
            "topN": {"type": "INTEGER", "description": "Explicit 'top N' / 'bottom N' count only."},
            "groupBy": {"type": "STRING", "enum": sorted(GROUP_BYS)},
            "countOnly": {"type": "BOOLEAN", "description": "True for 'how many' questions."},
            "superlative": {"type": "BOOLEAN",
                            "description": "True when the question asks for a single record "
                                           "('my oldest invoice'), not a total."},
            "aggregate": {"type": "STRING", "enum": sorted(AGGREGATES)},
            "amtMin": {"type": "NUMBER", "description": "Amount strictly greater than, in rupees."},
            "amtMax": {"type": "NUMBER", "description": "Amount strictly less than, in rupees."},
            "dueMonth": {"type": "INTEGER", "description": "Due in this month, 1-12."},
            "dueYear": {"type": "INTEGER", "description": "Due in this 4-digit year."},
            "dueBefore": {"type": "INTEGER", "description": "Due before the start of this month, 1-12."},
            "dueAfter": {"type": "INTEGER", "description": "Due from the start of this month onwards, 1-12."},
            "unsupported": {
                "type": "STRING",
                "description": "If part of the question cannot be expressed in these fields, "
                               "describe that part in a short phrase. Empty otherwise.",
            },
            "refusal": {
                "type": "STRING",
                "description": "If the question cannot be answered from an ageing snapshot at "
                               "all (payment history, sales targets, future forecasts, stock, "
                               "anything outside receivables), explain briefly why in one "
                               "sentence. Empty otherwise.",
            },
        },
    }


# ---------------------------------------------------------------------- prompt
SYSTEM = """\
You translate a salesperson's question about their accounts-receivable book into a
JSON filter specification. You are a translator, not an analyst.

Hard rules:
- NEVER compute, estimate or state any amount, count or total. The application
  computes every number from the real data using your filter.
- Only ever use zone, payment-term and customer values copied exactly from the
  lists you are given. If a customer the question names is not in the list, leave
  `customers` empty and say so in `unsupported`.
- The data is a single ageing SNAPSHOT as at the report date. It has due dates and
  ageing buckets. It has NO payment history, NO invoice posting dates, NO sales
  figures, NO targets, NO credit limits and NO future dates. If a question needs
  any of those, put a one-sentence explanation in `refusal` and leave the filters
  empty.
- Omit any field the question does not constrain. Do not guess.
- Set `superlative` for a question about one record ("my oldest invoice", "biggest
  customer"), and `topN` only when the question names an explicit count.
"""


def build_prompt(ctx: dict, question: str) -> str:
    lines = [
        f"Report date: {ctx['reportDate']} (all ageing is as at this date).",
        "",
        "Ageing buckets (index: label, days past due):",
    ]
    for i, (lab, rng) in enumerate(zip(ctx["bucketLabels"], ctx["bucketRanges"])):
        span = "not yet due" if rng[0] is None else f"{rng[0]}-{rng[1]} days past due"
        lines.append(f"  {i}: {lab} ({span})")

    lines += [
        "",
        f"Zones: {', '.join(ctx['zones']) or '(none)'}",
        f"Payment terms: {', '.join(ctx['terms']) or '(none)'}",
        "",
        "Customers on this salesperson's book (use these names exactly):",
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


def _clean_num(v: Any) -> Optional[float]:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)


def validate_spec(raw: dict, ctx: dict) -> dict:
    """Reduce the model's output to values this dataset can actually honour.

    Anything unrecognised is dropped silently — the query then covers more than
    was asked, which the frontend flags, rather than filtering on a value that
    does not exist and reporting a confident zero.
    """
    n_buckets = len(ctx["bucketLabels"])
    spec: Dict[str, Any] = {}

    buckets = raw.get("buckets")
    if isinstance(buckets, list):
        ok = sorted({b for b in (_clean_int(x, 0, n_buckets - 1) for x in buckets) if b is not None})
        if ok:
            spec["buckets"] = ok

    # Names are matched case-insensitively against this rep's own customers and
    # returned as dataset indices, so the frontend never re-matches loose text.
    names = raw.get("customers")
    if isinstance(names, list) and names:
        wanted = {str(n).strip().lower() for n in names if isinstance(n, str)}
        ids = [ci for ci in sorted(ctx["_custIds"])
               if 0 <= ci < len(ctx["_customers"])
               and ctx["_customers"][ci][1].strip().lower() in wanted]
        if ids:
            spec["custIds"] = ids

    zone = raw.get("zone")
    if isinstance(zone, str) and zone in ctx["zones"]:
        spec["zone"] = zone

    term = raw.get("term")
    if isinstance(term, str) and term in ctx["terms"]:
        spec["term"] = term
        # "30D" on its own would exclude "30D INV" and report a misleading zero,
        # so a bare code is treated as a family prefix — same rule the built-in
        # parser applies.
        family = [t for t in ctx["terms"]
                  if t == term or t.lower().startswith(term.lower() + " ")]
        if len(family) > 1:
            spec["termFamily"] = family

    if raw.get("sign") == "neg":
        spec["sign"] = "neg"
    if raw.get("sort") in SORTS:
        spec["sort"] = raw["sort"]
    if raw.get("groupBy") in GROUP_BYS:
        spec["groupBy"] = raw["groupBy"]
        spec["groupByCustomer"] = raw["groupBy"] == "customer"
    if raw.get("aggregate") in AGGREGATES:
        spec["aggregate"] = raw["aggregate"]
    if raw.get("countOnly") is True:
        spec["countOnly"] = True
    if raw.get("superlative") is True:
        spec["superlative"] = True

    top_n = _clean_int(raw.get("topN"), 1, 500)
    if top_n:
        spec["topN"] = top_n

    for key in ("amtMin", "amtMax"):
        val = _clean_num(raw.get(key))
        if val is not None:
            spec[key] = val
    # A reversed range would match nothing and read as "you have none of those".
    if spec.get("amtMin") is not None and spec.get("amtMax") is not None \
            and spec["amtMin"] > spec["amtMax"]:
        spec["amtMin"], spec["amtMax"] = spec["amtMax"], spec["amtMin"]

    for key, lo, hi in (("dueMonth", 1, 12), ("dueBefore", 1, 12),
                        ("dueAfter", 1, 12), ("dueYear", 2000, 2099)):
        val = _clean_int(raw.get(key), lo, hi)
        if val is not None:
            spec[key] = val

    for key in ("unsupported", "refusal"):
        val = raw.get(key)
        if isinstance(val, str) and val.strip():
            spec[key] = val.strip()[:400]

    # A superlative and an explicit count contradict each other; the explicit
    # count is the clearer instruction.
    if spec.get("topN") or spec.get("countOnly"):
        spec.pop("superlative", None)

    return spec
