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
| `ASK_AI_ENABLED` | | `true` | master switch for the AI Ask box |
| `ASK_PROVIDER` | | `gemini` | model backend. Only `gemini` ships today |
| `GEMINI_API_KEY` | | — | leave blank to run the Ask box on the built-in parser |
| `GEMINI_MODEL` | | `gemini-3.6-flash` | the model "Auto" tries first |
| `GEMINI_MODELS` | | — | optional comma-separated preference order after that |
| `ASK_QUOTA_COOLDOWN_SECONDS` | | `1800` | how long a model that hit its quota is skipped |
| `ASK_TIMEOUT_SECONDS` | | `12` | after this, the built-in parser answers instead |
| `ASK_MAX_PER_WINDOW` | | `40` | AI questions per session per window |
| `ASK_WINDOW_SECONDS` | | `300` | the Ask rate-limit window |
| `ASK_MAX_QUESTION_CHARS` | | `400` | longer questions are truncated, not refused |

The app refuses to start if any of the three required variables is missing,
rather than falling back to a default password.

---

## The Ask box

On the receivables page, **Ask** takes a question in plain English. With
`GEMINI_API_KEY` set it is answered in two stages:

1. **Gemini reads the question** and returns a *filter specification* — which
   ageing buckets, which customers, which zone, how to sort. It is explicitly
   instructed never to produce a number, and it is given only names: the report
   date, the bucket labels, the zone and payment-term lists, and the customer
   names on that one salesperson's book. **No amounts, due dates or document
   numbers are ever sent.**
2. **The browser computes the answer** by running that specification through
   `runQuery` against the real invoice lines — the same code path a typed
   question has always used.

So every figure on screen is still arithmetic over your own data. The model
chooses *which rows*, never *what the total is*. This is the whole reason for
the split: a language model asked to add up a column is sometimes confidently
wrong, and a wrong receivables figure is worse than no answer.

Three things keep it honest:

- **Validation.** `app/ask.py` checks everything the model returns against the
  live dataset. An unknown zone, term or customer is dropped, not passed on, so
  a hallucinated filter can only ever widen the query — it cannot invent one.
- **Chips.** The "Read as" row is built in the browser from the filters that
  were actually applied, never from anything the model wrote, so it cannot
  describe a query that did not run.
- **Provenance.** Every answer card names the engine that read the question —
  AI or built-in.

**It degrades, it does not break.** No key, a revoked key, an exhausted quota,
a timeout or malformed output all fall back to the built-in parser, and the card
says *"AI was unavailable"*. Setting `ASK_AI_ENABLED=false` returns the Ask box
to exactly its previous behaviour.

Rate limits (HTTP 429) and transient capacity errors (503) are retried once
after a short pause, inside the same `ASK_TIMEOUT_SECONDS` budget, because both
usually clear within a second or two.

### Choosing a model

The Ask card has a **Model** dropdown, populated from whatever models the API
key can actually see — the app asks Google for the list rather than hardcoding
one, and caches it for six hours.

- **Auto** (the default) walks a preference order: `GEMINI_MODEL` first, then
  `GEMINI_MODELS`, then everything else newest-first. A model that answers
  "quota exceeded" is parked for `ASK_QUOTA_COOLDOWN_SECONDS`; one that is
  merely overloaded is parked for two minutes. So a spent daily quota costs one
  wasted call, not one per question.
- **A specific model** pins every question to it. If that model cannot answer,
  the built-in parser does — Auto's failover is not applied to an explicit
  choice, because silently answering on a different model than the one asked
  for would be confusing.

The whole walk shares one `ASK_TIMEOUT_SECONDS` deadline, and no single model
may take more than half of it, so trying several models cannot multiply the
wait. The answer card names the model that actually answered.

Google's daily free-tier quota is **per model**, so failover genuinely buys more
questions on the free tier. It is a stopgap, not a substitute for billing.

> **Billing matters here.** On Google's free tier the request cap is low — tens
> of requests per day per model — and Google uses free-tier prompts to improve
> its models. Those prompts contain customer names. Enable billing on the Cloud
> project before using this with real data.

Swapping providers means adding a module under `app/providers/` and one line in
`get_provider`; nothing outside that package imports a vendor SDK.

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
  main.py               routes, auth, sessions, upload handling, /api/ask
  config.py             environment variables
  hash_password.py      python -m app.hash_password
  ask.py                question -> filter spec: prompt, schema, validation
  providers/
    base.py             the Provider protocol every backend implements
    gemini.py           Google Gemini over plain HTTPS (no vendor SDK)
  importers/
    ar_excel.py         BC extract  -> AR dataset (recomputes ageing)
    sec_excel.py        activity workbook -> secondary sales dataset
  static/               receivables.js, secondary.js, switch.js, app.css
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
