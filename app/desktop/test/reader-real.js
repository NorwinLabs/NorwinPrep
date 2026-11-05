'use strict';
// Real-network test (.github/workflows/install-real.yml): install a small content pack with the app's own installer, let the app's own
// Reader start kiwix-serve on it, and check the library answers. Prints why if the reader does not come up.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { Manager } = require('../modules-manager');
const { Reader } = require('../reader');
const get = (port, p) => new Promise((res, rej) => { http.get({ host: '127.0.0.1', port, path: p, timeout: 5000 }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res({ code: r.statusCode, body: d })); }).on('error', rej); });
(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'npreader-')); for (const d of ['zim', 'maps', 'apps']) fs.mkdirSync(path.join(data, d), { recursive: true });
  const reader = new Reader({ binDir: path.join(data, 'reader'), zimDir: path.join(data, 'zim') });
  const mgr = new Manager({ catalog: path.join(__dirname, '..', '..', 'shared', 'site', 'catalog.json'), dataDir: data, platform: process.platform, arch: process.arch, timeout: 60000, onLibraryChange: () => reader.restart() });
  mgr.enqueue('nhs-uk-en-medicines', 'install'); let j; for (let i = 0; i < 3600; i++) { j = mgr.jobs['nhs-uk-en-medicines']; if (j.state === 'done' || j.state === 'error') break; await new Promise((r) => setTimeout(r, 500)); }
  console.log('install:', JSON.stringify(j)); console.log('reader dir:', fs.existsSync(path.join(data, 'reader')) ? fs.readdirSync(path.join(data, 'reader')).join(', ') : '(missing)');
  console.log('zims:', fs.readdirSync(path.join(data, 'zim')).join(', '));
  if (!reader.ready()) { console.log('reader NOT ready. lastError:', reader.lastError, '| log:', reader.log); await reader.restart(); console.log('after a second restart: ready =', reader.ready(), '| lastError:', reader.lastError, '| log:', reader.log); }
  let ok = false;
  if (reader.ready()) { const g = await get(reader.port, '/wiki/'); console.log('GET /wiki/ ->', g.code, g.body.slice(0, 120).replace(/\s+/g, ' ')); ok = g.code === 200 || g.code === 302; }
  await reader.stop(); console.log(ok ? 'ALL PASSED' : 'FAILED'); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
