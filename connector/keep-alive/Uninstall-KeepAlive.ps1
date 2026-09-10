# Removes the AutoPost always-on supervisor scheduled task. (Leaves the watchdog script + log in place; delete
# %LOCALAPPDATA%\AutoPost\keep-alive.ps1 too if you want a full cleanup.)
$ErrorActionPreference = 'SilentlyContinue'
schtasks /Delete /TN 'AutoPost Keep-Alive' /F | Out-Null
Write-Host "Removed the 'AutoPost Keep-Alive' scheduled task."
