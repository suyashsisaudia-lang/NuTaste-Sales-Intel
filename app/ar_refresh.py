"""
Receivables refresh from the Business Central OData API (AgedReceivables).

This module only fetches records. Converting them is importers/ar_api.py, and
writing the dataset stays in main.py, so an API refresh goes through the same
validation and backup path as an Excel upload.

The endpoint uses HTTP Basic authentication. The username and password are read
from the environment (BC_API_USERNAME / BC_API_PASSWORD) and never logged.

Run from the repo root to see what the API returns and how it maps:

    .venv\\Scripts\\python -m app.ar_refresh fields   # field names + mapping
    .venv\\Scripts\\python -m app.ar_refresh check    # full conversion, nothing written
"""
import datetime as dt
import logging
import os
import sys
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import urlsplit

import httpx

log = logging.getLogger("nutaste.refresh")

MAX_PAGES = 500
CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "ar_columns.json"
IST = dt.timezone(dt.timedelta(minutes=330))


class RefreshError(Exception):
    """A refresh failed; the message is shown to the admin."""


def today_ist() -> dt.date:
    """The report date. BC computes overdue days as of today, and the server
    may run on UTC, so the date is taken in IST to match."""
    return dt.datetime.now(IST).date()


def fetch(url: str, username: str, password: str, timeout: float) -> List[Dict[str, Any]]:
    """Every record from the endpoint, following @odata.nextLink pages."""
    if not url:
        raise RefreshError("BC_AR_API_URL is not set.")
    if not (username and password):
        raise RefreshError("BC_API_USERNAME and BC_API_PASSWORD must both be set.")
    origin = urlsplit(url).netloc
    records: List[Dict[str, Any]] = []
    next_url = url
    try:
        with httpx.Client(auth=(username, password), timeout=timeout,
                          headers={"Accept": "application/json"}) as client:
            for _ in range(MAX_PAGES):
                # Never send the credentials anywhere but the configured server.
                if urlsplit(next_url).netloc != origin:
                    raise RefreshError("The API's next-page link points to a different server; stopped.")
                resp = client.get(next_url)
                if resp.status_code in (401, 403):
                    raise RefreshError(
                        f"Business Central refused the request (HTTP {resp.status_code}). "
                        "Check BC_API_USERNAME / BC_API_PASSWORD and that the user can read AgedReceivables.")
                if resp.status_code != 200:
                    raise RefreshError(f"Business Central returned HTTP {resp.status_code}: {resp.text[:200]}")
                try:
                    body = resp.json()
                except ValueError as exc:
                    raise RefreshError("Business Central did not return JSON.") from exc
                records.extend(body.get("value", []))
                next_url = body.get("@odata.nextLink")
                if not next_url:
                    return records
    except httpx.HTTPError as exc:
        raise RefreshError(f"Could not reach Business Central: {exc}") from exc
    raise RefreshError(f"Stopped after {MAX_PAGES} pages; the API kept returning more.")


# ---------------------------------------------------------------- CLI
def _load_dotenv() -> None:
    """Same rules as run-web.ps1, without overriding variables already set."""
    path = Path(__file__).resolve().parent.parent / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


def _main(argv: List[str]) -> int:
    from .importers import ar_api

    cmd = argv[0] if argv else "fields"
    if cmd not in ("fields", "check"):
        print(__doc__)
        return 2
    _load_dotenv()
    try:
        records = fetch(os.getenv("BC_AR_API_URL", ""), os.getenv("BC_API_USERNAME", ""),
                        os.getenv("BC_API_PASSWORD", ""),
                        float(os.getenv("BC_API_TIMEOUT_SECONDS", "120")))
    except RefreshError as exc:
        print(f"Error: {exc}")
        return 1
    print(f"{len(records)} records")
    if not records:
        return 0

    names = sorted({k for r in records[:50] for k in r if not k.startswith("@")})
    mapping = ar_api.map_fields(names, CONFIG_PATH)
    used = set(mapping.values())
    print("\nMapped fields (app field <- API field):")
    for field, name in mapping.items():
        print(f"  {field:<16} <- {name}")
    print("\nAPI fields not used:", ", ".join(n for n in names if n not in used) or "none")
    print("\nFirst record:")
    for k in names:
        print(f"  {k}: {records[0].get(k)!r}")

    if cmd == "check":
        try:
            d = ar_api.convert(records, today_ist(), CONFIG_PATH)
        except ValueError as exc:
            print(f"\nConversion failed: {exc}")
            return 1
        print(f"\nReport date {d['reportDate']}: {len(d['lines'])} lines, "
              f"{len(d['salespeople'])} salespeople, {len(d['customers'])} customers, "
              f"balance {d['controlTotal']:,.2f}")
        totals = [0.0] * len(d["bucketLabels"])
        for ln in d["lines"]:
            for i, v in enumerate(ln[7:]):
                totals[i] += v
        for label, total in zip(d["bucketLabels"], totals):
            print(f"  {label:<16} {total:>18,.2f}")
        print("Nothing was written. Use the admin page to replace the dataset.")
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
