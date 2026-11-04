#!/usr/bin/env bash
# Install the pmtiles command-line tool, needed to download offline map regions. Needs internet and root.
set -euo pipefail
command -v pmtiles >/dev/null && { echo "pmtiles is already installed"; exit 0; }
case "$(uname -m)" in aarch64|arm64) arch=arm64;; x86_64) arch=x86_64;; armv7l) echo "Offline maps need a 64-bit OS: the map tool has no 32-bit Raspberry Pi build." >&2; exit 1;; *) echo "unsupported architecture $(uname -m)" >&2; exit 1;; esac
tag="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/protomaps/go-pmtiles/releases/latest | sed 's|.*/tag/||')"
ver="${tag#v}"
curl -fsSL "https://github.com/protomaps/go-pmtiles/releases/download/${tag}/go-pmtiles_${ver}_Linux_${arch}.tar.gz" | tar -xz -C /usr/local/bin pmtiles
chmod +x /usr/local/bin/pmtiles
echo "pmtiles installed"
