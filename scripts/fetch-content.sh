#!/usr/bin/env bash
# Download offline content into the content dir. Needs internet (e.g. plug in ethernet).
# Usage: fetch-content.sh [small|medium|large]   (default: small, ~few GB)
set -euo pipefail
. /etc/norwinprep.conf
tier="${1:-small}"
B="https://download.kiwix.org/zim"
# Filenames change monthly; we resolve the newest match from the directory index.
latest() { # $1=subdir $2=prefix
  curl -fsSL "$B/$1/" | grep -oE "${2}_[0-9]{4}-[0-9]{2}\.zim\"" | tr -d '"' | sort | tail -1
}
items=(
  "wikipedia wikipedia_en_top_maxi"
  "other zimgit-medicine_en"
  "other zimgit-water_en"
  "other zimgit-post-disaster_en"
  "wikibooks wikibooks_en_all_maxi"
  "wikihow wikihow_en_maxi"
  "other ready.gov_en"
)
if [ "$tier" = medium ] || [ "$tier" = large ]; then
  items+=("wikipedia wikipedia_en_all_nopic" "gutenberg gutenberg_en_all" "stack_exchange survival.stackexchange.com_en_all")
fi
if [ "$tier" = large ]; then
  items+=("wikipedia wikipedia_en_all_maxi" "wiktionary wiktionary_en_all_maxi")
fi
mkdir -p "$CONTENT_DIR/zim"
for it in "${items[@]}"; do
  set -- $it
  f="$(latest "$1" "$2" || true)"
  if [ -z "$f" ]; then echo "skip: no match for $2 in $1"; continue; fi
  echo "==> $f"
  aria2c -c -x4 -d "$CONTENT_DIR/zim" "$B/$1/$f" || echo "failed: $f"
done
chown -R norwinprep: "$CONTENT_DIR"
systemctl restart norwinprep-kiwix.service
echo "Done."
