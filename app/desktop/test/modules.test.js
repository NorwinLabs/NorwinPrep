'use strict';
// Run: node test/modules.test.js   (no Electron needed)
const fs = require('fs'), os = require('os'), path = require('path');
const { Manager, loadCatalog } = require('../modules-manager');
const { ZIM, WATER, APK, EXE, PEXE, F, server, work } = require('./fixtures');
const CATALOG = path.join(__dirname, '..', '..', 'shared', 'site', 'catalog.json');
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
const reset = () => { Object.assign(F, { shaOk: true, shaMissing: false, newZim: '2025-03', tag: 'v0.6.9', apkSumOk: true, readerListing: true }); delete process.env.FAKE_PM_FAIL; };

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let t, j, c;

  // ---------- catalog ----------
  const forLinux = loadCatalog(CATALOG, 'linux'), forWin = loadCatalog(CATALOG, 'windows'), forAndroid = loadCatalog(CATALOG, 'android');
  ok(forLinux.length === 46 && forLinux.some((m) => m.id === 'reader') && forWin.some((m) => m.type === 'maps'), 'desktop sees all 46 modules including the reader and maps');
  ok(forAndroid.length > 30 && forAndroid.every((m) => m.type === 'content'), 'Android only sees content packs (' + forAndroid.length + ')');
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
  reset(); ({ mgr: t } = make()); t.enqueue('survival-se', 'install'); j = await done(t, 'survival-se'); ok(j.state === 'error' && /not found/.test(j.message), 'not in the Kiwix library: clear message');
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
  ok(cat['map-world'].size === undefined && cat['survival-se'].size === undefined && cat.medicine.latest === '2025.03', 'maps have no exact size; missing items have none; versions learned too');
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
  r = await t.handle('GET', '/info', new URLSearchParams('id=survival-se'), null); ok(r.code === 404 && /not found in the Kiwix library/.test(r.body.error), 'info through the API: missing item explained');
  ({ mgr: t } = make({ kiwix: 'http://127.0.0.1:1' })); r = await t.handle('GET', '/info', new URLSearchParams('id=medicine'), null); ok(r.code === 502 && /Could not reach/.test(r.body.error), 'info while offline: clean 502');
  ok((await t.handle('POST', '/pin', new URLSearchParams(), {})).code === 200 && (await t.handle('GET', '/nope', new URLSearchParams(), null)).code === 404 && (await t.handle('POST', '/install', new URLSearchParams(), { id: '../../x' })).code === 404, 'API: pin ok, unknown route 404, hostile id 404');
  ({ mgr: t } = make()); ok((await t.handle('POST', '/refresh', new URLSearchParams(), {})).code === 200 && (await t.handle('POST', '/refresh', new URLSearchParams(), {})).code === 429, 'refresh is throttled');

  server.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
