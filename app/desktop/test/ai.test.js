'use strict';
// Run: node test/ai.test.js. Fake llama-server, fake GitHub release and fake Hugging Face; no network, no real model.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { Llama } = require('../ai');
const { create, createShare } = require('../local-server');
const { Manager } = require('../modules-manager');
const { F, server, GGUF } = require('./fixtures');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL ' + m); } else console.log('ok   ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAKE = path.join(__dirname, 'fake-llama-server.js');
const req = (port, p, o) => new Promise((res, rej) => { const q = http.request(Object.assign({ host: '127.0.0.1', port, path: p, method: 'GET' }, o || {}), (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res({ code: r.statusCode, body: d, h: r.headers })); }); q.on('error', rej); if (o && o.body) q.write(o.body); q.end(); });
const chat = (port, body, extra) => req(port, '/ai/api/chat', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, extra || {}), body: JSON.stringify(body) });
function setup(models) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'npai-')); fs.mkdirSync(path.join(d, 'ai', 'engine'), { recursive: true }); fs.mkdirSync(path.join(d, 'ai', 'models'), { recursive: true });
  fs.copyFileSync(FAKE, path.join(d, 'ai', 'engine', 'llama-server')); fs.chmodSync(path.join(d, 'ai', 'engine', 'llama-server'), 0o755); for (const m of models) fs.writeFileSync(path.join(d, 'ai', 'models', m), 'GGUF'); return d; }

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // ---------- status, models ----------
  const empty = new Llama({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'npai0-')) });
  ok(!empty.status().engine && empty.status().models.length === 0 && empty.active() === null, 'nothing installed: no engine, no models');
  const data = setup(['b-model.gguf', 'a-model.gguf', 'notes.txt', '../x.gguf']); let ai = new Llama({ dataDir: data, idleMs: 600 });
  ok(JSON.stringify(ai.models()) === '["a-model.gguf","b-model.gguf"]' && ai.active() === 'a-model.gguf', 'lists only .gguf files, first one is active by default');
  let err; try { await ai.select('../../etc/passwd'); } catch (e) { err = e; } ok(err && err.code === 404, 'a path-like model name is refused');
  try { err = null; await ai.select('nope.gguf'); } catch (e) { err = e; } ok(err && err.code === 404, 'a model that is not installed is refused');
  await ai.select('b-model.gguf'); ok(ai.active() === 'b-model.gguf' && JSON.parse(fs.readFileSync(path.join(data, 'ai', 'active.json'))).model === 'b-model.gguf', 'the chosen model is remembered');

  // ---------- through the app's own server ----------
  const app = create({ siteDir: data, filesDir: data, getName: () => 'x', setName: () => {}, version: '1', platform: 'linux', ai }); const port = await app.start(0);
  let g = await req(port, '/ai/api/status'); ok(g.code === 200 && JSON.parse(g.body).canSelect === true && !JSON.parse(g.body).running, 'status: not running until asked, and the owner may switch models');
  const t0 = Date.now(); g = await chat(port, { messages: [{ role: 'user', content: 'hello' }] });
  ok(g.code === 200 && /MODEL=b-model\.gguf HOST=127\.0\.0\.1 /.test(g.body) && /data: \[DONE\]/.test(g.body), 'first question starts the engine on loopback with the chosen model and streams the answer (' + (Date.now() - t0) + ' ms)');
  g = await chat(port, { messages: [{ role: 'system', content: 'sys' }, { role: 'tool', content: 'x' }, { role: 'user', content: 'q'.repeat(20000) }, { role: 'user', content: 5 }], max_tokens: 999999, temperature: 99, grammar: 'root ::= "evil"', n_predict: 1e9, stop: ['x'], model: '../../etc/passwd', cache_prompt: true });
  const body = JSON.parse(JSON.parse(g.body.split('data: ').filter((x) => /BODY=/.test(x)).map((x) => x.trim())[0]).choices[0].delta.content.replace(/^BODY=/, ''));
  ok(Object.keys(body).sort().join() === 'max_tokens,messages,stream,temperature' && body.max_tokens === 2048 && body.temperature === 2, 'only chat fields are forwarded; max_tokens and temperature are clamped (grammar, model, n_predict... are dropped)');
  ok(body.messages.length === 2 && body.messages[0].role === 'system' && body.messages[1].content.length === 16000, 'bad roles / non-text messages are dropped and long messages are cut');
  g = await chat(port, { messages: [] }); ok(g.code === 400, 'an empty conversation is a 400');
  g = await chat(port, { messages: [{ role: 'user', content: 'x' }] }, { Origin: 'http://evil.example' }); ok(g.code === 403, 'a chat request from another website is refused');
  g = await req(port, '/ai/api/select', { method: 'POST', body: JSON.stringify({ model: 'a-model.gguf' }) }); ok(g.code === 403, 'switching models needs the app header');
  g = await req(port, '/ai/api/select', { method: 'POST', headers: { 'X-NorwinPrep': '1' }, body: JSON.stringify({ model: 'a-model.gguf' }) }); ok(g.code === 200 && JSON.parse(g.body).active === 'a-model.gguf', 'the owner can switch models');
  for (let i = 0; i < 60 && !ai.up; i++) await sleep(100); g = await chat(port, { messages: [{ role: 'user', content: 'again' }] }); ok(/MODEL=a-model\.gguf/.test(g.body), 'a running engine is restarted on the new model');
  g = await req(port, '/ai/api/v1/models'); ok(g.code === 404, 'llama-server\'s other endpoints are not reachable (404)');
  g = await req(port, '/ai/api/props', { method: 'POST', body: '{}' }); ok(g.code === 404, '...nor with POST');
  ok(ai.up, 'still running'); await sleep(1100); ok(!ai.up, 'it stops by itself after a quiet spell to free memory');

  // ---------- engine problems are explained ----------
  const crashData = setup(['m.gguf']); fs.writeFileSync(path.join(crashData, 'ai', 'engine', 'llama-server'), '#!/bin/sh\necho "error: failed to load model" >&2\nexit 3\n', { mode: 0o755 }); const bad = new Llama({ dataDir: crashData, startTimeout: 5000 });
  const app2 = create({ siteDir: crashData, filesDir: crashData, getName: () => 'x', setName: () => {}, version: '1', platform: 'linux', ai: bad }); const port2 = await app2.start(0);
  g = await chat(port2, { messages: [{ role: 'user', content: 'x' }] }); ok(g.code === 503 && /stopped|failed to load|did not start/i.test(JSON.parse(g.body).error), 'an engine that crashes gives a clear 503: ' + JSON.parse(g.body).error.slice(0, 70));
  g = await chat((await create({ siteDir: data, filesDir: data, getName: () => 'x', setName: () => {}, version: '1', platform: 'linux', ai: new Llama({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'npai1-')) }) }).start(0)), { messages: [{ role: 'user', content: 'x' }] });
  ok(g.code === 409 && /not installed/.test(JSON.parse(g.body).error), 'no engine: 409 "not installed"'); await app2.stop();

  // ---------- devices on the Wi-Fi share: chat yes, anything else no ----------
  fs.mkdirSync(path.join(data, 'ai-site'), { recursive: true }); const site = fs.mkdtempSync(path.join(os.tmpdir(), 'npaisite-')); fs.mkdirSync(path.join(site, 'ai')); fs.writeFileSync(path.join(site, 'ai', 'index.html'), '<title>CHAT</title>'); fs.writeFileSync(path.join(site, 'portal.html'), '<title>PORTAL</title>');
  const ai2 = new Llama({ dataDir: data, idleMs: 60000 });
  const sh = createShare({ siteDir: site, mapsDir: data, appsDir: data, reader: null, getName: () => 'x', version: '1', ai: ai2 }); const sp = await sh.start([0], '127.0.0.1');
  g = await req(sp, '/ai/'); ok(g.code === 200 && /CHAT/.test(g.body), 'the chat page is served to devices that join');
  g = await req(sp, '/api/device'); ok(JSON.parse(g.body).ai.ready === true, 'the landing page is told the assistant is ready');
  g = await chat(sp, { messages: [{ role: 'user', content: 'hi from a child device' }] }); ok(g.code === 200 && /MODEL=/.test(g.body), 'a joined device can chat');
  g = await req(sp, '/ai/api/status'); ok(g.code === 200 && JSON.parse(g.body).canSelect === false, 'but it cannot switch models');
  g = await req(sp, '/ai/api/select', { method: 'POST', body: '{"model":"a-model.gguf"}' }); ok(g.code === 405 || g.code === 403, 'switching models is refused for them (' + g.code + ')');
  g = await req(sp, '/ai/api/v1/models'); ok(g.code === 404, 'llama-server\'s own API is not exposed to them');
  g = await chat(sp, { messages: [{ role: 'user', content: 'x' }] }, { Origin: 'http://evil.example' }); ok(g.code === 403, 'a chat POST from another website is refused on the share too');
  await ai2.stop(); await sh.stop();

  // ---------- installing: engine + model through the store's manager ----------
  const b = 'http://127.0.0.1:' + server.address().port;
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'npaimgr-')); let stops = 0;
  const mk = (over) => new Manager(Object.assign({ catalog: path.join(__dirname, '..', '..', 'shared', 'site', 'catalog.json'), dataDir: lib, githubApi: b, githubDl: b, hf: b, kiwix: b, pypi: b, platform: 'linux', arch: 'x64', timeout: 5000, ramBytes: 4 * 1073741824, onAiChange: async () => { stops++; } }, over));
  let mgr = mk(); const done = async (id) => { for (let i = 0; i < 400; i++) { const j = mgr.jobs[id]; if (j && (j.state === 'done' || j.state === 'error')) return j; await sleep(40); } throw new Error('timeout ' + id); };
  let r = await mgr.handle('GET', '/info', new URLSearchParams('id=qwen25-05b'), null); ok(r.code === 200 && r.body.bytes === GGUF.length && r.body.version === 'Q4_K_M' && /Wants about 1 GB/.test(r.body.note) && !/too little/.test(r.body.note), 'model info: real size and the memory it wants');
  { const small = mk({ ramBytes: 0.5 * 1073741824 }); r = await small.handle('GET', '/info', new URLSearchParams('id=qwen25-05b'), null); ok(r.code === 200 && /probably too little/.test(r.body.note), 'on a computer with too little memory the dialog says so: ' + r.body.note.slice(0, 90)); }
  r = await mgr.handle('GET', '/info', new URLSearchParams('id=ai-engine'), null); ok(r.code === 200 && r.body.file === 'llama-b9999-bin-ubuntu-x64.tar.gz', 'engine info: picks the plain CPU Linux x64 build from the newest build release (a pre-release, after the nightly stub), not Vulkan/CUDA: ' + (r.body.file || r.body.error));
  for (const [plat, arch, want] of [['win32', 'x64', 'llama-b9999-bin-win-cpu-x64.zip'], ['darwin', 'arm64', 'llama-b9999-bin-macos-arm64.tar.gz'], ['linux', 'arm64', 'llama-b9999-bin-ubuntu-arm64.tar.gz']]) { const m2 = mk({ platform: plat, arch }); const x = await m2.handle('GET', '/info', new URLSearchParams('id=ai-engine'), null); ok(x.code === 200 && x.body.file === want, plat + ' ' + arch + ' gets ' + want + ' (' + (x.body.file || x.body.error) + ')'); }
  { const m2 = mk({ arch: 'arm' }); const x = await m2.handle('GET', '/info', new URLSearchParams('id=ai-engine'), null); ok(x.code === 412 && /no ready-made AI engine/i.test(x.body.error), 'a 32-bit Raspberry Pi (no build exists) gets a clear message: ' + x.body.error.slice(0, 80)); }
  mgr.enqueue('qwen25-05b', 'install'); let j = await done('qwen25-05b');
  ok(j.state === 'done' && fs.readFileSync(path.join(lib, 'ai', 'models', 'qwen2.5-0.5b-instruct-q4_k_m.gguf')).equals(GGUF), 'installing a model also installs the engine first, then the model (byte-identical): ' + j.message);
  ok(fs.existsSync(path.join(lib, 'ai', 'engine', 'llama-server')) && fs.existsSync(path.join(lib, 'ai', 'engine', 'libggml.so')) && (fs.statSync(path.join(lib, 'ai', 'engine', 'llama-server')).mode & 0o111) !== 0, 'the engine and its libraries are unpacked and the program is executable');
  let it = mgr.catalog().find((m) => m.id === 'qwen25-05b'); ok(it.installed && it.category === 'ai' && it.open === '/ai/' && it.minRamGB === 1 && it.type === 'model', 'the store sees it: installed, in AI, Open goes to the chat page');
  it = mgr.catalog().find((m) => m.id === 'ai-engine'); ok(it.installed && it.version === 'b9999', 'and the engine, version b9999');
  const live = new Llama({ dataDir: lib }); const app3 = create({ siteDir: site, filesDir: lib, getName: () => 'x', setName: () => {}, version: '1', platform: 'linux', ai: live }); const p3 = await app3.start(0);
  g = await chat(p3, { messages: [{ role: 'user', content: 'does the installed engine run?' }] }); ok(g.code === 200 && /MODEL=qwen2\.5-0\.5b-instruct-q4_k_m\.gguf/.test(g.body), 'the engine the store installed actually runs the model it installed'); await live.stop(); await app3.stop();
  mgr.enqueue('qwen25-05b', 'remove'); j = await done('qwen25-05b'); ok(j.state === 'done' && !fs.existsSync(path.join(lib, 'ai', 'models', 'qwen2.5-0.5b-instruct-q4_k_m.gguf')) && stops >= 1, 'removing a model deletes the file (and stops the engine)');
  F.ggufSha = 'bad'; mgr = mk(); mgr.enqueue('qwen25-05b', 'install'); j = await done('qwen25-05b'); ok(j.state === 'error' && /checksum|corrupt/i.test(j.message) && !fs.existsSync(path.join(lib, 'ai', 'models', 'qwen2.5-0.5b-instruct-q4_k_m.gguf')), 'a model whose SHA-256 does not match Hugging Face\'s record is rejected: ' + j.message);
  F.ggufSha = 'nolfs'; mgr = mk(); mgr.enqueue('qwen25-05b', 'install'); j = await done('qwen25-05b'); ok(j.state === 'error' && /no checksum/i.test(j.message), 'a file with no published checksum is refused');
  F.ggufSha = 'ok'; F.llamaSha = 'bad'; const lib2 = fs.mkdtempSync(path.join(os.tmpdir(), 'npaimgr2-')); mgr = mk({ dataDir: lib2 }); mgr.enqueue('ai-engine', 'install'); j = await done('ai-engine'); ok(j.state === 'error' && /checksum|corrupt/i.test(j.message) && !fs.existsSync(path.join(lib2, 'ai', 'engine')), 'an engine download that fails its GitHub digest is rejected');
  F.llamaSha = 'ok'; mgr.enqueue('ai-engine', 'install'); j = await done('ai-engine'); ok(j.state === 'done', 'and installs cleanly when the digest matches'); mgr.enqueue('ai-engine', 'remove'); j = await done('ai-engine'); ok(j.state === 'done' && !fs.existsSync(path.join(lib2, 'ai', 'engine')), 'engine removal');

  server.close(); await app.stop(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
