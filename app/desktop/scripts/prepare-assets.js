// Copies shared assets (home page, icon) next to main.js so electron-builder can package them.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), shared = path.join(root, '..', 'shared');
fs.rmSync(path.join(root, 'site'), { recursive: true, force: true });
fs.cpSync(path.join(shared, 'site'), path.join(root, 'site'), { recursive: true });
fs.copyFileSync(path.join(shared, 'icon.png'), path.join(root, 'icon.png'));
console.log('assets prepared');
try { require('./prepare-map-assets'); } catch (e) { console.warn('WARNING: map viewer assets not bundled: ' + e.message); }
