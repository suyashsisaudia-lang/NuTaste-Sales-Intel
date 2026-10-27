# Moving NuTaste Sales Intelligence to the office server

After this move the **office Windows server is the master copy** of the app. It runs
the app and the scheduled refreshes, and keeps the data and user accounts. After every
refresh it pushes the new data to GitHub, and **Render keeps serving the public
address**, so nothing changes for salespeople. The laptop can then be switched off.

```
Office server (always on, inside the office network)
  ├─ app + daily Receivables refresh (Business Central) + weekly Secondary Sales refresh (SharePoint)
  └─ pushes each refresh to GitHub
                 ↓
Render (public address, unchanged) rebuilds from GitHub
```

Allow about an hour. **Don't do steps 3–4 around 11:00 IST**, when the daily refresh runs.

---

## 1. Install the tools on the server

Sign in to the server (Remote Desktop) with the Windows account that will run the app.
**Use that same account for every step below**, because the app runs under it and uses
its GitHub sign-in.

- **Python 3.14** from python.org. Tick **"Add python.exe to PATH"**.
- **Git for Windows** from git-scm.com, with the default options.
- The server must not go to sleep: Power Options → *High performance*, sleep **Never**.

## 2. Get the project onto the server

In PowerShell:

```powershell
git clone https://github.com/Suyash480/nutaste-sales-desk.git C:\NuTaste\nutaste-sales-desk
```

Git opens a browser window. Sign in as the GitHub owner of the repo (Suyash480).

Then copy these from the laptop folder `C:\Users\admin\nutaste-sales-desk` into the same
places under `C:\NuTaste\nutaste-sales-desk`. **Use a USB drive or a network share. Never
use email, Teams or chat**: they contain the Business Central password, the AI key and the
admin password hash.

| Copy | What it is |
|---|---|
| `.env` | all settings and secrets |
| `data\credentials.json` | everyone's login password hashes |
| `data\backups\` *(optional)* | history of earlier uploads, about 3 MB |

In the server's `.env`, add this line so the app is only reachable on the server itself
(office users keep using the Render address):

```
HOST=127.0.0.1
```

## 3. Stop the laptop

Only one machine may run the refreshes, or both push to GitHub and conflict. On the
**laptop**, in PowerShell:

```powershell
cd C:\Users\admin\nutaste-sales-desk
git status --short          # should list only logs\ files: everything else is already on GitHub
Disable-ScheduledTask -TaskName "NuTaste Sales Desk"
Stop-ScheduledTask    -TaskName "NuTaste Sales Desk"
Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

The task is **disabled, not deleted**, so you can switch back (see *Going back*).

## 4. Run the setup script on the server

Open PowerShell with **Run as administrator**, then:

```powershell
cd C:\NuTaste\nutaste-sales-desk
powershell -ExecutionPolicy Bypass -File deploy\setup-server.ps1
```

The script checks everything before it changes anything, and stops with a clear message
if something is missing. It never prints a secret. In order, it:

1. checks Python and Git
2. updates the project from GitHub
3. checks `.env` and `credentials.json` were copied, and that `SEC_AUTO_PUSH=true`
4. installs the Python packages
5. tests that the server can reach **Business Central, SharePoint, GitHub** and Google AI
6. checks this account can push to GitHub (a dry run; nothing is pushed)
7. creates the **"NuTaste Sales Desk"** task, which starts at boot and runs with nobody
   logged in. It asks for this account's Windows password, which Task Scheduler stores.
8. asks you to confirm the laptop is stopped, then starts the app and checks it answers

You can run it again safely if it stops partway.

## 5. Check it works

1. On the server, open **http://localhost:8000** and sign in with your own account.
2. Go to **http://localhost:8000/admin** and press **Refresh now** under Receivables.
3. On GitHub (the repo's *Commits* page), a new *"Receivables data refresh"* commit
   should appear within a minute.
4. A few minutes later, the **Render site** should show today's ageing date.
5. *(Out of hours)* Restart the server and **don't log in**. The next day, check that the
   11:00 refresh still appeared on GitHub. That proves the app starts after a reboot
   with nobody logged in.

After a week of normal refreshes you can switch the laptop off for good.

---

## Day to day

| Task | Where and how |
|---|---|
| Daily Receivables / weekly Secondary Sales refresh | Automatic. Pushed to GitHub, so Render updates on its own |
| **Manual uploads** (Excel/CSV data) | On the server at **http://localhost:8000/admin**, then push (below). Manual uploads are **not** pushed automatically |
| **User accounts** (import HR master, reset a password) | On the server, at `/admin` → *User accounts* or `python -m app.users …`. Then push `employees.json` and re-upload `credentials.json` to Render (below) |
| Code changes | Make them on a development PC and push to GitHub. On the server: `git pull`, then restart the task |

**Don't upload data or change accounts on the Render site.** Render has no permanent
disk, so anything changed there is lost the next time it restarts.

Pushing after a manual upload or account change (on the server):

```powershell
cd C:\NuTaste\nutaste-sales-desk
git add data/ar_data.json data/sec_data.json data/sec_months data/meta.json data/employees.json
git commit -m "Manual data update"
git push
```

`credentials.json` is never put on GitHub. After changing accounts, upload the server's
`data\credentials.json` to Render: Dashboard → the service → **Environment → Secret
Files** → `credentials.json`.

**Restarting the app** on the server (after a `git pull` or a `.env` change):

```powershell
Get-NetTCPConnection -LocalPort 8000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Start-ScheduledTask -TaskName "NuTaste Sales Desk"
```

**If the Windows account's password changes**, update the stored password, or the app
won't start after the next reboot: Task Scheduler → *NuTaste Sales Desk* → Properties →
OK → enter the new password. Or run the setup script again and choose to replace the task.

## Known limitation

When someone changes their **own** password on the public Render site, the change lasts
only until Render next restarts or redeploys (which happens after every refresh). It
never reaches the server. Until that's fixed, reset passwords on the server and
re-upload `credentials.json` to Render as above.

## Going back to the laptop

On the server: `Disable-ScheduledTask -TaskName "NuTaste Sales Desk"`, then stop it as
in step 3. On the laptop: `git pull`, then
`Enable-ScheduledTask -TaskName "NuTaste Sales Desk"; Start-ScheduledTask -TaskName "NuTaste Sales Desk"`.
