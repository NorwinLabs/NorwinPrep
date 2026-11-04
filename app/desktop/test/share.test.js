'use strict';
// Run: node test/share.test.js
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { Share } = require('../share');
const { createShare } = require('../local-server');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL ' + m); } else console.log('ok   ' + m); };
const get = (port, p) => new Promise((res, rej) => { http.get({ host: '127.0.0.1', port, path: p }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res({ code: r.statusCode, body: d })); }).on('error', rej); });
const site = fs.mkdtempSync(path.join(os.tmpdir(), 'npshare-site-')); fs.writeFileSync(path.join(site, 'portal.html'), '<title>PORTAL</title>');

function harness(over) {
  const calls = [], dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npshare-')); const st = { wifi: 'wlan0', route: 'eth0', failUp: false, noNm: false };
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'nmcli' && st.noNm) throw Object.assign(new Error('ENOENT'), { stderr: 'not found' });
    if (cmd === 'nmcli' && args[args.length - 1] === 'device') return { stdout: 'lo:loopback\neth0:ethernet\n' + (st.wifi ? st.wifi + ':wifi\n' : '') };
    if (cmd === 'ip') return { stdout: 'default via 192.168.1.1 dev ' + st.route + ' proto dhcp\n' };
    if (cmd === 'nmcli' && args[1] === 'up' && st.failUp) throw Object.assign(new Error('x'), { stderr: 'Error: Connection activation failed: Not authorized to control networking.\nmore' });
    return { stdout: '' };
  };
  const mk = () => createShare({ siteDir: site, mapsDir: dir, appsDir: dir, reader: null, getName: () => 'Garage Pi', version: '1.0' });
  const sh = new Share(Object.assign({ dataDir: dir, platform: 'linux', exec, makeServer: mk, ports: [0] }, over)); return { sh, calls, st, dir };
}
const nm = (calls, ...a) => calls.filter((c) => c[0] === 'nmcli' && a.every((x, i) => c[1 + i] === x));
(async () => {
  let { sh, calls, st, dir } = harness();
  let s = await sh.status(); ok(s.supported && !s.active, 'supported on Linux with a Wi-Fi adapter');
  s = await sh.set(true);
  ok(s.active && s.ssid === 'NorwinPrep' && s.password === 'NORWINNOMAD' && s.url.startsWith('http://10.42.0.1'), 'turning sharing on: hotspot + the NORWINNOMAD password + address ' + s.url);
  const add = nm(calls, 'connection', 'add')[0];
  ok(add && add.includes('wlan0') && add.includes('ipv4.method') && add[add.indexOf('ipv4.method') + 1] === 'shared' && add[add.indexOf('802-11-wireless.mode') + 1] === 'ap' && add[add.indexOf('wifi-sec.key-mgmt') + 1] === 'wpa-psk' && add[add.indexOf('autoconnect') + 1] === 'no', 'the hotspot is WPA2, shared-mode, not auto-connecting at boot');
  ok(nm(calls, 'connection', 'up').length === 1 && (await get(sh.port, '/')).body.includes('PORTAL'), 'brought up, and the share server answers for devices that join');
  ok((fs.statSync(path.join(dir, 'share.json')).mode & 0o077) === 0, 'the saved password file is private (owner only)');
  const pw = s.password; await sh.set(false); ok(!(await sh.status()).active && nm(calls, 'connection', 'down').length === 1 && nm(calls, 'connection', 'delete').length >= 2, 'turning it off brings the hotspot down and removes the profile');
  let down = true; try { await get(sh.port, '/'); down = false; } catch (e) { /* refused */ } ok(down, 'and the share server stops');
  s = await sh.set(true); ok(s.password === pw, 'the password is stable across restarts of sharing');
  await sh.set(false);

  // safety: do not take away the Wi-Fi the device uses for internet
  ({ sh, calls, st } = harness()); st.route = 'wlan0';
  let e1; try { await sh.set(true); } catch (e) { e1 = e; } ok(e1 && e1.code === 409 && /online through its Wi-Fi/.test(e1.message) && nm(calls, 'connection', 'add').length === 0, 'refuses (409) when Wi-Fi is the internet connection, and changes nothing');
  s = await sh.set(true, true); ok(s.active, '...unless you explicitly choose to share anyway'); await sh.set(false);

  // failures clean up
  ({ sh, calls, st } = harness()); st.failUp = true; let e2; try { await sh.set(true); } catch (e) { e2 = e; }
  ok(e2 && e2.code === 500 && /Not authorized/.test(e2.message) && !e2.message.includes('\n'), 'hotspot failure: one-line reason (' + (e2 && e2.message.slice(0, 60)) + ')');
  ok(!(await sh.status()).active && nm(calls, 'connection', 'delete').length >= 2, 'a failed start leaves nothing running or half-configured');
  ({ sh, calls, st } = harness()); st.wifi = null; let e3; try { await sh.set(true); } catch (e) { e3 = e; } ok(e3 && e3.code === 400 && /No Wi-Fi adapter/.test(e3.message) && !(await sh.status()).supported, 'no Wi-Fi adapter: clear message');
  ({ sh, calls, st } = harness({ platform: 'win32' })); s = await sh.status(); ok(!s.supported && /Linux with NetworkManager/.test(s.reason) && calls.length === 0, 'Windows/macOS: not supported, with the reason, and nothing is run');
  ({ sh, calls, st } = harness()); st.noNm = true; s = await sh.status(); ok(!s.supported, 'no NetworkManager: not supported');

  // hostile saved settings are ignored, never passed to nmcli
  ({ sh, calls, st, dir } = harness({})); fs.writeFileSync(path.join(dir, 'share.json'), JSON.stringify({ on: false, ssid: 'x"; rm -rf /', password: 'a b' }));
  sh = new Share({ dataDir: dir, platform: 'linux', exec: sh.o.exec, makeServer: sh.o.makeServer, ports: [0] }); s = await sh.set(true);
  ok(s.ssid === 'NorwinPrep' && s.password === 'NORWINNOMAD', 'tampered ssid/password in the saved file are replaced by safe defaults'); await sh.set(false);

  // resume / shutdown
  ({ sh, calls, st, dir } = harness()); await sh.set(true); await sh.shutdown(); ok(!(await sh.status()).active && JSON.parse(fs.readFileSync(path.join(dir, 'share.json'))).on === true, 'quitting the app stops the hotspot but remembers you wanted sharing');
  const sh2 = new Share({ dataDir: dir, platform: 'linux', exec: sh.o.exec, makeServer: sh.o.makeServer, ports: [0] }); await sh2.resume(); ok((await sh2.status()).active, 'next launch resumes sharing automatically'); await sh2.set(false);
  ok(JSON.parse(fs.readFileSync(path.join(dir, 'share.json'))).on === false, 'turning it off yourself is remembered');
  // start with the app: the Wi-Fi comes up by itself (default), unless switched off or it would cut the internet
  ({ sh, calls, st, dir } = harness()); s = await sh.status(); ok(s.auto === true, 'start-Wi-Fi-at-launch is on by default');
  await sh.resume(); ok((await sh.status()).active && nm(calls, 'connection', 'up').length === 1, 'a fresh launch starts the hotspot with no clicks'); await sh.shutdown();
  await sh.set(false); await sh.setAuto(false); const sh3 = new Share({ dataDir: dir, platform: 'linux', exec: sh.o.exec, makeServer: sh.o.makeServer, ports: [0] }); await sh3.resume();
  ok(!(await sh3.status()).active && (await sh3.status()).auto === false, 'with the option off, launching does not start it');
  ({ sh, calls, st } = harness()); st.route = 'wlan0'; await sh.resume(); ok(!(await sh.status()).active && nm(calls, 'connection', 'add').length === 0, 'the automatic start never takes over a Wi-Fi internet link');
  // launch the app when the device starts
  const { Autostart } = require('../autostart'); const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nphome-'));
  const au = new Autostart({ platform: 'linux', home, exec: '/opt/Norwin Prep/norwinprep', args: ['--no-sandbox', '--kiosk'] });
  ok(au.get() === false, 'autostart starts off'); au.set(true);
  const df = fs.readFileSync(path.join(home, '.config/autostart/norwinprep.desktop'), 'utf8');
  ok(au.get() && /^Exec="\/opt\/Norwin Prep\/norwinprep" "--no-sandbox" "--kiosk"$/m.test(df) && /^Type=Application$/m.test(df), 'autostart writes a valid XDG entry (quoted path and flags)');
  au.set(false); ok(!au.get(), 'and removes it again');
  let bad = false; try { new Autostart({ platform: 'linux', home, exec: '/x\nExec=evil', args: [] }).set(true); } catch (e) { bad = true; } ok(bad, 'a program path with a newline is refused');

  // ---------- tools served to devices that join (CyberChef, Notes) ----------
  { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nptool-')); fs.mkdirSync(path.join(root, 'assets')); fs.writeFileSync(path.join(root, 'CyberChef_v1.html'), '<title>CC</title>'); fs.writeFileSync(path.join(root, 'assets', 'a.js'), 'var a=1'); fs.writeFileSync(path.join(root, '.installed'), '{}');
    fs.writeFileSync(path.join(path.dirname(root), 'secret-' + path.basename(root)), 'SECRET');
    const srv = createShare({ siteDir: site, mapsDir: root, appsDir: root, reader: null, getName: () => 'x', version: '1', siteRoot: (d) => (d === 'cyberchef' ? root : null), siteList: () => [{ id: 'cyberchef', name: 'CyberChef', path: '/tools/cyberchef/' }] });
    const port = await srv.start([0], '127.0.0.1');
    const nf = (pth) => new Promise((res) => http.get({ host: '127.0.0.1', port, path: pth }, (r) => { r.resume(); res({ code: r.statusCode, loc: r.headers.location, type: r.headers['content-type'] }); }));
    let g = await nf('/tools/cyberchef'); ok(g.code === 302 && g.loc === '/tools/cyberchef/', 'a tool address without a slash redirects to the folder');
    g = await nf('/tools/cyberchef/'); ok(g.code === 302 && g.loc === '/tools/cyberchef/CyberChef_v1.html', 'a folder with one web page opens that page');
    g = await get(port, '/tools/cyberchef/CyberChef_v1.html'); ok(g.code === 200 && g.body.includes('<title>CC</title>'), 'the page itself is served');
    g = await nf('/tools/cyberchef/assets/a.js'); ok(g.code === 200 && /javascript/.test(g.type), 'its scripts are served with the right type');
    for (const bad of ['/tools/cyberchef/.installed', '/tools/nope/', '/tools/cyberchef/%2e%2e/secret-' + path.basename(root), '/tools/cyberchef/..%2fx', '/tools/cyberchef/assets/../../x']) { g = await nf(bad); ok(g.code === 404 || g.code === 400, 'refused: ' + bad + ' (' + g.code + ')'); }
    const dev = JSON.parse((await get(port, '/api/device')).body); ok(dev.tools.length === 1 && dev.tools[0].path === '/tools/cyberchef/', 'the landing page is told which tools exist');
    const post = await new Promise((res) => { const q = http.request({ host: '127.0.0.1', port, path: '/tools/cyberchef/x', method: 'POST' }, (r) => { r.resume(); res(r.statusCode); }); q.end(); }); ok(post === 405, 'tools are read-only for devices that join (POST refused)');
    await srv.stop(); }
  // rapid toggles do not race
  ({ sh, calls } = harness()); await Promise.all([sh.set(true), sh.set(false), sh.set(true), sh.set(false)]); ok(!(await sh.status()).active && nm(calls, 'connection', 'up').length === nm(calls, 'connection', 'down').length, 'rapid on/off/on/off ends cleanly off');
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
