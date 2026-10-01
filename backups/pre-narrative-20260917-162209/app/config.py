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
    # bcrypt hash of the shared password every salesperson uses
    site_password_hash: str = os.getenv("SITE_PASSWORD_HASH", "")
    # bcrypt hash of the admin password (data uploads). Keep it different.
    admin_password_hash: str = os.getenv("ADMIN_PASSWORD_HASH", "")
    # random secret used to sign session cookies; rotate to log everyone out
    secret_key: str = os.getenv("SECRET_KEY", "")
    # where datasets live; mount a persistent volume here in production
    data_dir: str = os.getenv("DATA_DIR", "./data")
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
    # 0 = no internal reasoning (right for a classification task, and fastest);
    # -1 = let the model decide. Pro models cannot go below 128.
    gemini_thinking_budget: int = int(os.getenv("GEMINI_THINKING_BUDGET", "0"))
    # Kept short: a salesperson waiting on an answer would rather fall back to
    # the built-in parser than watch a spinner.
    ask_timeout_seconds: float = float(os.getenv("ASK_TIMEOUT_SECONDS", "12"))
    ask_max_per_window: int = int(os.getenv("ASK_MAX_PER_WINDOW", "40"))
    ask_window_seconds: int = int(os.getenv("ASK_WINDOW_SECONDS", "300"))
    ask_max_question_chars: int = int(os.getenv("ASK_MAX_QUESTION_CHARS", "400"))


settings = Settings()

_missing = [n for n, v in (("SITE_PASSWORD_HASH", settings.site_password_hash),
                           ("ADMIN_PASSWORD_HASH", settings.admin_password_hash),
                           ("SECRET_KEY", settings.secret_key)) if not v]
if _missing:
    sys.stderr.write(
        "\n[NuTaste Sales Desk] Missing required environment variables: "
        + ", ".join(_missing)
        + "\nSee README.md → Configuration. Generate hashes with: python -m app.hash_password\n\n"
    )
    sys.exit(1)
