'use strict';
// Run: node test/speech.test.js. Voice typing's speech model: installing it (checked), serving it to the page, removing it, copying it with a library.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const { Manager } = require('../modules-manager');
const { create } = require('../local-server');
const T = require('../library-transfer');
const { merged } = require('./catalog-merged');
const { F, server, SPEECH_TGZ } = require('./fixtures');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL ' + m); } else console.log('ok   ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = (port, p, o) => new Promise((res, rej) => { const q = http.request(Object.assign({ host: '127.0.0.1', port, path: p, method: 'GET' }, o || {}), (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res({ code: r.statusCode, body: Buffer.concat(c), h: r.headers })); }); q.on('error', rej); q.end(); });

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const b = 'http://127.0.0.1:' + server.address().port;
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'site', 'catalog.json'), 'utf8')), sp = cat.modules.find((m) => m.id === 'speech-en');
  ok(sp && sp.install.kind === 'speech-model' && sp.type === 'tool' && sp.category === 'ai' && /^https:\/\/ccoreilly\.github\.io\/vosk-browser\/models\//.test(sp.install.url), 'the store lists Voice typing (English) under AI');
  ok(cat.topics.find((t) => t.id === 'ai').tiers.some((t) => t.id === 'ai-voice'), 'easy setup offers it');
  // the shipped catalog pins the REAL model's SHA-256, so the fake model needs a catalog entry without it (the checksum tests below pin the fake's own)
  const plain = (() => { const c = JSON.parse(fs.readFileSync(merged(), 'utf8')); const e = c.modules.find((x) => x.id === 'speech-en'); ok(/^[0-9a-f]{64}$/.test(e.install.sha256), 'the shipped catalog pins the model\'s SHA-256'); delete e.install.sha256; const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'npspp-')), 'c.json'); fs.writeFileSync(f, JSON.stringify(c)); return f; })();
  const mk = (lib, catalog) => new Manager({ catalog: catalog || plain, dataDir: lib, githubApi: b, githubDl: b, kiwix: b, hf: b, pypi: b, speechBase: b, platform: 'linux', arch: 'x64', timeout: 5000 });
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'npsp-')); let m = mk(lib); const wait = async (id) => { for (let i = 0; i < 300; i++) { const j = m.jobs[id]; if (j && (j.state === 'done' || j.state === 'error')) return j; await sleep(25); } return m.jobs[id]; };
  const info = (await m.handle('GET', '/info', new URLSearchParams('id=speech-en'), null)).body; ok(info.file === 'vosk-model-small-en-us-0.15.tar.gz' && info.version === '0.15' && /microphone/.test(info.note), 'info: file, version and what it needs');
  m.enqueue('speech-en', 'install'); let j = await wait('speech-en'); ok(j.state === 'done' && fs.readFileSync(path.join(lib, 'speech', 'vosk-model-small-en-us-0.15.tar.gz')).equals(SPEECH_TGZ), 'installed byte for byte: ' + j.message);
  ok(m.catalog().find((x) => x.id === 'speech-en').installed && fs.readdirSync(path.join(lib, 'speech')).every((f) => !f.startsWith('.')), 'the store sees it installed and no partial file is left');
  // served to the page by the app (and only by the app's own server)
  const app = create({ siteDir: lib, filesDir: lib, getName: () => 'x', setName: () => {}, version: '1', platform: 'linux', speechDir: path.join(lib, 'speech') }), port = await app.start(0);
  let g = await req(port, '/speech/status'); ok(JSON.parse(g.body).installed === true, 'the page is told the model is installed');
  g = await req(port, '/speech/model.tar.gz'); ok(g.code === 200 && g.body.equals(SPEECH_TGZ) && g.h['content-type'] === 'application/gzip', 'the model is served to the page');
  g = await req(port, '/speech/model.tar.gz', { headers: { Range: 'bytes=0-9' } }); ok(g.code === 206 && g.body.length === 10 && g.body[0] === 0x1f, 'ranges work');
  g = await req(port, '/speech/../x.tar.gz'); ok(g.code !== 200 || !g.body.equals(SPEECH_TGZ), 'no other path reaches it');
  // refused downloads
  { F.speech = 'html'; const l2 = fs.mkdtempSync(path.join(os.tmpdir(), 'npsp2-')); m = mk(l2); m.enqueue('speech-en', 'install'); j = await wait('speech-en'); ok(j.state === 'error' && /not a speech model/.test(j.message) && !fs.existsSync(path.join(l2, 'speech', 'vosk-model-small-en-us-0.15.tar.gz')), 'a page that is not a model (an error page) is discarded'); F.speech = ''; }
  { const c2 = JSON.parse(fs.readFileSync(plain, 'utf8')); c2.modules.find((x) => x.id === 'speech-en').install.sha256 = '0'.repeat(64); const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'npsp3-')), 'c.json'); fs.writeFileSync(f, JSON.stringify(c2));
    const l3 = fs.mkdtempSync(path.join(os.tmpdir(), 'npsp3d-')); m = mk(l3, f); m.enqueue('speech-en', 'install'); j = await wait('speech-en'); ok(j.state === 'error' && /Checksum mismatch/i.test(j.message) && !fs.existsSync(path.join(l3, 'speech', 'vosk-model-small-en-us-0.15.tar.gz')), 'a model that fails its SHA-256 is refused');
    c2.modules.find((x) => x.id === 'speech-en').install.sha256 = crypto.createHash('sha256').update(SPEECH_TGZ).digest('hex'); fs.writeFileSync(f, JSON.stringify(c2)); m = mk(fs.mkdtempSync(path.join(os.tmpdir(), 'npsp4-')), f); m.enqueue('speech-en', 'install'); j = await wait('speech-en'); ok(j.state === 'done', 'and installs when the checksum matches'); }
  { const c3 = JSON.parse(fs.readFileSync(plain, 'utf8')); c3.modules.find((x) => x.id === 'speech-en').install.url = 'https://evil.example/model.tar.gz'; const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'npsp5-')), 'c.json'); fs.writeFileSync(f, JSON.stringify(c3)); let e; try { mk(fs.mkdtempSync(path.join(os.tmpdir(), 'npsp5d-')), f); } catch (x) { e = x; } ok(e && /bad speech-model spec/.test(e.message), 'a catalog entry pointing at any other host is rejected when the catalog loads'); }
  // copying a library takes the model along
  m = mk(lib); ok(T.listLibrary(lib).some((f) => f.rel === 'speech/vosk-model-small-en-us-0.15.tar.gz'), 'copying a library to a drive includes the speech model');
  const un = await app.stop; m.enqueue('speech-en', 'remove'); j = await wait('speech-en'); ok(j.state === 'done' && !fs.existsSync(path.join(lib, 'speech', 'vosk-model-small-en-us-0.15.tar.gz')), 'removing deletes it');
  g = await req(port, '/speech/status'); ok(JSON.parse(g.body).installed === false, 'and the page is told it is gone');
  await app.stop(); server.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
