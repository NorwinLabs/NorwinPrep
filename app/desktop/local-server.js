'use strict';
// Local NorwinPrep instance: serves the app's home page, a device-info API and a small file library,
// bound to 127.0.0.1 only. No dependencies besides Node core, so it also runs standalone for tests.
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif'
};
const NAME_RE = /^[A-Za-z0-9 ._()\-]{1,40}$/;                 // device name
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()\-]{0,99}$/;      // library file name
const MAX_UPLOAD = 500 * 1024 * 1024;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function create(opts) {
  // opts: siteDir, filesDir, getName(), setName(n), version, platform
  let port = 0;
  const origins = () => ['http://127.0.0.1:' + port, 'http://localhost:' + port];
  const hostOk = (h) => origins().some((o) => o === 'http://' + h);

  const deviceInfo = () => ({
    name: opts.getName(), mode: 'local', platform: opts.platform, version: opts.version,
    address: 'http://127.0.0.1:' + port, filesDir: opts.filesDir,
    arch: opts.arch || '', packaging: opts.packaging || ''
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
    const rel = p === '/' ? 'index.html' : p.slice(1);
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

module.exports = { create, NAME_RE, FILE_RE };
