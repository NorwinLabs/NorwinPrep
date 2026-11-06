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
  if (ok) {   // the Exit button: the real reader's own pages, through the app's proxy
    const front = http.createServer((q, r) => reader.proxy(q, r)); await new Promise((res) => front.listen(0, '127.0.0.1', res));
    const e1 = await get(front.address().port, '/wiki/'), e2 = await get(front.address().port, '/wiki/viewer');
    const has = (x) => /id="np-exit"/.test(x.body); console.log('Exit button on /wiki/ ->', e1.code, has(e1), '| /wiki/viewer ->', e2.code, has(e2));
    ok = ok && (e1.code === 200 || e1.code === 302) && (has(e1) || has(e2)); front.close(); console.log(has(e1) || has(e2) ? 'ok   the real reader\'s pages get the Exit button' : 'FAIL no Exit button on the real reader\'s pages');
  }
  if (ok) {   // the AI reads the library: search the real pack the way the chat does
    const { libraryContext } = require('../library-search');
    try { console.log('catalogue:', (await get(reader.port, '/wiki/catalog/v2/entries?count=100')).body.slice(0, 600).replace(/\s+/g, ' ')); } catch (e) { console.log('catalogue failed:', e.message); }
    const c = await libraryContext('what is the dose of paracetamol', { port: reader.port, root: '/wiki', maxChars: 2000, maxPages: 3 });
    console.log('library sources:', JSON.stringify(c.sources), '| text starts:', c.text.slice(0, 200).replace(/\s+/g, ' '));
    if (!c.text) { try { console.log('raw search page:', (await get(reader.port, '/wiki/search?pattern=paracetamol&pageLength=3')).body.slice(0, 1500).replace(/\s+/g, ' ')); } catch (e) { console.log('raw search failed:', e.message); } }
    ok = ok && c.text.length > 100 && c.sources.length > 0; console.log(c.text.length > 100 ? 'ok   the AI can read the real library' : 'FAIL the AI could not read the real library');
  }
  await reader.stop(); console.log(ok ? 'ALL PASSED' : 'FAILED'); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
