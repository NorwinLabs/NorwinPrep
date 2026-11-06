'use strict';
// Run: node test/library.test.js. A fake kiwix-serve (catalogue, search, article pages) checks the library search the AI uses.
const http = require('http');
const { libraryContext, keywords, parseBooks, parseResults, plain } = require('../library-search');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL ' + m); } else console.log('ok   ' + m); };
ok(keywords('How do I purify water from a river if I have no filter?').join(' ') === 'purify water river filter', 'questions are cut down to their keywords: ' + keywords('How do I purify water from a river if I have no filter?').join(' '));
ok(parseBooks('<entry><link href="/wiki/content/zimgit-water_en"/></entry><entry><link href="/wiki/content/zimgit-medicine_en"/></entry><link href="/wiki/content/zimgit-water_en"/>').join() === 'zimgit-water_en,zimgit-medicine_en', 'books are read from the catalogue (no duplicates)');
ok(plain('<script>x()</script><p>Boil &amp; cool</p><nav>menu</nav><p>Store it</p>') === 'Boil & cool\nStore it', 'page text is stripped of scripts, menus and tags');
const PAGES = { '/wiki/content/zimgit-water_en/A/Boiling': '<html><body><h1>Boiling</h1><p>' + 'Bring water to a rolling boil for at least one minute. At altitude boil for three minutes. '.repeat(30) + '</p></body></html>', '/wiki/content/zimgit-medicine_en/A/Dehydration': '<html><body><p>' + 'Dehydration signs: thirst, dark urine, dizziness. Give small sips often. '.repeat(30) + '</p></body></html>' };
const seen = [];
const srv = http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x'); seen.push(q.url);
  if (u.pathname === '/wiki/catalog/v2/entries') { r.end('<feed><entry><link href="/wiki/content/zimgit-water_en"/></entry><entry><link href="/wiki/content/zimgit-medicine_en"/></entry></feed>'); return; }
  if (u.pathname === '/wiki/search') {
    const book = u.searchParams.get('content'), pat = u.searchParams.get('pattern');
    if (/zzzz/.test(pat)) return r.end('<ul class="results"></ul>');
    if (book === 'zimgit-water_en') return r.end('<ul class="results"><li><a href="/wiki/content/zimgit-water_en/A/Boiling">Boiling</a><cite>x</cite></li></ul>');
    if (book === 'zimgit-medicine_en') return r.end('<ul class="results"><li><a href="/wiki/content/zimgit-medicine_en/A/Dehydration">Dehydration</a></li></ul>');
  }
  if (PAGES[u.pathname]) return r.end(PAGES[u.pathname]);
  r.writeHead(404); r.end('no');
});
srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  let c = await libraryContext('How do I purify water?', { port, root: '/wiki', maxChars: 1000, maxPages: 3 });
  ok(c.sources.length === 2 && c.sources.map((x) => x.title).sort().join() === 'Boiling,Dehydration', 'it searches every installed pack and takes the best page of each: ' + c.sources.map((x) => x.title));
  ok(/rolling boil/.test(c.text) && /Dehydration signs/.test(c.text) && c.text.length <= 1200, 'the text is the pages themselves, kept within the size budget (' + c.text.length + ' characters)');
  ok(c.sources.every((x) => /^\/wiki\/content\/[a-z_-]+\/A\//.test(x.url)), 'sources are addresses inside the library');
  c = await libraryContext('zzzz qqqq', { port, root: '/wiki' }); ok(c.text === '' && c.sources.length === 0, 'nothing matches: nothing is added');
  c = await libraryContext('the and of', { port, root: '/wiki' }); ok(c.text === '', 'a question with no keywords adds nothing');
  c = await libraryContext('boiling water', { port: 1, root: '/wiki' }); ok(c.text === '', 'a reader that is not running adds nothing (no crash)');
  srv.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
});
