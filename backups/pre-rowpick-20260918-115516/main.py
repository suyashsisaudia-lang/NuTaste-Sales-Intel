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
import logging
import os
import secrets
import shutil
import time
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional

import bcrypt
from fastapi import FastAPI, Form, Request, UploadFile, File
from fastapi.responses import (FileResponse, HTMLResponse, JSONResponse,
                               PlainTextResponse, RedirectResponse, Response)
from fastapi.staticfiles import StaticFiles
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel, Field

from . import ask as ask_mod
from .config import settings
from .importers import ar_excel, sec_excel
from .providers import ProviderError, get_provider

log = logging.getLogger("nutaste.ask")

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


def _call_with_failover(system: str, prompt: str, schema: dict,
                        requested: Optional[str]):
    """Try models in turn until one answers. Returns (raw_json, model_used).

    A model that is out of quota, overloaded, retired or that rejects the
    request hands over to the next one. A bad key stops immediately — retrying
    it on five models would just take five times as long to fail the same way.
    """
    if requested:
        candidates = [requested]        # an explicit choice is honoured as-is
    else:
        candidates = [m for m in _auto_order() if not _cooling_down(m)] or _auto_order()

    # One deadline for the whole walk, not per model — otherwise trying five
    # models could take five times the timeout the caller agreed to. Each model
    # gets at most half the budget, so a slow first choice can never consume
    # the lot and leave no room for a second.
    deadline = time.monotonic() + settings.ask_timeout_seconds
    per_model = max(MIN_MODEL_SECONDS, settings.ask_timeout_seconds / 2)

    last: Optional[ProviderError] = None
    for model in candidates[:5]:        # a bounded walk, so one question cannot stall
        remaining = deadline - time.monotonic()
        if remaining < MIN_MODEL_SECONDS:
            log.info("out of time after %s, stopping the walk", model)
            break
        try:
            raw = _provider.for_model(model, timeout=min(per_model, remaining)) \
                           .structured_json(system, prompt, schema)
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
    salesperson: int = Field(ge=0)
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
            "timeoutMs": int(settings.ask_timeout_seconds * 1000) + 3000}


@app.post("/api/ask")
def api_ask(request: Request, body: AskRequest):
    if not _is_authed(request):
        return JSONResponse({"error": "unauthorised"}, status_code=401)
    if not (settings.ask_ai_enabled and _provider):
        return {"ok": False, "reason": "disabled"}

    session = _read_cookie(request.cookies.get(SESSION_COOKIE), settings.session_hours * 3600) or {}
    if _ask_rate_limited(f"{_client_ip(request)}:{session.get('n', '-')}"):
        return {"ok": False, "reason": "rate"}

    question = body.question.strip()[:settings.ask_max_question_chars]
    if not question:
        return {"ok": False, "reason": "empty"}

    ctx = ask_mod.build_context(_load(AR_PATH), body.salesperson)
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

    return {"ok": True, "spec": ask_mod.validate_spec(raw, ctx),
            "provider": _provider.name, "model": used,
            "narrate": settings.ask_narrate}


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

    answer = ask_mod.verify_narrative(str(raw.get("answer", "")), result, body.question)
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
