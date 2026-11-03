# NorwinPrep

A self-contained offline-knowledge Raspberry Pi, modelled on PrepperDisk. Once installed, it
broadcasts its own Wi-Fi hotspot (`NorwinPrep`); connect any phone/laptop, a captive portal opens,
and you can browse offline Wikipedia, medical/water/repair guides and your own PDFs, no internet needed.

## What it sets up (all start automatically on boot)
- Wi-Fi access point (NetworkManager, `10.42.0.1`) with wildcard DNS so the portal pops up
- nginx landing page at `http://10.42.0.1` / `http://norwinprep.local`
- `kiwix-serve` for every `.zim` in `/srv/norwinprep/content/zim` (served at `/wiki/`)
- `/maps/` offline OpenStreetMap viewer (PMTiles + MapLibre)
- `/apps/` Kiwix reader installers for connected devices
- `/library/` file browser for PDFs, manuals, etc. in `/srv/norwinprep/content/library`

## Install

Requires a Raspberry Pi (3, 4 or 5; 2GB+ RAM recommended) running **Raspberry Pi OS Bookworm or newer** (Lite is fine), with
internet for the install. The Wi-Fi hotspot uses `wlan0`, so install over **Ethernet** if you can.

```bash
curl -fsSL https://raw.githubusercontent.com/NorwinLabs/NorwinPrepDisk/main/get.sh | sudo bash
```

or from a clone:

```bash
git clone https://github.com/NorwinLabs/NorwinPrepDisk.git && cd NorwinPrepDisk && sudo ./install.sh
```

Options (append after `-s --` for the one-liner): `--content survival|small|medium|large|none` (default `survival`, a compact
set of a few GB), `--no-hotspot`. If the Pi is currently online through Wi-Fi, the installer skips starting the hotspot (it would
disconnect you) and tells you how to start it later with `sudo /opt/norwinprep/scripts/setup-hotspot.sh`.

Change the Wi-Fi name/password in `/etc/norwinprep.conf` (defaults: `NorwinPrep` / `prepared123`), then rerun `setup-hotspot.sh`.
Uninstall with `sudo /opt/norwinprep/scripts/uninstall.sh` (add `--purge` to delete downloaded content too).

## Updates

**On the device (when online, e.g. Ethernet plugged in):** `norwinprep-update.timer` runs 10 min after boot and daily at ~03:30.
It does nothing if there is no internet. When online it:
1. installs OS/security updates (unattended-upgrades; no automatic reboot, so kernel updates apply at your next reboot),
2. updates NorwinPrep itself from GitHub (`UPDATE_CHANNEL="stable"` = latest `vX.Y.Z` release, `"edge"` = main) with automatic rollback if nginx fails its config test,
3. refreshes the Kiwix content tier in `CONTENT_TIER` to the newest monthly editions and removes the old ones.

Run it by hand with `sudo /opt/norwinprep/scripts/update.sh`; turn parts off with `AUTO_UPDATE_*` in `/etc/norwinprep.conf`.
Your settings are preserved across updates. The hotspot works over Wi-Fi, so give the Pi internet by Ethernet (or a USB Wi-Fi dongle).
If this repo is private, set `UPDATE_TOKEN` to a read-only GitHub token.

**Releases:** CI checks the scripts on every push to `main`. Bump `VERSION` and merge to `main` to publish a `vX.Y.Z` GitHub
release; devices on the `stable` channel then update themselves.

## Content

All downloads need internet once (plug in Ethernet or a USB tether), then everything runs offline.

| Command | What it adds |
|---|---|
| `fetch-content.sh small` | Survival/medicine/water/post-disaster guides, Appropedia, WikiHow, iFixit, MDWiki, WikEM, Wikipedia top articles, DIY/outdoors/gardening/cooking/health/mechanics/electronics/survival Stack Exchange |
| `fetch-content.sh medium` | + Wikibooks, Wikivoyage, Wikiversity, Wiktionary, Project Gutenberg, PhET, LibreTexts, Wikipedia (no images) |
| `fetch-content.sh large` | + full Wikipedia with images, Wikisource, Khan Academy, Wikinews |
| `fetch-maps.sh world` | Whole-world low-zoom map (small; do this first) |
| `fetch-maps.sh usa` / `canada` / `europe` / `uk` / `australia` | Regional OpenStreetMap detail |
| `fetch-maps.sh bbox NAME minlon,minlat,maxlon,maxlat [maxzoom]` | Any area; lower maxzoom = smaller file |
| `fetch-apps.sh` | Kiwix reader for Android, Windows, macOS, Linux and kiwix-tools, hosted on the Pi at `/apps/` |

All scripts live in `/opt/norwinprep/scripts/` and run with `sudo`. Kiwix content is restarted automatically; the map viewer
picks up new `.pmtiles` files on page reload. The maps use Protomaps builds of OpenStreetMap data, rendered by the bundled
MapLibre viewer at `/maps/` (fonts, icons and JS are vendored locally by `fetch-web-assets.sh`, which `install.sh` runs for you).
Offline address search is not included; the map is browse/zoom only.

Your own PDFs, field manuals and files go in `/srv/norwinprep/content/library` (served at `/library/`). Kiwix
ZIMs from library.kiwix.org can also be dropped straight into `/srv/norwinprep/content/zim`.

For anything near 512GB, mount a USB SSD at `/srv/norwinprep/content`.

## Status
Untested on hardware: written without access to a Pi. Expect to tune filenames in `fetch-content.sh`.
