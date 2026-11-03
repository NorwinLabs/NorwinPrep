// Copies shared assets (connect page, icon) next to main.js so electron-builder can package them.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
fs.copyFileSync(path.join(root, '..', 'shared', 'connect.html'), path.join(root, 'connect.html'));
fs.copyFileSync(path.join(root, '..', 'shared', 'icon.png'), path.join(root, 'icon.png'));
console.log('assets prepared');
