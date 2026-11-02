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
  nginx kiwix-tools network-manager dnsmasq-base curl ca-certificates aria2 avahi-daemon

install -d /opt/norwinprep/scripts /opt/norwinprep/web
[ -f /etc/norwinprep.conf ] || install -m 644 "$SRC/norwinprep.conf" /etc/norwinprep.conf
# shellcheck disable=SC1091
. /etc/norwinprep.conf

install -m 755 "$SRC"/scripts/*.sh /opt/norwinprep/scripts/
cp -r "$SRC"/web/. /opt/norwinprep/web/

install -d "$CONTENT_DIR"/{zim,library}
id -u norwinprep >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin norwinprep
chown -R norwinprep: "$CONTENT_DIR"

# nginx
install -m 644 "$SRC/system/nginx/norwinprep.conf" /etc/nginx/sites-available/norwinprep
ln -sf /etc/nginx/sites-available/norwinprep /etc/nginx/sites-enabled/norwinprep
rm -f /etc/nginx/sites-enabled/default

# captive-portal DNS: every name resolves to the Pi while in hotspot mode
install -d /etc/NetworkManager/dnsmasq-shared.d
echo "address=/#/10.42.0.1" > /etc/NetworkManager/dnsmasq-shared.d/norwinprep.conf

# systemd units
install -m 644 "$SRC"/system/systemd/*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable nginx.service norwinprep-kiwix.service norwinprep-firstboot.service avahi-daemon.service

# If running on a live system (not an image build chroot), start now
if [ -d /run/systemd/system ]; then
  systemctl restart nginx.service norwinprep-kiwix.service
  /opt/norwinprep/scripts/setup-hotspot.sh || true
fi

echo
echo "NorwinPrep installed. Hotspot: SSID '$SSID'. Portal: http://10.42.0.1 (or http://${HOSTNAME_NEW}.local)"
echo "Add content: sudo /opt/norwinprep/scripts/fetch-content.sh"
