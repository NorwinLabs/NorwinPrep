#!/usr/bin/env bash
# Download offline Kiwix content. Needs internet (e.g. plug in ethernet).
# Usage: fetch-content.sh [survival|small|medium|large]   (default: small)
#   survival  compact core (medicine, water, post-disaster, food, survival Q&A); this is what ships in the image
#   small     survival + wider how-to/repair/Wikipedia-top set (a few GB)
#   medium    + books, education, travel (100GB+)
#   large     + full Wikipedia with images etc. (300GB+)
# Re-running fetches newer monthly editions and removes the superseded files.
set -euo pipefail
. /etc/norwinprep.conf
tier="${1:-small}"
B="https://download.kiwix.org/zim"
# survival tier skips any single file bigger than this (MB) so the image stays small
SURVIVAL_MAX_MB="${SURVIVAL_MAX_MB:-600}"

latest() { # $1=subdir $2=prefix -> newest matching filename
  curl -fsSL "$B/$1/" | grep -oE "${2}_[0-9]{4}-[0-9]{2}\.zim\"" | tr -d '"' | sort | tail -1
}

# "subdir prefix". Missing entries are skipped, so a Kiwix rename never breaks the run.
survival=(
  "other zimgit-medicine_en"
  "other zimgit-water_en"
  "other zimgit-post-disaster_en"
  "other zimgit-food-preparation_en"
  "stack_exchange outdoors.stackexchange.com_en_all"
  "other appropedia_en_all_maxi"
  "wikipedia wikipedia_en_top_nopic"
)
small=(
  "wikipedia wikipedia_en_top_maxi"
  "ifixit ifixit_en_all"
  "other mdwiki_en_all_maxi"
  "stack_exchange diy.stackexchange.com_en_all"
  "stack_exchange gardening.stackexchange.com_en_all"
  "stack_exchange cooking.stackexchange.com_en_all"
  "stack_exchange mechanics.stackexchange.com_en_all"
  "stack_exchange electronics.stackexchange.com_en_all"
  "stack_exchange sustainability.stackexchange.com_en_all"
)
medium=(
  "wikibooks wikibooks_en_all_maxi"
  "wikivoyage wikivoyage_en_all_maxi"
  "wikiversity wikiversity_en_all_maxi"
  "wiktionary wiktionary_en_all_nopic"
  "gutenberg gutenberg_en_all"
  "phet phet_en_all"
  "libretexts libretexts.org_en_med"
  "libretexts libretexts.org_en_chem"
  "libretexts libretexts.org_en_eng"
  "wikipedia wikipedia_en_all_nopic"
)
large=(
  "wikipedia wikipedia_en_all_maxi"
  "wikisource wikisource_en_all_maxi"
  "other khanacademy_en_all"
)
case "$tier" in
  survival) items=("${survival[@]}") ;;
  small)    items=("${survival[@]}" "${small[@]}") ;;
  medium)   items=("${survival[@]}" "${small[@]}" "${medium[@]}") ;;
  large)    items=("${survival[@]}" "${small[@]}" "${medium[@]/wikipedia wikipedia_en_all_nopic/}" "${large[@]}") ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac

Z="$CONTENT_DIR/zim"; mkdir -p "$Z"
for it in "${items[@]}"; do
  [ -n "$it" ] || continue
  set -- $it
  f="$(latest "$1" "$2" || true)"
  if [ -z "$f" ]; then echo "skip: no match for $2 in $1"; continue; fi
  if [ -f "$Z/$f" ] && [ ! -f "$Z/$f.aria2" ]; then echo "have: $f"; continue; fi
  if [ "$tier" = survival ]; then
    bytes="$(curl -fsSIL "$B/$1/$f" | tr -d '\r' | awk 'tolower($1)=="content-length:"{s=$2} END{print s+0}')"
    if [ "$bytes" -gt $((SURVIVAL_MAX_MB * 1024 * 1024)) ]; then
      echo "skip (>${SURVIVAL_MAX_MB}MB for survival tier): $f"; continue
    fi
  fi
  echo "==> $f"
  if aria2c -c -x4 --allow-overwrite=true -d "$Z" "$B/$1/$f"; then
    # remove older editions of the same title
    for old in "$Z/$2"_[0-9][0-9][0-9][0-9]-[0-9][0-9].zim; do
      [ -e "$old" ] && [ "$(basename "$old")" != "$f" ] && rm -f "$old"
    done
  else
    echo "failed: $f"
  fi
done
chown -R norwinprep: "$CONTENT_DIR" 2>/dev/null || true
if [ -d /run/systemd/system ]; then systemctl restart norwinprep-kiwix.service; fi
ls "$Z"/*.zim >/dev/null 2>&1 || { echo "ERROR: no ZIM files present" >&2; exit 1; }
echo "Done."
