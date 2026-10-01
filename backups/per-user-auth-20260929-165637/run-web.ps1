# Foreground runner for the NuTaste Sales Desk web app.
#
# Unlike start-web.ps1 (which launches uvicorn and returns), this script *stays*
# in the foreground and restarts uvicorn if it ever exits. That is what the
# "NuTaste Sales Desk" scheduled task runs, so Windows can see whether the app
# is alive and restart the whole thing if this script itself dies.
#
# Run it by hand only for debugging; day to day it is started by the task at logon.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# ---------------------------------------------------------------- environment
$envFile = Join-Path $PSScriptRoot '.env'
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*#' -or [string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        $k, $v = $line.Split('=', 2)
        if (-not [string]::IsNullOrWhiteSpace($k)) {
            [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim(), 'Process')
        }
    }
}

$bindHost = [Environment]::GetEnvironmentVariable('HOST', 'Process')
if ([string]::IsNullOrWhiteSpace($bindHost)) { $bindHost = '0.0.0.0' }

$listenPort = [Environment]::GetEnvironmentVariable('PORT', 'Process')
if ([string]::IsNullOrWhiteSpace($listenPort)) { $listenPort = '8000' }

$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'web.log'

function Write-Log($message) {
    "$(Get-Date -Format 's')  $message" | Add-Content -Path $log
}

# Keep the log from growing without bound across months of uptime.
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 10MB)) {
    Move-Item $log (Join-Path $logDir 'web.log.old') -Force
}

$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) {
    Write-Log "FATAL: python not found at $python"
    exit 1
}

# Another copy already holds the port (e.g. a manual start-web.ps1 run). Exiting
# non-zero lets the scheduled task retry later instead of fighting over the port.
$existing = Get-NetTCPConnection -LocalPort $listenPort -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Write-Log "Port $listenPort already in use by PID $($existing[0].OwningProcess); not starting a second copy."
    exit 0
}

# ------------------------------------------------------------- supervise loop
# From here on a stray error must not kill the supervisor: uvicorn writes its
# banner to stderr, and under 'Stop' that would end the script on startup.
$ErrorActionPreference = 'Continue'

$outLog = Join-Path $logDir 'web-out.log'
$errLog = Join-Path $logDir 'web-err.log'

Write-Log "Supervisor starting: http://$($bindHost):$($listenPort)"
while ($true) {
    Write-Log 'Launching uvicorn...'
    # Start-Process keeps stdout/stderr as plain files instead of turning them
    # into PowerShell error records, which is what -Wait buys us here.
    $proc = Start-Process -FilePath $python `
        -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--host', $bindHost, '--port', $listenPort) `
        -WorkingDirectory $PSScriptRoot `
        -RedirectStandardOutput $outLog `
        -RedirectStandardError $errLog `
        -WindowStyle Hidden `
        -PassThru `
        -Wait

    Write-Log "uvicorn exited with code $($proc.ExitCode); restarting in 5s."
    Start-Sleep -Seconds 5
}
