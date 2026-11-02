#!/bin/bash -e
# pi-gen stage: copy this repo into the image rootfs, then install in chroot.
# build-image.sh copies the repo into ./repo next to this script.
REPO_ROOT="$(cd "$(dirname "$0")/repo" && pwd)"
install -d "${ROOTFS_DIR}/opt/norwinprep-src"
cp -r "${REPO_ROOT}/." "${ROOTFS_DIR}/opt/norwinprep-src/"
rm -rf "${ROOTFS_DIR}/opt/norwinprep-src/.git"

on_chroot << EOF
cd /opt/norwinprep-src && ./install.sh
rm -rf /opt/norwinprep-src
EOF
