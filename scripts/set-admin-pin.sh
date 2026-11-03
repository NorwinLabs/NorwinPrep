#!/usr/bin/env bash
# Set or reset the admin PIN that the Module Store asks for before installing or removing anything.
#   sudo /opt/norwinprep/scripts/set-admin-pin.sh [PIN]     (4-12 digits; a random 6-digit PIN if omitted)
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
FILE="${NORWINPREP_ADMIN_FILE:-/etc/norwinprep-admin}"
pin="${1:-$(shuf -i 100000-999999 -n1)}"
[[ "$pin" =~ ^[0-9]{4,12}$ ]] || { echo "PIN must be 4 to 12 digits." >&2; exit 1; }
salt="$(head -c8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
hash="$(printf '%s%s' "$salt" "$pin" | sha256sum | cut -d' ' -f1)"
umask 077
printf '%s:%s\n' "$salt" "$hash" > "$FILE"
chgrp norwinprep "$FILE" 2>/dev/null || true     # the module service (user norwinprep) must be able to read it
chmod 640 "$FILE"
echo "Admin PIN: $pin"
