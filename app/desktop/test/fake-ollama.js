#!/usr/bin/env node
// Stand-in for Ollama: `ollama serve` with /api/version, a streaming /api/pull that writes a manifest like the real one, /api/delete, and /v1/chat/completions that echoes.
const fs = require('fs'), path = require('path'), http = require('http');
if (process.argv[2] !== 'serve') { console.error('usage: ollama serve'); process.exit(2); }
if (process.env.FAKE_OLLAMA_CRASH) { console.error('Error: could not bind'); process.exit(3); }
const host = process.env.OLLAMA_HOST || '', port = Number(host.split(':')[1]), dir = process.env.OLLAMA_MODELS;
if (!/^127\.0\.0\.1:\d+$/.test(host) || !dir) { console.error('bad env ' + host + ' ' + dir); process.exit(4); }
const mpath = (name) => { const [repo, tag] = name.split(':'), parts = repo.includes('/') ? repo.split('/') : ['library', repo]; return path.join(dir, 'manifests', 'registry.ollama.ai', ...parts, tag); };
const readBody = (q, cb) => { let b = ''; q.on('data', (c) => b += c); q.on('end', () => cb(b)); };
http.createServer((q, r) => {
  if (q.url === '/api/version') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end('{"version":"0.0.0-fake"}'); }
  if (q.url === '/api/pull' && q.method === 'POST') return readBody(q, (b) => {
    const j = JSON.parse(b); r.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    if (/missing/.test(j.model)) { r.write('{"status":"pulling manifest"}\n'); return r.end('{"error":"pull model manifest: file does not exist"}\n'); }
    r.write('{"status":"pulling manifest"}\n'); let n = 0;
    const t = setInterval(() => {
      n++; r.write(JSON.stringify({ status: 'pulling abc123', digest: 'sha256:abc123', total: 4000000, completed: n * 1000000 }) + '\n');
      if (n === 4) { clearInterval(t); fs.mkdirSync(path.dirname(mpath(j.model)), { recursive: true }); fs.writeFileSync(mpath(j.model), JSON.stringify({ config: { size: 10 }, layers: [{ size: 4000000 }] })); r.write('{"status":"verifying sha256 digest"}\n'); r.end('{"status":"success"}\n'); }
    }, 30);
  });
  if (q.url === '/api/delete' && q.method === 'DELETE') return readBody(q, (b) => { try { fs.unlinkSync(mpath(JSON.parse(b).model)); r.writeHead(200); r.end(); } catch (e) { r.writeHead(404); r.end(); } });
  if (q.url === '/v1/chat/completions' && q.method === 'POST') return readBody(q, (b) => {
    const j = JSON.parse(b); r.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (c) => r.write('data: ' + JSON.stringify({ choices: [{ delta: { content: c } }] }) + '\n\n');
    chunk('OLLAMA MODEL=' + j.model + ' CTX=' + process.env.OLLAMA_CONTEXT_LENGTH + ' '); setTimeout(() => { chunk('BODY=' + b); r.write('data: [DONE]\n\n'); r.end(); }, 20);
  });
  r.writeHead(404); r.end('nope');
}).listen(port, '127.0.0.1');
