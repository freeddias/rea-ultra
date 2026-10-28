// Rewrites recorded official-server packets (data/official_script.json, captured with recorder.js and
// tools/decode_capture.js + capture_to_script.js) for our character: ids, name, class, sex, skills,
// items, avatars and timestamps.
const fs = require('fs');
const path = require('path');
const tpl = require('./templates');

let SCRIPT = [];
try { SCRIPT = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/official_script.json'), 'utf8')); } catch (e) { }

const OFFICIAL_REF = { PLAYER: 956, ARMY: 6834, HERO: 850, CASTLE: 802411, NICK: 'finley9l', ICON: 3, JOB: 3, SERVER: 'bmdim_0039', SMALL_IDS: true };
const CAPTURE_OFFSET_MS = -4 * 3600000;   // official server zone in the capture (America/New_York, EDT): sysCurtime "19:09:34" = 23:09:34Z
const OFFICIAL_TIME = new Date(Date.UTC(2026, 9, 3, 19, 1, 38) - CAPTURE_OFFSET_MS);   // capture start (19:01:38 server time)
const JOB_AVATAR = { 1: 'warrior', 2: 'hunter', 3: 'wizard' };
const DT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const norm = k => k.toLowerCase().replace(/_/g, '');
const SKILL_KEYS = new Set(['orderid', 'skillid', 'skilltempid', 'skillids', 'templatedid']);

function fmt(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

class Rewriter {
  // ch: { playerId, nickName, sex, icon, job, camp, serverName }
  constructor(ch, shiftMs, ref = OFFICIAL_REF) {
    this.ch = ch;
    this.shift = shiftMs;
    this.ref = ref;
    this.ids = new Map([[ref.PLAYER, ch.playerId], [ref.ARMY, ch.playerId + 100000000],
      [ref.HERO, ch.playerId + 200000000], [ref.CASTLE, ch.playerId + 300000000]]);
  }
  skill(v) {
    if (v >= 30000 && v < 40000 && this.ch.job !== this.ref.JOB) {
      const nv = this.ch.job * 10000 + v % 10000;
      return tpl.skillIds.has(nv) ? nv : v;
    }
    return v;
  }
  int(key, v, p) {
    const k = norm(key);
    if (this.ids.has(v) && (!this.ref.SMALL_IDS || k.includes('id'))) return this.ids.get(v);
    if (SKILL_KEYS.has(k) || (k === 'templateid' && (p.includes('buffer') || p.includes('updatedskill')))) return this.skill(v);
    // job is 1..3 (icon 4..6 are the female heroes of the same jobs): never the icon
    if (k === 'pic' || k === 'herotempid') return v === this.ref.ICON ? this.ch.icon : v;
    if (k === 'job' && v === this.ref.JOB) return this.ch.job;
    // epoch timestamps (s or ms) in time-named fields move with the packet like the date strings
    if (/time|date|millisecond|stamp/.test(k) && ((v > 1.6e9 && v < 2.2e9) || (v > 1.6e12 && v < 2.2e12))) return v > 1e11 ? v + this.shift : v + Math.round(this.shift / 1000);
    if ((k === 'tempateid' || k === 'templateid') && v === this.ref.ICON && (p.includes('hero') || p.includes('player'))) return this.ch.icon;
    if (k === 'sex' && (!p.includes('hero') || p.includes('simplehero'))) return this.ch.sex;
    if (k.includes('template') || k === 'itemid') {
      const it = tpl.items[v];
      if (it && Number(it.Job) === this.ref.JOB && this.ch.job !== this.ref.JOB) return tpl.itemVariant.get(v + '|' + this.ch.job) || v;
    }
    return v;
  }
  str(key, v) {
    if (v === this.ref.NICK) return this.ch.nickName;
    if (v === this.ref.SERVER) return this.ch.serverName;
    if (DT.test(v)) {
      const [d, t] = v.split(' '), [Y, M, D] = d.split('-').map(Number), [h, m, s] = t.split(':').map(Number);
      if (Y < 2010 || Y > 2100) return v;   // "2000-01-01 00:00:00" / "2999-..." mean "never" / "unset"
      // recorded strings are the official server's wall clock (UTC-4, its U_C_TIME_ZONE); ours are local time
      return fmt(new Date(Date.UTC(Y, M - 1, D, h, m, s) - CAPTURE_OFFSET_MS + this.shift));
    }
    if (this.ch.job !== this.ref.JOB) {
      if (v.includes('wizard_')) v = v.split('wizard_').join(JOB_AVATAR[this.ch.job] + '_');
      const k = norm(key);
      if (k === 'skillscript' || k === 'fastkey') v = v.replace(/\b3(0\d{1,3})\b/g, (_, x) => this.ch.job + x);
    }
    return v;
  }
  field(k, v, p) {
    const q = p + '.' + norm(k);
    if (Array.isArray(v)) return v.map(x => this.field(k, x, p));
    if (v && typeof v === 'object') return this.walk(v, q);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return this.int(k, v, q);
    if (typeof v === 'string') return this.str(k, v);
    return v;
  }
  walk(o, p = '') {
    const r = {};
    for (const [k, v] of Object.entries(o)) r[k] = this.field(k, v, p);
    const get = name => Object.keys(r).find(x => norm(x) === name);
    // any record describing OUR player/hero: its appearance id is the icon
    const idk = ['userid', 'playerid'].map(get).filter(Boolean);
    if (idk.some(x => r[x] === this.ch.playerId))
      for (const n of ['userpics', 'tempid', 'pic', 'templateid', 'tempateid', 'herotempid']) { const x = get(n); if (x && r[x] === this.ref.ICON) r[x] = this.ch.icon; }
    if (get('baseintellect') && this.ch.job !== this.ref.JOB) this.classStats(r, get);
    // world-map nodes (mines, cities) held by the official server's players / guilds: shown unoccupied here
    // (capture: U_C_TREASURE_MINE_INFO occupyPlayerName "SucoDeFrutas", occupyGuildName "Legends")
    const occ = get('occupyplayerid');
    if (occ && r[occ] && r[occ] !== this.ch.playerId)
      for (const n of ['occupyplayerid', 'occupyplayername', 'occupyguildid', 'occupyguildname', 'occupyleaguename', 'occupyconsortiaid', 'occupyconsortianame']) { const x = get(n); if (x) delete r[x]; }
    return r;
  }
  // swap the reference mage's primary stats for this class's template (level-1 values)
  classStats(h, get) {
    const ref = tpl.heroes[this.ref.ICON], mine = tpl.heroes[this.ch.icon];
    if (!ref || !mine) return;
    for (const [stat, attr] of [['power', 'Power'], ['agility', 'Agility'], ['intellect', 'Intellect'], ['physique', 'Physique'], ['forcehit', 'ForceHit']]) {
      const d = mine[attr] - ref[attr];
      for (const pre of ['base', 'total']) { const x = get(pre + stat); if (x) h[x] += d; }
    }
    const dp = 4 * (mine.Power - ref.Power), dm = 4 * (mine.Intellect - ref.Intellect);
    for (const pre of ['base', 'total']) {
      const a = get(pre + 'phyattack'), b = get(pre + 'magicattack');
      if (a) h[a] += dp; if (b) h[b] += dm;
    }
  }
  // -> { type, obj } | { raw } | null (drop)
  // Times: each recorded packet is replayed as if it happened now (shift = now - its capture time), so the
  // remaining durations it carries (refresh in 1 h, event ends in 3 days) stay what the official server said.
  // Steps without a capture time fall back to the character-creation shift given to the constructor.
  packet(step) {
    if (!step.obj) return step.raw ? { raw: Buffer.from(step.raw, 'hex') } : { raw: Buffer.alloc(0) };
    const keep = this.shift;
    if (step.t) this.shift = Date.now() - step.t;
    const o = this.walk(JSON.parse(JSON.stringify(step.obj)), norm(step.type.split('.').pop()));
    this.shift = keep;
    if (step.code === 11 && o.roomPlayer) o.roomPlayer = o.roomPlayer.filter(p => p.playerId === this.ch.playerId);
    if (step.code === 4129 && o.baseCastle) o.baseCastle = o.baseCastle.filter(c => [this.ch.playerId, 0, undefined].includes(c.occupyPlayerId));
    if (step.code === 3) { o.pic = this.ch.icon; o.sex = this.ch.sex; o.camp = this.ch.camp; o.serverName = this.ch.serverName; }
    return { type: step.type, obj: o };
  }
}

// The Laya client copies every proto default onto decoded messages (Bh.parse), so "field absent" means
// "reset to empty" — unlike the Flash client the recording came from. Hero fields that the recording
// only sent sometimes are therefore remembered and re-filled into every message that carries them.
module.exports = { Rewriter, OFFICIAL_REF, OFFICIAL_TIME, SCRIPT };
