# AutoPost keep-alive watchdog — HEALTH-AWARE.
# Run by the "AutoPost Keep-Alive" scheduled task (every ~1 min, in the user's interactive session, hidden via
# run-hidden.vbs so no console flashes). This is what makes the tunnel ALWAYS-ON: it (re)starts AutoPost when it
# is missing, AND — crucially — restarts it when it is running but WEDGED (a process being alive is NOT proof it
# works; RULE 0). The agent writes heartbeat.json every ~15s; a stale timestamp means the app is frozen.
$ErrorActionPreference = 'SilentlyContinue'
$runtimeDir   = Join-Path $env:LOCALAPPDATA 'AutoPost'
$exe          = Join-Path $env:LOCALAPPDATA 'Programs\AutoPost\AutoPost.exe'
$log          = Join-Path $runtimeDir 'keep-alive.log'
$disabledFlag = Join-Path $runtimeDir 'disabled.flag'
$heartbeat    = Join-Path $runtimeDir 'heartbeat.json'
function Note($m) { try { if (-not (Test-Path $runtimeDir)) { New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null }; "$((Get-Date).ToString('s'))  $m" | Out-File -FilePath $log -Append -Encoding utf8 } catch {} }

# The ONE permitted user-stop: a real "Turn off AutoPost" action writes this flag. While it exists we never start
# the app, so a DELIBERATE disable stays disabled. Quit / close / crash do NOT write it — they still auto-restart.
if (Test-Path $disabledFlag) { exit 0 }

if (-not (Test-Path $exe)) { Note "AutoPost.exe not found at $exe"; exit 0 }

$proc = Get-CimInstance Win32_Process -Filter "Name='AutoPost.exe'" -ErrorAction SilentlyContinue
if (-not $proc) { Note 'AutoPost not running -> starting it'; Start-Process -FilePath $exe; exit 0 }

# HEALTH check: if the app is running but its heartbeat is STALE (frozen / wedged main loop), kill the whole tree
# and restart clean. A MISSING heartbeat is left alone (the app may be starting up, or running the no-config
# preview which does not write one). connected=false with a FRESH ts is also left alone (it is reconnecting).
if (Test-Path $heartbeat) {
  try {
    $hb = Get-Content $heartbeat -Raw | ConvertFrom-Json
    $nowMs  = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $ageSec = ($nowMs - [double]$hb.ts) / 1000
    if ($ageSec -gt 90) {
      Note ("heartbeat stale " + [int]$ageSec + "s (app wedged) -> kill + restart")
      Get-Process AutoPost -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 800
      Start-Process -FilePath $exe
    }
  } catch { Note "heartbeat parse error: $($_.Exception.Message)" }
}
exit 0
