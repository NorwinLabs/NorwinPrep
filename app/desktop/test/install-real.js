'use strict';
// Run on a clean machine with internet (.github/workflows/install-real.yml): the app's own installer against the REAL servers.
//  1. every module in the catalog is resolved the way the store does it (latest version, file name, exact size)
//  2. a handful of small modules are really downloaded and installed
const fs = require('fs'), os = require('os'), path = require('path');
const { Manager } = require('../modules-manager');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL ' + m); } else console.log('ok   ' + m); };
(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'npireal-'));
  const mgr = new Manager({ catalog: path.join(__dirname, '..', '..', 'shared', 'site', 'catalog.json'), dataDir: data, platform: process.platform, arch: process.arch, timeout: 30000, pythonCheck: async () => true });
  const mods = mgr.catalog(); console.log(mods.length + ' modules for ' + process.platform + '/' + process.arch);
  // 1. resolve everything
  const bad = []; let next = 0;
  await Promise.all([1, 2, 3, 4].map(async () => { while (next < mods.length) { const m = mods[next++]; let r;
    try { r = await mgr.handle('GET', '/info', new URLSearchParams('id=' + encodeURIComponent(m.id)), null); } catch (e) { r = { code: 0, body: { error: String(e) } }; }
    if (r.code !== 200) bad.push(m.id + ' -> ' + r.code + ' ' + JSON.stringify(r.body).slice(0, 160)); } }));
  ok(!bad.length, 'every module resolves against the real servers (' + (mods.length - bad.length) + '/' + mods.length + ')'); bad.forEach((b) => console.error('   ' + b));
  // 2. really install some
  const run = async (id) => { try { mgr.enqueue(id, 'install'); } catch (e) { ok(false, id + ': ' + e.message); return; }
    let j; for (let i = 0; i < 2400; i++) { j = mgr.jobs[id]; if (j.state === 'done' || j.state === 'error') break; await new Promise((r) => setTimeout(r, 500)); }
    ok(j.state === 'done', id + ' installs: ' + j.message); };
  for (const id of ['water', 'nhs-uk-en-medicines', 'map-hawaii', 'cyberchef', 'notes', 'app-android']) if (mods.some((m) => m.id === id)) await run(id);
  console.log('installed now:', mgr.catalog().filter((m) => m.installed).map((m) => m.id).join(', '));
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
