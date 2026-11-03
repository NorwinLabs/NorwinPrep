'use strict';
const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { create, NAME_RE } = require('./local-server');

const SELFTEST = process.argv.includes('--selftest');
const KIOSK = process.argv.includes('--kiosk');   // full-screen, for a Pi with a display

// AppImages (and root/CI runs) can't use Chromium's setuid sandbox
if (process.env.APPIMAGE || process.argv.includes('--no-sandbox')) app.commandLine.appendSwitch('no-sandbox');

let win, server, home;

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

async function startServer() {
  const filesDir = path.join(app.getPath('userData'), 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  let name = loadName();
  server = create({
    siteDir: path.join(__dirname, 'site'), filesDir,
    getName: () => name, setName: (n) => { name = n; saveName(n); },
    version: app.getVersion(), platform: process.platform === 'win32' ? 'windows' : process.platform
  });
  const port = await server.start(8787);   // falls back to a free port if 8787 is taken
  home = 'http://127.0.0.1:' + port + '/';
  return { port, filesDir };
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
  const ready = await win.webContents.executeJavaScript(
    "new Promise(function(res){var n=0;(function w(){if(document.body&&document.body.getAttribute('data-ready')==='1'||++n>100)res(document.title+'|'+(document.getElementById('name')||{}).textContent);else setTimeout(w,100)})()})");
  check(/NorwinPrep/.test(ready), 'window shows the local home page (' + ready + ')');
  return fails;
}

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
app.on('quit', () => { try { server.stop(); } catch (e) { /* ignore */ } });
