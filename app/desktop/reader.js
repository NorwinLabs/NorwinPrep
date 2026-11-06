'use strict';
// Runs the Kiwix reader (kiwix-serve) on a private loopback port and proxies /wiki/ to it, so content packs show inside the app.
// kiwix-serve only reads the packs it is started with, so the reader is restarted whenever packs are added or removed.
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

class Reader {
  constructor(o) {         // o: binDir (where kiwix-serve lives), zimDir, platform, spawnFn (tests)
    this.o = Object.assign({ platform: process.platform, spawnFn: spawn }, o);
    this.child = null; this.port = 0; this.up = false; this.chain = Promise.resolve(); this.generation = 0; this.lastError = ''; this.log = '';
  }
  bin() { return path.join(this.o.binDir, this.o.platform === 'win32' ? 'kiwix-serve.exe' : 'kiwix-serve'); }
  zims() { try { return fs.readdirSync(this.o.zimDir).filter((f) => /\.zim$/i.test(f) && !f.startsWith('.')).sort().map((f) => path.join(this.o.zimDir, f)); } catch (e) { return []; } }
  ready() { return this.up; }
  // (re)start with whatever packs exist now. Resolves true when the reader is serving, or when there is nothing to serve.
  restart() {
    const run = this.chain.then(() => this._restart(), () => this._restart());
    this.chain = run.catch(() => {});
    return run;
  }
  async _restart() {
    await this._stopNow(); this.lastError = ''; this.log = '';
    const zims = this.zims();
    if (!zims.length) return true;                      // nothing to show yet
    if (!fs.existsSync(this.bin())) { this.lastError = 'The reader program is not installed (' + this.bin() + ').'; return false; }       // reader not installed yet
    this.port = await freePort();
    const gen = ++this.generation;
    const child = this.o.spawnFn(this.bin(), ['--port', String(this.port), '--address', '127.0.0.1', '--urlRootLocation', '/wiki'].concat(zims), { stdio: ['ignore', 'pipe', 'pipe'], cwd: this.o.binDir, windowsHide: true });
    this.child = child;
    let exited = false;
    const keep = (d) => { this.log = (this.log + d).slice(-1500); };
    if (child.stdout) child.stdout.on('data', keep); if (child.stderr) child.stderr.on('data', keep);
    child.on('error', (e) => { exited = true; this.lastError = 'The reader could not start: ' + e.message; });
    child.on('exit', (code) => { exited = true; if (!this.lastError) this.lastError = 'The reader stopped right away (exit code ' + code + '). ' + (this.log.trim().split('\n').pop() || '').slice(0, 200); if (gen === this.generation) { this.up = false; this.child = null; } });
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {                   // wait until it answers
      if (exited) return false;
      if (await probe(this.port)) { this.up = true; return true; }
      await new Promise((r) => setTimeout(r, 150));
    }
    this.lastError = this.lastError || 'The reader did not answer within 15 seconds. ' + (this.log.trim().split('\n').pop() || '').slice(0, 200); await this._stopNow(); return false;
  }
  async _stopNow() {
    const c = this.child; this.up = false; this.generation++; this.child = null;
    if (!c || c.exitCode !== null) return;
    await new Promise((resolve) => { const t = setTimeout(resolve, 3000); c.once('exit', () => { clearTimeout(t); resolve(); }); try { c.kill(); } catch (e) { resolve(); } });
  }
  stop() { this.chain = this.chain.then(() => this._stopNow(), () => this._stopNow()); return this.chain; }
  // Forwards /wiki/ to kiwix-serve. Kiwix's own pages have no way back to NorwinPrep, so every top-level HTML page gets a small
  // "Exit" button (bottom-left, leaves to the home screen). Inside Kiwix's content frames it is hidden so it appears once.
  proxy(req, res) {
    const headers = Object.assign({}, req.headers, { host: '127.0.0.1:' + this.port }); delete headers.connection; delete headers['accept-encoding'];   // plain text, so pages can be edited on the way through
    const up = http.request({ host: '127.0.0.1', port: this.port, path: req.url, method: req.method, headers }, (r) => {
      const type = String(r.headers['content-type'] || '');
      if (!/^text\/html/i.test(type) || req.method === 'HEAD') { res.writeHead(r.statusCode, r.headers); return void r.pipe(res); }
      const chunks = []; let size = 0;
      r.on('data', (c) => { chunks.push(c); size += c.length; });
      r.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf8');
        if (size < 8000000) { const at = html.lastIndexOf('</body>'); html = at >= 0 ? html.slice(0, at) + EXIT_BUTTON + html.slice(at) : html + EXIT_BUTTON; }
        const h = Object.assign({}, r.headers); delete h['content-length']; delete h['content-encoding']; delete h['transfer-encoding'];
        res.writeHead(r.statusCode, Object.assign(h, { 'Content-Length': Buffer.byteLength(html) })); res.end(html);
      });
    });
    up.on('error', () => { if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); } res.end('The reader is not responding'); });
    req.pipe(up);
  }
}
const EXIT_BUTTON = '<a id="np-exit" href="/" target="_top" title="Leave the library and go back to NorwinPrep" style="position:fixed;left:12px;bottom:12px;z-index:2147483647;display:flex;align-items:center;gap:6px;padding:9px 16px;border-radius:999px;background:#0d0f14;color:#fff;border:1px solid #6b7488;font:600 14px system-ui,-apple-system,Segoe UI,sans-serif;text-decoration:none;box-shadow:0 4px 16px rgba(0,0,0,.45)">&#10005; Exit</a><script>try{if(window.top!==window.self){var e=document.getElementById("np-exit");if(e)e.remove()}}catch(x){}</script>';
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
function probe(port) { return new Promise((resolve) => { const r = http.get({ host: '127.0.0.1', port, path: '/wiki/', timeout: 800 }, (res) => { res.resume(); resolve(res.statusCode < 500); }); r.on('error', () => resolve(false)); r.on('timeout', () => { r.destroy(); resolve(false); }); }); }

module.exports = { Reader };
