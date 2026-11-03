// Bundles the offline map viewer's libraries, fonts and icons into the desktop app (so maps work with no internet).
// Libraries come from npm devDependencies; fonts/sprites come from the Protomaps basemaps-assets repo (cloned once into .cache).
// Best effort: if the fonts can't be fetched (offline build) the app still builds, only map labels are missing.
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const root = path.join(__dirname, '..'), out = path.join(root, 'site', 'maps');
const mods = path.join(root, 'node_modules');
const vendor = path.join(out, 'vendor');
fs.mkdirSync(vendor, { recursive: true });
for (const [from, to] of [['maplibre-gl/dist/maplibre-gl.js', 'maplibre-gl.js'], ['maplibre-gl/dist/maplibre-gl.css', 'maplibre-gl.css'], ['pmtiles/dist/pmtiles.js', 'pmtiles.js'], ['@protomaps/basemaps/dist/basemaps.js', 'basemaps.js']]) {
  fs.copyFileSync(path.join(mods, from), path.join(vendor, to));
}
const cache = path.join(root, '.cache', 'basemaps-assets');
try {
  if (!fs.existsSync(path.join(cache, 'fonts'))) { fs.mkdirSync(path.dirname(cache), { recursive: true }); execFileSync('git', ['clone', '--depth', '1', 'https://github.com/protomaps/basemaps-assets.git', cache], { stdio: 'ignore', timeout: 120000 }); }
  for (const f of ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic']) fs.cpSync(path.join(cache, 'fonts', f), path.join(out, 'fonts', f), { recursive: true });
  fs.cpSync(path.join(cache, 'sprites'), path.join(out, 'sprites'), { recursive: true });
  console.log('map assets prepared (libraries, fonts, sprites)');
} catch (e) { console.warn('WARNING: map fonts/sprites were not fetched (' + (e.message || e).split('\n')[0] + '). Map labels will be missing until you build online.'); }
