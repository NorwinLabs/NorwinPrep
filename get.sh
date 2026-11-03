#!/usr/bin/env bash
# One-line installer:
#   curl -fsSL https://raw.githubusercontent.com/NorwinLabs/NorwinPrepDisk/main/get.sh | sudo bash
# Pass installer options after "-s --":  ... | sudo bash -s -- --content small --no-hotspot
# Env: NORWINPREP_REPO (git URL), NORWINPREP_REF (tag/branch; default latest release, else main)
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root: curl ... | sudo bash" >&2; exit 1; }
REPO="${NORWINPREP_REPO:-https://github.com/NorwinLabs/NorwinPrepDisk.git}"
DEST=/var/lib/norwinprep/src
command -v git >/dev/null || { apt-get update && apt-get install -y git; }
mkdir -p /var/lib/norwinprep
if [ -d "$DEST/.git" ]; then git -C "$DEST" fetch -q --tags --force origin
else git clone -q "$REPO" "$DEST"; fi
REF="${NORWINPREP_REF:-$(git -C "$DEST" tag -l 'v[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)}"
[ -n "$REF" ] || REF=origin/HEAD
git -C "$DEST" checkout -q --force --detach "$REF"
git -C "$DEST" rev-parse "$REF^{commit}" > /var/lib/norwinprep/installed-rev
exec "$DEST/install.sh" "$@"
