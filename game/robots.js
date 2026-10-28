// The client's own robot opponents (t_s_robottemplate): Type 0 = names, Type 1 = single arena robots by level
// (Grades 16..30, Sexs), Type 2 = pet arena robots (Pets = pet templates), Type 4 = guard arena robots (Guard = guard
// ids). Used for the robot names / line-ups of arena.js, petarena.js and guardarena.js.
const T = require('../templates');
const ROWS = T.table('t_s_robottemplate');
const byType = t => ROWS.filter(r => r.Type === t && r.NickName_tr);
const NAMES = byType(0), ARENA = byType(1), PET = byType(2), GUARD = byType(4);
const pick = l => l[Math.floor(Math.random() * l.length)];
// a single-arena robot near this level: its name and sex (any name when no row has that level)
function arena(grades) {
  const near = ARENA.filter(r => Math.abs(r.Grades - grades) <= 1);
  const r = pick(near.length ? near : NAMES);
  return { nick: r.NickName_tr, sex: r.Sexs === 0 ? 0 : 1 };
}
const name = () => pick(NAMES).NickName_tr;
// a pet arena robot: name + pet templates
function pet() { const r = pick(PET); return { nick: r.NickName_tr, pets: String(r.Pets || '').split(',').map(Number).filter(Boolean) }; }
function guard() { const r = pick(GUARD); return { nick: r.NickName_tr, guards: String(r.Guard || '').split(',').map(Number).filter(Boolean) }; }
module.exports = { arena, name, pet, guard };
