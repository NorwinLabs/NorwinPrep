'use strict';
// Local NorwinPrep instance: serves the app's home page, a device-info API and a small file library,
// bound to 127.0.0.1 only. No dependencies besides Node core, so it also runs standalone for tests.
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.htm': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif'
};
const NAME_RE = /^[A-Za-z0-9 ._()\-]{1,40}$/;                 // device name
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()\-]{0,99}$/;      // library file name
const MAX_UPLOAD = 500 * 1024 * 1024;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ASSET_FILE_RE = /^NorwinPrep-[A-Za-z0-9._-]+\.(apk|exe|AppImage|deb)$/;
const TILE_RE = /^[A-Za-z0-9._-]+\.pmtiles$/;

// Serve a file with HTTP Range support (PMTiles map archives are read with range requests).
function serveRange(req, res, full, type, head, extra) {
  let st;
  try { st = fs.statSync(full); } catch (e) { st = null; }
  if (!st || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end(head ? undefined : 'Not found'); }
  const m = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  let start = 0, end = st.size - 1, code = 200;
  if (m && (m[1] || m[2])) {
    if (m[1] === '') start = Math.max(0, st.size - Number(m[2]));
    else { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), st.size - 1); }
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
    code = 206;
  }
  const h = Object.assign({ 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }, extra || {});
  if (code === 206) h['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
  res.writeHead(code, h);
  if (head || st.size === 0) return res.end();
  fs.createReadStream(full, { start, end }).pipe(res);
}
function listDir(dir, re) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && re.test(d.name)).map((d) => ({ name: d.name, st: fs.statSync(path.join(dir, d.name)) })).sort((a, b) => a.name.localeCompare(b.name)); }
  catch (e) { return []; }
}
const page = (title, body) => '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title>' +
  '<body style="font:16px system-ui;background:#0d0f14;color:#e9ebf1;padding:1.2rem;max-width:760px;margin:0 auto">' + body;

// Routes both servers share: map tiles, hosted app downloads, and the content reader. Returns true when it handled the request.
function serveContent(req, res, p, head, o) {
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(head ? undefined : body); };
  if (p === '/tiles' || p === '/tiles/') {            // same shape as nginx's JSON listing on the Pi, so the map viewer works unchanged
    send(200, 'application/json; charset=utf-8', JSON.stringify(listDir(o.mapsDir, TILE_RE).map((f) => ({ name: f.name, type: 'file', size: f.st.size, mtime: new Date(f.st.mtimeMs).toUTCString() }))));
    return true;
  }
  if (p.startsWith('/tiles/')) { const n = p.slice(7); if (!TILE_RE.test(n)) send(400, 'text/plain', 'Bad file name'); else serveRange(req, res, path.join(o.mapsDir, n), 'application/octet-stream', head); return true; }
  if (p.startsWith('/tools/')) {                      // installed browser tools (CyberChef, Notes): static files, read-only
    const m = /^\/tools\/([a-z0-9-]+)(\/.*)?$/.exec(p), root = m && o.siteRoot ? o.siteRoot(m[1]) : null;
    if (!root) { send(404, 'text/plain', 'Not installed'); return true; }
    if (!m[2]) { res.writeHead(302, { Location: p + '/' }); res.end(); return true; }
    let rel = m[2];
    if (rel.endsWith('/')) {
      if (fs.existsSync(path.join(root, rel.slice(1), 'index.html'))) rel += 'index.html';
      else {                                           // e.g. CyberChef ships one CyberChef_vX.html: open that
        const first = (() => { try { return fs.readdirSync(path.join(root, rel.slice(1))).filter((f) => /\.html?$/i.test(f)).sort()[0]; } catch (e) { return null; } })();
        if (!first) { send(404, 'text/plain', 'Not found'); return true; }
        res.writeHead(302, { Location: p + first }); res.end(); return true;
      }
    }
    const full = path.resolve(root, rel.slice(1));
    if (!full.startsWith(path.resolve(root) + path.sep) || path.basename(full).startsWith('.')) { send(404, 'text/plain', 'Not found'); return true; }
    serveRange(req, res, full, TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream', head);
    return true;
  }
  if (p === '/apps' || p === '/apps/') {
    const rows = listDir(o.appsDir, ASSET_FILE_RE).map((f) => '<li style="margin:.5rem 0"><a style="color:#4aa3ff" href="/apps/' + encodeURIComponent(f.name) + '">' + esc(f.name) + '</a> <span style="color:#8b92a3">' + (f.st.size / 1048576).toFixed(1) + ' MB</span></li>').join('');
    send(200, 'text/html; charset=utf-8', page('Apps', '<p><a style="color:#4aa3ff" href="/">&larr; Back</a></p><h1>Apps</h1><p style="color:#8b92a3">Install NorwinPrep on your own device from here.</p><ul>' + (rows || '<li>No apps are installed on this device yet.</li>') + '</ul>'));
    return true;
  }
  if (p.startsWith('/apps/')) { const n = p.slice(6); if (!ASSET_FILE_RE.test(n)) send(400, 'text/plain', 'Bad file name'); else serveRange(req, res, path.join(o.appsDir, n), 'application/octet-stream', head, { 'Content-Disposition': 'attachment; filename="' + n + '"' }); return true; }
  if (p === '/wiki') { res.writeHead(302, { Location: '/wiki/' }); res.end(); return true; }
  if (p.startsWith('/wiki/')) {
    if (o.reader && o.reader.ready()) o.reader.proxy(req, res);
    else send(503, 'text/html; charset=utf-8', page('Library not ready', '<p><a style="color:#4aa3ff" href="/">&larr; Back</a></p><h1>The library is not ready</h1><p style="color:#8b92a3">Install a content pack from the Module Store (the reader comes with it), then try again.</p>'));
    return true;
  }
  return false;
}

function create(opts) {
  // opts: siteDir, filesDir, getName(), setName(n), version, platform, modules (Manager), mapsDir, appsDir, reader, share
  let port = 0;
  const origins = () => ['http://127.0.0.1:' + port, 'http://localhost:' + port];
  const hostOk = (h) => origins().some((o) => o === 'http://' + h);

  const deviceInfo = () => ({
    name: opts.getName(), mode: 'local', platform: opts.platform, version: opts.version,
    address: 'http://127.0.0.1:' + port, filesDir: opts.filesDir,
    arch: opts.arch || '', packaging: opts.packaging || '', canShare: !!opts.share, hasModules: !!opts.modules
  });

  const server = http.createServer((req, res) => {
    const head = req.method === 'HEAD';
    const send = (code, type, body) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(head ? undefined : body);
    };
    const json = (code, obj) => send(code, 'application/json; charset=utf-8', JSON.stringify(obj));

    // Defend against DNS-rebinding and cross-site requests to this loopback server
    if (!hostOk(req.headers.host)) return send(403, 'text/plain', 'Forbidden');
    // Kolibri (the offline school platform) runs behind /learn/. It has its own login, so it does not use the app's X-NorwinPrep header;
    // writes only need to come from this page's own origin.
    if (opts.kolibri && /^\/learn(\/|$)/.test(req.url.split('?')[0])) {
      const o = req.headers.origin;
      if (o && !origins().includes(o)) return send(403, 'text/plain', 'Forbidden');
      if (req.url.split('?')[0] === '/learn') { res.writeHead(302, { Location: '/learn/' }); return res.end(); }
      return opts.kolibri.proxy(req, res);
    }
    // The offline AI assistant: /ai/api/* goes to the runner. Chat needs the page's own origin; switching models also needs the app header.
    if (opts.ai && /^\/ai\/api\//.test(req.url.split('?')[0])) {
      const o = req.headers.origin;
      if (o && !origins().includes(o)) return send(403, 'text/plain', 'Forbidden');
      const route = req.url.split('?')[0].slice('/ai/api'.length);
      if (req.method === 'POST' && route === '/select' && req.headers['x-norwinprep'] !== '1') return send(403, 'text/plain', 'Forbidden');
      if (req.method !== 'GET' && req.method !== 'POST') return send(405, 'text/plain', 'Method not allowed');
      return opts.ai.handle(req, res, route, true);
    }
    const writes = req.method === 'PUT' || req.method === 'POST' || req.method === 'DELETE';
    if (writes) {
      const o = req.headers.origin;
      if (o && !origins().includes(o)) return send(403, 'text/plain', 'Forbidden');
      if (req.headers['x-norwinprep'] !== '1') return send(403, 'text/plain', 'Forbidden');
    } else if (req.method !== 'GET' && !head) {
      return send(405, 'text/plain', 'Method not allowed');
    }

    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { return send(400, 'text/plain', 'Bad request'); }
    if (p.includes('\0') || p.includes('\\') || p.split('/').includes('..')) return send(400, 'text/plain', 'Bad request');

    // ---- device info ----
    if (p === '/api/device') {
      if (!writes) return json(200, deviceInfo());
      if (req.method === 'DELETE') return send(405, 'text/plain', 'Method not allowed');
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        let name;
        try { name = String(JSON.parse(body).name || '').trim(); } catch (e) { return json(400, { error: 'invalid JSON' }); }
        if (!NAME_RE.test(name)) return json(400, { error: 'Name must be 1-40 letters, numbers, spaces or . _ - ( )' });
        opts.setName(name);
        return json(200, deviceInfo());
      });
      return;
    }

    // ---- module store: the manager installs into this device's own library, no PIN needed (it is your own app) ----
    if (p === '/api/modules' || p.startsWith('/api/modules/')) {
      if (!opts.modules) return json(404, { error: 'modules not available' });
      const route = p.slice('/api/modules'.length) || '/', q = new URL(req.url, 'http://x').searchParams;
      const run = (body) => opts.modules.handle(req.method, route, q, body).then((r) => json(r.code, r.body), () => json(500, { error: 'Server error' }));
      if (!writes) return void run(null);
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => { let b; try { b = body ? JSON.parse(body) : {}; } catch (e) { return json(400, { error: 'invalid JSON' }); } run(b); });
      return;
    }

    // ---- share over Wi-Fi (start / stop the hotspot and the read-only content server) ----
    if (p === '/api/share') {
      if (!opts.share) return json(200, { supported: false });
      const withLaunch = (r) => Object.assign({}, r, opts.autostart ? { launchAtStartup: opts.autostart.get() } : {});
      if (!writes) return void opts.share.status().then((r) => json(200, withLaunch(r)), () => json(500, { error: 'Server error' }));
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1024) req.destroy(); });
      req.on('end', () => {
        let b; try { b = JSON.parse(body || '{}'); } catch (e) { return json(400, { error: 'invalid JSON' }); }
        try { if (typeof b.launchAtStartup === 'boolean' && opts.autostart) opts.autostart.set(b.launchAtStartup); } catch (e) { return json(500, { error: 'Could not change the startup setting' }); }
        const done = (r) => json(200, withLaunch(r)), bad = (e) => json(e.code || 500, { error: e.message || 'Server error' });
        if (typeof b.auto === 'boolean') opts.share.setAuto(b.auto);
        if (typeof b.on === 'boolean') opts.share.set(b.on, !!b.force).then(done, bad); else opts.share.status().then(done, bad);
      });
      return;
    }

    // ---- content the viewers need: map tiles, hosted apps, the reader ----
    if (!writes && serveContent(req, res, p, head, { mapsDir: opts.mapsDir, appsDir: opts.appsDir, reader: opts.reader, siteRoot: opts.modules ? (d) => opts.modules.siteRoot(d) : null })) return;

    // ---- app updates (check GitHub, install the matching build) ----
    if (p === '/api/update/check' && !writes) {
      if (!opts.update) return json(404, { error: 'updates not available' });
      opts.update.check().then((r) => json(200, r), (e) => json(502, { error: 'Could not reach GitHub.' }));
      return;
    }
    if (p === '/api/update/status' && !writes) return json(200, opts.update ? opts.update.status() : { state: 'idle' });
    if (p === '/api/update/install' && req.method === 'POST') {
      if (!opts.update) return json(404, { error: 'updates not available' });
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 2048) req.destroy(); });
      req.on('end', () => {
        let b;
        try { b = JSON.parse(body); } catch (e) { return json(400, { error: 'invalid JSON' }); }
        try { return json(202, opts.update.install(String(b.tag || ''), String(b.asset || ''))); }
        catch (e) { return json(e.code || 500, { error: e.message }); }
      });
      return;
    }

    // ---- file library ----
    if (p === '/api/files' && !writes) {
      let list = [];
      try {
        list = fs.readdirSync(opts.filesDir, { withFileTypes: true }).filter((d) => d.isFile() && FILE_RE.test(d.name))
          .map((d) => ({ name: d.name, size: fs.statSync(path.join(opts.filesDir, d.name)).size }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch (e) { /* empty */ }
      return json(200, list);
    }
    if (p === '/files' || p === '/files/') {
      if (writes) return send(405, 'text/plain', 'Method not allowed');
      let rows = '';
      try {
        fs.readdirSync(opts.filesDir, { withFileTypes: true }).filter((d) => d.isFile() && FILE_RE.test(d.name))
          .sort((a, b) => a.name.localeCompare(b.name))
          .forEach((d) => { rows += '<li><a href="/files/' + encodeURIComponent(d.name) + '">' + esc(d.name) + '</a></li>'; });
      } catch (e) { /* empty */ }
      return send(200, 'text/html; charset=utf-8',
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Files</title><body style="font:16px system-ui;background:#10140f;color:#e8eddf;padding:1rem">' +
        '<p><a style="color:#9acd32" href="/">&larr; Home</a></p><h1>Files</h1><ul>' + (rows || '<li>No files yet.</li>') + '</ul>');
    }
    if (p.startsWith('/files/')) {
      const name = p.slice(7);
      if (!FILE_RE.test(name)) return json(400, { error: 'Bad file name: ' + name.slice(0, 60) });
      const full = path.join(opts.filesDir, name);
      if (req.method === 'PUT') {
        const len = Number(req.headers['content-length']);
        if (!Number.isFinite(len)) return json(411, { error: 'Length required' });
        if (len > MAX_UPLOAD) return json(413, { error: 'File too large (limit 500 MB)' });
        fs.mkdirSync(opts.filesDir, { recursive: true });
        const tmp = full + '.part';
        const out = fs.createWriteStream(tmp);
        let got = 0, bad = false;
        req.on('data', (c) => { got += c.length; if (got > MAX_UPLOAD && !bad) { bad = true; out.destroy(); req.destroy(); } });
        req.on('error', () => { try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ } });
        out.on('error', () => { if (!res.headersSent) json(500, { error: 'write failed' }); });
        req.pipe(out);
        out.on('finish', () => {
          if (bad) return;
          fs.renameSync(tmp, full);
          json(200, { name, size: got });
        });
        return;
      }
      if (req.method === 'DELETE') {
        try { fs.unlinkSync(full); return json(200, { deleted: name }); } catch (e) { return json(404, { error: 'not found' }); }
      }
      let st;
      try { st = fs.statSync(full); } catch (e) { return send(404, 'text/plain', 'Not found'); }
      if (!st.isFile()) return send(404, 'text/plain', 'Not found');
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
      });
      return head ? res.end() : fs.createReadStream(full).pipe(res);
    }

    // ---- static site ----
    if (writes) return send(405, 'text/plain', 'Method not allowed');
    const rel = p === '/' ? 'index.html' : p.endsWith('/') ? p.slice(1) + 'index.html' : p.slice(1);
    const full = path.join(opts.siteDir, rel);
    if (!full.startsWith(opts.siteDir + path.sep)) return send(400, 'text/plain', 'Bad request');
    fs.readFile(full, (err, data) => {
      if (err) return send(404, 'text/plain', 'Not found');
      send(200, TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream', data);
    });
  });

  return {
    start(preferred) {
      return new Promise((resolve, reject) => {
        const listen = (pt, retry) => {
          server.once('error', (e) => { if (retry && e.code === 'EADDRINUSE') listen(0, false); else reject(e); });
          server.listen(pt, '127.0.0.1', () => { port = server.address().port; resolve(port); });
        };
        listen(preferred, true);
      });
    },
    stop() { server.close(); },
    get port() { return port; }
  };
}

// Read-only server for devices that join this device's Wi-Fi: the portal, the map viewer, library, hosted apps. No writes, no store API.
function createShare(opts) {
  // opts: siteDir, mapsDir, appsDir, reader, getName(), version
  let port = 0;
  const server = http.createServer((req, res) => {
    const head = req.method === 'HEAD';
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(head ? undefined : body); };
    let p; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { return send(400, 'text/plain', 'Bad request'); }
    if (opts.ai && (p === '/ai/api/chat' || p === '/ai/api/status')) {            // the only things a device on the Wi-Fi may do besides reading
      if ((p === '/ai/api/chat') !== (req.method === 'POST')) return send(405, 'text/plain', 'Method not allowed');
      const o = req.headers.origin; if (o) { try { if (new URL(o).host !== req.headers.host) return send(403, 'text/plain', 'Forbidden'); } catch (e) { return send(403, 'text/plain', 'Forbidden'); } }
      return opts.ai.handle(req, res, p.slice('/ai/api'.length), false);
    }
    if (req.method !== 'GET' && !head) return send(405, 'text/plain', 'Method not allowed');
    if (p.includes('\0') || p.includes('\\') || p.split('/').includes('..')) return send(400, 'text/plain', 'Bad request');
    if (p === '/api/device') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      return res.end(head ? undefined : JSON.stringify({ name: opts.getName(), mode: 'pi', version: opts.version, share: true, modules: false, address: 'http://' + (req.headers.host || ''),
        hasLibrary: !!(opts.reader && opts.reader.ready()), hasMaps: listDir(opts.mapsDir, TILE_RE).length > 0, hasApps: listDir(opts.appsDir, ASSET_FILE_RE).length > 0, tools: opts.siteList ? opts.siteList() : [], kolibri: opts.kolibriInfo ? opts.kolibriInfo() : null, ai: opts.ai ? { ready: opts.ai.engineInstalled() && opts.ai.models().length > 0 } : null }));
    }
    if (serveContent(req, res, p, head, opts)) return;
    // only the portal and the map viewer are public; the store, settings and updates are not
    const rel = p === '/' ? 'portal.html' : (p === '/ai/' && opts.ai) ? 'ai/index.html' : p.startsWith('/maps/') ? (p.endsWith('/') ? p.slice(1) + 'index.html' : p.slice(1)) : null;
    if (!rel) return send(404, 'text/plain', 'Not found');
    const full = path.join(opts.siteDir, rel);
    if (!full.startsWith(opts.siteDir + path.sep)) return send(400, 'text/plain', 'Bad request');
    fs.readFile(full, (err, data) => err ? send(404, 'text/plain', 'Not found') : send(200, TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream', data));
  });
  return {
    // try each port in turn (80 needs privileges; fall back to 8080, then any free port)
    start(ports, host) {
      return new Promise((resolve, reject) => {
        const list = ports.slice();
        const next = () => {
          if (!list.length) return reject(new Error('no free port'));
          const pt = list.shift();
          const onErr = (e) => { server.removeListener('listening', onOk); if (e.code === 'EADDRINUSE' || e.code === 'EACCES') next(); else reject(e); };
          const onOk = () => { server.removeListener('error', onErr); port = server.address().port; resolve(port); };
          server.once('error', onErr); server.once('listening', onOk); server.listen(pt, host || '0.0.0.0');
        };
        next();
      });
    },
    stop() { return new Promise((r) => { try { server.close(() => r()); server.closeAllConnections && server.closeAllConnections(); } catch (e) { r(); } }); },
    get port() { return port; }
  };
}

module.exports = { create, createShare, NAME_RE, FILE_RE };
