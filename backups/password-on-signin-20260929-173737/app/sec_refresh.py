"""
Weekly Secondary Sales refresh from a SharePoint / OneDrive share link.

This module only fetches bytes and decides *when* to run. Converting and
writing the dataset stays in main.py, so a scheduled refresh goes through the
exact same importer, validation and backup path as a manual upload.

The scheduler is a single daemon thread inside the web process. That is
correct for one uvicorn process (how this app is run, on Windows and in
Docker); running several workers would schedule the refresh once per worker.
"""
import logging
import threading
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

log = logging.getLogger("nutaste.refresh")

WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
RETRY_MINUTES = 60
MAX_RETRIES = 3

class RefreshError(Exception):
    """A refresh failed; the message is shown to the admin."""


# ---------------------------------------------------------------- download
def _direct_download_url(url: str) -> str:
    """A share link opens Excel Online; `download=1` returns the file itself."""
    parts = urlsplit(url.strip())
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query["download"] = "1"
    return urlunsplit(parts._replace(query=urlencode(query)))

def download(url: str, timeout: float, max_bytes: int) -> bytes:
    """Fetch the workbook, refusing anything that is not an .xlsx file."""
    if not url:
        raise RefreshError("SEC_SOURCE_URL is not set.")
    try:
        with httpx.Client(follow_redirects=True, timeout=timeout) as client:
            with client.stream("GET", _direct_download_url(url)) as resp:
                if resp.status_code in (401, 403):
                    raise RefreshError(
                        f"SharePoint refused the download (HTTP {resp.status_code}). "
                        "The share link may have expired or been restricted to signed-in users.")
                if resp.status_code != 200:
                    raise RefreshError(f"SharePoint returned HTTP {resp.status_code}.")
                chunks, size = [], 0
                for chunk in resp.iter_bytes():
                    size += len(chunk)
                    if size > max_bytes:
                        raise RefreshError(f"The workbook exceeds {max_bytes // (1024 * 1024)} MB.")
                    chunks.append(chunk)
    except httpx.HTTPError as exc:
        raise RefreshError(f"Could not reach SharePoint: {exc}") from exc

    raw = b"".join(chunks)
    if not raw.startswith(b"PK"):
        raise RefreshError(
            "The link did not return an Excel file (probably a sign-in page). "
            "Check that the share link still allows download.")
    return raw


# ---------------------------------------------------------------- schedule
class Schedule:
    def __init__(self, weekday: int, hhmm: str, utc_offset_minutes: int):
        if not 0 <= weekday <= 6:
            raise ValueError("SEC_REFRESH_WEEKDAY must be 0 (Monday) to 6 (Sunday)")
        hour, minute = (int(p) for p in hhmm.split(":"))
        self.weekday, self.hour, self.minute = weekday, hour, minute
        self.tz = timezone(timedelta(minutes=utc_offset_minutes))

    def now(self) -> datetime:
        return datetime.now(self.tz)

    def last_slot(self, now: Optional[datetime] = None) -> datetime:
        """The most recent scheduled time at or before `now`."""
        now = (now or self.now()).astimezone(self.tz)
        slot = now.replace(hour=self.hour, minute=self.minute, second=0, microsecond=0)
        slot -= timedelta(days=(now.weekday() - self.weekday) % 7)
        if slot > now:
            slot -= timedelta(days=7)
        return slot

    def next_slot(self, now: Optional[datetime] = None) -> datetime:
        return self.last_slot(now) + timedelta(days=7)

    def describe(self) -> str:
        off = self.tz.utcoffset(None)
        sign = "+" if off >= timedelta(0) else "-"
        mins = abs(int(off.total_seconds() // 60))
        return (f"{WEEKDAYS[self.weekday]}s {self.hour:02d}:{self.minute:02d} "
                f"(UTC{sign}{mins // 60:02d}:{mins % 60:02d})")


class Scheduler:
    """Runs `job` weekly. `last_attempt` lets a run missed while the site was
    down (PC off on Monday morning) happen as soon as it starts again."""

    def __init__(self, schedule: Schedule, job: Callable[[str], None],
                 last_attempt: Callable[[], Optional[datetime]]):
        self.schedule = schedule
        self._job = job
        self._last_attempt = last_attempt
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.next_run: Optional[datetime] = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._loop, name="sec-refresh", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _first_run(self) -> datetime:
        now = self.schedule.now()
        last = self._last_attempt()
        if last is None or last < self.schedule.last_slot(now):
            return now + timedelta(seconds=30)
        return self.schedule.next_slot(now)

    def _loop(self) -> None:
        self.next_run = self._first_run()
        retries = 0
        log.info("Secondary Sales refresh scheduled: %s; next run %s",
                 self.schedule.describe(), self.next_run.isoformat(timespec="minutes"))
        while not self._stop.is_set():
            wait = (self.next_run - self.schedule.now()).total_seconds()
            if wait > 0:
                self._stop.wait(min(wait, 3600))
                continue
            ok = False
            try:
                self._job("scheduled")
                ok = True
            except Exception:           
                log.exception("scheduled Secondary Sales refresh failed")
            now = self.schedule.now()
            if ok or retries >= MAX_RETRIES:
                retries = 0
                self.next_run = self.schedule.next_slot(now)
            else:
                retries += 1
                self.next_run = min(now + timedelta(minutes=RETRY_MINUTES),
                                    self.schedule.next_slot(now))
            log.info("next Secondary Sales refresh %s", self.next_run.isoformat(timespec="minutes"))