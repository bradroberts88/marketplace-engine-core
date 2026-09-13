#!/usr/bin/env bash
# QConnect Tailscale key minting.
#
# Sourced by provision-sd.sh. One fresh, single-use, tagged, expiring key per
# card — a shared batch key means only the first card of a run ever joins.
#
# Needs two values in the environment (never on the command line, never in git):
#   TAILSCALE_API_KEY   an API access token with auth-key write scope
#   TAILSCALE_TAILNET   your tailnet, e.g. example.com or tail1234.ts.net
#
# The tag below must be declared in the tailnet ACL before any key can carry it
# (see docs/TAILSCALE-ACL.md). A tagged node has no user identity: it cannot be
# used to reach anything except what the ACL explicitly allows.
set -u

TS_API=${TS_API:-https://api.tailscale.com/api/v2}
TS_TAG=${TS_TAG:-tag:qconnect-device}
TS_KEY_DAYS=${TS_KEY_DAYS:-90}

ts_have_token() { [ -n "${TAILSCALE_API_KEY:-}" ] && [ -n "${TAILSCALE_TAILNET:-}" ]; }

# ts_mint_key <device-id>  ->  prints the key on stdout
# Fails loudly. A card written with an empty key is a card that never joins.
ts_mint_key() {
  local device_id="$1" body resp code seconds
  ts_have_token || { echo "ERROR: TAILSCALE_API_KEY / TAILSCALE_TAILNET not set" >&2; return 1; }
  seconds=$(( TS_KEY_DAYS * 86400 ))

  body=$(QT_TAG="$TS_TAG" QT_DESC="qconnect $device_id" QT_EXP="$seconds" python3 -c '
import json, os
print(json.dumps({
    "capabilities": {"devices": {"create": {
        "reusable": False,
        "ephemeral": False,
        "preauthorized": True,
        "tags": [os.environ["QT_TAG"]],
    }}},
    "expirySeconds": int(os.environ["QT_EXP"]),
    "description": os.environ["QT_DESC"],
}))')

  resp=$(mktemp)
  code=$(curl -s -o "$resp" -w '%{http_code}' --max-time 25 \
    -u "${TAILSCALE_API_KEY}:" -H "Content-Type: application/json" \
    -X POST "$TS_API/tailnet/${TAILSCALE_TAILNET}/keys" -d "$body")
  if [ "$code" != "200" ]; then
    echo "ERROR: Tailscale key request failed (HTTP $code): $(head -c 300 "$resp")" >&2
    rm -f "$resp"; return 1
  fi
  python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["key"])' "$resp" || {
    echo "ERROR: Tailscale returned no key" >&2; rm -f "$resp"; return 1; }
  rm -f "$resp"
}

# ts_list_keys — key ids currently valid on the tailnet, one per line
ts_list_keys() {
  ts_have_token || return 1
  curl -s --max-time 25 -u "${TAILSCALE_API_KEY}:" \
    "$TS_API/tailnet/${TAILSCALE_TAILNET}/keys" |
    python3 -c 'import json,sys;[print(k["id"]) for k in json.load(sys.stdin).get("keys",[])]' 2>/dev/null
}

# ts_revoke_key <key-id|key> — retires a key so it can never be used again.
# Used at the end of a batch to kill the shared key the run started with.
ts_revoke_key() {
  local id="$1" code
  ts_have_token || return 1
  # A full key looks like tskey-auth-<id>-<secret>; the API wants just the id.
  case "$id" in tskey-*) id=$(echo "$id" | cut -d- -f3) ;; esac
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
    -u "${TAILSCALE_API_KEY}:" -X DELETE "$TS_API/tailnet/${TAILSCALE_TAILNET}/keys/$id")
  [ "$code" = "200" ] || [ "$code" = "204" ]
}
