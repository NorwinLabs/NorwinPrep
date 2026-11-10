'use strict';
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { create, createShare, NAME_RE } = require('./local-server');
const { Manager } = require('./modules-manager');
const { Reader } = require('./reader');
const { Share } = require('./share');
const { Autostart } = require('./autostart');
const { Kolibri } = require('./kolibri');
const { Hub } = require('./ai');
const { libraryContext } = require('./library-search');
const updaterLib = require('./updater');
const { spawn, execFile } = require('child_process');

const SELFTEST = process.argv.includes('--selftest');
const KIOSK = process.argv.includes('--kiosk');   // full-screen, for a Pi with a display

// AppImages (and root/CI runs) can't use Chromium's setuid sandbox
if (process.env.APPIMAGE || process.argv.includes('--no-sandbox')) app.commandLine.appendSwitch('no-sandbox');

let win, server, home, reader, share, kolibri, ai;   // everything the quit handler stops must live here, not inside startServer

// ---- device name (shared with anything that connects to the local instance) ----
function cfgFile() { return path.join(app.getPath('userData'), 'device.json'); }
function defaultName() {
  const host = os.hostname().replace(/[^A-Za-z0-9 ._()-]/g, '-').slice(0, 20) || 'device';
  return ('NorwinPrep (' + host + ')').slice(0, 40);
}
function loadName() {
  try {
    const n = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')).name;
    if (typeof n === 'string' && NAME_RE.test(n)) return n;
  } catch (e) { /* first run */ }
  return defaultName();
}
function saveName(n) {
  fs.mkdirSync(path.dirname(cfgFile()), { recursive: true });
  fs.writeFileSync(cfgFile(), JSON.stringify({ name: n }));
}

// Which kind of install is this? Decides how an update is applied.
function detectPackaging() {
  if (!app.isPackaged) return 'dev';
  if (process.platform === 'win32') return process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'installer';
  if (process.platform === 'linux') return process.env.APPIMAGE ? 'appimage' : (process.execPath.startsWith('/opt/NorwinPrep/') ? 'deb' : 'dev');
  return 'dev';
}
const ARCH = process.arch === 'arm' ? 'armv7l' : process.arch;

function makeUpdater() {
  return updaterLib.create({
    slug: 'NorwinLabs/NorwinPrepDisk',
    // test hooks: point the updater at a fake GitHub (used by the self-test)
    apiBase: process.env.NORWINPREP_API_BASE || 'https://api.github.com',
    dlBase: process.env.NORWINPREP_DL_BASE || 'https://github.com',
    platform: process.platform === 'win32' ? 'windows' : process.platform,
    arch: ARCH, packaging: detectPackaging(),
    appImagePath: process.env.APPIMAGE, portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    execPath: process.execPath, relaunchArgs: process.argv.slice(1).filter((a) => a === '--kiosk' || a === '--no-sandbox'),
    actions: {
      // Free port 8787 before the new copy starts, so it comes up on the same address (keeps your saved options)
      spawnDetached: (cmd, args) => {
        try { server.stop(); } catch (e) { /* already stopped */ }
        const c = spawn(cmd, args, { detached: true, stdio: 'ignore' });
        c.on('error', () => {}); c.unref();
      },
      exec: (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 15 * 60 * 1000 }, (e) => (e ? reject(e) : resolve()))),
      quit: () => setTimeout(() => app.quit(), 800)
    }
  });
}

// Voice typing needs the microphone. Only this app's own page (loopback) may ask; on macOS the system asks the person first.
function allowMicrophone() {
  try {
    const { session, systemPreferences } = require('electron');
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
      let ok = false; try { const u = new URL((details && details.requestingUrl) || wc.getURL()); ok = permission === 'media' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && (!details || !details.mediaTypes || details.mediaTypes.every((t) => t === 'audio')); } catch (e) { ok = false; }
      if (!ok) return cb(false);
      if (process.platform === 'darwin' && systemPreferences.askForMediaAccess) systemPreferences.askForMediaAccess('microphone').then(cb, () => cb(false)); else cb(true);
    });
  } catch (e) { /* not fatal: no voice typing */ }
}
async function startServer() {
  const filesDir = path.join(app.getPath('userData'), 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  let name = loadName();
  // The library: content packs, maps and hosted apps live in this app's own folder, on any device. No Pi involved.
  const dataDir = path.join(app.getPath('userData'), 'library'), siteDir = path.join(__dirname, 'site');
  for (const d of ['zim', 'maps', 'apps']) fs.mkdirSync(path.join(dataDir, d), { recursive: true });
  reader = new Reader({ binDir: path.join(dataDir, 'reader'), zimDir: path.join(dataDir, 'zim') });
  const env = process.env;
  kolibri = new Kolibri({ dataDir });
  allowMicrophone();
  ai = new Hub({ dataDir, context: (q, eco) => (reader && reader.ready() ? libraryContext(q, { port: reader.port, root: '/wiki', maxChars: eco ? 1200 : 3000, maxPages: eco ? 2 : 3 }) : null), eco: () => { try { return require('electron').powerMonitor.isOnBatteryPower(); } catch (e) { return false; } } });
  const modules = new Manager({
    pythonCheck: (requires) => kolibri.findPython(requires), onKolibriChange: () => kolibri.stop(), onAiChange: () => ai.stop(), ollama: ai.ollama,
    onBattery: () => { try { return require('electron').powerMonitor.isOnBatteryPower(); } catch (e) { return false; } },
    pickFolder: async (title) => { const r = await dialog.showOpenDialog(win || undefined, { title, properties: ['openDirectory', 'createDirectory'] }); return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]; },
    catalog: path.join(siteDir, 'catalog.json'), dataDir, onLibraryChange: () => reader.restart(),
    bundledDir: siteDir, kiwix: env.NORWINPREP_KIWIX_BASE || undefined, githubApi: env.NORWINPREP_API_BASE || undefined, githubDl: env.NORWINPREP_DL_BASE || undefined, protomaps: env.NORWINPREP_PROTOMAPS_BASE || undefined
  });
  // scheduled updates (off unless the user turns them on in the store): checked every 30 minutes, run only in the chosen night hours and on mains power
  { const tick = () => { modules.autoUpdateTick().catch(() => {}); }, t1 = setInterval(tick, 30 * 60000), t2 = setTimeout(tick, 3 * 60000); if (t1.unref) t1.unref(); if (t2.unref) t2.unref(); }
  share = new Share({
    dataDir: app.getPath('userData'), onActive: (on) => kolibri.setShared(on),
    makeServer: () => createShare({ siteDir, ai, kolibriInfo: () => kolibri.info(), siteRoot: (d) => modules.siteRoot(d), siteList: () => modules.listSites(), mapsDir: path.join(dataDir, 'maps'), appsDir: path.join(dataDir, 'apps'), reader, getName: () => name, version: app.getVersion(), auth: share.authFor(), onClient: (ip, n) => deviceJoined(n) })
  });
  // start with the device: on the very first run turn "launch at startup" on (the user can switch it off in the connections panel)
  const autostart = new Autostart({ platform: process.platform, exec: process.env.APPIMAGE || process.execPath, app, args: process.argv.slice(1).filter((a) => a === '--kiosk' || a === '--no-sandbox') });
  if (!SELFTEST && !process.env.NORWINPREP_NO_AUTOSTART) {
    const mark = path.join(app.getPath('userData'), 'autostart-initialised');
    if (!fs.existsSync(mark)) { try { autostart.set(true); fs.writeFileSync(mark, '1'); } catch (e) { /* not fatal */ } }
  }
  reader.restart().catch(() => {});             // start the reader if a content pack is already installed
  share.resume().catch(() => {});               // and resume sharing over Wi-Fi if it was on when the app last ran
  server = create({
    siteDir, filesDir, modules, kolibri, ai, speechDir: path.join(dataDir, 'speech'), mapsDir: path.join(dataDir, 'maps'), appsDir: path.join(dataDir, 'apps'), reader, share, autostart,
    getName: () => name, setName: (n) => { name = n; saveName(n); },
    version: app.getVersion(), platform: process.platform === 'win32' ? 'windows' : process.platform,
    arch: ARCH, packaging: detectPackaging(), update: makeUpdater()
  });
  const port = await server.start(8787);   // falls back to a free port if 8787 is taken
  home = 'http://127.0.0.1:' + port + '/';
  return { port, filesDir };
}

// a device joined the Wi-Fi share: there is no vibration motor in a PC, so tell the owner with a system notification, a taskbar flash and a beep
function deviceJoined(n) {
  try { const { Notification, shell } = require('electron'); if (Notification.isSupported()) new Notification({ title: 'A device joined your Wi-Fi', body: n + (n === 1 ? ' device is' : ' devices are') + ' connected. They will be asked to sign in.', silent: false }).show(); try { shell.beep(); } catch (e) { /* no sound */ } } catch (e) { /* not fatal */ }
  try { if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true); } catch (e) { /* not fatal */ }
}
function goHome(stay) { win.loadURL(home + (stay ? '?stay=1' : '')); }

function createWindow(info) {
  win = new BrowserWindow({
    width: 1100, height: 800, minWidth: 360, minHeight: 480,
    show: !SELFTEST, fullscreen: KIOSK, autoHideMenuBar: true,
    backgroundColor: '#10140f', title: 'NorwinPrep',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  // links that open new windows go to the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'NorwinPrep', submenu: [
      { label: 'Home / choose connection', accelerator: 'CmdOrCtrl+H', click: () => goHome(true) },
      { label: 'Back', accelerator: 'Alt+Left', click: () => { if (win.webContents.canGoBack()) win.webContents.goBack(); } },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win.webContents.reload() },
      { label: 'Toggle full screen', accelerator: 'F11', click: () => win.setFullScreen(!win.isFullScreen()) },
      { label: 'Open local files folder', click: () => shell.openPath(info.filesDir) },
      { label: 'Check for updates\u2026', click: () => win.loadURL(home + '?stay=1#update') },
      { type: 'separator' },
      { role: 'quit' } ] }
  ]));
  // if a remote device can't be reached, come back to the home page with a message
  win.webContents.on('did-fail-load', (_e, code, _d, url, isMain) => {
    if (isMain && code !== -3 && !url.startsWith(home)) win.loadURL(home + '?unreachable=' + encodeURIComponent(url));
  });
  goHome(false);
}

// ---------- self test (used by CI): exercises the real server + window ----------
function request(port, method, p, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: opts.headers || {} }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ code: res.statusCode, body: d }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}
async function selftest(port) {
  const fails = [];
  const check = (c, m) => { if (!c) fails.push(m); };
  let r = await request(port, 'GET', '/');
  check(r.code === 200 && r.body.includes('NorwinPrep'), 'home page served');
  r = await request(port, 'GET', '/api/device');
  let d = {}; try { d = JSON.parse(r.body); } catch (e) { /* checked below */ }
  check(r.code === 200 && typeof d.name === 'string' && d.name.length > 0 && d.mode === 'local', 'device name API');
  r = await request(port, 'PUT', '/api/device', { headers: { 'X-NorwinPrep': '1' }, body: JSON.stringify({ name: d.name }) });
  check(r.code === 200, 'rename API accepts same-app request');
  r = await request(port, 'PUT', '/api/device', { body: '{"name":"x"}' });
  check(r.code === 403, 'rename without header refused');
  r = await request(port, 'GET', '/api/device', { headers: { Host: 'evil.example:' + port } });
  check(r.code === 403, 'foreign Host header refused');
  r = await request(port, 'GET', '/..%2fpackage.json');
  check(r.code === 400 || r.code === 404, 'path traversal refused');
  r = await request(port, 'GET', '/api/update/status');
  check(r.code === 200 && JSON.parse(r.body).state === 'idle', 'update status idle');
  r = await request(port, 'GET', '/api/modules/catalog');
  let cat = {}; try { cat = JSON.parse(r.body); } catch (e) { /* below */ }
  check(r.code === 200 && Array.isArray(cat.modules) && cat.modules.length > 30 && cat.disk && cat.disk.free > 0, 'module store works on this device (' + (cat.modules || []).length + ' modules, no Pi needed)');
  r = await request(port, 'POST', '/api/modules/install', { headers: { 'X-NorwinPrep': '1' }, body: JSON.stringify({ id: '../../x' }) });
  check(r.code === 404, 'module install rejects an unknown id');
  r = await request(port, 'POST', '/api/modules/install', { body: JSON.stringify({ id: 'water' }) });
  check(r.code === 403, 'module install without the app header refused');
  r = await request(port, 'GET', '/api/modules/catalog', { headers: { Host: 'evil.example:' + port } });
  check(r.code === 403, 'module API refuses a foreign Host header');
  r = await request(port, 'GET', '/api/share'); let sh = {}; try { sh = JSON.parse(r.body); } catch (e) { /* below */ }
  check(r.code === 200 && typeof sh.supported === 'boolean', 'share status answers (supported=' + sh.supported + ')');
  r = await request(port, 'GET', '/tiles/'); check(r.code === 200 && Array.isArray(JSON.parse(r.body)), 'map tile listing answers');
  r = await request(port, 'GET', '/apps/'); check(r.code === 200 && /Apps/.test(r.body), 'hosted apps page answers');
  r = await request(port, 'GET', '/wiki/'); check(r.code === 503, 'library says "not ready" until a content pack is installed');
  r = await request(port, 'GET', '/api/update/check');
  check(r.code === 502 && /Could not reach GitHub/.test(r.body), 'update check reports an unreachable GitHub cleanly');
  r = await request(port, 'POST', '/api/update/install', { headers: { 'X-NorwinPrep': '1' }, body: JSON.stringify({ tag: 'v1', asset: 'x' }) });
  check(r.code === 400, 'update install rejects a bad tag/asset');
  r = await request(port, 'POST', '/api/update/install', { body: JSON.stringify({ tag: 'v0.6.1', asset: 'NorwinPrep-0.6.1-linux-arm64.deb' }) });
  check(r.code === 403, 'update install without the app header refused');
  r = await request(port, 'GET', '/api/device');
  d = {}; try { d = JSON.parse(r.body); } catch (e) { /* below */ }
  check(typeof d.arch === 'string' && d.arch.length > 0 && typeof d.packaging === 'string' && d.packaging.length > 0, 'device info reports arch and packaging');
  const ready = await win.webContents.executeJavaScript(
    "new Promise(function(res){var n=0;(function w(){if(document.body&&document.body.getAttribute('data-ready')==='1'||++n>100)res(document.title+'|'+(document.getElementById('name')||{}).textContent);else setTimeout(w,100)})()})");
  check(/NorwinPrep/.test(ready), 'window shows the local home page (' + ready + ')');
  return fails;
}

if (SELFTEST) { for (const k of ['NORWINPREP_API_BASE', 'NORWINPREP_DL_BASE', 'NORWINPREP_KIWIX_BASE', 'NORWINPREP_PROTOMAPS_BASE']) process.env[k] = 'http://127.0.0.1:1'; }   // never touch the real internet in tests

app.whenReady().then(async () => {
  const info = await startServer();
  createWindow(info);
  if (SELFTEST) {
    const bail = setTimeout(() => { console.error('SELFTEST FAIL: timeout'); app.exit(1); }, 40000);
    win.webContents.once('did-finish-load', async () => {
      try {
        const fails = await selftest(info.port);
        clearTimeout(bail);
        if (fails.length) { console.error('SELFTEST FAIL: ' + fails.join('; ')); app.exit(1); }
        else { console.log('SELFTEST OK port=' + info.port + ' name=' + JSON.stringify(loadName())); app.exit(0); }
      } catch (e) { console.error('SELFTEST FAIL: ' + e); app.exit(1); }
    });
  }
});
app.on('window-all-closed', () => app.quit());
let quitting = false;
app.on('before-quit', (e) => {      // bring the hotspot down and stop the reader before exiting, so Wi-Fi comes back
  if (quitting) return; quitting = true; e.preventDefault();
  Promise.all([share ? share.shutdown().catch(() => {}) : null, reader ? reader.stop().catch(() => {}) : null, kolibri ? kolibri.stop().catch(() => {}) : null, ai ? ai.stop().catch(() => {}) : null]).then(() => { try { server.stop(); } catch (x) { /* ignore */ } app.exit(0); });
});
