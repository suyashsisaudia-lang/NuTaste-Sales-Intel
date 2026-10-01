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
