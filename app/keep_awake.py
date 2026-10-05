"""
Keeps a free Render instance from spinning down.

Render's free plan stops a web service after ~15 minutes without inbound
traffic, and the next visitor then waits 30-60 s for it to boot. This thread
requests the site's own *public* URL on a timer. Going out through the public
URL matters: the request comes back in through Render's proxy, which is what
Render counts as traffic. Calling 127.0.0.1 would not.

Cost: an always-awake service uses ~744 of the 750 free instance hours a month,
so this only fits if it is the one free service in the Render workspace.

A daemon thread in the web process, like the Secondary Sales scheduler: one
uvicorn process runs one pinger.
"""
import logging
import threading
from typing import Optional

import httpx

log = logging.getLogger("nutaste.keepawake")


class KeepAwake:
    def __init__(self, url: str, interval_seconds: float):
        self.url = url
        self.interval = interval_seconds
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._loop, name="keep-awake", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        log.info("Keep-awake: requesting %s every %.0f min", self.url, self.interval / 60)
        failures = 0
        # Wait first: the service has just started, so it is already awake.
        while not self._stop.wait(self.interval):
            try:
                resp = httpx.get(self.url, timeout=30, follow_redirects=True)
                if resp.status_code != 200:
                    raise httpx.HTTPError(f"HTTP {resp.status_code}")
                if failures:
                    log.info("Keep-awake: %s reachable again", self.url)
                failures = 0
            except httpx.HTTPError as exc:
                failures += 1
                # Log the first failure and then every sixth (~hourly at 10 min),
                # so a long outage does not flood the log.
                if failures == 1 or failures % 6 == 0:
                    log.warning("Keep-awake request failed (%d in a row): %s", failures, exc)
