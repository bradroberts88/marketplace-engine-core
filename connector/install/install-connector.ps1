<#
  Install the Dealership Connector as an always-on background task on this Windows PC.
  - Starts automatically at boot (before/without anyone logging in).
  - Restarts itself if it ever stops (via run-agent.cmd + the task's restart-on-failure).
  - Runs hidden (no window).

  Run this in an ADMINISTRATOR PowerShell:  right-click PowerShell > "Run as administrator", then:
      Set-ExecutionPolicy -Scope Process Bypass -Force
      .\install-connector.ps1

  Prereqs: Node.js LTS installed for "all users" (so SYSTEM can find it), and config.json filled in.
  Security note: this runs as SYSTEM for reliable boot-start. For a hardened deployment, switch it to a
  dedicated low-privilege service account (see docs/DEALERSHIP-TUNNEL-SECURITY.md).
#>
$ErrorActionPreference = 'Stop'
$TaskName = 'DealershipConnector'

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host 'Please run this in an ADMINISTRATOR PowerShell (right-click > Run as administrator).' -ForegroundColor Yellow; exit 1 }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path   # ...\install
$root = Split-Path -Parent $here                          # ...\desktop-connector
$cmd  = Join-Path $here 'run-agent.cmd'

if (-not (Test-Path (Join-Path $root 'src\agent.js'))) { Write-Host "Can't find the connector at $root. Run this from desktop-connector\install." -ForegroundColor Red; exit 1 }
if (-not (Test-Path (Join-Path $root 'config.json')))  { Write-Host "config.json not found in $root. Copy config.example.json to config.json and fill it in first." -ForegroundColor Red; exit 1 }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Node.js not found on the system PATH. Install the LTS "all users" build from https://nodejs.org then re-run.' -ForegroundColor Red; exit 1 }

$action   = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$cmd`""
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Hidden
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host ""
Write-Host "Installed. The connector now:" -ForegroundColor Green
Write-Host "  - starts automatically every time this PC boots,"
Write-Host "  - keeps running in the background (no window),"
Write-Host "  - restarts itself if it ever stops or is restarted from the super-admin."
Write-Host ""
Write-Host "Manage it in Task Scheduler under '$TaskName'. To remove: .\uninstall-connector.ps1"
