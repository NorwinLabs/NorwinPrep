#!/usr/bin/env bash
# Mirror the Kiwix reader apps + kiwix-tools onto the device so anyone connected to the hotspot
# can install the reader without internet. Served at /apps/.
set -euo pipefail
. /etc/norwinprep.conf
B=https://download.kiwix.org/release
D="$CONTENT_DIR/apps"; mkdir -p "$D"
grab() { # subdir regex
  local f; f="$(curl -fsSL "$B/$1/" | grep -oE "href=\"$2\"" | sed 's/href="//;s/"$//' | sort -V | tail -1 || true)"
  if [ -z "$f" ]; then echo "skip: no match $2 in $1"; return; fi
  echo "==> $f"; curl -fL -C - "$B/$1/$f" -o "$D/$f" || echo "failed: $f"
}
grab kiwix-android 'kiwix-[0-9.]+\.apk'
grab kiwix-desktop 'kiwix-desktop_windows_x64_[0-9.]+\.zip'
grab kiwix-desktop 'kiwix-desktop_x86_64_[0-9.]+\.appimage'
grab kiwix-macos   'kiwix-macos_[0-9.]+\.dmg'
grab kiwix-tools   'kiwix-tools_linux-aarch64-[0-9.]+\.tar\.gz'
grab kiwix-tools   'kiwix-tools_linux-x86_64-[0-9.]+\.tar\.gz'
# NorwinPrep client apps (APK / Windows / Linux incl. Raspberry Pi) from the latest stable GitHub release
slug="$(printf '%s' "${UPDATE_REPO:-https://github.com/NorwinLabs/NorwinPrepDisk.git}" | sed -E 's|.*github.com[/:]||; s|\.git$||')"
echo "==> NorwinPrep client apps from $slug"
curl -fsSL "https://api.github.com/repos/$slug/releases/latest" \
  | jq -r '.assets[]? | select(.name | test("\\.(apk|exe|AppImage|deb)$")) | "\(.name) \(.browser_download_url)"' \
  | while read -r name url; do
      echo "    $name"; curl -fL -C - "$url" -o "$D/$name" || echo "failed: $name"
    done || echo "skip: no stable release with apps found yet"
chown -R norwinprep: "$D"
echo "Done. Apps at http://norwinprep.local/apps/"
