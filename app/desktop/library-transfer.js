'use strict';
// Copy a library to a USB drive or folder, or load one from there, so another computer can be set up without internet.
// Only portable content moves: content packs, maps, AI models, built-in tools and app installers. Programs (reader, AI engines) differ by
// operating system and are downloaded again on the other machine. Everything read from a folder is checked against an allow-list first.
const fs = require('fs');
const path = require('path');

const NAME = 'NorwinPrepLibrary';
// allowed relative paths (forward slashes), nothing else is ever copied in
const ALLOW = [
  /^zim\/[A-Za-z0-9][A-Za-z0-9._-]*\.zim$/,
  /^maps\/[A-Za-z0-9][A-Za-z0-9._-]*\.pmtiles$/,
  /^apps\/[A-Za-z0-9][A-Za-z0-9._-]*$/,
  /^sites\/[a-z0-9-]+\/\.installed$/,
  /^sites\/[a-z0-9-]+\/(?:[A-Za-z0-9._ -]+\/){0,6}[A-Za-z0-9._ -]+$/,
  /^ai\/models\/[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/,
  /^ai\/ollama-models\/blobs\/sha256-[0-9a-f]{64}$/,
  /^ai\/ollama-models\/manifests\/registry\.ollama\.ai\/(?:[a-z0-9][a-z0-9._-]*\/){1,2}[A-Za-z0-9][A-Za-z0-9._-]*$/,
];
const allowed = (rel) => !rel.includes('..') && !rel.startsWith('/') && !rel.includes('\\') && ALLOW.some((r) => r.test(rel));

function listLibrary(dataDir) {       // [{ rel, size }] of everything that can be transferred from a library folder
  const out = [];
  const walk = (dir, rel) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') && e.name !== '.installed') continue;           // partial downloads and temp folders
      const p = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p, r); else if (e.isFile() && allowed(r)) { try { out.push({ rel: r, size: fs.statSync(p).size }); } catch (x) { /* vanished */ } }
    }
  };
  for (const top of ['zim', 'maps', 'apps', 'sites', 'ai/models', 'ai/ollama-models']) walk(path.join(dataDir, ...top.split('/')), top);
  return out;
}

function copyFile(src, dst, onBytes, isCancelled) {      // to a .part file first, so a pulled-out USB stick never leaves a broken file that looks finished
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const part = dst + '.part', rd = fs.createReadStream(src), wr = fs.createWriteStream(part);
    let fail = (e) => { rd.destroy(); wr.destroy(); try { fs.unlinkSync(part); } catch (x) { /* none */ } reject(e); };
    rd.on('data', (c) => { onBytes(c.length); if (isCancelled()) fail(Object.assign(new Error('Cancelled'), { cancelled: true })); });
    rd.on('error', fail); wr.on('error', fail);
    wr.on('finish', () => { try { fs.renameSync(part, dst); resolve(); } catch (e) { fail(e); } });
    rd.pipe(wr);
  });
}

async function run(files, srcRoot, dstRoot, onProgress, isCancelled) {
  const total = files.reduce((a, f) => a + f.size, 0); let done = 0, copied = 0, skipped = 0;
  for (const f of files) {
    if (isCancelled()) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    const dst = path.join(dstRoot, ...f.rel.split('/'));
    let have = -1; try { have = fs.statSync(dst).size; } catch (e) { /* new */ }
    if (have === f.size) { done += f.size; skipped++; onProgress(done, total, f.rel); continue; }       // already there: an interrupted copy resumes by skipping finished files
    await copyFile(path.join(srcRoot, ...f.rel.split('/')), dst, (n) => { done += n; onProgress(done, total, f.rel); }, isCancelled); copied++;
  }
  return { files: files.length, copied, skipped, bytes: total };
}

function freeBytes(dir) { try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch (e) { return Number.MAX_SAFE_INTEGER; } }

async function exportLibrary(dataDir, destDir, onProgress, isCancelled) {
  const files = listLibrary(dataDir); if (!files.length) throw new Error('There is nothing to copy yet: install some modules first.');
  const root = path.join(destDir, NAME); fs.mkdirSync(root, { recursive: true });
  const need = files.reduce((a, f) => { let have = 0; try { have = fs.statSync(path.join(root, ...f.rel.split('/'))).size; } catch (e) { /* new */ } return a + (have === f.size ? 0 : f.size); }, 0);
  if (need > freeBytes(root)) throw new Error('Not enough free space there: ' + Math.ceil(need / 1048576) + ' MB are needed.');
  const r = await run(files, dataDir, root, onProgress || (() => {}), isCancelled || (() => false));
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ app: 'norwinprep-library', version: 1, created: new Date().toISOString(), files: files.map((f) => ({ p: f.rel, size: f.size })) }));
  return r;
}

async function importLibrary(dataDir, fromDir, onProgress, isCancelled) {
  let root = fromDir; if (!fs.existsSync(path.join(root, 'manifest.json')) && fs.existsSync(path.join(root, NAME, 'manifest.json'))) root = path.join(root, NAME);
  let man; try { man = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')); } catch (e) { throw new Error('That folder is not a NorwinPrep library (no manifest.json). Choose the ' + NAME + ' folder, or the drive it is on.'); }
  if (!man || man.app !== 'norwinprep-library' || !Array.isArray(man.files)) throw new Error('That folder is not a NorwinPrep library.');
  const files = [];
  for (const f of man.files.slice(0, 200000)) {
    if (!f || typeof f.p !== 'string' || !allowed(f.p)) continue;                  // anything outside the allow-list is ignored, never copied
    const src = path.join(root, ...f.p.split('/')); let st; try { st = fs.lstatSync(src); } catch (e) { continue; }
    if (!st.isFile()) continue; files.push({ rel: f.p, size: st.size });
  }
  if (!files.length) throw new Error('There is nothing usable in that library.');
  const need = files.reduce((a, f) => { let have = 0; try { have = fs.statSync(path.join(dataDir, ...f.rel.split('/'))).size; } catch (e) { /* new */ } return a + (have === f.size ? 0 : f.size); }, 0);
  fs.mkdirSync(dataDir, { recursive: true }); if (need > freeBytes(dataDir)) throw new Error('Not enough free space on this device: ' + Math.ceil(need / 1048576) + ' MB are needed.');
  return run(files, root, dataDir, onProgress || (() => {}), isCancelled || (() => false));
}

module.exports = { NAME, allowed, listLibrary, exportLibrary, importLibrary };
