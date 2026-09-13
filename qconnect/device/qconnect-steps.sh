#!/bin/bash
# QConnect step reporter.
#
# Sourced by the setup script and callable on its own:
#   qconnect-steps.sh power_on ok
#   qconnect-steps.sh network_up fail "no dealer Wi-Fi in range"
#
# Reporting is best effort by design: a box with no internet cannot tell the
# server it has no internet. The server-side watchdog turns that silence into
# an overdue step, which is the whole point of the deadlines.
set -u
QCONNECT=${QCONNECT:-/opt/qconnect}
STATE=$QCONNECT/state
PROV=$QCONNECT/etc/provision.json
STEP_LOG=/var/log/qconnect-steps.log

qc_jget() { python3 -c "import json;print(json.load(open('$PROV')).get('$1',''))" 2>/dev/null; }

# report_step <step> <ok|fail> [detail]
report_step() {
  local step="$1" verdict="${2:-ok}" detail="${3:-}"
  [ -f "$PROV" ] || return 0

  local dev tok url key ok payload code
  dev=$(qc_jget device_id); tok=$(qc_jget device_token)
  url=$(qc_jget supabase_url); url=${url%/}
  key=$(qc_jget supabase_anon_key)
  [ -n "$dev" ] && [ -n "$tok" ] && [ -n "$url" ] || return 0

  if [ "$verdict" = "ok" ]; then ok=true; else ok=false; fi

  payload=$(QS_DEV="$dev" QS_TOK="$tok" QS_STEP="$step" QS_OK="$ok" QS_DETAIL="$detail" \
    python3 -c '
import json, os
print(json.dumps({
    "p_device_id": os.environ["QS_DEV"],
    "p_device_token": os.environ["QS_TOK"],
    "p_step": os.environ["QS_STEP"],
    "p_ok": os.environ["QS_OK"] == "true",
    "p_detail": os.environ.get("QS_DETAIL") or None,
}))')

  code=$(curl -s -o /tmp/qconnect-step.out -w '%{http_code}' --max-time 12 \
    -X POST "$url/rest/v1/rpc/qconnect_report_step" \
    -H "apikey: $key" -H "Authorization: Bearer $key" \
    -H "Content-Type: application/json" -d "$payload")

  echo "[$(date '+%F %T')] $step $verdict ($code) ${detail}" >> "$STEP_LOG"
  # Remember locally so a box that reports late does not repeat itself forever.
  mkdir -p "$STATE/steps"
  [ "$verdict" = "ok" ] && [ "$code" = "200" ] || [ "$code" = "204" ] && touch "$STATE/steps/$step"
  tail -n 300 "$STEP_LOG" > "$STEP_LOG.tmp" 2>/dev/null && mv "$STEP_LOG.tmp" "$STEP_LOG"
}

# report_step_once <step> — skips a step already accepted on this card.
report_step_once() {
  [ -f "$STATE/steps/$1" ] && return 0
  report_step "$1" ok "${2:-}"
}

# Direct invocation.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  [ $# -ge 1 ] || { echo "usage: $0 <step> [ok|fail] [detail]" >&2; exit 2; }
  report_step "$1" "${2:-ok}" "${3:-}"
fi
