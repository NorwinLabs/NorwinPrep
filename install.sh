#!/usr/bin/env bash
# NorwinPrep installer. Run as root on Raspberry Pi OS (Bookworm or newer, Lite is fine):
#   sudo ./install.sh
# Also used inside the pi-gen image build (no running services needed).
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  nginx kiwix-tools network-manager dnsmasq-base curl ca-certificates aria2 avahi-daemon git unattended-upgrades jq util-linux

install -d /opt/norwinprep/scripts /opt/norwinprep/web
if [ -f /etc/norwinprep.conf ]; then
  # keep user settings; append any new keys introduced by this version
  while IFS= read -r line; do
    key="${line%%=*}"
    [[ "$line" =~ ^[A-Z_]+= ]] && ! grep -q "^${key}=" /etc/norwinprep.conf && echo "$line" >> /etc/norwinprep.conf
  done < "$SRC/norwinprep.conf"
else
  install -m 644 "$SRC/norwinprep.conf" /etc/norwinprep.conf
fi
# shellcheck disable=SC1091
. /etc/norwinprep.conf

install -m 755 "$SRC"/scripts/*.sh /opt/norwinprep/scripts/
cp -r "$SRC"/web/. /opt/norwinprep/web/
install -m 644 "$SRC/VERSION" /opt/norwinprep/VERSION

install -d "$CONTENT_DIR"/{zim,library,maps,apps}
id -u norwinprep >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin norwinprep
chown -R norwinprep: "$CONTENT_DIR"

# map viewer assets (needs internet; skipped quietly if offline)
[ -f /opt/norwinprep/web/maps/vendor/maplibre-gl.js ] || /opt/norwinprep/scripts/fetch-web-assets.sh || echo "WARN: map viewer assets not fetched; rerun fetch-web-assets.sh while online"

# nginx
install -m 644 "$SRC/system/nginx/norwinprep.conf" /etc/nginx/sites-available/norwinprep
ln -sf /etc/nginx/sites-available/norwinprep /etc/nginx/sites-enabled/norwinprep
rm -f /etc/nginx/sites-enabled/default

# captive-portal DNS: every name resolves to the Pi while in hotspot mode
install -d /etc/NetworkManager/dnsmasq-shared.d
echo "address=/#/10.42.0.1" > /etc/NetworkManager/dnsmasq-shared.d/norwinprep.conf

# unattended OS updates
install -m 644 "$SRC/system/apt/20auto-upgrades" /etc/apt/apt.conf.d/20auto-upgrades
install -m 644 "$SRC/system/apt/52norwinprep-unattended-upgrades" /etc/apt/apt.conf.d/52norwinprep-unattended-upgrades

# systemd units
install -m 644 "$SRC"/system/systemd/*.service "$SRC"/system/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable nginx.service norwinprep-kiwix.service norwinprep-firstboot.service avahi-daemon.service norwinprep-update.timer

# Bake survival content into the image (set by the image build; needs internet)
if [ -n "${NORWINPREP_BAKE_TIER:-}" ]; then
  /opt/norwinprep/scripts/fetch-content.sh "$NORWINPREP_BAKE_TIER"
fi

# If running on a live system (not an image build chroot), (re)start services
if [ -d /run/systemd/system ]; then
  systemctl restart nginx.service norwinprep-kiwix.service
  systemctl start norwinprep-update.timer || true
  [ -f /var/lib/norwinprep/hotspot-configured ] || /opt/norwinprep/scripts/setup-hotspot.sh || true
fi

echo
echo "NorwinPrep installed. Hotspot: SSID '$SSID'. Portal: http://10.42.0.1 (or http://${HOSTNAME_NEW}.local)"
echo "Add content: sudo /opt/norwinprep/scripts/fetch-content.sh"
