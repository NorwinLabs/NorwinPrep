'use strict';
// A few app preferences kept in <library>/settings.json. Only known keys with valid values are ever stored or returned.
const fs = require('fs');
const path = require('path');
const DEFAULTS = { autoUpdate: false, autoUpdateHour: 3, autoUpdateMaxGB: 2, pauseOnBattery: false };
const CHECK = {
  autoUpdate: (v) => typeof v === 'boolean',
  autoUpdateHour: (v) => Number.isInteger(v) && v >= 0 && v <= 23,
  autoUpdateMaxGB: (v) => typeof v === 'number' && v >= 0.1 && v <= 500,
  pauseOnBattery: (v) => typeof v === 'boolean',
};
class Settings {
  constructor(dir) { this.file = dir ? path.join(dir, 'settings.json') : null; this.v = Object.assign({}, DEFAULTS); this.last = null; this.load(); }
  load() {
    if (!this.file) return;
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); for (const k of Object.keys(DEFAULTS)) if (CHECK[k](j[k])) this.v[k] = j[k]; if (j.last && typeof j.last === 'object') this.last = { t: Number(j.last.t) || 0, started: Array.isArray(j.last.started) ? j.last.started.filter((x) => typeof x === 'string').slice(0, 50) : [], note: String(j.last.note || '').slice(0, 120) }; } catch (e) { /* defaults */ }
  }
  save() { if (!this.file) return; try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(Object.assign({}, this.v, { last: this.last }))); } catch (e) { /* read-only: keep in memory */ } }
  get() { return Object.assign({}, this.v); }
  set(patch) {
    if (!patch || typeof patch !== 'object') throw new Error('invalid settings');
    for (const k of Object.keys(patch)) { if (!(k in DEFAULTS)) throw new Error('unknown setting ' + k); if (!CHECK[k](patch[k])) throw new Error('invalid value for ' + k); }
    Object.assign(this.v, patch); this.save(); return this.get();
  }
  setLast(info) { this.last = { t: Date.now(), started: (info.started || []).slice(0, 50), note: String(info.note || '').slice(0, 120) }; this.save(); }
}
module.exports = { Settings, DEFAULTS };
