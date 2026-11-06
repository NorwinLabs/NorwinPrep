'use strict';
// "Share over Wi-Fi": turns this device (e.g. a Raspberry Pi running the app) into a Wi-Fi hotspot and serves its content,
// read-only, to the devices that join, with no internet needed. Linux + NetworkManager only. Every nmcli argument is validated
// and run without a shell.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');

const CON = 'NorwinPrepShare';
const DEFAULT_PASSWORD = 'NORWINNOMAD';
const ADMIN = { user: 'admin', password: 'NOMAD' };   // the default sign-in for the page that devices joining the Wi-Fi are sent to (changeable)
const ADMIN_PW_OK = (v) => typeof v === 'string' && v.length >= 4 && v.length <= 64 && !/[\u0000-\u001f\u007f]/.test(v);
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 32).toString('hex');
const PORTAL_DNS = 'address=/#/10.42.0.1\n';           // every name resolves to this device, so the phone's "is there internet?" test lands on the sign-in page   // easy to type on a phone; WPA2 needs at least 8 characters
const SSID_RE = /^[A-Za-z0-9 ._-]{1,32}$/, PW_RE = /^[A-Za-z0-9]{8,63}$/, IFACE_RE = /^[A-Za-z0-9._-]{1,15}$/;

const defaultExec = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr || '') })) : resolve({ stdout: String(stdout) })));
});
const fail = (code, msg) => Object.assign(new Error(msg), { code });

class Share {
  constructor(o) {   // o: dataDir, platform, exec(cmd,args), makeServer() -> {start(ports,host), stop()}, ports, ssid
    this.o = Object.assign({ platform: process.platform, exec: defaultExec, ports: [80, 8080, 0], ssid: 'NorwinPrep', dnsmasqDir: '/etc/NetworkManager/dnsmasq-shared.d' }, o);
    this.captive = false;
    this.file = path.join(this.o.dataDir, 'share.json');
    this.server = null; this.active = false; this.iface = null; this.port = 0; this.busy = Promise.resolve(); this.cfg = this.load();
  }
  load() {
    let j = {}; try { j = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch (e) { /* first run */ }
    const a = j.admin && /^[0-9a-f]{32}$/.test(j.admin.salt || '') && /^[0-9a-f]{64}$/.test(j.admin.hash || '') ? { salt: j.admin.salt, hash: j.admin.hash } : null;   // the sign-in password is stored only as a salted hash
    return { on: !!j.on, auto: j.auto !== false, ssid: SSID_RE.test(j.ssid || '') ? j.ssid : this.o.ssid, password: PW_RE.test(j.password || '') ? j.password : DEFAULT_PASSWORD, admin: a };
  }
  // ---- sign-in and Wi-Fi passwords (both changeable; defaults are NORWINNOMAD for the Wi-Fi and admin / NOMAD for the sign-in page) ----
  checkAdmin(user, pw) {
    if (user !== ADMIN.user) return false;
    if (!this.cfg.admin) return pw === ADMIN.password;
    try { return crypto.timingSafeEqual(Buffer.from(hashPw(pw, this.cfg.admin.salt), 'hex'), Buffer.from(this.cfg.admin.hash, 'hex')); } catch (e) { return false; }
  }
  authFor() { return { user: ADMIN.user, verify: (u, p) => this.checkAdmin(u, p) }; }
  async setPasswords(o) {
    o = o || {}; let wifiChanged = false;
    if (o.wifiPassword !== undefined) { if (!PW_RE.test(o.wifiPassword || '')) throw fail(400, 'The Wi-Fi password must be 8 to 63 letters and numbers (no spaces or symbols).'); wifiChanged = o.wifiPassword !== this.cfg.password; this.cfg.password = o.wifiPassword; }
    if (o.adminPassword !== undefined) {
      if (!ADMIN_PW_OK(o.adminPassword)) throw fail(400, 'The sign-in password must be 4 to 64 characters.');
      const salt = crypto.randomBytes(16).toString('hex'); this.cfg.admin = { salt, hash: hashPw(o.adminPassword, salt) };
      if (this.server && this.server.resetSessions) this.server.resetSessions();      // everyone signs in again with the new password
    }
    this.save();
    if (wifiChanged && this.active) { await this.stop(true); await this.start(true); }  // the hotspot restarts with the new password; joined devices must reconnect
    return this.status();
  }
  save() { fs.mkdirSync(this.o.dataDir, { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.cfg), { mode: 0o600 }); }
  clients() { return this.server && this.server.clients ? this.server.clients() : 0; }
  // Best effort (needs permission to write there, which the Raspberry Pi service has): without it people can still open the address by hand
  writePortalDns() { try { fs.mkdirSync(this.o.dnsmasqDir, { recursive: true }); fs.writeFileSync(path.join(this.o.dnsmasqDir, 'norwinprep-portal.conf'), PORTAL_DNS); return true; } catch (e) { return false; } }
  removePortalDns() { try { fs.unlinkSync(path.join(this.o.dnsmasqDir, 'norwinprep-portal.conf')); } catch (e) { /* none */ } this.captive = false; }
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
    const s = { supported, active: this.active, auto: this.cfg.auto, clients: this.clients(), adminDefault: !this.cfg.admin, wifiDefault: this.cfg.password === DEFAULT_PASSWORD };
    if (!supported) s.reason = this.o.platform === 'linux' ? 'No Wi-Fi adapter was found (or NetworkManager is not running).' : 'Sharing over Wi-Fi needs Linux with NetworkManager, for example Raspberry Pi OS.';
    if (this.active) { s.ssid = this.cfg.ssid; s.password = this.cfg.password; s.port = this.port; s.url = 'http://10.42.0.1' + (this.port === 80 ? '' : ':' + this.port); s.captive = this.captive && this.port === 80; s.login = ADMIN.user; }
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
    this.captive = this.writePortalDns();
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
      this.removePortalDns();
      await this.server.stop(); this.server = null;
      try { await this.o.exec('nmcli', ['connection', 'delete', CON]); } catch (e2) { /* ignore */ }
      throw fail(500, 'Could not start the Wi-Fi hotspot: ' + String(e.stderr || e.message).trim().split('\n')[0].slice(0, 160));
    }
    this.iface = iface; this.active = true; this.cfg.on = true; this.save();
    if (this.o.onActive) { try { this.o.onActive(true); } catch (e) { /* not fatal */ } }
    return this.status();
  }
  async stop(keepPreference) {
    if (!this.active && !this.server) { if (!keepPreference) { this.cfg.on = false; this.save(); } return this.status(); }
    try { await this.o.exec('nmcli', ['connection', 'down', CON]); } catch (e) { /* already down */ }
    try { await this.o.exec('nmcli', ['connection', 'delete', CON]); } catch (e) { /* already gone */ }
    this.removePortalDns();
    if (this.server) { await this.server.stop(); this.server = null; }
    this.active = false; if (!keepPreference) this.cfg.on = false; this.save();
    if (this.o.onActive) { try { this.o.onActive(false); } catch (e) { /* not fatal */ } }
    return this.status();
  }
  // at app start: share again if it was on when the app last ran, or if "start the Wi-Fi when the app opens" is set (the default).
  // Only a deliberate earlier choice may take over a Wi-Fi internet link; the automatic start never does.
  async resume() { if (this.cfg.on || this.cfg.auto) { try { await this.set(true, this.cfg.on); } catch (e) { /* surfaced in status */ } } }
  setAuto(v) { this.cfg.auto = !!v; this.save(); return this.status(); }
  // at app quit: bring the hotspot down but remember the choice
  shutdown() { return this.stop(true); }
}

module.exports = { Share, ADMIN };
