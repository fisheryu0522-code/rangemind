$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$appPort = 8731
$appUrl = "http://127.0.0.1:$appPort"
$runtimeNode = (Get-Command node -ErrorAction Stop).Source
$existing = $null
try { $existing = Invoke-RestMethod "$appUrl/api/status" -TimeoutSec 2 } catch {}
if ($existing -and $existing.app -ne 'PokerLab') { throw 'Port 8731 is already in use by another application.' }
if (-not $existing) {
    $appLog = Join-Path $appRoot 'data'
    New-Item -ItemType Directory -Path $appLog -Force | Out-Null
    $serverFile = Join-Path $appRoot 'server.mjs'
    $env:POKERLAB_PORT = [string]$appPort
    $appProcess = Start-Process -FilePath $runtimeNode -ArgumentList @('"' + $serverFile + '"') -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $appLog 'server.log') -RedirectStandardError (Join-Path $appLog 'server-error.log') -PassThru
    $appProcess.Id | Set-Content (Join-Path $appLog 'server.pid')
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 300
        try { $s = Invoke-RestMethod "$appUrl/api/status" -TimeoutSec 1; if ($s.app -eq 'PokerLab') { $ready = $true; break } } catch {}
    }
    if (-not $ready) { throw 'PokerLab did not start. Check data/server-error.log.' }
}
try { Start-Process $appUrl } catch { Write-Host "PokerLab is running. Open $appUrl in your browser." }
