'use strict';
// Run: node test/exit-button.test.js. Kiwix's own pages get an Exit button back to NorwinPrep; other responses are untouched.
const http = require('http'), zlib = require('zlib');
const { Reader } = require('../reader');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL ' + m); } else console.log('ok   ' + m); };
const get = (port, p, h) => new Promise((res, rej) => { http.get({ host: '127.0.0.1', port, path: p, headers: h || {} }, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res({ code: r.statusCode, body: Buffer.concat(c), h: r.headers })); }).on('error', rej); });
let sawAcceptEncoding = null;
const kiwix = http.createServer((q, r) => {
  sawAcceptEncoding = q.headers['accept-encoding'];
  if (q.url.endsWith('/skin.css')) { r.writeHead(200, { 'Content-Type': 'text/css' }); return r.end('body{margin:0}'); }
  if (q.url.endsWith('/nobody')) { r.writeHead(200, { 'Content-Type': 'text/html' }); return r.end('<p>bare fragment</p>'); }
  if (q.url.endsWith('/zipped')) {   // like the real reader: compresses only when the client says it accepts that
    const page = '<html><body><h1>Zipped</h1></body></html>';
    if (/gzip/.test(q.headers['accept-encoding'] || '')) { const z = zlib.gzipSync(page); r.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip', 'Content-Length': z.length }); return r.end(z); }
    r.writeHead(200, { 'Content-Type': 'text/html' }); return r.end(page);
  }
  r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end('<html><body><h1>Library home</h1></body></html>');
});
kiwix.listen(0, '127.0.0.1', async () => {
  const rd = new Reader({ binDir: '/x', zimDir: '/x' }); rd.port = kiwix.address().port;
  const front = http.createServer((q, r) => rd.proxy(q, r)); await new Promise((res) => front.listen(0, '127.0.0.1', res)); const fp = front.address().port;
  let g = await get(fp, '/wiki/'); let html = g.body.toString();
  ok(g.code === 200 && /Library home/.test(html) && /id="np-exit"/.test(html) && /href="\/"/.test(html) && /Exit/.test(html), 'a Kiwix page gets an Exit button that goes to the NorwinPrep home');
  ok(html.indexOf('np-exit') < html.indexOf('</body>') && Number(g.h['content-length']) === g.body.length, 'it sits inside the page and the length is correct');
  g = await get(fp, '/wiki/zipped', { 'Accept-Encoding': 'gzip' }); html = g.body.toString();
  ok(/Zipped/.test(html) && /np-exit/.test(html) && !g.h['content-encoding'] && sawAcceptEncoding === undefined, 'compressed pages are fetched uncompressed so the button can be added');
  g = await get(fp, '/wiki/nobody'); ok(/bare fragment/.test(g.body.toString()) && /np-exit/.test(g.body.toString()), 'a page without </body> still gets the button');
  g = await get(fp, '/wiki/skin.css'); ok(g.body.toString() === 'body{margin:0}' && !/np-exit/.test(g.body.toString()), 'stylesheets and other files are passed through untouched');
  ok(/window\.top!==window\.self/.test(html), 'inside Kiwix\'s content frames the button removes itself, so it shows once');
  front.close(); kiwix.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
});
