'use strict';
const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

const SELFTEST = process.argv.includes('--selftest');
const KIOSK = process.argv.includes('--kiosk');   // full-screen, for a Pi with a display
const CONNECT = path.join(__dirname, 'connect.html');

// AppImages (and root/CI runs) can't use Chromium's setuid sandbox
if (process.env.APPIMAGE || process.argv.includes('--no-sandbox')) app.commandLine.appendSwitch('no-sandbox');

let win;

function connectPage(manual) {
  const query = SELFTEST ? { selftest: '1' } : manual ? { manual: '1' } : {};
  win.loadFile(CONNECT, { query });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 800, minWidth: 360, minHeight: 480,
    show: !SELFTEST, fullscreen: KIOSK, autoHideMenuBar: true,
    backgroundColor: '#10140f', title: 'NorwinPrep',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  // links that open new windows go to the system browser (e.g. downloads on the device)
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'NorwinPrep', submenu: [
      { label: 'Change server…', accelerator: 'CmdOrCtrl+L', click: () => connectPage(true) },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win.webContents.reload() },
      { label: 'Home', accelerator: 'CmdOrCtrl+H', click: () => connectPage(false) },
      { label: 'Toggle full screen', accelerator: 'F11', click: () => win.setFullScreen(!win.isFullScreen()) },
      { type: 'separator' },
      { role: 'quit' } ] }
  ]));
  // if the device is unreachable later, fall back to the connect page
  win.webContents.on('did-fail-load', (_e, code, _d, url, isMain) => {
    if (isMain && code !== -3 && !url.startsWith('file:')) connectPage(true);
  });
  connectPage(false);

  if (SELFTEST) {
    const fail = (why) => { console.error('SELFTEST FAIL: ' + why); app.exit(1); };
    setTimeout(() => fail('timeout'), 30000);
    win.webContents.on('did-finish-load', async () => {
      try {
        const r = await win.webContents.executeJavaScript(
          "JSON.stringify({title: document.title, ready: document.body.getAttribute('data-ready')})");
        const v = JSON.parse(r);
        if (v.title === 'NorwinPrep' && v.ready === '1') { console.log('SELFTEST OK ' + r); app.exit(0); }
        else fail(r);
      } catch (e) { fail(String(e)); }
    });
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
