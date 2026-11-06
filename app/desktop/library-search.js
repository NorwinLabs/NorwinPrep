'use strict';
// Lets the local AI read the installed library: finds the best matching pages for a question using the running kiwix-serve
// (full-text search over every installed pack), and returns their text plus the page addresses to show as sources.
// Talks to kiwix-serve on loopback only. Pure parsing helpers are exported so they can be tested without a reader.
const http = require('http');

const STOP = new Set('a an the and or of to in on at for with from by is are was were be been being do does did how what when where which who whom why can could should would will shall may might must i me my we our you your it its this that these those there here about into over under again then than so if as not no yes please tell give show need want make get use using have has had'.split(' '));
function keywords(q) {
  const words = String(q || '').toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
  const uniq = [...new Set(words)];
  return uniq.slice(0, 6);
}
const decode = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
function plain(html) {
  return decode(String(html).replace(/<(script|style|nav|header|footer|table)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
// the installed books, from kiwix-serve's catalogue (names to search with)
function parseBooks(xml) { const out = [], seen = new Set(); for (const m of String(xml).matchAll(/\/content\/([A-Za-z0-9_.-]+)/g)) if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); } return out; }
// result pages: every link into /content/<book>/..., with its text as the title
function parseResults(html, book) {
  const out = [], seen = new Set();
  for (const m of String(html).matchAll(/<a[^>]+href="([^"#?]*\/content\/([A-Za-z0-9_.-]+)\/([^"#?]+))"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const [, href, b, , inner] = m; if (book && b !== book) continue; if (seen.has(href)) continue;
    const title = plain(inner).replace(/\s+/g, ' ').trim(); if (!title) continue; seen.add(href); out.push({ href: decode(href), book: b, title: title.slice(0, 120) });
  }
  return out;
}
function get(port, path, timeout) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path, timeout: timeout || 6000, headers: { Accept: 'text/html,application/xml' } }, (res) => {
      if (res.statusCode >= 400) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => { d += c; if (d.length > 600000) res.destroy(); }); res.on('end', () => resolve(d)); res.on('error', reject);
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(new Error('timed out')); });
  });
}
// o: { port, root ('/wiki'), maxChars, maxPages, get }  ->  { text, sources:[{title, book, url}] } (empty text when nothing matched)
async function libraryContext(question, o) {
  const fetchText = o.get || ((p) => get(o.port, p)), root = o.root || '/wiki', maxChars = o.maxChars || 3000, maxPages = o.maxPages || 3;
  const words = keywords(question); if (!words.length) return { text: '', sources: [] };
  let books = []; try { books = parseBooks(await fetchText(root + '/catalog/v2/entries?count=100')); } catch (e) { /* older reader: search all packs below */ }
  const found = [];
  const searchAll = async (pattern) => {
    const targets = books.length ? books : [null];
    await Promise.all(targets.map(async (b) => {
      const q = root + '/search?' + (b ? 'content=' + encodeURIComponent(b) + '&' : '') + 'pattern=' + encodeURIComponent(pattern) + '&pageLength=3';
      try { const hits = parseResults(await fetchText(q), b); hits.slice(0, 2).forEach((h, i) => found.push(Object.assign(h, { rank: i }))); } catch (e) { /* this pack could not be searched */ }
    }));
  };
  await searchAll(words.join(' '));
  if (!found.length && words.length > 2) await searchAll(words.slice().sort((a, b) => b.length - a.length).slice(0, 2).join(' '));   // too strict: try the two most specific words
  if (!found.length) return { text: '', sources: [] };
  found.sort((a, b) => a.rank - b.rank);                       // best hit of each pack first, so several packs get a say
  const picked = found.slice(0, maxPages), per = Math.floor(maxChars / picked.length), parts = [], sources = [];
  for (const h of picked) {
    try { const t = plain(await fetchText(h.href.startsWith(root) ? h.href : root + h.href)); if (t.length < 40) continue; parts.push('[' + h.title + ']\n' + t.slice(0, per)); sources.push({ title: h.title, book: h.book, url: h.href }); } catch (e) { /* skip */ }
  }
  return { text: parts.join('\n\n'), sources };
}
module.exports = { libraryContext, keywords, parseBooks, parseResults, plain };
