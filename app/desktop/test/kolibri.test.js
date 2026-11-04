'use strict';
// Run: node test/kolibri.test.js. Uses a fake "python" that behaves like `python -m kolibri start` (no real Kolibri, no network).
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { Kolibri, pythonOk } = require('../kolibri');
const { create } = require('../local-server');
const { Manager } = require('../modules-manager');
const { F, server } = require('./fixtures');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL ' + m); } else console.log('ok   ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npkol-'));
const FAKE_PY = path.join(tmp, 'fakepython');
fs.writeFileSync(FAKE_PY, `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === '-c') { console.log(process.env.FAKE_PY_VERSION || '3.12'); process.exit(0); }
if (a[0] !== '-m' || a[1] !== 'kolibri') process.exit(2);
const fs = require('fs'), path = require('path');
const ini = fs.readFileSync(path.join(process.env.KOLIBRI_HOME, 'options.ini'), 'utf8');
const port = Number(a[a.indexOf('--port') + 1]);
const delay = Number(process.env.FAKE_DELAY || 0);
setTimeout(() => require('http').createServer((q, r) => { let b = ''; q.on('data', (c) => b += c); q.on('end', () => { r.writeHead(200, { 'Content-Type': 'text/plain', 'X-Seen-Host': q.headers.host }); r.end('KOLIBRI ' + q.method + ' ' + q.url + ' body=' + b + ' ini=' + ini.replace(/\\n/g, ';')); }); }).listen(port, '127.0.0.1'), delay);
`, { mode: 0o755 });
const get = (port, p, opt) => new Promise((res, rej) => { const q = http.request(Object.assign({ host: '127.0.0.1', port, path: p, method: 'GET' }, opt || {}), (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res({ code: r.statusCode, body: d, h: r.headers })); }); q.on('error', rej); if (opt && opt.body) q.write(opt.body); q.end(); });
function installFake(dir) { const app = path.join(dir, 'kolibri', 'app', 'kolibri'); fs.mkdirSync(app, { recursive: true }); fs.writeFileSync(path.join(app, '__init__.py'), ''); fs.writeFileSync(path.join(dir, 'kolibri', 'app', '.installed'), JSON.stringify({ version: '0.19.5', requires: '<3.15,>=3.6' })); }

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // ---- python version ranges ----
  ok(pythonOk('3.12', '<3.15,>=3.6') && pythonOk('3.6', '>=3.6') && !pythonOk('3.5', '>=3.6') && !pythonOk('3.15', '<3.15,>=3.6') && pythonOk('3.9', ''), 'Python version ranges are read correctly');

  // ---- finding Python ----
  const data = path.join(tmp, 'lib'); fs.mkdirSync(data, { recursive: true });
  let k = new Kolibri({ dataDir: data, candidates: [['/nonexistent-python'], [FAKE_PY]] });
  ok(JSON.stringify(await k.findPython('<3.15,>=3.6')) === JSON.stringify([FAKE_PY]), 'skips a missing interpreter and uses the next one');
  process.env.FAKE_PY_VERSION = '3.5'; let err = null; try { await k.findPython('<3.15,>=3.6'); } catch (e) { err = e; } ok(err && /needs Python .*3\.5/.test(err.message.replace(/<3\.15 and >=3\.6/, 'x')) || (err && /Python 3\.5/.test(err.message)), 'an out-of-range Python is explained: ' + (err && err.message.slice(0, 90)));
  delete process.env.FAKE_PY_VERSION;
  const none = new Kolibri({ dataDir: data, candidates: [['/nonexistent-python']] }); err = null; try { await none.findPython('>=3.6'); } catch (e) { err = e; } ok(err && /needs Python 3 on this computer/.test(err.message), 'no Python at all: tells the user what to install');

  // ---- running + proxy through the app's local server ----
  installFake(data); k = new Kolibri({ dataDir: data, candidates: [[FAKE_PY]], startTimeout: 15000 });
  ok(k.installed() && !k.ready(), 'installed, not running until first use');
  const app = create({ siteDir: tmp, filesDir: tmp, getName: () => 'x', setName: () => {}, version: '1', platform: 'linux', kolibri: k });
  const port = await app.start(0);
  process.env.FAKE_DELAY = '1500';
  let g = await get(port, '/learn/'); ok(g.code === 503 && /Starting Kolibri/.test(g.body) && /http-equiv="refresh"/.test(g.body), 'first visit starts it and shows a self-refreshing "Starting Kolibri" page');
  for (let i = 0; i < 80 && !k.ready(); i++) await sleep(150);
  ok(k.ready(), 'it comes up');
  g = await get(port, '/learn/en/learn?x=1'); ok(g.code === 200 && g.body.startsWith('KOLIBRI GET /learn/en/learn?x=1'), 'requests under /learn/ reach Kolibri with the path unchanged');
  ok(g.h['x-seen-host'] === '127.0.0.1:' + port, 'the Host header is kept as the browser sent it (Kolibri\'s CSRF check compares it with Origin)');
  ok(/HTTP_PORT = \d+/.test(g.body) && /URL_PATH_PREFIX = \/learn\//.test(g.body) && /LISTEN_ADDRESS = 127\.0\.0\.1/.test(g.body) && /DISABLE_PING = True/.test(g.body) && /ZIP_CONTENT_PORT = \d+/.test(g.body), 'its settings: own ports, /learn/ prefix, loopback only, no pings');
  g = await get(port, '/learn/api/login', { method: 'POST', headers: { Origin: 'http://127.0.0.1:' + port, 'Content-Type': 'application/json' }, body: '{"u":"a"}' }); ok(g.code === 200 && /POST \/learn\/api\/login body=\{"u":"a"\}/.test(g.body), 'a login POST from the app\'s own page is forwarded');
  g = await get(port, '/learn/api/login', { method: 'POST', headers: { Origin: 'http://evil.example' }, body: 'x' }); ok(g.code === 403, 'a POST from another website is refused');
  g = await get(port, '/learn'); ok(g.code === 302 && g.h.location === '/learn/', '/learn redirects to /learn/');
  g = await get(port, '/api/device'); ok(g.code === 200 && JSON.parse(g.body).mode === 'local', 'the app\'s own API is untouched');
  const p1 = k.port, z1 = k.zip; await k.stop(); ok(!k.ready(), 'stop shuts it down');
  process.env.FAKE_DELAY = '0'; await k.start(); ok(k.port === p1 && k.zip === z1, 'the same ports are reused after a restart');
  await k.setShared(true); for (let i = 0; i < 60 && !k.ready(); i++) await sleep(100);
  g = await get(k.port, '/learn/'); ok(/LISTEN_ADDRESS = 0\.0\.0\.0/.test(g.body) && k.info().shared, 'while Wi-Fi sharing is on it listens on all interfaces (so children can open it)');
  await k.setShared(false); for (let i = 0; i < 60 && !k.ready(); i++) await sleep(100);
  g = await get(k.port, '/learn/'); ok(/LISTEN_ADDRESS = 127\.0\.0\.1/.test(g.body) && !k.info().shared, 'and back to this device only when sharing stops');
  await k.stop(); await app.stop();

  // ---- failure shown to the user ----
  const bad = path.join(tmp, 'badlib'); fs.mkdirSync(bad); installFake(bad); const crash = path.join(tmp, 'crashpy'); fs.writeFileSync(crash, '#!/bin/sh\n[ "$1" = "-c" ] && { echo 3.12; exit 0; }\necho "ModuleNotFoundError: boom" >&2\nexit 1\n', { mode: 0o755 });
  const kb = new Kolibri({ dataDir: bad, candidates: [[crash]], startTimeout: 5000 }); await kb.start().catch(() => {});
  const app2 = create({ siteDir: tmp, filesDir: tmp, getName: () => 'x', setName: () => {}, version: '1', platform: 'linux', kolibri: kb }); const port2 = await app2.start(0);
  g = await get(port2, '/learn/'); ok(g.code === 500 && /could not start/i.test(g.body), 'a crash on start shows an error page, not a blank one: ' + g.code); await app2.stop();

  // ---- installing from PyPI (fake) ----
  const b = 'http://127.0.0.1:' + server.address().port, lib = path.join(tmp, 'mgrlib'); fs.mkdirSync(lib);
  const calls = { py: [], stops: 0 };
  const mk = (over) => new Manager(Object.assign({ catalog: path.join(__dirname, '..', '..', 'shared', 'site', 'catalog.json'), dataDir: lib, pypi: b, pypiFilesAny: true, githubApi: b, githubDl: b, kiwix: b, platform: 'linux', arch: 'x64', timeout: 5000,
    pythonCheck: async (r) => { calls.py.push(r); }, onKolibriChange: async () => { calls.stops++; } }, over));
  let mgr = mk(); const done = async (id) => { for (let i = 0; i < 400; i++) { const j = mgr.jobs[id]; if (j && (j.state === 'done' || j.state === 'error')) return j; await sleep(40); } throw new Error('timeout'); };
  let r = await mgr.handle('GET', '/info', new URLSearchParams('id=kolibri'), null); ok(r.code === 200 && r.body.version === '0.19.5' && r.body.file === 'kolibri-0.19.5-py2.py3-none-any.whl' && /Python <3\.15,>=3\.6/.test(r.body.note), 'info: newest pure-Python wheel from PyPI, version, size and the Python it needs');
  mgr.enqueue('kolibri', 'install'); let j = await done('kolibri'); ok(j.state === 'done' && calls.py[0] === '<3.15,>=3.6', 'installs after checking the computer has a suitable Python: ' + j.message);
  ok(fs.existsSync(path.join(lib, 'kolibri', 'app', 'kolibri', '__init__.py')) && JSON.parse(fs.readFileSync(path.join(lib, 'kolibri', 'app', '.installed'), 'utf8')).version === '0.19.5', 'unpacked and marked installed');
  const item = mgr.catalog().find((m) => m.id === 'kolibri'); ok(item.installed && item.version === '0.19.5' && item.open === '/learn/' && item.category === 'education', 'the store sees it: installed, Open goes to /learn/, in Education');
  fs.mkdirSync(path.join(lib, 'kolibri', 'home'), { recursive: true }); fs.writeFileSync(path.join(lib, 'kolibri', 'home', 'accounts.db'), 'learner data');
  mgr.enqueue('kolibri', 'remove'); j = await done('kolibri'); ok(j.state === 'done' && !mgr.catalog().find((m) => m.id === 'kolibri').installed && fs.readFileSync(path.join(lib, 'kolibri', 'home', 'accounts.db'), 'utf8') === 'learner data', 'removing deletes the program but keeps accounts and lessons');
  F.kolibriSha = 'bad'; mgr = mk(); mgr.enqueue('kolibri', 'install'); j = await done('kolibri'); ok(j.state === 'error' && /checksum|corrupt/i.test(j.message) && !fs.existsSync(path.join(lib, 'kolibri', 'app')), 'a wheel that fails PyPI\'s SHA-256 is rejected and nothing is installed: ' + j.message);
  F.kolibriSha = 'ok'; mgr = mk({ pythonCheck: async () => { throw new Error('Kolibri needs Python 3 on this computer. Install it from python.org.'); } }); mgr.enqueue('kolibri', 'install'); j = await done('kolibri'); ok(j.state === 'error' && /needs Python 3/.test(j.message) && !fs.existsSync(path.join(lib, 'kolibri', 'app')), 'no suitable Python: a clear message, and nothing is downloaded');

  server.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
