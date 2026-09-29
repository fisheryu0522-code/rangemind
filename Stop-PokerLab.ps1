$ErrorActionPreference = 'Stop'
try {
    $status = Invoke-RestMethod 'http://127.0.0.1:8731/api/status' -TimeoutSec 2
    if ($status.app -eq 'PokerLab' -and $status.version -ne '0.1.0') {
        Invoke-RestMethod 'http://127.0.0.1:8731/api/pro/shutdown' -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 3 | Out-Null
        exit
    }
} catch {}
$pidFile = Join-Path $PSScriptRoot 'data\server.pid'
if (Test-Path -LiteralPath $pidFile) {
    $savedPid = [int](Get-Content -LiteralPath $pidFile)
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid" -ErrorAction SilentlyContinue
    $expectedScript = Join-Path $PSScriptRoot 'server.mjs'
    if ($p -and $p.CommandLine -and $p.CommandLine.Contains($expectedScript)) {
        $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$savedPid"
        foreach ($child in $children) {
            if ($child.Name -in @('console_solver.exe','river-engine.exe','turn-engine.exe','llama-server.exe')) { Stop-Process -Id $child.ProcessId -ErrorAction SilentlyContinue }
            elseif ($child.Name -eq 'python.exe' -and $child.CommandLine -and $child.CommandLine.Contains((Join-Path $PSScriptRoot 'lib'))) { Stop-Process -Id $child.ProcessId -ErrorAction SilentlyContinue }
        }
        Stop-Process -Id $savedPid -ErrorAction SilentlyContinue
    }
}
