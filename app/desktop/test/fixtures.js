'use strict';
// Fake Kiwix / GitHub / Protomaps servers shared by the tests. They serve real tar.gz archives containing stand-in
// `kiwix-serve` and `pmtiles` programs, so the reader and map-tool installs run end to end.
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), { execFileSync } = require('child_process');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
// ---- fake downloads ----
const ZIM = crypto.randomBytes(300000), WATER = crypto.randomBytes(120000), APK = crypto.randomBytes(50000), EXE = crypto.randomBytes(60000), PEXE = crypto.randomBytes(61000);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'npmod-fixtures-'));
function tarball(name, files) {
  const d = fs.mkdtempSync(path.join(work, 'src-')); for (const [n, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, n)), { recursive: true }); fs.writeFileSync(path.join(d, n), body, { mode: 0o755 }); }
  const out = path.join(work, name); execFileSync('tar', ['-czf', out, '-C', d, '.']); return fs.readFileSync(out);
}
const PM_TAR = tarball('pm.tar.gz', { pmtiles: '#!/bin/sh\n[ -n "$FAKE_PM_FAIL" ] && { echo "boom: source unreachable" >&2; exit 1; }\nprintf "PM:%s" "$2" > "$3"\n' });
const FAKE_KIWIX = `#!/usr/bin/env node
const a = process.argv.slice(2); const port = Number(a[a.indexOf('--port') + 1]);
require('http').createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/plain' }); r.end('KIWIX path=' + q.url + ' zims=' + a.filter((x) => x.endsWith('.zim')).map((x) => require('path').basename(x)).join(',')); }).listen(port, '127.0.0.1');
`;
const KW_TAR = tarball('kw.tar.gz', { 'kiwix-tools_linux-x86_64-3.7.0/kiwix-serve': FAKE_KIWIX, 'kiwix-tools_linux-x86_64-3.7.0/libfake.so': 'lib' });
const F = { shaOk: true, shaMissing: false, newZim: '2025-03', tag: 'v0.6.9', apkSumOk: true, readerListing: true };
const server = http.createServer((q, r) => {
  const out = (code, body, h) => { r.writeHead(code, Object.assign({ 'Content-Length': Buffer.byteLength(body) }, h || {})); r.end(q.method === 'HEAD' ? undefined : body); };
  const p = q.url.split('?')[0];
  const zims = { ['/zim/other/zimgit-medicine_en_' + F.newZim + '.zim']: ZIM, '/zim/other/zimgit-water_en_2025-01.zim': WATER };
  if (p === '/zim/other/') return out(200, Object.keys(zims).map((n) => { const b = n.split('/').pop(); return '<a href="' + b + '">' + b + '</a><a href="' + b + '.sha256">x</a>'; }).join('\n') + '<a href="zimgit-medicine_en_2024-06.zim">old</a>');
  if (zims[p]) {
    const data = zims[p], rng = q.headers.range;
    if (rng && q.method !== 'HEAD') { const start = Number(rng.match(/bytes=(\d+)-/)[1]); return out(206, data.slice(start), { 'Content-Range': 'bytes ' + start + '-' + (data.length - 1) + '/' + data.length }); }
    r.writeHead(200, { 'Content-Length': data.length }); return r.end(q.method === 'HEAD' ? undefined : data);
  }
  if (p.endsWith('.zim.sha256') && zims[p.slice(0, -7)]) return F.shaMissing ? out(404, 'no') : out(200, (F.shaOk ? sha(zims[p.slice(0, -7)]) : '0'.repeat(64)) + '  x\n');
  if (p === '/repos/NorwinLabs/NorwinPrepDisk/releases/latest') { const t = F.tag.slice(1); return out(200, JSON.stringify({ tag_name: F.tag, assets: [{ name: 'NorwinPrep-' + t + '-android.apk', size: APK.length }, { name: 'NorwinPrep-' + t + '-win-x64.exe', size: EXE.length }, { name: 'NorwinPrep-' + t + '-portable-x64.exe', size: PEXE.length }, { name: 'SHA256SUMS', size: 400 }, { name: 'random.txt', size: 1 }] })); }
  let m = p.match(/^\/NorwinLabs\/NorwinPrepDisk\/releases\/download\/(v[\d.]+)\/(.+)$/);
  if (m) {
    const t = m[1].slice(1), files = { ['NorwinPrep-' + t + '-android.apk']: APK, ['NorwinPrep-' + t + '-win-x64.exe']: EXE, ['NorwinPrep-' + t + '-portable-x64.exe']: PEXE };
    if (m[2] === 'SHA256SUMS') return out(200, Object.keys(files).map((n) => (n.endsWith('.apk') && !F.apkSumOk ? '1'.repeat(64) : sha(files[n])) + '  ' + n).join('\n') + '\n');
    if (files[m[2]]) return out(200, files[m[2]], { 'Content-Type': 'application/octet-stream' });
  }
  if (p === '/builds.json') return out(200, '[{"key":"20260101.pmtiles"},{"key":"20260301.pmtiles"}]');
  if (p === '/repos/protomaps/go-pmtiles/releases/latest') return out(200, JSON.stringify({ tag_name: 'v1.2.3' }));
  if (p === '/protomaps/go-pmtiles/releases/download/v1.2.3/go-pmtiles_1.2.3_Linux_x86_64.tar.gz') return out(200, PM_TAR);
  if (p === '/protomaps/go-pmtiles/releases/download/v1.2.3/go-pmtiles_1.2.3_checksums.txt') return out(200, sha(PM_TAR) + '  go-pmtiles_1.2.3_Linux_x86_64.tar.gz\n');
  if (p === '/release/kiwix-tools/') return F.readerListing ? out(200, '<a href="kiwix-tools_linux-x86_64-3.6.0.tar.gz">a</a><a href="kiwix-tools_linux-x86_64-3.7.0.tar.gz">b</a><a href="kiwix-tools_linux-x86_64-3.7.0.tar.gz.sha256">c</a><a href="kiwix-tools_win-i686-3.7.0.zip">w</a>') : out(200, '<a href="other.txt">x</a>');
  if (p === '/release/kiwix-tools/kiwix-tools_linux-x86_64-3.7.0.tar.gz') { r.writeHead(302, { Location: '/cdn/kw.tgz' }); return r.end(); }
  if (p === '/cdn/kw.tgz') return out(200, KW_TAR);
  if (p === '/release/kiwix-tools/kiwix-tools_linux-x86_64-3.7.0.tar.gz.sha256') return out(200, sha(KW_TAR) + '  kiwix-tools_linux-x86_64-3.7.0.tar.gz\n');
  out(404, 'nope');
});


module.exports = { ZIM, WATER, APK, EXE, PEXE, F, server, PM_TAR, KW_TAR, sha, work };
