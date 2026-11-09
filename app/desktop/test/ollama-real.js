'use strict';
// Real-network test (.github/workflows/ai-real.yml, job "ollama"): installs the REAL Ollama and a real small model with the app's own installer,
// installs a real Kiwix content pack and the real reader, then asks a question through the app's own server with "Use my library" on, and checks
// that Ollama was given pages from the pack and answered. Prints the facts needed to fix a mismatch (asset names, log tail, answer).
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { Manager } = require('../modules-manager');
const { Hub } = require('../ai');
const { Reader } = require('../reader');
const { libraryContext } = require('../library-search');
const { create } = require('../local-server');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL ' + m); } else console.log('ok   ' + m); };
const wait = async (mgr, id, secs) => { let j; for (let i = 0; i < secs * 2; i++) { j = mgr.jobs[id]; if (j && (j.state === 'done' || j.state === 'error')) return j; await new Promise((r) => setTimeout(r, 500)); } return j; };
(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'npollreal-')); for (const d of ['zim', 'maps', 'apps']) fs.mkdirSync(path.join(data, d), { recursive: true });
  const reader = new Reader({ binDir: path.join(data, 'reader'), zimDir: path.join(data, 'zim') });
  const hub = new Hub({ dataDir: data, startTimeout: 600000, context: (q, eco) => (reader.ready() ? libraryContext(q, { port: reader.port, root: '/wiki', maxChars: 3000, maxPages: 3 }) : null) });
  const mgr = new Manager({ catalog: path.join(__dirname, '..', '..', 'shared', 'site', 'catalog.json'), dataDir: data, platform: process.platform, arch: process.arch, timeout: 120000, onLibraryChange: () => reader.restart(), onAiChange: () => hub.stop(), ollama: hub.ollama });
  for (const id of ['ollama-engine', 'ollama-qwen25-05b']) { const r = await mgr.handle('GET', '/info', new URLSearchParams('id=' + id), null); console.log('info', id, JSON.stringify(r.body)); ok(r.code === 200, id + ' is found on the real servers'); }
  const t0 = Date.now(); mgr.enqueue('ollama-qwen25-05b', 'install'); let j = await wait(mgr, 'ollama-qwen25-05b', 2400);
  ok(j && j.state === 'done', 'Ollama + model installed (' + Math.round((Date.now() - t0) / 1000) + 's): ' + (j && j.message)); if (!j || j.state !== 'done') process.exit(1);
  const odir = path.join(data, 'ai', 'ollama'); console.log('ollama dir:', fs.readdirSync(odir).join(' '), '| bin:', fs.existsSync(path.join(odir, 'bin')) ? fs.readdirSync(path.join(odir, 'bin')).join(' ') : '-');
  ok(hub.ollama.engineInstalled() && hub.ollama.models().includes('qwen2.5:0.5b'), 'the app sees the engine and the model: ' + hub.ollama.models().join(','));
  mgr.enqueue('nhs-uk-en-medicines', 'install'); j = await wait(mgr, 'nhs-uk-en-medicines', 1800); ok(j && j.state === 'done', 'a real content pack (and the reader) installed: ' + (j && j.message));
  ok(reader.ready(), 'the reader is serving the pack' + (reader.ready() ? '' : ' | ' + reader.lastError + ' | ' + reader.log));
  const app = create({ siteDir: data, filesDir: data, getName: () => 'x', setName: () => {}, version: '1', platform: process.platform, ai: hub, reader }); const port = await app.start(0);
  const ask = (content, library) => new Promise((resolve, reject) => { const body = JSON.stringify({ messages: [{ role: 'user', content }], stream: true, max_tokens: 120, temperature: 0, library }); const q = http.request({ host: '127.0.0.1', port, path: '/ai/api/chat', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => resolve({ code: r.statusCode, body: d, h: r.headers })); }); q.on('error', reject); q.end(body); });
  const text = (res) => { let t = ''; for (const ln of res.body.split('\n')) if (ln.startsWith('data:') && !ln.includes('[DONE]')) { try { t += JSON.parse(ln.slice(5)).choices[0].delta.content || ''; } catch (e) { /* partial */ } } return t; };
  let t1 = Date.now(), res = await ask('What is 2 plus 2? Answer with one short sentence.', false); let a = text(res);
  console.log('plain answer (' + Math.round((Date.now() - t1) / 1000) + 's):', JSON.stringify(a)); console.log('ollama log tail:', hub.ollama.log.slice(-600));
  ok(res.code === 200 && a.trim().length > 3, 'real Ollama streamed an answer through the app\'s proxy'); ok(/4|four/i.test(a), 'and it is sensible');
  t1 = Date.now(); res = await ask('What is the usual adult dose of paracetamol?', true); a = text(res);
  let src = []; try { src = JSON.parse(decodeURIComponent(res.h['x-library-sources'] || '[]')); } catch (e) { /* none */ }
  console.log('library answer (' + Math.round((Date.now() - t1) / 1000) + 's):', JSON.stringify(a)); console.log('sources:', JSON.stringify(src));
  ok(res.code === 200 && a.trim().length > 3, 'Ollama answered with "Use my library" on'); ok(src.length > 0, 'and it was given pages from the real Kiwix pack (' + src.map((s) => s.title).join(', ') + ')');
  await hub.stop(); await reader.stop(); await app.stop(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
