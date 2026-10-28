// Guild (consortia) store shared by all players: the database's meta 'guilds' (store.js), written through. Members keep their own part (duty, offer, learned skills) in their player file
// (p.s.guild); the guild keeps the member list, levels, wealth (offer), notices and applications.
const store = require('../store');
const T = require('../templates');

let state = store.getMeta('guilds', { nextId: 1, nextApplyId: 1, guilds: {} });
const save = () => store.setMeta('guilds', state);

// t_s_consortialevel by Types|Levels. Types (client id enum): 1 guild, 2 shop, 3 altar, 4 skill school
// (LING_SHI), 20 safe box, 6 power, 8 agility (Zırh), 9 intellect, 10 captain, 11 gold, 12 physique
const LEVELS = new Map(T.table('t_s_consortialevel').map(r => [r.Types + '|' + r.Levels, r]));
const BUILDINGS = [1, 2, 3, 4, 20];
const SKILLS = [6, 8, 9, 10, 11, 12];
const MAX_SKILL = 10;
const level = (type, lv) => LEVELS.get(type + '|' + lv) || null;
// members allowed: "Maksimum üye sayısı 32" at Lv1, +2 per level (the guild templates' descriptions)
const maxMembers = g => { const m = String((level(1, g.levels[1]) || {}).Description_tr || '').match(/(\d+)/); return m ? Number(m[1]) : 30 + 2 * g.levels[1]; };
// guild wealth cap: Property1 of the guild level (50000 at Lv1 ... 500000 at Lv10)
const wealthCap = g => (level(1, g.levels[1]) || {}).Property1 || 50000;

function create(name, chairman) {
  const id = state.nextId++;
  const g = state.guilds[id] = { id, name, creatorId: chairman.id, creatorName: chairman.s.nickName, chairmanId: chairman.id, created: Date.now(),
    levels: { 1: 1, 2: 0, 3: 0, 4: 0, 20: 0 }, offer: 0, totalOffer: 0, placard: '', description: '', groupPlacard: '', openApp: true,
    members: [chairman.id], code: null, applies: [], contrib: {} };
  save();
  return g;
}
const get = id => state.guilds[id] || null;
const byName = name => Object.values(state.guilds).find(g => g.name.toLowerCase() === String(name).trim().toLowerCase()) || null;
const all = () => Object.values(state.guilds);
function remove(id) { delete state.guilds[id]; save(); }
const nextApplyId = () => { const n = state.nextApplyId++; return n; };

module.exports = { state, save, create, get, byName, all, remove, nextApplyId, level, maxMembers, wealthCap, BUILDINGS, SKILLS, MAX_SKILL };
