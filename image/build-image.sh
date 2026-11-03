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
# pi-gen's docker build gets no working DNS in BuildKit on GitHub runners; build on the host network
sed -i 's|${DOCKER} build --build-arg|${DOCKER} build --network=host --build-arg|' pi-gen/build-docker.sh
grep -q -- '--network=host' pi-gen/build-docker.sh || { echo "failed to patch build-docker.sh" >&2; exit 1; }
# The 32-bit i386 host image pi-gen picks on x86_64 can fail DNS on some runners (the 64-bit image is fine).
# The target image is still armhf; this only changes the build container.
echo "--- DNS check for pi-gen host image ---"
docker run --rm --network=host i386/debian:bookworm cat /etc/resolv.conf || true
if ! docker run --rm --network=host i386/debian:bookworm getent hosts deb.debian.org; then
  echo "i386 base image cannot resolve DNS here; using debian:bookworm as the pi-gen host image"
  sed -i 's|BASE_IMAGE=i386/debian:bookworm|BASE_IMAGE=debian:bookworm|' pi-gen/build-docker.sh
fi
# pi-gen's host-side check wants a host qemu-user-static package; newer runners don't ship one.
# The workflow registers ARM binfmt with docker/setup-qemu-action instead, so skip that check.
# (Locally, install qemu-user-static as pi-gen's README says and remove this line if you prefer.)
if [ -n "${CI:-}" ]; then
  sed -i 's|^if \[\[ "${binfmt_misc_required}" == "1" \]\]; then|if false; then # patched: qemu registered by CI|' pi-gen/build-docker.sh
  grep -q 'patched: qemu registered by CI' pi-gen/build-docker.sh || { echo "failed to patch qemu check" >&2; exit 1; }
fi
(cd pi-gen && ./build-docker.sh)
echo "Image in image/pi-gen/deploy/"
