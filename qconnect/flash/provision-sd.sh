#!/usr/bin/env bash
#
# QConnect SD Provisioner (operator side)
# -----------------------------------
# Run this AFTER flashing Raspberry Pi OS Lite (64-bit, Bookworm) to the SD
# card with Raspberry Pi Imager. It writes the QConnect payload to the boot
# partition so the device provisions itself on first power-up.
#
# Usage:
#   ./provision-sd.sh \
#     --boot /Volumes/bootfs \          # (macOS) or /media/$USER/bootfs (Linux)
#     --device-id QCN-0042 \
#     --dealer-id kendall-ford-meridian \
#     --wifi-ssid "DealerGuest" \
#     --wifi-pass "guestpass123" \      # optional; omit for AP-fallback-only
#     --tailscale-key tskey-auth-XXXX \
#     --supabase-url https://xyz.supabase.co \
#     --supabase-anon-key eyJhbGciOi...
#
# Wi-Fi creds are optional. Without them the box boots straight into
# AP fallback mode (QConnect-Setup-<id> hotspot).

set -euo pipefail

BOOT=""
DEVICE_ID=""
DEALER_ID=""
WIFI_SSID=""
WIFI_PASS=""
TS_KEY=""
SB_URL=""
SB_KEY=""
WIFI_COUNTRY="US"

PAYLOAD_DIR="$(cd "$(dirname "$0")/.." && pwd)"

usage() { grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --boot)               BOOT="$2"; shift 2 ;;
    --device-id)          DEVICE_ID="$2"; shift 2 ;;
    --dealer-id)          DEALER_ID="$2"; shift 2 ;;
    --wifi-ssid)          WIFI_SSID="$2"; shift 2 ;;
    --wifi-pass)          WIFI_PASS="$2"; shift 2 ;;
    --wifi-country)       WIFI_COUNTRY="$2"; shift 2 ;;
    --tailscale-key)      TS_KEY="$2"; shift 2 ;;
    --supabase-url)       SB_URL="$2"; shift 2 ;;
    --supabase-anon-key)  SB_KEY="$2"; shift 2 ;;
    -h|--help)            usage ;;
    *) echo "Unknown arg: $1"; usage ;;
  esac
done

[[ -n "$BOOT" && -n "$DEVICE_ID" && -n "$DEALER_ID" && -n "$TS_KEY" && -n "$SB_URL" && -n "$SB_KEY" ]] \
  || { echo "ERROR: missing required args"; usage; }

[[ -f "$BOOT/cmdline.txt" ]] || { echo "ERROR: $BOOT does not look like a Pi boot partition (no cmdline.txt)"; exit 1; }

# Per-device secret used to authenticate registration + heartbeats to Supabase.
DEVICE_TOKEN="$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 40)"

echo "==> Writing QConnect payload to $BOOT"
mkdir -p "$BOOT/qconnect"
cp "$PAYLOAD_DIR/boot-payload/qconnect-firstrun.sh"      "$BOOT/qconnect/"
cp "$PAYLOAD_DIR/device/qconnect-setup.sh"               "$BOOT/qconnect/"
cp "$PAYLOAD_DIR/device/qconnect-portal.py"              "$BOOT/qconnect/"
cp "$PAYLOAD_DIR/device/qconnect-heartbeat.sh"           "$BOOT/qconnect/"
cp "$PAYLOAD_DIR/device/systemd/qconnect-setup.service"  "$BOOT/qconnect/"
cp "$PAYLOAD_DIR/device/systemd/qconnect-heartbeat.service" "$BOOT/qconnect/"
cp "$PAYLOAD_DIR/device/systemd/qconnect-heartbeat.timer"   "$BOOT/qconnect/"

# provision.json — the device's identity and secrets. Values are passed via
# environment variables (never interpolated into code) so passwords with
# quotes, backslashes, spaces, or any special characters survive intact.
QP_DEVICE_ID="$DEVICE_ID" QP_DEALER_ID="$DEALER_ID" QP_TOKEN="$DEVICE_TOKEN" \
QP_SSID="$WIFI_SSID" QP_PASS="$WIFI_PASS" QP_COUNTRY="$WIFI_COUNTRY" \
QP_TSKEY="$TS_KEY" QP_SBURL="$SB_URL" QP_SBKEY="$SB_KEY" \
python3 - "$BOOT/qconnect/provision.json" <<'PYEOF'
import json, os, sys
json.dump({
    "device_id":         os.environ["QP_DEVICE_ID"],
    "dealer_id":         os.environ["QP_DEALER_ID"],
    "device_token":      os.environ["QP_TOKEN"],
    "wifi_ssid":         os.environ.get("QP_SSID", ""),
    "wifi_pass":         os.environ.get("QP_PASS", ""),
    "wifi_country":      os.environ.get("QP_COUNTRY", "US"),
    "tailscale_authkey": os.environ["QP_TSKEY"],
    "supabase_url":      os.environ["QP_SBURL"],
    "supabase_anon_key": os.environ["QP_SBKEY"],
}, open(sys.argv[1], "w"), indent=2)
PYEOF

# Hook firstrun into the kernel command line (same mechanism Raspberry Pi
# Imager uses). It self-removes after running once.
CMDLINE="$(cat "$BOOT/cmdline.txt")"
if [[ "$CMDLINE" != *"qconnect-firstrun"* ]]; then
  cp "$BOOT/cmdline.txt" "$BOOT/cmdline.txt.qconnect-bak"
  printf '%s systemd.run=/boot/qconnect/qconnect-firstrun.sh systemd.run_success_action=reboot systemd.unit=kernel-command-line.target\n' "$CMDLINE" > "$BOOT/cmdline.txt"
fi

echo
echo "==> Done. Device summary:"
echo "    device_id:    $DEVICE_ID"
echo "    dealer_id:    $DEALER_ID"
echo "    wifi:         ${WIFI_SSID:-<none - AP fallback only>}"
echo "    device_token: $DEVICE_TOKEN"
echo
echo "Pre-register this device in Supabase (or let it self-register):"
echo "  select public.qconnect_preregister('$DEVICE_ID', '$DEALER_ID', '$DEVICE_TOKEN');"
echo
echo "Eject the card, put it in the QConnect, ship it. Dealer just plugs in power."
