'use strict';
// Module manager for the desktop app: lists, installs, updates and removes modules (Kiwix content packs, map regions,
// client apps and the reader tool) into the app's own library folder. A Node port of scripts/modules-api.py, with the same
// API shapes, so the same Module Store page drives both. Nothing from the catalog is ever executed: install kinds are a
// fixed allowlist with validated fields, and every download is checked (SHA-256) before it replaces anything.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const TAG_RE = /^v\d+\.\d+\.\d+$/;
const ASSET_RE = /^NorwinPrep-[A-Za-z0-9._-]+\.(apk|exe|AppImage|deb)$/;
const UA = { 'User-Agent': 'NorwinPrep-modules' };

class ApiError extends Error { constructor(code, msg) { super(msg); this.code = code; this.msg = msg; } }
class HttpError extends Error { constructor(status, url) { super('HTTP ' + status); this.status = status; this.url = url; } }

const human = (n) => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; n = Number(n); while (n >= 1024 && i < 4) { n /= 1024; i++; } return i === 0 ? n.toFixed(0) + ' B' : n.toFixed(1) + ' ' + u[i]; };
const vkey = (v) => (String(v || '').match(/\d+/g) || []).map(Number);
const vgt = (a, b) => { const x = vkey(a), y = vkey(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
const { unzip } = require('./unzip');
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- catalog
function loadCatalog(file, platform) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const seen = new Set(), out = [];
  for (const m of data.modules) {
    const i = m.install || {};
    if (!ID_RE.test(m.id || '') || seen.has(m.id)) throw new Error('bad or duplicate module id: ' + m.id);
    if (!['content', 'maps', 'app', 'tool', 'model'].includes(m.type)) throw new Error('bad type for ' + m.id);
    if (!['s', 'm', 'l', 'xl'].includes(m.sizeClass)) throw new Error('bad sizeClass for ' + m.id);
    if (i.kind === 'zim') {
      if (!/^[a-z0-9_]+$/.test(i.subdir || '') || !/^[A-Za-z0-9_.-]+$/.test(i.prefix || '')) throw new Error('bad zim spec for ' + m.id);
    } else if (i.kind === 'maps') {
      if (!/^[a-z0-9-]+\.pmtiles$/.test(i.file || '') || !(i.maxzoom >= 0 && i.maxzoom <= 15)) throw new Error('bad maps spec for ' + m.id);
      if (i.bbox !== undefined) {
        const p = String(i.bbox).split(',').map(Number);
        if (p.length !== 4 || p.some(Number.isNaN) || !(p[0] >= -180 && p[0] < p[2] && p[2] <= 180 && p[1] >= -90 && p[1] < p[3] && p[3] <= 90)) throw new Error('bad bbox for ' + m.id);
      }
    } else if (i.kind === 'app') {
      if (!Array.isArray(i.suffixes) || !i.suffixes.length || !i.suffixes.every((s) => /^[A-Za-z0-9._-]+$/.test(s))) throw new Error('bad app suffixes for ' + m.id);
    } else if (i.kind === 'static-site') {
      if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(i.repo || '') || !/^[a-z0-9-]+$/.test(i.dir || '') || typeof i.asset !== 'string' || i.asset.length > 120) throw new Error('bad static-site spec for ' + m.id);
      new RegExp(i.asset);
    } else if (i.kind === 'pmtiles-file') {      // a ready-made map file; only Project NOMAD's map repository is trusted as the source
      if (!/^https:\/\/github\.com\/Crosstalk-Solutions\/project-nomad-maps\/raw\/refs\/heads\/master\/pmtiles\/[a-z0-9_.-]+_\d{4}-\d{2}\.pmtiles$/.test(i.url || '') || !/^[a-z0-9-]+\.pmtiles$/.test(i.file || '')) throw new Error('bad pmtiles-file spec for ' + m.id);
    } else if (i.kind === 'llama-cpp') {
      if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(i.repo || '')) throw new Error('bad llama-cpp spec for ' + m.id);
    } else if (i.kind === 'gguf') {
      if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(i.repo || '') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.gguf$/.test(i.file || '') || (i.minRamGB !== undefined && !(i.minRamGB > 0 && i.minRamGB < 512))) throw new Error('bad gguf spec for ' + m.id);
    } else if (i.kind === 'python-wheel') {
      if (!/^[a-z0-9][a-z0-9._-]{0,60}$/.test(i.package || '') || !/^[a-z0-9-]+$/.test(i.dir || '')) throw new Error('bad python-wheel spec for ' + m.id);
    } else if (i.kind === 'bundled') {
      if (!/^[a-z0-9-]+$/.test(i.dir || '')) throw new Error('bad bundled spec for ' + m.id);
    } else if (i.kind !== 'kiwix-tools') throw new Error('unknown install kind for ' + m.id);
    seen.add(m.id);
    if ((m.platforms || ['windows', 'linux', 'darwin', 'android']).includes(platform) && (m.hosts || ['app', 'pi']).includes('app')) out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------- http helpers
// A slow or briefly overloaded server (download.kiwix.org often is) must not look like a broken link: network timeouts,
// resets and 5xx/429 answers are retried with a growing pause. 404 and other 4xx answers are final.
const retryable = (e) => e instanceof HttpError ? (e.status >= 500 || e.status === 429) : !!e && !(e instanceof ApiError) && (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH'].includes(e.code) || /timed out|socket hang up|EPROTO|handshake/i.test(String(e.message)));
async function request(urlStr, o) {
  const tries = (o && o.retries !== undefined ? o.retries : 3) + 1, base = Number(process.env.NORWINPREP_RETRY_MS || 1500);
  for (let n = 1; ; n++) {
    try { return await requestOnce(urlStr, o); }
    catch (e) { if (n >= tries || !retryable(e)) throw e; await new Promise((r) => setTimeout(r, base * Math.pow(2, n - 1))); }
  }
}
function requestOnce(urlStr, o) {
  o = o || {};
  const left = o.redirects === undefined ? 5 : o.redirects;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new ApiError(400, 'bad url')); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method: o.method || 'GET', headers: Object.assign({}, UA, o.headers || {}) }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (left <= 0) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, u);
        if (u.protocol === 'https:' && next.protocol !== 'https:' && !o.allowDowngrade) return reject(new Error('refusing https to http redirect'));
        return resolve(requestOnce(next.toString(), Object.assign({}, o, { redirects: left - 1 })));
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); return reject(new HttpError(res.statusCode, urlStr)); }
      resolve(res);
    });
    req.setTimeout(o.timeout || 30000, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}
function readText(res, max) {
  return new Promise((resolve, reject) => {
    let d = ''; res.setEncoding('utf8');
    res.on('data', (c) => { d += c; if (d.length > (max || 8000000)) { res.destroy(); reject(new Error('response too large')); } });
    res.on('end', () => resolve(d)); res.on('error', reject);
  });
}

// ---------------------------------------------------------------- manager
class Manager {
  constructor(cfg) {
    this.cfg = Object.assign({ timeout: 30000, kiwix: 'https://download.kiwix.org', githubApi: 'https://api.github.com', githubDl: 'https://github.com',
      protomaps: 'https://build.protomaps.com', protomapsMeta: null, slug: 'NorwinLabs/NorwinPrepDisk', pmtilesRepo: 'protomaps/go-pmtiles', platform: process.platform,
      arch: process.arch, pypi: 'https://pypi.org', nomadMaps: 'https://github.com', hf: 'https://huggingface.co', onAiChange: async () => true, ramBytes: os.totalmem(), pythonCheck: async () => true, onKolibriChange: async () => true, bundledDir: path.join(__dirname, 'site'), onLibraryChange: async () => true, run: spawn }, cfg);
    this.mods = loadCatalog(this.cfg.catalog, this.cfg.platform === 'win32' ? 'windows' : this.cfg.platform);
    this.byid = Object.fromEntries(this.mods.map((m) => [m.id, m]));
    this.jobs = {}; this.queue = []; this.working = false; this.cache = new Map();
    this.sizes = { running: false, ok: 0, fail: 0 }; this.lastRefresh = 0;
  }
  d(kind) { const p = path.join(this.cfg.dataDir, kind); fs.mkdirSync(p, { recursive: true }); return p; }
  get plat() { return this.cfg.platform === 'win32' ? 'windows' : this.cfg.platform; }

  // ---------- network (cached)
  async text(url, max) { return readText(await request(url, { timeout: this.cfg.timeout }), max); }
  // keys are arrays like ['list', url]; a Map compares arrays by identity, so key by their joined text
  async cached(key, fn, ttl, force) {
    const k = key.join('\u0000'), hit = this.cache.get(k);
    if (hit && !force && Date.now() - hit.t < (ttl || 3600000)) return hit.v;
    const v = await fn(); this.cache.set(k, { t: Date.now(), v }); return v;
  }
  peek(key) { const h = this.cache.get(key.join('\u0000')); return h ? h.v : undefined; }
  zimBase(m) { return this.cfg.kiwix + '/zim/' + m.install.subdir + '/'; }
  zimVersions(html, prefix) { const re = new RegExp(esc(prefix) + '_(\\d{4}-\\d{2})\\.zim(?![\\w])', 'g'); const s = new Set(); let x; while ((x = re.exec(html))) s.add(x[1]); return [...s].sort(); }
  async kiwixVersions(m, force) {
    try { const html = await this.cached(['list', this.zimBase(m)], () => this.text(this.zimBase(m)), 3600000, force); return this.zimVersions(html, m.install.prefix); }
    catch (e) { if (e instanceof HttpError && e.status === 404) return []; throw e; }
  }
  releaseUrl() { return this.cfg.githubApi + '/repos/' + this.cfg.slug + '/releases/latest'; }
  async latestRelease(force) {
    return this.cached(['release', this.releaseUrl()], async () => {
      const j = JSON.parse(await this.text(this.releaseUrl()));
      if (!TAG_RE.test(j.tag_name || '')) throw new ApiError(502, 'unexpected release tag');
      const assets = {};
      for (const a of j.assets || []) if (ASSET_RE.test(a.name || '') || a.name === 'SHA256SUMS') assets[a.name] = Number(a.size || 0);
      return { tag: j.tag_name, assets };
    }, 3600000, force);
  }
  async headSize(url) {
    return this.cached(['size', url], async () => { const r = await request(url, { method: 'HEAD', timeout: this.cfg.timeout }); r.resume(); const n = r.headers['content-length']; return n && /^\d+$/.test(n) ? Number(n) : null; });
  }
  async protomapsBuild(force) {
    const url = (this.cfg.protomapsMeta || (this.cfg.protomaps === 'https://build.protomaps.com' ? 'https://build-metadata.protomaps.dev' : this.cfg.protomaps)) + '/builds.json';   // the build list moved off build.protomaps.com; the downloads did not
    const txt = await this.cached(['pm', url], () => this.text(url), 3600000, force);
    const b = [...new Set(txt.match(/\d{8}(?=\.pmtiles)/g) || [])].sort();
    if (!b.length) throw new ApiError(502, 'could not find a Protomaps build');
    // the newest build can be listed before its file is uploaded: use the newest one that is really there
    for (const id of b.slice(-3).reverse()) {
      try { const r = await request(this.cfg.protomaps + '/' + id + '.pmtiles', { method: 'HEAD', timeout: this.cfg.timeout, retries: 1 }); r.resume(); return id; } catch (e) { if (!(e instanceof HttpError) || e.status !== 404) break; }
    }
    return b[b.length - 1];
  }

  // ---------- what is installed
  installed(m) {
    const i = m.install;
    if (i.kind === 'zim') {
      const zdir = this.d('zim'), re = new RegExp('^' + esc(i.prefix) + '_(\\d{4}-\\d{2})\\.zim$');
      const found = fs.readdirSync(zdir).filter((f) => re.test(f)).map((f) => [f.match(re)[1], f]).sort();
      if (!found.length) return null;
      const [ver, f] = found[found.length - 1], st = fs.statSync(path.join(zdir, f));
      return { version: ver.replace('-', '.'), files: [f], bytes: st.size, updated: st.mtimeMs / 1000 };
    }
    if (i.kind === 'maps' || i.kind === 'pmtiles-file') {
      const p = path.join(this.d('maps'), i.file);
      if (!fs.existsSync(p)) return null;
      const st = fs.statSync(p), dt = new Date(st.mtimeMs);
      return { version: dt.toISOString().slice(0, 10).replace(/-/g, ''), files: [i.file], bytes: st.size, updated: st.mtimeMs / 1000 };
    }
    if (i.kind === 'kiwix-tools') {
      const dir = path.join(this.cfg.dataDir, 'reader'), bin = path.join(dir, this.plat === 'windows' ? 'kiwix-serve.exe' : 'kiwix-serve');
      if (!fs.existsSync(bin)) return null;
      let ver = '0'; try { ver = fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(); } catch (e) { /* unknown */ }
      const st = fs.statSync(bin);
      return { version: ver, files: ['kiwix-serve'], bytes: dirSize(dir), updated: st.mtimeMs / 1000 };
    }
    if (i.kind === 'gguf') {
      const f = path.join(this.cfg.dataDir, 'ai', 'models', i.file);
      try { const st = fs.statSync(f); return { version: ((/-(Q\d[A-Za-z0-9_]*)\.gguf$/i.exec(i.file) || [])[1] || 'GGUF').toUpperCase(), files: [i.file], bytes: st.size, updated: st.mtimeMs / 1000 }; } catch (e) { return null; }
    }
    if (i.kind === 'llama-cpp') {
      const dir = path.join(this.cfg.dataDir, 'ai', 'engine'), bin = path.join(dir, this.plat === 'windows' ? 'llama-server.exe' : 'llama-server');
      if (!fs.existsSync(bin)) return null;
      let ver = '?'; try { ver = fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(); } catch (e) { /* unknown */ }
      return { version: ver, files: ['llama-server'], bytes: dirSize(dir), updated: fs.statSync(bin).mtimeMs / 1000 };
    }
    if (i.kind === 'python-wheel') {
      const dir = path.join(this.cfg.dataDir, i.dir, 'app');
      try { const meta = JSON.parse(fs.readFileSync(path.join(dir, '.installed'), 'utf8')), st = fs.statSync(path.join(dir, '.installed'));
        return { version: String(meta.version || '?').slice(0, 20), files: [i.dir], bytes: dirSize(dir), updated: st.mtimeMs / 1000 }; } catch (e) { return null; }
    }
    if (i.kind === 'static-site' || i.kind === 'bundled') {
      const dir = path.join(this.d('sites'), i.dir);
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, '.installed'), 'utf8')), st = fs.statSync(path.join(dir, '.installed'));
        return { version: String(meta.version || '1').slice(0, 20), files: [i.dir], bytes: i.kind === 'bundled' ? 0 : dirSize(dir), updated: st.mtimeMs / 1000 };
      } catch (e) { return null; }
    }
    const adir = this.d('apps'); let files = [], ver = null, size = 0, newest = 0;
    for (const s of i.suffixes) {
      const re = new RegExp('^NorwinPrep-(\\d+\\.\\d+\\.\\d+)-' + esc(s) + '$');
      const hits = fs.readdirSync(adir).filter((f) => re.test(f)).sort((a, b) => (vgt(a.match(re)[1], b.match(re)[1]) ? 1 : -1));
      if (!hits.length) return null;
      const f = hits[hits.length - 1], st = fs.statSync(path.join(adir, f)); files.push(f); size += st.size; newest = Math.max(newest, st.mtimeMs / 1000);
      const v = f.match(re)[1]; if (ver === null || vgt(ver, v)) ver = v;
    }
    return { version: ver, files, bytes: size, updated: newest };
  }
  latest(m) {
    const i = m.install;
    if (i.kind === 'zim') { const html = this.peek(['list', this.zimBase(m)]); if (html === undefined) return null; const vs = this.zimVersions(html, i.prefix); return vs.length ? vs[vs.length - 1].replace('-', '.') : null; }
    if (i.kind === 'app') { const r = this.peek(['release', this.releaseUrl()]); return r ? r.tag.slice(1) : null; }
    if (i.kind === 'static-site') { const r = this.peek(['site', i.repo]); return r ? r.tag.replace(/^v/, '') : null; }
    if (i.kind === 'python-wheel') { const r = this.peek(['pypi', i.package]); return r ? r.version : null; }
    if (i.kind === 'llama-cpp') { const r = this.peek(['llama', i.repo]); return r ? r.tag : null; }
    return null;
  }
  knownSize(m) {
    const i = m.install;
    if (i.kind === 'zim') {
      const html = this.peek(['list', this.zimBase(m)]); if (html === undefined) return null;
      const vs = this.zimVersions(html, i.prefix); if (!vs.length) return null;
      const sz = this.peek(['size', this.zimBase(m) + i.prefix + '_' + vs[vs.length - 1] + '.zim']); return sz || null;
    }
    if (i.kind === 'app') {
      const r = this.peek(['release', this.releaseUrl()]); if (!r) return null;
      const files = i.suffixes.flatMap((s) => Object.keys(r.assets).filter((n) => n.endsWith('-' + s)));
      return files.length === i.suffixes.length ? files.reduce((a, n) => a + r.assets[n], 0) : null;
    }
    if (i.kind === 'static-site') { const r = this.peek(['site', i.repo]); return r ? r.size : null; }
    if (i.kind === 'python-wheel') { const r = this.peek(['pypi', i.package]); return r ? r.size : null; }
    if (i.kind === 'llama-cpp') { const r = this.peek(['llama', i.repo]); return r ? r.size : null; }
    if (i.kind === 'pmtiles-file') { const s = this.peek(['size', i.url]); return s || null; }
    if (i.kind === 'gguf') { const t = this.peek(['hf', i.repo]); return t && t[i.file] ? t[i.file].size : null; }
    return null;
  }
  // The newest llama.cpp release and the one ready-made CPU build that fits this computer (llama-server is inside it).
  async llamaRelease(m, force) {
    const i = m.install, osTok = { linux: ['ubuntu', 'linux'], win32: ['win', 'windows'], darwin: ['macos'] }[this.cfg.platform], archTok = { x64: ['x64', 'x86_64', 'x86-64', 'amd64'], arm64: ['arm64', 'aarch64'] }[this.cfg.arch];
    return this.cached(['llama', i.repo], async () => {
      if (!osTok || !archTok) throw new ApiError(412, 'There is no ready-made AI engine for this computer (' + this.cfg.platform + ' ' + this.cfg.arch + ').');
      // "latest" is not the build release here (it is a nightly stub); the binaries are in the newest bNNNN release that has them
      const all = JSON.parse(await this.text(this.cfg.githubApi + '/repos/' + i.repo + '/releases?per_page=20')), bad = /cuda|vulkan|hip|sycl|opencl|rocm|openvino|cudart|kleidiai|musa|radeon|xcframework|android|ios|rpc|aclnn|cann|bf16|snapdragon|adreno|zdnn|s390x|-ui\b/i;
      const words = (n) => n.toLowerCase().split(/[^a-z0-9_]+/);
      const j = (Array.isArray(all) ? all : []).filter((r) => r && !r.draft && /^b\d+$/.test(r.tag_name || '') && (r.assets || []).some((a) => /^llama-/.test(a.name || '') && /\.(zip|tar\.gz|tgz)$/.test(a.name || '')))[0];
      if (!j) throw new ApiError(502, 'No llama.cpp build release was found');
      const c = (j.assets || []).filter((a) => /^llama-/.test(a.name) && /\.(zip|tar\.gz|tgz)$/.test(a.name) && /^[A-Za-z0-9._-]+$/.test(a.name) && !bad.test(a.name)
        && words(a.name).some((w) => osTok.includes(w)) && words(a.name).some((w) => archTok.includes(w))).sort((a, b) => a.size - b.size);
      if (!c.length) throw new ApiError(412, 'There is no ready-made AI engine for this computer (' + this.cfg.platform + ' ' + this.cfg.arch + ') in the latest llama.cpp release.');
      const a = c[0], dg = /^sha256:([0-9a-f]{64})$/i.exec(a.digest || '');
      if (!/^[A-Za-z0-9._-]+$/.test(j.tag_name || '')) throw new ApiError(502, 'unexpected release tag');
      return { tag: j.tag_name, name: a.name, size: Number(a.size || 0), sha: dg ? dg[1].toLowerCase() : null, url: this.cfg.githubDl + '/' + i.repo + '/releases/download/' + j.tag_name + '/' + a.name };
    }, 3600000, force);
  }
  // File list of a Hugging Face model repo: size and SHA-256 of each file (from its LFS record).
  async hfFiles(repo, force) {
    return this.cached(['hf', repo], async () => {
      const list = JSON.parse(await this.text(this.cfg.hf + '/api/models/' + repo + '/tree/main')), out = {};
      for (const f of list) if (f && f.type !== 'directory' && /\.gguf$/.test(f.path || '')) out[f.path] = { size: Number(f.size || 0), sha: f.lfs && /^[0-9a-f]{64}$/.test(f.lfs.oid || '') ? f.lfs.oid : null };
      return out;
    }, 3600000, force);
  }
  // the newest wheel of a pure-Python package on PyPI (Kolibri). Only files.pythonhosted.org is trusted as the download host.
  async pypiRelease(m, force) {
    const i = m.install;
    return this.cached(['pypi', i.package], async () => {
      const j = JSON.parse(await this.text(this.cfg.pypi + '/pypi/' + i.package + '/json'));
      const w = (j.urls || []).filter((u) => u.packagetype === 'bdist_wheel' && /-(py3|py2\.py3)-none-any\.whl$/.test(u.filename || ''))[0];
      if (!w) throw new ApiError(404, 'PyPI has no pure-Python download of ' + i.package);
      const url = new URL(w.url);
      if (!this.cfg.pypiFilesAny && !(url.protocol === 'https:' && url.hostname === 'files.pythonhosted.org')) throw new ApiError(502, 'unexpected download address for ' + i.package);
      const sha = String((w.digests && w.digests.sha256) || '').toLowerCase(); if (!/^[0-9a-f]{64}$/.test(sha)) throw new ApiError(502, 'PyPI published no checksum for ' + i.package);
      return { version: String(j.info.version).slice(0, 20), requires: String(j.info.requires_python || '').slice(0, 40), url: w.url, name: w.filename, size: Number(w.size || 0), sha };
    }, 3600000, force);
  }
  // the newest release of a static web app on GitHub (e.g. CyberChef) and the one asset we install
  async siteRelease(m, force) {
    const i = m.install, re = new RegExp(i.asset);
    return this.cached(['site', i.repo], async () => {
      const j = JSON.parse(await this.text(this.cfg.githubApi + '/repos/' + i.repo + '/releases/latest'));
      if (!/^v?\d+\.\d+\.\d+$/.test(j.tag_name || '')) throw new ApiError(502, 'unexpected release tag');
      const a = (j.assets || []).filter((x) => re.test(x.name || '') && /^[A-Za-z0-9._-]+$/.test(x.name))[0];
      if (!a) throw new ApiError(404, 'The latest ' + i.repo + ' release has no download for this');
      const dg = /^sha256:([0-9a-f]{64})$/i.exec(a.digest || '');
      return { tag: j.tag_name, name: a.name, size: Number(a.size || 0), sha: dg ? dg[1].toLowerCase() : null, url: this.cfg.githubDl + '/' + i.repo + '/releases/download/' + j.tag_name + '/' + a.name };
    }, 3600000, force);
  }
  // where an installed tool is served from (null when not installed); used by the local and the sharing server
  siteRoot(dir) {
    const m = this.mods.find((x) => (x.install.kind === 'static-site' || x.install.kind === 'bundled') && x.install.dir === dir);
    if (!m || !this.installed(m)) return null;
    return m.install.kind === 'bundled' ? path.join(this.cfg.bundledDir, dir) : path.join(this.d('sites'), dir);
  }
  listSites() {   // installed tools that run in a browser: what a device that joins the Wi-Fi may use
    return this.mods.filter((m) => m.open && this.installed(m)).map((m) => ({ id: m.id, name: m.name, path: m.open }));
  }
  disk() {
    try { const s = fs.statfsSync(this.d('zim')); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; }
    catch (e) { return { free: Number.MAX_SAFE_INTEGER, total: Number.MAX_SAFE_INTEGER }; }
  }

  // ---------- views
  catalog() {
    this.kickSizes();
    const out = [];
    for (const m of this.mods) {
      const ins = this.installed(m), lat = this.latest(m);
      const item = {}; for (const k of ['id', 'type', 'name', 'tagline', 'description', 'by', 'source', 'icon', 'color', 'category', 'open']) if (m[k] !== undefined) item[k] = m[k];
      if (m.install.minRamGB) item.minRamGB = m.install.minRamGB;
      if (m.topic) item.topic = m.topic;
      if (m.approxMB) item.approxMB = m.approxMB;
      item.installed = !!ins; item.sizeClass = m.sizeClass;
      if (!ins) { const ks = this.knownSize(m); if (ks) item.size = ks; }
      if (ins) { item.version = ins.version; item.bytes = ins.bytes; item.updated = Math.floor(ins.updated); item.files = ins.files; }
      if (lat) { item.latest = lat; item.updateAvailable = !!ins && vgt(lat, ins.version); if (!ins) item.version = lat; }
      const j = this.jobs[m.id]; if (j) item.job = { state: j.state, percent: j.percent, message: j.message, action: j.action, t: j.t };
      out.push(item);
    }
    return out;
  }
  status() { const jobs = {}; for (const [k, j] of Object.entries(this.jobs)) jobs[k] = { state: j.state, percent: j.percent, message: j.message, action: j.action, t: j.t }; return { jobs, disk: this.disk() }; }
  async info(id) {
    const m = this.byid[id]; if (!m) throw new ApiError(404, 'unknown module');
    const i = m.install, res = { id, name: m.name, free: this.disk().free, bytes: null, file: null, version: null };
    try {
      if (i.kind === 'zim') {
        const vs = await this.kiwixVersions(m);
        if (!vs.length) throw new ApiError(404, i.prefix + ' was not found in the Kiwix library');
        const name = i.prefix + '_' + vs[vs.length - 1] + '.zim';
        Object.assign(res, { file: name, version: vs[vs.length - 1].replace('-', '.'), bytes: await this.headSize(this.zimBase(m) + name) });
      } else if (i.kind === 'app') {
        const rel = await this.latestRelease();
        const files = i.suffixes.flatMap((s) => Object.keys(rel.assets).filter((n) => n.endsWith('-' + s)));
        if (files.length !== i.suffixes.length) throw new ApiError(404, 'the latest release has no files for this module yet');
        Object.assign(res, { file: files.join(', '), version: rel.tag.slice(1), bytes: files.reduce((a, n) => a + rel.assets[n], 0) });
      } else if (i.kind === 'maps') {
        Object.assign(res, { file: i.file, version: await this.protomapsBuild(), note: 'Size depends on the region; large regions can be tens of GB and take hours.' });
      } else if (i.kind === 'static-site') {
        const r = await this.siteRelease(m, true);
        Object.assign(res, { file: r.name, version: r.tag.replace(/^v/, ''), bytes: r.size });
      } else if (i.kind === 'pmtiles-file') {
        const url = i.url.replace('https://github.com', this.cfg.nomadMaps);
    let size = null; try { size = await this.headSize(url); } catch (e) { if (!(e instanceof HttpError)) throw e; }
        Object.assign(res, { file: i.file, version: ((/_(\d{4}-\d{2})\.pmtiles$/.exec(i.url) || [])[1] || '').replace('-', '.'), bytes: size || (m.approxMB ? m.approxMB * 1048576 : null), note: 'A ready-made map file, downloaded as it is.' });
      } else if (i.kind === 'llama-cpp') {
        const r = await this.llamaRelease(m, true);
        Object.assign(res, { file: r.name, version: r.tag, bytes: r.size, note: 'A small program that runs AI models on your processor. It is installed automatically with your first model.' });
      } else if (i.kind === 'gguf') {
        const t = await this.hfFiles(i.repo, true), f = t[i.file]; if (!f) throw new ApiError(404, i.file + ' was not found on Hugging Face');
        const ram = this.cfg.ramBytes, need = (i.minRamGB || 0) * 1073741824;
        Object.assign(res, { file: i.file, version: ((/-(Q\d[A-Za-z0-9_]*)\.gguf$/i.exec(i.file) || [])[1] || 'GGUF').toUpperCase(), bytes: f.size,
          note: i.minRamGB ? 'Wants about ' + i.minRamGB + ' GB of free memory; this computer has ' + (ram / 1073741824).toFixed(1) + ' GB in total.' + (need > ram * 0.8 ? ' That is probably too little: it may be very slow or fail.' : '') : '' });
      } else if (i.kind === 'python-wheel') {
        const r = await this.pypiRelease(m, true);
        Object.assign(res, { file: r.name, version: r.version, bytes: r.size, note: 'Needs Python ' + (r.requires || '3') + ' on this computer. Unpacked it takes about 3 times the download.' });
      } else if (i.kind === 'bundled') Object.assign(res, { file: 'built into the app', version: '1', bytes: 0, note: 'Nothing is downloaded.' });
      else Object.assign(res, { file: 'kiwix-serve', version: null, note: 'A small program that lets the app show content packs.' });
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e instanceof HttpError) throw new ApiError(502, 'The download server answered HTTP ' + e.status);
      throw new ApiError(502, 'Could not reach the download server (' + (e.code || e.message) + ')');
    }
    return res;
  }
  async refresh() {
    if (Date.now() - this.lastRefresh < 15000) throw new ApiError(429, 'Refreshed a moment ago');
    this.lastRefresh = Date.now(); this.kickSizes(true);
    let errors = 0; const zims = this.mods.filter((m) => m.install.kind === 'zim'), seen = new Set();
    for (const m of zims) { if (seen.has(m.install.subdir)) continue; seen.add(m.install.subdir); try { await this.kiwixVersions(m, true); } catch (e) { errors++; } }
    try { await this.latestRelease(true); } catch (e) { errors++; }
    return { ok: true, errors };
  }

  // ---------- background size lookup (never blocks; backs off when offline)
  kickSizes(force) {
    const now = Date.now(), s = this.sizes;
    if (s.running || (!force && (now - s.ok < 6 * 3600000 || now - s.fail < 600000))) return;
    s.running = true; this.resolveSizes().then(() => { s.ok = Date.now(); }, () => { s.fail = Date.now(); }).finally(() => { s.running = false; });
  }
  async resolveSizes() {
    const zims = this.mods.filter((m) => m.install.kind === 'zim'), seen = new Set();
    for (const m of zims) { if (seen.has(m.install.subdir)) continue; seen.add(m.install.subdir); await this.kiwixVersions(m, true); }   // offline -> throws -> back off
    let idx = 0;
    const worker = async () => {
      while (idx < zims.length) {
        const m = zims[idx++], vs = await this.kiwixVersions(m); if (!vs.length) continue;
        try { await this.headSize(this.zimBase(m) + m.install.prefix + '_' + vs[vs.length - 1] + '.zim'); } catch (e) { if (!(e instanceof HttpError)) throw e; }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    try { await this.latestRelease(true); } catch (e) { if (!(e instanceof HttpError)) throw e; }
    for (const r of new Set(this.mods.filter((x) => x.install.kind === 'gguf').map((x) => x.install.repo))) { try { await this.hfFiles(r, true); } catch (e) { if (!(e instanceof HttpError) && !(e instanceof ApiError)) throw e; } }
    for (const m of this.mods.filter((x) => x.install.kind === 'llama-cpp')) { try { await this.llamaRelease(m, true); } catch (e) { if (!(e instanceof HttpError) && !(e instanceof ApiError)) throw e; } }
    for (const m of this.mods.filter((x) => x.install.kind === 'python-wheel')) { try { await this.pypiRelease(m, true); } catch (e) { if (!(e instanceof HttpError) && !(e instanceof ApiError)) throw e; } }
    for (const m of this.mods.filter((x) => x.install.kind === 'static-site')) { try { await this.siteRelease(m, true); } catch (e) { if (!(e instanceof HttpError) && !(e instanceof ApiError)) throw e; } }
  }
  sizesPending() { return this.sizes.running; }

  // ---------- jobs (one at a time, in order)
  enqueue(id, action) {
    const m = this.byid[id]; if (!m) throw new ApiError(404, 'unknown module');
    const j = this.jobs[id]; if (j && (j.state === 'queued' || j.state === 'running')) throw new ApiError(409, m.name + ' is already in progress');
    const job = { state: 'queued', percent: 0, message: 'Waiting in line…', action, t: Date.now() };
    this.jobs[id] = job; this.queue.push([id, action]); this.pump();
    return job;
  }
  cancel(id) {                          // take a waiting job out of the line (one already running is not interrupted)
    const i = this.queue.findIndex((q) => q[0] === id);
    if (i < 0) throw new ApiError(409, 'Only items still waiting in line can be removed');
    this.queue.splice(i, 1); delete this.jobs[id];
  }
  set(id, patch) { Object.assign(this.jobs[id], patch); }
  async pump() {
    if (this.working) return; this.working = true;
    try {
      while (this.queue.length) {
        const [id, action] = this.queue.shift(), m = this.byid[id];
        this.set(id, { state: 'running', message: 'Starting…' });
        try {
          if (action === 'remove') await this.remove(m);
          else {
            if (m.type === 'content') await this.ensureReader(id);
            if (m.type === 'model') await this.ensureEngine(id);
            await ({ zim: this.installZim, maps: this.installMaps, app: this.installApp, 'kiwix-tools': this.installReader, 'static-site': this.installSite, 'python-wheel': this.installWheel, 'llama-cpp': this.installLlama, gguf: this.installGguf, 'pmtiles-file': this.installPmFile, bundled: this.installBundled })[m.install.kind].call(this, m);
          }
          this.set(id, { state: 'done', percent: 100, message: action === 'remove' ? 'Removed' : 'Installed' });
        } catch (e) {
          let msg;
          if (e instanceof ApiError) msg = e.msg;
          else if (e instanceof HttpError) msg = 'The download server answered HTTP ' + e.status;
          else if (e && (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || /timed out/.test(e.message))) msg = 'Could not reach the download server (' + (e.code || e.message) + ')';
          else msg = 'Failed: ' + String((e && e.message) || e).slice(0, 200);
          this.set(id, { state: 'error', message: msg });
        }
        this.jobs[id].t = Date.now();
      }
    } finally { this.working = false; }
  }
  async restartLibrary() { try { return await this.cfg.onLibraryChange(); } catch (e) { return false; } }
  needSpace(need) {
    const free = this.disk().free;
    if (need && free < need * 1.05 + 52428800) throw new ApiError(507, 'Not enough free space: needs ' + human(need) + ', only ' + human(free) + ' free');
  }

  // ---------- download with progress, resume and SHA-256
  async download(id, url, part, expectSha, label) {
    let have = 0; try { have = fs.statSync(part).size; } catch (e) { /* none */ }
    let h = crypto.createHash('sha256');
    if (have) await new Promise((res, rej) => { const s = fs.createReadStream(part); s.on('data', (c) => h.update(c)); s.on('end', res); s.on('error', rej); });
    let resp = null;
    try { resp = await request(url, { headers: have ? { Range: 'bytes=' + have + '-' } : {}, timeout: 60000, allowDowngrade: true }); }
    catch (e) {
      if (e instanceof HttpError && e.status === 416 && have) resp = null;
      else if (e instanceof HttpError) throw new ApiError(502, 'Download failed (HTTP ' + e.status + ')');
      else throw new ApiError(502, 'Could not reach the download server (' + (e.code || e.message) + ')');
    }
    if (resp) {
      if (have && resp.statusCode !== 206) { have = 0; h = crypto.createHash('sha256'); }       // server ignored Range: start over
      const clen = Number(resp.headers['content-length']) || 0, total = clen ? have + clen : 0;
      let done = have;
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
        resp.on('data', (c) => { h.update(c); done += c.length; if (total) this.set(id, { state: 'running', percent: Math.min(99, Math.floor(done * 100 / total)), message: label + human(done) + ' of ' + human(total) }); });
        resp.on('error', reject); out.on('error', reject); out.on('finish', resolve); resp.pipe(out);
      });
      if (total && done !== total) throw new ApiError(502, 'Download was cut short; press Install to resume');
    }
    if (expectSha && h.digest('hex') !== expectSha) { try { fs.unlinkSync(part); } catch (e) { /* gone */ } throw new ApiError(502, 'Checksum mismatch. The download was discarded and not installed.'); }
  }
  async sha(url) { try { const t = (await this.text(url, 4096)).trim().split(/\s+/)[0]; return /^[0-9a-fA-F]{64}$/.test(t || '') ? t.toLowerCase() : null; } catch (e) { return null; } }

  // ---------- installers
  async installZim(m) {
    const i = m.install, zdir = this.d('zim'), vs = await this.kiwixVersions(m, true);
    if (!vs.length) throw new ApiError(404, i.prefix + ' was not found in the Kiwix library');
    const name = i.prefix + '_' + vs[vs.length - 1] + '.zim', url = this.zimBase(m) + name;
    let size = null; try { size = await this.headSize(url); } catch (e) { /* unknown */ }
    this.needSpace(size);
    const part = path.join(zdir, '.' + name + '.part'), sha = await this.sha(url + '.sha256');
    await this.download(m.id, url, part, sha, '');
    this.set(m.id, { percent: 99, message: 'Finishing…' });
    fs.renameSync(part, path.join(zdir, name));
    const re = new RegExp('^' + esc(i.prefix) + '_\\d{4}-\\d{2}\\.zim$');
    for (const f of fs.readdirSync(zdir)) if (re.test(f) && f !== name) fs.unlinkSync(path.join(zdir, f));      // drop older editions
    if (!(await this.restartLibrary())) this.set(m.id, { message: 'Installed (the reader could not be restarted)' });
  }
  async toolDir() { const p = path.join(this.cfg.dataDir, 'tools'); fs.mkdirSync(p, { recursive: true }); return p; }
  async extract(archive, dest) {
    fs.mkdirSync(dest, { recursive: true });
    await new Promise((resolve, reject) => {       // `tar` reads .tar.gz everywhere and .zip on Windows 10+ and macOS
      const c = spawn('tar', ['-xf', archive, '-C', dest], { stdio: 'ignore' }); c.on('error', reject); c.on('exit', (code) => (code === 0 ? resolve() : reject(new ApiError(500, 'Could not unpack the download (tar exit ' + code + ')'))));
    });
  }
  findFile(dir, name) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { const f = this.findFile(p, name); if (f) return f; } else if (e.name === name) return p;
    }
    return null;
  }
  async ensureTool(name, jid) {     // the pmtiles command-line tool, downloaded from its GitHub releases on first use
    const bin = path.join(await this.toolDir(), name + (this.plat === 'windows' ? '.exe' : ''));
    if (fs.existsSync(bin)) return bin;
    const archMap = { x64: 'x86_64', arm64: 'arm64', arm: 'armv6' }, os = { linux: 'Linux', darwin: 'Darwin', windows: 'Windows' }[this.plat], a = archMap[this.cfg.arch];
    if (a === 'armv6') throw new ApiError(500, 'Offline maps need a 64-bit system: the map tool has no 32-bit Raspberry Pi build. Content packs still work.');
    if (!os || !a) throw new ApiError(500, 'The map tool is not available for this computer (' + this.plat + ' ' + this.cfg.arch + ')');
    const j = JSON.parse(await this.text(this.cfg.githubApi + '/repos/' + this.cfg.pmtilesRepo + '/releases/latest'));
    const tag = j.tag_name, ver = String(tag).replace(/^v/, '');
    if (!/^v?\d+\.\d+\.\d+$/.test(tag)) throw new ApiError(502, 'unexpected map tool release');
    const file = (os === 'Darwin' ? 'go-pmtiles-' : 'go-pmtiles_') + ver + '_' + os + '_' + a + (os === 'Linux' ? '.tar.gz' : '.zip'), base = this.cfg.githubDl + '/' + this.cfg.pmtilesRepo + '/releases/download/' + tag + '/';
    const tmp = fs.mkdtempSync(path.join(await this.toolDir(), 'dl-')), part = path.join(tmp, file);
    try {
      let sha = null;
      try { for (const line of (await this.text(base + 'go-pmtiles_' + ver + '_checksums.txt', 200000)).split('\n')) { const p = line.trim().split(/\s+/); if (p[1] === file && /^[0-9a-f]{64}$/i.test(p[0])) sha = p[0].toLowerCase(); } } catch (e) { /* published over HTTPS anyway */ }
      await this.download(jid, base + file, part, sha, 'Map tool: ');
      await this.extract(part, tmp + '/x');
      const found = this.findFile(tmp + '/x', name + (this.plat === 'windows' ? '.exe' : ''));
      if (!found) throw new ApiError(500, 'The map tool was not in the download');
      fs.copyFileSync(found, bin); fs.chmodSync(bin, 0o755);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    return bin;
  }
  async installMaps(m) {
    const i = m.install, mdir = this.d('maps');
    this.set(m.id, { message: 'Preparing the map tool…' });
    const bin = await this.ensureTool('pmtiles', m.id);
    const build = await this.protomapsBuild(true).catch((e) => { throw e instanceof ApiError ? e : new ApiError(502, 'Could not reach the map server (' + (e.code || e.message) + ')'); });
    this.needSpace(1 << 30);
    const tmp = path.join(mdir, '.' + i.file + '.part'); try { fs.unlinkSync(tmp); } catch (e) { /* none */ }
    const args = ['extract', this.cfg.protomaps + '/' + build + '.pmtiles', tmp, '--maxzoom=' + i.maxzoom]; if (i.bbox) args.push('--bbox=' + i.bbox);
    const t0 = Date.now();
    const code = await new Promise((resolve, reject) => {
      const c = this.cfg.run(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] }); let err = '';
      c.stderr.on('data', (d) => { err += d; err = err.slice(-2000); });
      const tick = setInterval(() => { let sz = 0; try { sz = fs.statSync(tmp).size; } catch (e) { /* not yet */ } this.set(m.id, { state: 'running', percent: 0, message: 'Downloading map tiles… ' + human(sz) + ' so far (' + Math.floor((Date.now() - t0) / 60000) + ' min)' }); }, 1000);
      c.on('error', (e) => { clearInterval(tick); reject(e); });
      c.on('exit', (cd) => { clearInterval(tick); resolve({ cd, err }); });
    });
    if (code.cd !== 0) { try { fs.unlinkSync(tmp); } catch (e) { /* gone */ } throw new ApiError(502, 'Map download failed: ' + (code.err.trim().split('\n').pop() || 'pmtiles failed').slice(0, 150)); }
    fs.renameSync(tmp, path.join(mdir, i.file));
  }
  async installApp(m) {
    const i = m.install, adir = this.d('apps');
    let rel; try { rel = await this.latestRelease(true); } catch (e) { if (e instanceof ApiError) throw e; throw new ApiError(502, 'Could not reach GitHub (' + (e.code || e.message) + ')'); }
    const base = this.cfg.githubDl + '/' + this.cfg.slug + '/releases/download/' + rel.tag + '/', names = [];
    for (const s of i.suffixes) {
      const hit = Object.keys(rel.assets).find((n) => n.endsWith('-' + s) && ASSET_RE.test(n));
      if (!hit) throw new ApiError(404, 'The latest release has no ' + s + ' file yet'); names.push([s, hit]);
    }
    this.needSpace(names.reduce((a, [, n]) => a + rel.assets[n], 0));
    const sums = {}; for (const line of (await this.text(base + 'SHA256SUMS', 1000000)).split('\n')) { const p = line.trim().split(/\s+/); if (p.length >= 2) sums[p[1].replace(/^\*/, '')] = p[0].toLowerCase(); }
    for (const [s, n] of names) {
      if (!/^[0-9a-f]{64}$/.test(sums[n] || '')) throw new ApiError(502, 'No checksum published for ' + n);
      const part = path.join(adir, '.' + n + '.part');
      await this.download(m.id, base + n, part, sums[n], n + ': ');
      fs.renameSync(part, path.join(adir, n));
      const re = new RegExp('^NorwinPrep-\\d+\\.\\d+\\.\\d+-' + esc(s) + '$');
      for (const f of fs.readdirSync(adir)) if (f !== n && re.test(f)) fs.unlinkSync(path.join(adir, f));
    }
  }
  // The reader: kiwix-serve, downloaded from download.kiwix.org on first use. Archive names below are the documented release
  // layout (kiwix-tools_<platform>-<version>.<ext>); they could not be checked from the development environment.
  readerPattern() {
    const pat = { 'linux:x64': 'linux-x86_64', 'linux:arm64': 'linux-aarch64', 'linux:arm': 'linux-armhf', 'win32:x64': 'win-i686', 'win32:ia32': 'win-i686', 'windows:x64': 'win-i686', 'darwin:x64': 'macos-x86_64', 'darwin:arm64': 'macos-arm64' }[this.cfg.platform + ':' + this.cfg.arch];
    if (!pat) throw new ApiError(500, 'The reader is not available for this computer (' + this.plat + ' ' + this.cfg.arch + ')');
    return new RegExp('kiwix-tools_' + esc(pat) + '-(\\d+\\.\\d+\\.\\d+)\\.(tar\\.gz|zip)(?![\\w.])', 'g');
  }
  async installReader(m, jid) {      // jid: which job shows the progress (the reader's own, or the content pack that needs it)
    jid = jid || m.id;
    const base = this.cfg.kiwix + '/release/kiwix-tools/', re = this.readerPattern();
    let html; try { html = await this.cached(['reader', base], () => this.text(base), 3600000, true); } catch (e) { if (e instanceof HttpError) throw new ApiError(502, 'The download server answered HTTP ' + e.status); throw e; }
    const found = []; let x; while ((x = re.exec(html))) found.push({ file: x[0], ver: x[1] });
    if (!found.length) throw new ApiError(404, 'No reader was found for this computer on the Kiwix download server');
    found.sort((a, b) => (vgt(a.ver, b.ver) ? 1 : -1)); const best = found[found.length - 1], url = base + best.file;
    let size = null; try { size = await this.headSize(url); } catch (e) { /* unknown */ }
    this.needSpace(size);
    const dir = path.join(this.cfg.dataDir, 'reader'), tmp = fs.mkdtempSync(path.join(this.cfg.dataDir, 'reader-dl-')), part = path.join(tmp, best.file);
    try {
      await this.download(jid, url, part, await this.sha(url + '.sha256'), 'Reader: ');
      this.set(jid, { percent: 99, message: 'Unpacking…' });
      await this.extract(part, tmp + '/x');
      const bin = this.findFile(tmp + '/x', this.plat === 'windows' ? 'kiwix-serve.exe' : 'kiwix-serve');
      if (!bin) throw new ApiError(500, 'kiwix-serve was not in the download');
      fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
      for (const f of fs.readdirSync(path.dirname(bin))) fs.copyFileSync(path.join(path.dirname(bin), f), path.join(dir, f));   // keep any bundled libraries beside it
      fs.chmodSync(path.join(dir, path.basename(bin)), 0o755); fs.writeFileSync(path.join(dir, 'VERSION'), best.ver + '\n');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    await this.restartLibrary();
  }
  async installPmFile(m) {            // a finished PMTiles map from the NOMAD map repository: download, check it really is a PMTiles file, keep
    const i = m.install, dir = this.d('maps'), part = path.join(dir, '.' + i.file + '.part'); let have = 0; try { have = fs.statSync(part).size; } catch (e) { /* none */ }
    const url = i.url.replace('https://github.com', this.cfg.nomadMaps);
    let size = null; try { size = await this.headSize(url); } catch (e) { if (!(e instanceof HttpError)) throw e; }
    this.needSpace(Math.max(0, (size || (m.approxMB || 0) * 1048576) - have));
    await this.download(m.id, url, part, null, m.name + ': ');
    const fd = fs.openSync(part, 'r'), head = Buffer.alloc(8); fs.readSync(fd, head, 0, 8, 0); fs.closeSync(fd);
    if (head.toString('latin1', 0, 7) !== 'PMTiles') { fs.unlinkSync(part); throw new ApiError(502, 'The download is not a map file (it was discarded).'); }
    fs.renameSync(part, path.join(dir, i.file));
  }
  async installLlama(m, jid) {       // the AI engine: llama.cpp's llama-server and the libraries beside it
    jid = jid || m.id; const r = await this.llamaRelease(m, true);
    this.needSpace(r.size * 3);
    const base = this.d('ai'), tmp = fs.mkdtempSync(path.join(base, '.dl-')), part = path.join(tmp, r.name);
    try {
      await this.download(jid, r.url, part, r.sha, 'AI engine: ');
      this.set(jid, { percent: 99, message: 'Unpacking…' });
      const out = path.join(tmp, 'x');
      if (/\.zip$/.test(r.name)) unzip(fs.readFileSync(part), out, 1500 * 1024 * 1024); else await this.extract(part, out);
      const bin = this.findFile(out, this.plat === 'windows' ? 'llama-server.exe' : 'llama-server');
      if (!bin) throw new ApiError(502, 'llama-server was not in the download');
      const dest = path.join(base, 'engine'); await this.cfg.onAiChange('stop'); fs.rmSync(dest, { recursive: true, force: true }); fs.mkdirSync(dest, { recursive: true });
      for (const f of fs.readdirSync(path.dirname(bin))) { const s = path.join(path.dirname(bin), f); if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(dest, f)); }
      fs.chmodSync(path.join(dest, path.basename(bin)), 0o755); fs.writeFileSync(path.join(dest, 'VERSION'), r.tag + '\n');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  async ensureEngine(forId) {          // the first model pulls the engine in automatically
    const em = this.mods.find((x) => x.install.kind === 'llama-cpp'); if (!em || this.installed(em)) return;
    this.set(forId, { message: 'Installing the AI engine first…' });
    await this.installLlama(em, forId);
  }
  async installGguf(m) {              // one model file from Hugging Face, checked against the SHA-256 Hugging Face records for it
    const i = m.install, t = await this.hfFiles(i.repo, true), f = t[i.file];
    if (!f) throw new ApiError(404, i.file + ' was not found on Hugging Face');
    if (!f.sha) throw new ApiError(502, 'Hugging Face published no checksum for ' + i.file);
    const dir = path.join(this.d('ai'), 'models'); fs.mkdirSync(dir, { recursive: true });
    const part = path.join(dir, '.' + i.file + '.part'); let have = 0; try { have = fs.statSync(part).size; } catch (e) { /* none */ }
    this.needSpace(Math.max(0, f.size - have));
    await this.download(m.id, this.cfg.hf + '/' + i.repo + '/resolve/main/' + i.file, part, f.sha, m.name + ': ');
    fs.renameSync(part, path.join(dir, i.file));
  }
  async installWheel(m) {            // Kolibri: needs Python on this computer; the wheel is unpacked and run in place
    const i = m.install, r = await this.pypiRelease(m, true);
    try { await this.cfg.pythonCheck(r.requires); } catch (e) { throw new ApiError(412, e.message); }
    this.needSpace(r.size * 4);
    const base = path.join(this.cfg.dataDir, i.dir); fs.mkdirSync(base, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(base, '.dl-')), part = path.join(tmp, r.name);
    try {
      await this.download(m.id, r.url, part, r.sha, m.name + ': ');
      this.set(m.id, { percent: 99, message: 'Unpacking…' });
      const out = path.join(tmp, 'app'); unzip(fs.readFileSync(part), out, 1200 * 1024 * 1024);
      if (!fs.existsSync(path.join(out, i.package, '__init__.py'))) throw new ApiError(502, 'The download did not contain ' + i.package);
      fs.writeFileSync(path.join(out, '.installed'), JSON.stringify({ version: r.version, requires: r.requires }));
      await this.cfg.onKolibriChange('stop');
      const dest = path.join(base, 'app'); fs.rmSync(dest, { recursive: true, force: true }); fs.renameSync(out, dest);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  async installBundled(m) {          // ships inside the app: "installing" just switches it on
    const dir = path.join(this.d('sites'), m.install.dir); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.installed'), JSON.stringify({ version: '1' }));
  }
  async installSite(m) {              // a static web app from a GitHub release (zip), served by the app and shared over Wi-Fi
    const i = m.install, r = await this.siteRelease(m, true);
    this.needSpace(r.size * 3);
    const base = this.d('sites'), tmp = fs.mkdtempSync(path.join(base, '.dl-')), part = path.join(tmp, r.name);
    try {
      await this.download(m.id, r.url, part, r.sha, m.name + ': ');
      this.set(m.id, { percent: 99, message: 'Unpacking…' });
      const out = path.join(tmp, 'x'); unzip(fs.readFileSync(part), out);
      let root = out; const top = fs.readdirSync(out);                      // a zip with one top folder: serve that folder
      if (top.length === 1 && fs.statSync(path.join(out, top[0])).isDirectory()) root = path.join(out, top[0]);
      if (!fs.readdirSync(root).some((f) => /\.html?$/i.test(f))) throw new ApiError(502, 'The download did not contain a web page');
      fs.writeFileSync(path.join(root, '.installed'), JSON.stringify({ version: r.tag.replace(/^v/, '') }));
      const dest = path.join(base, i.dir); fs.rmSync(dest, { recursive: true, force: true }); fs.renameSync(root, dest);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  async ensureReader(forId) {     // the first content pack pulls the reader in automatically
    const rm = this.byid.reader; if (!rm || this.installed(rm)) return;
    this.set(forId, { message: 'Installing the reader first…' });
    await this.installReader(rm, forId);
  }
  async remove(m) {
    const ins = this.installed(m); if (!ins) throw new ApiError(404, 'Not installed');
    const k = m.install.kind;
    if (k === 'kiwix-tools') { fs.rmSync(path.join(this.cfg.dataDir, 'reader'), { recursive: true, force: true }); await this.restartLibrary(); return; }
    if (k === 'gguf') { await this.cfg.onAiChange('stop'); fs.unlinkSync(path.join(this.d('ai'), 'models', m.install.file)); return; }
    if (k === 'llama-cpp') { await this.cfg.onAiChange('stop'); fs.rmSync(path.join(this.d('ai'), 'engine'), { recursive: true, force: true }); return; }
    if (k === 'python-wheel') {            // the program goes; accounts and lessons in <data>/<dir>/home stay
      await this.cfg.onKolibriChange('stop'); fs.rmSync(path.join(this.cfg.dataDir, m.install.dir, 'app'), { recursive: true, force: true }); return;
    }
    if (k === 'static-site' || k === 'bundled') { fs.rmSync(path.join(this.d('sites'), m.install.dir), { recursive: true, force: true }); return; }
    const folder = { zim: 'zim', maps: 'maps', 'pmtiles-file': 'maps', app: 'apps' }[k];
    for (const f of ins.files) fs.unlinkSync(path.join(this.d(folder), f));
    if (k === 'zim') await this.restartLibrary();
  }
  // ---------- HTTP-shaped front door (used by the local server)
  async handle(method, route, query, body) {
    try {
      if (method === 'GET') {
        if (route === '/catalog') return { code: 200, body: { modules: this.catalog(), disk: this.disk(), sizesPending: this.sizesPending() } };
        if (route === '/status') return { code: 200, body: this.status() };
        if (route === '/info') return { code: 200, body: await this.info(query.get('id') || '') };
        throw new ApiError(404, 'Not found');
      }
      if (route === '/refresh') return { code: 200, body: await this.refresh() };
      if (route === '/pin') return { code: 200, body: { ok: true } };            // no PIN on this device: it is your own app
      if (route === '/cancel') { this.cancel(String((body && body.id) || '')); return { code: 200, body: { ok: true } }; }
      if (route === '/install' || route === '/remove') {
        const j = this.enqueue(String((body && body.id) || ''), route.slice(1));
        return { code: 202, body: { state: j.state, percent: j.percent, message: j.message, action: j.action } };
      }
      throw new ApiError(404, 'Not found');
    } catch (e) {
      if (e instanceof ApiError) return { code: e.code, body: { error: e.msg } };
      return { code: 500, body: { error: 'Server error: ' + (e && e.name) } };
    }
  }
}

function dirSize(dir) { let n = 0; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size; } return n; }

module.exports = { Manager, ApiError, loadCatalog, human };
