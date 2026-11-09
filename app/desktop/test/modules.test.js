'use strict';
// Run: node test/modules.test.js   (no Electron needed)
const fs = require('fs'), os = require('os'), path = require('path');
const { Manager, loadCatalog } = require('../modules-manager');
const { ZIM, WATER, APK, EXE, PEXE, F, server, work } = require('./fixtures');
const { SHIPPED, merged } = require('./catalog-merged'); const CATALOG = merged();   // CATALOG = shipped modules + test-only extras; SHIPPED = exactly what users get
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL ' + m); } else console.log('ok   ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function make(over) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npmod-')), b = 'http://127.0.0.1:' + server.address().port, calls = { restarts: 0 };
  const mgr = new Manager(Object.assign({ catalog: CATALOG, dataDir: dir, kiwix: b, githubApi: b, githubDl: b, protomaps: b, platform: 'linux', arch: 'x64', timeout: 5000,
    onLibraryChange: async () => { calls.restarts++; return true; } }, over));
  return { mgr, dir, calls };
}
async function done(mgr, id, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 30000)) { const j = mgr.jobs[id]; if (j && (j.state === 'done' || j.state === 'error')) return j; await sleep(40); } throw new Error('job ' + id + ' did not finish: ' + JSON.stringify(mgr.jobs[id])); }
const mod = (mgr, id) => mgr.catalog().find((m) => m.id === id);
async function settle(mgr) { for (let i = 0; i < 100 && mgr.sizesPending(); i++) await sleep(50); }
const reset = () => { Object.assign(F, { shaOk: true, shaMissing: false, newZim: '2025-03', tag: 'v0.6.9', apkSumOk: true, readerListing: true, cyber: 'good', cyberDigest: true }); delete process.env.FAKE_PM_FAIL; };

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let t, j, c, dir;

  // ---------- catalog ----------
  const forLinux = loadCatalog(CATALOG, 'linux'), forWin = loadCatalog(CATALOG, 'windows'), forAndroid = loadCatalog(CATALOG, 'android');
  { const shipped = loadCatalog(SHIPPED, 'linux'), cats = new Set(shipped.map((m) => m.category));
    ok(shipped.length >= 93 && shipped.some((m) => m.id === 'reader') && shipped.filter((m) => m.type === 'maps').length === 51, 'the shipped catalog is the short list: ' + shipped.length + ' modules, 51 of them maps');
    ok(['maps', 'survival', 'water', 'cooking', 'electronics', 'coding', 'dictionary', 'ai'].every((c) => cats.has(c)), 'it covers maps, survival, water, cooking, electronics, coding, dictionary and AI');
    ok(!shipped.some((m) => ['cyberchef', 'kolibri', 'gardening', 'wikipedia-full', 'map-usa'].includes(m.id)), 'the niche modules are gone'); }
  ok(forLinux.length >= 93 && forLinux.some((m) => m.id === 'reader') && forWin.some((m) => m.type === 'maps'), 'desktop sees the modules including the reader and maps (' + forLinux.length + ' with the test extras)');
  ok(forAndroid.length > 15 && forAndroid.every((m) => m.type === 'content'), 'Android only sees content packs (' + forAndroid.length + ')');
  for (const bad of [{ id: '../x', type: 'content', sizeClass: 's', install: { kind: 'zim', subdir: 'a', prefix: 'b' } }, { id: 'ok1', type: 'content', sizeClass: 's', install: { kind: 'zim', subdir: '../etc', prefix: 'b' } },
    { id: 'ok2', type: 'content', sizeClass: 's', install: { kind: 'shell', cmd: 'rm -rf /' } }, { id: 'ok3', type: 'maps', sizeClass: 's', install: { kind: 'maps', file: '../x.pmtiles', maxzoom: 7 } },
    { id: 'ok4', type: 'maps', sizeClass: 's', install: { kind: 'maps', file: 'a.pmtiles', maxzoom: 7, bbox: '1,2,3' } }, { id: 'ok5', type: 'app', sizeClass: 's', install: { kind: 'app', suffixes: ['a/../b'] } },
    { id: 'ok6', type: 'content', sizeClass: 'huge', install: { kind: 'zim', subdir: 'a', prefix: 'b' } }]) {
    const f = path.join(work, 'bad.json'); fs.writeFileSync(f, JSON.stringify({ modules: [bad] }));
    let threw = false; try { loadCatalog(f, 'linux'); } catch (e) { threw = true; } ok(threw, 'rejects bad catalog entry ' + bad.id);
  }

  // ---------- install content (reader pulled in first) ----------
  reset(); ({ mgr: t, dir: c } = make());
  ok(t.catalog().every((m) => !m.installed) && t.disk().free > 0, 'starts empty');
  fs.mkdirSync(path.join(c, 'zim'), { recursive: true }); fs.writeFileSync(path.join(c, 'zim', 'zimgit-medicine_en_2024-06.zim'), 'old');
  let r = await t.handle('POST', '/install', new URLSearchParams(), { id: 'medicine' }); ok(r.code === 202, 'install is accepted');
  j = await done(t, 'medicine'); ok(j.state === 'done', 'install finished: ' + JSON.stringify(j));
  ok(fs.readFileSync(path.join(c, 'zim', 'zimgit-medicine_en_2025-03.zim')).equals(ZIM), 'file is byte-identical and passed its checksum');
  ok(!fs.existsSync(path.join(c, 'zim', 'zimgit-medicine_en_2024-06.zim')) && fs.readdirSync(path.join(c, 'zim')).every((f) => !f.endsWith('.part')), 'older edition removed, no .part left');
  ok(mod(t, 'reader').installed && mod(t, 'reader').version === '3.7.0', 'the reader was installed automatically first (newest version 3.7.0)');
  ok(fs.existsSync(path.join(c, 'reader', 'kiwix-serve')) && fs.existsSync(path.join(c, 'reader', 'libfake.so')) && (fs.statSync(path.join(c, 'reader', 'kiwix-serve')).mode & 0o111) !== 0, 'reader unpacked with its libraries, executable');
  ok(mod(t, 'medicine').installed && mod(t, 'medicine').version === '2025.03', 'catalog now shows it installed at 2025.03');

  // ---------- integrity ----------
  reset(); F.shaOk = false; ({ mgr: t, dir: c } = make()); t.enqueue('water', 'install'); j = await done(t, 'water');
  ok(j.state === 'error' && /Checksum mismatch/.test(j.message), 'bad checksum is refused'); ok(!fs.existsSync(path.join(c, 'zim')) || fs.readdirSync(path.join(c, 'zim')).length === 0, 'nothing installed, no .part left');
  reset(); F.shaMissing = true; ({ mgr: t } = make()); t.enqueue('water', 'install'); ok((await done(t, 'water')).state === 'done', 'a missing .sha256 file still installs (HTTPS)');
  reset(); ({ mgr: t, dir: c } = make()); fs.mkdirSync(path.join(c, 'zim'), { recursive: true }); fs.writeFileSync(path.join(c, 'zim', '.zimgit-medicine_en_2025-03.zim.part'), ZIM.slice(0, 100000));
  t.enqueue('medicine', 'install'); j = await done(t, 'medicine'); ok(j.state === 'done' && fs.readFileSync(path.join(c, 'zim', 'zimgit-medicine_en_2025-03.zim')).equals(ZIM), 'interrupted download resumes and ends byte-identical');
  reset(); ({ mgr: t, dir: c } = make()); fs.mkdirSync(path.join(c, 'zim'), { recursive: true }); fs.writeFileSync(path.join(c, 'zim', '.zimgit-medicine_en_2025-03.zim.part'), Buffer.alloc(100000));
  t.enqueue('medicine', 'install'); j = await done(t, 'medicine'); ok(j.state === 'error' && /Checksum/.test(j.message) && !fs.existsSync(path.join(c, 'zim', 'zimgit-medicine_en_2025-03.zim')), 'a corrupt partial file is caught by the checksum');

  // ---------- queue, space, library ----------
  reset(); ({ mgr: t } = make()); t.enqueue('medicine', 'install'); t.enqueue('water', 'install');
  let dup; try { t.enqueue('water', 'install'); } catch (e) { dup = e; } ok(dup && dup.code === 409, 'a second request for the same module is refused (409)');
  ok((await done(t, 'medicine')).state === 'done' && (await done(t, 'water')).state === 'done', 'queued installs run one after the other');
  reset(); ({ mgr: t } = make()); t.disk = () => ({ free: 1000, total: 1e9 }); t.enqueue('water', 'install'); j = await done(t, 'water'); ok(j.state === 'error' && /Not enough free space/.test(j.message), 'full disk is reported before downloading');
  reset(); ({ mgr: t } = make()); t.enqueue('gardening', 'install'); j = await done(t, 'gardening'); ok(j.state === 'error' && /not found/.test(j.message), 'not in the Kiwix library: clear message');
  reset(); ({ mgr: t, calls: c } = make()); t.enqueue('water', 'install'); await done(t, 'water'); const before = c.restarts;
  t.enqueue('water', 'remove'); ok((await done(t, 'water')).state === 'done' && !mod(t, 'water').installed && c.restarts > before, 'remove deletes it and restarts the reader');
  t.enqueue('water', 'remove'); ok((await done(t, 'water')).state === 'error', 'removing something not installed is an error');
  reset(); ({ mgr: t } = make({ onLibraryChange: async () => { throw new Error('x'); } })); t.enqueue('water', 'install'); ok((await done(t, 'water')).state === 'done', 'a reader restart failure does not fail the install');

  // ---------- reader failures ----------
  reset(); F.readerListing = false; ({ mgr: t } = make()); t.enqueue('water', 'install'); j = await done(t, 'water'); ok(j.state === 'error' && /No reader was found/.test(j.message), 'no reader for this computer: clear message, content not installed');
  reset(); ({ mgr: t, dir: c } = make({ arch: 'riscv64' })); t.enqueue('reader', 'install'); j = await done(t, 'reader'); ok(j.state === 'error' && /not available for this computer/.test(j.message), 'unsupported CPU: clear message');
  reset(); ({ mgr: t, dir: c } = make()); t.enqueue('reader', 'install'); await done(t, 'reader'); t.enqueue('reader', 'remove'); ok((await done(t, 'reader')).state === 'done' && !fs.existsSync(path.join(c, 'reader')), 'the reader can be removed');

  // ---------- sizes ----------
  reset(); ({ mgr: t } = make()); t.catalog(); await settle(t); let cat = Object.fromEntries(t.catalog().map((m) => [m.id, m]));
  ok(cat.medicine.size === ZIM.length && cat.water.size === WATER.length && cat['app-android'].size === APK.length && cat['app-windows'].size === EXE.length + PEXE.length, 'exact sizes are looked up in the background');
  ok(cat['map-world'].size === undefined && cat['gardening'].size === undefined && cat.medicine.latest === '2025.03', 'maps have no exact size; missing items have none; versions learned too');
  reset(); ({ mgr: t } = make({ kiwix: 'http://127.0.0.1:1' })); t.catalog(); await settle(t); ok(t.sizes.fail > 0, 'offline: the size lookup gives up quietly'); t.catalog(); ok(!t.sizesPending(), '...and does not retry straight away');

  // ---------- maps (downloads the pmtiles tool on first use) ----------
  reset(); ({ mgr: t, dir: c } = make()); t.enqueue('map-world', 'install'); j = await done(t, 'map-world'); ok(j.state === 'done', 'map install finished: ' + JSON.stringify(j));
  ok(fs.readFileSync(path.join(c, 'maps', 'world.pmtiles'), 'utf8').endsWith('20260301.pmtiles') && fs.existsSync(path.join(c, 'tools', 'pmtiles')), 'newest Protomaps build used; the map tool was fetched once');
  ok(fs.readdirSync(path.join(c, 'maps')).every((f) => !f.startsWith('.')), 'no temporary files left');
  process.env.FAKE_PM_FAIL = '1'; t.enqueue('map-usa', 'install'); j = await done(t, 'map-usa'); ok(j.state === 'error' && /source unreachable/.test(j.message) && fs.readdirSync(path.join(c, 'maps')).every((f) => f === 'world.pmtiles'), 'a failing extract leaves nothing behind'); delete process.env.FAKE_PM_FAIL;
  reset(); ({ mgr: t } = make({ arch: 'mips' })); t.enqueue('map-world', 'install'); j = await done(t, 'map-world'); ok(j.state === 'error' && /not available for this computer/.test(j.message), 'maps on an unsupported CPU: clear message');

  // ---------- apps ----------
  reset(); ({ mgr: t, dir: c } = make()); fs.mkdirSync(path.join(c, 'apps'), { recursive: true }); fs.writeFileSync(path.join(c, 'apps', 'NorwinPrep-0.6.1-win-x64.exe'), 'old');
  t.enqueue('app-windows', 'install'); j = await done(t, 'app-windows'); ok(j.state === 'done' && JSON.stringify(fs.readdirSync(path.join(c, 'apps')).sort()) === JSON.stringify(['NorwinPrep-0.6.9-portable-x64.exe', 'NorwinPrep-0.6.9-win-x64.exe']), 'app files installed, older version replaced');
  reset(); F.apkSumOk = false; ({ mgr: t, dir: c } = make()); t.enqueue('app-android', 'install'); j = await done(t, 'app-android'); ok(j.state === 'error' && /Checksum mismatch/.test(j.message), 'app with a bad checksum is refused');
  reset(); ({ mgr: t } = make()); t.enqueue('app-pi64', 'install'); j = await done(t, 'app-pi64'); ok(j.state === 'error' && /no linux-arm64/.test(j.message), 'app missing from the release: clear message');
  reset(); ({ mgr: t, dir: c } = make()); fs.mkdirSync(path.join(c, 'apps'), { recursive: true }); fs.writeFileSync(path.join(c, 'apps', 'NorwinPrep-0.6.1-android.apk'), 'x'); await t.refresh(); const m0 = mod(t, 'app-android');
  ok(m0.version === '0.6.1' && m0.latest === '0.6.9' && m0.updateAvailable === true, 'app update detected');

  // ---------- info / API ----------
  reset(); ({ mgr: t } = make()); const i1 = await t.info('medicine'); ok(i1.file === 'zimgit-medicine_en_2025-03.zim' && i1.bytes === ZIM.length && i1.free > 0, 'info: file, version, size, free space');
  let e1; try { await t.info('nope'); } catch (e) { e1 = e; } ok(e1 && e1.code === 404, 'info: unknown module is 404');
  r = await t.handle('GET', '/info', new URLSearchParams('id=gardening'), null); ok(r.code === 404 && /not found in the Kiwix library/.test(r.body.error), 'info through the API: missing item explained');
  ({ mgr: t } = make({ kiwix: 'http://127.0.0.1:1' })); r = await t.handle('GET', '/info', new URLSearchParams('id=medicine'), null); ok(r.code === 502 && /Could not reach/.test(r.body.error), 'info while offline: clean 502');
  ok((await t.handle('POST', '/pin', new URLSearchParams(), {})).code === 200 && (await t.handle('GET', '/nope', new URLSearchParams(), null)).code === 404 && (await t.handle('POST', '/install', new URLSearchParams(), { id: '../../x' })).code === 404, 'API: pin ok, unknown route 404, hostile id 404');
  ({ mgr: t } = make()); ok((await t.handle('POST', '/refresh', new URLSearchParams(), {})).code === 200 && (await t.handle('POST', '/refresh', new URLSearchParams(), {})).code === 429, 'refresh is throttled');


  // ---------- tools: CyberChef (a web app from a GitHub release) and Notes (built in) ----------
  reset(); const bundled = fs.mkdtempSync(path.join(os.tmpdir(), 'npbundled-')); fs.mkdirSync(path.join(bundled, 'notes')); fs.writeFileSync(path.join(bundled, 'notes', 'index.html'), '<title>NOTES</title>');
  ({ mgr: t, dir } = make({ bundledDir: bundled }));
  r = await t.handle('GET', '/info', new URLSearchParams('id=cyberchef'), null); ok(r.code === 200 && r.body.file === 'CyberChef_v10.0.0.zip' && r.body.version === '10.0.0' && r.body.bytes > 100, 'CyberChef info: newest release asset, version and size');
  ok(t.siteRoot('cyberchef') === null, 'not installed: nothing is served');
  t.enqueue('cyberchef', 'install'); j = await done(t, 'cyberchef'); ok(j.state === 'done', 'CyberChef installs: ' + j.message);
  const cc = t.siteRoot('cyberchef'); ok(cc && fs.existsSync(path.join(cc, 'CyberChef_v10.0.0.html')) && fs.existsSync(path.join(cc, 'assets', 'app.js')), 'its files were unpacked');
  ok(mod(t, 'cyberchef').installed && mod(t, 'cyberchef').version === '10.0.0' && mod(t, 'cyberchef').open === '/tools/cyberchef/' && mod(t, 'cyberchef').category === 'tools', 'the store sees it installed, with its Open link and category');
  ok(t.listSites().some((x) => x.id === 'cyberchef' && x.path === '/tools/cyberchef/'), 'it is offered to devices on the shared Wi-Fi');
  t.enqueue('cyberchef', 'remove'); j = await done(t, 'cyberchef'); ok(j.state === 'done' && t.siteRoot('cyberchef') === null && !fs.existsSync(path.join(dir, 'sites', 'cyberchef')), 'remove deletes it');
  F.cyber = 'folder'; t.enqueue('cyberchef', 'install'); j = await done(t, 'cyberchef'); ok(j.state === 'done' && fs.existsSync(path.join(t.siteRoot('cyberchef'), 'index.html')), 'a zip wrapped in one folder is served from inside that folder');
  t.enqueue('cyberchef', 'remove'); await done(t, 'cyberchef');
  F.cyber = 'evil'; t.enqueue('cyberchef', 'install'); j = await done(t, 'cyberchef');
  ok(j.state === 'error' && /unsafe path/.test(j.message) && t.siteRoot('cyberchef') === null && !fs.existsSync(path.join(dir, 'sites', 'evil.txt')) && !fs.existsSync(path.join(dir, 'evil.txt')), 'a zip that tries to write outside its folder is refused and writes nothing: ' + j.message);
  F.cyber = 'good'; F.cyberDigest = 'wrong'; t.enqueue('cyberchef', 'install'); j = await done(t, 'cyberchef'); ok(j.state === 'error' && /checksum|corrupt/i.test(j.message) && t.siteRoot('cyberchef') === null, 'a download that fails the published SHA-256 is rejected: ' + j.message);
  F.cyberDigest = false; t.enqueue('cyberchef', 'install'); j = await done(t, 'cyberchef'); ok(j.state === 'done', 'without a published digest it still installs (HTTPS only)');
  { const re = new RegExp(JSON.parse(fs.readFileSync(CATALOG, 'utf8')).modules.find((m) => m.id === 'cyberchef').install.asset); ok(re.test('CyberChef_v11.0.0.zip') && re.test('CyberChef_d24ba1afce2e3a080308b5df7db033332fe94a1a.zip') && !re.test('CyberChef_x.zip') && !re.test('CyberChef_v1.zip.exe'), 'the CyberChef file-name pattern accepts both release naming styles (version, or commit hash) and nothing else'); }
  ok(t.siteRoot('notes') === null, 'Notes: off until installed');
  t.enqueue('notes', 'install'); j = await done(t, 'notes'); ok(j.state === 'done' && t.siteRoot('notes') === path.join(bundled, 'notes') && mod(t, 'notes').installed, 'Notes: installing switches on the built-in page (nothing is downloaded)');
  t.enqueue('notes', 'remove'); await done(t, 'notes'); ok(t.siteRoot('notes') === null && !mod(t, 'notes').installed, 'Notes: remove switches it off');
  { const u = make({ nomadMaps: 'http://127.0.0.1:' + server.address().port }), t2 = u.mgr;
    t2.enqueue('map-alaska', 'install'); j = await done(t2, 'map-alaska'); ok(j.state === 'done' && fs.existsSync(path.join(u.dir, 'maps', 'alaska.pmtiles')) && mod(t2, 'map-alaska').installed, 'a NOMAD state map downloads, passes the PMTiles check and shows as installed');
    t2.enqueue('map-hawaii', 'install'); j = await done(t2, 'map-hawaii'); ok(j.state === 'error' && !fs.existsSync(path.join(u.dir, 'maps', 'hawaii.pmtiles')) && fs.readdirSync(path.join(u.dir, 'maps')).filter((f) => /hawaii/.test(f)).length === 0, 'a download that is not a PMTiles file is discarded: ' + j.message);
    t2.enqueue('map-alaska', 'remove'); await done(t2, 'map-alaska'); ok(!fs.existsSync(path.join(u.dir, 'maps', 'alaska.pmtiles')), 'a NOMAD state map can be removed'); }
  { const u = make({}), q = u.mgr; q.enqueue('water', 'install'); q.enqueue('medicine', 'install'); q.enqueue('notes', 'install');
    let r = await q.handle('POST', '/cancel', new URLSearchParams(), { id: 'notes' }); ok(r.code === 200 && !q.jobs.notes && !q.queue.some((x) => x[0] === 'notes'), 'a waiting download can be taken out of the queue');
    const run = Object.keys(q.jobs).find((k) => q.jobs[k].state === 'running'); r = await q.handle('POST', '/cancel', new URLSearchParams(), { id: run || 'water' }); ok(r.code === 409, 'one that is already downloading cannot be removed: ' + JSON.stringify(r.body));
    r = await q.handle('POST', '/cancel', new URLSearchParams(), { id: 'nothing' }); ok(r.code === 409, 'cancelling something that is not queued is refused');
    ok(q.catalog().filter((m) => m.job).every((m) => typeof m.job.t === 'number'), 'jobs carry their start time so the store can order the queue');
    await done(q, 'water'); await done(q, 'medicine'); }
  { const http = require('http'); let hits = 0, hits404 = 0;
    const flaky = http.createServer((q, r) => { if (q.url === '/gone') { hits404++; r.writeHead(404); return r.end(); } hits++; if (hits <= 2) { r.writeHead(503); return r.end(); } r.writeHead(200, { 'Content-Length': 2 }); r.end('ok'); });
    await new Promise((res) => flaky.listen(0, '127.0.0.1', res)); const u = make({ kiwix: 'http://127.0.0.1:' + flaky.address().port }); let size = null, err = null;
    try { size = await u.mgr.text('http://127.0.0.1:' + flaky.address().port + '/x'); } catch (e) { err = e; } ok(!err && size === 'ok' && hits === 3, 'a server that answers 503 twice and then works is retried and succeeds (' + hits + ' tries)');
    try { await u.mgr.text('http://127.0.0.1:' + flaky.address().port + '/gone'); } catch (e) { err = e; } ok(err && err.status === 404 && hits404 === 1, 'a 404 is final and is not retried');
    flaky.close(); }
  { // the packaged app passes env-var overrides as undefined when they are not set: that must keep the real server addresses
    const u = new Manager({ catalog: CATALOG, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'npundef-')), kiwix: undefined, githubApi: undefined, githubDl: undefined, protomaps: undefined, hf: undefined, pypi: undefined });
    ok(u.cfg.kiwix === 'https://download.kiwix.org' && u.cfg.githubApi === 'https://api.github.com' && u.cfg.githubDl === 'https://github.com' && u.cfg.protomaps === 'https://build.protomaps.com' && u.cfg.hf === 'https://huggingface.co' && u.cfg.pypi === 'https://pypi.org', 'unset server options keep their real defaults (no "undefined/..." download addresses)');
    ok(u.zimBase(u.byid.water) === 'https://download.kiwix.org/zim/other/', 'a pack is looked up at the real Kiwix address: ' + u.zimBase(u.byid.water)); }
  { const cat = JSON.parse(fs.readFileSync(CATALOG, 'utf8')), ids = new Set(cat.modules.map((m) => m.id)); ok(cat.tiers.length === 3 && cat.tiers.every((x) => x.modules.every((id) => ids.has(id))), 'every module named in the quick-setup tiers exists');
    ok((() => { const model = new Set(cat.modules.filter((m) => m.type === 'model').map((m) => m.id)), content = (t) => t.modules.filter((id) => !model.has(id));   // the AI model is swapped for a bigger one in each tier, not piled up
      return cat.tiers[0].modules.length < cat.tiers[1].modules.length && cat.tiers[1].modules.length < cat.tiers[2].modules.length && content(cat.tiers[0]).every((id) => cat.tiers[1].modules.includes(id)) && content(cat.tiers[1]).every((id) => cat.tiers[2].modules.includes(id)); })(), 'tiers grow: Essential is inside Standard, Standard has more'); }

  server.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
