"""
NuTaste Sales Desk — hosted backend.

Responsibilities
  * Shared-password gate for the whole site (bcrypt hash from env, rate-limited).
  * Signed, HttpOnly session cookie with expiry.
  * Serves the Sales Desk frontend and the two datasets (AR_DATA, SEC_DATA).
  * Admin area (separate password) to upload replacement datasets:
      - JSON in the app's native shape (either dataset), or
      - the Business Central AR Excel extract, converted by importers/ar_excel.py.
  * noindex headers + robots.txt so the site stays out of search engines.

The application is read-only with respect to any upstream system. When the
Business Central API is ready, replace the "upload" step with a scheduled job
that writes data/ar_data.json — nothing else needs to change.
"""

import json
import os
import secrets
import shutil
import time
from datetime import date
from pathlib import Path
from typing import Dict, List, Optional

import bcrypt
from fastapi import FastAPI, Form, Request, UploadFile, File
from fastapi.responses import (FileResponse, HTMLResponse, JSONResponse,
                               PlainTextResponse, RedirectResponse, Response)
from fastapi.staticfiles import StaticFiles
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from .config import settings
from .importers import ar_excel, sec_excel

BASE = Path(__file__).resolve().parent
DATA_DIR = Path(settings.data_dir)
DATA_DIR.mkdir(parents=True, exist_ok=True)
AR_PATH = DATA_DIR / "ar_data.json"
SEC_PATH = DATA_DIR / "sec_data.json"
META_PATH = DATA_DIR / "meta.json"

app = FastAPI(title="NuTaste Sales Desk", docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")

signer = URLSafeTimedSerializer(settings.secret_key, salt="nutaste-session")
SESSION_COOKIE = "nsd_session"
ADMIN_COOKIE = "nsd_admin"


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


def _is_authed(request: Request) -> bool:
    data = _read_cookie(request.cookies.get(SESSION_COOKIE), settings.session_hours * 3600)
    return bool(data and data.get("role") == "user")

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


@app.get("/login", response_class=HTMLResponse)
def login_form(request: Request, error: str = ""):
    if _is_authed(request):
        return RedirectResponse("/", status_code=303)
    msg = {"bad": "That password wasn't recognised.",
           "rate": "Too many attempts. Please wait a few minutes and try again.",
           "expired": "Your session expired. Please sign in again."}.get(error, "")
    return _template("login.html", error=msg, title="NuTaste Sales Desk",
                     heading="Sales Desk", action="/login", hint="Ask your manager or IT for the access password.")


@app.post("/login")
def login(request: Request, password: str = Form("")):
    ip = _client_ip(request)
    if _too_many_attempts(ip):
        return RedirectResponse("/login?error=rate", status_code=303)
    if not _check_password(password, settings.site_password_hash):
        _record_attempt(ip)
        return RedirectResponse("/login?error=bad", status_code=303)
    resp = RedirectResponse("/", status_code=303)
    _set_cookie(resp, SESSION_COOKIE, _make_cookie({"role": "user", "n": secrets.token_hex(4)}),
                settings.session_hours * 3600)
    return resp


@app.get("/logout")
def logout():
    resp = RedirectResponse("/login", status_code=303)
    resp.delete_cookie(SESSION_COOKIE, path="/")
    resp.delete_cookie(ADMIN_COOKIE, path="/")
    return resp


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    if not _is_authed(request):
        return RedirectResponse("/login", status_code=303)
    return _template("index.html")


def _dataset_js(request: Request, path: Path, var: str) -> Response:
    if not _is_authed(request):
        return Response("// unauthorised", status_code=401, media_type="application/javascript")
    body = path.read_text(encoding="utf-8") if path.exists() else "null"
    return Response(f"window.{var}={body};", media_type="application/javascript")


@app.get("/api/data/ar.js")
def ar_js(request: Request):
    return _dataset_js(request, AR_PATH, "AR_DATA")


@app.get("/api/data/sec.js")
def sec_js(request: Request):
    return _dataset_js(request, SEC_PATH, "SEC_DATA")


@app.get("/api/meta")
def meta(request: Request):
    if not _is_authed(request):
        return JSONResponse({"error": "unauthorised"}, status_code=401)
    ar = _load(AR_PATH)
    sec = _load(SEC_PATH)
    return {
        "ar": {"reportDate": ar.get("reportDate"), "lines": len(ar.get("lines", [])),
               "salespeople": len(ar.get("salespeople", [])), **_meta().get("ar", {})},
        "sec": {"periodFrom": sec.get("periodFrom"), "periodTo": sec.get("periodTo"),
                "people": len(sec.get("people", [])), **_meta().get("sec", {})},
    }


# ----------------------------------------------------------------------- admin
@app.get("/admin/login", response_class=HTMLResponse)
def admin_login_form(request: Request, error: str = ""):
    if not _is_authed(request):
        return RedirectResponse("/login", status_code=303)
    msg = {"bad": "Admin password not recognised.",
           "rate": "Too many attempts. Please wait a few minutes."}.get(error, "")
    return _template("login.html", error=msg, title="Sales Desk — Admin",
                     heading="Data administration", action="/admin/login",
                     hint="Admin access is separate from the shared site password.")


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
    ar = _load(AR_PATH)
    sec = _load(SEC_PATH)
    m = _meta()
    return _template(
        "admin.html",
        ar_report_date=ar.get("reportDate", "—"),
        ar_lines=len(ar.get("lines", [])),
        ar_people=len(ar.get("salespeople", [])),
        ar_total=f"{sum(l[6] for l in ar.get('lines', [])):,.2f}" if ar else "—",
        ar_updated=m.get("ar", {}).get("updated", "seeded"),
        ar_source=m.get("ar", {}).get("source", "initial dataset"),
        sec_period=f"{sec.get('periodFrom', '—')} to {sec.get('periodTo', '—')}",
        sec_people=len(sec.get("people", [])),
        sec_visits=len(sec.get("visits", [])),
        sec_updated=m.get("sec", {}).get("updated", "seeded"),
        sec_source=m.get("sec", {}).get("source", "initial dataset"),
        today=date.today().isoformat(),
        msg=msg, err=err,
    )


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
                _write_dataset(SEC_PATH, payload, "sec", file.filename)
        elif name.endswith((".xlsx", ".xlsm", ".csv")):
            if kind == "ar":
                rd = date.fromisoformat(report_date) if report_date else date.today()
                payload = ar_excel.convert(raw, name, rd, BASE.parent / "config" / "ar_columns.json")
                _validate_ar(payload)
                _write_dataset(AR_PATH, payload, "ar", file.filename)
            else:
                payload = sec_excel.convert(raw, period or None)
                _validate_sec(payload)
                _write_dataset(SEC_PATH, payload, "sec",
                               f"{file.filename} ({payload['importNotes']['period']})")
        else:
            raise ValueError("Unsupported file type. Upload .xlsx, .csv or .json.")
    except Exception as exc:  # surfaced to the admin, never to salespeople
        from urllib.parse import quote
        return RedirectResponse(f"/admin?err={quote(str(exc)[:400])}", status_code=303)
    from urllib.parse import quote
    return RedirectResponse(f"/admin?msg={quote(f'{kind.upper()} dataset replaced from {file.filename}')}",
                            status_code=303)


@app.get("/admin/download/{kind}")
def admin_download(request: Request, kind: str):
    if not _is_authed(request) or not _is_admin(request):
        return RedirectResponse("/admin/login", status_code=303)
    path = AR_PATH if kind == "ar" else SEC_PATH
    if not path.exists():
        return PlainTextResponse("no dataset", status_code=404)
    return FileResponse(path, filename=path.name, media_type="application/json")
