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
// stand-ins for CyberChef's release zip: normal, one with a "../" path (must be refused), and one wrapped in a top folder
const ZIP_GOOD = Buffer.from('UEsDBBQAAAAIAGN3ZF0tCamhQgAAAK8TAAAWAAAAQ3liZXJDaGVmX3YxMC4wLjAuaHRtbO3IsQ2AIBBA0VVgAha4UEjOUNNZK4kmGCiuwO0tnMHuv/KJP/puz6jutLtFsctajWlbtKSsq4QvJgAAAAAAAIDfvVBLAwQUAAAACABjd2RdaP4BQxAAAAAOAAAADQAAAGFzc2V0cy9hcHAuanNLzs8rzs9J1cvJT9cw1AQAUEsBAhQDFAAAAAgAY3dkXS0JqaFCAAAArxMAABYAAAAAAAAAAAAAAIABAAAAAEN5YmVyQ2hlZl92MTAuMC4wLmh0bWxQSwECFAMUAAAACABjd2RdaP4BQxAAAAAOAAAADQAAAAAAAAAAAAAAgAF2AAAAYXNzZXRzL2FwcC5qc1BLBQYAAAAAAgACAH8AAACxAAAAAAA=', 'base64'), ZIP_EVIL = Buffer.from('UEsDBBQAAAAAAAAAIQAVHoDMEAAAABAAAAAWAAAAQ3liZXJDaGVmX3YxMC4wLjAuaHRtbDx0aXRsZT54PC90aXRsZT5QSwMEFAAAAAAAAAAhAH5TBNkFAAAABQAAAAsAAAAuLi9ldmlsLnR4dHB3bmVkUEsBAhQDFAAAAAAAAAAhABUegMwQAAAAEAAAABYAAAAAAAAAAAAAAIABAAAAAEN5YmVyQ2hlZl92MTAuMC4wLmh0bWxQSwECFAMUAAAAAAAAACEAflME2QUAAAAFAAAACwAAAAAAAAAAAAAAgAFEAAAALi4vZXZpbC50eHRQSwUGAAAAAAIAAgB9AAAAcgAAAAAA', 'base64'), ZIP_FOLDER = Buffer.from('UEsDBBQAAAAIAGN3ZF1twgYfEgAAABUAAAAUAAAAQ3liZXJDaGVmL2luZGV4Lmh0bWyzKcksyUm1c/P3cXENstGH8ABQSwMEFAAAAAgAY3dkXbfv3IMDAAAAAQAAAA4AAABDeWJlckNoZWYvYS5qczMEAFBLAQIUAxQAAAAIAGN3ZF1twgYfEgAAABUAAAAUAAAAAAAAAAAAAACAAQAAAABDeWJlckNoZWYvaW5kZXguaHRtbFBLAQIUAxQAAAAIAGN3ZF2379yDAwAAAAEAAAAOAAAAAAAAAAAAAACAAUQAAABDeWJlckNoZWYvYS5qc1BLBQYAAAAAAgACAH4AAABzAAAAAAA=', 'base64');
const WHEEL = Buffer.from('UEsDBBQAAAAIAKN6ZF0d6+inDQAAAAsAAAATAAAAa29saWJyaS9fX2luaXRfXy5weVNWKC5JzEvRzczjAgBQSwMEFAAAAAgAo3pkXR3r6KcNAAAACwAAABMAAABrb2xpYnJpL19fbWFpbl9fLnB5U1YoLknMS9HNzOMCAFBLAwQUAAAACACjemRdGf95axAAAAAOAAAAIQAAAGtvbGlicmktMC4xOS41LmRpc3QtaW5mby9NRVRBREFUQfNLzE21UsjOz8lMKsrkAgBQSwECFAMUAAAACACjemRdHevopw0AAAALAAAAEwAAAAAAAAAAAAAAgAEAAAAAa29saWJyaS9fX2luaXRfXy5weVBLAQIUAxQAAAAIAKN6ZF0d6+inDQAAAAsAAAATAAAAAAAAAAAAAACAAT4AAABrb2xpYnJpL19fbWFpbl9fLnB5UEsBAhQDFAAAAAgAo3pkXRn/eWsQAAAADgAAACEAAAAAAAAAAAAAAIABfAAAAGtvbGlicmktMC4xOS41LmRpc3QtaW5mby9NRVRBREFUQVBLBQYAAAAAAwADANEAAADLAAAAAAA=', 'base64');   // stand-in for the Kolibri wheel on PyPI
// stand-in for llama.cpp's release zip (holds the fake llama-server) and a tiny "model" file
const LLAMA_ZIP = Buffer.from('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', 'base64'), GGUF = Buffer.from('GGUF' + 'x'.repeat(200000));
const F = { llamaSha: 'ok', ggufSha: 'ok', kolibriSha: 'ok', cyber: 'good', cyberDigest: true, shaOk: true, shaMissing: false, newZim: '2025-03', tag: 'v0.6.9', apkSumOk: true, readerListing: true };
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
  if (p === '/repos/gchq/CyberChef/releases/latest') {
    const z = F.cyber === 'evil' ? ZIP_EVIL : F.cyber === 'folder' ? ZIP_FOLDER : ZIP_GOOD;
    return out(200, JSON.stringify({ tag_name: 'v10.0.0', assets: [{ name: 'other.txt', size: 1 }, { name: 'CyberChef_v10.0.0.zip', size: z.length, digest: F.cyberDigest ? 'sha256:' + (F.cyberDigest === 'wrong' ? '0'.repeat(64) : sha(z)) : undefined }] }));
  }
  if (p === '/gchq/CyberChef/releases/download/v10.0.0/CyberChef_v10.0.0.zip') return out(200, F.cyber === 'evil' ? ZIP_EVIL : F.cyber === 'folder' ? ZIP_FOLDER : ZIP_GOOD);
  if (p === '/repos/ggml-org/llama.cpp/releases') {            // newest first; the repo's newest release is a nightly stub with no binaries, the build is the one before it
    const t = 'b9999', mk = (n, size, z) => ({ name: n, size: size || (z || LLAMA_ZIP).length, digest: F.llamaSha === 'none' ? undefined : 'sha256:' + (F.llamaSha === 'bad' ? '2'.repeat(64) : sha(z || LLAMA_ZIP)) });
    return out(200, JSON.stringify([{ tag_name: 'v0.9.0', assets: [{ name: 'nightly-tag.txt', size: 7 }] }, { tag_name: 'b9998', prerelease: true, assets: [mk('llama-b9998-bin-ubuntu-x64.zip')] }, { tag_name: t, assets: [mk('llama-' + t + '-bin-ubuntu-vulkan-x64.zip', 900000000, Buffer.from('v')), mk('llama-' + t + '-bin-ubuntu-x64.zip'), mk('llama-' + t + '-bin-win-cuda-12.4-x64.zip', 800000000, Buffer.from('c')),
      mk('llama-' + t + '-bin-win-cpu-x64.zip'), mk('llama-' + t + '-bin-macos-arm64.zip'), mk('cudart-llama-bin-win-cuda-12.4-x64.zip', 400000000, Buffer.from('r')), mk('llama-' + t + '-xcframework.zip', 100, Buffer.from('i'))] }]));
  }
  m = p.match(/^\/ggml-org\/llama\.cpp\/releases\/download\/b9999\/(llama-b9999-bin-(?:ubuntu-x64|win-cpu-x64|macos-arm64)\.zip)$/); if (m) return out(200, LLAMA_ZIP);
  if (p === '/api/models/Qwen/Qwen2.5-0.5B-Instruct-GGUF/tree/main') return out(200, JSON.stringify([{ type: 'file', path: 'README.md', size: 10 }, { type: 'file', path: 'qwen2.5-0.5b-instruct-q4_k_m.gguf', size: GGUF.length, lfs: { oid: F.ggufSha === 'nolfs' ? undefined : sha(GGUF), size: GGUF.length } }]));
  if (p === '/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf') {
    const data = F.ggufSha === 'bad' ? Buffer.from('GGUF' + 'y'.repeat(200000)) : GGUF, rng = q.headers.range;
    if (rng && q.method !== 'HEAD') { const start = Number(rng.match(/bytes=(\d+)-/)[1]); return out(206, data.slice(start), { 'Content-Range': 'bytes ' + start + '-' + (data.length - 1) + '/' + data.length }); }
    return out(200, data);
  }
  if (p === '/pypi/kolibri/json') return out(200, JSON.stringify({ info: { version: '0.19.5', requires_python: '<3.15,>=3.6' }, urls: [{ packagetype: 'sdist', filename: 'kolibri-0.19.5.tar.gz', url: 'http://x/y', size: 1, digests: { sha256: '0'.repeat(64) } },
    { packagetype: 'bdist_wheel', filename: 'kolibri-0.19.5-py2.py3-none-any.whl', url: 'http://' + q.headers.host + '/files/kolibri-0.19.5-py2.py3-none-any.whl', size: WHEEL.length, digests: { sha256: F.kolibriSha === 'bad' ? '1'.repeat(64) : sha(WHEEL) } }] }));
  if (p === '/files/kolibri-0.19.5-py2.py3-none-any.whl') return out(200, WHEEL);
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


module.exports = { LLAMA_ZIP, GGUF, ZIM, WATER, APK, EXE, PEXE, F, server, PM_TAR, KW_TAR, sha, work };
