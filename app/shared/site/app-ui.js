/* App-only parts of the Module Store screen: the connections icon + picker, and the version button with in-app updates.
 * Loaded by index.html only when the page is served by an app's local instance (never on the Pi). */
(function () {
  'use strict';
  var S = window.NPStore, U = S.ui, el = U.el;
  var params = new URLSearchParams(location.search);
  var H = { 'X-NorwinPrep': '1' };
  var CONN = 'norwinprep.connection', CUSTOM = 'norwinprep.custom';

  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }
  function jf(url, opt) {
    return fetch(url, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('Request failed (' + r.status + ')')); return j; });
    });
  }
  function normalize(s) {
    s = (s || '').trim(); if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    return s.replace(/\/+$/, '').replace(/^(http:\/\/[^\/]+):80$/i, '$1').replace(/^(https:\/\/[^\/]+):443$/i, '$1');
  }

  // ------------------------------------------------------------------ connections
  var BUILTIN = [
    { label: 'Localhost', url: 'http://localhost', desc: 'NorwinPrep on this same computer (for example, this app installed on the Pi itself)' },
    { label: 'NorwinPrep hotspot', url: 'http://10.42.0.1', desc: "A Pi, when you are joined to its Wi-Fi hotspot" },
    { label: 'norwinprep.local', url: 'http://norwinprep.local', desc: 'A Pi on your network, found by name' }
  ];
  function customList() { try { return JSON.parse(store(CUSTOM) || '[]'); } catch (e) { return []; } }
  function saveCustom(l) { store(CUSTOM, JSON.stringify(l.slice(0, 6))); }
  var current = { url: null };     // url null = THIS device (the default); otherwise another NorwinPrep device whose modules we manage
  var results = {}, panelBox = null, panelMsg = '';

  function options() {
    var seen = {}, out = [];
    BUILTIN.concat(customList().map(function (u) { return { label: u, url: u, desc: 'Custom address', custom: true }; }))
      .forEach(function (o) { if (!seen[o.url]) { seen[o.url] = 1; out.push(o); } });
    if (current.url && !seen[current.url]) out.push({ label: current.url, url: current.url, desc: 'Saved connection' });
    return out;
  }
  function optionFor(url) { return options().filter(function (o) { return o.url === url; })[0]; }

  // verified = it answered /api/device like a NorwinPrep; up-only = something answers but we can't tell what
  function probe(url) {
    function t(ms) { var c = new AbortController(); setTimeout(function () { c.abort(); }, ms); return c.signal; }
    return fetch(url + '/api/device', { cache: 'no-store', signal: t(2500) })
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (j) {
        if (!j || typeof j.name !== 'string' || typeof j.version !== 'string') throw 0;
        return { up: true, verified: true, name: j.name.slice(0, 60), version: j.version.slice(0, 20), modules: j.modules === true, share: j.share === true };
      })
      .catch(function () {
        return fetch(url + '/', { mode: 'no-cors', cache: 'no-store', signal: t(2500) })
          .then(function () { return { up: true, verified: false }; }).catch(function () { return { up: false }; });
      });
  }
  function scan() {
    results = {}; refreshUi();
    return Promise.all(options().map(function (o) { return probe(o.url).then(function (r) { results[o.url] = r; refreshUi(); }); }));
  }

  function nameOf(url) { var r = results[url]; return r && r.verified && r.name ? r.name : ''; }
  function label() {
    if (!current.url) return 'this device';
    var o = optionFor(current.url), n = nameOf(current.url);
    return (n ? n + ' — ' : '') + (o ? o.label : current.url);
  }
  function statusText(r) { return !r ? 'Checking\u2026' : r.up ? (r.verified ? (r.share ? 'Sharing its library over Wi-Fi' : 'Online') : 'Answers, but not identified as NorwinPrep') : 'Not reachable'; }

  // ---- header icon with a status dot ----
  var cdot = el('span', 'cdot');
  var connBtn = el('button', 'iconbtn'); connBtn.id = 'connBtn'; connBtn.type = 'button';
  connBtn.setAttribute('aria-label', 'Connection'); connBtn.title = 'Connection';
  connBtn.innerHTML = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 8.8a15 15 0 0 1 20 0"/><path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1" fill="currentColor"/></svg>';
  connBtn.appendChild(cdot);
  document.getElementById('hdrTools').appendChild(connBtn);
  connBtn.addEventListener('click', function () { openConnections(); });
  function updateDot() {
    var r = current.url ? results[current.url] : null;
    cdot.className = 'cdot' + (!current.url ? ' on' : !r ? '' : r.up ? (r.verified ? ' on' : ' warn') : ' off');
  }

  // ---- the picker ----
  function choose(url) {
    store(CONN, url || 'local'); current = { url: url };
    U.closeModal(); updateDot(); S.reload(url === null ? '' : url);
  }
  function optionRow(title, desc, r, url, o) {
    var row = el('div', 'opt'), dot = el('span', 'dot' + (url === null ? ' on' : r ? (r.up ? (r.verified ? ' on' : ' warn') : ' off') : ''));
    var mid = el('div', 'grow'); mid.appendChild(el('div', 't', title)); mid.appendChild(el('div', 'd', desc));
    row.appendChild(dot); row.appendChild(mid);
    var active = (url === null && current.url === null) || (url !== null && url === current.url);
    if (active) row.appendChild(el('span', 'tagon', 'Active'));
    else if (r && r.verified && r.share) {           // another device sharing its library over Wi-Fi: read-only, so open it
      var op = el('a', 'btn sm solid', 'Open'); op.href = url + '/'; row.appendChild(op);
    } else {
      var usable = url === null || (r && r.up && (!r.verified || r.modules));
      var b = el('button', 'btn sm solid', 'Use'); b.type = 'button'; b.disabled = !usable;
      if (!usable) b.title = r && r.verified && !r.modules ? 'This device needs an update to offer the Module Store' : 'Not reachable right now';
      b.addEventListener('click', function () { choose(url); }); row.appendChild(b);
    }
    if (o && o.custom) {
      var rm = el('button', 'btn sm', 'Remove'); rm.type = 'button';
      rm.addEventListener('click', function () {
        saveCustom(customList().filter(function (u) { return u !== o.url; }));
        if (current.url === o.url) { store(CONN, 'local'); current = { url: null }; S.reload(''); updateDot(); }
        refreshUi();
      });
      row.appendChild(rm);
    }
    return row;
  }
  // ---- share over Wi-Fi (this device becomes a hotspot that serves its library, read-only, to devices that join) ----
  var shareState = null, shareMsg = '', dev0 = null;
  function loadShare() { return jf('/api/share', { cache: 'no-store' }).then(function (j) { shareState = j; refreshUi(); }).catch(function () { shareState = { supported: false }; }); }
  function setShare(on, force) {
    shareMsg = on ? 'Starting the hotspot…' : 'Stopping…'; refreshUi();
    return jf('/api/share', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify({ on: on, force: !!force }) })
      .then(function (j) { shareState = j; shareMsg = ''; refreshUi(); })
      .catch(function (e) { shareMsg = e.message; shareState = Object.assign({}, shareState); shareState.needForce = /online through its Wi-Fi/.test(e.message); refreshUi(); });
  }
  function setPref(body) {
    return jf('/api/share', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify(body) })
      .then(function (j) { shareState = j; refreshUi(); }).catch(function (e) { shareMsg = e.message; refreshUi(); });
  }
  function prefRow(label, on, key) {
    var row = el('label', 'note'); row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;cursor:pointer';
    var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!on; cb.setAttribute('data-pref', key);
    cb.addEventListener('change', function () { var b = {}; b[key] = cb.checked; setPref(b); });
    row.appendChild(cb); row.appendChild(document.createTextNode(label)); return row;
  }
  // change the Wi-Fi password (not on Android, which picks it) and the sign-in password that joined devices must use
  function passwordForm(st) {
    var wrap = el('details'); wrap.style.marginTop = '12px'; var sm = el('summary', 'mono', 'Change passwords'); sm.style.cursor = 'pointer'; wrap.appendChild(sm);
    function field(label, hint, key, type) {
      var f = el('form'); f.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:10px'; f.autocomplete = 'off';
      var l = el('label', 'note', label); var i = document.createElement('input'); i.type = type; i.autocomplete = 'off'; i.autocapitalize = 'off'; i.spellcheck = false; i.placeholder = hint; i.setAttribute('aria-label', label); i.style.cssText = 'padding:10px;border-radius:10px;border:1px solid var(--line2);background:#0d0f14;color:inherit;font:inherit';
      var go = el('button', 'btn sm', 'Save'); go.type = 'submit'; f.appendChild(l); f.appendChild(i); f.appendChild(go);
      f.addEventListener('submit', function (e) { e.preventDefault(); var v = i.value; if (!v) return; var b = {}; b[key] = v; go.disabled = true;
        jf('/api/share', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify(b) })
          .then(function (j) { shareState = j; shareMsg = key === 'wifiPassword' ? 'Wi-Fi password changed. The hotspot restarted, so devices must join again with the new password.' : 'Sign-in password changed. Everyone must sign in again.'; refreshUi(); })
          .catch(function (er) { go.disabled = false; shareMsg = er.message; refreshUi(); }); });
      wrap.appendChild(f);
    }
    if (st.canChangeWifiPassword !== false) field('Wi-Fi password (8 to 63 letters and numbers)', 'New Wi-Fi password', 'wifiPassword', 'text');
    else wrap.appendChild(el('div', 'note', 'Android chooses this phone’s Wi-Fi name and password itself, so only the sign-in password can be changed here.'));
    field('Sign-in password (4 to 64 characters; the user name stays admin)', 'New sign-in password', 'adminPassword', 'text');
    return wrap;
  }
  var shareTimer = null, lastClients = -1;
  function pollShare() {                 // keeps the "Connected devices" number live without rebuilding the panel (which would wipe a password being typed)
    clearInterval(shareTimer);
    shareTimer = setInterval(function () {
      if (!panelBox || !panelBox.isConnected) { clearInterval(shareTimer); return; }
      jf('/api/share', { cache: 'no-store' }).then(function (j) {
        var was = shareState && shareState.active; shareState = j;
        var n = document.getElementById('shareClients'); if (n) n.textContent = String(j.clients || 0);
        if (!!j.active !== !!was) refreshUi();
      }).catch(function () { /* try again next time */ });
    }, 3000);
  }
  function shareSection() {
    var st = shareState;
    if (!st || (!st.supported && !(dev0 && dev0.platform === 'linux'))) return null;
    var box = el('div', 'sumbox'); box.appendChild(el('div', 'mono', 'Share over Wi-Fi'));
    if (!st.supported) { box.appendChild(el('div', 'note', st.reason || 'Not available on this device.')); return box; }
    box.appendChild(el('div', 'note', st.note || 'Turn this device into a Wi-Fi hotspot. Other devices join it and read your library, maps and apps, with no internet needed.'));
    if (st.active) {
      var dl = el('dl', 'kv'); dl.style.marginTop = '10px';
      [['Wi-Fi name', st.ssid], ['Wi-Fi password', st.password], ['Sign-in page', st.url + '/login'], ['Sign in as', (st.login || 'admin') + (st.adminDefault ? ' / NOMAD (default)' : ' / your sign-in password')], ['Connected devices', String(st.clients || 0)]].forEach(function (r) {
        dl.appendChild(el('dt', null, r[0])); var dd = el('dd', null, String(r[1])); dd.style.fontFamily = 'var(--mono)'; if (r[0] === 'Connected devices') dd.id = 'shareClients'; dl.appendChild(dd); });
      box.appendChild(dl);
    }
    if (shareMsg) box.appendChild(el('div', 'note bad', shareMsg));
    var row = el('div'); row.style.cssText = 'display:flex;gap:8px;margin-top:10px';
    var b = el('button', 'btn sm ' + (st.active ? '' : 'solid'), st.active ? 'Stop sharing' : 'Start sharing'); b.type = 'button';
    b.addEventListener('click', function () { setShare(!st.active, false); }); row.appendChild(b);
    if (st.needForce && !st.active) { var f = el('button', 'btn sm warn', 'Share anyway'); f.type = 'button'; f.addEventListener('click', function () { setShare(true, true); }); row.appendChild(f); }
    box.appendChild(row);
    box.appendChild(passwordForm(st));
    if (st.canAuto !== false) box.appendChild(prefRow('Start the Wi-Fi automatically when the app opens', st.auto, 'auto'));
    if (st.launchAtStartup !== undefined) box.appendChild(prefRow('Open this app when the device starts', st.launchAtStartup, 'launchAtStartup'));
    return box;
  }

  function buildPanel(box) {
    box.textContent = '';
    if (panelMsg) box.appendChild(el('div', 'note bad', panelMsg));
    var sum = el('div', 'sumbox'), r = current.url ? results[current.url] : null;
    sum.appendChild(el('div', 'mono', 'Network mode'));
    var line = el('div'); line.style.marginTop = '6px';
    if (current.url) {
      var o = optionFor(current.url), b = el('b', null, o ? o.label : current.url);
      line.appendChild(b);
      line.appendChild(document.createTextNode(nameOf(current.url) ? '  ·  ' + nameOf(current.url) + (r && r.version ? ' (v' + r.version + ')' : '') : ''));
      sum.appendChild(line);
      sum.appendChild(el('div', 'note', statusText(r) + '  ·  ' + current.url));
      sum.appendChild(el('div', 'note', 'Modules you install or remove are changed on that device (it asks for its admin PIN).'));
    } else {
      line.appendChild(el('b', null, 'This device'));
      sum.appendChild(line);
      sum.appendChild(el('div', 'note', 'Modules install on this device and open inside the app. Once installed they work with no internet.'));
    }
    box.appendChild(sum);
    var sh = shareSection(); if (sh) box.appendChild(sh);

    box.appendChild(optionRow('This device', 'Install and open modules here', null, null));
    var cap = el('div', 'mono', 'Other NorwinPrep devices'); cap.style.cssText = 'color:var(--mut);margin:14px 0 0'; box.appendChild(cap);
    box.appendChild(el('div', 'note', 'Optional. Manage another device’s modules, or open a library it shares over Wi-Fi.'));
    options().forEach(function (o) {
      var r2 = results[o.url], n = nameOf(o.url);
      box.appendChild(optionRow((n ? n + ' — ' : '') + o.label, (o.custom ? 'Custom · ' : '') + statusText(r2) + '  ·  ' + o.url + (r2 && r2.verified && !r2.modules && !r2.share ? '  ·  needs an update for the Module Store' : ''), r2, o.url, o));
    });

    var form = el('form', 'addr'), inp = el('input'); inp.type = 'text'; inp.placeholder = 'Other address, e.g. 192.168.1.20 or localhost:8080';
    inp.setAttribute('aria-label', 'Other address'); inp.autocapitalize = 'off'; inp.autocomplete = 'off'; inp.spellcheck = false;
    var add = el('button', 'btn sm solid', 'Add'); add.type = 'submit'; form.appendChild(inp); form.appendChild(add);
    form.addEventListener('submit', function (e) {
      e.preventDefault(); var u = normalize(inp.value); if (!u) return;
      saveCustom([u].concat(customList().filter(function (x) { return x !== u; }))); scan();
    });
    box.appendChild(form);

    var foot = el('div', 'note'); foot.style.marginTop = '14px';
    if (current.url && r && r.up) { var a = el('a', null, 'Open that device’s portal'); a.href = current.url + '/'; a.style.color = 'var(--blue)'; foot.appendChild(a); foot.appendChild(document.createTextNode('   ·   ')); }
    var d = el('a', null, 'This device: name and files'); d.href = '/device.html'; d.style.color = 'var(--blue)'; foot.appendChild(d);
    box.appendChild(foot);
  }
  function openConnections(msg) {
    panelMsg = msg || '';          // kept so the picker's re-draws (after each scan result) still show it
    shareMsg = ''; loadShare(); pollShare();
    U.openModal(function (m) {
      m.appendChild(el('h3', null, 'Connection'));
      var mb = el('div', 'mb'); panelBox = el('div'); mb.appendChild(panelBox); m.appendChild(mb);
      var mf = el('div', 'mf'); mf.appendChild(U.btn('Rescan', '', function () { scan(); })); mf.appendChild(U.btn('Close', 'solid', U.closeModal)); m.appendChild(mf);
      buildPanel(panelBox);
    });
    scan();
  }
  function refreshUi() { updateDot(); if (panelBox && panelBox.isConnected) buildPanel(panelBox); }

  // Which connection to use at start-up: the one you chose; otherwise THIS device (modules install here, no Pi needed).
  function start() {
    var saved = store(CONN), unreachable = params.get('unreachable');
    jf('/api/device', { cache: 'no-store' }).then(function (d) { dev0 = d; }).catch(function () {});
    current = saved && saved !== 'local' ? { url: saved } : { url: null };
    scan(); updateDot();
    if (unreachable) setTimeout(function () { openConnections('Could not reach ' + unreachable + '. Pick a connection.'); }, 300);
    return Promise.resolve(current.url === null ? '' : current.url);
  }
  window.NPApp = { start: start, openConnections: openConnections, label: label };

  // ------------------------------------------------------------------ version button + app updates
  var dev = null, updBusy = false, pollT = null, updateTag = '';
  var verBtn = el('button', null, 'v…'); verBtn.id = 'ver'; verBtn.type = 'button'; verBtn.title = 'Check for updates'; verBtn.setAttribute('aria-haspopup', 'dialog');
  document.body.appendChild(verBtn);
  var upd = el('div'); upd.id = 'upd'; upd.setAttribute('role', 'dialog'); upd.setAttribute('aria-live', 'polite'); upd.setAttribute('aria-label', 'App update');
  var updTitle = el('div', null, ''); updTitle.id = 'updTitle'; updTitle.style.fontWeight = '600';
  var updMsg = el('div', 'note', ''); updMsg.id = 'updMsg';
  var updBar = el('div', 'bar'); updBar.id = 'updBar'; updBar.style.display = 'none'; var updFill = el('i'); updFill.id = 'updFill'; updBar.appendChild(updFill);
  var updRow = el('div'); updRow.style.cssText = 'display:flex;gap:10px;margin-top:12px';
  var updLink = el('a', 'btn sm', 'Release page'); updLink.id = 'updLink'; updLink.target = '_blank'; updLink.rel = 'noopener noreferrer'; updLink.style.display = 'none';
  var updClose = el('button', 'btn sm', 'Close'); updClose.id = 'updClose'; updClose.type = 'button';
  updRow.appendChild(updLink); updRow.appendChild(updClose);
  [updTitle, updMsg, updBar, updRow].forEach(function (n) { upd.appendChild(n); });
  document.body.appendChild(upd);

  function vparts(v) { return String(v || '').replace(/^v/, '').split('.').map(function (n) { return parseInt(n, 10) || 0; }); }
  function isNewer(a, b) {
    var x = vparts(a), y = vparts(b);
    for (var i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
    return false;
  }
  // choose the release file that matches how THIS copy of the app is installed
  function pickAsset(names, d) {
    var re = null;
    if (d.platform === 'android') re = /-android\.apk$/;
    else if (d.platform === 'windows') re = d.packaging === 'portable' ? /-portable-x64\.exe$/ : /-win-x64\.exe$/;
    else if (d.platform === 'linux') {
      if (d.packaging === 'deb') { var da = { x64: 'amd64', arm64: 'arm64', armv7l: 'armv7l' }[d.arch]; if (da) re = new RegExp('-linux-' + da + '\\.deb$'); }
      else { var aa = { x64: 'x86_64', arm64: 'arm64', armv7l: 'armv7l' }[d.arch]; if (aa) re = new RegExp('-linux-' + aa + '\\.AppImage$'); }
    }
    if (!re) return null;
    for (var i = 0; i < names.length; i++) if (re.test(names[i])) return names[i];
    return null;
  }
  function setVer() {
    if (!dev) return;
    verBtn.textContent = 'v' + dev.version + (updateTag ? ' · update available' : '');
    verBtn.classList.toggle('new', !!updateTag);
    verBtn.title = updateTag ? 'Update to ' + updateTag + ' — click to install' : 'Check for updates';
  }
  function showUpd(title, msg, o) {
    o = o || {};
    upd.style.display = 'block'; updTitle.textContent = title; updMsg.textContent = msg || '';
    updBar.style.display = o.bar === undefined ? 'none' : 'block'; updFill.style.width = (o.bar || 0) + '%';
    updLink.style.display = o.link ? 'inline-flex' : 'none'; if (o.link) updLink.href = o.link;
  }
  function poll() {
    clearInterval(pollT);
    pollT = setInterval(function () {
      jf('/api/update/status', { cache: 'no-store' }).then(function (st) {
        if (st.state === 'downloading' || st.state === 'verifying' || st.state === 'installing') showUpd('Updating to ' + st.tag, st.message, { bar: st.percent });
        else {
          clearInterval(pollT); updBusy = false;
          if (st.state === 'done') showUpd('Update ready', st.message);
          else if (st.state === 'needs-permission') showUpd('One more step', st.message);
          else showUpd('Update failed', st.message || 'Unknown error');
        }
      }).catch(function () {   // the local server stops while the desktop app restarts
        clearInterval(pollT); showUpd('Restarting…', 'The app is restarting to finish the update.');
      });
    }, 700);
  }
  function checkRelease() { return jf('/api/update/check', { cache: 'no-store' }); }
  function runUpdate() {
    if (updBusy || !dev) return;
    updBusy = true; showUpd('Checking for updates…', 'Current version: v' + dev.version);
    checkRelease().then(function (rel) {
      if (!isNewer(rel.tag, dev.version)) { updateTag = ''; setVer(); updBusy = false; return showUpd('You are up to date', 'v' + dev.version + ' is the latest release.', { link: rel.url }); }
      updateTag = rel.tag; setVer();
      if (dev.packaging === 'dev') { updBusy = false; return showUpd(rel.tag + ' is available', 'Updating works for installed builds, not a development run.', { link: rel.url }); }
      var asset = pickAsset(rel.assets, dev);
      if (!asset) { updBusy = false; return showUpd(rel.tag + ' is available', 'No build for this device (' + dev.platform + ' ' + dev.arch + ') is attached to the release.', { link: rel.url }); }
      showUpd('Updating to ' + rel.tag, 'Starting…', { bar: 0 });
      return jf('/api/update/install', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify({ tag: rel.tag, asset: asset }) }).then(poll);
    }).catch(function (e) { updBusy = false; showUpd('Could not update', e.message + ' Connect this device to the internet and try again.'); });
  }
  verBtn.addEventListener('click', function () { if (upd.style.display === 'block' && !updBusy) upd.style.display = 'none'; else runUpdate(); });
  updClose.addEventListener('click', function () { upd.style.display = 'none'; });

  jf('/api/device', { cache: 'no-store' }).then(function (d) {
    dev = d; setVer();
    // quietly look for a newer release after start-up; a hash of #update opens the update panel straight away
    setTimeout(function () {
      if (dev.packaging === 'dev') return;
      if (location.hash === '#update') return runUpdate();
      checkRelease().then(function (rel) { if (isNewer(rel.tag, dev.version)) { updateTag = rel.tag; setVer(); } }).catch(function () {});
    }, 1500);
  }).catch(function () {});
})();
