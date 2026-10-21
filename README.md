# NuTaste Sales Intelligence

NuTaste Sales Intelligence as a hosted web application: the same Receivables and Secondary
Sales views, behind a personal sign-in per employee, with an admin page for replacing the data.

Built to stay host-agnostic — one Docker container, all configuration through
environment variables — so the hosting decision can be made later without
changing the code.

---

## What this is

| | |
|---|---|
| **Receivables** | Salesperson picker → Overview, Full report, Ask |
| **Secondary Sales** | Salesperson picker → Overview, Activity detail |
| **Access** | Own email + password per employee; each sees themselves and everyone below them. Admin has a separate password |
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
SECURE_COOKIES=false uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

On Windows, the easiest way to keep the site running after VS Code is closed is:

```powershell
# from the repo root
powershell -ExecutionPolicy Bypass -File .\start-web.ps1
```

This starts the app as a detached background process so it stays reachable even
when the editor is not open. Open http://127.0.0.1:8000 and sign in with a work
email and password (see **User accounts** below). The admin page is at `/admin`.

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
| `SITE_PASSWORD_HASH` | | — | optional legacy shared password. While set it signs in with **full view** of everyone's data (email box left blank). Remove it to retire shared access |
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
| `ASK_NARRATE` | | `true` | write a plain-English summary above each answer. **The only setting that sends amounts to the provider** |
| `ASK_TIMEOUT_SECONDS` | | `12` | after this, the built-in parser answers instead |
| `ASK_MAX_PER_WINDOW` | | `40` | AI questions per session per window |
| `ASK_WINDOW_SECONDS` | | `300` | the Ask rate-limit window |
| `ASK_MAX_QUESTION_CHARS` | | `400` | longer questions are truncated, not refused |
| `ASK_ANALYST` | | `true` | **Secondary Sales only.** Model answers with figures of its own, from the real rows. Set `false` for filter-only answers |
| `ASK_ANALYST_TIMEOUT_SECONDS` | | `75` | analyst calls read hundreds of rows; ~23s is typical for one model |
| `ASK_ANALYST_MAX_TOKENS` | | `8192` | output cap; the model's reasoning is charged against it too |
| `ASK_ANALYST_MAX_CHARS` | | `4000` | longest analyst answer rendered |
| `SEC_SOURCE_URL` | | — | SharePoint share link to the Secondary Sale workbook. Blank turns the weekly refresh off. **Treat as a secret** |
| `SEC_REFRESH_ENABLED` | | `true` | `false` stops the schedule; the admin "Refresh now" button still works |
| `SEC_REFRESH_WEEKDAY` | | `0` | 0 = Monday … 6 = Sunday |
| `SEC_REFRESH_TIME` | | `11:00` | 24-hour time, in the offset below |
| `SEC_REFRESH_UTC_OFFSET_MINUTES` | | `330` | 330 = IST. A fixed offset, so it is right on a UTC container too |
| `SEC_DOWNLOAD_TIMEOUT_SECONDS` | | `300` | how long the workbook download may take |
| `KEEP_AWAKE_URL` | | `$RENDER_EXTERNAL_URL/healthz` on Render, blank elsewhere | the app requests this URL on a timer so a free Render instance never sleeps. Uses ~744 of the 750 free hours a month. Set to blank to turn off |
| `KEEP_AWAKE_MINUTES` | | `10` | interval; keep it under Render's ~15-minute idle limit |

The app refuses to start if any of the three required variables is missing,
rather than falling back to a default password.

---

## The Ask box

The two tabs answer questions in two different ways, and the difference matters
for both accuracy and what leaves your network. **Receivables** is described
first; **Secondary Sales** works differently — see *Analyst mode* below.

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

This applies to the **receivables** Ask box in full. On **Secondary Sales** it
describes the fallback only — see the next section.

### The written summary

With `ASK_NARRATE=true` (the default) there is a **third stage**: once the
browser has computed the answer, the finished figures go back to the model,
which writes two or three sentences of plain English above the table.

This is the one place amounts leave your network — the first stage never sends
them. Set `ASK_NARRATE=false` to keep every figure inside the building; answers
then render exactly as they did before, just without the paragraph.

The model is told to copy figures character for character and never to derive
new ones, and `verify_narrative()` in `app/ask.py` enforces it: every number in
the sentence must appear in the computed result, the question, or be a small
count. A narrative that quotes anything else is **discarded**, not shown, and
the computed answer stands alone. A rounded figure or an invented total is
therefore impossible to get on screen.

It also costs a second API call per question, which matters on a quota.

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

### Analyst mode (Secondary Sales)

The Secondary Sales Ask box does **not** work like the receivables one. With
`ASK_ANALYST=true` (the default) the model is sent this salesperson's actual
rows for the month — outlets, product groups, rupees, units, minutes,
kilometres — and answers the question directly: it ranks, compares, works out
rates and states a conclusion.

This is a deliberate trade, and both halves of it should be understood:

- **What you gain.** Questions the filter engine could only refuse now get a
  useful answer. "Which distributor am I losing" has no churn column behind it,
  so the model says so and then answers the closest thing the rows support —
  outlets that bought once and never repeated, or were visited without buying —
  and labels it as a proxy.
- **What you give up.** The figures in an analyst answer are produced by the
  **model**, not computed by this application. They can disagree with the
  Overview tab and with Excel. Treat an analyst answer as a lead to follow, not
  as a number to put in a report.

Two things narrow the gap without closing it. Exact subtotals — every table
total, and breakdowns by outlet, product group, city, stage, status, region and
channel — are computed in Python and sent alongside the rows, and the model is
told to quote those rather than add anything up itself. And the source line
under every answer says which kind it is: *"figures quoted from totals computed
by this app"* when the model stayed inside them, or *"figures are the model's
own — check against Overview before acting"* when it did its own arithmetic.

**Privacy.** Analyst mode sends real amounts and real customer names to the
provider on every question. That is a larger egress than `ASK_NARRATE`, which
only sends an already-computed result. Set `ASK_ANALYST=false` to return the
Secondary Ask box to filter-only answers, where every figure is arithmetic over
your own data and only names are ever sent.

**Cost.** An analyst question sends 3k-8k tokens of context, against a few
hundred for a filter classification, and takes around 23 seconds rather than
two. On a free-tier key this exhausts a model's daily quota considerably faster.
When every model is spent, the box falls back to the built-in parser, which
answers what it can place with certainty and flags the rest as not computable.

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

Upload the workbook (`.xlsx`). Every month in it is imported and stored
separately under `$DATA_DIR/sec_months/` (`2026-08.json`, …), and the page has
a **Month** picker in the top bar of the Secondary Sales section. The latest
month is the default and is also kept in `sec_data.json`. Enter a month such as
`2026-08` to re-import just that one. Months already stored are kept even if a
later workbook no longer contains them.

It reads `Secondary sale`, `Visit_report`, `Demos`, `Leads Header`, `Travel`,
`Expenses` and `Channelier Employees`. The workbook is read once and split by
month, so importing all months takes about as long as one.

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

### Secondary Sales — weekly refresh from SharePoint

With `SEC_SOURCE_URL` set, the app downloads the workbook from SharePoint every
**Monday at 11:00 IST** (configurable) and imports every month in it — the
same importer, validation and backup as an upload. The latest month (month-to-
date on a mid-month refresh) is the default view. No restart is needed; the site serves the new data
immediately. The admin page shows the schedule, the next run and the result of
the last attempt, and has a **Refresh now from SharePoint** button.

- **Nothing is replaced on failure.** A download that fails, a link that returns
  a sign-in page instead of the file, or a workbook the importer rejects all
  leave the current dataset in place, and the reason appears on the admin page.
  A failed scheduled run is retried hourly, up to three times.
- **Missed runs catch up.** If the site was down at the scheduled time, the
  refresh runs about 30 seconds after it next starts.
- **One process only.** The scheduler runs inside the web process. Running
  uvicorn with several workers would refresh once per worker.
- **The link is a credential.** It is an "Anyone with the link" share, so anyone
  holding it can download the workbook. Keep it in `.env` / host secrets. The
  durable fix is an Entra app registration with read access to just this file,
  downloading through Microsoft Graph instead of a public link.

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

## User accounts

Every employee in HR's *Super Employee Master* (Book4.xlsx) signs in with their
official email and their own password. What they see follows
`ReportingManager_Code`: **their own data plus everyone below them in the
tree**. People listed as full view (the head of sales, CN005) see everyone in
the directory. Rows for people **not in the employee master** (leavers, test
accounts) are hidden from every view, including full view, the shared password
and Ask; they stay in the stored files, so adding the person to the master
brings their data back.

The filtering happens on the server: the Receivables and Secondary Sales
datasets, and the rows sent to the Ask models, are cut down before they leave
it. A salesperson's browser never receives anyone else's rows.

| File (in `DATA_DIR`) | What it holds |
|---|---|
| `employees.json` | the directory: code, name, email, status, manager; aliases; full-view list |
| `credentials.json` | bcrypt hash per email. Secret — excluded from Git and the Docker image |

```powershell
# first time, or when HR sends a new master (existing passwords are kept)
.venv\Scripts\python -m app.users import "Book4.xlsx" `
    --extra "CN005,Srikanth Kadiyali,k.srikanth@nutasteworld.com" --full-view CN005

.venv\Scripts\python -m app.users issue     # random password for everyone without one -> CSV
.venv\Scripts\python -m app.users reset someone@nutasteworld.com
.venv\Scripts\python -m app.users list      # accounts, and what each one sees
.venv\Scripts\python -m app.users check     # dataset names that match nobody
```

`--extra` people and `--full-view` are remembered across later imports. The
admin page (`/admin` → *User accounts*) can also reset a password (shown once,
on screen) and re-import the master. People change their own password from
**Password** in the top bar; a change or reset signs out their other sessions.

- **Status `FnF Initiated`** (and other exit statuses) removes the login but
  keeps the person's rows visible to their managers.
- **Matching names.** Secondary Sales rows carry an employee code, which is used
  directly. Receivables rows carry only a name, matched ignoring case and
  punctuation, plus an alias list in `employees.json` for spellings that differ
  ("Md.Kahshan" → EM513). Run `check` after each new extract: a name listed there
  is hidden from everyone — add an alias if it is really a listed employee.
- **Hand out the password sheet from `issue` person by person, then delete it.**

## Security notes

The build measures in place:

- Passwords stored as bcrypt hashes, never in code; per-person hashes in
  `credentials.json`, admin (and optional shared) hashes in the environment
- Login rate limiting per IP and per account (5 attempts per 5 minutes by default)
- Data filtered server-side to each person's reporting tree; the session is
  re-checked against the directory on every request, so a leaver or a reset
  takes effect immediately
- Signed, HttpOnly, Secure session cookies with expiry
- `X-Robots-Tag: noindex, nofollow`, a disallow-all `robots.txt`, HSTS,
  `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`
- Admin access behind a second password with a shorter session
- Uploads validated and reconciled before they replace anything, with backups

What the code cannot do for you:

- **Retire the shared password once everyone has their own login** — while
  `SITE_PASSWORD_HASH` is set, anyone holding it sees the full ledger. Until then,
  rotate it whenever anyone leaves the sales team.
- **Keep the employee master current.** Re-import it when people join, leave or
  change manager; visibility follows it.
- **Distribute passwords verbally or through IT's normal channel** — not email,
  not WhatsApp.
- **Name an owner before launch.** An unowned internal tool decays.

---

## Receivables from the Business Central API

Receivables are pulled straight from BC's `AgedReceivables` OData endpoint
**every day at 11:00 IST**, and on demand from `/admin` → **Refresh now from
Business Central**. It goes through the same validation and backup as an upload, and the
frontend sees a dataset of exactly the same shape.

| Variable | Purpose |
|---|---|
| `BC_AR_API_URL` | the AgedReceivables endpoint. Blank disables the button |
| `BC_API_USERNAME` / `BC_API_PASSWORD` | a BC web-service user (HTTP Basic auth). **Secrets** |
| `BC_API_TIMEOUT_SECONDS` | per-request timeout, default 120 |
| `AR_REFRESH_ENABLED` | `false` stops the daily run; the button still works |
| `AR_REFRESH_TIME` / `AR_REFRESH_UTC_OFFSET_MINUTES` | default `11:00` at `330` (IST) |
| `AR_AUTO_PUSH` | commit + push `ar_data.json` after each refresh so Render catches up. Defaults to `SEC_AUTO_PUSH`; office PC only |

- **Ageing comes from the API's total overdue days**, not from Due Date: each
  line goes into the bucket its days fall in (33 days → "32-62 Days"), using
  the same bucket bounds as the Excel import. The report date is today (IST).
- **Only fields the API returns are used.** API field names are matched through
  `config/ar_columns.json` ignoring case and punctuation (`Remaining_Amount`
  matches "Remaining Amount"). Required: salesperson, customer number or name,
  document number, balance, overdue days. Zone, payment terms, due date and
  original amount are optional and left blank when absent.
- **The daily run** starts only when the URL and both credentials are set. A run
  missed while the site was down happens about 30 seconds after it next starts;
  a failed run is retried hourly, up to three times, and the current data stays
  in place. The admin page shows the next run and the last result.
- Lines with a zero balance are skipped; paging (`@odata.nextLink`) is followed,
  but never to a different server, so the credentials only go to BC.

To see what the API returns and how it maps, before replacing anything:

```powershell
.venv\Scripts\python -m app.ar_refresh fields   # field names + mapping
.venv\Scripts\python -m app.ar_refresh check    # full conversion, nothing written
```

The endpoint is plain `http://`, so the Basic-auth credentials cross the network
unencrypted. Use a dedicated read-only BC user and move the endpoint to HTTPS
when possible. Credentials belong in `.env` / the host's secrets, never in code.

---

## Layout

```
app/
  main.py               routes, auth, sessions, upload handling, /api/ask
  users.py              per-person logins, reporting tree, data scoping; python -m app.users
  config.py             environment variables
  hash_password.py      python -m app.hash_password
  ask.py                question -> filter spec: prompt, schema, validation
  sec_refresh.py        weekly SharePoint download + scheduler for Secondary Sales
  ar_refresh.py         Business Central AgedReceivables API fetch; python -m app.ar_refresh
  providers/
    base.py             the Provider protocol every backend implements
    gemini.py           Google Gemini over plain HTTPS (no vendor SDK)
  importers/
    ar_excel.py         BC extract  -> AR dataset (recomputes ageing)
    ar_api.py           BC API records -> AR dataset (buckets by overdue days)
    sec_excel.py        activity workbook -> secondary sales dataset
  static/               receivables.js, secondary.js, switch.js, app.css
  templates/            index.html (the main app), login.html, admin.html
config/ar_columns.json  column-name aliases for the AR import
data/                   datasets + backups/  (mount a volume here)
```

## Known gaps

- Excel and PDF export from the report view (phase 3 of the build plan) is not
  built yet.
- Filters for zone, payment terms and ageing bucket are not built yet.
- Secondary Sales shows one month at a time (picked from the Month menu); there
  are no month-over-month trend charts yet.
- The login rate limiter keeps its counters in memory, which is correct for a
  single container. Running several replicas needs shared storage for it.
