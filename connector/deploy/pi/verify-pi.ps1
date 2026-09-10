<#
  verify-pi.ps1 — bench acceptance test for a freshly flashed Pi. ONE command, PASS or FAIL.

  You never type an SSH command. This brings up the USB link, runs deploy/pi/pi-verify.sh on the Pi, and prints a
  verdict. Intended for a production line: flash -> boot -> plug in USB -> run this -> box it or re-flash it.

  Usage (normally via VERIFY-PI.cmd, which elevates):
      verify-pi.ps1                      # standard checks
      verify-pi.ps1 -Ap                  # also prove the rescue AP raises (adds ~45s, worth it)
      verify-pi.ps1 -ExpectSsid "Dealer WiFi"   # also assert the right dealership profile is on the card
      verify-pi.ps1 -Log C:\qa\pis.csv   # append the result to a CSV log for the batch
#>
[CmdletBinding()]
param(
  [string]$PiUser = 'admin',
  [string]$KeyPath = "$env:USERPROFILE\.ssh\id_ed25519",
  [switch]$Ap,
  [string]$ExpectSsid = '',
  [string]$Log = '',
  [int]$WaitSeconds = 120
)

$ErrorActionPreference = 'Stop'
$HOST_MAC = '02-1A-11-00-00-02'
$PI_IP    = '10.55.0.1'
$PC_IP    = '10.55.0.2'
$PREFIX   = 24

function Line { param($c='Gray',$m) Write-Host $m -ForegroundColor $c }
function Big  { param($c,$m) Write-Host ""; Write-Host "  $m  " -ForegroundColor White -BackgroundColor $c; Write-Host "" }

Write-Host ""
Line Cyan "AutoPost - bench verification"
Line DarkGray "-----------------------------"

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Big Red "CANNOT RUN - needs Administrator. Use VERIFY-PI.cmd."
  exit 1
}
if (-not (Test-Path $KeyPath)) {
  Big Red "NO SSH KEY at $KeyPath - flash cards with your public key so this can log in unattended."
  exit 1
}

# ---- 1. wait for the gadget, then configure this PC's side -------------------------------------------------
Line Gray "Waiting for the Pi's USB adapter..."
$nic = $null
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  $nic = Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue |
         Where-Object { $_.MacAddress -eq $HOST_MAC } | Select-Object -First 1
  if ($nic) { break }
  Start-Sleep -Seconds 2
}
if (-not $nic) {
  Big Red "FAIL - no USB gadget. Pi not booted, charge-only cable, or wrong port (use the inner 'USB' one)."
  exit 2
}
Line Green "  adapter: $($nic.Name)"

$have = Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -eq $PC_IP }
if (-not $have) {
  Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
  try { Set-NetIPInterface -InterfaceIndex $nic.ifIndex -Dhcp Disabled -ErrorAction Stop } catch {}
  New-NetIPAddress -InterfaceIndex $nic.ifIndex -IPAddress $PC_IP -PrefixLength $PREFIX -ErrorAction Stop | Out-Null
}
try { Set-NetConnectionProfile -InterfaceIndex $nic.ifIndex -NetworkCategory Private -ErrorAction Stop } catch {}

Line Gray "Waiting for $PI_IP..."
$up = $false
foreach ($i in 1..30) {
  if (Test-Connection -ComputerName $PI_IP -Count 1 -Quiet -ErrorAction SilentlyContinue) { $up = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $up) { Big Red "FAIL - adapter present but $PI_IP never answered. Power-cycle the Pi and retry."; exit 3 }
Line Green "  $PI_IP is up"

# ---- 2. run the acceptance test on the Pi ------------------------------------------------------------------
$script = Join-Path $PSScriptRoot 'pi-verify.sh'
if (-not (Test-Path $script)) { Big Red "FAIL - pi-verify.sh not found next to this script."; exit 4 }

$sshArgs = @('-i', $KeyPath, '-o','StrictHostKeyChecking=no', '-o','UserKnownHostsFile=NUL',
             '-o','GlobalKnownHostsFile=NUL', '-o','BatchMode=yes', '-o','ConnectTimeout=10',
             '-o','LogLevel=ERROR', "$PiUser@$PI_IP")

$remoteArgs = @()
if ($Ap) { $remoteArgs += '--ap' }
if ($ExpectSsid) { $remoteArgs += @('--expect-ssid', "'" + ($ExpectSsid -replace "'","'\''") + "'") }

Line Gray "Running checks on the Pi$(if($Ap){' (including the rescue-AP smoke test)'})..."
$cmd = "sudo -n bash -s -- $($remoteArgs -join ' ') 2>/dev/null || bash -s -- $($remoteArgs -join ' ')"
$out = (Get-Content $script -Raw) | & ssh @sshArgs $cmd 2>&1

if (-not $out) { Big Red "FAIL - the Pi returned nothing. Key not authorized for '$PiUser'?"; exit 5 }

# ---- 3. render ---------------------------------------------------------------------------------------------
Write-Host ""
$serial = ''; $hostn = ''
foreach ($l in ($out -split "`n")) {
  $l = $l.TrimEnd()
  if ($l -match '^INFO serial=(.*)$')   { $serial = $Matches[1]; Line DarkGray "  serial   $serial"; continue }
  if ($l -match '^INFO hostname=(.*)$') { $hostn  = $Matches[1]; Line DarkGray "  hostname $hostn";  continue }
  if ($l -match '^INFO model=(.*)$')    { Line DarkGray "  model    $($Matches[1])"; continue }
  if ($l -match '^PASS (.+)$')          { Line Green      "  [ OK ]   $($Matches[1])"; continue }
  if ($l -match '^WARN (.+?) :: (.+)$') { Line Yellow     "  [WARN]   $($Matches[1])"; Line DarkYellow "           $($Matches[2])"; continue }
  if ($l -match '^FAIL (.+?) :: (.+)$') { Line Red        "  [FAIL]   $($Matches[1])"; Line DarkRed    "           $($Matches[2])"; continue }
}

$verdict = if ($out -match 'VERDICT:\s*PASS') { 'PASS' } elseif ($out -match 'VERDICT:\s*FAIL') { 'FAIL' } else { 'UNKNOWN' }

switch ($verdict) {
  'PASS'    { Big DarkGreen "PASS - this unit is OK to ship" }
  'FAIL'    { Big DarkRed   "FAIL - DO NOT SHIP this unit" }
  default   { Big DarkYellow "UNKNOWN - the test did not complete; re-run before shipping" }
}

if ($Log) {
  $row = '{0},{1},{2},{3},{4}' -f (Get-Date -Format s), $hostn, $serial, $verdict, $(if($Ap){'with-ap'}else{'standard'})
  if (-not (Test-Path $Log)) { 'timestamp,hostname,serial,verdict,mode' | Out-File -FilePath $Log -Encoding utf8 }
  $row | Out-File -FilePath $Log -Append -Encoding utf8
  Line DarkGray "  logged to $Log"
}

if ($verdict -eq 'PASS') { exit 0 } else { exit 1 }
