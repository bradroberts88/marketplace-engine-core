#!/usr/bin/env bash
#
# QConnect SD Provisioner (operator side)
# -----------------------------------
# Run this AFTER flashing Raspberry Pi OS Lite (64-bit, BOOKWORM or newer) to
# the SD card with Raspberry Pi Imager. It writes the QConnect payload to the
# boot partition so the device provisions itself on first power-up, and it
# issues the card a single-use enrolment ticket so the card registers ITSELF on
# first boot. No manual SQL step anywhere.
#
# Usage:
#   ./provision-sd.sh \
#     --boot /Volumes/bootfs \          # (macOS) or /media/$USER/bootfs (Linux)
#     --device-id QCN-0042 \
#     --dealer-id kendall-ford-meridian \
#     --supabase-url https://xyz.supabase.co \
#     --supabase-anon-key sb_publishable_... \
#     --supabase-service-key sb_secret_...    # used once, here, to issue the ticket
#
# Tailscale: with TAILSCALE_API_KEY and TAILSCALE_TAILNET in the environment a
# fresh single-use tagged key is minted per card automatically. Pass
# --tailscale-key tskey-auth-XXXX only to supply one by hand.
#
# Optional connectivity (all of them; the box tries cable, Wi-Fi, cellular,
# hotspot in that order and uses whichever works):
#     --wifi-ssid "DealerGuest" --wifi-pass "guestpass123" [--wifi-hidden]
#     --hotspot-ssid "Sales iPhone" --hotspot-pass "..."   # last-resort fallback
#     --cellular-apn broadband [--cellular-user u --cellular-pass p]
#                            AT&T default: broadband
#                            AT&T IoT/M2M:  m2m.com.attz
#                            AT&T MVNO:     att.mvno
#     --wifi-country US
#
# Batch bookkeeping:
#     --batch-id RUN-2026-09 [--batch-label "September pilot"]
#     --enrol-ttl-days 30        # how long the ticket stays valid before shipping
#
# With no Wi-Fi and no cable the box boots straight into AP fallback mode
# (QConnect-Setup-<id> hotspot, password qconnect123).

set -euo pipefail

BOOT=""
DEVICE_ID=""
DEALER_ID=""
WIFI_SSID=""
WIFI_PASS=""
WIFI_HIDDEN="no"
HOTSPOT_SSID=""
HOTSPOT_PASS=""
CELL_APN="broadband"   # AT&T fleet default; override with --cellular-apn
CELL_USER=""
CELL_PASS=""
TS_KEY=""
SB_URL=""
SB_KEY=""
SB_SERVICE_KEY="${QCONNECT_SERVICE_KEY:-}"
WIFI_COUNTRY="US"
BOOT_MOUNT=""          # override for the on-device boot mountpoint
BATCH_ID=""
BATCH_LABEL=""
ENROL_TTL_DAYS="30"
SKIP_ENROLMENT="no"

PAYLOAD_DIR="$(cd "$(dirname "$0")/.." && pwd)"
KEY_LEDGER="${QCONNECT_KEY_LEDGER:-$HOME/.qconnect-used-tailscale-keys}"

# shellcheck source=tailscale-keys.sh
. "$(dirname "$0")/tailscale-keys.sh"

usage() { grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
die() { echo "ERROR: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --boot)                 BOOT="$2"; shift 2 ;;
    --device-id)            DEVICE_ID="$2"; shift 2 ;;
    --dealer-id)            DEALER_ID="$2"; shift 2 ;;
    --wifi-ssid)            WIFI_SSID="$2"; shift 2 ;;
    --wifi-pass)            WIFI_PASS="$2"; shift 2 ;;
    --wifi-hidden)          WIFI_HIDDEN="yes"; shift ;;
    --hotspot-ssid)         HOTSPOT_SSID="$2"; shift 2 ;;
    --hotspot-pass)         HOTSPOT_PASS="$2"; shift 2 ;;
    --cellular-apn)         CELL_APN="$2"; shift 2 ;;
    --cellular-user)        CELL_USER="$2"; shift 2 ;;
    --cellular-pass)        CELL_PASS="$2"; shift 2 ;;
    --wifi-country)         WIFI_COUNTRY="$2"; shift 2 ;;
    --tailscale-key)        TS_KEY="$2"; shift 2 ;;
    --tailscale-tailnet)    TAILSCALE_TAILNET="$2"; shift 2 ;;
    --supabase-url)         SB_URL="$2"; shift 2 ;;
    --supabase-anon-key)    SB_KEY="$2"; shift 2 ;;
    --supabase-service-key) SB_SERVICE_KEY="$2"; shift 2 ;;
    --boot-mount)           BOOT_MOUNT="$2"; shift 2 ;;
    --batch-id)             BATCH_ID="$2"; shift 2 ;;
    --batch-label)          BATCH_LABEL="$2"; shift 2 ;;
    --enrol-ttl-days)       ENROL_TTL_DAYS="$2"; shift 2 ;;
    --skip-enrolment)       SKIP_ENROLMENT="yes"; shift ;;
    -h|--help)              usage ;;
    *) echo "Unknown arg: $1"; usage ;;
  esac
done

[[ -n "$BOOT" && -n "$DEVICE_ID" && -n "$DEALER_ID" && -n "$SB_URL" && -n "$SB_KEY" ]] \
  || { echo "ERROR: missing required args"; usage; }

[[ -f "$BOOT/cmdline.txt" ]] || die "$BOOT does not look like a Pi boot partition (no cmdline.txt)"

# A trailing slash produces //rest/v1/... which some gateways 404 - and then the
# card retries registration forever with no clue why.
SB_URL="${SB_URL%/}"

# --- one Tailscale key per card -------------------------------------------
# Minted automatically when the API token is present; otherwise the operator
# must supply one. Either way the key is used exactly once: a reused single-use
# key means only the FIRST card of a batch ever joins the tailnet.
if [[ -z "$TS_KEY" ]]; then
  ts_have_token || die "no --tailscale-key given and TAILSCALE_API_KEY / TAILSCALE_TAILNET are not set"
  echo "==> Minting a Tailscale key for $DEVICE_ID (tag ${TS_TAG}, ${TS_KEY_DAYS}d)"
  TS_KEY="$(ts_mint_key "$DEVICE_ID")" || die "could not mint a Tailscale key. Card NOT written."
fi
[[ -n "$TS_KEY" ]] || die "empty Tailscale key"

KEY_FP="$(printf '%s' "$TS_KEY" | shasum -a 256 2>/dev/null | awk '{print $1}')"
[[ -n "$KEY_FP" ]] || KEY_FP="$(printf '%s' "$TS_KEY" | sha256sum | awk '{print $1}')"
if [[ -f "$KEY_LEDGER" ]] && grep -q "^$KEY_FP " "$KEY_LEDGER"; then
  die "this Tailscale key was already used for $(grep "^$KEY_FP " "$KEY_LEDGER" | awk '{print $2}'). Mint a fresh key per card."
fi

# --- device token and enrolment ticket -------------------------------------
# Fixed-length hex. The old base64|tr|head pipeline could SIGPIPE under
# pipefail and abort mid-provision, and produced variable-length tokens.
DEVICE_TOKEN="$(od -An -tx1 -N20 /dev/urandom | tr -d ' \n')"
[[ ${#DEVICE_TOKEN} -eq 40 ]] || die "could not generate a device token"
ENROL_TICKET="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
[[ ${#ENROL_TICKET} -eq 48 ]] || die "could not generate an enrolment ticket"

# --- issue the ticket BEFORE writing the card ------------------------------
# The card creates its own row on first boot by presenting this ticket. Nobody
# runs SQL, and a card whose ticket never reached the server refuses to pretend
# it is fine - it reports the refusal and raises an alert.
if [[ "$SKIP_ENROLMENT" == "yes" ]]; then
  echo "!! Skipping ticket issue at your request. This card will NOT be able to enrol."
else
  [[ -n "$SB_SERVICE_KEY" ]] || die "--supabase-service-key is required to issue the enrolment ticket"
  echo "==> Issuing enrolment ticket for $DEVICE_ID"
  CODE=$(curl -s -o /tmp/qconnect-enrol.out -w '%{http_code}' --max-time 20 \
    -X POST "$SB_URL/rest/v1/rpc/qconnect_issue_enrolment" \
    -H "apikey: $SB_SERVICE_KEY" -H "Authorization: Bearer $SB_SERVICE_KEY" \
    -H "Content-Type: application/json" \
    -d "$(QP_D="$DEVICE_ID" QP_R="$DEALER_ID" QP_T="$ENROL_TICKET" QP_B="$BATCH_ID" \
          QP_L="$BATCH_LABEL" QP_TTL="$ENROL_TTL_DAYS" python3 -c \
        'import json,os
print(json.dumps({"p_device_id":os.environ["QP_D"],"p_dealer_id":os.environ["QP_R"],
                  "p_ticket":os.environ["QP_T"],
                  "p_batch_id":os.environ.get("QP_B") or None,
                  "p_batch_label":os.environ.get("QP_L") or None,
                  "p_ttl_days":int(os.environ.get("QP_TTL") or 30)}))')")
  if [[ "$CODE" != "200" && "$CODE" != "204" ]]; then
    die "ticket issue failed (HTTP $CODE): $(head -c 300 /tmp/qconnect-enrol.out). Card NOT written."
  fi
  echo "    ticket issued (valid ${ENROL_TTL_DAYS} days)."

  # Record WHICH remote-access key went onto this card, so the fleet dashboard
  # can warn before it expires instead of after. Never fatal: the card is
  # already good, and an unrecorded key simply shows as "unrecorded".
  if [[ -n "${TS_LAST_KEY_ID:-}" ]]; then
    curl -s -o /dev/null --max-time 15 \
      -X POST "$SB_URL/rest/v1/rpc/qconnect_record_card_key" \
      -H "apikey: $SB_SERVICE_KEY" -H "Authorization: Bearer $SB_SERVICE_KEY" \
      -H "Content-Type: application/json" \
      -d "$(QP_D="$DEVICE_ID" QP_K="$TS_LAST_KEY_ID" QP_E="${TS_LAST_KEY_EXPIRES:-}" python3 -c \
          'import json,os
print(json.dumps({"p_device_id":os.environ["QP_D"],"p_key_id":os.environ["QP_K"],
                  "p_expires_at":os.environ.get("QP_E") or None}))')" \
      && echo "    remote-access key recorded against the card." \
      || echo "    NOTE: could not record the key id; the card is fine, the dashboard will show it as unrecorded."
  fi
fi

echo "==> Writing QConnect payload to $BOOT"
mkdir -p "$BOOT/qconnect"
cp "$PAYLOAD_DIR/boot-payload/qconnect-firstrun.sh"         "$BOOT/qconnect/"
cp "$PAYLOAD_DIR/device/qconnect-setup.sh"                  "$BOOT/qconnect/"
cp "$PAYLOAD_DIR/device/qconnect-netmanager.sh"             "$BOOT/qconnect/"
# qconnect-setup.sh SOURCES this one. A card written without it stops dead on
# first boot with "no such file", online but unprovisioned and looking dead.
cp "$PAYLOAD_DIR/device/qconnect-steps.sh"                  "$BOOT/qconnect/"
cp "$PAYLOAD_DIR/device/qconnect-agent-update.sh"           "$BOOT/qconnect/"
cp "$PAYLOAD_DIR/device/qconnect-command-exec.sh"           "$BOOT/qconnect/"
cp "$PAYLOAD_DIR/device/qconnect-portal.py"                 "$BOOT/qconnect/"
cp "$PAYLOAD_DIR/device/qconnect-heartbeat.sh"              "$BOOT/qconnect/"
cp "$PAYLOAD_DIR/device/systemd/qconnect-setup.service"     "$BOOT/qconnect/"
cp "$PAYLOAD_DIR/device/systemd/qconnect-heartbeat.service" "$BOOT/qconnect/"
cp "$PAYLOAD_DIR/device/systemd/qconnect-heartbeat.timer"   "$BOOT/qconnect/"
cp "$PAYLOAD_DIR/device/systemd/qconnect-netwatch.service"  "$BOOT/qconnect/"
date -u +%FT%TZ > "$BOOT/qconnect/VERSION"

# provision.json — the device's identity and secrets. Values are passed via
# environment variables (never interpolated into code) so passwords with
# quotes, backslashes, spaces, or any special characters survive intact.
QP_DEVICE_ID="$DEVICE_ID" QP_DEALER_ID="$DEALER_ID" QP_TOKEN="$DEVICE_TOKEN" \
QP_TICKET="$ENROL_TICKET" QP_BATCH="$BATCH_ID" \
QP_SSID="$WIFI_SSID" QP_PASS="$WIFI_PASS" QP_HIDDEN="$WIFI_HIDDEN" QP_COUNTRY="$WIFI_COUNTRY" \
QP_HSSID="$HOTSPOT_SSID" QP_HPASS="$HOTSPOT_PASS" \
QP_APN="$CELL_APN" QP_CUSER="$CELL_USER" QP_CPASS="$CELL_PASS" \
QP_TSKEY="$TS_KEY" QP_SBURL="$SB_URL" QP_SBKEY="$SB_KEY" \
python3 - "$BOOT/qconnect/provision.json" <<'PYEOF'
import json, os, sys
json.dump({
    "device_id":         os.environ["QP_DEVICE_ID"],
    "dealer_id":         os.environ["QP_DEALER_ID"],
    "device_token":      os.environ["QP_TOKEN"],
    "enrolment_ticket":  os.environ.get("QP_TICKET", ""),
    "batch_id":          os.environ.get("QP_BATCH", ""),
    "wifi_ssid":         os.environ.get("QP_SSID", ""),
    "wifi_pass":         os.environ.get("QP_PASS", ""),
    "wifi_hidden":       os.environ.get("QP_HIDDEN", "no"),
    "wifi_country":      os.environ.get("QP_COUNTRY", "US"),
    "hotspot_ssid":      os.environ.get("QP_HSSID", ""),
    "hotspot_pass":      os.environ.get("QP_HPASS", ""),
    "cellular_apn":      os.environ.get("QP_APN", ""),
    "cellular_user":     os.environ.get("QP_CUSER", ""),
    "cellular_pass":     os.environ.get("QP_CPASS", ""),
    "tailscale_authkey": os.environ["QP_TSKEY"],
    "supabase_url":      os.environ["QP_SBURL"],
    "supabase_anon_key": os.environ["QP_SBKEY"],
}, open(sys.argv[1], "w"), indent=2)
PYEOF

# --- kernel command line hook ----------------------------------------------
# The path here is the path AS THE PI SEES IT once booted, not the path on this
# machine. Bookworm mounts the boot partition at /boot/firmware; older images at
# /boot. Getting this wrong means firstrun never runs and the card boots as
# stock Pi OS - which is exactly what "some cards do nothing" looked like.
if [[ -z "$BOOT_MOUNT" ]]; then
  if grep -qs 'auto_initramfs' "$BOOT/config.txt" || [[ -f "$BOOT/initramfs8" ]] \
     || grep -qsi 'bookworm\|trixie' "$BOOT/issue.txt"; then
    BOOT_MOUNT="/boot/firmware"
  else
    BOOT_MOUNT="/boot"
    echo "!! This card does not look like Bookworm. QConnect requires Bookworm or newer"
    echo "!! (NetworkManager). Re-flash, or pass --boot-mount if you know better."
  fi
fi
echo "==> Device will look for the payload at $BOOT_MOUNT/qconnect"

CMDLINE="$(cat "$BOOT/cmdline.txt")"
if [[ "$CMDLINE" != *"qconnect-firstrun"* ]]; then
  cp "$BOOT/cmdline.txt" "$BOOT/cmdline.txt.qconnect-bak"
  printf '%s systemd.run=%s/qconnect/qconnect-firstrun.sh systemd.run_success_action=reboot systemd.unit=kernel-command-line.target\n' \
    "$CMDLINE" "$BOOT_MOUNT" > "$BOOT/cmdline.txt"
fi

printf '%s %s %s\n' "$KEY_FP" "$DEVICE_ID" "$(date -u +%FT%TZ)" >> "$KEY_LEDGER"

# Manifest line for batch runs: one CSV row per card, appended.
if [[ -n "${QCONNECT_MANIFEST:-}" ]]; then
  printf '%s,%s,%s,%s,%s\n' "$DEVICE_ID" "$DEALER_ID" "$BATCH_ID" "$KEY_FP" \
    "$(date -u +%FT%TZ)" >> "$QCONNECT_MANIFEST"
fi

echo
echo "==> Done. Device summary:"
echo "    device_id:    $DEVICE_ID"
echo "    dealer_id:    $DEALER_ID"
echo "    batch:        ${BATCH_ID:-<none>}"
echo "    enrols itself: $([[ "$SKIP_ENROLMENT" == yes ]] && echo NO || echo "yes, on first boot")"
echo "    wired:        always tried first - a cable needs no setup at all"
echo "    wifi:         ${WIFI_SSID:-<none>}${WIFI_SSID:+$([[ $WIFI_HIDDEN == yes ]] && echo ' (hidden)')}"
echo "    cellular:     ${CELL_APN:-broadband} (AT&T default; fit a USB modem with an AT&T SIM)"
echo "    hotspot:      ${HOTSPOT_SSID:-<none>}"
echo "    setup rescue: QConnect-Setup-$DEVICE_ID / qconnect123"
echo
echo "Eject the card, put it in the QConnect, ship it. Dealer plugs in power (and a cable if they have one)."
