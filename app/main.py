"""
NuTaste Sales Intelligence — hosted backend.

Responsibilities
  * Shared-password gate for the whole site (bcrypt hash from env, rate-limited).
  * Signed, HttpOnly session cookie with expiry.
  * Serves the Sales Intelligence frontend and the two datasets (AR_DATA, SEC_DATA).
  * Admin area (separate password) to upload replacement datasets:
      - JSON in the app's native shape (either dataset), or
      - the Business Central AR Excel extract, converted by importers/ar_excel.py.
  * noindex headers + robots.txt so the site stays out of search engines.

The application is read-only with respect to any upstream system. When the
Business Central API is ready, replace the "upload" step with a scheduled job
that writes data/ar_data.json — nothing else needs to change.
"""
import html
import json
import logging
import logging.handlers
import os
import re
import secrets
import shutil
import threading
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import bcrypt
from fastapi import FastAPI, Form, Request, UploadFile, File
from fastapi.responses import (FileResponse, HTMLResponse, JSONResponse,
                               PlainTextResponse, RedirectResponse, Response)
from fastapi.staticfiles import StaticFiles
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel, Field

from . import ar_refresh
from . import ask as ask_mod
from . import ask_sec as ask_sec_mod
from . import data_sync
from . import export_xlsx
from . import keep_awake
from . import sec_refresh
from . import users
from .config import settings
from .importers import ar_api, ar_excel, sec_excel
from .providers import ProviderError, get_provider

log = logging.getLogger("nutaste.ask")

BASE = Path(__file__).resolve().parent


def _setup_app_logging() -> None:
    """Send the app's own INFO messages (scheduler, refresh, push) somewhere.

    Without this only WARNING and above reach stderr. They go to stderr (Render's
    log view; web-err.log on the PC) and to logs/app.log, which, unlike
    web-err.log, is not wiped when uvicorn restarts.
    """
    root = logging.getLogger("nutaste")
    if root.handlers:                   # uvicorn --reload imports twice
        return
    root.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s  %(levelname)-7s %(name)s: %(message)s",
                            "%Y-%m-%d %H:%M:%S")
    handlers: List[logging.Handler] = [logging.StreamHandler()]
    try:
        log_dir = BASE.parent / "logs"
        log_dir.mkdir(exist_ok=True)
        handlers.append(logging.handlers.RotatingFileHandler(
            log_dir / "app.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8"))
    except OSError:                     # read-only image: stderr alone is fine
        pass
    for h in handlers:
        h.setFormatter(fmt)
        root.addHandler(h)


_setup_app_logging()

DATA_DIR = Path(settings.data_dir)
DATA_DIR.mkdir(parents=True, exist_ok=True)
AR_PATH = DATA_DIR / "ar_data.json"
SEC_PATH = DATA_DIR / "sec_data.json"          
SEC_MONTHS_DIR = DATA_DIR / "sec_months"
META_PATH = DATA_DIR / "meta.json"
MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")

app = FastAPI(title="NuTaste Sales Intelligence", docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")

signer = URLSafeTimedSerializer(settings.secret_key, salt="nutaste-session")
SESSION_COOKIE = "nsd_session"
ADMIN_COOKIE = "nsd_admin"

def _seed_credentials() -> None:
    """Hosts without a persistent disk (Render Free) start every boot with an
    empty DATA_DIR, and credentials.json is never in Git or the image. Copy it
    from the host's secret file when it is missing; an existing file (local
    run, mounted disk) is never overwritten."""
    target = DATA_DIR / "credentials.json"
    source = Path(settings.credentials_seed_file) if settings.credentials_seed_file else None
    if target.exists() or not (source and source.is_file()):
        return
    try:
        json.loads(source.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        log.error("Credentials seed %s is not valid JSON; sign-in stays closed: %s", source, e)
        return
    shutil.copyfile(source, target)
    log.info("Seeded %s from %s", target, source)


_seed_credentials()

# Per-person logins and the reporting tree. See app/users.py.
user_store = users.Store(DATA_DIR)


# --------------------------------------------------------------------------- helpers
def _template(name: str, **ctx) -> str:
    html = (BASE / "templates" / name).read_text(encoding="utf-8")
    for k, v in ctx.items():
        html = html.replace("{{ %s }}" % k, str(v))
    return html


def _check_password(plain: str, hashed: str) -> bool:
    if not plain or not hashed:
        return False
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False


def _make_cookie(payload: dict) -> str:
    return signer.dumps(payload)


def _read_cookie(value: Optional[str], max_age: int) -> Optional[dict]:
    if not value:
        return None
    try:
        return signer.loads(value, max_age=max_age)
    except (BadSignature, SignatureExpired):
        return None


def _viewer(request: Request) -> Optional[users.Viewer]:
    """The signed-in person, re-validated against the directory every request."""
    data = _read_cookie(request.cookies.get(SESSION_COOKIE), settings.session_hours * 3600)
    if not (data and data.get("role") == "user"):
        return None
    email, tag = data.get("u", ""), data.get("t", "")
    if email == users.SHARED_EMAIL:
        # Only while the shared password is still configured: removing
        # SITE_PASSWORD_HASH ends every shared session too.
        return users.shared_viewer() if settings.site_password_hash else None
    return user_store.viewer_for_session(email, tag)


def _is_authed(request: Request) -> bool:
    return _viewer(request) is not None

def _is_admin(request: Request) -> bool:
    data = _read_cookie(request.cookies.get(ADMIN_COOKIE), settings.admin_session_minutes * 60)
    return bool(data and data.get("role") == "admin")


def _set_cookie(resp: Response, name: str, value: str, max_age: int) -> None:
    resp.set_cookie(
        name, value, max_age=max_age, httponly=True, samesite="lax",
        secure=settings.secure_cookies, path="/",
    )


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"

# ------------------------------------------------------------- login rate limiting
# In-memory sliding window per IP. Good enough for one small container; if you
# ever run several replicas, move this to Redis or the database.
_attempts: Dict[str, List[float]] = {}

def _too_many_attempts(ip: str) -> bool:
    now = time.time()
    window = settings.login_window_seconds
    hits = [t for t in _attempts.get(ip, []) if now - t < window]
    _attempts[ip] = hits
    return len(hits) >= settings.login_max_attempts


def _record_attempt(ip: str) -> None:
    _attempts.setdefault(ip, []).append(time.time())

def _ar_for(viewer: users.Viewer) -> dict:
    return users.scope_ar(_load(AR_PATH), user_store.directory, viewer)


def _sec_for(viewer: users.Viewer, month: Optional[str]) -> dict:
    return users.scope_sec(_load(_sec_path(month)), user_store.directory, viewer)


# ------------------------------------------------------------------ data access
def _load(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _meta() -> dict:
    return _load(META_PATH) if META_PATH.exists() else {}


def _write_dataset(path: Path, payload: dict, kind: str, source: str) -> None:
    """Atomic replace with a timestamped backup of the previous file."""
    backups = DATA_DIR / "backups"
    backups.mkdir(exist_ok=True)
    if path.exists():
        stamp = time.strftime("%Y%m%d-%H%M%S")
        shutil.copy2(path, backups / f"{path.stem}.{stamp}.json")
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)
    meta = _meta()
    meta[kind] = {"updated": time.strftime("%Y-%m-%d %H:%M:%S"), "source": source}
    META_PATH.write_text(json.dumps(meta, indent=2), encoding="utf-8")


def _validate_ar(d: dict) -> None:
    need = {"reportDate", "bucketKeys", "bucketLabels", "salespeople", "customers", "terms", "lines"}
    missing = need - set(d)
    if missing:
        raise ValueError(f"AR JSON missing keys: {sorted(missing)}")
    nb = len(d["bucketLabels"])
    for i, ln in enumerate(d["lines"][:50]):
        if len(ln) != 7 + nb:
            raise ValueError(f"AR line {i} has {len(ln)} fields, expected {7 + nb}")


def _validate_sec(d: dict) -> None:
    need = {"periodFrom", "periodTo", "people", "roster", "pools",
            "visits", "demos", "leads", "travel", "expenses", "sales"}
    missing = need - set(d)
    if missing:
        raise ValueError(f"Secondary-sales JSON missing keys: {sorted(missing)}")


# ------------------------------------------------ secondary sales: months
# Every month in the workbook is stored, so the page can offer a month picker.
# sec_data.json stays a copy of the latest month: it is the default view and
# what older code paths and the Docker seed expect.
def _sec_months() -> List[str]:
    """Stored months, oldest first."""
    if not SEC_MONTHS_DIR.exists():
        return []
    return sorted(p.stem for p in SEC_MONTHS_DIR.glob("*.json") if MONTH_RE.match(p.stem))


def _sec_path(month: Optional[str]) -> Path:
    """The file for `month`, or the latest month when it is blank or unknown."""
    if month and MONTH_RE.match(month):
        path = SEC_MONTHS_DIR / f"{month}.json"
        if path.exists():
            return path
    return SEC_PATH


def _sec_month_of(payload: dict) -> str:
    return str(payload.get("periodFrom", ""))[:7]


def _write_sec_months(datasets: Dict[str, dict], source: str) -> str:
    """Store each month, then make the newest one the default. Returns it.

    Months already stored but absent from this import are kept, so history
    survives the workbook being trimmed at source.
    """
    SEC_MONTHS_DIR.mkdir(exist_ok=True)
    for month, payload in datasets.items():
        _validate_sec(payload)
        path = SEC_MONTHS_DIR / f"{month}.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    newest = max(_sec_months())
    if newest in datasets:
        _write_dataset(SEC_PATH, datasets[newest], "sec", f"{source} ({newest})")
    return newest


def _seed_sec_months() -> None:
    """First run after upgrading: file the existing dataset under its month."""
    if _sec_months() or not SEC_PATH.exists():
        return
    payload = _load(SEC_PATH)
    month = _sec_month_of(payload)
    if MONTH_RE.match(month):
        SEC_MONTHS_DIR.mkdir(exist_ok=True)
        shutil.copy2(SEC_PATH, SEC_MONTHS_DIR / f"{month}.json")


_seed_sec_months()


# ------------------------------------------------ secondary sales auto-refresh
# Weekly pull of the workbook from SharePoint, through the same importer,
# validation and backup as a manual upload. See app/sec_refresh.py.
_sec_refresh_lock = threading.Lock()
_sec_schedule = sec_refresh.Schedule(settings.sec_refresh_weekday, settings.sec_refresh_time,
                                     settings.sec_refresh_utc_offset_minutes)
_sec_scheduler: Optional[sec_refresh.Scheduler] = None


def _record_refresh(ok: bool, message: str, trigger: str) -> None:
    meta = _meta()
    meta["secRefresh"] = {"lastAttempt": _sec_schedule.now().isoformat(timespec="seconds"),
                          "ok": ok, "message": message, "trigger": trigger}
    META_PATH.write_text(json.dumps(meta, indent=2), encoding="utf-8")


def _last_refresh_attempt() -> Optional[datetime]:
    stamp = _meta().get("secRefresh", {}).get("lastAttempt")
    try:
        return datetime.fromisoformat(stamp) if stamp else None
    except ValueError:
        return None


def refresh_sec_from_source(trigger: str) -> str:
    """Download the workbook, import every month in it, replace the datasets.

    On any failure the current dataset is left untouched and the reason is
    recorded for the admin page. Returns a one-line summary on success.
    """
    if not _sec_refresh_lock.acquire(blocking=False):
        raise sec_refresh.RefreshError("A refresh is already running. Try again in a minute.")
    try:
        raw = sec_refresh.download(settings.sec_source_url, settings.sec_download_timeout_seconds,
                                   settings.max_upload_mb * 1024 * 1024)
        datasets = sec_excel.convert_all(raw)
        newest = _write_sec_months(datasets, f"SharePoint auto-refresh, {trigger}")
        months = sorted(datasets)
        message = (f"Imported {len(months)} months ({months[0]} to {months[-1]}) from SharePoint "
                   f"({len(raw) / 1048576:.1f} MB); default view {newest}")
        _record_refresh(True, message, trigger)
        log.info("Secondary Sales refresh (%s): %s", trigger, message)
        if settings.sec_auto_push:
            data_sync.push_in_background(BASE.parent, f"Secondary Sales data refresh ({trigger}): "
                                         f"{months[0]} to {months[-1]}",
                                         settings.sec_auto_push_branch)
        return message
    except Exception as exc:
        _record_refresh(False, str(exc)[:400], trigger)
        log.warning("Secondary Sales refresh (%s) failed: %s", trigger, exc)
        raise
    finally:
        _sec_refresh_lock.release()


# ------------------------------------------------ receivables from the BC API
# Daily pull of AgedReceivables, through the same validation and backup as an
# upload. Shares the Schedule/Scheduler in app/sec_refresh.py.
_ar_refresh_lock = threading.Lock()
_ar_schedule = sec_refresh.Schedule(None, settings.ar_refresh_time,
                                    settings.ar_refresh_utc_offset_minutes)
_ar_scheduler: Optional[sec_refresh.Scheduler] = None


def _ar_api_configured() -> bool:
    return bool(settings.bc_ar_api_url and settings.bc_api_username and settings.bc_api_password)


def _record_ar_refresh(ok: bool, message: str, trigger: str) -> None:
    meta = _meta()
    meta["arRefresh"] = {"lastAttempt": _ar_schedule.now().isoformat(timespec="seconds"),
                         "ok": ok, "message": message, "trigger": trigger}
    META_PATH.write_text(json.dumps(meta, indent=2), encoding="utf-8")


def _last_ar_refresh_attempt() -> Optional[datetime]:
    stamp = _meta().get("arRefresh", {}).get("lastAttempt")
    try:
        return datetime.fromisoformat(stamp) if stamp else None
    except ValueError:
        return None


def refresh_ar_from_api(trigger: str) -> str:
    """Pull AgedReceivables from Business Central and replace the AR dataset.

    Ageing comes from the API's total-overdue-days field. On any failure the
    current dataset is left untouched. Returns a one-line summary on success.
    """
    if not _ar_refresh_lock.acquire(blocking=False):
        raise ar_refresh.RefreshError("A receivables refresh is already running. Try again in a minute.")
    try:
        records = ar_refresh.fetch(settings.bc_ar_api_url, settings.bc_api_username,
                                   settings.bc_api_password, settings.bc_api_timeout_seconds)
        payload = ar_api.convert(records, ar_refresh.today_ist(),
                                 BASE.parent / "config" / "ar_columns.json")
        _validate_ar(payload)
        _write_dataset(AR_PATH, payload, "ar",
                       f"Business Central API, {trigger} (ageing as at {payload['reportDate']})")
        unmatched = [n for n in payload["salespeople"] if not user_store.directory.resolve(n)]
        message = (f"Imported {len(payload['lines'])} lines for {len(payload['salespeople'])} salespeople "
                   f"from Business Central, ageing as at {payload['reportDate']}")
        if unmatched:
            message += (f". {len(unmatched)} salesperson name(s) match nobody in the employee "
                        f"directory and stay hidden: {', '.join(unmatched[:8])}")
        _record_ar_refresh(True, message, trigger)
        log.info("Receivables refresh (%s): %s", trigger, message)
        if settings.ar_auto_push:
            data_sync.push_in_background(BASE.parent, f"Receivables data refresh ({trigger}): "
                                         f"ageing as at {payload['reportDate']}",
                                         settings.sec_auto_push_branch, data_sync.AR_DATA_PATHS)
        return message
    except Exception as exc:
        _record_ar_refresh(False, str(exc)[:400], trigger)
        log.warning("Receivables refresh (%s) failed: %s", trigger, exc)
        raise
    finally:
        _ar_refresh_lock.release()


@app.on_event("startup")
def _start_sec_scheduler() -> None:
    global _sec_scheduler
    if not (settings.sec_refresh_enabled and settings.sec_source_url):
        log.info("Secondary Sales auto-refresh is off (SEC_SOURCE_URL not set or disabled).")
        return
    _sec_scheduler = sec_refresh.Scheduler(_sec_schedule, refresh_sec_from_source,
                                           _last_refresh_attempt)
    _sec_scheduler.start()


@app.on_event("shutdown")
def _stop_sec_scheduler() -> None:
    if _sec_scheduler:
        _sec_scheduler.stop()


@app.on_event("startup")
def _start_ar_scheduler() -> None:
    global _ar_scheduler
    if not (settings.ar_refresh_enabled and _ar_api_configured()):
        log.info("Receivables daily refresh is off (BC API not configured or disabled).")
        return
    _ar_scheduler = sec_refresh.Scheduler(_ar_schedule, refresh_ar_from_api,
                                          _last_ar_refresh_attempt, name="Receivables")
    _ar_scheduler.start()


@app.on_event("shutdown")
def _stop_ar_scheduler() -> None:
    if _ar_scheduler:
        _ar_scheduler.stop()


def _ar_refresh_status() -> str:
    """One line for the admin page describing the daily refresh state."""
    if not _ar_api_configured():
        return "Not configured (set BC_AR_API_URL, BC_API_USERNAME, BC_API_PASSWORD)"
    if not settings.ar_refresh_enabled:
        return "Disabled (AR_REFRESH_ENABLED=false); manual refresh still works"
    nxt = _ar_scheduler.next_run if _ar_scheduler else None
    return _ar_schedule.describe() + (f" · next {nxt:%a %d %b %H:%M}" if nxt else "")


def _ar_last_refresh() -> str:
    r = _meta().get("arRefresh")
    if not r:
        return "never"
    when = r.get("lastAttempt", "")[:16].replace("T", " ")
    return f"{'OK' if r.get('ok') else 'FAILED'} {when} ({r.get('trigger', '')}): {r.get('message', '')}"


# Free Render instances sleep after ~15 idle minutes; see app/keep_awake.py.
_keep_awake: Optional[keep_awake.KeepAwake] = None


@app.on_event("startup")
def _start_keep_awake() -> None:
    global _keep_awake
    if not settings.keep_awake_url:
        return
    _keep_awake = keep_awake.KeepAwake(settings.keep_awake_url,
                                       max(settings.keep_awake_minutes, 1) * 60)
    _keep_awake.start()


@app.on_event("shutdown")
def _stop_keep_awake() -> None:
    if _keep_awake:
        _keep_awake.stop()


def _sec_refresh_status() -> str:
    """One line for the admin page describing the auto-refresh state."""
    if not settings.sec_source_url:
        return "Not configured (set SEC_SOURCE_URL)"
    if not settings.sec_refresh_enabled:
        return "Disabled (SEC_REFRESH_ENABLED=false); manual refresh still works"
    nxt = _sec_scheduler.next_run if _sec_scheduler else None
    return _sec_schedule.describe() + (f" · next {nxt:%a %d %b %H:%M}" if nxt else "")


def _sec_last_refresh() -> str:
    r = _meta().get("secRefresh")
    if not r:
        return "never"
    when = r.get("lastAttempt", "")[:16].replace("T", " ")
    return f"{'OK' if r.get('ok') else 'FAILED'} {when} ({r.get('trigger', '')}): {r.get('message', '')}"


# ------------------------------------------------------------------ middleware
@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-Robots-Tag"] = "noindex, nofollow"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Cache-Control"] = "no-store"
    if settings.secure_cookies:
        resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return resp


# ---------------------------------------------------------------------- routes
@app.get("/robots.txt", response_class=PlainTextResponse)
def robots():
    return "User-agent: *\nDisallow: /\n"


@app.get("/healthz", response_class=PlainTextResponse)
def healthz():
    return "ok"


@app.get("/healthz/data")
def healthz_data():
    """Which data this copy is serving, so the PC and the hosted copy can be
    compared without signing in. Timestamps, dates and month names only."""
    meta = _meta()
    sec, ar = meta.get("sec", {}), meta.get("ar", {})
    ar_refresh_state = meta.get("arRefresh", {})
    return {"secUpdated": sec.get("updated"), "secSource": sec.get("source"),
            "months": _sec_months(),
            "arUpdated": ar.get("updated"), "arSource": ar.get("source"),
            "arReportDate": _load(AR_PATH).get("reportDate"),
            "arLastRefresh": ar_refresh_state.get("lastAttempt"),
            "arLastRefreshOk": ar_refresh_state.get("ok")}


# Form fields for the one sign-in template (login.html), which serves the
# site login and the admin login.
_ICON_USER = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
              'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
              '<circle cx="12" cy="8.5" r="3.8"></circle><path d="M4.5 20a7.5 7.5 0 0 1 15 0"></path></svg>')
_ICON_LOCK = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
              'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
              '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"></rect>'
              '<path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"></path></svg>')
_EYE = ('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"></path>'
        '<circle cx="12" cy="12" r="2.8"></circle>')
_SVG = ('<svg class="{cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{body}</svg>')
# Show/hide password. Hidden until login.js wires it up, so it never shows as a dead button.
_REVEAL = ('<button type="button" class="reveal" aria-label="Show password" aria-pressed="false" hidden>'
           + _SVG.format(cls="eye-show", body=_EYE)
           + _SVG.format(cls="eye-hide", body=_EYE + '<path d="M4 4l16 16"></path>')
           + '</button>')


def _field(name: str, kind: str, label: str, autocomplete: str,
           value: str = "", required: bool = True, autofocus: bool = False) -> str:
    icon = _ICON_USER if kind == "email" else _ICON_LOCK
    flags = (" required" if required else "") + (" autofocus" if autofocus else "")
    if kind == "email":
        flags += ' autocapitalize="off" spellcheck="false"'
    cls = "field field-password" if kind == "password" else "field"
    return (f'<div class="{cls}">{icon}<input type="{kind}" name="{name}" '
            f'placeholder="{label}" aria-label="{label}" autocomplete="{autocomplete}" '
            f'value="{html.escape(value)}"{flags}>'
            f'{_REVEAL if kind == "password" else ""}</div>')


def _gate(heading: str, intro: str, action: str, fields: str, error: str = "",
          hint: str = "", button: str = "Continue", title: str = "NuTaste Sales Intelligence",
          notice: str = "") -> str:
    # No fields = a message page whose button just goes to `action`.
    method = "post" if fields else "get"
    return _template("login.html", title=title, heading=heading, intro=html.escape(intro),
                     action=action, method=method, fields=fields, button=button, error=html.escape(error),
                     notice=html.escape(notice), hint=hint)


@app.get("/login", response_class=HTMLResponse)
def login_form(request: Request, error: str = "", u: str = ""):
    if _is_authed(request):
        return RedirectResponse("/", status_code=303)
    msg = {"bad": "That email and password don't match an account.",
           "rate": "Too many attempts. Please wait a few minutes and try again.",
           "expired": "Your session expired. Please sign in again."}.get(error, "")
    email = u[:120] if error == "bad" else ""
    fields = (_field("username", "email", "Work email", "username", email, autofocus=not email)
              + _field("password", "password", "Password", "current-password", autofocus=bool(email)))
    return _gate("Sales Intelligence", "Sign in with your NuTaste email and password.", "/login", fields,
                 error=msg, hint='Forgotten your password? Ask IT to reset it.')


@app.post("/login")
def login(request: Request, username: str = Form(""), password: str = Form("")):
    ip = _client_ip(request)
    email = username.strip().lower()[:120]
    # Per IP and per account: the second stops a slow guess at one person's
    # password from many addresses.
    acct = f"acct:{email}"
    if _too_many_attempts(ip) or (email and _too_many_attempts(acct)):
        return RedirectResponse("/login?error=rate", status_code=303)

    viewer = user_store.authenticate(email, password) if email and password else None
    if viewer is None and password and settings.site_password_hash \
            and _check_password(password, settings.site_password_hash):
        # The shared password still opens the full view (kept by request for
        # the transition). The email box may be left blank for it.
        viewer = users.shared_viewer()
    if viewer is None:
        _record_attempt(ip)
        if email:
            _record_attempt(acct)
        from urllib.parse import quote
        return RedirectResponse(f"/login?error=bad&u={quote(email)}", status_code=303)

    log.info("sign-in: %s (%s)", viewer.email, "full view" if viewer.full_view
             else f"{len(viewer.codes)} people")
    resp = RedirectResponse("/", status_code=303)
    _set_cookie(resp, SESSION_COOKIE,
                _make_cookie({"role": "user", "u": viewer.email, "t": viewer.session_tag,
                              "n": secrets.token_hex(4)}),
                settings.session_hours * 3600)
    return resp


@app.get("/account/password")
def password_form():
    # Self-service password change was removed: on Render the change was lost
    # at the next restart (no persistent disk). IT resets passwords instead.
    # Old bookmarks land on the sign-in page.
    return RedirectResponse("/login", status_code=303)


@app.get("/logout")
def logout():
    resp = RedirectResponse("/login", status_code=303)
    resp.delete_cookie(SESSION_COOKIE, path="/")
    resp.delete_cookie(ADMIN_COOKIE, path="/")
    return resp


@app.get("/", response_class=HTMLResponse)
def index(request: Request, month: str = ""):
    viewer = _viewer(request)
    if viewer is None:
        return RedirectResponse("/login", status_code=303)
    # ?month=2026-08 picks the Secondary Sales month; anything else is ignored.
    sec_query = f"?month={month}" if MONTH_RE.match(month) else ""
    # "greet" in employees.json overrides the first-name greeting for one person.
    greet = (user_store.directory.employees.get(viewer.code) or {}).get("greet", "")
    return _template("index.html", sec_query=sec_query, me_name=html.escape(viewer.name),
                     me_email=html.escape(viewer.email if not viewer.email.startswith("*") else ""),
                     me_greet=html.escape(str(greet)))


def _dataset_js(viewer: Optional[users.Viewer], payload: Optional[dict], var: str,
                extra: str = "") -> Response:
    if viewer is None:
        return Response("// unauthorised", status_code=401, media_type="application/javascript")
    body = json.dumps(payload, ensure_ascii=False) if payload else "null"
    # Who is looking, so a person with a single-name view opens straight onto it.
    me = {"name": viewer.name, "fullView": viewer.full_view}
    return Response(f"window.{var}={body};window.ME={json.dumps(me)};{extra}",
                    media_type="application/javascript")


@app.get("/api/data/ar.js")
def ar_js(request: Request):
    viewer = _viewer(request)
    # when the dataset was last replaced (upload or seed), for the header
    extra = f"window.AR_UPDATED={json.dumps(_meta().get('ar', {}).get('updated'))};"
    return _dataset_js(viewer, _ar_for(viewer) if viewer else None, "AR_DATA", extra)


@app.get("/api/data/sec.js")
def sec_js(request: Request, month: str = ""):
    viewer = _viewer(request)
    path = _sec_path(month)
    shown = month if path != SEC_PATH else _sec_month_of(_load(SEC_PATH))
    # The month list rides along with the data so the picker needs no extra call.
    extra = (f"window.SEC_MONTHS={json.dumps(_sec_months() or [shown])};"
             f"window.SEC_MONTH={json.dumps(shown)};"
             # when the dataset was last replaced (refresh or upload), for the header
             f"window.SEC_UPDATED={json.dumps(_meta().get('sec', {}).get('updated'))};")
    return _dataset_js(viewer, _sec_for(viewer, month) if viewer else None, "SEC_DATA", extra)


@app.get("/api/meta")
def meta(request: Request):
    viewer = _viewer(request)
    if viewer is None:
        return JSONResponse({"error": "unauthorised"}, status_code=401)
    ar = _ar_for(viewer)
    sec = _sec_for(viewer, None)
    return {
        "ar": {"reportDate": ar.get("reportDate"), "lines": len(ar.get("lines", [])),
               "salespeople": len(ar.get("salespeople", [])), **_meta().get("ar", {})},
        "sec": {"periodFrom": sec.get("periodFrom"), "periodTo": sec.get("periodTo"),
                "people": len(sec.get("people", [])), **_meta().get("sec", {})},
    }


# ------------------------------------------------------------- Excel downloads
# Built from the viewer's scoped payload, so the file holds exactly what the
# page could show them. ?person= is the name picked on screen; blank or "All"
# means everyone in their view.
XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _xlsx_response(body: bytes, filename: str) -> Response:
    from urllib.parse import quote
    return Response(body, media_type=XLSX_TYPE, headers={
        "Content-Disposition": f"attachment; filename=\"{filename}\"; "
                               f"filename*=UTF-8''{quote(filename)}",
        "Cache-Control": "no-store",
    })


@app.get("/api/export/ar.xlsx")
def export_ar(request: Request, person: str = ""):
    viewer = _viewer(request)
    if viewer is None:
        return RedirectResponse("/login", status_code=303)
    ar = _ar_for(viewer)
    who = None if person in ("", "All") else person
    try:
        body = export_xlsx.build_ar(ar, who, viewer.name)
    except KeyError:
        return PlainTextResponse("That salesperson is not in your view.", status_code=404)
    log.info("Excel download: receivables (%s) by %s", who or "All", viewer.email)
    name = export_xlsx.safe_filename("NuTaste-Receivables", who or "All",
                                     str(ar.get("reportDate", "")))
    return _xlsx_response(body, name + ".xlsx")


@app.get("/api/export/sec.xlsx")
def export_sec(request: Request, month: str = "", person: str = ""):
    viewer = _viewer(request)
    if viewer is None:
        return RedirectResponse("/login", status_code=303)
    sec = _sec_for(viewer, month)
    who = None if person in ("", "All") else person
    try:
        body = export_xlsx.build_sec(sec, who, viewer.name)
    except KeyError:
        return PlainTextResponse("That person is not in your view.", status_code=404)
    log.info("Excel download: secondary sales %s (%s) by %s",
             _sec_month_of(sec), who or "All", viewer.email)
    name = export_xlsx.safe_filename("NuTaste-Secondary-Sales", who or "All", _sec_month_of(sec))
    return _xlsx_response(body, name + ".xlsx")


# ------------------------------------------------------------------- ask (AI)
# The model turns a typed question into a filter spec; the browser computes the
# answer from that spec against the real invoice lines. No amounts are sent to
# the provider and none come back — see app/ask.py for why.
try:
    _provider = get_provider(settings.ask_provider, settings.gemini_api_key,
                             settings.gemini_model, settings.ask_timeout_seconds,
                             settings.gemini_thinking_budget)
except ProviderError as exc:
    log.warning("Ask AI disabled: %s", exc)
    _provider = None

if settings.ask_ai_enabled and _provider is None:
    log.info("Ask AI is on but no API key is set — the Ask box will use the built-in parser.")

_ask_hits: Dict[str, List[float]] = {}

# ---- model catalogue and failover state
# A model that has answered 429 is parked here until its cooldown expires, so
# Auto stops spending a round trip on a model whose daily quota is gone.
_model_cooldown: Dict[str, float] = {}
_catalog_cache: Dict[str, Any] = {"at": 0.0, "models": []}
CATALOG_TTL_SECONDS = 6 * 3600
# Below this, a model has no realistic chance of answering, so the walk stops
# rather than burning the last seconds on a request that cannot finish.
MIN_MODEL_SECONDS = 6.0
# An overloaded model (503) usually recovers in minutes, unlike a spent daily
# quota, so it is parked only briefly.
BUSY_COOLDOWN_SECONDS = 120


def _catalog() -> List[dict]:
    """Models this key can call, cached — the list changes rarely."""
    if not _provider:
        return []
    now = time.time()
    if _catalog_cache["models"] and now - _catalog_cache["at"] < CATALOG_TTL_SECONDS:
        return _catalog_cache["models"]
    models = _provider.list_models()
    if models:                      # keep the previous list if the call failed
        _catalog_cache.update(at=now, models=models)
    return _catalog_cache["models"]


def _known_model_ids() -> List[str]:
    ids = [m["id"] for m in _catalog()]
    # The configured model must always be selectable, even if listing failed.
    if settings.gemini_model not in ids:
        ids.insert(0, settings.gemini_model)
    return ids


def _auto_order() -> List[str]:
    """Preference order Auto walks through.

    The configured model leads, then any explicit GEMINI_MODELS order, then
    everything else the key can see, newest first.
    """
    order: List[str] = [settings.gemini_model]
    order += [m.strip() for m in settings.gemini_models.split(",") if m.strip()]
    order += _known_model_ids()
    seen, out = set(), []
    for m in order:
        if m and m not in seen:
            seen.add(m)
            out.append(m)
    return out


def _cooling_down(model: str) -> bool:
    until = _model_cooldown.get(model, 0)
    if until and until > time.time():
        return True
    _model_cooldown.pop(model, None)
    return False


def _ask_with_failover(ctx: dict, question: str, requested: Optional[str]):
    """Question -> filter spec, trying models in turn."""
    return _call_with_failover(
        ask_mod.SYSTEM,
        ask_mod.build_prompt(ctx, question),
        ask_mod.spec_schema(len(ctx["bucketLabels"])),
        requested,
    )


# Fields that actually narrow the query. `unsupported` and `refusal` are
# commentary, so a spec carrying only those is still an empty query. Mirrors
# FILTER_KEYS in static/receivables.js.
_NARROWING_KEYS = ("buckets", "custIds", "zone", "term", "sign", "sort", "topN",
                   "groupBy", "countOnly", "superlative", "aggregate",
                   "amtMin", "amtMax", "dueMonth", "dueYear", "dueBefore", "dueAfter")


def _narrows(spec: dict) -> bool:
    return any(spec.get(k) not in (None, False, [], "") for k in _NARROWING_KEYS)


def _pick_with_failover(rows_ctx: dict, question: str, requested: Optional[str]):
    """Question -> chosen row IDs, trying models in turn.

    The second, slower way of answering: the model reads the real invoice lines
    instead of filling in a fixed filter. Used only when the filter spec came
    back unable to express the question.
    """
    return _call_with_failover(
        ask_mod.PICK_SYSTEM,
        ask_mod.build_pick_prompt(rows_ctx, question),
        ask_mod.PICK_SCHEMA,
        requested,
    )


def _call_with_failover(system: str, prompt: str, schema: dict,
                        requested: Optional[str],
                        timeout: Optional[float] = None,
                        max_output_tokens: int = 2048,
                        thinking_budget: Optional[int] = None):
    """Try models in turn until one answers. Returns (raw_json, model_used).

    A model that is out of quota, overloaded, retired or that rejects the
    request hands over to the next one. A bad key stops immediately — retrying
    it on five models would just take five times as long to fail the same way.

    `timeout`, `max_output_tokens` and `thinking_budget` are raised by analyst
    mode, which reads several hundred rows and writes prose; the defaults suit a
    classification into a small schema.
    """
    if requested:
        candidates = [requested]        # an explicit choice is honoured as-is
    else:
        candidates = [m for m in _auto_order() if not _cooling_down(m)] or _auto_order()

    # One deadline for the whole walk, not per model — otherwise trying five
    # models could take five times the timeout the caller agreed to. Each model
    # gets at most half the budget, so a slow first choice can never consume
    # the lot and leave no room for a second.
    budget_seconds = timeout or settings.ask_timeout_seconds
    deadline = time.monotonic() + budget_seconds
    per_model = max(MIN_MODEL_SECONDS, budget_seconds / 2)

    last: Optional[ProviderError] = None
    for model in candidates[:5]:        # a bounded walk, so one question cannot stall
        remaining = deadline - time.monotonic()
        if remaining < MIN_MODEL_SECONDS:
            log.info("out of time after %s, stopping the walk", model)
            break
        try:
            raw = _provider.for_model(model, timeout=min(per_model, remaining)) \
                           .structured_json(system, prompt, schema,
                                            max_output_tokens=max_output_tokens,
                                            thinking_budget=thinking_budget)
            _model_cooldown.pop(model, None)
            return raw, model
        except ProviderError as exc:
            last = exc
            if exc.is_quota:
                # Daily caps do not clear quickly; stop spending a round trip
                # on this model for a while.
                _model_cooldown[model] = time.time() + settings.ask_quota_cooldown_seconds
                log.warning("model %s is out of quota, parking it", model)
            elif exc.can_failover or exc.status is None:
                # Overloaded or unreachable: park it briefly so the next few
                # questions do not each pay to rediscover that.
                _model_cooldown[model] = time.time() + BUSY_COOLDOWN_SECONDS
                log.info("model %s unavailable (%s), parking it briefly", model, exc.status)
            if not (exc.can_failover or exc.status is None):
                raise
    raise last or ProviderError("no model was available")


def _ask_rate_limited(key: str) -> bool:
    """Sliding window per session, so one person cannot burn the shared quota."""
    now = time.time()
    hits = [t for t in _ask_hits.get(key, []) if now - t < settings.ask_window_seconds]
    if len(hits) >= settings.ask_max_per_window:
        _ask_hits[key] = hits
        return True
    hits.append(now)
    _ask_hits[key] = hits
    return False


class AskRequest(BaseModel):
    question: str = Field(min_length=1)
    salesperson: int = Field(ge=-1)        # -1 = "All": everyone the viewer can see
    # "" or absent means Auto. Any other value must be a model the key can see;
    # it is checked against the catalogue before use, never passed through.
    model: Optional[str] = Field(default=None, max_length=100)


@app.get("/api/ask/models")
def ask_models(request: Request):
    """The model picker's options, with whichever ones are currently parked."""
    if not _is_authed(request):
        return JSONResponse({"error": "unauthorised"}, status_code=401)
    if not (settings.ask_ai_enabled and _provider):
        return {"enabled": False, "models": [], "default": None}

    known = {m["id"]: m for m in _catalog()}
    out = []
    for mid in _auto_order():
        meta = known.get(mid, {"id": mid, "label": mid})
        cooling = _cooling_down(mid)
        out.append({
            "id": mid,
            "label": meta.get("label") or mid,
            "available": not cooling,
            "note": "quota spent — will be retried later" if cooling else "",
            "recommended": mid == settings.gemini_model,
        })
    return {"enabled": True, "models": out, "default": settings.gemini_model}


@app.get("/api/ask/status")
def ask_status(request: Request):
    if not _is_authed(request):
        return JSONResponse({"error": "unauthorised"}, status_code=401)
    # The browser takes its abort deadline from here, so the timeout is
    # configured in one place. The margin covers the round trip and the one
    # retry the provider may make.
    return {"enabled": bool(settings.ask_ai_enabled and _provider),
            "provider": _provider.name if _provider else None,
            "timeoutMs": int(settings.ask_timeout_seconds * 1000) + 3000,
            # Analyst mode reads rows and writes prose, so the browser needs a
            # longer deadline for it than for a filter classification.
            "analyst": bool(settings.ask_analyst),
            "analystTimeoutMs": int(settings.ask_analyst_timeout_seconds * 1000) + 5000}


@app.post("/api/ask")
def api_ask(request: Request, body: AskRequest):
    viewer = _viewer(request)
    if viewer is None:
        return JSONResponse({"error": "unauthorised"}, status_code=401)
    if not (settings.ask_ai_enabled and _provider):
        return {"ok": False, "reason": "disabled"}

    session = _read_cookie(request.cookies.get(SESSION_COOKIE), settings.session_hours * 3600) or {}
    if _ask_rate_limited(f"{_client_ip(request)}:{session.get('n', '-')}"):
        return {"ok": False, "reason": "rate"}

    question = body.question.strip()[:settings.ask_max_question_chars]
    if not question:
        return {"ok": False, "reason": "empty"}

    ctx = ask_mod.build_context(_ar_for(viewer), body.salesperson)
    if ctx is None:
        return {"ok": False, "reason": "no-data"}

    # An explicitly chosen model is only honoured if the key really offers it,
    # so nothing a browser sends can reach Google as a model name.
    requested = (body.model or "").strip()
    if requested and requested not in _known_model_ids():
        requested = ""

    try:
        raw, used = _ask_with_failover(ctx, question, requested or None)
    except ProviderError as exc:
        # Logged for the operator, never shown to the salesperson: the frontend
        # just quietly drops back to the built-in parser.
        log.warning("Ask AI call failed, falling back: %s", exc)
        return {"ok": False, "reason": "quota" if exc.is_quota else "error"}

    spec = ask_mod.validate_spec(raw, ctx)

    # The filter fields could not carry the whole question ("due before the
    # 10th"), or validation stripped them down to nothing. Rather than answer a
    # broader question than was asked, show the model the actual invoice lines
    # and let it choose the rows. A refusal is already a complete answer, so it
    # is left alone.
    if not spec.get("refusal") and (spec.get("unsupported") or not _narrows(spec)):
        rows_ctx = ask_mod.build_rows(_ar_for(viewer), body.salesperson)
        if rows_ctx:
            try:
                praw, pused = _pick_with_failover(rows_ctx, question, requested or None)
                pick = ask_mod.validate_picks(praw, rows_ctx)
                # An empty pick with nothing to say is not an answer — it would
                # read as "you have none of those" on a question the model
                # simply could not place. The spec stands and the page flags it.
                if pick.get("rowIds") or pick.get("refusal"):
                    spec["pick"] = pick
                    used = pused
            except ProviderError as exc:
                # The filter-spec answer is already in hand and still worth
                # showing, flagged, so a failure here is not fatal.
                log.warning("Ask row-pick failed, keeping the filter answer: %s", exc)

    return {"ok": True, "spec": spec,
            "provider": _provider.name, "model": used,
            "narrate": settings.ask_narrate}


# ------------------------------------------------- ask (AI) — secondary sales
# Same contract as /api/ask above, against the field-activity dataset instead of
# the receivables book: the model chooses a table and a filter, the browser
# computes every figure from the real rows. See app/ask_sec.py.
class AskSecRequest(BaseModel):
    question: str = Field(min_length=1)
    person: int = Field(ge=-1)             # -1 = "All": everyone the viewer can see
    model: Optional[str] = Field(default=None, max_length=100)
    # The month on screen. Person indices differ between months, so the
    # question must be answered from the same file the page was built from.
    month: Optional[str] = Field(default=None, max_length=7)


@app.post("/api/ask/sec")
def api_ask_sec(request: Request, body: AskSecRequest):
    viewer = _viewer(request)
    if viewer is None:
        return JSONResponse({"error": "unauthorised"}, status_code=401)
    if not (settings.ask_ai_enabled and _provider):
        return {"ok": False, "reason": "disabled"}

    session = _read_cookie(request.cookies.get(SESSION_COOKIE), settings.session_hours * 3600) or {}
    if _ask_rate_limited(f"sec:{_client_ip(request)}:{session.get('n', '-')}"):
        return {"ok": False, "reason": "rate"}

    question = body.question.strip()[:settings.ask_max_question_chars]
    if not question:
        return {"ok": False, "reason": "empty"}

    ctx = ask_sec_mod.build_context(_sec_for(viewer, body.month), body.person)
    if ctx is None or not ask_sec_mod.has_any_activity(ctx):
        # Nothing to filter: the page says so itself, without spending a call.
        return {"ok": False, "reason": "no-data"}

    requested = (body.model or "").strip()
    if requested and requested not in _known_model_ids():
        requested = ""

    try:
        raw, used = _call_with_failover(
            ask_sec_mod.SYSTEM, ask_sec_mod.build_prompt(ctx, question),
            ask_sec_mod.SPEC_SCHEMA, requested or None)
    except ProviderError as exc:
        log.warning("Secondary Ask AI call failed, falling back: %s", exc)
        return {"ok": False, "reason": "quota" if exc.is_quota else "error"}

    spec = ask_sec_mod.validate_spec(raw, ctx)

    # The model did not place the question on any table and nothing it returned
    # narrows the query. Answering anyway would print a month's sales total
    # under whatever was asked, so the built-in parser gets a turn instead.
    if spec.get("guessedDataset") and not ask_sec_mod.narrows(spec) and not spec.get("refusal"):
        return {"ok": False, "reason": "empty"}

    return {"ok": True, "spec": spec,
            "provider": _provider.name, "model": used,
            "narrate": settings.ask_narrate}


def _sec_year_summary(viewer: users.Viewer, sec: dict, person: Optional[str]) -> Optional[dict]:
    """The person's full calendar year, as exact aggregates, for the analyst.
    `person` None means everyone the viewer can see (the "All" entry).

    The year is the one the month on screen falls in. Every month file is scoped
    to the same viewer as the month on screen, so this reaches no one the page
    itself could not show. A failure here costs only the year context, never
    the answer.
    """
    shown = _sec_month_of(sec)
    if not MONTH_RE.match(shown):
        return None
    try:
        months = [(m, sec if m == shown else _sec_for(viewer, m))
                  for m in _sec_months() if m[:4] == shown[:4]]
        current = date.today().strftime("%Y-%m")
        return ask_sec_mod.build_year_summary(
            months, person, current if any(m == current for m, _ in months) else None)
    except Exception:  # noqa: BLE001 — a damaged month file must not sink the answer
        log.exception("Secondary analyst: year summary failed")
        return None


# ------------------------------------------- secondary sales: compare people
# The Compare tab's month-by-month trend. Everything else on that tab is
# worked out in the browser from the month on screen; only the rest of the
# year needs the other month files. Each file is scoped to the viewer, so a
# name the viewer cannot see simply comes back empty.
COMPARE_MAX = 3


class CompareSecRequest(BaseModel):
    people: List[str] = Field(min_length=1, max_length=COMPARE_MAX)
    month: Optional[str] = Field(default=None, max_length=7)


@app.post("/api/compare/sec")
def api_compare_sec(request: Request, body: CompareSecRequest):
    viewer = _viewer(request)
    if viewer is None:
        return JSONResponse({"ok": False, "error": "Not signed in"}, status_code=401)
    shown = body.month if body.month and MONTH_RE.match(body.month) \
        else _sec_month_of(_load(SEC_PATH))
    if not MONTH_RE.match(shown):
        return {"ok": False, "error": "No secondary sales data"}
    months = [(m, _sec_for(viewer, m)) for m in _sec_months()
              if m[:4] == shown[:4] and m <= shown]
    if not months:
        return {"ok": False, "error": "No months stored for this year"}
    current = date.today().strftime("%Y-%m")
    out: Dict[str, Any] = {}
    for name in dict.fromkeys(body.people):          # de-duplicated, order kept
        y = ask_sec_mod.build_year_summary(
            months, name, current if any(m == current for m, _ in months) else None)
        out[name] = None if y is None else {
            "perMonth": y["perMonth"], "total": y["total"],
            "categories": [[c[0], c[1]] for c in y["categories"][:10]],
        }
    return {"ok": True, "months": [m for m, _ in months],
            "inProgress": current if any(m == current for m, _ in months) else None,
            "people": out}


# --------------------------------------------- ask (AI) — secondary, analyst
# The live path for a typed question. Unlike /api/ask/sec above, the model is
# given this person's real rows and real amounts and answers directly: it ranks,
# compares and states figures itself.
#
# This means the figures in the reply are the MODEL's, not this application's,
# and can disagree with the Overview tab. That is understood and intended — the
# owner asked for an analyst rather than a translator. Exact subtotals are sent
# alongside the rows and the model is told to quote them, which narrows the gap
# without closing it, and every answer is labelled in the UI.
def _unescape_model_text(text: str) -> str:
    """Turn line breaks a model double-escaped back into real ones.

    In JSON mode some Gemini models return "\\n" — a backslash and an n — where
    a newline was meant. The page renders markdown line by line, so without
    this the whole answer collapses into one paragraph with literal "\\n" in
    it, and bullet asterisks are misread as italics.
    """
    return text.replace("\\r\\n", "\n").replace("\\n", "\n")


@app.post("/api/ask/sec/analyst")
def api_ask_sec_analyst(request: Request, body: AskSecRequest):
    viewer = _viewer(request)
    if viewer is None:
        return JSONResponse({"error": "unauthorised"}, status_code=401)
    if not (settings.ask_ai_enabled and _provider and settings.ask_analyst):
        return {"ok": False, "reason": "disabled"}

    session = _read_cookie(request.cookies.get(SESSION_COOKIE), settings.session_hours * 3600) or {}
    if _ask_rate_limited(f"sec-analyst:{_client_ip(request)}:{session.get('n', '-')}"):
        return {"ok": False, "reason": "rate"}

    question = body.question.strip()[:settings.ask_max_question_chars]
    if not question:
        return {"ok": False, "reason": "empty"}

    sec = _sec_for(viewer, body.month)
    payload = ask_sec_mod.build_analyst_payload(sec, body.person)
    if payload is None:
        return {"ok": False, "reason": "no-data"}
    payload["year"] = _sec_year_summary(
        viewer, sec, None if body.person == ask_sec_mod.ALL_PEOPLE else payload["person"])
    if not any(t["lines"] for t in payload["tables"].values()) and not payload["year"]:
        # No rows at all for this person: there is nothing to analyse, and the
        # page says so itself without spending a call.
        return {"ok": False, "reason": "no-data"}

    requested = (body.model or "").strip()
    if requested and requested not in _known_model_ids():
        requested = ""

    try:
        raw, used = _call_with_failover(
            ask_sec_mod.ANALYST_SYSTEM,
            ask_sec_mod.build_analyst_prompt(payload, question),
            ask_sec_mod.ANALYST_SCHEMA, requested or None,
            timeout=settings.ask_analyst_timeout_seconds,
            max_output_tokens=settings.ask_analyst_max_tokens,
            # Let the model reason. Ranking outlets and weighing a conclusion is
            # the work; a zero budget here produces confident, shallow answers.
            thinking_budget=-1)
    except ProviderError as exc:
        log.warning("Secondary analyst call failed, falling back: %s", exc)
        return {"ok": False, "reason": "quota" if exc.is_quota else "error"}

    answer = _unescape_model_text(str(raw.get("answer", ""))).strip()
    if not answer:
        # An empty answer is a failed call, not an analysis. Say so, so the
        # browser falls back rather than rendering a blank card.
        return {"ok": False, "reason": "empty"}

    return {"ok": True,
            "answer": answer[:settings.ask_analyst_max_chars],
            "caveat": _unescape_model_text(str(raw.get("caveat", ""))).strip()[:400],
            "exactOnly": bool(raw.get("usedExactTotals")),
            "provider": _provider.name, "model": used}


class NarrateRequest(BaseModel):
    """The result the BROWSER computed, sent back for wording only."""
    question: str = Field(min_length=1)
    headline: str = Field(default="", max_length=120)
    heading: str = Field(default="", max_length=200)
    note: str = Field(default="", max_length=600)
    columns: List[str] = Field(default_factory=list, max_length=8)
    rows: List[List[str]] = Field(default_factory=list, max_length=25)
    more: int = Field(default=0, ge=0)
    model: Optional[str] = Field(default=None, max_length=100)


@app.post("/api/ask/narrate")
def api_narrate(request: Request, body: NarrateRequest):
    """Turn an already-computed result into a few sentences of plain English.

    Nothing here computes anything. If the model states a figure that is not in
    the result it was given, the narrative is thrown away rather than shown.
    """
    if not _is_authed(request):
        return JSONResponse({"error": "unauthorised"}, status_code=401)
    if not (settings.ask_ai_enabled and _provider and settings.ask_narrate):
        return {"ok": False, "reason": "disabled"}

    session = _read_cookie(request.cookies.get(SESSION_COOKIE), settings.session_hours * 3600) or {}
    if _ask_rate_limited(f"narrate:{_client_ip(request)}:{session.get('n', '-')}"):
        return {"ok": False, "reason": "rate"}

    result = {
        "headline": body.headline, "heading": body.heading, "note": body.note,
        "columns": body.columns,
        "rows": [[str(c)[:120] for c in row[:8]] for row in body.rows],
        "more": body.more,
    }
    prompt = ask_mod.build_narrate_prompt(
        body.question.strip()[:settings.ask_max_question_chars], result)

    requested = (body.model or "").strip()
    if requested and requested not in _known_model_ids():
        requested = ""

    try:
        raw, used = _call_with_failover(
            ask_mod.NARRATE_SYSTEM, prompt, ask_mod.NARRATE_SCHEMA, requested or None)
    except ProviderError as exc:
        log.info("narration unavailable (%s); the computed answer stands alone", exc)
        return {"ok": False, "reason": "quota" if exc.is_quota else "error"}

    answer = ask_mod.verify_narrative(_unescape_model_text(str(raw.get("answer", ""))),
                                      result, body.question)
    if answer is None:
        log.warning("narrative quoted a figure not in the result; discarded (model=%s)", used)
        return {"ok": False, "reason": "unverified"}
    return {"ok": True, "text": answer, "model": used}


# ----------------------------------------------------------------------- admin
@app.get("/admin/login", response_class=HTMLResponse)
def admin_login_form(request: Request, error: str = ""):
    if not _is_authed(request):
        return RedirectResponse("/login", status_code=303)
    msg = {"bad": "Admin password not recognised.",
           "rate": "Too many attempts. Please wait a few minutes."}.get(error, "")
    return _gate("Data administration", "Enter the admin password to continue.", "/admin/login",
                 _field("password", "password", "Admin password", "current-password", autofocus=True),
                 error=msg, title="Sales Intelligence — Admin",
                 hint="Admin access is separate from your own sign-in.")


@app.post("/admin/login")
def admin_login(request: Request, password: str = Form("")):
    if not _is_authed(request):
        return RedirectResponse("/login", status_code=303)
    ip = _client_ip(request)
    if _too_many_attempts(ip):
        return RedirectResponse("/admin/login?error=rate", status_code=303)
    if not _check_password(password, settings.admin_password_hash):
        _record_attempt(ip)
        return RedirectResponse("/admin/login?error=bad", status_code=303)
    resp = RedirectResponse("/admin", status_code=303)
    _set_cookie(resp, ADMIN_COOKIE, _make_cookie({"role": "admin", "n": secrets.token_hex(4)}),
                settings.admin_session_minutes * 60)
    return resp


@app.get("/admin", response_class=HTMLResponse)
def admin(request: Request, msg: str = "", err: str = ""):
    if not _is_authed(request):
        return RedirectResponse("/login", status_code=303)
    if not _is_admin(request):
        return RedirectResponse("/admin/login", status_code=303)
    return _admin_page(html.escape(msg), html.escape(err))


def _admin_page(msg: str = "", err: str = "", reveal: str = "") -> str:
    """`msg`/`err` are already-escaped HTML. `reveal` (a new password) is
    rendered into this one response only — never into a URL, where it would
    end up in browser history and server logs."""
    ar = _load(AR_PATH)
    sec = _load(SEC_PATH)
    m = _meta()
    acc = user_store.accounts_summary()
    d = user_store.directory
    return _template(
        "admin.html",
        ar_report_date=ar.get("reportDate", "—"),
        ar_lines=len(ar.get("lines", [])),
        ar_people=len(ar.get("salespeople", [])),
        ar_total=f"{sum(l[6] for l in ar.get('lines', [])):,.2f}" if ar else "—",
        ar_updated=m.get("ar", {}).get("updated", "seeded"),
        ar_source=m.get("ar", {}).get("source", "initial dataset"),
        ar_api_disabled="" if settings.bc_ar_api_url else "disabled",
        ar_refresh_schedule=html.escape(_ar_refresh_status()),
        ar_refresh_last=html.escape(_ar_last_refresh()),
        sec_period=f"{sec.get('periodFrom', '—')} to {sec.get('periodTo', '—')}",
        sec_people=len(sec.get("people", [])),
        sec_visits=len(sec.get("visits", [])),
        sec_months=html.escape(", ".join(_sec_months()) or "—"),
        sec_updated=m.get("sec", {}).get("updated", "seeded"),
        sec_source=m.get("sec", {}).get("source", "initial dataset"),
        sec_refresh_schedule=html.escape(_sec_refresh_status()),
        sec_refresh_last=html.escape(_sec_last_refresh()),
        sec_refresh_disabled="" if settings.sec_source_url else "disabled",
        users_employees=acc["employees"],
        users_eligible=acc["eligible"],
        users_with_pw=acc["withPassword"],
        users_full_view=html.escape(", ".join(d.employees[c]["name"] for c in d.full_view
                                              if c in d.employees) or "nobody"),
        users_shared="on" if settings.site_password_hash else "off",
        reveal=reveal,
        today=date.today().isoformat(),
        msg=msg, err=err,
    )


@app.post("/admin/users/reset", response_class=HTMLResponse)
def admin_user_reset(request: Request, email: str = Form("")):
    """New random password for one person (also how a new joiner gets one)."""
    if not _is_authed(request) or not _is_admin(request):
        return RedirectResponse("/admin/login", status_code=303)
    email = email.strip().lower()
    d = user_store.directory
    code = d.by_email.get(email)
    if not code:
        return _admin_page(err=f"{html.escape(email)} is not in the employee directory.")
    if not d.can_login(code):
        return _admin_page(err=f"{html.escape(email)} has status "
                               f"{html.escape(d.employees[code].get('status', ''))}: no login.")
    pw = users.generate_password()
    user_store.set_password(email, pw, by="admin")
    log.info("admin reset the password for %s", email)
    name = html.escape(d.employees[code].get("name", email))
    return _admin_page(
        msg=f"New password for {name} set. Any session they had is signed out.",
        reveal=(f'<div class="reveal"><span>{name} · {html.escape(email)}</span>'
                f'<code>{html.escape(pw)}</code>'
                f'<small>Shown once. Copy it now and give it to them directly.</small></div>'))


@app.post("/admin/users/import")
async def admin_user_import(request: Request, file: UploadFile = File(...)):
    """Replace the directory from a new copy of the employee master workbook."""
    if not _is_authed(request) or not _is_admin(request):
        return RedirectResponse("/admin/login", status_code=303)
    from urllib.parse import quote
    raw = await file.read()
    if len(raw) > settings.max_upload_mb * 1024 * 1024:
        return RedirectResponse(f"/admin?err=File+exceeds+{settings.max_upload_mb}+MB", status_code=303)
    tmp = DATA_DIR / "employee-master-upload.xlsx"
    try:
        tmp.write_bytes(raw)
        payload = users.import_master(tmp, DATA_DIR, [], [])
    except Exception as exc:  # surfaced to the admin, never to salespeople
        return RedirectResponse(f"/admin?err={quote(str(exc)[:400])}", status_code=303)
    finally:
        tmp.unlink(missing_ok=True)
    n = len(payload["employees"])
    return RedirectResponse(f"/admin?msg={quote(f'Employee directory replaced from {file.filename}: {n} people')}",
                            status_code=303)


@app.post("/admin/upload")
async def admin_upload(request: Request, kind: str = Form(...), report_date: str = Form(""),
                       period: str = Form(""), file: UploadFile = File(...)):
    if not _is_authed(request) or not _is_admin(request):
        return RedirectResponse("/admin/login", status_code=303)
    name = (file.filename or "upload").lower()
    raw = await file.read()
    if len(raw) > settings.max_upload_mb * 1024 * 1024:
        return RedirectResponse(f"/admin?err=File+exceeds+{settings.max_upload_mb}+MB", status_code=303)
    try:
        if name.endswith(".json"):
            payload = json.loads(raw.decode("utf-8"))
            # accept either bare JSON or a "window.X_DATA = {...};" script
            if kind == "ar":
                _validate_ar(payload)
                _write_dataset(AR_PATH, payload, "ar", file.filename)
            else:
                _validate_sec(payload)
                month = _sec_month_of(payload)
                if not MONTH_RE.match(month):
                    raise ValueError("Secondary-sales JSON has no valid periodFrom date.")
                _write_sec_months({month: payload}, file.filename)
        elif name.endswith((".xlsx", ".xlsm", ".csv")):
            if kind == "ar":
                rd = date.fromisoformat(report_date) if report_date else date.today()
                payload = ar_excel.convert(raw, name, rd, BASE.parent / "config" / "ar_columns.json")
                _validate_ar(payload)
                _write_dataset(AR_PATH, payload, "ar", file.filename)
            else:
                # Every month in the workbook; a single month when one is given.
                datasets = (sec_excel.convert_all(raw) if not period else
                            {period: sec_excel.convert(raw, period)})
                _write_sec_months(datasets, file.filename)
        else:
            raise ValueError("Unsupported file type. Upload .xlsx, .csv or .json.")
    except Exception as exc:  # surfaced to the admin, never to salespeople
        from urllib.parse import quote
        return RedirectResponse(f"/admin?err={quote(str(exc)[:400])}", status_code=303)
    from urllib.parse import quote
    return RedirectResponse(f"/admin?msg={quote(f'{kind.upper()} dataset replaced from {file.filename}')}",
                            status_code=303)


@app.post("/admin/refresh-ar")
def admin_refresh_ar(request: Request):
    """Replace the receivables dataset from the Business Central API."""
    if not _is_authed(request) or not _is_admin(request):
        return RedirectResponse("/admin/login", status_code=303)
    from urllib.parse import quote
    try:
        message = refresh_ar_from_api("manual")
    except Exception as exc:  # surfaced to the admin, never to salespeople
        return RedirectResponse(f"/admin?err={quote(str(exc)[:400])}", status_code=303)
    return RedirectResponse(f"/admin?msg={quote(message[:600])}", status_code=303)


@app.post("/admin/refresh-sec")
def admin_refresh_sec(request: Request):
    """Pull the workbook from SharePoint now, instead of waiting for the schedule."""
    if not _is_authed(request) or not _is_admin(request):
        return RedirectResponse("/admin/login", status_code=303)
    from urllib.parse import quote
    try:
        message = refresh_sec_from_source("manual")
    except Exception as exc:  # surfaced to the admin, never to salespeople
        return RedirectResponse(f"/admin?err={quote(str(exc)[:400])}", status_code=303)
    return RedirectResponse(f"/admin?msg={quote(message)}", status_code=303)


@app.get("/admin/download/{kind}")
def admin_download(request: Request, kind: str):
    if not _is_authed(request) or not _is_admin(request):
        return RedirectResponse("/admin/login", status_code=303)
    path = AR_PATH if kind == "ar" else SEC_PATH
    if not path.exists():
        return PlainTextResponse("no dataset", status_code=404)
    return FileResponse(path, filename=path.name, media_type="application/json")
