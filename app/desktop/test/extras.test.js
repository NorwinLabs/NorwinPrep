'use strict';
// Run: node test/extras.test.js. Settings, pausing downloads on battery, scheduled updates, the storage list, and copying a library to / from a drive.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { Manager } = require('../modules-manager');
const { Settings } = require('../settings');
const T = require('../library-transfer');
const { merged } = require('./catalog-merged');
const { F, server, ZIM } = require('./fixtures');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL ' + m); } else console.log('ok   ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const put = (root, rel, body) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const b = 'http://127.0.0.1:' + server.address().port;
  // ---------- settings ----------
  { const d = tmp('npset-'), s = new Settings(d);
    ok(JSON.stringify(s.get()) === '{"autoUpdate":false,"autoUpdateHour":3,"autoUpdateMaxGB":2,"pauseOnBattery":false}', 'defaults: everything off');
    s.set({ autoUpdate: true, autoUpdateHour: 2 }); ok(new Settings(d).get().autoUpdate === true && new Settings(d).get().autoUpdateHour === 2, 'settings are remembered');
    for (const bad of [{ autoUpdateHour: 24 }, { autoUpdate: 'yes' }, { nope: 1 }, { autoUpdateMaxGB: -1 }, null]) { let e; try { s.set(bad); } catch (x) { e = x; } ok(e, 'refused: ' + JSON.stringify(bad)); }
    fs.writeFileSync(path.join(d, 'settings.json'), '{"autoUpdate":"x","autoUpdateHour":99,"pauseOnBattery":true}'); ok(JSON.stringify(new Settings(d).get()) === '{"autoUpdate":false,"autoUpdateHour":3,"autoUpdateMaxGB":2,"pauseOnBattery":true}', 'a damaged settings file falls back to defaults per setting'); }

  // ---------- pause downloads on battery ----------
  { let battery = true; const lib = tmp('npbat-'), mk = () => new Manager({ catalog: merged(), dataDir: lib, githubApi: b, githubDl: b, kiwix: b, hf: b, pypi: b, platform: 'linux', arch: 'x64', timeout: 5000, onBattery: () => battery, powerPollMs: 30 });
    const m = mk(); const jobs = async (id, st, ms) => { for (let i = 0; i < ms / 20; i++) { const j = m.jobs[id]; if (j && st(j)) return j; await sleep(20); } return m.jobs[id]; };
    m.handle('POST', '/settings', new URLSearchParams(), { set: { pauseOnBattery: true } }); m.enqueue('water', 'install');
    let j = await jobs('water', (x) => /Paused/.test(x.message), 3000); ok(j.state === 'running' && /Paused: running on battery/.test(j.message), 'on battery the download waits and says why');
    ok(!fs.existsSync(path.join(lib, 'zim')) || fs.readdirSync(path.join(lib, 'zim')).length === 0, '...and has not started downloading');
    battery = false; j = await jobs('water', (x) => x.state === 'done' || x.state === 'error', 8000); ok(j.state === 'done', 'it continues by itself when plugged in: ' + j.message);
    battery = true; m.enqueue('water', 'remove'); j = await jobs('water', (x) => x.action === 'remove' && (x.state === 'done' || x.state === 'error'), 3000); ok(j.state === 'done', 'removing is never held back');
    m.enqueue('water', 'install'); await jobs('water', (x) => /Paused/.test(x.message), 3000); const r = await m.handle('POST', '/force-start', new URLSearchParams(), { id: 'water' }); ok(r.code === 200, '"Download anyway" is accepted');
    j = await jobs('water', (x) => x.state === 'done' || x.state === 'error', 8000); ok(j.state === 'done', 'and the download runs on battery');
    m.settings.set({ pauseOnBattery: false }); m.enqueue('notes', 'install'); j = await jobs('notes', (x) => x.state === 'done' || x.state === 'error', 3000); ok(j.state === 'done', 'with the setting off, battery makes no difference'); }

  // ---------- scheduled updates ----------
  { let battery = false; const lib = tmp('npupd-'), mk = () => new Manager({ catalog: merged(), dataDir: lib, githubApi: b, githubDl: b, kiwix: b, hf: b, pypi: b, platform: 'linux', arch: 'x64', timeout: 5000, onBattery: () => battery });
    put(lib, 'zim/zimgit-medicine_en_2024-06.zim', 'old'); let m = mk(); const wait = async (id) => { for (let i = 0; i < 400; i++) { const j = m.jobs[id]; if (j && (j.state === 'done' || j.state === 'error')) return j; await sleep(25); } return m.jobs[id]; };
    let r = await m.autoUpdate(); ok(r.started.length === 0 && /off/.test(r.note), 'off by default: nothing happens');
    m.settings.set({ autoUpdate: true }); battery = true; r = await m.autoUpdate(); ok(r.started.length === 0 && /battery/.test(r.note), 'never runs on battery');
    battery = false; r = await m.autoUpdate({ maxGB: 0.000000001 }); ok(r.started.length === 0 && /Too large for the limit/.test(r.note), 'a module bigger than the size limit is left alone and named');
    m = mk(); m.settings.set({ autoUpdate: true }); r = await m.autoUpdate(); ok(r.started.includes('medicine'), 'an older edition is updated: ' + r.note);
    ok((await wait('medicine')).state === 'done' && fs.existsSync(path.join(lib, 'zim', 'zimgit-medicine_en_2025-03.zim')) && !fs.existsSync(path.join(lib, 'zim', 'zimgit-medicine_en_2024-06.zim')), 'the new edition replaced the old one');
    ok(m.settings.last && m.settings.last.started.includes('medicine'), 'what happened is remembered for the store to show');
    m.settings.set({ autoUpdate: true, autoUpdateHour: 3 }); const at = (h, extra) => new Date(2026, 0, 10, h, 0, 0).getTime() + (extra || 0);
    m.settings.last = null; ok(m.autoUpdateDue(at(3)) && m.autoUpdateDue(at(5)) && !m.autoUpdateDue(at(6)) && !m.autoUpdateDue(at(14)), 'it is due only in the three night hours chosen (3:00 to 5:59)');
    m.settings.last = { t: at(3), started: [], note: '' }; ok(!m.autoUpdateDue(at(4)), '...and only once a day');
    m.settings.set({ autoUpdate: false }); m.settings.last = null; ok(!m.autoUpdateDue(at(3)), '...and never when switched off');
    const rr = await m.handle('POST', '/autoupdate', new URLSearchParams(), {}); ok(rr.code === 200 && Array.isArray(rr.body.started), '"Update now" works from the store'); }

  // ---------- storage list ----------
  { const lib = tmp('npsto-'), m = new Manager({ catalog: merged(), dataDir: lib, githubApi: b, githubDl: b, kiwix: b, platform: 'linux', arch: 'x64', timeout: 5000 });
    m.enqueue('water', 'install'); for (let i = 0; i < 300 && !(m.jobs.water.state === 'done'); i++) await sleep(25); m.enqueue('notes', 'install'); for (let i = 0; i < 100 && m.jobs.notes.state !== 'done'; i++) await sleep(25);
    const st = (await m.handle('GET', '/storage', new URLSearchParams(), null)).body; ok(st.items.length >= 2 && st.items[0].bytes >= st.items[st.items.length - 1].bytes && st.used > 0 && st.disk.free > 0, 'storage lists what is installed, biggest first, with the total used (' + st.items.map((x) => x.id).join(', ') + ')'); }

  // ---------- copying a library ----------
  const A = tmp('npA-'), rnd = (n) => crypto.randomBytes(n);
  const zim = rnd(300000), gguf = rnd(100000), blob = rnd(50000), hex = crypto.createHash('sha256').update(blob).digest('hex');
  put(A, 'zim/medicine_en_2025-03.zim', zim); put(A, 'maps/alaska.pmtiles', Buffer.concat([Buffer.from('PMTiles'), rnd(2000)])); put(A, 'apps/NorwinPrep-1-android.apk', rnd(1000)); put(A, 'sites/notes/.installed', '{}'); put(A, 'sites/cyber/assets/app.js', 'x');
  put(A, 'ai/models/tiny.gguf', gguf); put(A, 'ai/ollama-models/blobs/sha256-' + hex, blob); put(A, 'ai/ollama-models/manifests/registry.ollama.ai/library/qwen2.5/0.5b', '{"layers":[]}');
  put(A, 'zim/.partial.zim.part', 'half'); put(A, 'reader/kiwix-serve', 'program'); put(A, 'ai/engine/llama-server', 'program'); put(A, 'settings.json', '{}'); put(A, 'zim/notes.txt', 'not a pack'); put(A, 'ai/models/.dl-123/x.gguf', 'tmp');
  try { fs.symlinkSync('/etc/passwd', path.join(A, 'zim', 'link.zim')); } catch (e) { /* no symlinks */ }
  const files = T.listLibrary(A).map((f) => f.rel).sort(); ok(JSON.stringify(files) === JSON.stringify(['ai/models/tiny.gguf', 'ai/ollama-models/blobs/sha256-' + hex, 'ai/ollama-models/manifests/registry.ollama.ai/library/qwen2.5/0.5b', 'apps/NorwinPrep-1-android.apk', 'maps/alaska.pmtiles', 'sites/cyber/assets/app.js', 'sites/notes/.installed', 'zim/medicine_en_2025-03.zim'].sort()), 'only portable content is listed (no programs, settings, partial downloads, links or other file types): ' + files.length + ' files');
  const USB = tmp('npusb-'); let ticks = 0, lastPct = 0; let r = await T.exportLibrary(A, USB, (d, t) => { ticks++; lastPct = Math.floor(d * 100 / t); });
  ok(r.files === 8 && r.copied === 8 && ticks > 0 && lastPct === 100 && fs.readFileSync(path.join(USB, 'NorwinPrepLibrary', 'zim', 'medicine_en_2025-03.zim')).equals(zim), 'export copies every file byte for byte, with progress');
  const man = JSON.parse(fs.readFileSync(path.join(USB, 'NorwinPrepLibrary', 'manifest.json'), 'utf8')); ok(man.app === 'norwinprep-library' && man.files.length === 8, 'and writes a manifest');
  ok(!fs.existsSync(path.join(USB, 'NorwinPrepLibrary', 'reader')) && !fs.existsSync(path.join(USB, 'NorwinPrepLibrary', 'settings.json')) && !fs.readdirSync(path.join(USB, 'NorwinPrepLibrary', 'zim')).some((f) => /part|notes|link/.test(f)), 'programs and junk are not copied');
  r = await T.exportLibrary(A, USB); ok(r.copied === 0 && r.skipped === 8, 'copying again skips what is already there (an interrupted copy resumes)');
  const B = tmp('npB-'); let seen = 0; r = await T.importLibrary(B, USB, () => { seen++; }); ok(r.copied === 8 && fs.readFileSync(path.join(B, 'zim', 'medicine_en_2025-03.zim')).equals(zim) && fs.readFileSync(path.join(B, 'ai', 'ollama-models', 'blobs', 'sha256-' + hex)).equals(blob) && seen > 0, 'import from the drive (or its NorwinPrepLibrary folder) restores everything');
  ok(T.listLibrary(B).length === 8 && !fs.readdirSync(path.join(B, 'zim')).some((f) => f.endsWith('.part')), 'no partial files are left');
  // a hostile or damaged library: nothing outside the allow-list is ever written
  { const EVIL = tmp('npevil-'), root = path.join(EVIL, 'NorwinPrepLibrary'); put(root, 'zim/ok.zim', 'fine'); put(root, 'reader/kiwix-serve', 'evil'); put(root, 'zim/a.txt', 'x'); fs.mkdirSync(path.join(EVIL, 'outside'), { recursive: true }); fs.writeFileSync(path.join(EVIL, 'outside', 'x.zim'), 'x');
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ app: 'norwinprep-library', version: 1, files: [{ p: 'zim/ok.zim' }, { p: '../outside/x.zim' }, { p: 'zim/../../outside/x.zim' }, { p: 'reader/kiwix-serve' }, { p: 'zim/a.txt' }, { p: '/etc/passwd' }, { p: 'zim\\evil.zim' }, { p: 5 }, null]}));
    const C = tmp('npC-'); r = await T.importLibrary(C, EVIL); ok(r.copied === 1 && fs.existsSync(path.join(C, 'zim', 'ok.zim')) && !fs.existsSync(path.join(C, 'reader')) && !fs.existsSync(path.join(path.dirname(C), 'outside')) && !fs.existsSync(path.join(C, 'zim', 'a.txt')), 'a manifest that points outside the allow-list (.., programs, other file types, absolute paths) is ignored, only the valid file is copied');
    let e; try { await T.importLibrary(tmp('npD-'), tmp('npEmpty-')); } catch (x) { e = x; } ok(e && /not a NorwinPrep library/.test(e.message), 'a folder that is not a library is explained');
    try { e = null; await T.exportLibrary(tmp('npEmptyLib-'), tmp('npUsb2-')); } catch (x) { e = x; } ok(e && /nothing to copy/.test(e.message), 'copying an empty library says so'); }
  { const USB3 = tmp('npusb3-'); let cancelAt = false; let e; try { await T.exportLibrary(A, USB3, (d, t) => { cancelAt = d > 100000; }, () => cancelAt); } catch (x) { e = x; }
    ok(e && e.cancelled && !fs.readdirSync(path.join(USB3, 'NorwinPrepLibrary', 'zim')).some((f) => f.endsWith('.part')), 'cancelling stops the copy and leaves no half-written file'); }

  // ---------- through the manager (the store's buttons) ----------
  { const lib = A, m = new Manager({ catalog: merged(), dataDir: lib, githubApi: b, githubDl: b, kiwix: b, platform: 'linux', arch: 'x64', timeout: 5000 });
    let r1 = await m.handle('POST', '/transfer', new URLSearchParams(), { action: 'export' }); ok(r1.code === 500 || r1.code === 501 || r1.code === 400, 'without the desktop folder chooser the copy is refused (' + r1.code + ')');
    const dest = tmp('npusb4-'); let libChanged = 0; const m2 = new Manager({ catalog: merged(), dataDir: A, githubApi: b, githubDl: b, kiwix: b, platform: 'linux', arch: 'x64', timeout: 5000, pickFolder: async () => dest, onLibraryChange: async () => { libChanged++; } });
    r1 = await m2.handle('POST', '/transfer', new URLSearchParams(), { action: 'export' }); ok(r1.code === 202 && r1.body.state === 'running', 'the store starts an export');
    for (let i = 0; i < 200 && m2.xfer.state === 'running'; i++) await sleep(25); ok(m2.xfer.state === 'done' && /Copied 8 files/.test(m2.xfer.message) && m2.status().transfer.state === 'done', 'it finishes and says what it did: ' + m2.xfer.message);
    const lib2 = tmp('npE-'); const m3 = new Manager({ catalog: merged(), dataDir: lib2, githubApi: b, githubDl: b, kiwix: b, platform: 'linux', arch: 'x64', timeout: 5000, pickFolder: async () => dest, onLibraryChange: async () => { libChanged++; } });
    await m3.handle('POST', '/transfer', new URLSearchParams(), { action: 'import' }); for (let i = 0; i < 200 && m3.xfer.state === 'running'; i++) await sleep(25);
    ok(m3.xfer.state === 'done' && libChanged === 1 && m3.catalog().find((x) => x.id === 'medicine' || true), 'import finishes and the reader is told the library changed');
    const m4 = new Manager({ catalog: merged(), dataDir: lib2, githubApi: b, githubDl: b, kiwix: b, platform: 'linux', arch: 'x64', pickFolder: async () => null }); r1 = await m4.handle('POST', '/transfer', new URLSearchParams(), { action: 'import' }); ok(r1.code === 409 && /No folder/.test(r1.body.error), 'closing the folder chooser cancels quietly');
    r1 = await m4.handle('POST', '/transfer', new URLSearchParams(), { action: 'rm -rf' }); ok(r1.code === 400, 'an unknown action is refused'); }

  server.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
