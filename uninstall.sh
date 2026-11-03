#!/usr/bin/env bash
# Remove NorwinPrep. Keeps downloaded content unless --purge is given.
#   sudo /opt/norwinprep/scripts/uninstall.sh [--purge]
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }
. /etc/norwinprep.conf 2>/dev/null || CONTENT_DIR=/srv/norwinprep/content
systemctl disable --now norwinprep-update.timer norwinprep-modules.service norwinprep-kiwix.service 2>/dev/null || true
rm -f /etc/systemd/system/norwinprep-*.service /etc/systemd/system/norwinprep-*.timer
systemctl daemon-reload
nmcli connection delete NorwinPrepAP 2>/dev/null || true
rm -f /etc/NetworkManager/dnsmasq-shared.d/norwinprep.conf /etc/nginx/sites-enabled/norwinprep /etc/nginx/sites-available/norwinprep
systemctl reload nginx 2>/dev/null || true
rm -f /etc/sudoers.d/norwinprep /etc/norwinprep-admin
rm -rf /opt/norwinprep /opt/norwinprep.prev /var/lib/norwinprep
[ "${1:-}" = "--purge" ] && rm -rf "$(dirname "$CONTENT_DIR")" && rm -f /etc/norwinprep.conf
echo "NorwinPrep removed. Config kept at /etc/norwinprep.conf and content at ${CONTENT_DIR} unless --purge."
