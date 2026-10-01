# NuTaste Sales Desk

The Sales Desk as a hosted web application: the same Receivables and Secondary
Sales views, behind a password, with an admin page for replacing the data.

Built to stay host-agnostic — one Docker container, all configuration through
environment variables — so the hosting decision can be made later without
changing the code.

---

## What this is

| | |
|---|---|
| **Receivables** | Salesperson picker → Overview, Full report, Ask |
| **Secondary Sales** | Salesperson picker → Overview, Activity detail |
| **Access** | One shared password for all salespeople; a second password for admin |
| **Data** | Excel upload through the admin page; Business Central API later |
| **Direction of data** | Read-only. Nothing is ever written back to any source system |

The frontend is unchanged from the original — the same JavaScript, the same
stylesheet, the same layout. The only structural change is that the two
datasets now load from the server (`/api/data/ar.js`, `/api/data/sec.js`)
instead of being baked into the page, so new data can be uploaded without
rebuilding or redeploying anything.

---

## Quick start (local)

```bash
pip install -r requirements.txt

# generates both password hashes and a secret key
python -m app.hash_password

cp .env.example .env     # paste the three values in
set -a; . ./.env; set +a
SECURE_COOKIES=false uvicorn app.main:app --reload --port 8000
```

Open http://127.0.0.1:8000 — the site asks for the shared password. The admin
page is at `/admin`.

`SECURE_COOKIES=false` is only for local `http://` testing. Leave it at `true`
everywhere else or the session cookie won't be sent.

## Quick start (Docker)

```bash
python -m app.hash_password        # then put the values in .env
docker compose up --build
```

The compose file mounts a named volume at `/data`, so uploaded datasets survive
container rebuilds.

---

## Configuration

Every setting is an environment variable. Nothing secret belongs in the code or
in version control.

| Variable | Required | Default | Purpose |
|---|:---:|---|---|
| `SITE_PASSWORD_HASH` | yes | — | bcrypt hash of the shared salesperson password |
| `ADMIN_PASSWORD_HASH` | yes | — | bcrypt hash of the admin password. Keep it different |
| `SECRET_KEY` | yes | — | signs session cookies. Changing it signs everyone out |
| `DATA_DIR` | | `./data` | where datasets live. Point at a persistent volume |
| `SESSION_HOURS` | | `12` | how long a salesperson stays signed in |
| `ADMIN_SESSION_MINUTES` | | `30` | admin sessions expire faster on purpose |
| `LOGIN_MAX_ATTEMPTS` | | `5` | attempts allowed per IP per window |
| `LOGIN_WINDOW_SECONDS` | | `300` | the rate-limit window |
| `SECURE_COOKIES` | | `true` | set false **only** for local http testing |
| `MAX_UPLOAD_MB` | | `64` | the secondary sales workbook is around 22 MB |

The app refuses to start if any of the three required variables is missing,
rather than falling back to a default password.

---

## Updating the data

Sign in → `/admin` → choose a file → upload. Each dataset can be replaced
independently, and every replacement writes a timestamped backup into
`$DATA_DIR/backups/`.

### Receivables

Upload the Business Central extract (`.xlsx` or `.csv`) and set the report date.
The importer reads the `Detailed` sheet and:

- **Recomputes every ageing bucket from Due Date** against the report date. The
  extract's own bucket columns are frozen at the moment of extraction, so a
  file even a few days old puts invoices in the wrong bucket. This was point 1
  of the data-quality list in the build plan.
- **Reconciles** the recomputed buckets against the Balance column and rejects
  the whole import if they differ by more than one rupee.
- **Normalises zone strings**, so "WEST MH" and "West MH" stop splitting
  reports. This is a stopgap — the durable fix is still to clean the values in
  Business Central.

Column headings are matched through `config/ar_columns.json`. If Business
Central renames a column, add the new name to the relevant list in that file;
no code change is needed. If a required column can't be found, the import is
rejected with a message naming what was missing and what was found instead.

### Secondary Sales

Upload the workbook (`.xlsx`) and optionally a reporting month such as
`2026-08`. Leave the month blank to take the latest month present in the file.

It reads `Secondary sale`, `Visit_report`, `Demos`, `Leads Header`, `Travel`,
`Expenses` and `Channelier Employees`, and extracts one month at a time.

Two things worth knowing:

- The sheets disagree about names. The visit and travel exports use the full HR
  name ("Shrish Pratap Singh"); the sales sheet's `FPR 1` column uses a short
  form ("Shiris Pratap"). The importer resolves these against the employee
  roster instead of matching on spelling. Anything it cannot resolve is kept
  and reported rather than silently dropped, so a new misspelling shows up as a
  warning instead of a person's sales disappearing.
- A lead counts in the month it was raised, from the split year/month/day
  columns — not `follow_up_date`, which points into the future and would pull
  leads into a month they were not created in.

A 22 MB workbook takes roughly 20 seconds to process. That is normal.

---

## Deploying

The image reads `PORT` from the environment, so it works as-is on the common
hosts. Set the three required variables as secrets in the host's configuration,
never in the repository.

**Azure App Service** — the option to prefer if the Business Central API turns
out to be IP-restricted, since it keeps the app in the same tenant. Deploy the
container, set the variables under Configuration → Application settings, and
mount Azure Files at `/data` so uploads persist.

**Render / Railway / Fly.io** — cheaper and quicker. Point them at the
Dockerfile, set the variables, attach a persistent disk at `/data`. These sit
outside the Microsoft tenant, so confirm the BC API is reachable before
committing to one.

**On-premise** — `docker compose up -d` behind a reverse proxy that terminates
TLS, published through Entra Application Proxy or VPN.

Whichever you choose, the app must be served over HTTPS. The session cookie is
marked Secure and won't be sent over plain HTTP.

---

## Security notes

With per-salesperson isolation deliberately out of scope, the shared password is
the only thing protecting the full receivables ledger on a public address. The
build measures already in place:

- Passwords stored as bcrypt hashes in environment configuration, never in code
- Login rate limiting per IP (5 attempts per 5 minutes by default)
- Signed, HttpOnly, Secure session cookies with expiry
- `X-Robots-Tag: noindex, nofollow`, a disallow-all `robots.txt`, HSTS,
  `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`
- Admin access behind a second password with a shorter session
- Uploads validated and reconciled before they replace anything, with backups

What the code cannot do for you:

- **Rotate the shared password whenever anyone leaves the sales team.** Generate
  a new hash, update the environment variable, restart.
- **Distribute it verbally or through IT's normal channel** — not email, not
  WhatsApp.
- **Name an owner before launch.** An unowned internal tool decays.

---

## When the Business Central API is ready

The upload path is deliberately the only part that knows where data comes from.
To switch to the API, write a scheduled job that calls BC and writes
`$DATA_DIR/ar_data.json` in the same shape the importer produces. Nothing in the
frontend, the authentication or the admin page needs to change; you can keep the
upload page as a manual fallback.

Still outstanding from the build plan, and needed before that job can be
written:

- Endpoint URL and authentication method
- A sample JSON response
- **Whether the API is IP-restricted** — this constrains the hosting choice

Credentials belong in the host's environment configuration, read at runtime.
Never in chat, never in source code.

---

## Layout

```
app/
  main.py               routes, auth, sessions, upload handling
  config.py             environment variables
  hash_password.py      python -m app.hash_password
  importers/
    ar_excel.py         BC extract  -> AR dataset (recomputes ageing)
    sec_excel.py        activity workbook -> secondary sales dataset
  static/               the original app: receivables.js, secondary.js,
                        switch.js, app.css — unchanged
  templates/            index.html (the Sales Desk), login.html, admin.html
config/ar_columns.json  column-name aliases for the AR import
data/                   datasets + backups/  (mount a volume here)
```

## Known gaps

- Excel and PDF export from the report view (phase 3 of the build plan) is not
  built yet.
- Filters for zone, payment terms and ageing bucket are not built yet.
- Secondary Sales holds one month at a time; trend charts need history to
  accumulate first.
- The login rate limiter keeps its counters in memory, which is correct for a
  single container. Running several replicas needs shared storage for it.
