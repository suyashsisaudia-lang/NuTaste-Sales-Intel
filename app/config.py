"""
All runtime configuration comes from environment variables so the same
container runs unchanged on Azure App Service, Render, Railway, Fly.io or an
on-premise Docker host. Nothing secret is ever written into source code.

Generate password hashes with:  python -m app.hash_password
"""
import os
import sys
from dataclasses import dataclass


def _bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    # Optional. bcrypt hash of the old shared password. While set, it still
    # signs in with FULL view of every person's data; per-person logins
    # (app/users.py) are the normal way in. Remove it to retire shared access.
    site_password_hash: str = os.getenv("SITE_PASSWORD_HASH", "")
    # bcrypt hash of the admin password (data uploads). Keep it different.
    admin_password_hash: str = os.getenv("ADMIN_PASSWORD_HASH", "")
    # random secret used to sign session cookies; rotate to log everyone out
    secret_key: str = os.getenv("SECRET_KEY", "")
    # where datasets live; mount a persistent volume here in production
    data_dir: str = os.getenv("DATA_DIR", "./data")
    # Copied to DATA_DIR/credentials.json at startup when that file is missing
    # (hosts with no persistent disk). /etc/secrets is where Render mounts its
    # Secret Files. Blank disables it.
    credentials_seed_file: str = os.getenv("CREDENTIALS_SEED_FILE", "/etc/secrets/credentials.json")
    session_hours: int = int(os.getenv("SESSION_HOURS", "12"))
    admin_session_minutes: int = int(os.getenv("ADMIN_SESSION_MINUTES", "30"))
    login_max_attempts: int = int(os.getenv("LOGIN_MAX_ATTEMPTS", "5"))
    login_window_seconds: int = int(os.getenv("LOGIN_WINDOW_SECONDS", "300"))
    # set to false only for plain-HTTP local testing
    secure_cookies: bool = _bool("SECURE_COOKIES", True)
    max_upload_mb: int = int(os.getenv("MAX_UPLOAD_MB", "64"))

    # ---- Ask box: natural-language questions on the receivables page.
    # Entirely optional. With no API key the app boots and behaves exactly as it
    # did before, and the Ask box falls back to its built-in parser — so a
    # missing, revoked or exhausted key is never an outage.
    ask_ai_enabled: bool = _bool("ASK_AI_ENABLED", True)
    ask_provider: str = os.getenv("ASK_PROVIDER", "gemini")
    gemini_api_key: str = os.getenv("GEMINI_API_KEY", "")
    gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-3.6-flash")
    # Optional comma-separated preference order for "Auto". Leave blank to let
    # the app order whatever models the key can actually see, newest first.
    gemini_models: str = os.getenv("GEMINI_MODELS", "")
    # How long a model that returned "quota exceeded" is skipped by Auto. The
    # free tier's cap is daily, so a short cooldown just means Auto rechecks
    # occasionally instead of wasting a call on every question.
    ask_quota_cooldown_seconds: int = int(os.getenv("ASK_QUOTA_COOLDOWN_SECONDS", "1800"))
    # Write a plain-English paragraph above each answer. This is a SECOND call
    # per question, and unlike the first it sends computed figures — amounts,
    # customer names, due dates — to the provider. Turn it off to keep every
    # number inside your network.
    ask_narrate: bool = _bool("ASK_NARRATE", True)
    # 0 = no internal reasoning (right for a classification task, and fastest);
    # -1 = let the model decide. Pro models cannot go below 128.
    gemini_thinking_budget: int = int(os.getenv("GEMINI_THINKING_BUDGET", "0"))
    # Kept short: a salesperson waiting on an answer would rather fall back to
    # the built-in parser than watch a spinner.
    ask_timeout_seconds: float = float(os.getenv("ASK_TIMEOUT_SECONDS", "12"))
    ask_max_per_window: int = int(os.getenv("ASK_MAX_PER_WINDOW", "40"))
    ask_window_seconds: int = int(os.getenv("ASK_WINDOW_SECONDS", "300"))
    ask_max_question_chars: int = int(os.getenv("ASK_MAX_QUESTION_CHARS", "400"))
    # ---- analyst mode (the Secondary Sales Ask box)
    # The model is sent this person's real rows and answers with figures of its
    # own. Set ASK_ANALYST=0 to go back to filter-only answers, where every
    # number is computed from the rows by the application instead.
    ask_analyst: bool = _bool("ASK_ANALYST", True)
    ask_analyst_max_chars: int = int(os.getenv("ASK_ANALYST_MAX_CHARS", "4000"))
    # Analyst answers are prose, not a filter spec, and the model reasons before
    # writing — both are charged against this cap, so it is far higher than the
    # 2048 a classification needs.
    ask_analyst_max_tokens: int = int(os.getenv("ASK_ANALYST_MAX_TOKENS", "8192"))
    # Reading a few hundred rows and reasoning over them takes far longer than
    # classifying a sentence: measured at ~23s on gemini-3.5-flash for a month
    # of one person's activity. The failover walk gives each model half this
    # budget, so it has to be roughly four times the observed single-call time
    # for one model to answer after another has 429'd.
    ask_analyst_timeout_seconds: float = float(os.getenv("ASK_ANALYST_TIMEOUT_SECONDS", "75"))

    # ---- scheduled Secondary Sales refresh from SharePoint / OneDrive
    # The share link for the workbook. Treat it like a password: anyone holding
    # an "Anyone with the link" URL can download the file. Blank = no refresh.
    sec_source_url: str = os.getenv("SEC_SOURCE_URL", "")
    sec_refresh_enabled: bool = _bool("SEC_REFRESH_ENABLED", True)
    # 0 = Monday ... 6 = Sunday
    sec_refresh_weekday: int = int(os.getenv("SEC_REFRESH_WEEKDAY", "0"))
    sec_refresh_time: str = os.getenv("SEC_REFRESH_TIME", "11:00")
    # A fixed offset rather than a zone name: containers run on UTC and Windows
    # Python ships without tz data. 330 = IST (UTC+05:30), which has no DST.
    sec_refresh_utc_offset_minutes: int = int(os.getenv("SEC_REFRESH_UTC_OFFSET_MINUTES", "330"))
    sec_download_timeout_seconds: float = float(os.getenv("SEC_DOWNLOAD_TIMEOUT_SECONDS", "300"))
    # After a successful refresh, commit + push the data files so the Render
    # copy (which deploys from GitHub) catches up. Set on the office PC only.
    sec_auto_push: bool = _bool("SEC_AUTO_PUSH", False)
    sec_auto_push_branch: str = os.getenv("SEC_AUTO_PUSH_BRANCH", "main")

    # ---- Receivables from the Business Central OData API (app/ar_refresh.py)
    # The AgedReceivables endpoint and a BC web-service user (Basic auth).
    # Blank URL = the admin page's "Refresh from Business Central" is disabled.
    bc_ar_api_url: str = os.getenv("BC_AR_API_URL", "")
    bc_api_username: str = os.getenv("BC_API_USERNAME", "")
    bc_api_password: str = os.getenv("BC_API_PASSWORD", "")
    bc_api_timeout_seconds: float = float(os.getenv("BC_API_TIMEOUT_SECONDS", "120"))
    # Daily refresh from the API. Runs only when the URL and both credentials
    # are set; "false" stops the schedule but keeps the admin button working.
    ar_refresh_enabled: bool = _bool("AR_REFRESH_ENABLED", True)
    ar_refresh_time: str = os.getenv("AR_REFRESH_TIME", "11:00")
    ar_refresh_utc_offset_minutes: int = int(os.getenv("AR_REFRESH_UTC_OFFSET_MINUTES", "330"))
    # Commit + push ar_data.json after each refresh so Render catches up. Follows
    # SEC_AUTO_PUSH unless set on its own; meant for the office PC only.
    ar_auto_push: bool = _bool("AR_AUTO_PUSH", _bool("SEC_AUTO_PUSH", False))

    # ---- keep a free Render instance awake (app/keep_awake.py)
    # Render sets RENDER_EXTERNAL_URL on its own hosts, so this is on there and
    # off everywhere else without any configuration. Set KEEP_AWAKE_URL to ""
    # on Render to turn it off.
    keep_awake_url: str = os.getenv(
        "KEEP_AWAKE_URL",
        os.getenv("RENDER_EXTERNAL_URL", "").rstrip("/") + "/healthz"
        if os.getenv("RENDER_EXTERNAL_URL") else "")
    # Under Render's ~15-minute idle limit, with margin for a slow request.
    keep_awake_minutes: float = float(os.getenv("KEEP_AWAKE_MINUTES", "10"))


settings = Settings()

_missing = [n for n, v in (("ADMIN_PASSWORD_HASH", settings.admin_password_hash),
                           ("SECRET_KEY", settings.secret_key)) if not v]
if _missing:
    sys.stderr.write(
        "\n[NuTaste Sales Intel] Missing required environment variables: "
        + ", ".join(_missing)
        + "\nSee README.md → Configuration. Generate hashes with: python -m app.hash_password\n\n"
    )
    sys.exit(1)
