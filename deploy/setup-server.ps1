# One-time setup of NuTaste Sales Intelligence on the office Windows server.
#
# The office server becomes the master copy: it runs the app and the daily
# Receivables / weekly Secondary Sales refreshes, and pushes each refresh to
# GitHub so the public copy on Render redeploys. Follow deploy\OFFICE-SERVER.md;
# this script is step 4 of it.
#
# Run from the cloned repo, in a PowerShell window opened with "Run as administrator":
#
#   powershell -ExecutionPolicy Bypass -File deploy\setup-server.ps1
#
# Safe to run again: every step checks before it changes anything, and no
# secret from .env is ever printed. Written for Windows PowerShell 5.1 (the
# version Windows Server ships with), so the file is plain ASCII.

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

# Same name as on the laptop, so existing notes and commands still apply.
$TaskName = 'NuTaste Sales Desk'

function Step($n, $text) { Write-Host ''; Write-Host "[$n] $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "    OK    $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    CHECK $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "    STOP  $text" -ForegroundColor Red; exit 1 }
function Ask($text)  { (Read-Host "    $text [y/n]").Trim().ToLower() -eq 'y' }

# TCP reachability with a short timeout (Test-NetConnection takes ~20s to give up).
function Test-Port($hostName, $port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $wait = $client.BeginConnect($hostName, $port, $null, $null)
        if (-not $wait.AsyncWaitHandle.WaitOne(5000)) { return $false }
        $client.EndConnect($wait); return $true
    } catch { return $false } finally { $client.Close() }
}

# --------------------------------------------------------------- 1. tools
Step 1 'Python and Git'
$pyExe = $null
if (Get-Command py -ErrorAction SilentlyContinue) {
    $pyExe = (& py -3 -c 'import sys; print(sys.executable)' 2>$null)
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $pyExe = (& python -c 'import sys; print(sys.executable)' 2>$null)
}
if (-not $pyExe) {
    Fail 'Python not found. Install Python 3.14 from python.org (tick "Add python.exe to PATH"), open a new window and run this again.'
}
$pyVer = (& $pyExe -c "import sys; print('%d.%d' % sys.version_info[:2])").Trim()
if ([version]$pyVer -lt [version]'3.11') { Fail "Python $pyVer is too old; install 3.14 (the laptop runs 3.14)." }
if ($pyVer -ne '3.14') { Warn "Python $pyVer found; the laptop runs 3.14. It should work, but 3.14 is the tested version." }
else { Ok "Python $pyVer ($pyExe)" }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail 'Git not found. Install Git for Windows from git-scm.com (default options), open a new window and run this again.'
}
Ok ((git --version) -join '')

# ---------------------------------------------------------------- 2. repo
Step 2 'Project folder'
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') { Fail "This copy is on branch '$branch'; it must be on main." }
$origin = (git remote get-url origin).Trim()
if ($origin -notmatch 'nutaste-sales-desk') { Fail "Unexpected GitHub remote: $origin" }
git pull --ff-only --quiet
if ($LASTEXITCODE -ne 0) { Fail 'git pull failed. Fix the error above (usually GitHub sign-in) and run this again.' }
Ok "Up to date with GitHub ($((git log -1 --format='%h %s') -join ''))"

# ------------------------------------------------- 3. files from the laptop
Step 3 'Settings and user accounts copied from the laptop'
$envPath = Join-Path $root '.env'
$credPath = Join-Path $root 'data\credentials.json'
if (-not (Test-Path $envPath))  { Fail '.env is missing. Copy it from the laptop folder by USB or network share (never by email or chat).' }
if (-not (Test-Path $credPath)) { Fail 'data\credentials.json is missing (the user accounts). Copy it from the laptop the same way.' }

$envVars = @{}
foreach ($line in Get-Content $envPath) {
    if ($line -match '^\s*#' -or [string]::IsNullOrWhiteSpace($line)) { continue }
    $k, $v = $line.Split('=', 2)
    if ($k) { $envVars[$k.Trim()] = "$v".Trim() }
}
$required = 'SECRET_KEY', 'ADMIN_PASSWORD_HASH', 'BC_AR_API_URL', 'BC_API_USERNAME', 'BC_API_PASSWORD', 'SEC_SOURCE_URL'
$missing = @($required | Where-Object { -not $envVars[$_] })
if ($missing.Count) { Fail ".env has no value for: $($missing -join ', ')" }
Ok '.env has every required setting (values not shown)'
Ok "data\credentials.json present ($([math]::Round((Get-Item $credPath).Length / 1KB, 1)) KB)"

if ($envVars['SEC_AUTO_PUSH'] -ne 'true') { Fail 'SEC_AUTO_PUSH must be true on the server, or refreshes never reach Render.' }
Ok 'SEC_AUTO_PUSH=true (refreshes are pushed to GitHub)'
if ($envVars['HOST'] -ne '127.0.0.1') {
    Warn 'HOST is not 127.0.0.1, so the app is open to the whole office network over plain http. Add HOST=127.0.0.1 to .env unless you want that.'
} else { Ok 'HOST=127.0.0.1 (only reachable on the server itself)' }

# ----------------------------------------------------- 4. python packages
Step 4 'Python environment'
$venvPy = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPy)) {
    & $pyExe -m venv .venv
    if ($LASTEXITCODE -ne 0) { Fail 'Could not create .venv.' }
}
& $venvPy -m pip install --quiet --disable-pip-version-check -r requirements.txt
if ($LASTEXITCODE -ne 0) { Fail 'Installing packages failed; see the error above.' }
Ok 'Packages installed from requirements.txt'

# ---------------------------------------------------------- 5. network
Step 5 'Network: can the server reach everything it needs?'
$bc = [uri]$envVars['BC_AR_API_URL']
$sp = [uri]$envVars['SEC_SOURCE_URL']
$targets = @(
    @{ Name = 'Business Central API (Receivables)'; Host = $bc.Host; Port = $bc.Port; Must = $true },
    @{ Name = 'SharePoint (Secondary Sales file)';  Host = $sp.Host; Port = 443;      Must = $true },
    @{ Name = 'GitHub (push to Render)';            Host = 'github.com'; Port = 443;  Must = $true },
    @{ Name = 'Google AI (Ask box)';                Host = 'generativelanguage.googleapis.com'; Port = 443; Must = $false }
)
$blocked = $false
foreach ($t in $targets) {
    if (Test-Port $t.Host $t.Port) { Ok "$($t.Name)" }
    elseif ($t.Must) { Write-Host "    STOP  $($t.Name): cannot reach $($t.Host):$($t.Port)" -ForegroundColor Red; $blocked = $true }
    else { Warn "$($t.Name): cannot reach $($t.Host):$($t.Port). The app works, but the Ask box will not." }
}
if ($blocked) { Fail 'Ask the network admin to allow the addresses above for this server, then run this again.' }

# --------------------------------------------------- 6. git identity + push
Step 6 'GitHub push access'
if (-not (git config user.name)) {
    $who = Read-Host '    Name to show on data commits (e.g. NuTaste Office Server)'
    git config user.name $who
}
if (-not (git config user.email)) {
    $mail = Read-Host '    Email for data commits'
    git config user.email $mail
}
Ok "Commits will be signed '$((git config user.name) -join '')'"
# A dry run proves the stored GitHub sign-in can push, without pushing anything.
# If no sign-in is stored yet, Git opens a browser window: sign in as the repo owner.
git push --dry-run --quiet origin main
if ($LASTEXITCODE -ne 0) { Fail 'This Windows account cannot push to GitHub. Sign in when Git asks, then run this again.' }
Ok "Push access works for Windows account $env:USERDOMAIN\$env:USERNAME"

# ----------------------------------------------------- 7. scheduled task
Step 7 "Scheduled task '$TaskName' (starts at boot, runs with nobody logged in)"
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$register = $true
if ($existing) { $register = Ask "A task called '$TaskName' already exists. Replace it?" }
if ($register) {
    # The task must run as THIS account: it holds the GitHub sign-in checked above.
    Write-Host "    Enter the Windows password for $env:USERDOMAIN\$env:USERNAME. Task Scheduler stores it so the app runs after a reboot with nobody logged in."
    $cred = Get-Credential -UserName "$env:USERDOMAIN\$env:USERNAME" -Message "Password for $env:USERDOMAIN\$env:USERNAME"
    if (-not $cred) { Fail 'No password entered; task not created.' }
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\run-web.ps1`"" `
        -WorkingDirectory $root
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
        -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited | Out-Null
    Ok 'Task registered: starts at boot, restarts the app if it stops'
} else { Ok 'Kept the existing task' }

# ------------------------------------------------------------- 8. start
Step 8 'Start the app'
Write-Host '    Only ONE machine may run the refreshes, or they will fight over GitHub.'
if (-not (Ask 'Is the scheduled task on the laptop stopped AND disabled (OFFICE-SERVER.md, step 3)?')) {
    Write-Host '    Not started. Stop the laptop first, then run:  Start-ScheduledTask -TaskName "NuTaste Sales Desk"'
    exit 0
}
$port = if ($envVars['PORT']) { $envVars['PORT'] } else { '8000' }
Start-ScheduledTask -TaskName $TaskName
$healthy = $false
for ($i = 0; $i -lt 45 -and -not $healthy; $i++) {
    Start-Sleep -Seconds 2
    try { $healthy = (Invoke-WebRequest "http://127.0.0.1:$port/healthz" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { }
}
if (-not $healthy) { Fail "The app did not answer on port $port within 90s. Look in logs\web-err.log." }
Ok "Running: open http://localhost:$port on this server"

Write-Host ''
Write-Host 'Setup complete. Carry on with step 5 (Check it works) in deploy\OFFICE-SERVER.md.' -ForegroundColor Green
