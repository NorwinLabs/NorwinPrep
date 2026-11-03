'use strict';
// In-app updater for the desktop app: reads the latest GitHub release, downloads the right file for
// this install type, verifies its SHA-256 against the release's SHA256SUMS, installs it and restarts.
// Pure Node (no Electron imports) so it can be tested; main.js injects the platform actions.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const TAG_RE = /^v\d+\.\d+\.\d+$/;
const ASSET_RE = /^NorwinPrep-[A-Za-z0-9._-]+\.(apk|exe|AppImage|deb)$/;

function get(urlStr, headers, left) {
  left = left === undefined ? 5 : left;
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(u, { headers: Object.assign({ 'User-Agent': 'NorwinPrep-app' }, headers || {}) }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (left <= 0) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, u);
        if (u.protocol === 'https:' && next.protocol !== 'https:') return reject(new Error('refusing https to http redirect'));
        return resolve(get(next.toString(), headers, left - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      resolve(res);
    });
    req.setTimeout(30000, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

function readText(res, max) {
  return new Promise((resolve, reject) => {
    let d = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { d += c; if (d.length > (max || 2000000)) { res.destroy(); reject(new Error('response too large')); } });
    res.on('end', () => resolve(d));
    res.on('error', reject);
  });
}

function create(o) {
  // o: slug, apiBase, dlBase, platform ('windows'|'linux'), arch, packaging ('installer'|'portable'|'appimage'|'deb'|'dev'),
  //    appImagePath, portableDir, execPath, relaunchArgs, tmpRoot, actions: { spawnDetached(cmd,args), exec(cmd,args), quit() }
  const A = o.actions;
  let st = { state: 'idle', percent: 0, message: '', tag: '' };
  const set = (patch) => { st = Object.assign({}, st, patch); };

  async function check() {
    const res = await get(o.apiBase + '/repos/' + o.slug + '/releases/latest', { Accept: 'application/vnd.github+json' });
    const j = JSON.parse(await readText(res));
    if (!TAG_RE.test(j.tag_name || '')) throw new Error('unexpected release tag');
    return {
      tag: j.tag_name,
      url: String(j.html_url || ''),
      assets: (j.assets || []).map((a) => a && a.name).filter((n) => typeof n === 'string')
    };
  }

  async function download(url, dest) {
    const res = await get(url);
    const total = Number(res.headers['content-length']) || 0;
    const hash = crypto.createHash('sha256');
    let got = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => {
        hash.update(c); got += c.length;
        if (total) set({ percent: Math.min(99, Math.floor((got * 100) / total)) });
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      res.pipe(out);
    });
    return hash.digest('hex');
  }

  async function run(tag, asset) {
    const dir = fs.mkdtempSync(path.join(o.tmpRoot || os.tmpdir(), 'norwinprep-update-'));
    let keep = false;
    try {
      const base = o.dlBase + '/' + o.slug + '/releases/download/' + tag + '/';
      set({ state: 'downloading', percent: 0, message: 'Downloading ' + asset + '…' });
      const sums = await readText(await get(base + 'SHA256SUMS'));
      const line = sums.split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p.length >= 2 && p[1].replace(/^\*/, '') === asset);
      if (!line || !/^[0-9a-f]{64}$/i.test(line[0])) throw new Error('No checksum published for ' + asset);
      const file = path.join(dir, asset);
      const got = await download(base + asset, file);
      set({ state: 'verifying', percent: 100, message: 'Verifying download…' });
      if (got.toLowerCase() !== line[0].toLowerCase()) throw new Error('Checksum mismatch. The download was not installed.');

      set({ state: 'installing', message: 'Installing ' + tag + '…' });
      const relaunch = o.relaunchArgs || [];
      if (o.packaging === 'appimage') {
        const target = o.appImagePath;
        if (!target) throw new Error('Cannot find the AppImage to replace.');
        try { fs.accessSync(path.dirname(target), fs.constants.W_OK); }
        catch (e) { throw new Error('Cannot write to ' + path.dirname(target) + '. Move the AppImage to a folder you own.'); }
        const staged = target + '.new';
        fs.copyFileSync(file, staged);
        fs.chmodSync(staged, 0o755);
        fs.renameSync(staged, target);               // atomic; the running copy keeps working until we exit
        set({ state: 'done', message: 'Updated to ' + tag + '. Restarting…' });
        A.spawnDetached(target, relaunch);
        A.quit();
      } else if (o.packaging === 'deb') {
        fs.chmodSync(dir, 0o755); fs.chmodSync(file, 0o644);
        keep = true;                                 // keep the .deb if the install fails so you can run it by hand
        try { await A.exec('pkexec', ['apt-get', 'install', '-y', file]); }
        catch (e) { throw new Error('Install failed (' + (e && e.message ? e.message : e) + '). Run: sudo apt install ' + file); }
        keep = false;
        set({ state: 'done', message: 'Updated to ' + tag + '. Restarting…' });
        A.spawnDetached(o.execPath, relaunch);
        A.quit();
      } else if (o.packaging === 'installer') {
        keep = true;                                 // the installer runs after we quit, so it must stay on disk
        set({ state: 'done', message: 'Installing ' + tag + ' and restarting…' });
        A.spawnDetached(file, ['--updated', '/S', '--force-run']);
        A.quit();
      } else if (o.packaging === 'portable') {
        const dest = path.join(o.portableDir || os.homedir(), asset);
        fs.copyFileSync(file, dest);
        set({ state: 'done', message: 'Saved ' + dest + '. Starting the new version…' });
        A.spawnDetached(dest, relaunch);
        A.quit();
      } else {
        throw new Error('Updates apply to installed builds, not a development run.');
      }
    } catch (e) {
      set({ state: 'error', message: String(e && e.message ? e.message : e) });
    } finally {
      if (!keep) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
    }
  }

  function install(tag, asset) {
    if (!TAG_RE.test(tag || '')) throw Object.assign(new Error('bad tag'), { code: 400 });
    if (!ASSET_RE.test(asset || '')) throw Object.assign(new Error('bad asset'), { code: 400 });
    if (['downloading', 'verifying', 'installing'].includes(st.state)) throw Object.assign(new Error('An update is already running'), { code: 409 });
    set({ state: 'downloading', percent: 0, message: 'Starting…', tag });
    run(tag, asset);
    return status();
  }

  function status() { return Object.assign({}, st); }
  return { check, install, status };
}

module.exports = { create, TAG_RE, ASSET_RE };
