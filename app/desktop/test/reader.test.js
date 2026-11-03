'use strict';
// Run: node test/reader.test.js
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { Reader } = require('../reader');
const { create, createShare } = require('../local-server');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL ' + m); } else console.log('ok   ' + m); };
const get = (port, p, headers) => new Promise((res, rej) => { http.get({ host: '127.0.0.1', port, path: p, headers }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res({ code: r.statusCode, body: d, h: r.headers })); }).on('error', rej); });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npreader-')), bin = path.join(dir, 'reader'), zim = path.join(dir, 'zim'); fs.mkdirSync(bin); fs.mkdirSync(zim);
// a stand-in kiwix-serve that really listens on --port, serves /wiki/ and records how it was started
fs.writeFileSync(path.join(bin, 'kiwix-serve'), `#!/usr/bin/env node
const a = process.argv.slice(2); const port = Number(a[a.indexOf('--port') + 1]);
require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'args.json'))}, JSON.stringify({ args: a, pid: process.pid }));
require('http').createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/plain' }); r.end('KIWIX pid=' + process.pid + ' path=' + q.url + ' host=' + q.headers.host + ' zims=' + a.filter((x) => x.endsWith('.zim')).map((x) => require('path').basename(x)).join(',')); }).listen(port, '127.0.0.1');
`, { mode: 0o755 });
(async () => {
  const rd = new Reader({ binDir: bin, zimDir: zim });
  ok(await rd.restart() === true && !rd.ready(), 'no content packs yet: nothing to run, not an error');
  fs.writeFileSync(path.join(zim, 'a_2025-01.zim'), 'a'); fs.writeFileSync(path.join(zim, '.hidden_2025-01.zim.part'), 'x'); fs.writeFileSync(path.join(zim, 'notes.txt'), 'n');
  ok(await rd.restart() === true && rd.ready(), 'with a pack the reader starts and answers');
  const a1 = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8'));
  ok(a1.args.includes('--urlRootLocation') && a1.args[a1.args.indexOf('--urlRootLocation') + 1] === '/wiki' && a1.args[a1.args.indexOf('--address') + 1] === '127.0.0.1', 'bound to loopback only, served under /wiki');
  ok(a1.args.filter((x) => x.endsWith('.zim')).length === 1 && !a1.args.some((x) => x.includes('.part') || x.includes('notes')), 'only real packs are passed (not .part files or other files)');

  // through the app's local server
  const app = create({ siteDir: dir, filesDir: dir, getName: () => 'x', setName() {}, version: '1', platform: 'linux', mapsDir: dir, appsDir: dir, reader: rd });
  const ap = await app.start(0);
  let r = await get(ap, '/wiki/A/Main_Page?x=1'); ok(r.code === 200 && /path=\/wiki\/A\/Main_Page\?x=1/.test(r.body) && /zims=a_2025-01\.zim/.test(r.body), 'the app proxies /wiki/ (path + query kept): ' + r.body.slice(0, 70));
  ok(/host=127\.0\.0\.1:\d+/.test(r.body) && !r.body.includes('host=127.0.0.1:' + ap), 'the reader sees its own loopback host, not the app\'s');
  r = await get(ap, '/wiki'); ok(r.code === 302 && r.h.location === '/wiki/', '/wiki redirects to /wiki/');

  // adding a pack restarts the reader so it shows up
  fs.writeFileSync(path.join(zim, 'b_2025-02.zim'), 'b'); const pid1 = a1.pid;
  ok(await rd.restart() === true, 'restart after adding a pack'); const a2 = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8'));
  ok(a2.pid !== pid1 && a2.args.filter((x) => x.endsWith('.zim')).length === 2, 'a new process serves both packs');
  r = await get(ap, '/wiki/'); ok(/zims=a_2025-01\.zim,b_2025-02\.zim/.test(r.body), 'new pack visible through the proxy');
  let alive = true; try { process.kill(pid1, 0); } catch (e) { alive = false; } ok(!alive, 'the old reader process was stopped');

  // concurrent restarts do not pile up processes
  await Promise.all([rd.restart(), rd.restart(), rd.restart()]); const a3 = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8'));
  ok(rd.ready() && (await get(ap, '/wiki/')).code === 200, 'overlapping restarts settle into one working reader');

  // the Wi-Fi share server: read-only, serves the same reader
  const share = createShare({ siteDir: dir, mapsDir: dir, appsDir: dir, reader: rd, getName: () => 'Garage Pi', version: '0.7.1' });
  fs.writeFileSync(path.join(dir, 'portal.html'), '<title>PORTAL</title>'); fs.mkdirSync(path.join(dir, 'maps')); fs.writeFileSync(path.join(dir, 'maps', 'index.html'), '<title>MAPS</title>'); fs.writeFileSync(path.join(dir, 'secret.html'), 'SECRET'); fs.writeFileSync(path.join(dir, 'index.html'), 'STORE');
  const sp = await share.start([0], '127.0.0.1');
  r = await get(sp, '/'); ok(r.code === 200 && /PORTAL/.test(r.body), 'share: portal at /');
  r = await get(sp, '/wiki/'); ok(r.code === 200 && /KIWIX/.test(r.body), 'share: library through the reader');
  r = await get(sp, '/maps/'); ok(r.code === 200 && /MAPS/.test(r.body), 'share: map viewer');
  r = await get(sp, '/api/device'); const dv = JSON.parse(r.body); ok(dv.name === 'Garage Pi' && dv.mode === 'pi' && dv.share === true && dv.modules === false, 'share: identifies itself as a NorwinPrep device, store API off');
  for (const p of ['/index.html', '/secret.html', '/api/modules/catalog', '/api/share', '/device.html', '/files/', '/app-ui.js', '/api/update/check']) { r = await get(sp, p); ok(r.code === 404, 'share: ' + p + ' is not public (' + r.code + ')'); }
  r = await new Promise((res) => { const q = http.request({ host: '127.0.0.1', port: sp, path: '/api/device', method: 'POST' }, (x) => { x.resume(); res(x.statusCode); }); q.end(); }); ok(r === 405, 'share: writes are refused (405)');
  r = await get(sp, '/%2e%2e/etc/passwd'); ok(r.code === 400 || r.code === 404, 'share: path tricks refused');

  // stopping
  await rd.stop(); ok(!rd.ready(), 'stop shuts the reader down'); r = await get(ap, '/wiki/'); ok(r.code === 503 && /not ready/i.test(r.body), 'proxy says "not ready" instead of hanging'); 
  fs.unlinkSync(path.join(bin, 'kiwix-serve')); ok(await rd.restart() === false, 'reader missing: reports false, does not crash');
  await share.stop(); app.stop(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
