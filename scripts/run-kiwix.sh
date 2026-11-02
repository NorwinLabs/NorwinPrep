#!/usr/bin/env bash
# Serve every .zim file in the content dir. Restart the service after adding files.
. /etc/norwinprep.conf
shopt -s nullglob
zims=("$CONTENT_DIR"/zim/*.zim)
if [ ${#zims[@]} -eq 0 ]; then
  echo "No ZIM files in $CONTENT_DIR/zim yet; waiting." >&2
  exec sleep infinity
fi
exec /usr/bin/kiwix-serve --port 8081 --address 127.0.0.1 --urlRootLocation /wiki "${zims[@]}"
