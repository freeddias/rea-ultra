// Drop engine over t_s_dropitem (the server-side drop table the client ships too).
// Per DropId, by AppearType:
//   1  always dropped
//   2  one row picked from the type-2 rows, weighted by Random
//   4  one row picked from the type-4 rows, weighted by Random
//   3  each row independently with chance Random / 1,000,000 (0 = never)
// Data = count. Used by boxes (item Property1 = DropId), sign-in (t_s_dropcondition type 17) and others.
const { table } = require('../templates');

const BY_DROP = new Map();
for (const r of table('t_s_dropitem')) {
  if (!BY_DROP.has(r.DropId)) BY_DROP.set(r.DropId, []);
  BY_DROP.get(r.DropId).push(r);
}

function pick(rows, rnd) {
  const total = rows.reduce((n, r) => n + Math.max(0, r.Random), 0);
  if (total <= 0) return null;
  let x = rnd() * total;
  for (const r of rows) { x -= Math.max(0, r.Random); if (x < 0) return r; }
  return rows[rows.length - 1];
}

// -> [[templateId, count], ...] (same template merged)
function roll(dropId, rnd = Math.random) {
  const rows = BY_DROP.get(dropId) || [], got = [];
  for (const r of rows) if (r.AppearType === 1) got.push(r);
  for (const t of [2, 4]) { const r = pick(rows.filter(x => x.AppearType === t), rnd); if (r) got.push(r); }
  for (const r of rows) if (r.AppearType === 3 && r.Random > 0 && rnd() * 1e6 < r.Random) got.push(r);
  const out = new Map();
  for (const r of got) out.set(r.ItemId, (out.get(r.ItemId) || 0) + (r.Data || 1));
  return [...out];
}

const has = dropId => BY_DROP.has(dropId);
// conditional drops (t_s_dropcondition): type -> rows
const CONDITION = new Map();
for (const r of table('t_s_dropcondition')) {
  if (!CONDITION.has(r.CondictionType)) CONDITION.set(r.CondictionType, []);
  CONDITION.get(r.CondictionType).push(r);
}

module.exports = { roll, has, rows: id => BY_DROP.get(id) || [], condition: t => CONDITION.get(t) || [] };
