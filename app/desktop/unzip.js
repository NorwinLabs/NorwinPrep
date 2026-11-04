'use strict';
// Minimal, safe .zip extractor (no external tools: GNU tar cannot read zip). Stored + deflate only, no zip64, no encryption.
// Refuses absolute paths, "..", and archives that expand beyond a size limit.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function unzip(buf, dest, maxTotal) {
  maxTotal = maxTotal || 600 * 1024 * 1024;
  let i = buf.length - 22;
  while (i >= Math.max(0, buf.length - 65557) && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(i + 10);
  let p = buf.readUInt32LE(i + 16), total = 0;
  const root = path.resolve(dest) + path.sep;
  fs.mkdirSync(dest, { recursive: true });
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip directory');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lh = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (flags & 1) throw new Error('encrypted zip entries are not supported');
    if (csize === 0xffffffff || usize === 0xffffffff || lh === 0xffffffff) throw new Error('zip64 is not supported');
    if (name.endsWith('/')) continue;
    if (name.includes('\0') || name.includes('\\') || path.isAbsolute(name) || name.split('/').includes('..')) throw new Error('unsafe path in zip: ' + name.slice(0, 60));
    const out = path.resolve(dest, name);
    if (!out.startsWith(root)) throw new Error('unsafe path in zip: ' + name.slice(0, 60));
    total += usize; if (total > maxTotal) throw new Error('zip expands too large');
    if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('corrupt zip entry');
    const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28), raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: usize + 1 });
    else throw new Error('unsupported zip compression ' + method);
    if (data.length !== usize) throw new Error('zip entry size mismatch: ' + name.slice(0, 60));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
  }
  return count;
}
module.exports = { unzip };
