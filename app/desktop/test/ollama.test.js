'use strict';
// Run: node test/ollama.test.js. Ollama as a second AI engine: release/asset choice, installing the engine and a model, pulling with progress,
// chatting (also while "reading the library"), switching between llama.cpp and Ollama models, removing. Fake Ollama + fake GitHub; no network.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { Hub, OllamaEngine, Llama } = require('../ai');
const { create } = require('../local-server');
const { Manager } = require('../modules-manager');
const { merged } = require('./catalog-merged');
const { F, server, OLLAMA_LINUX, HAS_ZSTD } = require('./fixtures');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL ' + m); } else console.log('ok   ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = (port, p, o) => new Promise((res, rej) => { const q = http.request(Object.assign({ host: '127.0.0.1', port, path: p, method: 'GET' }, o || {}), (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res({ code: r.statusCode, body: d, h: r.headers })); }); q.on('error', rej); if (o && o.body) q.write(o.body); q.end(); });
const chat = (port, body) => req(port, '/ai/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const b = 'http://127.0.0.1:' + server.address().port, lib = fs.mkdtempSync(path.join(os.tmpdir(), 'npollama-')); let stops = 0;
  const hub = new Hub({ dataDir: lib, idleMs: 600, context: async (q) => ({ text: '[Boiling]\nBoil water for one minute.', sources: [{ title: 'Boiling', url: '/wiki/content/water/A/Boiling' }] }) });
  const mk = (over) => new Manager(Object.assign({ catalog: merged(), dataDir: lib, githubApi: b, githubDl: b, hf: b, kiwix: b, pypi: b, platform: 'linux', arch: 'x64', timeout: 5000, ramBytes: 4 * 1073741824, onAiChange: async () => { stops++; await hub.stop(); }, ollama: hub.ollama }, over || {}));
  let mgr = mk(); const done = async (id) => { for (let i = 0; i < 600; i++) { const j = mgr.jobs[id]; if (j && (j.state === 'done' || j.state === 'error')) return j; await sleep(30); } throw new Error('timeout ' + id); };
  const info = async (m, id) => m.handle('GET', '/info', new URLSearchParams('id=' + id), null);

  // ---------- the catalog ----------
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'site', 'catalog.json'), 'utf8'));
  const eng = cat.modules.find((m) => m.id === 'ollama-engine'), oms = cat.modules.filter((m) => m.install.kind === 'ollama-model');
  ok(eng && eng.install.kind === 'ollama' && eng.category === 'ai' && oms.length === 5 && oms.every((m) => m.type === 'model' && m.open === '/ai/' && m.approxMB > 0), 'the store lists Ollama and five Ollama models in the AI category');
  ok(cat.topics.find((t) => t.id === 'ai').tiers.some((t) => /^ai-ollama/.test(t.id) && t.modules.includes('ollama-engine')), 'easy setup offers an Ollama choice');

  // ---------- which download is chosen (real asset names, GPU add-ons and installers ignored) ----------
  let r = await info(mgr, 'ollama-engine'); ok(r.code === 200 && r.body.file === OLLAMA_LINUX && r.body.version === 'v9.9.9', 'Linux x64 gets ' + OLLAMA_LINUX + ' (not the rocm / mlx add-ons): ' + r.body.file);
  for (const [plat, arch, want] of [['win32', 'x64', 'ollama-windows-amd64.zip'], ['win32', 'arm64', 'ollama-windows-arm64.zip'], ['darwin', 'arm64', 'Ollama-darwin.zip'], ['linux', 'arm64', 'ollama-linux-arm64.tar.zst']]) {
    const x = await info(mk({ platform: plat, arch }), 'ollama-engine'); ok(x.code === 200 && x.body.file === want, plat + ' ' + arch + ' gets ' + want + ' (' + (x.body.file || x.body.error) + ')'); }
  { const x = await info(mk({ arch: 'arm' }), 'ollama-engine'); ok(x.code === 412 && /no ready-made Ollama/i.test(x.body.error), 'a 32-bit Raspberry Pi is told plainly there is no Ollama for it'); }
  r = await info(mgr, 'ollama-qwen25-05b'); ok(r.code === 200 && r.body.version === '0.5b' && r.body.bytes === 400 * 1048576 && /Ollama library/.test(r.body.note), 'model info: tag, size and where it comes from');
  { const small = mk({ ramBytes: 0.5 * 1073741824 }); r = await info(small, 'ollama-llama32-3b'); ok(/probably too little/.test(r.body.note), 'a model that needs more memory than the computer has is flagged'); }

  // ---------- installing a model installs the engine first, then pulls with progress ----------
  const seen = new Set(), setOrig = mgr.set.bind(mgr); mgr.set = (id, patch) => { if (patch && patch.message) seen.add(patch.message); return setOrig(id, patch); };   // every message the Downloads panel could show, not a sample
  mgr.enqueue('ollama-qwen25-05b', 'install'); let j;
  for (let i = 0; i < 600; i++) { j = mgr.jobs['ollama-qwen25-05b']; if (j.state === 'done' || j.state === 'error') break; await sleep(10); }
  ok(j.state === 'done', 'engine + model installed: ' + j.message);
  const odir = path.join(lib, 'ai', 'ollama');
  ok(fs.existsSync(path.join(odir, 'bin', 'ollama')) && fs.existsSync(path.join(odir, 'lib', 'ollama', 'libggml-base.so')) && (fs.statSync(path.join(odir, 'bin', 'ollama')).mode & 0o111) !== 0 && fs.readFileSync(path.join(odir, 'VERSION'), 'utf8').trim() === 'v9.9.9', 'Ollama is unpacked whole (bin/ and lib/ side by side), runnable, with its version recorded' + (HAS_ZSTD ? ' (from a .tar.zst)' : ''));
  ok([...seen].some((m) => /Installing the AI engine first/.test(m)) && [...seen].some((m) => /qwen2\.5:0\.5b: \d+ of \d+ MB/.test(m)), 'the Downloads panel saw "engine first" and then the model\'s progress in MB');
  ok(fs.existsSync(path.join(lib, 'ai', 'ollama-models', 'manifests', 'registry.ollama.ai', 'library', 'qwen2.5', '0.5b')), 'the model lives in the library folder, not in the user\'s own ~/.ollama');
  let it = mgr.catalog().find((m) => m.id === 'ollama-qwen25-05b'); ok(it.installed && it.version === '0.5b' && it.bytes === 4000010, 'the store sees the model as installed (size from its manifest)');
  it = mgr.catalog().find((m) => m.id === 'ollama-engine'); ok(it.installed && it.version === 'v9.9.9', 'and the engine, version v9.9.9');
  ok(fs.readdirSync(path.join(lib, 'ai')).every((f) => !f.startsWith('.dl-')), 'no temporary download folder is left behind');

  // ---------- chatting through the app: Ollama is picked automatically, and can read the library ----------
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'npollsite-')); const app = create({ siteDir: site, filesDir: lib, getName: () => 'x', setName: () => {}, version: '1', platform: 'linux', ai: hub }); const port = await app.start(0);
  let g = await req(port, '/ai/api/status'); let st = JSON.parse(g.body);
  ok(st.engine && st.engines.ollama && !st.engines.llama && JSON.stringify(st.models) === '["ollama:qwen2.5:0.5b"]' && st.active === 'ollama:qwen2.5:0.5b' && st.canSelect === true, 'status lists the Ollama model (as "ollama:qwen2.5:0.5b") and the owner may switch');
  g = await chat(port, { messages: [{ role: 'user', content: 'hello' }] });
  ok(g.code === 200 && /OLLAMA MODEL=qwen2\.5:0\.5b CTX=4096/.test(g.body) && /data: \[DONE\]/.test(g.body), 'a question starts Ollama on loopback with the model and streams the answer');
  const body = JSON.parse(JSON.parse(g.body.split('data: ').filter((x) => /BODY=/.test(x))[0].trim()).choices[0].delta.content.replace(/^BODY=/, ''));
  ok(Object.keys(body).sort().join() === 'max_tokens,messages,model,stream,temperature' && body.model === 'qwen2.5:0.5b', 'only chat fields reach Ollama, plus the model name the app chose');
  g = await chat(port, { messages: [{ role: 'user', content: 'how do I purify water?' }], library: true, model: '../../etc/passwd' });
  ok(/Excerpts from the user's offline library/.test(g.body) && /Boil water for one minute/.test(g.body) && /MODEL=qwen2\.5:0\.5b/.test(g.body), 'with "Use my library" on, Ollama is given the matching pages (and a model name from the page is ignored)');
  let src = []; try { src = JSON.parse(decodeURIComponent(g.h['x-library-sources'])); } catch (e) { /* none */ } ok(src.length === 1 && src[0].title === 'Boiling', 'and the sources come back for the page to link');
  g = await req(port, '/ai/api/api/tags'); ok(g.code === 404, 'Ollama\'s own API (list, pull, delete...) is not reachable through the app');
  g = await req(port, '/ai/api/api/pull', { method: 'POST', body: '{"model":"x"}' }); ok(g.code === 404, '...nor can a page start a download');
  // pictures go to Ollama vision models as image parts of the last question; anything that is not a small image data URL is dropped
  { const PNG = 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64');
    g = await chat(port, { messages: [{ role: 'user', content: 'what plant is this?' }], images: [PNG, 'http://evil.example/x.png', 'data:text/html;base64,AAAA', PNG] });
    const pb = JSON.parse(JSON.parse(g.body.split('data: ').filter((x) => /BODY=/.test(x))[0].trim()).choices[0].delta.content.replace(/^BODY=/, '')), last = pb.messages[pb.messages.length - 1];
    ok(g.code === 200 && Array.isArray(last.content) && last.content[0].type === 'text' && last.content[0].text === 'what plant is this?' && last.content.length === 3 && last.content[1].image_url.url === PNG, 'a picture is passed to Ollama as an image part of the question (links and non-images are dropped, at most 2)');
    g = await chat(port, { messages: [{ role: 'user', content: 'x' }], images: ['data:image/png;base64,' + 'A'.repeat(1600000)] }); ok(g.code === 200 && !/image_url/.test(g.body), 'an oversized picture is dropped'); }
  ok(hub.up, 'running'); await sleep(900); ok(!hub.up, 'it stops by itself after a quiet spell');

  // ---------- both engines side by side ----------
  fs.mkdirSync(path.join(lib, 'ai', 'engine'), { recursive: true }); fs.mkdirSync(path.join(lib, 'ai', 'models'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fake-llama-server.js'), path.join(lib, 'ai', 'engine', 'llama-server')); fs.chmodSync(path.join(lib, 'ai', 'engine', 'llama-server'), 0o755); fs.writeFileSync(path.join(lib, 'ai', 'models', 'tiny.gguf'), 'GGUF');
  st = hub.status(); ok(JSON.stringify(st.models) === '["tiny.gguf","ollama:qwen2.5:0.5b"]' && st.engines.llama && st.engines.ollama, 'a llama.cpp model and an Ollama model are listed together');
  g = await req(port, '/ai/api/select', { method: 'POST', headers: { 'X-NorwinPrep': '1' }, body: JSON.stringify({ model: 'tiny.gguf' }) }); ok(g.code === 200 && JSON.parse(g.body).active === 'tiny.gguf', 'the owner can pick the llama.cpp model');
  g = await chat(port, { messages: [{ role: 'user', content: 'x' }] }); ok(/MODEL=tiny\.gguf/.test(g.body) && !/OLLAMA/.test(g.body), 'and that question is answered by llama.cpp');
  g = await chat(port, { messages: [{ role: 'user', content: 'what is this?' }], images: ['data:image/png;base64,AAAA'] }); ok(g.code === 400 && /vision model/.test(JSON.parse(g.body).error), 'llama.cpp models cannot take pictures: the page is told to use an Ollama vision model');
  g = await req(port, '/ai/api/select', { method: 'POST', headers: { 'X-NorwinPrep': '1' }, body: JSON.stringify({ model: 'ollama:qwen2.5:0.5b' }) }); ok(g.code === 200 && JSON.parse(g.body).active === 'ollama:qwen2.5:0.5b', 'and back to the Ollama model');
  g = await chat(port, { messages: [{ role: 'user', content: 'x' }] }); ok(/OLLAMA MODEL=qwen2\.5:0\.5b/.test(g.body), 'answered by Ollama again');
  for (const bad of ['ollama:nope:1b', 'ollama:../x:1', '../x.gguf', 'nope.gguf']) { g = await req(port, '/ai/api/select', { method: 'POST', headers: { 'X-NorwinPrep': '1' }, body: JSON.stringify({ model: bad }) }); ok(g.code === 404, 'switching to "' + bad + '" is refused'); }
  g = await req(port, '/ai/api/select', { method: 'POST', body: JSON.stringify({ model: 'tiny.gguf' }) }); ok(g.code === 403, 'switching needs the app header');
  await hub.stop();

  // ---------- devices on the Wi-Fi share may chat with Ollama but not switch or pull ----------
  { const { createShare } = require('../local-server'); fs.mkdirSync(path.join(site, 'ai'), { recursive: true }); fs.writeFileSync(path.join(site, 'ai', 'index.html'), 'CHAT');
    const sh = createShare({ siteDir: site, mapsDir: lib, appsDir: lib, reader: null, getName: () => 'x', version: '1', ai: hub }); const sp = await sh.start([0], '127.0.0.1');
    g = await chat(sp, { messages: [{ role: 'user', content: 'hi from a phone' }] }); ok(g.code === 200 && /MODEL=/.test(g.body), 'a joined device can chat');
    g = await req(sp, '/ai/api/select', { method: 'POST', body: '{"model":"tiny.gguf"}' }); ok(g.code === 405 || g.code === 403, 'but cannot switch models');
    g = await req(sp, '/ai/api/api/pull', { method: 'POST', body: '{"model":"x"}' }); ok(g.code !== 200, 'nor start a download (' + g.code + ')');
    await hub.stop(); await sh.stop(); }

  // ---------- problems are explained ----------
  { const extra = JSON.parse(fs.readFileSync(merged(), 'utf8')); extra.modules.push({ id: 'ollama-missing', type: 'model', category: 'ai', name: 'Missing', tagline: 't', description: 'd', by: 'X', source: 'https://x', icon: 'chip', color: '#000', sizeClass: 's', approxMB: 10, install: { kind: 'ollama-model', name: 'missing:1b' }, platforms: ['linux'], hosts: ['app'] });
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'npcat2-')), 'catalog.json'); fs.writeFileSync(f, JSON.stringify(extra)); mgr = mk({ catalog: f }); }
  mgr.enqueue('ollama-missing', 'install'); j = await done('ollama-missing'); ok(j.state === 'error' && /Ollama could not download missing:1b: .*does not exist/.test(j.message), 'a model Ollama does not have gives a clear error: ' + j.message);
  ok(!hub.ollama.models().includes('missing:1b'), 'and nothing half-installed is listed');
  F.ollamaSha = 'bad'; { const lib2 = fs.mkdtempSync(path.join(os.tmpdir(), 'npollama2-')); const m2 = mk({ dataDir: lib2 }); mgr = m2; m2.enqueue('ollama-engine', 'install'); j = await done('ollama-engine'); ok(j.state === 'error' && /checksum/i.test(j.message) && !fs.existsSync(path.join(lib2, 'ai', 'ollama')), 'an engine download that fails its GitHub digest is rejected and not installed'); }
  F.ollamaSha = 'ok';
  { const lib3 = fs.mkdtempSync(path.join(os.tmpdir(), 'npollama3-')); fs.mkdirSync(path.join(lib3, 'ai', 'ollama', 'bin'), { recursive: true }); fs.writeFileSync(path.join(lib3, 'ai', 'ollama', 'bin', 'ollama'), '#!/bin/sh\necho "Error: could not bind" >&2\nexit 3\n', { mode: 0o755 });
    const bad = new Hub({ dataDir: lib3, startTimeout: 5000 }), mf = path.join(lib3, 'ai', 'ollama-models', 'manifests', 'registry.ollama.ai', 'library', 'm', '1b'); fs.mkdirSync(path.dirname(mf), { recursive: true }); fs.writeFileSync(mf, '{}');
    const ba = create({ siteDir: site, filesDir: lib3, getName: () => 'x', setName: () => {}, version: '1', platform: 'linux', ai: bad }); const bp = await ba.start(0);
    g = await chat(bp, { messages: [{ role: 'user', content: 'x' }] }); ok(g.code === 503 && /stopped|did not start|bind/i.test(JSON.parse(g.body).error), 'an Ollama that crashes gives a clear 503: ' + JSON.parse(g.body).error.slice(0, 70)); await ba.stop(); }

  // ---------- removing ----------
  mgr = mk(); mgr.enqueue('ollama-qwen25-05b', 'remove'); j = await done('ollama-qwen25-05b');
  ok(j.state === 'done' && !fs.existsSync(path.join(lib, 'ai', 'ollama-models', 'manifests', 'registry.ollama.ai', 'library', 'qwen2.5', '0.5b')) && !hub.ollama.models().length, 'removing a model deletes it through Ollama');
  mgr.enqueue('ollama-engine', 'remove'); j = await done('ollama-engine'); ok(j.state === 'done' && !fs.existsSync(path.join(lib, 'ai', 'ollama')) && stops >= 1, 'removing the engine stops it and deletes it');
  ok(!hub.ollama.engineInstalled() && hub.status().engines.llama, 'the other engine is untouched');

  server.close(); await app.stop(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
