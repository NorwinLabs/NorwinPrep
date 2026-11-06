'use strict';
// Real-network test of the "offline maps" installer (Protomaps build + go-pmtiles extract), with a tiny region so it finishes in a minute.
const fs = require('fs'), os = require('os'), path = require('path');
const { Manager } = require('../modules-manager');
(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'npmaps-')), cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'site', 'catalog.json'), 'utf8'));
  const tpl = cat.modules.find((m) => m.id === 'map-world'); cat.modules = [Object.assign({}, tpl, { id: 'map-tiny', install: { kind: 'maps', file: 'tiny.pmtiles', maxzoom: 8, bbox: '-0.3,51.4,0.1,51.6' } })]; cat.tiers = []; cat.topics = [];
  const cp = path.join(data, 'catalog.json'); fs.writeFileSync(cp, JSON.stringify(cat));
  const mgr = new Manager({ catalog: cp, dataDir: data, platform: process.platform, arch: process.arch, timeout: 60000 });
  console.log('build:', await mgr.protomapsBuild(true));
  const info = await mgr.handle('GET', '/info', new URLSearchParams('id=map-tiny'), null); console.log('info', JSON.stringify(info));
  mgr.enqueue('map-tiny', 'install'); let j; for (let i = 0; i < 600; i++) { j = mgr.jobs['map-tiny']; if (j.state === 'done' || j.state === 'error') break; await new Promise((r) => setTimeout(r, 500)); }
  console.log('job:', JSON.stringify(j));
  const f = path.join(data, 'maps', 'tiny.pmtiles'); const ok = j.state === 'done' && fs.existsSync(f) && fs.readFileSync(f).subarray(0, 7).toString() === 'PMTiles';
  console.log(ok ? 'ALL PASSED (' + fs.statSync(f).size + ' bytes)' : 'FAILED'); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
