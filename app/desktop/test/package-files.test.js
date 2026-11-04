'use strict';
// Run: node test/package-files.test.js. Every local module the app requires must be listed in package.json "build.files", or the PACKAGED app
// crashes on launch ("Cannot find module") even though running from source works. (This caught nothing once: autostart.js was missed and a build hung.)
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')), listed = new Set(pkg.build.files);
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL ' + m); } else console.log('ok   ' + m); };
const seen = new Set(), queue = ['main.js'];
while (queue.length) {
  const f = queue.shift(); if (seen.has(f)) continue; seen.add(f);
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of src.matchAll(/require\('\.\/([A-Za-z0-9._-]+)'\)/g)) { const dep = m[1].endsWith('.js') ? m[1] : m[1] + '.js'; ok(fs.existsSync(path.join(root, dep)), f + ' requires ./' + m[1] + ' which exists'); queue.push(dep); }
}
for (const f of seen) ok(listed.has(f), f + ' is packaged (listed in build.files)');
for (const f of listed) if (!f.includes('*') && f !== 'icon.png') ok(fs.existsSync(path.join(root, f)), f + ' is listed and exists');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
