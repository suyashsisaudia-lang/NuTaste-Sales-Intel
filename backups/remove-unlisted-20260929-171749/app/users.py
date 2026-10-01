"""
Per-person sign-in, and the reporting tree that decides what each person sees.

Two files in DATA_DIR, both written only by this module:

  employees.json    The directory: who exists, their login email and who they
                    report to. Imported from HR's "Super Employee Master"
                    workbook (Book4.xlsx) with `python -m app.users import`.
  credentials.json  One bcrypt hash per login email. Never sent to a browser,
                    never copied into the Docker image (.dockerignore).

Visibility rule
  A person sees their own rows and the rows of everyone below them in the
  tree. Codes listed under "fullView" (the head of sales) see every row,
  including rows for people the directory does not know — leavers, test
  accounts — which would otherwise be visible to nobody. Full view is an
  explicit list rather than "whoever has no manager", so a mistyped manager
  code in the workbook cannot silently hand someone the whole company.

Matching dataset names to people
  The source systems spell names their own way ("Md.Kahshan", "Shrish singh").
  A dataset name is resolved to an employee code by, in order:
    1. the employee code the Secondary Sales roster carries, when the
       directory knows that code;
    2. an alias (a normalised spelling mapped to a code);
    3. the directory name itself, ignoring case, spaces and punctuation.
  Nothing fuzzier than that: "Nikhil Kumar" must not be taken for "Nikhil
  Kumar Sharma" — they are different people with different codes.

Command line (run from the project folder; DATA_DIR defaults to ./data):
  python -m app.users import <Book4.xlsx> [--full-view CODE] [--extra CODE,NAME,EMAIL]
  python -m app.users issue [--out FILE]      passwords for every account without one
  python -m app.users reset <email> [--out FILE]
  python -m app.users list
  python -m app.users check                   which dataset names match nobody
"""
import csv
import json
import os
import re
import secrets
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, FrozenSet, Iterable, List, Optional, Tuple

import bcrypt

# Statuses that keep a person in the tree (their managers still see their
# rows) but give them no login. Compared lower-case.
NO_LOGIN_STATUSES = {"fnf initiated", "fnf completed", "exited", "resigned", "inactive", "left"}

# Spellings in the Receivables extract that match no directory name. Keys are
# normalised (see _norm). Import merges these with the aliases already saved,
# so an alias added by hand survives the next import.
DEFAULT_ALIASES = {
    "shrishsingh": "EM512",        # Shrish Pratap Singh
    "mdkahshan": "EM513",          # Mohmmad Kahshan
    "darshanrawal": "EM441",       # Darshan Raval
    "shekhardeshmukh": "EM517",    # Shekhar Shivaji Deshmukh
    "praveensingh": "EM481",       # Praveen Kumar Singh
    "atulborse": "EM454",          # Atul Ravindra Borse
    "amarendrakumarsharma": "EM196",  # Amrendra Kumar Sharma
}

MIN_PASSWORD_CHARS = 10
# No 0/O, 1/l/I: these passwords are read off a sheet and typed by hand.
_PW_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

# A real bcrypt hash, checked against when the email is unknown so a wrong
# email takes as long as a wrong password and the form does not reveal which
# addresses have accounts.
_DUMMY_HASH = bcrypt.hashpw(b"not-a-real-password", bcrypt.gensalt(rounds=12))


def _norm(name: str) -> str:
    return re.sub(r"[^a-z]", "", str(name or "").lower())


def _norm_email(email: str) -> str:
    return str(email or "").strip().lower()


def generate_password() -> str:
    """Twelve random characters in three groups, e.g. Kp7m-Xq3v-Tn9w."""
    raw = "".join(secrets.choice(_PW_ALPHABET) for _ in range(12))
    return "-".join(raw[i:i + 4] for i in range(0, 12, 4))


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode()


def _write_json(path: Path, payload: dict) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


# ------------------------------------------------------------------ viewer
@dataclass(frozen=True)
class Viewer:
    """Who is signed in and which employee codes they may see.

    `codes` is None for full view. `session_tag` is stored in the cookie and
    changes whenever the password does, so a reset signs the person out
    everywhere.
    """
    email: str
    name: str
    code: str
    codes: Optional[FrozenSet[str]]
    session_tag: str

    @property
    def full_view(self) -> bool:
        return self.codes is None

    def can_see(self, code: Optional[str]) -> bool:
        if self.codes is None:
            return True
        return code is not None and code in self.codes


SHARED_EMAIL = "*shared"


def shared_viewer() -> Viewer:
    """The legacy shared site password: full view, not tied to a person."""
    return Viewer(email=SHARED_EMAIL, name="Shared access", code="", codes=None, session_tag="shared")


# --------------------------------------------------------------- directory
class Directory:
    def __init__(self, data: dict):
        self.employees: Dict[str, dict] = data.get("employees", {})
        self.aliases: Dict[str, str] = data.get("aliases", {})
        self.full_view: FrozenSet[str] = frozenset(data.get("fullView", []))
        self.by_email: Dict[str, str] = {}
        self.children: Dict[str, List[str]] = {}
        self._by_name: Dict[str, str] = {}
        for code, e in self.employees.items():
            if e.get("email"):
                self.by_email[_norm_email(e["email"])] = code
            self._by_name.setdefault(_norm(e.get("name", "")), code)
            mgr = e.get("manager") or ""
            if mgr and mgr != code:
                self.children.setdefault(mgr, []).append(code)

    def subtree(self, code: str) -> FrozenSet[str]:
        """`code` and everyone who reports to it, directly or not."""
        seen, stack = set(), [code]
        while stack:
            c = stack.pop()
            if c in seen:          # a loop in the workbook must not hang a login
                continue
            seen.add(c)
            stack.extend(self.children.get(c, []))
        return frozenset(seen)

    def can_login(self, code: str) -> bool:
        e = self.employees.get(code)
        return bool(e and e.get("email")
                    and str(e.get("status", "")).strip().lower() not in NO_LOGIN_STATUSES)

    def resolve(self, name: str, roster_id: Optional[str] = None) -> Optional[str]:
        if roster_id and roster_id in self.employees:
            return roster_id
        n = _norm(name)
        if not n:
            return None
        code = self.aliases.get(n)
        if code in self.employees:
            return code
        return self._by_name.get(n)


class Store:
    """Directory + credentials, reloaded whenever either file changes on disk,
    so an import or a reset from the command line takes effect without a
    restart."""

    def __init__(self, data_dir: Path):
        self.dir_path = Path(data_dir) / "employees.json"
        self.cred_path = Path(data_dir) / "credentials.json"
        self._lock = threading.Lock()
        self._stamp: Tuple[float, float] = (-1.0, -1.0)
        self._directory = Directory({})
        self._creds: Dict[str, dict] = {}

    def _mtime(self, p: Path) -> float:
        try:
            return p.stat().st_mtime
        except FileNotFoundError:
            return 0.0

    def _refresh(self) -> None:
        stamp = (self._mtime(self.dir_path), self._mtime(self.cred_path))
        if stamp == self._stamp:
            return
        with self._lock:
            d = json.loads(self.dir_path.read_text(encoding="utf-8")) if stamp[0] else {}
            c = json.loads(self.cred_path.read_text(encoding="utf-8")) if stamp[1] else {}
            self._directory, self._creds, self._stamp = Directory(d), c.get("accounts", {}), stamp

    @property
    def directory(self) -> Directory:
        self._refresh()
        return self._directory

    def configured(self) -> bool:
        self._refresh()
        return bool(self._directory.employees)

    # -------------------------------------------------------------- viewers
    def _viewer(self, code: str) -> Optional[Viewer]:
        d = self._directory
        email = _norm_email(d.employees[code]["email"])
        cred = self._creds.get(email)
        if not cred or not d.can_login(code):
            return None
        codes = None if code in d.full_view else d.subtree(code)
        return Viewer(email=email, name=d.employees[code].get("name", email), code=code,
                      codes=codes, session_tag=str(cred.get("set", "")))

    def authenticate(self, email: str, password: str) -> Optional[Viewer]:
        self._refresh()
        email = _norm_email(email)
        code = self._directory.by_email.get(email)
        cred = self._creds.get(email) if code else None
        hashed = (cred or {}).get("hash", "").encode() or _DUMMY_HASH
        try:
            ok = bcrypt.checkpw(password.encode("utf-8"), hashed)
        except ValueError:
            ok = False
        if not (ok and cred and code):
            return None
        return self._viewer(code)

    def viewer_for_session(self, email: str, tag: str) -> Optional[Viewer]:
        """The viewer a cookie names, if that account is still valid.

        Re-checked on every request: someone removed from the directory, moved
        to an exit status or given a new password loses access at once, and a
        change of manager changes what they see without signing in again.
        """
        self._refresh()
        code = self._directory.by_email.get(_norm_email(email))
        v = self._viewer(code) if code else None
        return v if v and v.session_tag == tag else None

    # ---------------------------------------------------------- credentials
    def set_password(self, email: str, plain: str, by: str) -> str:
        """Store a new hash. Returns the new session tag."""
        self._refresh()
        email = _norm_email(email)
        if email not in self._directory.by_email:
            raise KeyError(f"{email} is not in the employee directory")
        with self._lock:
            data = json.loads(self.cred_path.read_text(encoding="utf-8")) if self.cred_path.exists() else {}
            accounts = data.setdefault("accounts", {})
            tag = f"{time.strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(3)}"
            accounts[email] = {"hash": hash_password(plain), "set": tag, "by": by}
            _write_json(self.cred_path, data)
        self._stamp = (-1.0, -1.0)
        return tag

    def has_password(self, email: str) -> bool:
        self._refresh()
        return _norm_email(email) in self._creds

    def accounts_summary(self) -> dict:
        d = self.directory
        eligible = [c for c in d.employees if d.can_login(c)]
        with_pw = [c for c in eligible if _norm_email(d.employees[c]["email"]) in self._creds]
        return {"employees": len(d.employees), "eligible": len(eligible), "withPassword": len(with_pw)}


# ------------------------------------------------------------- data scoping
# Both datasets store the person as field 0 of every row, as an index into a
# name list. Scoping keeps the visible people, renumbers them 0..n-1 in their
# original order and keeps only their rows, so the browser code needs no
# change: it simply receives a smaller company. The Ask endpoints scope the
# same way before indexing, so the index a browser sends always refers to the
# list that browser was given.

def scope_ar(ar: dict, directory: Directory, viewer: Viewer) -> dict:
    if not ar or viewer.full_view:
        return ar
    names = ar.get("salespeople", [])
    keep = [i for i, n in enumerate(names) if viewer.can_see(directory.resolve(n))]
    remap = {old: new for new, old in enumerate(keep)}
    lines = [ln for ln in ar.get("lines", []) if ln[0] in remap]
    # Customers too: the list is index-addressed, and sending it whole would
    # show every customer the company has.
    cust_keep = sorted({ln[1] for ln in lines})
    cust_remap = {old: new for new, old in enumerate(cust_keep)}
    out = dict(ar)
    out["salespeople"] = [names[i] for i in keep]
    out["customers"] = [ar["customers"][i] for i in cust_keep]
    out["lines"] = [[remap[ln[0]], cust_remap[ln[1]]] + ln[2:] for ln in lines]
    out["controlTotal"] = round(sum(ln[6] for ln in out["lines"]), 2)
    out.pop("importNotes", None)     # company-wide counts, admin-only
    return out


SEC_TABLES = ("visits", "demos", "leads", "travel", "expenses", "sales")


def scope_sec(sec: dict, directory: Directory, viewer: Viewer) -> dict:
    if not sec or viewer.full_view:
        return sec
    people = sec.get("people", [])
    roster = sec.get("roster", {})
    keep = [i for i, n in enumerate(people)
            if viewer.can_see(directory.resolve(n, (roster.get(n) or {}).get("id")))]
    remap = {old: new for new, old in enumerate(keep)}
    out = dict(sec)
    out["people"] = [people[i] for i in keep]
    out["roster"] = {n: roster[n] for n in out["people"] if n in roster}
    for t in SEC_TABLES:
        out[t] = [[remap[r[0]]] + r[1:] for r in sec.get(t, []) if r[0] in remap]
    out.pop("importNotes", None)
    return out


# ------------------------------------------------------------------- import
def import_master(xlsx_path: Path, data_dir: Path, full_view: Iterable[str],
                  extras: Iterable[Tuple[str, str, str]]) -> dict:
    """Replace the directory from the HR workbook. Credentials are untouched."""
    import openpyxl

    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    ws = wb.worksheets[0]
    rows = ws.iter_rows(values_only=True)
    header = [_norm(h) for h in next(rows)]
    need = {"employeecode": "code", "employeename": "name", "employeestatus": "status",
            "officialemail": "email", "reportingmanagercode": "manager",
            "designation": "designation", "baselocation": "location",
            "subdepartmentdescription": "subdept"}
    missing = [k for k in ("employeecode", "employeename", "officialemail", "reportingmanagercode")
               if k not in header]
    if missing:
        raise ValueError(f"{xlsx_path.name}: missing columns {missing}; found {header}")
    col = {field: header.index(h) for h, field in need.items() if h in header}

    employees: Dict[str, dict] = {}
    seen_email: Dict[str, str] = {}
    for r in rows:
        code = str(r[col["code"]] or "").strip()
        if not code:
            continue
        e = {f: str(r[i]).strip() if r[i] is not None else "" for f, i in col.items() if f != "code"}
        e["email"] = _norm_email(e.get("email"))
        if e["email"] in seen_email:
            raise ValueError(f"email {e['email']} is on both {seen_email[e['email']]} and {code}")
        if e["email"]:
            seen_email[e["email"]] = code
        employees[code] = e

    old = {}
    dir_path = Path(data_dir) / "employees.json"
    if dir_path.exists():
        old = json.loads(dir_path.read_text(encoding="utf-8"))
    # People added by hand (--extra) are not in the workbook; keep them unless
    # the workbook now has them itself.
    for code, e in old.get("employees", {}).items():
        if e.get("manual") and code not in employees:
            employees[code] = e
    for code, name, email in extras:
        employees[code] = {"name": name, "email": _norm_email(email), "status": "Existing",
                           "manager": "", "designation": "", "location": "", "subdept": "",
                           "manual": True}
    by_email: Dict[str, str] = {}
    for code, e in employees.items():
        if e.get("email") and by_email.setdefault(e["email"], code) != code:
            raise ValueError(f"email {e['email']} is on both {by_email[e['email']]} and {code}")
    aliases = dict(DEFAULT_ALIASES)
    aliases.update(old.get("aliases", {}))
    fv = sorted(set(full_view) or set(old.get("fullView", [])))
    for c in fv:
        if c not in employees:
            raise ValueError(f"full-view code {c} is not in the directory (add it with --extra)")

    payload = {"source": xlsx_path.name, "imported": time.strftime("%Y-%m-%d %H:%M:%S"),
               "fullView": fv, "aliases": dict(sorted(aliases.items())), "employees": employees}
    _write_json(dir_path, payload)
    return payload


def unmatched_names(data_dir: Path) -> Dict[str, List[str]]:
    """Dataset names that resolve to nobody — visible to full view only."""
    d = Directory(json.loads((Path(data_dir) / "employees.json").read_text(encoding="utf-8")))
    out: Dict[str, List[str]] = {}
    ar_path = Path(data_dir) / "ar_data.json"
    if ar_path.exists():
        ar = json.loads(ar_path.read_text(encoding="utf-8"))
        out["Receivables"] = sorted(n for n in ar.get("salespeople", []) if not d.resolve(n))
    names = set()
    for p in sorted((Path(data_dir) / "sec_months").glob("*.json")):
        sec = json.loads(p.read_text(encoding="utf-8"))
        roster = sec.get("roster", {})
        names |= {n for n in sec.get("people", [])
                  if not d.resolve(n, (roster.get(n) or {}).get("id"))}
    out["Secondary Sales"] = sorted(names)
    return out


def _write_password_sheet(path: Path, rows: List[List[str]]) -> None:
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["Employee code", "Name", "Username (email)", "Password", "Sees"])
        w.writerows(rows)


def _sees(store: Store, code: str) -> str:
    d = store.directory
    if code in d.full_view:
        return "everyone"
    n = len(d.subtree(code)) - 1
    return "own data only" if n == 0 else f"own data + {n} below"


def _main(argv: List[str]) -> None:
    import argparse

    ap = argparse.ArgumentParser(prog="python -m app.users")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("import", help="replace the directory from the HR workbook")
    p.add_argument("xlsx")
    p.add_argument("--full-view", action="append", default=[], metavar="CODE")
    p.add_argument("--extra", action="append", default=[], metavar="CODE,NAME,EMAIL",
                   help="someone missing from the workbook, e.g. the head of sales")
    p = sub.add_parser("issue", help="random passwords for every account that has none")
    p.add_argument("--out", default=f"initial-passwords-{time.strftime('%Y%m%d-%H%M%S')}.csv")
    p = sub.add_parser("reset", help="new random password for one account")
    p.add_argument("email")
    p.add_argument("--out", default="")
    sub.add_parser("list", help="accounts and what each one sees")
    sub.add_parser("check", help="dataset names that match nobody in the directory")
    a = ap.parse_args(argv)

    # Read directly rather than through app.config, which insists on the web
    # server's secrets being set — not needed to manage accounts.
    data_dir = Path(os.getenv("DATA_DIR", "./data"))
    store = Store(data_dir)

    if a.cmd == "import":
        extras = []
        for x in a.extra:
            parts = [s.strip() for s in x.split(",")]
            if len(parts) != 3:
                raise SystemExit(f"--extra expects CODE,NAME,EMAIL, got {x!r}")
            extras.append(tuple(parts))
        payload = import_master(Path(a.xlsx), data_dir, a.full_view, extras)
        d = Directory(payload)
        orphans = sorted({e["manager"] for e in d.employees.values()
                          if e.get("manager") and e["manager"] not in d.employees})
        print(f"Imported {len(d.employees)} employees; full view: {', '.join(d.full_view) or 'nobody'}")
        if orphans:
            print(f"WARNING manager codes not in the directory: {', '.join(orphans)} — "
                  "their reports are seen by full view only, not by that manager.")
        return

    if a.cmd == "issue":
        d = store.directory
        rows = []
        for code, e in sorted(d.employees.items()):
            if not d.can_login(code) or store.has_password(e["email"]):
                continue
            pw = generate_password()
            store.set_password(e["email"], pw, by="issued")
            rows.append([code, e["name"], e["email"], pw, _sees(store, code)])
        if not rows:
            print("Every eligible account already has a password. Use `reset` for one person.")
            return
        _write_password_sheet(Path(a.out), rows)
        print(f"Issued {len(rows)} passwords -> {Path(a.out).resolve()}")
        print("Hand each person their own line, then DELETE this file.")
        return

    if a.cmd == "reset":
        d = store.directory
        code = d.by_email.get(_norm_email(a.email))
        if not code:
            raise SystemExit(f"{a.email} is not in the directory")
        if not d.can_login(code):
            raise SystemExit(f"{a.email} has status {d.employees[code].get('status')!r}: no login")
        pw = generate_password()
        store.set_password(a.email, pw, by="reset")
        if a.out:
            _write_password_sheet(Path(a.out), [[code, d.employees[code]["name"], a.email, pw,
                                                 _sees(store, code)]])
            print(f"New password written to {Path(a.out).resolve()}")
        else:
            print(f"New password for {a.email}: {pw}")
        print("Existing sessions for this account are now signed out.")
        return

    if a.cmd == "list":
        d = store.directory
        for code, e in sorted(d.employees.items()):
            login = ("password set" if store.has_password(e["email"]) else "NO PASSWORD") \
                if d.can_login(code) else f"no login ({e.get('status')})"
            print(f"{code:7} {e['name'][:28]:28} {e['email'][:40]:40} {login:22} {_sees(store, code)}")
        return

    if a.cmd == "check":
        for ds, names in unmatched_names(data_dir).items():
            print(f"{ds}: {len(names)} name(s) visible to full view only")
            for n in names:
                print(f"   {n}")


if __name__ == "__main__":
    _main(sys.argv[1:])
