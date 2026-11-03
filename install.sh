#!/usr/bin/env bash
# NorwinPrep installer for Raspberry Pi OS (Bookworm or newer) / Debian with NetworkManager.
#   sudo ./install.sh [--content survival|small|medium|large|none] [--no-hotspot]
# Default: installs everything and downloads the compact "survival" Kiwix set.
# Safe to re-run (it keeps your /etc/norwinprep.conf and downloaded content).
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
die() { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "Run as root (sudo)."

CONTENT_INSTALL="${NORWINPREP_CONTENT:-survival}"
DO_HOTSPOT=1
UPDATING="${NORWINPREP_UPDATE:-0}"      # set by update.sh
while [ $# -gt 0 ]; do
  case "$1" in
    --content)    CONTENT_INSTALL="${2:?tier required}"; shift ;;
    --no-content) CONTENT_INSTALL=none ;;
    --no-hotspot) DO_HOTSPOT=0 ;;
    -h|--help)    sed -n 2,6p "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done
[ "$UPDATING" = 1 ] && { CONTENT_INSTALL=none; DO_HOTSPOT=0; }

command -v nmcli >/dev/null && systemctl is-active --quiet NetworkManager \
  || die "NetworkManager is required (default on Raspberry Pi OS Bookworm or newer)."

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  nginx kiwix-tools dnsmasq-base curl ca-certificates aria2 avahi-daemon git \
  unattended-upgrades jq util-linux python3

install -d /opt/norwinprep/scripts /opt/norwinprep/web
if [ -f /etc/norwinprep.conf ]; then
  # keep user settings; append any new keys introduced by this version
  while IFS= read -r line; do
    key="${line%%=*}"
    if [[ "$line" =~ ^[A-Z_]+= ]] && ! grep -q "^${key}=" /etc/norwinprep.conf; then echo "$line" >> /etc/norwinprep.conf; fi
  done < "$SRC/norwinprep.conf"
else
  install -m 644 "$SRC/norwinprep.conf" /etc/norwinprep.conf
fi
# shellcheck disable=SC1091
. /etc/norwinprep.conf

install -m 755 "$SRC"/scripts/*.sh "$SRC/scripts/modules-api.py" /opt/norwinprep/scripts/
install -d /opt/norwinprep/modules
install -m 644 "$SRC/app/shared/site/catalog.json" /opt/norwinprep/modules/catalog.json
# the Module Store page is the same file the apps ship as their home screen
install -d /opt/norwinprep/web/modules
install -m 644 "$SRC/app/shared/site/index.html" /opt/norwinprep/web/modules/index.html
install -m 755 "$SRC/uninstall.sh" /opt/norwinprep/scripts/uninstall.sh
cp -r "$SRC"/web/. /opt/norwinprep/web/
# Version = the release tag this checkout is (get.sh / update.sh check out tags); otherwise "<MAJOR.MINOR>-dev"
APP_VERSION="$(git -C "$SRC" describe --tags --exact-match 2>/dev/null | sed 's/^v//' || true)"
[ -n "$APP_VERSION" ] || APP_VERSION="$(cat "$SRC/VERSION")-dev"
echo "$APP_VERSION" > /opt/norwinprep/VERSION

# Device info served at /api/device (read by the NorwinPrep apps)
if ! [[ "${DEVICE_NAME:-NorwinPrep}" =~ ^[A-Za-z0-9\ ._()-]{1,40}$ ]]; then
  echo "WARN: DEVICE_NAME in /etc/norwinprep.conf has unsupported characters; using 'NorwinPrep'"; DEVICE_NAME="NorwinPrep"
fi
install -d /opt/norwinprep/web/api
jq -n --arg name "${DEVICE_NAME:-NorwinPrep}" --arg ver "$APP_VERSION" --arg host "${HOSTNAME_NEW:-norwinprep}" --arg ssid "${SSID:-NorwinPrep}" \
  '{name:$name, mode:"pi", version:$ver, hostname:$host, ssid:$ssid, address:"http://10.42.0.1", modules:true}' > /opt/norwinprep/web/api/device.json

install -d "$CONTENT_DIR"/{zim,library,maps,apps}
id -u norwinprep >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin norwinprep
chown -R norwinprep: "$CONTENT_DIR"

# Admin PIN for the Module Store (created once; shown at the end of the install)
NEW_PIN=""
if [ ! -f /etc/norwinprep-admin ]; then
  NEW_PIN="$(/opt/norwinprep/scripts/set-admin-pin.sh | sed -n 's/^Admin PIN: //p')"
fi

# The module manager may restart the library service after installs (and nothing else)
if command -v visudo >/dev/null; then
  tmp_sudoers="$(mktemp)"
  cp "$SRC/system/sudoers-norwinprep" "$tmp_sudoers"
  if visudo -cf "$tmp_sudoers" >/dev/null; then install -m 440 "$tmp_sudoers" /etc/sudoers.d/norwinprep; else echo "WARN: sudoers rule invalid; module installs will not restart the library"; fi
  rm -f "$tmp_sudoers"
fi

# Tool for downloading map regions (best effort; the Module Store tells you if it is missing)
command -v pmtiles >/dev/null || /opt/norwinprep/scripts/install-pmtiles.sh || echo "WARN: pmtiles not installed; run /opt/norwinprep/scripts/install-pmtiles.sh later"

# map viewer assets (JS, fonts, sprites) so maps work with zero internet later
[ -f /opt/norwinprep/web/maps/vendor/maplibre-gl.js ] || /opt/norwinprep/scripts/fetch-web-assets.sh \
  || echo "WARN: map viewer assets not fetched; rerun /opt/norwinprep/scripts/fetch-web-assets.sh"

# nginx
install -m 644 "$SRC/system/nginx/norwinprep.conf" /etc/nginx/sites-available/norwinprep
ln -sf /etc/nginx/sites-available/norwinprep /etc/nginx/sites-enabled/norwinprep
rm -f /etc/nginx/sites-enabled/default
nginx -t

# captive-portal DNS: every name resolves to the Pi while the hotspot is up
install -d /etc/NetworkManager/dnsmasq-shared.d
echo "address=/#/10.42.0.1" > /etc/NetworkManager/dnsmasq-shared.d/norwinprep.conf

# unattended OS updates
install -m 644 "$SRC/system/apt/20auto-upgrades" /etc/apt/apt.conf.d/20auto-upgrades
install -m 644 "$SRC/system/apt/52norwinprep-unattended-upgrades" /etc/apt/apt.conf.d/52norwinprep-unattended-upgrades

# systemd units
rm -f /etc/systemd/system/norwinprep-firstboot.service
install -m 644 "$SRC"/system/systemd/*.service "$SRC"/system/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now nginx.service norwinprep-kiwix.service norwinprep-modules.service avahi-daemon.service norwinprep-update.timer
systemctl restart norwinprep-modules.service    # pick up new code/catalog on updates
systemctl reload nginx.service || true

# Content (needs internet; skipped with --content none)
if [ "$CONTENT_INSTALL" != none ]; then
  /opt/norwinprep/scripts/fetch-content.sh "$CONTENT_INSTALL" \
    || echo "WARN: content download incomplete; rerun: sudo /opt/norwinprep/scripts/fetch-content.sh $CONTENT_INSTALL"
fi
systemctl restart norwinprep-kiwix.service

# Hotspot. Turning wlan0 into an access point drops it as a Wi-Fi client, so don't
# do that if you're connected (e.g. over SSH) through Wi-Fi.
if [ "$DO_HOTSPOT" = 1 ] && [ ! -f /var/lib/norwinprep/hotspot-configured ]; then
  uplink="$(ip -4 route show default 2>/dev/null | awk '{print $5; exit}')"
  if [ "$uplink" = "$WIFI_IFACE" ]; then
    HOTSPOT_SKIPPED=1
    echo
    echo "NOTE: this Pi is online through $WIFI_IFACE, which the hotspot needs. Hotspot NOT started."
    echo "      Connect Ethernet (or run locally), then: sudo /opt/norwinprep/scripts/setup-hotspot.sh"
  else
    /opt/norwinprep/scripts/setup-hotspot.sh || echo "WARN: hotspot setup failed; rerun setup-hotspot.sh"
  fi
fi

echo
echo "NorwinPrep $(cat /opt/norwinprep/VERSION) installed."
if [ -f /var/lib/norwinprep/hotspot-configured ]; then
  echo "Join Wi-Fi '$SSID' (password in /etc/norwinprep.conf), then open http://10.42.0.1 or http://${HOSTNAME_NEW}.local"
elif [ -z "${HOTSPOT_SKIPPED:-}" ]; then
  echo "Hotspot not configured; run: sudo /opt/norwinprep/scripts/setup-hotspot.sh"
fi
[ -z "$NEW_PIN" ] || { echo; echo "Module Store admin PIN: $NEW_PIN   (write it down; reset with: sudo /opt/norwinprep/scripts/set-admin-pin.sh)"; }
echo "Module Store: http://10.42.0.1/modules/"
echo "More content: sudo /opt/norwinprep/scripts/fetch-content.sh [small|medium|large]; maps: fetch-maps.sh world"
