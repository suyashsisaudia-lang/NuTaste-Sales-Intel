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

# The "All" entry in the name picker: every salesperson the viewer can see,
# taken together. The dataset passed in is already scoped to the viewer, so
# "all" never reaches beyond what the page itself shows.
ALL_PEOPLE = -1


def _valid_person(people: list, sp_index: Any) -> bool:
    return isinstance(sp_index, int) and (
        (sp_index == ALL_PEOPLE and len(people) > 0) or 0 <= sp_index < len(people))


def _person_label(people: list, sp_index: int) -> str:
    if sp_index == ALL_PEOPLE:
        return f"All - combined book of {len(people)} salespeople"
    return people[sp_index]


def _is_theirs(ln: list, sp_index: int) -> bool:
    return sp_index == ALL_PEOPLE or ln[0] == sp_index
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
    if not _valid_person(people, sp_index):
        return None

    customers = ar.get("customers") or []
    labels = ar.get("bucketLabels") or []

    # Only the customers and zones this person actually has lines for. A rep
    # asking about "Sharma" should not be able to resolve it against another
    # rep's account.
    cust_ids = {ln[1] for ln in ar.get("lines", []) if _is_theirs(ln, sp_index)}
    names, zones = [], set()
    for ci in sorted(cust_ids):
        if 0 <= ci < len(customers):
            names.append(customers[ci][1])
            if customers[ci][2]:
                zones.add(customers[ci][2])

    return {
        "salesperson": _person_label(people, sp_index),
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


# ------------------------------------------------------------- row selection
# Second way of answering, used only when the filter spec above cannot express
# the question ("due before the 10th", "invoices with no zone set", anything the
# fixed fields have no slot for). Here the model is shown the salesperson's
# actual invoice lines and asked which ones the question is about.
#
# It still never produces a number. It returns row IDs; `runQuery` in
# static/receivables.js adds up those rows exactly as it does for any other
# filter. So the model decides WHICH rows, the application decides WHAT THEY
# COME TO — a wrong pick shows a visibly wrong set of invoices, where a wrong
# total would just look like an answer.

# One salesperson's book is 105 lines at its largest today, so the whole book
# fits comfortably. The cap is here so an unusually large import degrades into a
# flagged partial read rather than a refused request.
MAX_ROWS_IN_PROMPT = 400


def _row_bucket(ln: List[Any], labels: List[str], b0: int) -> str:
    """Which ageing bucket this line's money sits in.

    Ageing is recomputed from the due date on import, so a line's balance
    normally lands in exactly one bucket. A line split across several is
    reported as such rather than picking one arbitrarily.
    """
    hit = [labels[i] for i in range(len(labels)) if ln[b0 + i]]
    if len(hit) == 1:
        return hit[0]
    return "split across buckets" if hit else "no balance"


def build_rows(ar: dict, sp_index: int) -> Optional[dict]:
    """The salesperson's real invoice lines, laid out for the model to read.

    Row IDs are positions in this salesperson's own line list, in dataset
    order. The browser builds its `person.lines` by walking the same list in the
    same order, so position N here is position N there. The document number is
    carried alongside each pick so the browser can prove that before using it.
    """
    people = ar.get("salespeople") or []
    if not _valid_person(people, sp_index):
        return None

    customers = ar.get("customers") or []
    terms = ar.get("terms") or []
    labels = ar.get("bucketLabels") or []
    b0 = 7                      # first bucket column; mirrors L.B0 in the frontend

    rows, docs = [], []
    for ln in ar.get("lines", []):
        if not _is_theirs(ln, sp_index):
            continue
        rid = len(rows)
        ci = ln[1]
        cust = customers[ci][1] if 0 <= ci < len(customers) else "(unknown)"
        zone = customers[ci][2] if 0 <= ci < len(customers) else ""
        ti = ln[2]
        term = terms[ti] if isinstance(ti, int) and 0 <= ti < len(terms) else ""
        docs.append(ln[3])
        rows.append(
            f"r{rid} | {cust} | {zone or '-'} | {term or '-'} | {ln[3]} | "
            f"due {ln[4]} | balance {ln[6]:.2f} | {_row_bucket(ln, labels, b0)}"
        )

    if not rows:
        return None

    return {
        "salesperson": _person_label(people, sp_index),
        "reportDate": ar.get("reportDate"),
        "rows": rows[:MAX_ROWS_IN_PROMPT],
        "docs": docs,                       # rid -> document number, for the integrity check
        "total": len(rows),
        "truncated": len(rows) > MAX_ROWS_IN_PROMPT,
    }


PICK_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "rows": {
            "type": "ARRAY",
            "description": "The row IDs the question is about, as integers (r12 -> 12). "
                           "Empty if genuinely nothing in the data matches.",
            "items": {"type": "INTEGER"},
        },
        "basis": {
            "type": "STRING",
            "description": "One short phrase naming the test you applied, written for the "
                           "salesperson, e.g. 'due date earlier than 10 August 2026'. "
                           "No numbers, totals or counts.",
        },
        "groupBy": {"type": "STRING", "enum": sorted(GROUP_BYS),
                    "description": "Set when the question asks about customers, zones or "
                                   "payment terms rather than individual invoices."},
        "sort": {"type": "STRING", "enum": sorted(SORTS)},
        "countOnly": {"type": "BOOLEAN", "description": "True for 'how many' questions."},
        "refusal": {
            "type": "STRING",
            "description": "If the question cannot be answered from these rows at all, "
                           "explain briefly why in one sentence. Empty otherwise.",
        },
    },
    "required": ["rows", "basis"],
}


PICK_SYSTEM = """\
You are given a salesperson's real accounts-receivable invoice lines, one per row,
each with a row ID. Your job is to decide WHICH ROWS the question is about.

Hard rules:
- NEVER compute, estimate or state any amount, count, total or average. The
  application adds up the rows you select and prints the figures itself. Your
  answer is a list of row IDs and nothing more.
- Select a row only if the data shown on that row satisfies the question. Do not
  infer, assume or guess anything that is not printed on the row.
- Use every row that matches, not a sample. If a hundred rows match, return all
  of them.
- If nothing matches, return an empty list. An empty list is a correct answer and
  is far better than a loose one.
- The rows are a single ageing SNAPSHOT as at the report date. They carry due
  dates, ageing buckets, payment terms, zones and balances. They carry NO payment
  history, NO invoice posting dates, NO sales figures, NO targets and NO credit
  limits. If the question needs any of those, put one sentence in `refusal` and
  return no rows.
- `basis` states the test you applied, in the salesperson's words, with no figures
  in it.
"""


def build_pick_prompt(rows_ctx: dict, question: str) -> str:
    lines = [
        f"Report date: {rows_ctx['reportDate']} (all ageing is as at this date).",
        f"Salesperson: {rows_ctx['salesperson']}",
        "",
        "Their invoice lines, one per row:",
        "  id | customer | zone | payment term | document | due date | balance | ageing bucket",
        "",
    ]
    lines += [f"  {r}" for r in rows_ctx["rows"]]
    if rows_ctx["truncated"]:
        lines.append(f"  (only the first {MAX_ROWS_IN_PROMPT} of "
                     f"{rows_ctx['total']} rows are shown)")
    lines += [
        "",
        f"Question: {question}",
        "",
        "Return the row IDs this question is about. Do not state any figure.",
    ]
    return "\n".join(lines)


def validate_picks(raw: dict, rows_ctx: dict) -> dict:
    """Reduce the model's picks to row IDs this book actually has.

    An ID out of range is dropped rather than clamped: a made-up row cannot be
    turned into a real one, and silently substituting a neighbour would put an
    invoice on screen that the model never chose.
    """
    out: Dict[str, Any] = {}
    n = len(rows_ctx["rows"])

    picked = raw.get("rows")
    ids = []
    if isinstance(picked, list):
        seen = set()
        for x in picked:
            i = _clean_int(x, 0, n - 1)
            if i is not None and i not in seen:
                seen.add(i)
                ids.append(i)
    out["rowIds"] = sorted(ids)
    # Sent so the browser can confirm each ID still points at the invoice the
    # model was shown before it counts a single rupee of it.
    out["rowDocs"] = [rows_ctx["docs"][i] for i in out["rowIds"]]

    basis = raw.get("basis")
    if isinstance(basis, str) and basis.strip():
        out["basis"] = basis.strip()[:200]

    if raw.get("groupBy") in GROUP_BYS:
        out["groupBy"] = raw["groupBy"]
        out["groupByCustomer"] = raw["groupBy"] == "customer"
    if raw.get("sort") in SORTS:
        out["sort"] = raw["sort"]
    if raw.get("countOnly") is True:
        out["countOnly"] = True

    refusal = raw.get("refusal")
    if isinstance(refusal, str) and refusal.strip():
        out["refusal"] = refusal.strip()[:400]

    if rows_ctx["truncated"]:
        out["partial"] = rows_ctx["total"]

    return out


# ------------------------------------------------------------------- narrative
# Second pass. The browser has already COMPUTED the answer; this turns that
# computed result into a few sentences of plain English. The model is given the
# finished figures and forbidden from deriving new ones, and everything it
# writes is checked against those figures before it reaches the page.

NARRATE_SYSTEM = """\
You write two or three sentences explaining an accounts-receivable result to the
salesperson who asked for it. Write like a capable colleague talking, not like a
report: plain English, no headings, no bullet points, no markdown, no preamble.

Absolute rules:
- Every figure you mention must be copied EXACTLY, character for character, from
  the data you are given. Never add, total, subtract, average or round anything.
  If a number is not in the data, it does not go in your answer.
- Never invent a customer, document, date or amount.
- If the result is empty, say plainly that nothing matched.
- Lead with the answer to the question, then at most one useful observation
  about what stands out — the oldest item, the largest, a concentration in one
  customer. Do not give advice about collections policy or credit control.
- Do not mention filters, buckets, queries, JSON, or how the answer was produced.
- Never end by offering to do more, and never ask a question back.
"""

NARRATE_SCHEMA = {
    "type": "OBJECT",
    "properties": {"answer": {"type": "STRING",
                              "description": "Two or three sentences of plain English."}},
    "required": ["answer"],
}

MAX_NARRATE_ROWS = 15


def build_narrate_prompt(question: str, result: dict) -> str:
    """Lay the COMPUTED result out for the model. Figures only, no raw data."""
    lines = [f"The salesperson asked: {question}", ""]
    if result.get("headline"):
        lines.append(f"Answer computed from their data: {result['headline']}")
    if result.get("heading"):
        lines.append(f"What that figure is: {result['heading']}")
    if result.get("note"):
        lines.append(f"Context: {result['note']}")

    rows = result.get("rows") or []
    if rows:
        cols = result.get("columns") or []
        lines += ["", f"Supporting rows ({' | '.join(cols)}):"]
        for r in rows[:MAX_NARRATE_ROWS]:
            lines.append("  " + " | ".join(str(c) for c in r))
        if result.get("more"):
            lines.append(f"  ...and {result['more']} more rows not shown")
    else:
        lines += ["", "There are no supporting rows: nothing matched."]

    lines += ["", "Write the explanation now. Use only the figures above."]
    return "\n".join(lines)


# Any run of digits, with or without separators — this is what gets checked
# against the source figures.
_NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?")


def _numbers_in(text: str) -> set:
    """Digits only, separators stripped, so '2,52,589' and '252589' match."""
    return {m.group(0).replace(",", "") for m in _NUMBER.finditer(text or "")}


def verify_narrative(answer: str, result: dict, question: str = "") -> Optional[str]:
    """Return the answer, or None if it states a figure that is not in the data.

    This is the backstop for the one thing that must never happen: a number on
    screen that the model made up. A narrative that fails the check is dropped
    entirely and the computed answer stands on its own, which is the behaviour
    the page had before.
    """
    if not answer or not answer.strip():
        return None

    allowed = set()
    for key in ("headline", "heading", "note"):
        allowed |= _numbers_in(str(result.get(key, "")))
    # Echoing a number the salesperson typed ("nothing is over 200 days") is
    # repeating them, not inventing a figure.
    allowed |= _numbers_in(question)
    for row in (result.get("rows") or []):
        for cell in row:
            allowed |= _numbers_in(str(cell))
    allowed |= _numbers_in(str(result.get("more", "")))
    # Small counts are ordinary English ("two invoices", "the top 3"), and the
    # row count itself is legitimately derivable by counting what is listed.
    allowed |= {str(n) for n in range(0, 21)}
    allowed.add(str(len(result.get("rows") or [])))
    # A four-digit year that appears in any date is fine to mention on its own.
    for row in (result.get("rows") or []):
        for cell in row:
            for part in re.findall(r"\d{4}", str(cell)):
                allowed.add(part)

    used = _numbers_in(answer)
    invented = used - allowed
    if invented:
        return None
    return answer.strip()


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
