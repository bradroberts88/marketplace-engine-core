#!/usr/bin/env bash
#
# QConnect batch provisioner.
# ---------------------------
# Writes a run of cards, each with its own identity, device token, enrolment
# ticket and freshly minted Tailscale key, and records the run as a batch so the
# dashboard can show how far along it is and which cards never came up.
#
# Two ways to feed it:
#   --list cards.csv     device_id,dealer_id[,boot_path]     one card per line
#   --count 25 --prefix QCN- --dealer-id kendall-ford --boot /Volumes/bootfs
#
# With --count the writer pauses between cards so you can swap the SD card; with
# --list and a boot_path column it runs unattended over as many readers as you
# have plugged in (set --jobs to the number of readers).
#
# Every card is written by provision-sd.sh, so all of its flags apply here too —
# pass them after `--` and they are forwarded verbatim:
#
#   ./provision-batch.sh --count 25 --prefix QCN- --dealer-id kendall-ford \
#     --boot /Volumes/bootfs --batch-id RUN-2026-09 -- \
#     --supabase-url https://xyz.supabase.co --supabase-anon-key sb_publishable_... \
#     --wifi-ssid DealerGuest --wifi-pass guestpass123 --cellular-apn broadband
#
# At the end of a run, retire the shared key you started the day with:
#   ./provision-batch.sh --revoke-batch-key tskey-auth-XXXX
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tailscale-keys.sh
. "$HERE/tailscale-keys.sh"

LIST=""
COUNT=""
PREFIX="QCN-"
START=1
DEALER_ID=""
BOOT=""
BATCH_ID="RUN-$(date -u +%Y%m%d-%H%M)"
BATCH_LABEL=""
JOBS=1
MANIFEST=""
REVOKE_KEY=""
FORWARD=()

die() { echo "ERROR: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list)              LIST="$2"; shift 2 ;;
    --count)             COUNT="$2"; shift 2 ;;
    --prefix)            PREFIX="$2"; shift 2 ;;
    --start)             START="$2"; shift 2 ;;
    --dealer-id)         DEALER_ID="$2"; shift 2 ;;
    --boot)              BOOT="$2"; shift 2 ;;
    --batch-id)          BATCH_ID="$2"; shift 2 ;;
    --batch-label)       BATCH_LABEL="$2"; shift 2 ;;
    --jobs)              JOBS="$2"; shift 2 ;;
    --manifest)          MANIFEST="$2"; shift 2 ;;
    --revoke-batch-key)  REVOKE_KEY="$2"; shift 2 ;;
    --)                  shift; FORWARD=("$@"); break ;;
    -h|--help)           grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
    *) die "unknown arg: $1" ;;
  esac
done

if [[ -n "$REVOKE_KEY" ]]; then
  ts_revoke_key "$REVOKE_KEY" && { echo "Batch key retired."; exit 0; }
  die "could not retire that key (check TAILSCALE_API_KEY / TAILSCALE_TAILNET)"
fi

[[ -n "$LIST" || -n "$COUNT" ]] || die "give either --list or --count"
ts_have_token || echo "!! TAILSCALE_API_KEY / TAILSCALE_TAILNET not set - each card will need --tailscale-key"

MANIFEST="${MANIFEST:-$PWD/$BATCH_ID-manifest.csv}"
LOGDIR="${QCONNECT_LOGDIR:-$PWD/$BATCH_ID-logs}"
mkdir -p "$LOGDIR"
[[ -f "$MANIFEST" ]] || echo "device_id,dealer_id,batch_id,tailscale_key_fp,written_at" > "$MANIFEST"

write_card() {
  local device_id="$1" dealer_id="$2" boot="$3" log="$LOGDIR/$1.log"
  if QCONNECT_MANIFEST="$MANIFEST" "$HERE/provision-sd.sh" \
        --boot "$boot" --device-id "$device_id" --dealer-id "$dealer_id" \
        --batch-id "$BATCH_ID" ${BATCH_LABEL:+--batch-label "$BATCH_LABEL"} \
        "${FORWARD[@]}" >"$log" 2>&1; then
    echo "  ok   $device_id"
  else
    echo "  FAIL $device_id  (see $log)"
    echo "$device_id" >> "$LOGDIR/failed.txt"
    return 1
  fi
}

echo "==> Batch $BATCH_ID"
echo "    manifest: $MANIFEST"
echo "    logs:     $LOGDIR"

written=0
failed=0

if [[ -n "$LIST" ]]; then
  [[ -f "$LIST" ]] || die "no such list: $LIST"
  running=0
  while IFS=, read -r dev dealer boot_path; do
    [[ -z "${dev// }" || "$dev" == \#* || "$dev" == "device_id" ]] && continue
    dealer="${dealer:-$DEALER_ID}"
    boot_path="${boot_path:-$BOOT}"
    [[ -n "$dealer" && -n "$boot_path" ]] || die "row '$dev' needs a dealer and a boot path"
    if [[ "$JOBS" -gt 1 ]]; then
      write_card "$dev" "$dealer" "$boot_path" &
      running=$((running + 1))
      if [[ "$running" -ge "$JOBS" ]]; then wait -n 2>/dev/null || wait; running=$((running - 1)); fi
    else
      write_card "$dev" "$dealer" "$boot_path" && written=$((written + 1)) || failed=$((failed + 1))
    fi
  done < "$LIST"
  wait
else
  [[ -n "$DEALER_ID" && -n "$BOOT" ]] || die "--count needs --dealer-id and --boot"
  for i in $(seq "$START" $((START + COUNT - 1))); do
    dev="$(printf '%s%04d' "$PREFIX" "$i")"
    echo
    echo "--- card $dev : insert the flashed SD card and press Enter (or Ctrl-C to stop)"
    read -r _
    write_card "$dev" "$DEALER_ID" "$BOOT" && written=$((written + 1)) || failed=$((failed + 1))
    echo "    eject the card."
  done
fi

[[ -f "$LOGDIR/failed.txt" ]] && failed=$(wc -l < "$LOGDIR/failed.txt" | tr -d ' ')

echo
echo "==> Batch $BATCH_ID finished: $written written, ${failed:-0} failed."
echo "    Watch them come up on the fleet page; every card enrols itself on first boot."
