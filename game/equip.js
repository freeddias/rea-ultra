// Equipment extras: gem sockets (join_1..4) and random properties (randomSkill_1..5).
//  sockets: client ItemMsg.join_n > 0 gem template, 0 open and empty, -1 closed (an "Diamante Delici" 208004
//   opens one). Capture: Profile 2 equipment came with every socket closed, Profile 3 with join_1 open.
//   Profile 4+ (not in the capture): Profile - 2 open sockets, our extrapolation.
//  random properties: t_s_skilltemplate UseWay 2 "property skills", one per type: 20TT GG (T type, G grade
//   1..80) and 704GG for Liderlik (there is no 2004xx); their stats are t_s_skillpropertytemplate rows with
//   the same id. Grade ranges by the item's NeedGrades are the client's own (refresh window
//   initMinAndMaxStar); above Lv80 t_s_equip_refresh (Type 1, Level = current grade) gives them.
//   Count = item RandomSkillCount, types distinct (as on every captured item).
const D = require('./data');
const T = require('../templates');

const SOCKETS = 4, MAX_RANDOM = 5;
const SKILLS = new Map(T.table('t_s_skilltemplate').map(r => [r.TemplateId, r]));
const PROPS = new Map(T.table('t_s_skillpropertytemplate').map(r => [r.TemplateId, r]));
const REFRESH = new Map(T.table('t_s_equip_refresh').filter(r => r.Type === 1).map(r => [r.Level, r]));
const TYPES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 21];
// id -> grade is not plain arithmetic: Liderlik 704xx is shifted (70401 is grade 2, 70402 grade 3, capture
// item 70402 on a Lv1 item = grade 3 of 1..5), so ids are looked up by their Grades field
const idRange = type => type === 4 ? [70400, 70499] : [200000 + type * 100, 200000 + type * 100 + 99];
const BY_GRADE = {};
for (const [id, r] of SKILLS) for (const t of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 21]) { const [a, b] = idRange(t); if (id >= a && id <= b && r.Grades > 0) (BY_GRADE[t] = BY_GRADE[t] || {})[r.Grades] = id; }
const skillId = (type, g) => (BY_GRADE[type] || {})[g] || 0;
const typeOf = id => id >= 70400 && id < 70500 ? 4 : Math.floor((id - 200000) / 100);
// highest grade that exists per type (Liderlik stops at 55)
const MAX_GRADE = {};
for (const t of TYPES) MAX_GRADE[t] = Math.max(0, ...Object.keys(BY_GRADE[t] || {}).map(Number));
// the id of grade g, or of the nearest grade that exists (Liderlik has no grade 1)
function nearest(type, g) {
  for (let d = 0; d <= MAX_GRADE[type]; d++) { const id = skillId(type, g + d) || skillId(type, g - d); if (id) return id; }
  return 0;
}

const isEquip = tp => !!tp && tp.MasterType === 1;
function gradeRange(tp, cur = 0) {
  const n = tp.NeedGrades;
  if (n > 80) { const r = REFRESH.get(cur) || REFRESH.get(0); return [r.RangeDown, r.RangeUp]; }
  if (n === -1) return [30, 39];
  const rows = [[9, 1, 5], [19, 1, 10], [29, 5, 20], [39, 10, 30], [49, 15, 40], [59, 20, 50], [69, 25, 60], [79, 30, 70]];
  for (const [hi, lo, up] of rows) if (n <= hi) return [lo, up];
  return [40, 80];
}
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
// minGrade: Ultra purify floor — unlocked slots always roll at least this grade
// avoidType: prefer a different attribute than the slot's current one
function rollOne(tp, used, cur = 0, minGrade = 0, avoidType = 0) {
  let free = TYPES.filter(t => !used.has(t) && MAX_GRADE[t] > 0);
  if (avoidType && free.some(t => t !== avoidType)) free = free.filter(t => t !== avoidType);
  const type = free[Math.floor(Math.random() * free.length)];
  let [lo, hi] = gradeRange(tp, cur);
  if (minGrade > 0) { lo = Math.max(lo, minGrade); hi = Math.max(hi, lo); }
  used.add(type);
  return nearest(type, Math.max(1, Math.min(MAX_GRADE[type], rnd(lo, hi))));
}
// new random properties; locked[i] keeps the current one at i
// Ultra: unlocked slots always re-roll the attribute type and never drop grade (floor = cur+1)
function roll(tp, current = [], locked = []) {
  const n = Math.min(MAX_RANDOM, tp.RandomSkillCount || 0), out = [], used = new Set();
  for (let i = 0; i < n; i++) if (locked[i] && current[i]) used.add(typeOf(current[i]));
  for (let i = 0; i < n; i++) {
    if (locked[i] && current[i]) { out.push(current[i]); continue; }
    const cur = current[i] ? (SKILLS.get(current[i]) || {}).Grades || 0 : 0;
    const avoid = current[i] ? typeOf(current[i]) : 0;
    out.push(rollOne(tp, used, cur, cur > 0 ? cur + 1 : 0, avoid));
  }
  return out;
}
function defaultJoins(tp) {
  const open = Math.max(0, Math.min(SOCKETS, (tp.Profile || 0) - 2));
  return Array.from({ length: SOCKETS }, (_, i) => (i < open ? 0 : -1));
}
// gives a (new or older) equipment record its sockets and random properties
function init(it) {
  const tp = D.items.get(it.templateId);
  if (!isEquip(tp)) return false;
  let changed = false;
  if (!it.joins) { it.joins = defaultJoins(tp); changed = true; }
  if (!it.rnd) { it.rnd = roll(tp); changed = true; }
  return changed;
}
// stat additions of one equipped item's gems and random properties (both flat, not strengthened)
const KEYS = ['Power', 'Agility', 'Intellect', 'Physique', 'Captain', 'Attack', 'MagicAttack', 'Defence', 'MagicDefence', 'Live', 'Conat', 'ForceHit', 'Parry'];
// jewelPct: the soul jewel's gem effect (client Jo.getJewelEffecyByGrade): every non-zero attribute of a gem
// gets floor(the gem's attribute total x pct / 100) more (client parseJewelAddProperty)
function extras(it, jewelPct = 0) {
  const add = Object.fromEntries(KEYS.map(k => [k, 0]));
  for (const g of it.joins || []) {
    const t = g > 0 && D.items.get(g); if (!t) continue;
    const bonus = Math.floor(KEYS.reduce((n, k) => n + (t[k] || 0), 0) * jewelPct / 100);
    for (const k of KEYS) if (t[k]) add[k] += t[k] + bonus;
  }
  for (const id of it.rnd || []) { const r = PROPS.get(id); if (r && r.AddType === 1) for (const k of KEYS) add[k] += r[k] || 0; }
  return add;
}
// ItemMsg fields
function fields(it) {
  const o = {}, j = it.joins || [-1, -1, -1, -1];
  for (let i = 0; i < SOCKETS; i++) o['join_' + (i + 1)] = j[i] ?? -1;
  for (let i = 0; i < MAX_RANDOM; i++) o['randomSkill_' + (i + 1)] = (it.art || it.rnd || [])[i] || 0;   // art: an appraised pet artifact's blessings (features/petartifact.js)
  return o;
}

// equipment sets (t_s_suitetemplate; client: an item's SuiteId): with k pieces of one set worn, the set's PropertyK
// skill (k = 2..8) counts — its t_s_skillpropertytemplate AddType 1 values are flat attributes. Property1 of the
// one-piece rows is the item's own battle effect (not modelled). Set 1 (test items 1000..1005, +5,000,000) is left out.
const SUITS = new Map(T.table('t_s_suitetemplate').map(r => [r.TemplateId, r]));
const SUIT_KEYS = ['Power', 'Agility', 'Intellect', 'Physique', 'Captain', 'Attack', 'MagicAttack', 'Defence', 'MagicDefence', 'Live', 'ForceHit', 'Parry', 'Conat'];
function suitAdds(items) {
  const count = {}, add = {};
  for (const it of items) { const tp = D.items.get(it.templateId); if (tp && tp.SuiteId > 1) count[tp.SuiteId] = (count[tp.SuiteId] || 0) + 1; }
  for (const [id, n] of Object.entries(count)) {
    const s = SUITS.get(Number(id)); if (!s) continue;
    for (let k = 2; k <= Math.min(8, n); k++) {
      const pr = PROPS.get(Number(s['Property' + k])); if (!pr || pr.AddType !== 1) continue;
      for (const key of SUIT_KEYS) if (pr[key] && Math.abs(pr[key]) < 1e6) add[key] = (add[key] || 0) + pr[key];
    }
  }
  return add;
}

const jewelPct = g => (g <= 50 ? 2 * g : g <= 70 ? 3 * (g - 50) + 100 : g <= 80 ? 4 * (g - 70) + 160 : 0);
module.exports = { suitAdds, jewelPct, isEquip, init, roll, extras, fields, gradeRange, defaultJoins, typeOf, skillId, SOCKETS, MAX_RANDOM, MAX_GRADE, SKILLS, PROPS };
