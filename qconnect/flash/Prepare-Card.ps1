<#
    QConnect card preparation — Windows edition.

    The Windows equivalent of provision-sd.sh. Run it AFTER writing Raspberry Pi
    OS Lite (64-bit, Bookworm or newer) to the memory card with Raspberry Pi
    Imager. It writes the QConnect payload onto the card's boot partition so the
    Pi sets itself up on first power-up, and issues the card a single-use
    enrolment ticket so it registers ITSELF. No SQL by hand, anywhere.

    Double-click friendly: with no arguments it asks for what it needs.

      powershell -ExecutionPolicy Bypass -File .\Prepare-Card.ps1

    Or non-interactively:

      .\Prepare-Card.ps1 -BootDrive E: -DeviceId QCN-0042 `
          -DealerId kendall-ford-meridian `
          -WifiSsid "DealerGuest" -WifiPass "guestpass123"

    Settings that are the same for every card are read from the environment so
    they never end up in a screenshot or in git:

      QCONNECT_SUPABASE_URL        https://<project>.supabase.co
      QCONNECT_SUPABASE_ANON_KEY   sb_publishable_...
      QCONNECT_SERVICE_KEY         sb_secret_...   (used once, here)
      TAILSCALE_API_KEY            token with auth-key write scope
      TAILSCALE_TAILNET            e.g. example.com

    The script refuses to write a half-good card. Every failure stops before the
    card is touched, so a card either leaves this script fully correct or not
    written at all.
#>

[CmdletBinding()]
param(
    [string] $BootDrive,
    [string] $DeviceId,
    [string] $DealerId,
    [string] $WifiSsid = "",
    [string] $WifiPass = "",
    [switch] $WifiHidden,
    [string] $HotspotSsid = "",
    [string] $HotspotPass = "",
    [string] $CellularApn = "broadband",
    [string] $CellularUser = "",
    [string] $CellularPass = "",
    [string] $WifiCountry = "US",
    [string] $BatchId = "",
    [string] $BatchLabel = "",
    [int]    $EnrolTtlDays = 30,
    [string] $TailscaleKey = "",
    [string] $SupabaseUrl = $env:QCONNECT_SUPABASE_URL,
    [string] $SupabaseAnonKey = $env:QCONNECT_SUPABASE_ANON_KEY,
    [string] $SupabaseServiceKey = $env:QCONNECT_SERVICE_KEY,
    [string] $BootMount,
    [switch] $SkipEnrolment
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Die([string] $message) {
    Write-Host ""
    Write-Host "STOPPED: $message" -ForegroundColor Red
    Write-Host "The card has NOT been changed. Fix the above and run this again." -ForegroundColor Red
    exit 1
}

function AskIfEmpty([string] $value, [string] $prompt) {
    if ([string]::IsNullOrWhiteSpace($value)) { return (Read-Host $prompt).Trim() }
    return $value
}

$payloadDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$keyLedger = if ($env:QCONNECT_KEY_LEDGER) { $env:QCONNECT_KEY_LEDGER }
             else { Join-Path $env:USERPROFILE '.qconnect-used-tailscale-keys' }

Write-Host ""
Write-Host "QConnect card preparation" -ForegroundColor Cyan
Write-Host "-------------------------"

# --- what card, and is it really a Pi card? ---------------------------------
if ([string]::IsNullOrWhiteSpace($BootDrive)) {
    Write-Host ""
    Write-Host "Removable drives Windows can see right now:"
    Get-Volume |
        Where-Object { $_.DriveLetter -and $_.DriveType -eq 'Removable' } |
        Select-Object DriveLetter, FileSystemLabel,
            @{ n = 'SizeGB'; e = { [math]::Round($_.Size / 1GB, 1) } } |
        Format-Table | Out-Host
    Write-Host "The Pi card shows up as a small drive (about 0.2 GB) usually named bootfs."
    $BootDrive = (Read-Host "Which drive letter is it? (for example E)").Trim()
}
$BootDrive = $BootDrive.TrimEnd(':', '\')
$boot = "${BootDrive}:\"

if (-not (Test-Path $boot)) { Die "there is no drive $BootDrive on this computer." }
if (-not (Test-Path (Join-Path $boot 'cmdline.txt'))) {
    Die "drive $BootDrive does not look like a freshly written Pi card (no cmdline.txt on it). Write Raspberry Pi OS Lite 64-bit to the card first."
}

# --- who is this card? -------------------------------------------------------
$DeviceId = AskIfEmpty $DeviceId "A short name for this Pi (for example QCN-0042)"
$DealerId = AskIfEmpty $DealerId "Which dealership is it going to (for example kendall-ford-meridian)"
if ([string]::IsNullOrWhiteSpace($DeviceId)) { Die "every card needs its own name." }
if ([string]::IsNullOrWhiteSpace($DealerId)) { Die "every card needs a dealership." }

if (-not $PSBoundParameters.ContainsKey('WifiSsid') -and [string]::IsNullOrWhiteSpace($WifiSsid)) {
    Write-Host ""
    Write-Host "Wi-Fi is optional. A cable always wins and needs no setup, and the SIM is"
    Write-Host "already configured - but filling Wi-Fi in costs nothing and gives the Pi"
    Write-Host "another way to rescue itself. Press Enter to skip."
    $WifiSsid = (Read-Host "Wi-Fi name").Trim()
    if ($WifiSsid) { $WifiPass = (Read-Host "Wi-Fi password").Trim() }
}

if ([string]::IsNullOrWhiteSpace($SupabaseUrl) -or [string]::IsNullOrWhiteSpace($SupabaseAnonKey)) {
    Die "the fleet address and key are not set on this computer (QCONNECT_SUPABASE_URL / QCONNECT_SUPABASE_ANON_KEY). Ask for the bench settings file and run it first."
}
$SupabaseUrl = $SupabaseUrl.TrimEnd('/')

# --- one remote-access key per card -----------------------------------------
function New-TailscaleKey([string] $deviceId) {
    if (-not $env:TAILSCALE_API_KEY -or -not $env:TAILSCALE_TAILNET) {
        Die "no remote-access key was supplied and TAILSCALE_API_KEY / TAILSCALE_TAILNET are not set."
    }
    $tag = if ($env:TS_TAG) { $env:TS_TAG } else { 'tag:qconnect-device' }
    $days = if ($env:TS_KEY_DAYS) { [int] $env:TS_KEY_DAYS } else { 90 }
    $body = @{
        capabilities   = @{ devices = @{ create = @{
            reusable = $false; ephemeral = $false; preauthorized = $true; tags = @($tag) } } }
        expirySeconds  = $days * 86400
        description    = "qconnect $deviceId"
    } | ConvertTo-Json -Depth 8
    $auth = [Convert]::ToBase64String(
        [Text.Encoding]::ASCII.GetBytes("$($env:TAILSCALE_API_KEY):"))
    try {
        $resp = Invoke-RestMethod -Method Post -TimeoutSec 25 `
            -Uri "https://api.tailscale.com/api/v2/tailnet/$($env:TAILSCALE_TAILNET)/keys" `
            -Headers @{ Authorization = "Basic $auth" } `
            -ContentType 'application/json' -Body $body
    } catch {
        Die "could not get a remote-access key for this card: $($_.Exception.Message)"
    }
    if (-not $resp.key) { Die "the remote-access service returned no key." }
    # Strict mode turns a missing property into an error, and the shape of this
    # reply is not ours to depend on. Read both defensively.
    $script:TsKeyId = if ($resp.PSObject.Properties['id']) { $resp.id } else { $null }
    $script:TsKeyExpires = if ($resp.PSObject.Properties['expires']) { $resp.expires } else { $null }
    return $resp.key
}

$script:TsKeyId = $null
$script:TsKeyExpires = $null
if ([string]::IsNullOrWhiteSpace($TailscaleKey)) {
    Write-Host ""
    Write-Host "==> Getting this card its own remote-access key"
    $TailscaleKey = New-TailscaleKey $DeviceId
}

# A single-use key used twice means only the FIRST card ever joins. Keep a
# local ledger and refuse a repeat outright.
$sha = [Security.Cryptography.SHA256]::Create()
$keyFingerprint = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($TailscaleKey)) |
    ForEach-Object { $_.ToString('x2') })
if (Test-Path $keyLedger) {
    $seen = Select-String -Path $keyLedger -Pattern "^$keyFingerprint " -Quiet
    if ($seen) { Die "this remote-access key has already been used on another card. Each card needs its own." }
}

# --- identity and ticket ------------------------------------------------------
function New-HexToken([int] $bytes) {
    $buf = New-Object byte[] $bytes
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
    return (-join ($buf | ForEach-Object { $_.ToString('x2') }))
}
$deviceToken = New-HexToken 20   # 40 hex chars
$enrolTicket = New-HexToken 24   # 48 hex chars

# --- issue the ticket BEFORE writing the card --------------------------------
if ($SkipEnrolment) {
    Write-Host "!! Skipping the ticket at your request. This card will NOT be able to register." -ForegroundColor Yellow
} else {
    if ([string]::IsNullOrWhiteSpace($SupabaseServiceKey)) {
        Die "the one-time admin key (QCONNECT_SERVICE_KEY) is not set, so no ticket can be issued for this card."
    }
    Write-Host "==> Registering $DeviceId with the fleet"
    $headers = @{ apikey = $SupabaseServiceKey; Authorization = "Bearer $SupabaseServiceKey" }
    $payload = @{
        p_device_id   = $DeviceId
        p_dealer_id   = $DealerId
        p_ticket      = $enrolTicket
        p_batch_id    = if ($BatchId) { $BatchId } else { $null }
        p_batch_label = if ($BatchLabel) { $BatchLabel } else { $null }
        p_ttl_days    = $EnrolTtlDays
    } | ConvertTo-Json -Depth 5
    try {
        Invoke-RestMethod -Method Post -TimeoutSec 20 `
            -Uri "$SupabaseUrl/rest/v1/rpc/qconnect_issue_enrolment" `
            -Headers $headers -ContentType 'application/json' -Body $payload | Out-Null
    } catch {
        Die "the fleet would not register this card: $($_.Exception.Message)"
    }
    Write-Host "    registered (the ticket is good for $EnrolTtlDays days)."

    # Record WHICH key went onto THIS card so the dashboard can warn before it
    # runs out. Never fatal - the card is already good either way.
    if ($script:TsKeyId) {
        $rec = @{
            p_device_id = $DeviceId
            p_key_id    = $script:TsKeyId
            p_expires_at = if ($script:TsKeyExpires) { $script:TsKeyExpires } else { $null }
        } | ConvertTo-Json -Depth 5
        try {
            Invoke-RestMethod -Method Post -TimeoutSec 15 `
                -Uri "$SupabaseUrl/rest/v1/rpc/qconnect_record_card_key" `
                -Headers $headers -ContentType 'application/json' -Body $rec | Out-Null
            Write-Host "    remote-access key recorded against the card."
        } catch {
            Write-Host "    NOTE: could not record the key; the card is fine, it will show as unrecorded." -ForegroundColor Yellow
        }
    }
}

# --- write the payload --------------------------------------------------------
Write-Host "==> Writing the QConnect files to $boot"
$dest = Join-Path $boot 'qconnect'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$files = @(
    'boot-payload\qconnect-firstrun.sh',
    'device\qconnect-setup.sh',
    'device\qconnect-netmanager.sh',
    # qconnect-setup.sh SOURCES this one. A card without it boots, looks alive,
    # and never finishes setting itself up.
    'device\qconnect-steps.sh',
    'device\qconnect-agent-update.sh',
    'device\qconnect-command-exec.sh',
    'device\qconnect-portal.py',
    'device\qconnect-heartbeat.sh',
    'device\systemd\qconnect-setup.service',
    'device\systemd\qconnect-heartbeat.service',
    'device\systemd\qconnect-heartbeat.timer',
    'device\systemd\qconnect-netwatch.service'
)
foreach ($rel in $files) {
    $src = Join-Path $payloadDir $rel
    if (-not (Test-Path $src)) { Die "a required file is missing from this folder: $rel" }
    # Shell scripts must keep Unix line endings or the Pi refuses to run them.
    $text = [IO.File]::ReadAllText($src) -replace "`r`n", "`n"
    [IO.File]::WriteAllText((Join-Path $dest (Split-Path -Leaf $rel)), $text,
        (New-Object Text.UTF8Encoding $false))
}
[IO.File]::WriteAllText((Join-Path $dest 'VERSION'),
    ((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') + "`n"),
    (New-Object Text.UTF8Encoding $false))

$provision = [ordered]@{
    device_id         = $DeviceId
    dealer_id         = $DealerId
    device_token      = $deviceToken
    enrolment_ticket  = $enrolTicket
    batch_id          = $BatchId
    wifi_ssid         = $WifiSsid
    wifi_pass         = $WifiPass
    wifi_hidden       = if ($WifiHidden) { 'yes' } else { 'no' }
    wifi_country      = $WifiCountry
    hotspot_ssid      = $HotspotSsid
    hotspot_pass      = $HotspotPass
    cellular_apn      = $CellularApn
    cellular_user     = $CellularUser
    cellular_pass     = $CellularPass
    tailscale_authkey = $TailscaleKey
    supabase_url      = $SupabaseUrl
    supabase_anon_key = $SupabaseAnonKey
}
[IO.File]::WriteAllText((Join-Path $dest 'provision.json'),
    (($provision | ConvertTo-Json -Depth 5) -replace "`r`n", "`n"),
    (New-Object Text.UTF8Encoding $false))

# --- first-run hook -----------------------------------------------------------
# This path is the path AS THE PI SEES IT, not the Windows drive letter. Bookworm
# mounts the boot partition at /boot/firmware; older images at /boot. Getting it
# wrong means the Pi boots as plain Raspberry Pi OS and does nothing - which is
# exactly what "some cards just sat there" looked like.
if ([string]::IsNullOrWhiteSpace($BootMount)) {
    $configText = if (Test-Path (Join-Path $boot 'config.txt')) { Get-Content -Raw (Join-Path $boot 'config.txt') } else { '' }
    $issueText = if (Test-Path (Join-Path $boot 'issue.txt')) { Get-Content -Raw (Join-Path $boot 'issue.txt') } else { '' }
    if ($configText -match 'auto_initramfs' -or (Test-Path (Join-Path $boot 'initramfs8')) -or
        $issueText -match '(?i)bookworm|trixie') {
        $BootMount = '/boot/firmware'
    } else {
        Die "this card does not look like Raspberry Pi OS Bookworm or newer. QConnect needs Bookworm. Re-write the card with Raspberry Pi OS Lite (64-bit)."
    }
}
Write-Host "==> The Pi will look for its setup files at $BootMount/qconnect"

$cmdlinePath = Join-Path $boot 'cmdline.txt'
$cmdline = ([IO.File]::ReadAllText($cmdlinePath)).Trim()
if ($cmdline -notmatch 'qconnect-firstrun') {
    Copy-Item $cmdlinePath (Join-Path $boot 'cmdline.txt.qconnect-bak') -Force
    $new = "$cmdline systemd.run=$BootMount/qconnect/qconnect-firstrun.sh systemd.run_success_action=reboot systemd.unit=kernel-command-line.target`n"
    [IO.File]::WriteAllText($cmdlinePath, $new, (New-Object Text.UTF8Encoding $false))
}

Add-Content -Path $keyLedger -Value ("{0} {1} {2}" -f $keyFingerprint, $DeviceId,
    (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))

if ($env:QCONNECT_MANIFEST) {
    Add-Content -Path $env:QCONNECT_MANIFEST -Value ("{0},{1},{2},{3},{4}" -f
        $DeviceId, $DealerId, $BatchId, $keyFingerprint,
        (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))
}

Write-Host ""
Write-Host "==> Done. This card is ready." -ForegroundColor Green
Write-Host "    name:          $DeviceId"
Write-Host "    dealership:    $DealerId"
Write-Host "    batch:         $(if ($BatchId) { $BatchId } else { '<none>' })"
Write-Host "    registers itself: $(if ($SkipEnrolment) { 'NO' } else { 'yes, on first power-up' })"
Write-Host "    cable:         always tried first - needs no setup at all"
Write-Host "    Wi-Fi:         $(if ($WifiSsid) { $WifiSsid } else { '<none>' })"
Write-Host "    SIM:           $CellularApn (AT&T default)"
Write-Host "    rescue page:   QConnect-Setup-$DeviceId / qconnect123"
Write-Host ""
Write-Host "Safely eject the card in Windows, put it back in the Pi, and power it on."
