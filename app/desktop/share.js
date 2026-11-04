'use strict';
// "Share over Wi-Fi": turns this device (e.g. a Raspberry Pi running the app) into a Wi-Fi hotspot and serves its content,
// read-only, to the devices that join, with no internet needed. Linux + NetworkManager only. Every nmcli argument is validated
// and run without a shell.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CON = 'NorwinPrepShare';
const DEFAULT_PASSWORD = 'NORWINNOMAD';   // easy to type on a phone; WPA2 needs at least 8 characters
const SSID_RE = /^[A-Za-z0-9 ._-]{1,32}$/, PW_RE = /^[A-Za-z0-9]{8,63}$/, IFACE_RE = /^[A-Za-z0-9._-]{1,15}$/;

const defaultExec = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr || '') })) : resolve({ stdout: String(stdout) })));
});
const fail = (code, msg) => Object.assign(new Error(msg), { code });

class Share {
  constructor(o) {   // o: dataDir, platform, exec(cmd,args), makeServer() -> {start(ports,host), stop()}, ports, ssid
    this.o = Object.assign({ platform: process.platform, exec: defaultExec, ports: [80, 8080, 0], ssid: 'NorwinPrep' }, o);
    this.file = path.join(this.o.dataDir, 'share.json');
    this.server = null; this.active = false; this.iface = null; this.port = 0; this.busy = Promise.resolve(); this.cfg = this.load();
  }
  load() { try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); return { on: !!j.on, auto: j.auto !== false, ssid: SSID_RE.test(j.ssid || '') ? j.ssid : this.o.ssid, password: DEFAULT_PASSWORD }; } catch (e) { return { on: false, auto: true, ssid: this.o.ssid, password: DEFAULT_PASSWORD }; } }
  save() { fs.mkdirSync(this.o.dataDir, { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.cfg), { mode: 0o600 }); }
  async wifiDevice() {
    if (this.o.platform !== 'linux') return null;
    try {
      const out = (await this.o.exec('nmcli', ['-t', '-f', 'DEVICE,TYPE', 'device'])).stdout;
      for (const line of out.split('\n')) { const [dev, type] = line.trim().split(':'); if (type === 'wifi' && IFACE_RE.test(dev || '')) return dev; }
    } catch (e) { /* no nmcli */ }
    return null;
  }
  async usingWifiForInternet(iface) {
    try { const out = (await this.o.exec('ip', ['-4', 'route', 'show', 'default'])).stdout; return out.split('\n').some((l) => new RegExp('\\bdev ' + iface + '\\b').test(l)); } catch (e) { return false; }
  }
  async status() {
    const iface = await this.wifiDevice(), supported = !!iface;
    const s = { supported, active: this.active, auto: this.cfg.auto };
    if (!supported) s.reason = this.o.platform === 'linux' ? 'No Wi-Fi adapter was found (or NetworkManager is not running).' : 'Sharing over Wi-Fi needs Linux with NetworkManager, for example Raspberry Pi OS.';
    if (this.active) { s.ssid = this.cfg.ssid; s.password = this.cfg.password; s.port = this.port; s.url = 'http://10.42.0.1' + (this.port === 80 ? '' : ':' + this.port); }
    return s;
  }
  set(on, force) {          // serialised: rapid toggles queue up instead of racing
    const run = this.busy.then(() => (on ? this.start(!!force) : this.stop()), () => (on ? this.start(!!force) : this.stop()));
    this.busy = run.catch(() => {}); return run;
  }
  async start(force) {
    if (this.active) return this.status();
    const iface = await this.wifiDevice(); if (!iface) throw fail(400, (await this.status()).reason);
    if (!force && await this.usingWifiForInternet(iface)) throw fail(409, 'This device is online through its Wi-Fi, which the hotspot needs. Switch to Ethernet first, or share anyway and lose that Wi-Fi connection.');
    const { ssid, password } = this.cfg;
    this.server = this.o.makeServer();
    try { this.port = await this.server.start(this.o.ports, '0.0.0.0'); }
    catch (e) { this.server = null; throw fail(500, 'Could not start the sharing server (' + e.message + ')'); }
    try {
      try { await this.o.exec('nmcli', ['connection', 'delete', CON]); } catch (e) { /* none yet */ }
      await this.o.exec('nmcli', ['connection', 'add', 'type', 'wifi', 'ifname', iface, 'con-name', CON, 'autoconnect', 'no', 'ssid', ssid,
        '802-11-wireless.mode', 'ap', '802-11-wireless.band', 'bg', 'ipv4.method', 'shared', 'ipv4.addresses', '10.42.0.1/24', 'ipv6.method', 'disabled',
        'wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', password]);
      await this.o.exec('nmcli', ['connection', 'up', CON]);
    } catch (e) {
      await this.server.stop(); this.server = null;
      try { await this.o.exec('nmcli', ['connection', 'delete', CON]); } catch (e2) { /* ignore */ }
      throw fail(500, 'Could not start the Wi-Fi hotspot: ' + String(e.stderr || e.message).trim().split('\n')[0].slice(0, 160));
    }
    this.iface = iface; this.active = true; this.cfg.on = true; this.save();
    return this.status();
  }
  async stop(keepPreference) {
    if (!this.active && !this.server) { if (!keepPreference) { this.cfg.on = false; this.save(); } return this.status(); }
    try { await this.o.exec('nmcli', ['connection', 'down', CON]); } catch (e) { /* already down */ }
    try { await this.o.exec('nmcli', ['connection', 'delete', CON]); } catch (e) { /* already gone */ }
    if (this.server) { await this.server.stop(); this.server = null; }
    this.active = false; if (!keepPreference) this.cfg.on = false; this.save();
    return this.status();
  }
  // at app start: share again if it was on when the app last ran, or if "start the Wi-Fi when the app opens" is set (the default).
  // Only a deliberate earlier choice may take over a Wi-Fi internet link; the automatic start never does.
  async resume() { if (this.cfg.on || this.cfg.auto) { try { await this.set(true, this.cfg.on); } catch (e) { /* surfaced in status */ } } }
  setAuto(v) { this.cfg.auto = !!v; this.save(); return this.status(); }
  // at app quit: bring the hotspot down but remember the choice
  shutdown() { return this.stop(true); }
}

module.exports = { Share };
