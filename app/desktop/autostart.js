'use strict';
// Launch the app when the user logs in / the device starts. Linux: an XDG autostart entry (works on Raspberry Pi OS and most
// desktops, including when the app is an AppImage). Windows/macOS: the login-item API. Kept in one place so it can be tested.
const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = 'norwinprep.desktop';
const esc = (s) => '"' + String(s).replace(/[\\"`$]/g, '\\$&').replace(/%/g, '%%') + '"';

class Autostart {
  constructor(o) {   // o: platform, home, exec (path of the program), args, app (electron app, for win/mac)
    this.o = Object.assign({ platform: process.platform, home: os.homedir(), args: [] }, o);
    this.dir = path.join(this.o.home, '.config', 'autostart'); this.file = path.join(this.dir, FILE);
  }
  get() {
    if (this.o.platform === 'linux') return fs.existsSync(this.file);
    try { return !!this.o.app.getLoginItemSettings().openAtLogin; } catch (e) { return false; }
  }
  set(on) {
    if (this.o.platform === 'linux') {
      if (!on) { try { fs.unlinkSync(this.file); } catch (e) { /* already off */ } return false; }
      if (/[\r\n]/.test(this.o.exec + this.o.args.join(''))) throw new Error('unsupported characters in the program path');
      fs.mkdirSync(this.dir, { recursive: true });
      const exec = [esc(this.o.exec)].concat(this.o.args.map(esc)).join(' ');
      fs.writeFileSync(this.file, ['[Desktop Entry]', 'Type=Application', 'Name=NorwinPrep', 'Comment=Offline survival library and Wi-Fi sharing', 'Exec=' + exec,
        'Terminal=false', 'X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-Delay=5', ''].join('\n'), { mode: 0o644 });
      return true;
    }
    try { this.o.app.setLoginItemSettings({ openAtLogin: !!on, args: this.o.args }); } catch (e) { /* unsupported */ }
    return this.get();
  }
}
module.exports = { Autostart };
