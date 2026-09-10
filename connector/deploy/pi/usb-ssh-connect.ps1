<#
  usb-ssh-connect.ps1 — the WINDOWS half of USB SSH.

  The card written by the flasher comes up as a USB Ethernet gadget at 10.55.0.1 with sshd on (see
  flasher/inject.js, usbGadgetSteps). This script does the only three things the PC side needs:

    1. FIND the adapter. It is identified by MAC, not by name: g_ether hands the Windows side the fixed
       host_addr 02-1A-11-00-00-02, and Windows names these adapters "Ethernet 4", "Ethernet 7", ... with no
       stable ordering. Matching the MAC is the only way to pick the right one on a machine that also has
       Wi-Fi, Tailscale, WSL/Hyper-V virtual switches and possibly a real NIC.
    2. Give it 10.55.0.2/24 with NO gateway and NO DNS. That is deliberate: a default route on this adapter
       would send the PC's internet traffic into a Raspberry Pi that cannot forward it.
    3. Wait for the Pi to answer, then hand over to ssh.

  Run it with -NoSsh to just configure the link, or -Reset to drop the config and let Windows have the
  adapter back.

  Needs Administrator (setting an IP does). USB-SSH.cmd elevates and calls this.
#>
[CmdletBinding()]
param(
  [string]$PiUser = 'admin',
  [switch]$NoSsh,
  [switch]$Reset
)

$ErrorActionPreference = 'Stop'

# Must match flasher/inject.js USB.* exactly. If you change them there, change them here.
$HOST_MAC = '02-1A-11-00-00-02'   # the PC-side MAC g_ether assigns (host_addr)
$PI_IP    = '10.55.0.1'
$PC_IP    = '10.55.0.2'
$PREFIX   = 24

function Info($m) { Write-Host "  $m" }
function Ok  ($m) { Write-Host "  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  $m" -ForegroundColor Yellow }
function Bad ($m) { Write-Host "  $m" -ForegroundColor Red }

Write-Host ""
Write-Host "AutoPost - connect to the Pi over USB" -ForegroundColor Cyan
Write-Host "-------------------------------------"

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Bad "This needs Administrator (it sets an IP address). Run USB-SSH.cmd instead, or start PowerShell as admin."
  exit 1
}

# ---- 1. find the gadget adapter by MAC -------------------------------------------------------------------
# -IncludeHidden so an adapter Windows has parked (disconnected cable, driver still binding) is still found and
# reported, instead of looking like it does not exist at all.
$nic = Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue |
       Where-Object { $_.MacAddress -eq $HOST_MAC } |
       Sort-Object { if ($_.Status -eq 'Up') { 0 } else { 1 } } |
       Select-Object -First 1

if (-not $nic) {
  Bad "No USB gadget adapter found (looking for MAC $HOST_MAC)."
  Write-Host ""
  Info "Check, in order:"
  Info "  * The cable is in the Pi's DATA port - on a Pi Zero / Zero 2 W that is the micro-USB marked"
  Info "    'USB', NOT the one marked 'PWR IN'. On a Pi 4 it is the USB-C port."
  Info "  * The cable is a DATA cable. A charge-only USB cable gives you a powered Pi and no adapter,"
  Info "    and looks identical. This is the single most common cause."
  Info "  * The Pi has finished its first boot. A freshly flashed card boots, provisions, and REBOOTS"
  Info "    itself once - the gadget only exists after that second boot. Allow ~90 seconds."
  Info "  * The card was written with USB SSH enabled (the checkbox in step 2 of the flasher)."
  Write-Host ""
  Info "If Windows shows an unknown 'RNDIS' device in Device Manager with a warning triangle, right-click"
  Info "it -> Update driver -> Browse -> Let me pick -> Network adapters -> Microsoft -> 'Remote NDIS"
  Info "Compatible Device' (or 'USB RNDIS Adapter'), then run this again."
  exit 2
}

Ok "Found adapter: '$($nic.Name)'  [$($nic.InterfaceDescription)]  status=$($nic.Status)"

# ---- Reset mode: hand the adapter back to Windows --------------------------------------------------------
if ($Reset) {
  Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
  Get-NetRoute -InterfaceIndex $nic.ifIndex -ErrorAction SilentlyContinue |
    Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
  try { Set-NetIPInterface -InterfaceIndex $nic.ifIndex -Dhcp Enabled -ErrorAction Stop } catch {}
  Ok "Reset - '$($nic.Name)' is back on DHCP."
  exit 0
}

if ($nic.Status -ne 'Up') {
  Warn "Adapter is '$($nic.Status)', not 'Up'. Configuring anyway - it usually comes up within a few seconds."
}

# ---- 2. static 10.55.0.2/24, no gateway, no DNS ----------------------------------------------------------
$existing = Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -eq $PC_IP -and $_.PrefixLength -eq $PREFIX }

if ($existing) {
  Ok "Already configured: $PC_IP/$PREFIX"
} else {
  Info "Setting $PC_IP/$PREFIX on '$($nic.Name)' (no gateway - this link must never carry internet traffic)"
  # Clear whatever is there first: a stale APIPA 169.254.x from a previous session, or an address left by an
  # earlier run, both prevent the new one from being added.
  Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
  Get-NetRoute -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' } |
    Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
  try { Set-NetIPInterface -InterfaceIndex $nic.ifIndex -Dhcp Disabled -ErrorAction Stop } catch {}
  New-NetIPAddress -InterfaceIndex $nic.ifIndex -IPAddress $PC_IP -PrefixLength $PREFIX -ErrorAction Stop | Out-Null
  # No DNS on this interface - otherwise Windows may try to resolve names through a Pi that serves none.
  try { Set-DnsClientServerAddress -InterfaceIndex $nic.ifIndex -ResetServerAddresses -ErrorAction Stop } catch {}
  Ok "Configured $PC_IP/$PREFIX"
}

# Treat the link as Private so the Windows firewall does not block the outbound SSH on a "Public" profile.
try {
  $prof = Get-NetConnectionProfile -InterfaceIndex $nic.ifIndex -ErrorAction Stop
  if ($prof.NetworkCategory -ne 'Private') {
    Set-NetConnectionProfile -InterfaceIndex $nic.ifIndex -NetworkCategory Private -ErrorAction Stop
    Info "Marked the link Private (firewall profile)"
  }
} catch { }

# ---- 3. wait for the Pi, then hand over to ssh -----------------------------------------------------------
Info "Waiting for $PI_IP to answer..."
$up = $false
foreach ($i in 1..30) {
  if (Test-Connection -ComputerName $PI_IP -Count 1 -Quiet -ErrorAction SilentlyContinue) { $up = $true; break }
  Start-Sleep -Seconds 2
}

if (-not $up) {
  Bad "$PI_IP is not responding after ~60s."
  Write-Host ""
  Info "The adapter exists, so the cable and port are fine - the Pi side has not brought usb0 up yet."
  Info "  * If the card was JUST flashed, it is still in its first-boot provisioning reboot. Wait and retry."
  Info "  * Otherwise, power-cycle the Pi and run this again."
  exit 3
}

Ok "$PI_IP is up."

if ($NoSsh) {
  Write-Host ""
  Info "Link ready. Connect with:  ssh $PiUser@$PI_IP"
  exit 0
}

$ssh = (Get-Command ssh.exe -ErrorAction SilentlyContinue)
if (-not $ssh) {
  Warn "The OpenSSH client is not installed. Install it with:"
  Info "  Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0"
  Info "Then run:  ssh $PiUser@$PI_IP"
  exit 0
}

Write-Host ""
Ok "Connecting: ssh $PiUser@$PI_IP"
Write-Host ""
# A reflashed card is a NEW host at the SAME address, so its host key legitimately changes every flash and
# strict checking would refuse to connect. Keep the known_hosts file out of it entirely for this link.
& $ssh.Source `
  -o StrictHostKeyChecking=no `
  -o UserKnownHostsFile=NUL `
  -o GlobalKnownHostsFile=NUL `
  -o LogLevel=ERROR `
  "$PiUser@$PI_IP"
