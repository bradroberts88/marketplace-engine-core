#!/usr/bin/env bash
# Builds and signs a QConnect agent bundle.
#
#   ./make-release.sh 2026.09.13-1 /path/to/qconnect-release.key
#
# Produces qconnect-agent-<version>.tar.gz plus the fingerprint and signature
# you paste into the Releases screen. The private key never leaves your machine
# (or the server secret store); only the matching public key is baked into the
# card image at /opt/qconnect/etc/qconnect-release.pub.
#
# One-time key pair:
#   openssl genpkey -algorithm ed25519 -out qconnect-release.key
#   openssl pkey -in qconnect-release.key -pubout -out qconnect-release.pub
set -euo pipefail

VERSION=${1:-}
KEY=${2:-}
[ -n "$VERSION" ] && [ -n "$KEY" ] || { echo "usage: $0 <version> <private-key.pem>" >&2; exit 2; }
[ -f "$KEY" ] || { echo "private key not found: $KEY" >&2; exit 2; }

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../device"
OUT="$HERE/dist"
mkdir -p "$OUT"
BUNDLE="$OUT/qconnect-agent-$VERSION.tar.gz"

# Only the agent files. No secrets, no state, no provision.json.
tar -czf "$BUNDLE" -C "$SRC" \
  qconnect-setup.sh qconnect-netmanager.sh qconnect-heartbeat.sh \
  qconnect-steps.sh qconnect-command-exec.sh qconnect-agent-update.sh \
  qconnect-portal.py

SHA=$(sha256sum "$BUNDLE" | awk '{print $1}')
SIG=$(openssl pkeyutl -sign -inkey "$KEY" -rawin -in "$BUNDLE" | base64 -w0)

cat <<EOF

Bundle:      $BUNDLE
Version:     $VERSION
SHA-256:     $SHA
Signature:   $SIG

Upload the bundle somewhere the boxes can reach over HTTPS, then paste the
address, the fingerprint and the signature into the Releases screen.
EOF
