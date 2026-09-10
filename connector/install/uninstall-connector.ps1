<#
  Remove the Dealership Connector background task. Run in an ADMINISTRATOR PowerShell.
#>
$ErrorActionPreference = 'SilentlyContinue'
$TaskName = 'DealershipConnector'

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host 'Please run this in an ADMINISTRATOR PowerShell.' -ForegroundColor Yellow; exit 1 }

Stop-ScheduledTask -TaskName $TaskName
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false

# Stop any agent still running from the supervisor loop.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*src\agent.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Write-Host "Removed '$TaskName'. The connector will no longer start on boot." -ForegroundColor Green
