#!/usr/bin/env bash
# Download offline vector maps (PMTiles, OpenStreetMap data via Protomaps) into <content>/maps.
# Usage:
#   fetch-maps.sh world                         low-zoom whole world (z0-7), small; get this first
#   fetch-maps.sh usa|canada|europe|uk|australia  regional extract, full detail (z0-15)
#   fetch-maps.sh bbox NAME MINLON,MINLAT,MAXLON,MAXLAT [MAXZOOM]   any area, e.g.
#       fetch-maps.sh bbox texas -106.7,25.8,-93.5,36.6 14
# Lower MAXZOOM = much smaller files (z12 ~ streets overview, z15 = building detail).
# Tip: a world file plus one detailed regional file is the best combination.
set -euo pipefail
. /etc/norwinprep.conf
MAPS="$CONTENT_DIR/maps"; mkdir -p "$MAPS"
BIN=/usr/local/bin/pmtiles

command -v pmtiles >/dev/null || "$(dirname "$0")/install-pmtiles.sh"

build="$(curl -fsSL https://build.protomaps.com/builds.json | grep -oE '[0-9]{8}\.pmtiles' | sort | tail -1)"
[ -n "$build" ] || { echo "Could not determine latest Protomaps build"; exit 1; }
SRC="https://build.protomaps.com/$build"
echo "Using $SRC"

extract() { # name bbox maxzoom
  local args=(extract "$SRC" "$MAPS/$1.pmtiles" --maxzoom="$3")
  [ -n "$2" ] && args+=(--bbox="$2")
  pmtiles "${args[@]}"
}

case "${1:-}" in
  world)     extract world "" 7 ;;
  usa)       extract usa       -125.0,24.3,-66.9,49.5 15 ;;
  canada)    extract canada    -141.0,41.6,-52.6,70.0 14 ;;
  europe)    extract europe    -25.0,34.0,45.0,72.0   14 ;;
  uk)        extract uk        -8.7,49.8,2.0,60.9     15 ;;
  australia) extract australia 112.0,-44.0,154.0,-10.0 14 ;;
  bbox)      [ $# -ge 3 ] || { sed -n '2,12p' "$0"; exit 1; }
             extract "$2" "$3" "${4:-15}" ;;
  *)         sed -n '2,12p' "$0"; exit 1 ;;
esac
chown -R norwinprep: "$MAPS"
echo "Done. Open http://norwinprep.local/maps/"
