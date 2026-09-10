# Installs the AutoPost always-on supervisor: a per-user scheduled task (no admin) that (re)starts AutoPost and
# restarts it when it dies OR when it is running-but-wedged (heartbeat-aware). Survives crash / quit / close /
# reboot / sleep. The dealership installer runs this.
$ErrorActionPreference = 'Stop'
$taskName = 'AutoPost Keep-Alive'

$runtimeDir = Join-Path $env:LOCALAPPDATA 'AutoPost'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$watchdog = Join-Path $runtimeDir 'keep-alive.ps1'
Copy-Item -Path (Join-Path $PSScriptRoot 'keep-alive.ps1') -Destination $watchdog -Force
$vbs = Join-Path $runtimeDir 'run-hidden.vbs'
Copy-Item -Path (Join-Path $PSScriptRoot 'run-hidden.vbs') -Destination $vbs -Force

# Runs completely hidden (wscript -> run-hidden.vbs -> hidden PowerShell). Triggers: AT LOGON (fast recovery
# after a reboot) PLUS a repeating trigger every 1 minute forever (catches crash / quit / wedge while logged on,
# and catches up immediately after sleep via StartWhenAvailable). Battery flags so it ALSO runs on a dealership
# laptop (a plain schtasks task defaults to AC-power-only and would silently not run on battery).
# Remove any existing task first, then register fresh — replacing a task in place can throw "Access denied"
# depending on how it was originally created (schtasks vs cmdlet). Delete-then-create sidesteps that.
try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop } catch { schtasks /Delete /TN $taskName /F 2>$null | Out-Null }

$registered = $false
try {
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"')
  $tLogon = New-ScheduledTaskTrigger -AtLogOn
  $tRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($tLogon, $tRepeat) -Settings $settings -Principal $principal -ErrorAction Stop | Out-Null
  $registered = $true
} catch {
  Write-Host "Register-ScheduledTask failed; falling back to schtasks."
}
if (-not $registered) {
  # Proven simple task: runs the hidden watchdog every minute while logged on. Best-effort battery allowance.
  schtasks /Create /TN $taskName /TR ('wscript.exe "' + $vbs + '"') /SC MINUTE /MO 1 /RL LIMITED /F | Out-Null
  try { $s = Get-ScheduledTask -TaskName $taskName; $s.Settings.DisallowStartIfOnBatteries = $false; $s.Settings.StopIfGoingOnBatteries = $false; Set-ScheduledTask -TaskName $taskName -Settings $s.Settings -ErrorAction Stop | Out-Null } catch {}
}

Write-Host "Installed scheduled task '$taskName' (health-aware; ~1 min + at-logon; runs on battery)."
Write-Host "It restarts AutoPost on crash/quit/close/reboot AND when it is running-but-wedged (stale heartbeat)."
Write-Host "Watchdog: $watchdog"
