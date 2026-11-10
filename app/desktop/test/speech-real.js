'use strict';
// Real-network test (.github/workflows/ai-real.yml, job "speech"): installs the REAL speech model with the app's own installer, serves it and the real
// vosk-browser from the app's own server, plays a spoken sentence into a fake microphone in a real Chromium, presses the microphone button on the
// AI page and checks the words come out. Prints the model's size and SHA-256 (to pin in the catalog) and the transcript.
// Needs: playwright (npm i --no-save playwright; npx playwright install --with-deps chromium), espeak-ng and ffmpeg.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), { execFileSync } = require('child_process');
const { Manager } = require('../modules-manager');
const { create } = require('../local-server');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL ' + m); } else console.log('ok   ' + m); };
(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'npspeech-')), work = fs.mkdtempSync(path.join(os.tmpdir(), 'npspeechw-'));
  const mgr = new Manager({ catalog: path.join(__dirname, '..', '..', 'shared', 'site', 'catalog.json'), dataDir: data, platform: process.platform, arch: process.arch, timeout: 120000 });
  const t0 = Date.now(); mgr.enqueue('speech-en', 'install'); let j; for (let i = 0; i < 1200; i++) { j = mgr.jobs['speech-en']; if (j.state === 'done' || j.state === 'error') break; await new Promise((r) => setTimeout(r, 500)); }
  ok(j.state === 'done', 'the real speech model installed (' + Math.round((Date.now() - t0) / 1000) + 's): ' + j.message); if (j.state !== 'done') process.exit(1);
  const model = path.join(data, 'speech', fs.readdirSync(path.join(data, 'speech')).filter((f) => f.endsWith('.tar.gz'))[0]), buf = fs.readFileSync(model);
  console.log('MODEL_FILE=' + path.basename(model) + ' MODEL_BYTES=' + buf.length + ' MODEL_SHA256=' + crypto.createHash('sha256').update(buf).digest('hex'));
  console.log('model contents:', execFileSync('tar', ['-tzf', model]).toString().split('\n').slice(0, 14).join(' '));
  // a spoken sentence with 1.5 s of silence around it, as 16 kHz mono PCM
  const say = 'boil the water for one minute', raw = path.join(work, 'raw.wav'), wav = path.join(work, 'speech.wav');
  execFileSync('espeak-ng', ['-v', 'en-us', '-s', '135', '-w', raw, say]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-af', 'adelay=1500|1500,apad=pad_dur=2', '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', wav]);
  const { chromium } = require('playwright');
  const app = create({ siteDir: path.resolve(__dirname, '..', '..', 'shared', 'site'), filesDir: data, getName: () => 'x', setName: () => {}, version: '1', platform: process.platform, speechDir: path.join(data, 'speech'),
    ai: { handle(q, r) { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ engine: true, models: ['m.gguf'], active: 'm.gguf', canSelect: true })); }, engineInstalled: () => true, models: () => ['m.gguf'] } });
  const port = await app.start(0);
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-audio-capture=' + wav + '%noloop'] });
  const ctx = await browser.newContext({ permissions: ['microphone'] }), pg = await ctx.newPage(); const errs = []; pg.on('pageerror', (e) => errs.push(e.message)); pg.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await pg.goto('http://127.0.0.1:' + port + '/ai/'); await pg.waitForSelector('#mic:not([hidden])', { timeout: 15000 }); ok(true, 'the microphone button appears once the model is installed');
  const t1 = Date.now(); await pg.click('#mic'); await pg.waitForFunction(() => document.querySelector('#mic').classList.contains('on'), null, { timeout: 120000 });
  ok(true, 'the real recogniser loaded the real model and the microphone is on (' + Math.round((Date.now() - t1) / 1000) + 's)');
  let text = ''; const t2 = Date.now(); while (Date.now() - t2 < 40000) { text = await pg.inputValue('#q'); if (/water/i.test(text) && /minute/i.test(text)) break; await new Promise((r) => setTimeout(r, 500)); }
  await pg.click('#mic'); await new Promise((r) => setTimeout(r, 1500)); const final = await pg.inputValue('#q');
  console.log('SAID: "' + say + '"\nHEARD while listening: ' + JSON.stringify(text) + '\nHEARD after stopping: ' + JSON.stringify(final) + '\npage errors: ' + JSON.stringify(errs));
  // diagnostic: the same audio straight into the recogniser (no microphone path): is the synthetic voice itself recognisable?
  const pcm = fs.readFileSync(wav).slice(44).toString('base64');
  const direct = await pg.evaluate(async (b64) => {
    const bin = atob(b64), n = bin.length >> 1, f = new Float32Array(n); for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v > 32767) v -= 65536; f[i] = v / 32768; }
    const model = await window.Vosk.createModel('/speech/model.tar.gz'), rec = new model.KaldiRecognizer(16000), said = []; rec.on('result', (m) => { if (m.result.text) said.push(m.result.text); });
    for (let i = 0; i < n; i += 4000) rec.acceptWaveformFloat(f.slice(i, i + 4000), 16000); rec.retrieveFinalResult(); await new Promise((r) => setTimeout(r, 4000)); model.terminate(); return said.join(' ');
  }, pcm);
  console.log('HEARD straight from the file (no microphone): ' + JSON.stringify(direct));
  const hits = ['boil', 'water', 'one', 'minute'].filter((w) => new RegExp(w, 'i').test(final)).length;
  ok(hits >= 2, 'the spoken words were recognised (' + hits + ' of 4 key words in the transcript)');
  await browser.close(); await app.stop(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
