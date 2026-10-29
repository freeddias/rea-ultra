// Guild (consortia) store shared by players of the same site. The database's meta 'guilds' (store.js)
// is written through; members keep their own part (duty, offer, learned skills) in their player file
// (p.s.guild); the guild keeps the member list, levels, wealth (offer), notices and applications.
// Names and membership are scoped per site — the same guild name may exist on another server.
const store = require('../store');
const cfg = require('../config');
const T = require('../templates');

let state = store.getMeta('guilds', { nextId: 1, nextApplyId: 1, guilds: {} });
const save = () => store.setMeta('guilds', state);

// Older saves had no site; stamp from chairman / members / default so uniqueness stays per server.
(function migrateSites() {
  let dirty = false;
  for (const g of Object.values(state.guilds)) {
    if (g.site) continue;
    let site = null;
    for (const id of [g.chairmanId, g.creatorId, ...(g.members || [])]) {
      if (!id) continue;
      const pl = store.loadPlayer(id);
      if (pl && pl.site) { site = pl.site; break; }
    }
    g.site = site || cfg.SITE_NAME;
    dirty = true;
  }
  if (dirty) save();
})();

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
  const site = chairman.s.site || cfg.SITE_NAME;
  const g = state.guilds[id] = { id, site, name, creatorId: chairman.id, creatorName: chairman.s.nickName, chairmanId: chairman.id, created: Date.now(),
    levels: { 1: 1, 2: 0, 3: 0, 4: 0, 20: 0 }, offer: 0, totalOffer: 0, placard: '', description: '', groupPlacard: '', openApp: true,
    members: [chairman.id], code: null, applies: [], contrib: {} };
  save();
  return g;
}
const get = id => state.guilds[id] || null;
const byName = (name, site, excludeId) => Object.values(state.guilds).find(g =>
  g.site === site && g.id !== excludeId && g.name.toLowerCase() === String(name).trim().toLowerCase()) || null;
const all = (site) => {
  const list = Object.values(state.guilds);
  return site == null ? list : list.filter(g => g.site === site);
};
function remove(id) { delete state.guilds[id]; save(); }
const nextApplyId = () => { const n = state.nextApplyId++; return n; };
const sameSite = (g, p) => !!g && !!p && g.site === (p.s.site || cfg.SITE_NAME);

module.exports = { state, save, create, get, byName, all, remove, nextApplyId, level, maxMembers, wealthCap, sameSite, BUILDINGS, SKILLS, MAX_SKILL };
