'use strict';
// Guards against "X is not defined" crashes in main.js's quit handler: every name it uses must be declared at module level
// (it once used `kolibri` and `ai`, which only existed inside startServer, so quitting the app threw an error dialog).
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL ' + m); } else console.log('ok   ' + m); };
const m = src.match(/app\.on\('before-quit'[\s\S]*?\n\}\);/); ok(!!m, 'found the before-quit handler');
const top = (src.match(/^let [^;]+;/gm) || []).join(' ') + ' ' + (src.match(/^const [^=]+=/gm) || []).join(' ');
const used = new Set(); for (const x of (m ? m[0] : '').matchAll(/\b([a-z][A-Za-z0-9]*)\s*\?\s*\1\.(?:stop|shutdown)\b/g)) used.add(x[1]);
ok(used.size >= 4, 'it stops several services: ' + [...used].join(', '));
for (const n of used) ok(new RegExp('\\b' + n + '\\b').test(top), n + ' is declared at module level');
const inner = (src.match(/^ {2,}(?:const|let) (kolibri|ai|reader|share)\b/gm) || []); ok(inner.length === 0, 'none of them is re-declared inside a function: ' + inner.join(','));
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
