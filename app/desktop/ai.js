'use strict';
// Offline AI assistant: runs llama.cpp's `llama-server` (CPU) on loopback with one downloaded GGUF model, and lets the app's pages talk to it
// through a small allow-list (chat, model list, health). Started on first use, stopped after a quiet spell to free memory.
// Only chat requests are forwarded, rebuilt from a fixed set of fields, so nothing else of llama-server's API is reachable.
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.gguf$/;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

class Llama {
  constructor(o) {   // o: dataDir (library folder), platform, spawn, idleMs, startTimeout, ctx
    this.o = Object.assign({ platform: process.platform, spawn, idleMs: 15 * 60000, startTimeout: 180000, ctx: 4096, eco: () => false, cpus: os.cpus().length }, o);
    this.base = path.join(this.o.dataDir, 'ai'); this.engineDir = path.join(this.base, 'engine'); this.modelDir = path.join(this.base, 'models');
    this.child = null; this.port = 0; this.up = false; this.starting = null; this.lastError = ''; this.model = null; this.idle = null; this.log = '';
  }
  binary() { return path.join(this.engineDir, this.o.platform === 'win32' ? 'llama-server.exe' : 'llama-server'); }
  engineInstalled() { return fs.existsSync(this.binary()); }
  models() { try { return fs.readdirSync(this.modelDir).filter((f) => MODEL_RE.test(f)).sort(); } catch (e) { return []; } }
  active() {
    let want = null; try { want = JSON.parse(fs.readFileSync(path.join(this.base, 'active.json'), 'utf8')).model; } catch (e) { /* none */ }
    const all = this.models(); return all.includes(want) ? want : (all[0] || null);
  }
  async select(file) {
    if (!MODEL_RE.test(file || '') || !this.models().includes(file)) throw Object.assign(new Error('That model is not installed.'), { code: 404 });
    fs.mkdirSync(this.base, { recursive: true }); fs.writeFileSync(path.join(this.base, 'active.json'), JSON.stringify({ model: file }));
    if (this.up || this.starting) { await this.stop(); this.start().catch(() => {}); }
  }
  status() {
    return { engine: this.engineInstalled(), models: this.models(), active: this.active(), running: this.up, starting: !!this.starting, error: this.starting ? '' : this.lastError };
  }
  touch() { clearTimeout(this.idle); const eco = this.isEco(); this.idle = setTimeout(() => { this.stop().catch(() => {}); }, eco ? Math.min(this.o.idleMs, 5 * 60000) : this.o.idleMs); if (this.idle.unref) this.idle.unref(); }
  isEco() { try { return !!this.o.eco(); } catch (e) { return false; } }   // eco: on battery power, use fewer CPU threads, a smaller context and stop sooner
  start() {
    if (this.up) return Promise.resolve(true);
    if (this.starting) return this.starting;
    this.lastError = '';
    this.starting = (async () => {
      if (!this.engineInstalled()) throw new Error('The AI engine is not installed.');
      const model = this.active(); if (!model) throw new Error('No AI model is installed yet.');
      this.model = model; this.port = await freePort();
      const env = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR, LD_LIBRARY_PATH: this.engineDir, DYLD_LIBRARY_PATH: this.engineDir };
      const args = ['-m', path.join(this.modelDir, model), '--host', '127.0.0.1', '--port', String(this.port), '-c', String(this.isEco() ? Math.min(this.o.ctx, 2048) : this.o.ctx)];
      if (this.isEco()) args.push('--threads', String(Math.max(1, Math.floor(this.o.cpus / 2))));
      const child = this.child = this.o.spawn(this.binary(), args, { env, cwd: this.engineDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); this.log = '';
      const keep = (d) => { this.log = (this.log + d).slice(-4000); };
      child.stdout && child.stdout.on('data', keep); child.stderr && child.stderr.on('data', keep);
      child.on('exit', (code) => { if (this.child === child) { this.child = null; this.up = false; if (!this.stopping) this.lastError = 'The AI engine stopped (exit ' + code + '). ' + (this.log.trim().split('\n').pop() || '').slice(0, 200); } });
      child.on('error', (e) => { this.lastError = 'Could not start the AI engine: ' + e.message; });
      const t0 = Date.now();
      while (Date.now() - t0 < this.o.startTimeout) {
        if (!this.child || this.child !== child) throw new Error(this.lastError || 'The AI engine did not start');
        if (await this.probe()) { this.up = true; this.touch(); return true; }
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error('The AI engine took too long to load the model');
    })().catch((e) => { this.lastError = this.lastError || e.message; this.killChild(); throw e; }).finally(() => { this.starting = null; });
    this.starting.catch(() => {});
    return this.starting;
  }
  probe() {
    return new Promise((resolve) => {
      const r = http.get({ host: '127.0.0.1', port: this.port, path: '/health', timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
      r.on('error', () => resolve(false)); r.on('timeout', () => { r.destroy(); resolve(false); });
    });
  }
  killChild() { const c = this.child; this.child = null; this.up = false; if (c) { try { c.kill('SIGTERM'); } catch (e) { /* gone */ } setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }, 4000).unref(); } }
  async stop() { clearTimeout(this.idle); this.stopping = true; this.killChild(); await new Promise((r) => setTimeout(r, 50)); this.stopping = false; }

  // Handles /ai/api/* . `local` is true on the app's own page (which may also switch models); false for devices on the Wi-Fi share.
  handle(req, res, route, local) {
    const json = (code, obj, h) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, h || {})); res.end(JSON.stringify(obj)); };
    const readBody = (max, cb) => { let b = ''; let over = false; req.on('data', (c) => { b += c; if (b.length > max && !over) { over = true; req.destroy(); } }); req.on('end', () => { if (!over) cb(b); }); };
    if (route === '/status' && req.method === 'GET') return json(200, Object.assign(this.status(), { canSelect: !!local }));
    if (route === '/select' && req.method === 'POST') {
      if (!local) return json(403, { error: 'Only the owner of this device can switch models.' });
      return readBody(2048, (b) => { let m; try { m = JSON.parse(b).model; } catch (e) { return json(400, { error: 'invalid JSON' }); } this.select(String(m)).then(() => json(200, this.status()), (e) => json(e.code || 500, { error: e.message })); });
    }
    if (route === '/chat' && req.method === 'POST') {
      return readBody(262144, (b) => {
        let j; try { j = JSON.parse(b); } catch (e) { return json(400, { error: 'invalid JSON' }); }
        const msgs = Array.isArray(j.messages) ? j.messages.slice(-40).filter((m) => m && ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string').map((m) => ({ role: m.role, content: m.content.slice(0, 16000) })) : [];
        if (!msgs.length) return json(400, { error: 'no messages' });
        const wantLib = j.library === true && typeof this.o.context === 'function';
        let sources = [];
        const body = { messages: msgs, stream: j.stream !== false, temperature: Math.min(2, Math.max(0, Number(j.temperature) || 0.7)), max_tokens: Math.min(2048, Math.max(1, parseInt(j.max_tokens, 10) || 768)) };
        const withLibrary = async () => {                        // let the model read the installed library: the best matching pages go in as a system note
          if (!wantLib) return;
          const q = [...msgs].reverse().find((m) => m.role === 'user'); if (!q) return;
          try {
            const c = await Promise.race([this.o.context(q.content, this.isEco()), new Promise((r) => setTimeout(() => r(null), 9000))]);
            if (c && c.text) {
              sources = c.sources || [];
              const note = { role: 'system', content: 'Excerpts from the user\'s offline library follow. Answer from them when they are relevant, name the page you used in [brackets], and say so if they do not cover the question. Do not invent facts that are not in them.\n\n' + c.text };
              const at = msgs.findIndex((m) => m.role !== 'system'); body.messages = msgs.slice(0, at < 0 ? msgs.length : at).concat([note], msgs.slice(at < 0 ? msgs.length : at));
            }
          } catch (e) { /* no library: answer without it */ }
        };
        const go = async () => {
          await withLibrary(); this.touch(); const payload = JSON.stringify(body);
          const up = http.request({ host: '127.0.0.1', port: this.port, method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (r) => {
            res.writeHead(r.statusCode, Object.assign({ 'Content-Type': r.headers['content-type'] || 'application/json', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }, sources.length ? { 'X-Library-Sources': encodeURIComponent(JSON.stringify(sources.slice(0, 5).map((s) => ({ title: String(s.title).slice(0, 80), url: s.url })))).slice(0, 1500) } : {})); r.pipe(res);
            r.on('data', () => this.touch());
          });
          up.on('error', () => { if (!res.headersSent) json(502, { error: 'The AI engine is not answering.' }); else res.end(); });
          res.on('close', () => up.destroy());
          up.end(payload);
        };
        if (this.up) return go();
        if (!this.engineInstalled() || !this.active()) return json(409, { error: !this.engineInstalled() ? 'The AI engine is not installed.' : 'No AI model is installed yet.' });
        this.start().then(go, (e) => json(503, { error: e.message }));
      });
    }
    return json(404, { error: 'Not found' });
  }
}
module.exports = { Llama, MODEL_RE };
