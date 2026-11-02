#!/usr/bin/env bash
# Download offline content into the content dir. Needs internet (e.g. plug in ethernet).
# Usage: fetch-content.sh [small|medium|large]   (default: small; medium ~100GB+; large ~300GB+ with maps)
set -euo pipefail
. /etc/norwinprep.conf
tier="${1:-small}"
B="https://download.kiwix.org/zim"
# Filenames change monthly; we resolve the newest match from the directory index.
latest() { # $1=subdir $2=prefix
  curl -fsSL "$B/$1/" | grep -oE "${2}_[0-9]{4}-[0-9]{2}\.zim\"" | tr -d '"' | sort | tail -1
}
# "subdir prefix". Missing entries are skipped, so it is safe if Kiwix renames something.
items=(   # small: survival, medicine, repair, how-to (a few GB)
  "wikipedia wikipedia_en_top_maxi"
  "other zimgit-medicine_en"
  "other zimgit-water_en"
  "other zimgit-post-disaster_en"
  "other zimgit-food-preparation_en"
  "other appropedia_en_all_maxi"
  "wikihow wikihow_en_maxi"
  "ifixit ifixit_en_all"
  "mdwiki mdwiki_en_all_maxi"
  "wikem wikem_en_all_maxi"
  "stack_exchange diy.stackexchange.com_en_all"
  "stack_exchange outdoors.stackexchange.com_en_all"
  "stack_exchange gardening.stackexchange.com_en_all"
  "stack_exchange cooking.stackexchange.com_en_all"
  "stack_exchange health.stackexchange.com_en_all"
  "stack_exchange mechanics.stackexchange.com_en_all"
  "stack_exchange electronics.stackexchange.com_en_all"
  "stack_exchange sustainability.stackexchange.com_en_all"
  "stack_exchange survival.stackexchange.com_en_all"
)
if [ "$tier" = medium ] || [ "$tier" = large ]; then   # + travel, books, education (tens of GB)
  items+=(
    "wikibooks wikibooks_en_all_maxi"
    "wikivoyage wikivoyage_en_all_maxi"
    "wikiversity wikiversity_en_all_maxi"
    "wiktionary wiktionary_en_all_maxi"
    "gutenberg gutenberg_en_all"
    "phet phet_en_all"
    "libretexts libretexts.org_en_med"
    "libretexts libretexts.org_en_chem"
    "libretexts libretexts.org_en_eng"
    "wikipedia wikipedia_en_all_nopic"
  )
fi
if [ "$tier" = large ]; then   # + full Wikipedia with images, Wikisource, Khan Academy (100s of GB)
  items=("${items[@]/wikipedia wikipedia_en_all_nopic/}")
  items+=(
    "wikipedia wikipedia_en_all_maxi"
    "wikisource wikisource_en_all_maxi"
    "khan_academy khan_academy_en_all"
    "wikinews wikinews_en_all_maxi"
  )
fi
mkdir -p "$CONTENT_DIR/zim"
for it in "${items[@]}"; do
  [ -n "$it" ] || continue
  set -- $it
  f="$(latest "$1" "$2" || true)"
  if [ -z "$f" ]; then echo "skip: no match for $2 in $1"; continue; fi
  echo "==> $f"
  aria2c -c -x4 -d "$CONTENT_DIR/zim" "$B/$1/$f" || echo "failed: $f"
done
chown -R norwinprep: "$CONTENT_DIR"
systemctl restart norwinprep-kiwix.service
echo "Done."
