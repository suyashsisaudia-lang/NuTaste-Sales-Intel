"""
Commit and push the Secondary Sales (and receivables) data files to GitHub
after a refresh.

The hosted copy on Render builds from the GitHub repo and has no SharePoint
refresh of its own that survives a restart, so the office PC is the source of
truth: every successful refresh here is committed and pushed, and Render's
auto-deploy picks it up.

Only the data paths below are ever staged or committed (``git commit --only``),
so unrelated edits in the working tree are left alone. This is opt-in via
SEC_AUTO_PUSH and is meant for the PC only; the Docker image has no git.
"""
from __future__ import annotations

import logging
import os
import subprocess
import threading
from pathlib import Path
from typing import List

log = logging.getLogger("nutaste.ask")

DATA_PATHS = ["data/meta.json", "data/sec_data.json", "data/sec_months"]
AR_DATA_PATHS = ["data/meta.json", "data/ar_data.json"]

# One push at a time; a second refresh finishing mid-push just waits its turn.
_lock = threading.Lock()


class PushError(RuntimeError):
    pass


def _git(root: Path, *args: str, timeout: float = 120) -> subprocess.CompletedProcess:
    # Never let git or Credential Manager open a prompt: the web process runs
    # in a hidden window and would hang waiting for an answer nobody sees.
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="never")
    return subprocess.run(["git", *args], cwd=root, env=env, capture_output=True,
                          text=True, timeout=timeout)


def _check(proc: subprocess.CompletedProcess, what: str) -> None:
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip().splitlines()
        raise PushError(f"git {what} failed: {detail[-1] if detail else proc.returncode}")


def push_data(root: Path, message: str, branch: str = "main",
              data_paths: List[str] = DATA_PATHS) -> str:
    """Commit the data files if they changed, then push. Returns a summary.

    The push runs even when there is nothing new to commit, so a push that
    failed last week (network down, remote ahead) is retried on the next run.
    """
    with _lock:
        current = _git(root, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
        if current != branch:
            raise PushError(f"working copy is on '{current}', not '{branch}'; not pushing")
        paths: List[str] = [p for p in data_paths if (root / p).exists()]
        _check(_git(root, "add", "--", *paths), "add")
        changed = _git(root, "diff", "--cached", "--quiet", "--", *paths).returncode == 1
        if changed:
            _check(_git(root, "commit", "--only", "-m", message, "--", *paths), "commit")
        _check(_git(root, "push", "origin", f"HEAD:{branch}", timeout=300), "push")
        return "committed and pushed" if changed else "nothing new; pushed pending commits"


def push_in_background(root: Path, message: str, branch: str = "main",
                       data_paths: List[str] = DATA_PATHS) -> None:
    """Fire-and-forget wrapper so a slow push never holds up the refresh."""
    def run() -> None:
        try:
            log.info("Data push: %s", push_data(root, message, branch, data_paths))
        except Exception as exc:  # logged, retried on the next refresh
            log.warning("Data push failed: %s", exc)

    threading.Thread(target=run, name="data-push", daemon=True).start()
