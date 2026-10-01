$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$envFile = Join-Path $PSScriptRoot '.env'
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*#' -or [string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        $k,$v = $line.Split('=', 2)
        if (-not [string]::IsNullOrWhiteSpace($k)) {
            [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim(), 'Process')
        }
    }
}

$bindHost = [Environment]::GetEnvironmentVariable('HOST', 'Process')
if ([string]::IsNullOrWhiteSpace($bindHost)) {
    $bindHost = '0.0.0.0'
}

$listenPort = [Environment]::GetEnvironmentVariable('PORT', 'Process')
if ([string]::IsNullOrWhiteSpace($listenPort)) {
    $listenPort = '8000'
}

$existing = Get-NetTCPConnection -LocalPort $listenPort -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Port $listenPort is already in use; the app appears to be running already."
    exit 0
}

$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$process = Start-Process -FilePath $python `
    -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--host', $bindHost, '--port', $listenPort) `
    -WorkingDirectory $PSScriptRoot `
    -RedirectStandardOutput (Join-Path $logDir 'web-out.log') `
    -RedirectStandardError (Join-Path $logDir 'web-err.log') `
    -WindowStyle Hidden `
    -PassThru

Write-Host "NuTaste Sales Desk is now running on http://$($bindHost):$($listenPort)"
Write-Host "Logs: $logDir"
$process | Out-Null
