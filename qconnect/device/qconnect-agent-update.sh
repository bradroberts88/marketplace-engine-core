#!/bin/bash
# QConnect self-update with a safety net.
#
# The box downloads the bundle the server is pointing it at, refuses it unless
# the SHA-256 matches AND the detached signature verifies against the public
# key baked into the image, installs it beside the current version, and flips a
# symlink. If the new version cannot reach the server within the health window,
# the symlink goes back and the old version keeps running.
#
# Run from the heartbeat timer (after qconnect-command-exec.sh).
set -u
QCONNECT=${QCONNECT:-/opt/qconnect}
STATE=$QCONNECT/state
PROV=$QCONNECT/etc/provision.json
PUBKEY=$QCONNECT/etc/qconnect-release.pub
RELEASES=$QCONNECT/releases
CURRENT=$QCONNECT/current            # symlink -> releases/<version>
LOG=/var/log/qconnect-update.log
HEALTH_WINDOW_S=${QCONNECT_HEALTH_WINDOW_S:-600}

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }
[ -f "$PROV" ] || exit 0

jget() { python3 -c "import json;print(json.load(open('$PROV')).get('$1',''))" 2>/dev/null; }
DEVICE_ID=$(jget device_id); DEVICE_TOKEN=$(jget device_token)
SB_URL=$(jget supabase_url); SB_URL=${SB_URL%/}
SB_KEY=$(jget supabase_anon_key)
CUR_VERSION=$(cat "$QCONNECT/VERSION" 2>/dev/null || echo unknown)

report() { # report <version> <status> [error]
  local body
  body=$(QU_DEV="$DEVICE_ID" QU_TOK="$DEVICE_TOKEN" QU_VER="$1" QU_ST="$2" \
         QU_FROM="$CUR_VERSION" QU_ERR="${3:-}" python3 -c '
import json, os
print(json.dumps({
    "p_device_id": os.environ["QU_DEV"], "p_device_token": os.environ["QU_TOK"],
    "p_version": os.environ["QU_VER"], "p_status": os.environ["QU_ST"],
    "p_from_version": os.environ["QU_FROM"],
    "p_error": (os.environ.get("QU_ERR") or None),
}))')
  curl -s --max-time 15 -X POST "$SB_URL/rest/v1/rpc/qconnect_report_update" \
    -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
    -H "Content-Type: application/json" -d "$body" > /dev/null
}

# ---------------------------------------------------------- pending rollback?
# Written before the switch. If the new version never marked itself healthy in
# time, put the old one back on the next run — even if that run IS the broken
# version, because this script is the last thing to be swapped.
if [ -f "$STATE/update-pending" ]; then
  PEND_VER=$(sed -n 1p "$STATE/update-pending")
  PEND_PREV=$(sed -n 2p "$STATE/update-pending")
  PEND_AT=$(sed -n 3p "$STATE/update-pending")
  NOW=$(date +%s)
  if [ -f "$STATE/update-healthy" ]; then
    rm -f "$STATE/update-pending" "$STATE/update-healthy"
    report "$PEND_VER" healthy
    log "version $PEND_VER confirmed healthy"
  elif [ $((NOW - PEND_AT)) -gt "$HEALTH_WINDOW_S" ]; then
    log "version $PEND_VER never reported healthy; rolling back to $PEND_PREV"
    ln -sfn "$RELEASES/$PEND_PREV" "$CURRENT"
    echo "$PEND_PREV" > "$QCONNECT/VERSION"
    rm -f "$STATE/update-pending"
    systemctl restart qconnect-netwatch.service > /dev/null 2>&1
    report "$PEND_VER" rolled_back "no healthy check-in within ${HEALTH_WINDOW_S}s"
    exit 0
  else
    # Still inside the window: a successful poll is the proof we need.
    if curl -s --max-time 10 -o /dev/null \
        -X POST "$SB_URL/rest/v1/rpc/qconnect_poll_commands" \
        -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
        -H "Content-Type: application/json" \
        -d "{\"p_device_id\":\"$DEVICE_ID\",\"p_device_token\":\"$DEVICE_TOKEN\"}"; then
      touch "$STATE/update-healthy"
    fi
    exit 0
  fi
fi

# ------------------------------------------------------------ target release
TARGET=$STATE/target-release.json
[ -s "$TARGET" ] || exit 0
read_target() { python3 -c "import json;d=json.load(open('$TARGET')) or {};print(d.get('$1') or '')" 2>/dev/null; }
VERSION=$(read_target version)
BUNDLE_URL=$(read_target bundle_url)
SHA256=$(read_target sha256)
SIGNATURE=$(read_target signature)
[ -n "${QCONNECT_FORCE_VERSION:-}" ] && [ "$QCONNECT_FORCE_VERSION" != "$VERSION" ] && exit 0
[ -n "$VERSION" ] && [ -n "$BUNDLE_URL" ] || exit 0
[ "$VERSION" = "$CUR_VERSION" ] && exit 0
[ -f "$PUBKEY" ] || { log "no release public key on this card; refusing to update"; exit 0; }

log "update available: $CUR_VERSION -> $VERSION"
report "$VERSION" started

WORK=$(mktemp -d /tmp/qconnect-update.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
BUNDLE=$WORK/bundle.tar.gz

if ! curl -fsSL --max-time 300 -o "$BUNDLE" "$BUNDLE_URL"; then
  log "download failed"; report "$VERSION" failed "download failed"; exit 1
fi

GOT=$(sha256sum "$BUNDLE" | awk '{print $1}')
if [ "$GOT" != "$SHA256" ]; then
  log "checksum mismatch"; report "$VERSION" failed "checksum mismatch"; exit 1
fi

echo "$SIGNATURE" | base64 -d > "$WORK/bundle.sig" 2>/dev/null
if ! openssl pkeyutl -verify -pubin -inkey "$PUBKEY" -rawin -in "$BUNDLE" \
        -sigfile "$WORK/bundle.sig" > /dev/null 2>&1; then
  log "SIGNATURE REJECTED for $VERSION"
  report "$VERSION" failed "signature rejected"
  exit 1
fi

# --------------------------------------------------------------- install
mkdir -p "$RELEASES/$VERSION"
if ! tar -xzf "$BUNDLE" -C "$RELEASES/$VERSION"; then
  log "unpack failed"; report "$VERSION" failed "unpack failed"; rm -rf "${RELEASES:?}/$VERSION"; exit 1
fi
chmod +x "$RELEASES/$VERSION"/*.sh 2>/dev/null

# First update on a card that was flashed with loose files: snapshot what is
# running now so there is something to roll back to.
PREV=$CUR_VERSION
if [ ! -d "$RELEASES/$PREV" ]; then
  mkdir -p "$RELEASES/$PREV"
  cp -a "$QCONNECT"/*.sh "$QCONNECT"/*.py "$RELEASES/$PREV"/ 2>/dev/null
fi

ln -sfn "$RELEASES/$VERSION" "$CURRENT"
# The live scripts are the ones systemd runs out of $QCONNECT, so mirror them.
cp -a "$RELEASES/$VERSION"/. "$QCONNECT"/ 2>/dev/null
echo "$VERSION" > "$QCONNECT/VERSION"

printf '%s\n%s\n%s\n' "$VERSION" "$PREV" "$(date +%s)" > "$STATE/update-pending"
rm -f "$STATE/update-healthy"
report "$VERSION" installed
log "installed $VERSION; watching for a healthy check-in (${HEALTH_WINDOW_S}s)"

systemctl restart qconnect-netwatch.service > /dev/null 2>&1
tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
exit 0
