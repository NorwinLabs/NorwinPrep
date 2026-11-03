#!/usr/bin/env bash
# NorwinPrep updater. Runs from a systemd timer; does nothing when offline.
#  - OS packages: handled by unattended-upgrades (also triggered here)
#  - NorwinPrep software: follows GitHub releases (stable) or main (edge)
#  - Survival content: refreshed to the newest Kiwix editions
# Manual run: sudo /opt/norwinprep/scripts/update.sh
set -euo pipefail
. /etc/norwinprep.conf
REPO="${UPDATE_REPO:-https://github.com/NorwinLabs/NorwinPrepDisk.git}"
CHANNEL="${UPDATE_CHANNEL:-stable}"
STATE=/var/lib/norwinprep; SRC="$STATE/src"
mkdir -p "$STATE"
exec 9>/run/norwinprep-update.lock
flock -n 9 || { echo "update already running"; exit 0; }

curl -fsS --max-time 8 -o /dev/null https://github.com || { echo "offline; skipping update"; exit 0; }

git_() { # authenticated git for private repos
  if [ -n "${UPDATE_TOKEN:-}" ]; then
    git -c http.extraHeader="Authorization: Basic $(printf 'x-access-token:%s' "$UPDATE_TOKEN" | base64 -w0)" "$@"
  else git "$@"; fi
}

# 1) OS packages
if [ "${AUTO_UPDATE_OS:-1}" = 1 ]; then
  apt-get update -qq || true
  unattended-upgrade || true
fi

# 2) NorwinPrep software
if [ "${AUTO_UPDATE_SOFTWARE:-1}" = 1 ]; then
  if [ -d "$SRC/.git" ]; then git_ -C "$SRC" fetch -q --tags --force origin
  else git_ clone -q "$REPO" "$SRC"; fi
  if [ "$CHANNEL" = edge ]; then target="origin/HEAD"
  else target="$(git -C "$SRC" tag -l 'v[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)"; fi
  if [ -n "$target" ]; then
    rev="$(git -C "$SRC" rev-parse "$target^{commit}")"
    if [ "$rev" != "$(cat "$STATE/installed-rev" 2>/dev/null || true)" ]; then
      echo "Updating NorwinPrep to ${target} ($rev)"
      git -C "$SRC" checkout -q --force --detach "$target"
      rm -rf /opt/norwinprep.prev && cp -a /opt/norwinprep /opt/norwinprep.prev
      cp -a /etc/nginx/sites-available/norwinprep /opt/norwinprep.prev/nginx.conf.bak 2>/dev/null || true
      if NORWINPREP_UPDATE=1 "$SRC/install.sh" && nginx -t; then
        echo "$rev" > "$STATE/installed-rev"
        systemctl reload nginx || true
      else
        echo "Update failed; rolling back" >&2
        rm -rf /opt/norwinprep && mv /opt/norwinprep.prev /opt/norwinprep
        [ -f /opt/norwinprep/nginx.conf.bak ] && cp /opt/norwinprep/nginx.conf.bak /etc/nginx/sites-available/norwinprep
        systemctl reload nginx || true
        exit 1
      fi
    else echo "NorwinPrep is up to date ($(cat /opt/norwinprep/VERSION))"; fi
  fi
fi

# 3) Content refresh (new monthly Kiwix editions of whatever tier you chose)
if [ "${AUTO_UPDATE_CONTENT:-1}" = 1 ]; then
  /opt/norwinprep/scripts/fetch-content.sh "${CONTENT_TIER:-survival}" || true
fi
echo "Update check complete."
