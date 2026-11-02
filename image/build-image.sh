#!/usr/bin/env bash
# Build a flashable NorwinPrepOS .img locally (needs Docker; takes ~30-60 min).
set -euo pipefail
cd "$(dirname "$0")"
REPO_ROOT="$(cd .. && pwd)"
[ -d pi-gen ] || git clone --depth 1 --branch bookworm https://github.com/RPi-Distro/pi-gen.git
cp config pi-gen/config
rm -rf pi-gen/stage-norwin && cp -r stage-norwin pi-gen/stage-norwin
touch pi-gen/stage3/SKIP pi-gen/stage4/SKIP pi-gen/stage5/SKIP
touch pi-gen/stage4/SKIP_IMAGES pi-gen/stage5/SKIP_IMAGES
touch pi-gen/stage2/SKIP_IMAGES
rm -rf pi-gen/stage-norwin/00-install/repo
mkdir -p pi-gen/stage-norwin/00-install/repo
(cd "$REPO_ROOT" && tar --exclude=.git --exclude=image/pi-gen -cf - .) | tar -xf - -C pi-gen/stage-norwin/00-install/repo
(cd pi-gen && ./build-docker.sh)
echo "Image in image/pi-gen/deploy/"
