# NorwinPrep

A self-contained offline-knowledge Raspberry Pi, modelled on PrepperDisk. Power it on and it
broadcasts its own Wi-Fi hotspot (`NorwinPrep`); connect any phone/laptop, a captive portal opens,
and you can browse offline Wikipedia, medical/water/repair guides and your own PDFs, no internet needed.

## What boots automatically
- Wi-Fi access point (NetworkManager, `10.42.0.1`) with wildcard DNS so the portal pops up
- nginx landing page at `http://10.42.0.1` / `http://norwinprep.local`
- `kiwix-serve` for every `.zim` in `/srv/norwinprep/content/zim` (served at `/wiki/`)
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
`fetch-content.sh` pulls ZIMs from download.kiwix.org: tiers `small`, `medium`, `large`. For 512GB+
use a USB SSD mounted at `/srv/norwinprep/content`. Restart with `sudo systemctl restart norwinprep-kiwix`.
Offline maps, medical references and more are good next steps.

## Status
Untested on hardware: written without access to a Pi. Expect to tune filenames in `fetch-content.sh`.
