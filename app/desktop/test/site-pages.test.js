'use strict';
// Run: node test/site-pages.test.js. Every page in app/shared/site must have valid inline JavaScript (a typo would blank the whole page), and every
// bundled tool in the catalog must have its page.
const fs = require('fs'), path = require('path'), vm = require('vm');
const SITE = path.join(__dirname, '..', '..', 'shared', 'site');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL ' + m); } else console.log('ok   ' + m); };
const pages = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'fonts' && e.name !== 'sprites') walk(p); } else if (e.name.endsWith('.html')) pages.push(p); } })(SITE);
for (const p of pages) {
  const html = fs.readFileSync(p, 'utf8'), re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g; let m, n = 0, bad = null;
  while ((m = re.exec(html))) { n++; try { new vm.Script(m[1], { filename: p }); } catch (e) { bad = e.message; } }
  ok(!bad, path.relative(SITE, p) + ': ' + n + ' inline script(s) parse' + (bad ? ' (' + bad + ')' : ''));
}
const cat = JSON.parse(fs.readFileSync(path.join(SITE, 'catalog.json'), 'utf8'));
for (const m of cat.modules.filter((x) => x.install.kind === 'bundled')) ok(fs.existsSync(path.join(SITE, m.install.dir, 'index.html')) && m.open === '/tools/' + m.install.dir + '/', 'bundled tool ' + m.id + ' has its page and a matching open link');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
