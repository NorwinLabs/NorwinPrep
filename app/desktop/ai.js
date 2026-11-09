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
    this.probePath = '/health'; this.chatPath = '/v1/chat/completions'; this.needsModel = true; this.vision = false;
  }
  // how to start the engine for `model` (Ollama overrides this)
  spawnSpec(model) {
    const args = ['-m', path.join(this.modelDir, model), '--host', '127.0.0.1', '--port', String(this.port), '-c', String(this.isEco() ? Math.min(this.o.ctx, 2048) : this.o.ctx)];
    if (this.isEco()) args.push('--threads', String(Math.max(1, Math.floor(this.o.cpus / 2))));
    return { cmd: this.binary(), args, env: this.baseEnv({ LD_LIBRARY_PATH: this.engineDir, DYLD_LIBRARY_PATH: this.engineDir }), cwd: this.engineDir };
  }
  baseEnv(extra) { return Object.assign({ PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR }, extra); }
  shape(body) { return body; }
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
      const model = this.active(); if (!model && this.needsModel) throw new Error('No AI model is installed yet.');
      this.model = model; this.port = await freePort();
      const sp = this.spawnSpec(model);
      const child = this.child = this.o.spawn(sp.cmd, sp.args, { env: sp.env, cwd: sp.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); this.log = '';
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
      const r = http.get({ host: '127.0.0.1', port: this.port, path: this.probePath, timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
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
      return readBody(3500000, (b) => {
        let j; try { j = JSON.parse(b); } catch (e) { return json(400, { error: 'invalid JSON' }); }
        const msgs = Array.isArray(j.messages) ? j.messages.slice(-40).filter((m) => m && ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string').map((m) => ({ role: m.role, content: m.content.slice(0, 16000) })) : [];
        if (!msgs.length) return json(400, { error: 'no messages' });
        // pictures (Ollama vision models only): up to 2 small JPEG/PNG/WebP data URLs, attached to the last question
        const images = Array.isArray(j.images) ? j.images.filter((u) => typeof u === 'string' && u.length <= 1500000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/]+=*$/.test(u)).slice(0, 2) : [];
        if (images.length && !this.vision) return json(400, { error: 'Pictures need an Ollama vision model (for example Gemma 3 4B). Install one from the Module Store and choose it here.' });
        const wantLib = j.library === true && typeof this.o.context === 'function';
        let sources = [];
        const body = this.shape({ messages: msgs, stream: j.stream !== false, temperature: Math.min(2, Math.max(0, Number(j.temperature) || 0.7)), max_tokens: Math.min(2048, Math.max(1, parseInt(j.max_tokens, 10) || 768)) });
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
          await withLibrary(); this.touch();
          if (images.length) { const at = body.messages.map((m) => m.role).lastIndexOf('user'); if (at >= 0) body.messages[at] = { role: 'user', content: [{ type: 'text', text: body.messages[at].content }].concat(images.map((u) => ({ type: 'image_url', image_url: { url: u } }))) }; }
          const payload = JSON.stringify(body);
          const up = http.request({ host: '127.0.0.1', port: this.port, method: 'POST', path: this.chatPath, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (r) => {
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

// ---------------------------------------------------------------------------------------------------------------------------------
// Ollama: the second engine. The app downloads Ollama itself (a module), runs `ollama serve` on loopback with its models kept in the library
// folder, pulls models from Ollama's own registry, and chats through the same allow-listed proxy as llama.cpp (Ollama answers the same
// OpenAI-style /v1/chat/completions). Nothing is installed system-wide; the user's own ~/.ollama is never touched.
const OLLAMA_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,60}(\/[a-z0-9][a-z0-9._-]{0,60})?:[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
// "qwen2.5:0.5b" -> <models>/manifests/registry.ollama.ai/library/qwen2.5/0.5b ; "someone/model:tag" -> .../someone/model/tag
function ollamaManifestPath(modelDir, name) {
  if (!OLLAMA_NAME_RE.test(name || '')) throw new Error('bad Ollama model name');
  const [repo, tag] = name.split(':'), parts = repo.includes('/') ? repo.split('/') : ['library', repo];
  return path.join(modelDir, 'manifests', 'registry.ollama.ai', ...parts, tag);
}
class OllamaEngine extends Llama {
  constructor(o) {
    super(o);
    this.engineDir = path.join(this.base, 'ollama'); this.modelDir = path.join(this.base, 'ollama-models');
    this.probePath = '/api/version'; this.needsModel = false; this.vision = true;
  }
  binary() {
    const exe = this.o.platform === 'win32' ? 'ollama.exe' : 'ollama', c = [path.join(this.engineDir, 'bin', exe), path.join(this.engineDir, exe)];
    return c.find((f) => fs.existsSync(f)) || c[0];
  }
  models() {                                   // every pulled model: manifests/<registry>/<namespace>/<name>/<tag>
    const out = [], root = path.join(this.modelDir, 'manifests', 'registry.ollama.ai');
    const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return []; } };
    for (const ns of dirs(root)) if (ns.isDirectory()) for (const nm of dirs(path.join(root, ns.name))) if (nm.isDirectory()) for (const tg of dirs(path.join(root, ns.name, nm.name))) {
      if (!tg.isFile()) continue; const n = (ns.name === 'library' ? '' : ns.name + '/') + nm.name + ':' + tg.name; if (OLLAMA_NAME_RE.test(n)) out.push(n);
    }
    return out.sort();
  }
  active() {
    let want = null; try { want = JSON.parse(fs.readFileSync(path.join(this.base, 'active.json'), 'utf8')).model; } catch (e) { /* none */ }
    const all = this.models(), w = typeof want === 'string' && want.startsWith('ollama:') ? want.slice(7) : null;
    return all.includes(w) ? w : (all[0] || null);
  }
  spawnSpec() {
    fs.mkdirSync(this.modelDir, { recursive: true });
    const env = this.baseEnv({ OLLAMA_HOST: '127.0.0.1:' + this.port, OLLAMA_MODELS: this.modelDir, OLLAMA_KEEP_ALIVE: '10m', OLLAMA_NOPRUNE: '1', OLLAMA_NO_CLOUD: '1', OLLAMA_CONTEXT_LENGTH: String(this.isEco() ? Math.min(this.o.ctx, 2048) : this.o.ctx), LD_LIBRARY_PATH: path.join(this.engineDir, 'lib', 'ollama'), OLLAMA_ORIGINS: 'http://127.0.0.1' });
    if (this.isEco()) env.OLLAMA_NUM_PARALLEL = '1';
    return { cmd: this.binary(), args: ['serve'], env, cwd: this.engineDir };
  }
  shape(body) { body.model = this.active(); return body; }
  // download a model from Ollama's registry (the engine does the work: resumable, checksummed). onProgress({percent, message}).
  async pull(name, onProgress) {
    if (!OLLAMA_NAME_RE.test(name || '')) throw new Error('bad Ollama model name');
    if (!this.engineInstalled()) throw new Error('The Ollama engine is not installed.');
    await this.start(); this.touch();
    await new Promise((resolve, reject) => {
      const payload = JSON.stringify({ model: name, stream: true }), layers = {}; let last = '', done = false;
      const q = http.request({ host: '127.0.0.1', port: this.port, method: 'POST', path: '/api/pull', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (r) => {
        let buf = '';
        const line = (ln) => {
          if (!ln.trim()) return; let j; try { j = JSON.parse(ln); } catch (e) { return; }
          this.touch();
          if (j.error) { done = true; return reject(new Error(String(j.error).slice(0, 300))); }
          if (j.digest && j.total) layers[j.digest] = { t: Number(j.total), c: Number(j.completed || 0) };
          const t = Object.values(layers).reduce((a, x) => a + x.t, 0), c = Object.values(layers).reduce((a, x) => a + x.c, 0);
          last = j.status || last;
          if (onProgress) onProgress({ percent: t ? Math.min(99, Math.floor(c / t * 100)) : 0, message: t ? name + ': ' + Math.round(c / 1048576) + ' of ' + Math.round(t / 1048576) + ' MB' : name + ': ' + (j.status || 'starting') });
          if (j.status === 'success') { done = true; resolve(); }
        };
        r.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { line(buf.slice(0, k)); buf = buf.slice(k + 1); } });
        r.on('end', () => { line(buf); if (!done) reject(new Error(r.statusCode === 200 ? 'Ollama stopped before the download finished (' + last + ')' : 'Ollama answered HTTP ' + r.statusCode)); });
      });
      q.on('error', (e) => reject(new Error('Could not reach Ollama: ' + e.message))); q.end(payload);
    });
    if (!this.models().includes(name)) throw new Error('Ollama did not keep the model ' + name);
  }
  async removeModel(name) {
    if (!OLLAMA_NAME_RE.test(name || '')) throw new Error('bad Ollama model name');
    try {
      if (!this.engineInstalled()) throw new Error('no engine');
      await this.start();
      await new Promise((resolve, reject) => { const payload = JSON.stringify({ model: name }), q = http.request({ host: '127.0.0.1', port: this.port, method: 'DELETE', path: '/api/delete', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (r) => { r.resume(); r.on('end', () => (r.statusCode < 300 ? resolve() : reject(new Error('HTTP ' + r.statusCode)))); }); q.on('error', reject); q.end(payload); });
    } catch (e) { /* engine unavailable: drop the manifest so the model is gone from the app; blobs are cleaned by Ollama later */ }
    try { fs.unlinkSync(ollamaManifestPath(this.modelDir, name)); } catch (e) { /* already gone */ }
  }
}

// One front for both engines. Model names from Ollama are shown as "ollama:<name>"; .gguf files belong to llama.cpp. Same handle() contract.
class Hub {
  constructor(o) { this.o = o; this.llama = new Llama(o); this.ollama = new OllamaEngine(o); this.base = this.llama.base; }
  want() { try { return JSON.parse(fs.readFileSync(path.join(this.base, 'active.json'), 'utf8')).model; } catch (e) { return null; } }
  usable(b) { return b.engineInstalled() && b.models().length > 0; }
  current() {
    const w = this.want(), order = typeof w === 'string' && w.startsWith('ollama:') ? [this.ollama, this.llama] : [this.llama, this.ollama];
    return order.find((b) => this.usable(b)) || this.llama;
  }
  engineInstalled() { return this.llama.engineInstalled() || this.ollama.engineInstalled(); }
  models() { return this.llama.models().concat(this.ollama.models().map((n) => 'ollama:' + n)); }
  active() { const c = this.current(), a = c.active(); return a ? (c === this.ollama ? 'ollama:' + a : a) : null; }
  get up() { return this.llama.up || this.ollama.up; }
  status() {
    const c = this.current(), s = c.status();
    return { engine: this.engineInstalled(), engines: { llama: this.llama.engineInstalled(), ollama: this.ollama.engineInstalled() }, models: this.models(), active: this.active(), running: this.llama.up || this.ollama.up, starting: !!(this.llama.starting || this.ollama.starting), error: s.error };
  }
  async select(m) {
    const ok = typeof m === 'string' && (m.startsWith('ollama:') ? this.ollama.models().includes(m.slice(7)) : MODEL_RE.test(m) && this.llama.models().includes(m));
    if (!ok) throw Object.assign(new Error('That model is not installed.'), { code: 404 });
    const was = this.up || this.llama.starting || this.ollama.starting;
    fs.mkdirSync(this.base, { recursive: true }); fs.writeFileSync(path.join(this.base, 'active.json'), JSON.stringify({ model: m }));
    if (was) { await this.stop(); this.current().start().catch(() => {}); }
  }
  async stop() { await Promise.all([this.llama.stop(), this.ollama.stop()]); }
  handle(req, res, route, local) {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (route === '/status' && req.method === 'GET') return json(200, Object.assign(this.status(), { canSelect: !!local }));
    if (route === '/chat' && req.method === 'POST') return this.current().handle(req, res, route, local);
    if (route === '/select' && req.method === 'POST') {
      if (!local) return json(403, { error: 'Only the owner of this device can switch models.' });
      let b = '', over = false; req.on('data', (c) => { b += c; if (b.length > 2048 && !over) { over = true; req.destroy(); } });
      return req.on('end', () => { if (over) return; let m; try { m = JSON.parse(b).model; } catch (e) { return json(400, { error: 'invalid JSON' }); } this.select(String(m)).then(() => json(200, Object.assign(this.status(), { canSelect: true })), (e) => json(e.code || 500, { error: e.message })); });
    }
    return json(404, { error: 'Not found' });
  }
}
module.exports = { Llama, OllamaEngine, Hub, MODEL_RE, OLLAMA_NAME_RE, ollamaManifestPath };
