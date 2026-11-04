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

Change the Wi-Fi name/password in `/etc/norwinprep.conf` (defaults: `NorwinPrep` / `NORWINNOMAD`; existing installs keep the password already in their file), then rerun `setup-hotspot.sh`.
Uninstall with `sudo /opt/norwinprep/scripts/uninstall.sh` (add `--purge` to delete downloaded content too).

## Choosing what to install

The store is grouped like Project NOMAD: **Library**, **Education**, **Maps**, **Tools** and **Apps**, with a **Quick setup** row at the top.
Quick setup installs a whole set in one tap: **Essential** (medicine, water, food, first aid, a Wikipedia starter, a world map), **Standard**
(adds repair, DIY, gardening, cooking, electronics, textbooks, travel guides and the tools) and **Comprehensive** (adds a large encyclopedia, books,
Khan Academy, more textbooks and detailed maps). The dialog shows the modules, the download size and your free space first.

Tools on desktop and Pi: **CyberChef** (GCHQ's data toolkit, downloaded from its GitHub release and run offline) and **Notes** (built in, stays on the device).
Both open inside the app and are offered to devices that join your Wi-Fi share. **Kolibri** (Learning Equality's offline school platform: courses, quizzes, learner accounts and progress) is under Education on desktop and Pi.
It is a Python program: the app downloads it from PyPI (checksum verified), runs it on your computer only, and opens it at `/learn/` inside the app.
It needs Python 3.6 to 3.14 installed (Raspberry Pi OS has it; on Windows install it from python.org). The first start takes a minute or two. Import courses
(for example Khan Academy) inside Kolibri's own Device page, which needs internet. While Wi-Fi sharing is on, Kolibri also listens on the Wi-Fi so children can open it
from the landing page and sign in with a learner account you create. Removing the module keeps your accounts and lessons.
**AI assistant** (desktop and Pi; under AI in the store): the app runs llama.cpp's `llama-server` on your processor with a model you choose
(Qwen 2.5 0.5B/1.5B/3B/7B, Llama 3.2 1B/3B, Gemma 3 1B, Phi 3.5 mini; 0.4 to 4.7 GB, downloaded from Hugging Face and checked against their SHA-256). The first
model installs the engine for you. Chat opens at `/ai/` inside the app; the model loads on your first question and unloads after 15 quiet minutes. While Wi-Fi sharing is on,
devices that join can chat too (they cannot switch models or reach anything else). It needs no internet once installed, but a small model on a CPU is slow and can be wrong.
The engine ships ready-made CPU builds only for some computers; where there is none the store says so.

## Install on any device, share over Wi-Fi

The desktop app (Windows, Linux x64/arm64/armv7l incl. Raspberry Pi) is its own installer: the Module Store installs content, maps and the
Content Reader **onto the device you are using** (default connection: "This device"). No Pi and no PIN are needed. Connecting to a headless
Pi (PIN-protected) is optional.

- **Share over Wi-Fi** (connections icon): turns this device's Wi-Fi into a hotspot (`NorwinPrep`, password `NORWINNOMAD`,
  Linux/NetworkManager only; refused if Wi-Fi is your only internet link unless you force it) and starts a read-only server. Devices that join
  open `http://10.42.0.1:<port>` and get a landing page with the library, maps and hosted apps. Nothing there can install or change anything.
- Content packs are read through a Kiwix reader (`kiwix-tools`), downloaded on demand as the "Content Reader" tool.
- **Android** installs content packs onto the phone itself (downloaded with resume and checksum verification; needs internet on the phone while installing, not the hub). Packs are read in the free Kiwix app: the Library page's Open button hands the file to it. Maps, apps and the in-browser library are desktop/Pi features.
- **Share from a phone** (connections icon → Share over Wi-Fi): the phone opens a local-only hotspot (Android chooses its name and password and shows them in the app) and serves the packs you installed, read-only. Devices that join open the address shown, download a pack (resumable) and read it in the Kiwix app. A phone cannot serve a browsable library the way a Pi or computer does, because Android cannot run the Kiwix server. Needs Android 8+, the hotspot permission, Location on (Android 12 and older), and your phone's own hotspot off.
- The headless Pi installer below (nginx + Kiwix + Python backend) remains for screenless Pis.

## Module Store (install content, maps and apps)

Open **Module Store** from the portal (`http://10.42.0.1/modules/`), or tap **Modules** next to a NorwinPrep device in the desktop/Android app.
It lists everything you can add to the device in the same layout as an app launcher: **Installed** and **Not installed** sections, a version tag on every
card, OPEN / INSTALL buttons, a "..." menu (Details, Re-download, Remove), search, sort, type filters and a grid/list toggle. The refresh button checks
for newer versions; a red version tag and an UPDATE button mean one is available.

| Type | Examples | Installs to |
|---|---|---|
| Content | medicine, water, post-disaster and food guides, WikEM, Wikipedia (several sizes), WikiHow, iFixit, Gutenberg, Khan Academy, Stack Exchange archives | Kiwix library (`/wiki/`) |
| Maps | world overview, USA, Canada, Europe, UK, Australia | map viewer (`/maps/`) |
| Apps | NorwinPrep for Android, Windows, Raspberry Pi (32/64-bit), Linux PC | hosted at `/apps/` for people on the hotspot |

**Size and space on every card:** each module shows its **install size** (the real size on disk once installed; before that, the exact download size once
the device has looked it up, otherwise a labelled *estimate* such as "1-10 GB") next to **space left** on the device. If a download will not fit, the box turns
red and the button says "Not enough space"; if even the smallest it could be won't fit, it says "may not fit".

**Hide modules you don't want:** open a module's "..." menu and choose **Hide**. A **Hidden** button (with a count) appears in the toolbar to show them again
(dimmed, with **Unhide**); Settings has **Unhide all**. Hiding is a personal preference kept in this browser/app, so it doesn't change the device.

Before anything downloads you see the exact file, version, download size and free space. Downloads resume if interrupted, are verified
(SHA-256) before they replace anything, and queue one at a time. Needs the device to be online (e.g. Ethernet).

**Admin PIN:** looking is open, but installing or removing needs the PIN shown at the end of the install (reset: `sudo /opt/norwinprep/scripts/set-admin-pin.sh`).
Wrong guesses are rate-limited. The catalog is `app/shared/site/catalog.json` (the apps ship the same file for offline browsing); each entry is one of three fixed install kinds (`zim`, `maps`, `app`), so adding a
module is a JSON edit and the service never runs commands from the catalog. The service is `norwinprep-modules` (Python, runs as the unprivileged
`norwinprep` user; its only sudo right is restarting the library service).

## Client apps (Android, Windows, Linux, Raspberry Pi)

Each app runs its **own local NorwinPrep instance** on `127.0.0.1:8787` and **opens straight to the Module Store**, so there is always a screen to
land on, even with no Pi nearby. The store page is the same file the Pi serves at `/modules/`.

Tap the **connections icon** (the Wi-Fi symbol in the top bar; its dot is green when the connected device is online, amber if something answers but
isn't recognised as NorwinPrep, red if unreachable) to see **which network mode the app is using** and to switch:

| Mode | Address | Use it when |
|---|---|---|
| This app only | none | browse the catalog with no device (install buttons say "Connect to install") |
| **Localhost** | `http://localhost` | the app is installed on the same machine as NorwinPrep (e.g. on the Pi itself) |
| NorwinPrep hotspot | `http://10.42.0.1` | you've joined a Pi's Wi-Fi hotspot |
| `norwinprep.local` | `http://norwinprep.local` | a Pi on your network |
| Custom | anything you type | any other address; saved for next time |

At first launch the app connects by itself to the first device it finds that offers the Module Store (the panel says "found automatically"). Once you pick
a mode yourself, the app remembers it. Installs, updates and removals happen **on the connected device** (with its admin PIN, remembered per device). If the
device can't be reached you still see the catalog, with a red bar and a button back to the picker. The picker also links to the device's own portal and to
**This device**, a small page for the app's device name and local files. **Back** (Android) or **Ctrl+H** (desktop) returns to the Module Store.

### Version button and in-app updates

The **version number in the bottom-right corner** (for example `v0.6.14`) is clickable. It turns green and says "update available" when a newer
release exists. Click it to check GitHub's latest release and update automatically:

| Platform | What happens on click |
|---|---|
| Linux AppImage (incl. Raspberry Pi) | downloads the new AppImage, verifies it, replaces the file, restarts |
| Linux `.deb` (installed in `/opt`) | downloads, installs with `pkexec apt-get install` (asks for your password), restarts |
| Windows installer | downloads and runs the installer silently, then restarts |
| Windows portable | saves the new portable exe next to the old one and starts it |
| Android | downloads and verifies the APK, then opens Android's installer (you tap Install; the first time you must allow "install unknown apps" for NorwinPrep) |

Every download is checked against the release's `SHA256SUMS` before anything is installed; a mismatch is discarded. The app only ever fetches
`NorwinLabs/NorwinPrepDisk` release files with a plain `vX.Y.Z` tag. Desktop has **Check for updates** in its menu too. The Android app
checks through whichever network has internet, so it still works while joined to a Pi's hotspot (which has none).

**Versions:** `VERSION` holds `MAJOR.MINOR`. Every push to `main` publishes one release `vMAJOR.MINOR.<run number>` (for example `v0.6.14`), so each
push is one step the update button can take. Bump `VERSION` for a bigger release. Old releases beyond the newest 25 are pruned.

The device name is set on the **This device** page (local instance) or `DEVICE_NAME` in `/etc/norwinprep.conf` (Pi), and both are served as JSON at
`/api/device`. The local server only listens on loopback and rejects requests from other sites; see `app/desktop/local-server.js`
(desktop) and `app/android/.../LocalServer.java` (Android, unit-tested in CI).

Every push to `main` builds all of them in GitHub Actions and publishes them as a **GitHub release** (`vMAJOR.MINOR.<run number>`, newest 25 kept):

| Platform | File |
|---|---|
| Android 7+ | `NorwinPrep-<ver>-android.apk` (sideload; allow "install unknown apps") |
| Windows 10/11 (64-bit) | `NorwinPrep-<ver>-win-x64.exe` installer, or `NorwinPrep-<ver>-portable-x64.exe` |
| Raspberry Pi OS 64-bit | `NorwinPrep-<ver>-linux-arm64.deb` or `.AppImage` |
| Raspberry Pi OS 32-bit | `NorwinPrep-<ver>-linux-armv7l.deb` or `.AppImage` |
| Linux PC (x64) | `NorwinPrep-<ver>-linux-amd64.deb` or `-linux-x86_64.AppImage` |

On a Pi: `sudo apt install ./NorwinPrep-<ver>-linux-arm64.deb`, then run `norwinprep` (add `--kiosk` for full screen).
The device itself can host these for people who join its hotspot: `sudo /opt/norwinprep/scripts/fetch-apps.sh` downloads them,
plus the Kiwix apps, into the portal's **Get the apps** page.

Notes: the Windows build and APK are not code-signed by a public CA. Windows SmartScreen will warn ("More info" > "Run anyway"), and
the APK is signed with the project key checked in at `app/android/norwinprep.keystore` so updates install over older versions.
Fork this repo? Set the secrets `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` to sign with your own key.
Source: `app/desktop` (Electron), `app/android` (native WebView), `app/shared` (connect page).

## Updates

**On the device (when online, e.g. Ethernet plugged in):** `norwinprep-update.timer` runs 10 min after boot and daily at ~03:30.
It does nothing if there is no internet. When online it:
1. installs OS/security updates (unattended-upgrades; no automatic reboot, so kernel updates apply at your next reboot),
2. updates NorwinPrep itself from GitHub (`UPDATE_CHANNEL="stable"` = latest `vX.Y.Z` release, `"edge"` = main) with automatic rollback if nginx fails its config test,
3. refreshes the Kiwix content tier in `CONTENT_TIER` to the newest monthly editions and removes the old ones.

Run it by hand with `sudo /opt/norwinprep/scripts/update.sh`; turn parts off with `AUTO_UPDATE_*` in `/etc/norwinprep.conf`.
Your settings are preserved across updates. The hotspot works over Wi-Fi, so give the Pi internet by Ethernet (or a USB Wi-Fi dongle).
If this repo is private, set `UPDATE_TOKEN` to a read-only GitHub token.

**Releases:** CI checks the scripts and builds the apps on every push to `main` and publishes `vMAJOR.MINOR.<run number>`. Devices on the
`stable` channel follow the newest release, so a Pi updates itself shortly after a push passes CI. Use `UPDATE_CHANNEL="edge"` to track `main` directly.

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

## Credits

The extra content packs, topics and US state maps are adapted from [Project NOMAD](https://github.com/Crosstalk-Solutions/project-nomad) (Apache-2.0). See `NOTICE` and `third_party/project-nomad/`.
