# NorwinPrep

A self-contained offline-knowledge Raspberry Pi, modelled on PrepperDisk. Power it on and it
broadcasts its own Wi-Fi hotspot (`NorwinPrep`); connect any phone/laptop, a captive portal opens,
and you can browse offline Wikipedia, medical/water/repair guides and your own PDFs, no internet needed.

## What boots automatically
- Wi-Fi access point (NetworkManager, `10.42.0.1`) with wildcard DNS so the portal pops up
- nginx landing page at `http://10.42.0.1` / `http://norwinprep.local`
- `kiwix-serve` for every `.zim` in `/srv/norwinprep/content/zim` (served at `/wiki/`)
- `/maps/` offline OpenStreetMap viewer (PMTiles + MapLibre)
- `/apps/` Kiwix reader installers for connected devices
- `/library/` file browser for PDFs, manuals, etc. in `/srv/norwinprep/content/library`

## Option A: install on Raspberry Pi OS Lite (Bookworm)
```bash
git clone <this repo> && cd NorwinPrepDisk
sudo ./install.sh
sudo /opt/norwinprep/scripts/fetch-content.sh small   # or medium / large (needs internet)
```
Edit `/etc/norwinprep.conf` (SSID, password), then `sudo /opt/norwinprep/scripts/setup-hotspot.sh`.

## Option B: build a flashable image
`image/build-image.sh` (needs Docker) or run the "Build NorwinPrepOS image" GitHub workflow.
Flash the resulting image with Raspberry Pi Imager; it auto-launches everything on first boot.
Change the default login (`norwin` / `changeme-now`) and Wi-Fi password in `image/config` and `norwinprep.conf` first.

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
