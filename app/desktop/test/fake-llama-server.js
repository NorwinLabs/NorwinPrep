#!/usr/bin/env node
// Stand-in for llama.cpp's llama-server: /health, and a streaming /v1/chat/completions that echoes back what it was sent.
const a = process.argv.slice(2), port = Number(a[a.indexOf('--port') + 1]), model = a[a.indexOf('-m') + 1], host = a[a.indexOf('--host') + 1];
if (process.env.FAKE_LLAMA_CRASH) { console.error('error: failed to load model'); process.exit(3); }
const t0 = Date.now(), delay = Number(process.env.FAKE_LLAMA_DELAY || 0);
require('http').createServer((q, r) => {
  if (q.url === '/health') { if (Date.now() - t0 < delay) { r.writeHead(503); return r.end('{"status":"loading"}'); } r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end('{"status":"ok"}'); }
  if (q.url === '/v1/chat/completions' && q.method === 'POST') {
    let b = ''; q.on('data', (c) => b += c); q.on('end', () => {
      const j = JSON.parse(b);
      if (!j.stream) { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ choices: [{ message: { content: 'ECHO ' + b } }] })); }
      r.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (c) => r.write('data: ' + JSON.stringify({ choices: [{ delta: { content: c } }] }) + '\n\n');
      chunk('MODEL=' + require('path').basename(model) + ' HOST=' + host + ' ARGS=' + a.join(' ') + ' '); setTimeout(() => { chunk('BODY=' + b); r.write('data: [DONE]\n\n'); r.end(); }, 30);
    }); return;
  }
  r.writeHead(404); r.end('nope');
}).listen(port, '127.0.0.1');
