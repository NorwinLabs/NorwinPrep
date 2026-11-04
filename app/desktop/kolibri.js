'use strict';
// Kolibri (Learning Equality's offline school platform) as an optional module. It is a Python program, so this finds a suitable
// Python, runs it from the unpacked PyPI wheel on loopback only, and proxies it under /learn/ so it opens inside the app.
// Started on first use (it is heavy), stopped when the app quits. Accounts and lessons live in <data>/kolibri/home and survive removal.
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, execFile } = require('child_process');

const PREFIX = '/learn/';

// ">=3.6,<3.15" style ranges only
function pythonOk(ver, requires) {
  const v = String(ver).split('.').map(Number);
  const cmp = (a, b) => { for (let i = 0; i < 2; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); } return 0; };
  for (const part of String(requires || '>=3.6').split(',')) {
    const m = /^\s*(>=|<=|>|<|==)\s*(\d+)\.(\d+)/.exec(part); if (!m) continue;
    const c = cmp(v, [Number(m[2]), Number(m[3])]);
    if ((m[1] === '>=' && c < 0) || (m[1] === '>' && c <= 0) || (m[1] === '<' && c >= 0) || (m[1] === '<=' && c > 0) || (m[1] === '==' && c !== 0)) return false;
  }
  return true;
}
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const portFree = (p) => new Promise((resolve) => { const s = net.createServer(); s.on('error', () => resolve(false)); s.listen(p, '127.0.0.1', () => s.close(() => resolve(true))); });
const defaultCandidates = (platform) => (platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']]);
const runOut = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 15000, windowsHide: true }, (e, out) => (e ? reject(e) : resolve(String(out).trim()))));

class Kolibri {
  constructor(o) {   // o: dataDir (the library folder), platform, candidates, spawn, startTimeout
    this.o = Object.assign({ platform: process.platform, spawn, startTimeout: 240000 }, o);
    this.base = path.join(this.o.dataDir, 'kolibri'); this.appDir = path.join(this.base, 'app'); this.home = path.join(this.base, 'home');
    this.child = null; this.port = 0; this.zip = 0; this.up = false; this.starting = null; this.lastError = ''; this.stopping = false; this.shared = false; this.log = '';
  }
  meta() { try { return JSON.parse(fs.readFileSync(path.join(this.appDir, '.installed'), 'utf8')); } catch (e) { return null; } }
  installed() { return !!this.meta() && fs.existsSync(path.join(this.appDir, 'kolibri', '__init__.py')); }
  ready() { return this.up; }
  async findPython(requires) {          // the first interpreter in range, as a [cmd, ...args] array; throws a user-readable Error
    let found = null;
    for (const c of this.o.candidates || defaultCandidates(this.o.platform)) {
      try { const v = await runOut(c[0], c.slice(1).concat(['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'])); if (/^\d+\.\d+$/.test(v)) { found = found || v; if (pythonOk(v, requires)) return c; } } catch (e) { /* not installed */ }
    }
    throw new Error(found ? 'Kolibri needs Python ' + String(requires || '3.6+').replace(/,/g, ' and ') + ', but this computer has Python ' + found + '. Install a supported Python from python.org, then try again.'
      : 'Kolibri needs Python 3 on this computer. Install it from python.org (Raspberry Pi OS already has it), then try again.');
  }
  async stablePort(name, avoid) {          // the same port as last time when it is still free, so a shared address stays valid
    const f = path.join(this.base, 'ports.json'); let saved = {}; try { saved = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* first run */ }
    let p = Number(saved[name]);
    if (!(p > 1023 && p < 65536) || (avoid || []).includes(p) || !(await portFree(p))) p = await freePort();
    saved[name] = p; try { fs.mkdirSync(this.base, { recursive: true }); fs.writeFileSync(f, JSON.stringify(saved)); } catch (e) { /* not fatal */ }
    return p;
  }
  writeOptions(listen) {
    fs.mkdirSync(this.home, { recursive: true });
    fs.writeFileSync(path.join(this.home, 'options.ini'), ['[Deployment]', 'HTTP_PORT = ' + this.port, 'ZIP_CONTENT_PORT = ' + this.zip, 'URL_PATH_PREFIX = ' + PREFIX,
      'LISTEN_ADDRESS = ' + listen, 'DISABLE_PING = True', ''].join('\n'));
  }
  start() {                               // single flight; resolves when Kolibri answers
    if (this.up) return Promise.resolve(true);
    if (this.starting) return this.starting;
    this.lastError = '';
    this.starting = (async () => {
      const meta = this.meta(); if (!meta) throw new Error('Kolibri is not installed');
      const py = await this.findPython(meta.requires);
      this.port = await this.stablePort('http'); this.zip = await this.stablePort('zip', [this.port]);
      this.writeOptions(this.shared ? '0.0.0.0' : '127.0.0.1');
      const env = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG || 'C.UTF-8', KOLIBRI_HOME: this.home, PYTHONPATH: this.appDir, PYTHONNOUSERSITE: '1' };
      this.child = this.o.spawn(py[0], py.slice(1).concat(['-m', 'kolibri', 'start', '--foreground', '--port', String(this.port)]), { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: this.base });
      const child = this.child; this.log = '';
      const keep = (d) => { this.log = (this.log + d).slice(-4000); };
      child.stdout && child.stdout.on('data', keep); child.stderr && child.stderr.on('data', keep);
      child.on('exit', (code) => { if (this.child === child) { this.child = null; this.up = false; if (!this.stopping) this.lastError = 'Kolibri stopped (exit ' + code + '). ' + (this.log.trim().split('\n').pop() || '').slice(0, 200); } });
      child.on('error', (e) => { this.lastError = 'Could not start Python: ' + e.message; });
      const t0 = Date.now();
      while (Date.now() - t0 < this.o.startTimeout) {
        if (!this.child || this.child !== child) throw new Error(this.lastError || 'Kolibri did not start');
        if (await this.probe()) { this.up = true; return true; }
        await new Promise((r) => setTimeout(r, 700));
      }
      throw new Error('Kolibri took too long to start');
    })().catch((e) => { this.lastError = this.lastError || e.message; this.killChild(); throw e; }).finally(() => { this.starting = null; });
    this.starting.catch(() => {});
    return this.starting;
  }
  probe() {
    return new Promise((resolve) => {
      const r = http.get({ host: '127.0.0.1', port: this.port, path: PREFIX, timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode < 500); });
      r.on('error', () => resolve(false)); r.on('timeout', () => { r.destroy(); resolve(false); });
    });
  }
  killChild() { const c = this.child; this.child = null; this.up = false; if (c) { try { c.kill('SIGTERM'); } catch (e) { /* gone */ } setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }, 4000).unref(); } }
  async stop() { this.stopping = true; this.killChild(); await new Promise((r) => setTimeout(r, 50)); this.stopping = false; }
  async setShared(on) {                    // listen on all interfaces only while Wi-Fi sharing is on, so children can open it
    on = !!on; if (on === this.shared) return; this.shared = on;
    if (this.up || this.starting) { await this.stop(); this.start().catch(() => {}); } else if (on && this.installed()) this.start().catch(() => {});   // so a child can open it at once
  }
  info() { return this.installed() ? { port: this.port || 0, running: this.up, shared: this.shared } : null; }
  // Forward a request to Kolibri. The Host header is kept as the browser sent it so Django's CSRF origin check passes.
  proxy(req, res) {
    const page = (code, body) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '3' }); res.end(body); };
    const shell = (inner, refresh) => '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + (refresh ? '<meta http-equiv="refresh" content="3">' : '') + '<title>Kolibri</title>' +
      '<body style="font:16px system-ui;background:#0d0f14;color:#e9ebf1;padding:2rem;max-width:640px;margin:0 auto"><p><a style="color:#4aa3ff" href="/">&larr; Module Store</a></p>' + inner;
    if (!this.installed()) return page(404, shell('<h1>Kolibri is not installed</h1><p>Install it from the Module Store first.</p>'));
    if (!this.up) {
      const retry = /[?&]retry=1/.test(req.url);
      if (this.lastError && !this.starting && !retry) return page(500, shell('<h1>Kolibri could not start</h1><p style="color:#ff8a98">' + String(this.lastError).replace(/[<>&]/g, '') + '</p><p><a style="color:#4aa3ff" href="/learn/?retry=1">Try again</a></p>'));
      if (!this.starting) this.start().catch(() => {});
      return page(503, shell('<h1>Starting Kolibri&hellip;</h1><p style="color:#8b92a3">The first start sets up its database and can take a minute or two. This page refreshes by itself.</p>', true));
    }
    const headers = Object.assign({}, req.headers); delete headers.connection; delete headers['keep-alive']; delete headers['proxy-connection']; delete headers.upgrade;
    const up = http.request({ host: '127.0.0.1', port: this.port, method: req.method, path: req.url, headers }, (r) => {
      const h = Object.assign({}, r.headers); delete h.connection; delete h['transfer-encoding'];
      res.writeHead(r.statusCode, h); r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) page(502, shell('<h1>Kolibri is not answering</h1><p>It may have stopped. Reload this page to start it again.</p>')); else res.end(); });
    req.pipe(up);
  }
}
module.exports = { Kolibri, pythonOk, PREFIX };
