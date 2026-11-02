#!/usr/bin/env bash
# Vendor the map viewer's JS, fonts and sprites so the viewer works with zero internet.
# Run once while online (install.sh does this automatically; failure is non-fatal).
set -euo pipefail
V=/opt/norwinprep/web/maps/vendor
mkdir -p "$V"
CDN=https://cdn.jsdelivr.net/npm
get() { curl -fsSL "$1" -o "$2" && echo "ok  $2" || echo "FAIL $1"; }
get "$CDN/maplibre-gl@4.7.1/dist/maplibre-gl.js"  "$V/maplibre-gl.js"
get "$CDN/maplibre-gl@4.7.1/dist/maplibre-gl.css" "$V/maplibre-gl.css"
get "$CDN/pmtiles@3.2.1/dist/pmtiles.js"          "$V/pmtiles.js"
get "$CDN/@protomaps/basemaps@5.0.0/dist/basemaps.js" "$V/basemaps.js" \
  || get "$CDN/@protomaps/basemaps/dist/basemaps.js" "$V/basemaps.js"

# Glyphs (fonts) and sprites for labels/icons
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
git clone --depth 1 https://github.com/protomaps/basemaps-assets.git "$tmp/a"
rm -rf /opt/norwinprep/web/maps/fonts /opt/norwinprep/web/maps/sprites
cp -r "$tmp/a/fonts" /opt/norwinprep/web/maps/fonts
cp -r "$tmp/a/sprites" /opt/norwinprep/web/maps/sprites
echo "Map viewer assets installed."
