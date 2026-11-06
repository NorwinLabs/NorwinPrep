'use strict';
// Run on a clean machine with internet (see .github/workflows/kolibri-real.yml): installs the REAL Kolibri from PyPI with the app's own
// installer, starts it with the app's own runner, and checks it answers under /learn/ through the app's own local server.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { Manager } = require('../modules-manager');
const { Kolibri } = require('../kolibri');
const { create } = require('../local-server');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL ' + m); } else console.log('ok   ' + m); };
const get = (port, p) => new Promise((res, rej) => { http.get({ host: '127.0.0.1', port, path: p }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res({ code: r.statusCode, body: d, h: r.headers })); }).on('error', rej); });
(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'npkreal-')), k = new Kolibri({ dataDir: data, startTimeout: 300000 });
  const mgr = new Manager({ catalog: require('./catalog-merged').merged(), dataDir: data, platform: process.platform, arch: process.arch, pythonCheck: (r) => k.findPython(r), onKolibriChange: () => k.stop() });
  const info = await mgr.handle('GET', '/info', new URLSearchParams('id=kolibri'), null); console.log('info', JSON.stringify(info.body)); ok(info.code === 200, 'PyPI lookup works');
  mgr.enqueue('kolibri', 'install'); let j; for (let i = 0; i < 1800; i++) { j = mgr.jobs.kolibri; if (j.state === 'done' || j.state === 'error') break; await new Promise((r) => setTimeout(r, 500)); }
  ok(j.state === 'done', 'real Kolibri installed: ' + j.message); if (j.state !== 'done') process.exit(1);
  const app = create({ siteDir: data, filesDir: data, getName: () => 'x', setName: () => {}, version: '1', platform: process.platform, kolibri: k }); const port = await app.start(0);
  let g = await get(port, '/learn/'); console.log('first answer', g.code);
  const t0 = Date.now(); while (!k.ready() && Date.now() - t0 < 290000) await new Promise((r) => setTimeout(r, 1000));
  ok(k.ready(), 'Kolibri started (' + Math.round((Date.now() - t0) / 1000) + 's)'); console.log('python log tail:', k.log.slice(-600));
  if (k.ready()) {
    g = await get(port, '/learn/'); console.log('GET /learn/ ->', g.code, g.h.location || ''); ok(g.code === 200 || g.code === 302, 'answers under /learn/ through the app');
    let loc = g.h.location, depth = 0; while (loc && depth++ < 5) { g = await get(port, loc); console.log('follow', loc, '->', g.code, g.h.location || ''); loc = g.code >= 300 && g.code < 400 ? g.h.location : null; }
    ok(g.code === 200 && /kolibri/i.test(g.body), 'the page that loads is Kolibri\'s (' + g.code + ', ' + g.body.length + ' bytes)');
    const asset = (g.body.match(/(?:src|href)="(\/learn\/[^"]+\.(?:js|css))"/) || [])[1]; if (asset) { const a = await get(port, asset); ok(a.code === 200, 'its static files load through the proxy: ' + asset + ' -> ' + a.code); }
    const api = await get(port, '/learn/api/public/info/'); console.log('api', api.code, api.body.slice(0, 160)); ok(api.code === 200 && /kolibri_version|application/.test(api.body), 'its public info API answers through the proxy');
  }
  await k.stop(); await app.stop(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
