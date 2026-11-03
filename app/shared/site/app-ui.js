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
  var current = { url: null, auto: true };     // url null = this app only (browse the catalog)
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
        return { up: true, verified: true, name: j.name.slice(0, 60), version: j.version.slice(0, 20), modules: j.modules === true };
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
    if (!current.url) return 'this app';
    var o = optionFor(current.url), n = nameOf(current.url);
    return (n ? n + ' — ' : '') + (o ? o.label : current.url);
  }
  function statusText(r) { return !r ? 'Checking…' : r.up ? (r.verified ? 'Online' : 'Answers, but not identified as NorwinPrep') : 'Not reachable'; }

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
    cdot.className = 'cdot' + (!current.url || !r ? '' : r.up ? (r.verified ? ' on' : ' warn') : ' off');
  }

  // ---- the picker ----
  function choose(url) {
    store(CONN, url || 'local'); current = { url: url, auto: false };
    U.closeModal(); updateDot(); S.reload(url);
  }
  function optionRow(title, desc, r, url, o) {
    var row = el('div', 'opt'), dot = el('span', 'dot' + (url === null ? ' on' : r ? (r.up ? (r.verified ? ' on' : ' warn') : ' off') : ''));
    var mid = el('div', 'grow'); mid.appendChild(el('div', 't', title)); mid.appendChild(el('div', 'd', desc));
    row.appendChild(dot); row.appendChild(mid);
    var active = (url === null && current.url === null) || (url !== null && url === current.url);
    if (active) row.appendChild(el('span', 'tagon', 'Active'));
    else {
      var usable = url === null || (r && r.up && (!r.verified || r.modules));
      var b = el('button', 'btn sm solid', 'Use'); b.type = 'button'; b.disabled = !usable;
      if (!usable) b.title = r && r.verified && !r.modules ? 'This device needs an update to offer the Module Store' : 'Not reachable right now';
      b.addEventListener('click', function () { choose(url); }); row.appendChild(b);
    }
    if (o && o.custom) {
      var rm = el('button', 'btn sm', 'Remove'); rm.type = 'button';
      rm.addEventListener('click', function () {
        saveCustom(customList().filter(function (u) { return u !== o.url; }));
        if (current.url === o.url) { store(CONN, 'local'); current = { url: null, auto: false }; S.reload(null); updateDot(); }
        refreshUi();
      });
      row.appendChild(rm);
    }
    return row;
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
      line.appendChild(document.createTextNode(nameOf(current.url) ? '  ·  ' + nameOf(current.url) + (r.version ? ' (v' + r.version + ')' : '') : ''));
      sum.appendChild(line);
      sum.appendChild(el('div', 'note', statusText(r) + '  ·  ' + current.url + (current.auto ? '  ·  found automatically' : '')));
      sum.appendChild(el('div', 'note', 'Modules you install or remove are changed on this device.'));
    } else {
      line.appendChild(el('b', null, 'This app only'));
      sum.appendChild(line);
      sum.appendChild(el('div', 'note', 'No NorwinPrep device is connected. You can browse the catalog; connect a device below to install modules.'));
    }
    box.appendChild(sum);

    box.appendChild(optionRow('This app only', 'Browse the module catalog without a device', null, null));
    options().forEach(function (o) {
      var r2 = results[o.url], n = nameOf(o.url);
      box.appendChild(optionRow((n ? n + ' — ' : '') + o.label, (o.custom ? 'Custom · ' : '') + statusText(r2) + '  ·  ' + o.url + (r2 && r2.verified && !r2.modules ? '  ·  needs an update for the Module Store' : ''), r2, o.url, o));
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
    if (current.url && r && r.up) { var a = el('a', null, 'Open this device’s portal'); a.href = current.url + '/'; a.style.color = 'var(--blue)'; foot.appendChild(a); foot.appendChild(document.createTextNode('   ·   ')); }
    var d = el('a', null, 'This device: name and files'); d.href = '/device.html'; d.style.color = 'var(--blue)'; foot.appendChild(d);
    box.appendChild(foot);
  }
  function openConnections(msg) {
    panelMsg = msg || '';          // kept so the picker's re-draws (after each scan result) still show it
    U.openModal(function (m) {
      m.appendChild(el('h3', null, 'Connection'));
      var mb = el('div', 'mb'); panelBox = el('div'); mb.appendChild(panelBox); m.appendChild(mb);
      var mf = el('div', 'mf'); mf.appendChild(U.btn('Rescan', '', function () { scan(); })); mf.appendChild(U.btn('Close', 'solid', U.closeModal)); m.appendChild(mf);
      buildPanel(panelBox);
    });
    scan();
  }
  function refreshUi() { updateDot(); if (panelBox && panelBox.isConnected) buildPanel(panelBox); }

  // Which connection to use at start-up: the one you chose, otherwise the first device that offers the Module Store.
  function start() {
    var saved = store(CONN), unreachable = params.get('unreachable'), p;
    if (saved === 'local') { current = { url: null, auto: false }; scan(); p = Promise.resolve(null); }
    else if (saved) { current = { url: saved, auto: false }; scan(); p = Promise.resolve(saved); }
    else p = scan().then(function () {
      var hit = options().filter(function (o) { var r = results[o.url]; return r && r.verified && r.modules; })[0];
      current = { url: hit ? hit.url : null, auto: true }; updateDot(); return current.url;
    });
    return p.then(function (url) {
      if (unreachable) setTimeout(function () { openConnections('Could not reach ' + unreachable + '. Pick a connection.'); }, 300);
      return url;
    });
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
