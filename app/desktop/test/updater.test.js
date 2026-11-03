'use strict';
// Run: node test/updater.test.js   (no Electron needed)
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const assert = require('assert');
const { create } = require('../updater');

const TAG = 'v0.6.9', SLUG = 'NorwinLabs/NorwinPrepDisk';
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL ' + m); } else console.log('ok   ' + m); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const files = {
  'NorwinPrep-0.6.9-linux-arm64.AppImage': Buffer.from('#!/bin/sh\necho new appimage\n'),
  'NorwinPrep-0.6.9-win-x64.exe': Buffer.from('MZ-installer'),
  'NorwinPrep-0.6.9-portable-x64.exe': Buffer.from('MZ-portable'),
  'NorwinPrep-0.6.9-linux-arm64.deb': Buffer.from('!<arch>deb'),
  'NorwinPrep-0.6.9-linux-amd64.deb': Buffer.from('!<arch>deb2')
};
let badSums = false, slow = false;
const server = http.createServer((q, r) => {
  const base = `/${SLUG}/releases/download/${TAG}/`;
  if (q.url === `/repos/${SLUG}/releases/latest`) {
    r.writeHead(200, { 'Content-Type': 'application/json' });
    return r.end(JSON.stringify({ tag_name: TAG, html_url: 'https://github.com/x/y/releases/tag/' + TAG,
      assets: Object.keys(files).map((name) => ({ name })).concat([{ name: 'SHA256SUMS' }]), body: 'ignored' }));
  }
  if (q.url === base + 'SHA256SUMS') {
    r.writeHead(200);
    let t = Object.keys(files).map((n) => sha(files[n]) + '  ' + n).join('\n') + '\n';
    if (badSums) t = t.replace(/[0-9a-f]/, (c) => (c === '0' ? '1' : '0'));   // corrupt the first hash
    return r.end(t);
  }
  if (q.url.startsWith(base) && files[q.url.slice(base.length)]) {      // GitHub redirects to a CDN host
    r.writeHead(302, { Location: '/cdn/' + q.url.slice(base.length) });
    return r.end();
  }
  if (q.url.startsWith('/cdn/') && files[q.url.slice(5)]) {
    const b = files[q.url.slice(5)];
    r.writeHead(200, { 'Content-Length': b.length });
    if (!slow) return r.end(b);
    r.write(b.slice(0, 2)); return setTimeout(() => r.end(b.slice(2)), 600);
  }
  r.writeHead(404); r.end('nope');
});

function harness(over) {
  const calls = { spawn: [], exec: [], quit: 0 };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nptest-'));
  const u = create(Object.assign({
    slug: SLUG, apiBase: 'http://127.0.0.1:' + server.address().port, dlBase: 'http://127.0.0.1:' + server.address().port,
    platform: 'linux', arch: 'arm64', packaging: 'appimage', tmpRoot: tmp, relaunchArgs: ['--kiosk'],
    actions: {
      spawnDetached: (c, a) => calls.spawn.push([c, a]),
      exec: (c, a) => { calls.exec.push([c, a]); return calls.execFail ? Promise.reject(new Error('exit 126')) : Promise.resolve(); },
      quit: () => { calls.quit++; }
    }
  }, over));
  return { u, calls, tmp };
}
const waitDone = async (u) => { for (let i = 0; i < 100; i++) { const s = u.status(); if (s.state === 'done' || s.state === 'error') return s; await new Promise((r) => setTimeout(r, 50)); } return u.status(); };

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  // ---- check ----
  let h = harness({});
  const c = await h.u.check();
  ok(c.tag === TAG && c.assets.includes('SHA256SUMS') && c.assets.length === 6 && c.url.includes('releases'), 'check() summarises the latest release');
  const evil = harness({ apiBase: 'http://127.0.0.1:1' });
  await evil.u.check().then(() => ok(false, 'unreachable API rejects'), () => ok(true, 'check() rejects when GitHub is unreachable'));

  // ---- validation ----
  for (const [t, a, why] of [['v1', 'NorwinPrep-1-linux-arm64.deb', 'bad tag'], [TAG, '../../etc/passwd', 'path in asset'],
    [TAG, 'evil.sh', 'wrong asset name'], ['v0.6.9; rm -rf', 'NorwinPrep-0.6.9-win-x64.exe', 'injection in tag']]) {
    try { h.u.install(t, a); ok(false, 'rejects ' + why); } catch (e) { ok(e.code === 400, 'rejects ' + why); }
  }

  // ---- AppImage: replace in place, make executable, relaunch ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npapp-')); const target = path.join(dir, 'NorwinPrep.AppImage');
  fs.writeFileSync(target, 'OLD'); fs.chmodSync(target, 0o755);
  h = harness({ appImagePath: target });
  h.u.install(TAG, 'NorwinPrep-0.6.9-linux-arm64.AppImage');
  let s = await waitDone(h.u);
  ok(s.state === 'done' && fs.readFileSync(target, 'utf8').includes('new appimage'), 'AppImage replaced with the verified download');
  ok((fs.statSync(target).mode & 0o111) !== 0, 'replacement is executable');
  ok(h.calls.spawn.length === 1 && h.calls.spawn[0][0] === target && h.calls.spawn[0][1][0] === '--kiosk' && h.calls.quit === 1, 'relaunches the new AppImage with --kiosk, then quits');
  ok(fs.readdirSync(h.tmp).length === 0, 'temp download folder cleaned up');
  ok(!fs.existsSync(target + '.new'), 'no staging file left behind');

  // ---- wrong checksum: nothing installed, nothing launched ----
  fs.writeFileSync(target, 'OLD'); badSums = true;
  h = harness({ appImagePath: target });
  h.u.install(TAG, 'NorwinPrep-0.6.9-linux-arm64.AppImage');
  s = await waitDone(h.u); badSums = false;
  ok(s.state === 'error' && /Checksum mismatch/.test(s.message), 'checksum mismatch is reported');
  ok(fs.readFileSync(target, 'utf8') === 'OLD' && h.calls.spawn.length === 0 && h.calls.quit === 0, 'bad download is NOT installed and the app is NOT restarted');

  // ---- asset with no published checksum ----
  h = harness({ appImagePath: target });
  h.u.install(TAG, 'NorwinPrep-0.6.9-linux-armv7l.AppImage');
  s = await waitDone(h.u);
  ok(s.state === 'error', 'unknown/unlisted asset is an error (' + s.message + ')');

  // ---- read-only folder ----
  h = harness({ appImagePath: '/proc/nope/NorwinPrep.AppImage' });
  h.u.install(TAG, 'NorwinPrep-0.6.9-linux-arm64.AppImage');
  s = await waitDone(h.u);
  ok(s.state === 'error' && /Cannot write/.test(s.message), 'unwritable AppImage folder gives a clear error');

  // ---- Windows installer: silent update, relaunch after ----
  h = harness({ platform: 'windows', arch: 'x64', packaging: 'installer' });
  h.u.install(TAG, 'NorwinPrep-0.6.9-win-x64.exe');
  s = await waitDone(h.u);
  ok(s.state === 'done' && h.calls.spawn.length === 1 && /win-x64\.exe$/.test(h.calls.spawn[0][0]) &&
    h.calls.spawn[0][1].join(' ') === '--updated /S --force-run' && h.calls.quit === 1, 'Windows installer started silently with --force-run, then app quits');
  ok(fs.existsSync(h.calls.spawn[0][0]), 'installer stays on disk until it has run');

  // ---- Windows portable: saved next to the old one, new one started ----
  const pdir = fs.mkdtempSync(path.join(os.tmpdir(), 'npport-'));
  h = harness({ platform: 'windows', arch: 'x64', packaging: 'portable', portableDir: pdir });
  h.u.install(TAG, 'NorwinPrep-0.6.9-portable-x64.exe');
  s = await waitDone(h.u);
  ok(s.state === 'done' && fs.readFileSync(path.join(pdir, 'NorwinPrep-0.6.9-portable-x64.exe'), 'utf8') === 'MZ-portable' && h.calls.spawn[0][0].startsWith(pdir), 'portable build saved beside the old one and started');

  // ---- .deb: pkexec apt install, then relaunch ----
  h = harness({ packaging: 'deb', execPath: '/opt/NorwinPrep/norwinprep' });
  h.u.install(TAG, 'NorwinPrep-0.6.9-linux-arm64.deb');
  s = await waitDone(h.u);
  ok(s.state === 'done' && h.calls.exec[0][0] === 'pkexec' && h.calls.exec[0][1].slice(0, 3).join(' ') === 'apt-get install -y' &&
    h.calls.spawn[0][0] === '/opt/NorwinPrep/norwinprep' && h.calls.quit === 1, 'deb installed through pkexec apt-get, then relaunched');
  h = harness({ packaging: 'deb', execPath: '/opt/NorwinPrep/norwinprep' }); h.calls.execFail = true;
  h.u.install(TAG, 'NorwinPrep-0.6.9-linux-amd64.deb');
  s = await waitDone(h.u);
  ok(s.state === 'error' && /sudo apt install/.test(s.message) && h.calls.quit === 0, 'failed deb install explains the manual command and keeps the app running');
  ok(fs.readdirSync(h.tmp).length === 1, 'failed deb is kept for the manual install');

  // ---- dev run ----
  h = harness({ packaging: 'dev' });
  h.u.install(TAG, 'NorwinPrep-0.6.9-linux-arm64.deb');
  s = await waitDone(h.u);
  ok(s.state === 'error' && /installed builds/.test(s.message), 'development runs refuse to self-update');

  // ---- concurrency ----
  slow = true;
  h = harness({ appImagePath: target });
  h.u.install(TAG, 'NorwinPrep-0.6.9-linux-arm64.AppImage');
  try { h.u.install(TAG, 'NorwinPrep-0.6.9-linux-arm64.AppImage'); ok(false, 'second install while running is refused'); }
  catch (e) { ok(e.code === 409, 'second install while one is running is refused'); }
  await waitDone(h.u); slow = false;

  server.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
