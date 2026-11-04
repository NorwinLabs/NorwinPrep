'use strict';
// Run on a clean machine with internet (see .github/workflows/ai-real.yml): installs the REAL llama.cpp engine and a real small model with the
// app's own installer, starts the app's own runner, asks a question through the app's own server, and checks that an answer streams back.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), https = require('https');
const { Manager } = require('../modules-manager');
const { Llama } = require('../ai');
const { create } = require('../local-server');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL ' + m); } else console.log('ok   ' + m); };
(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'npaireal-')), ai = new Llama({ dataDir: data, startTimeout: 420000 });
  const mgr = new Manager({ catalog: path.join(__dirname, '..', '..', 'shared', 'site', 'catalog.json'), dataDir: data, platform: process.platform, arch: process.arch, onAiChange: () => ai.stop() });
  // facts: what does llama.cpp really publish? (printed so a failed match can be fixed from evidence)
  try {
    const rels = await new Promise((resolve, reject) => { https.get({ host: 'api.github.com', path: '/repos/ggml-org/llama.cpp/releases?per_page=12', headers: { 'User-Agent': 'norwinprep-check' } }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject); });
    console.log('RELEASES:', rels.map((r) => r.tag_name + (r.prerelease ? '(pre)' : '') + ':' + (r.assets || []).length).join(' '));
    const withBins = rels.filter((r) => (r.assets || []).some((a) => /^llama-/.test(a.name)))[0] || rels[1] || rels[0];
    if (withBins) console.log('ASSETS of ' + withBins.tag_name + ':\n  ' + withBins.assets.map((a) => a.name + ' ' + a.size).join('\n  '));
  } catch (e) { console.log('release probe failed:', e.message); }
  for (const id of ['ai-engine', 'qwen25-05b']) { const r = await mgr.handle('GET', '/info', new URLSearchParams('id=' + id), null); console.log('info', id, JSON.stringify(r.body)); ok(r.code === 200, id + ' is found on the real servers'); }
  const t0 = Date.now(); mgr.enqueue('qwen25-05b', 'install'); let j; for (let i = 0; i < 3600; i++) { j = mgr.jobs['qwen25-05b']; if (j.state === 'done' || j.state === 'error') break; await new Promise((r) => setTimeout(r, 500)); }
  ok(j.state === 'done', 'engine + model installed (' + Math.round((Date.now() - t0) / 1000) + 's): ' + j.message); if (j.state !== 'done') process.exit(1);
  console.log('engine dir:', fs.readdirSync(path.join(data, 'ai', 'engine')).slice(0, 20).join(' '));
  const app = create({ siteDir: data, filesDir: data, getName: () => 'x', setName: () => {}, version: '1', platform: process.platform, ai }); const port = await app.start(0);
  const t1 = Date.now(); const body = JSON.stringify({ messages: [{ role: 'user', content: 'What is 2 plus 2? Answer with one short sentence.' }], stream: true, max_tokens: 40, temperature: 0 });
  const res = await new Promise((resolve, reject) => { const q = http.request({ host: '127.0.0.1', port, path: '/ai/api/chat', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => resolve({ code: r.statusCode, body: d })); }); q.on('error', reject); q.end(body); });
  console.log('chat status', res.code, 'in', Math.round((Date.now() - t1) / 1000) + 's'); console.log('log tail:', ai.log.slice(-500));
  let text = ''; for (const ln of res.body.split('\n')) { if (ln.startsWith('data:') && !ln.includes('[DONE]')) { try { text += JSON.parse(ln.slice(5)).choices[0].delta.content || ''; } catch (e) { /* partial */ } } }
  console.log('ANSWER:', JSON.stringify(text));
  ok(res.code === 200 && text.trim().length > 3, 'a real model streamed an answer through the app\'s proxy'); ok(/4|four/i.test(text), 'and the answer is sensible');
  await ai.stop(); await app.stop(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
