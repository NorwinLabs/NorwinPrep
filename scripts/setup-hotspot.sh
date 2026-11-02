#!/usr/bin/env bash
# Create (or recreate) the auto-starting Wi-Fi access point via NetworkManager.
set -euo pipefail
. /etc/norwinprep.conf

command -v rfkill >/dev/null && rfkill unblock wifi || true
iw reg set US 2>/dev/null || true

hostnamectl set-hostname "$HOSTNAME_NEW" 2>/dev/null || true

nmcli connection delete NorwinPrepAP 2>/dev/null || true
args=(connection add type wifi ifname "$WIFI_IFACE" con-name NorwinPrepAP autoconnect yes
  ssid "$SSID" 802-11-wireless.mode ap 802-11-wireless.band bg
  ipv4.method shared ipv4.addresses 10.42.0.1/24 ipv6.method disabled
  connection.autoconnect-priority 100)
if [ -n "${PASSWORD:-}" ]; then
  args+=(wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$PASSWORD")
fi
nmcli "${args[@]}"
nmcli connection up NorwinPrepAP || true
