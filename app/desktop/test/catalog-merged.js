'use strict';
// The shipped catalog plus test-only extras (modules users no longer see, whose installers are still tested). Returns the path of a temp file.
const fs = require('fs'), os = require('os'), path = require('path');
const SHIPPED = path.join(__dirname, '..', '..', 'shared', 'site', 'catalog.json');
function merged() {
  const cat = JSON.parse(fs.readFileSync(SHIPPED, 'utf8')), extra = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog-extras.json'), 'utf8')), have = new Set(cat.modules.map((m) => m.id));
  for (const m of extra.modules) if (!have.has(m.id)) cat.modules.push(m);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'npcat-')), 'catalog.json'); fs.writeFileSync(f, JSON.stringify(cat)); return f;
}
module.exports = { SHIPPED, merged };
