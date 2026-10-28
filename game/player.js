// Persistent player state + derived values (hero stats, levels). One JSON file per player.
const fs = require('fs');
const path = require('path');
const D = require('./data');
const store = require('../store');
const E = require('./equip');


// per-level primary stat growth by job, derived from the recorded mage (Int+3, Agi+1, Phys+1)
// per-level growth. Mage verified against the capture (Lv1..23: Agility +1, Intellect +3, Physique +1,
// Captain +10, Power +0). Warrior / archer are NOT in any capture or table: mirrored guesses.
const GROWTH = {
  1: { power: 3, agility: 1, intellect: 0, physique: 1 },   // warrior (guess)
  2: { power: 1, agility: 3, intellect: 0, physique: 1 },   // archer (guess)
  3: { power: 0, agility: 1, intellect: 3, physique: 1 },   // mage (capture)
};
const RUNE_BAG_TYPE = 25, RUNE_BAG = Number(String((require('../templates').table('t_s_config').find(r => r.ConfigName === 'runehole_bag') || {}).ConfigValue || '80').split(',')[0]) || 80;
const isRuneGem = tp => (tp.SonType >= 411 && tp.SonType <= 415) || (tp.SonType >= 421 && tp.SonType <= 425);
const PE = require('./petequip');
const bagTypeOf = tp => isRuneGem(tp) ? RUNE_BAG_TYPE : PE.isPetEquip(tp) ? PE.PET_BAG : 1;   // pet equipment: its own bag (features/petequip.js)
const BASE_BAG = Number((require('../templates').table('t_s_config').find(r => r.ConfigName === 'Player_BagCount') || {}).ConfigValue) || 100;
const CAPTAIN_GROWTH = 10;   // capture: 100, 110, 120 ...
const CASTLE_MAP = 5;            // world map of the current client (official capture)
const VERSION = 2;               // player file format; older files (Flash-era client) start over
// academy research (msg.techBonus): PropertyType1 -> flat combat key on the hero
const TECH_FLAT = { 141: 'attack', 241: 'attack', 142: 'magicAttack', 242: 'magicAttack', 143: 'defence', 243: 'defence',
  144: 'magicDefence', 244: 'magicDefence', 145: 'live', 245: 'live' };

const MONEY = ['gold', 'point', 'giftToken', 'crystals'], MONEY_MAX = 2147483647;

class Player {
  constructor(s) { this.s = s; }

  // the players table of the database (store.js)
  static load(id) {
    try {
      const s = store.loadPlayer(id); if (!s) return null;
      if (s.version !== VERSION) return null;
      // equipment from before sockets / random properties existed gets them once
      let changed = false;
      for (const it of [...s.bag, ...Object.values(s.equip)]) changed = PE.init(it) || E.init(it) || changed;
      const p = new Player(s);
      if (MONEY.some(k => s[k] > MONEY_MAX)) changed = true;
      if (changed) p.save();   // rolled once, kept
      return p;
    } catch (e) { return null; }
  }
  // brand new character (account = db.js account record)
  static create(a) {
    const ch = a.char, tpl = D.heroes.get(ch.icon);
    const s = {
      version: VERSION, id: a.userId, site: a.site || null, nickName: ch.nickName, sex: ch.sex, icon: ch.icon, job: tpl.Job, camp: ch.camp || 1,
      // starting balances as the official new character (capture: gold 0 until the first quest reward,
      // no crystals at all through Lv23, weary 200)
      created: Date.now(), grades: 1, gp: 0, totalGp: 0, gold: 0, point: 0, giftToken: 0, crystals: 0,
      noviceProcess: 0, sonNoviceProcess: 0, newNoviceProcess: 0, tutorialDone: false, weary: 200, wearyLimit: 0,
      skills: (tpl.SkillScript || []).slice(), fastKey: (tpl.SkillScript || []).map(id => D.skills.get(id).SonType),
      nextItemId: a.userId * 100 + 1, bag: [], equip: {},
      quests: { active: {}, done: [] },
      buildings: [], castle: { mapId: CASTLE_MAP, posX: 361, posY: 1314 },
      pawns: {},               // castle reserve per pawn sonType: { tempId, count }
      army: { tempId: 0, count: 0 },   // troops the hero leads
      cleared: [],             // finished campaign ids
      campaign: null,          // { campaignId, nodes: {campDataId: state}, posX, posY }
    };
    const p = new Player(s);
    p.save();
    return p;
  }
  // money beyond int32 (the client's fields) is cut to the most it can show: the many direct `p.s.gold +=` too
  save() { for (const k of MONEY) if (this.s[k] > MONEY_MAX) this.s[k] = MONEY_MAX; store.savePlayer(this.s); }

  get id() { return this.s.id; }
  get armyId() { return this.s.id + 100000000; }
  get heroId() { return this.s.id + 200000000; }
  get castleId() { return this.s.id + 300000000; }
  get heroTpl() { return D.heroes.get(this.s.icon); }

  // ---- hero stats -------------------------------------------------------------------------------
  // Primary stats: template + per-level growth (+ equipment). Derived stats use the client's own formulas
  // (bundle Xo.calculatePlayerFightCapacity): attack = power*4 + Attack, magic attack = intellect*4 + MagicAttack,
  // defence = power + agility*4 + Defence, magic defence = intellect + agility*4 + MagicDefence,
  // hp = physique*20 + Live, command (conat) = captain + Conat. Checked against the capture's mage, Lv1..23.
  // Not yet included: passive skill % bonuses, troops' effect_Data.
  stats() {
    const t = this.heroTpl, lv = this.s.grades - 1, g = GROWTH[this.s.job] || GROWTH[1];
    const prim = {
      power: t.Power + g.power * lv, agility: t.Agility + g.agility * lv, intellect: t.Intellect + g.intellect * lv,
      physique: t.Physique + g.physique * lv, captain: t.Captain + CAPTAIN_GROWTH * lv,
    };
    const flat = { attack: t.Attack || 0, magicAttack: t.MagicAttack || 0, defence: t.Defence || 0, magicDefence: t.MagicDefence || 0,
      live: t.Live || 0, conat: t.conat || 0, forceHit: t.ForceHit || 0, parry: t.Parry || 0 };
    const derive = (p, f) => ({
      power: p.power, agility: p.agility, intellect: p.intellect, physique: p.physique, captain: p.captain,
      phyAttack: p.power * 4 + f.attack, magicAttack: p.intellect * 4 + f.magicAttack,
      phyDefence: p.power + p.agility * 4 + f.defence, magicDefence: p.intellect + p.agility * 4 + f.magicDefence,
      live: p.physique * 20 + f.live, conat: p.captain + f.conat, forceHit: f.forceHit, parry: f.parry,
    });
    const base = derive(prim, flat);
    // equipment adds template attributes; strengthening adds floor(v * g * 0.1 + 5 * g) to every non-zero one
    // (client: forge view getCurr)
    const p2 = Object.assign({}, prim), f2 = Object.assign({}, flat);
    // guild skills (t_s_consortialevel 6/8/9/12: +40 per level, 10 Liderlik: +20 per level)
    const gs = (this.s.guild && this.s.guild.skills) || {};
    p2.power += 40 * (gs[6] || 0); p2.agility += 40 * (gs[8] || 0); p2.intellect += 40 * (gs[9] || 0); p2.physique += 40 * (gs[12] || 0); p2.captain += 20 * (gs[10] || 0);
    for (const it of Object.values(this.s.equip)) {
      const tp = D.items.get(it.templateId); if (!tp) continue;
      const sg = it.strengthenGrade || 0;
      // Tanrısal döküm (features/smith.js C_MOULD_ITEM): client getMouldAddition on the template value
      const mg = it.mouldGrade || 0, mv = x => !x || !mg ? 0 : mg <= 80 ? Math.floor(x * mg * 0.3) : mg <= 160 ? Math.ceil(x * 24) + Math.ceil(x * (mg - 80) * 0.4) : Math.ceil(x * 24) + Math.ceil(x * 32) + Math.ceil(x * (mg - 160) * 0.25);
      const v = k => { const x = tp[k] || 0; return x ? x + Math.floor(x * sg * 0.1 + 5 * sg) + mv(x) : 0; };
      p2.power += v('Power'); p2.agility += v('Agility'); p2.intellect += v('Intellect'); p2.physique += v('Physique'); p2.captain += v('Captain');
      f2.attack += v('Attack'); f2.magicAttack += v('MagicAttack'); f2.defence += v('Defence'); f2.magicDefence += v('MagicDefence');
      f2.live += v('Live'); f2.conat += v('Conat'); f2.forceHit += v('ForceHit'); f2.parry += v('Parry');
      // gems and random properties: flat, not strengthened (equip.js)
      const x = E.extras(it, E.jewelPct((this.s.jewel && this.s.jewel.grade) || 0));   // soul jewel (features/bag.js C_BAG_USESTORE)
      p2.power += x.Power; p2.agility += x.Agility; p2.intellect += x.Intellect; p2.physique += x.Physique; p2.captain += x.Captain;
      f2.attack += x.Attack; f2.magicAttack += x.MagicAttack; f2.defence += x.Defence; f2.magicDefence += x.MagicDefence;
      f2.live += x.Live; f2.conat += x.Conat; f2.forceHit += x.ForceHit; f2.parry += x.Parry;
    }
    // equipment sets (equip.js suitAdds): flat attributes for 2+ pieces of one set
    const su = E.suitAdds(Object.values(this.s.equip));
    p2.power += su.Power || 0; p2.agility += su.Agility || 0; p2.intellect += su.Intellect || 0; p2.physique += su.Physique || 0; p2.captain += su.Captain || 0;
    f2.attack += su.Attack || 0; f2.magicAttack += su.MagicAttack || 0; f2.defence += su.Defence || 0; f2.magicDefence += su.MagicDefence || 0;
    f2.live += su.Live || 0; f2.forceHit += su.ForceHit || 0; f2.parry += su.Parry || 0; f2.conat += su.Conat || 0;
    // mount training (features/mount.js): attribute = mount template value + 5 x property grade
    const mt = this.s.mount && this.s.mount.add;
    if (mt) { p2.power += mt.power || 0; p2.agility += mt.agility || 0; p2.intellect += mt.intellect || 0; p2.physique += mt.physique || 0; }
    // academy technologies (msg.techBonus): hero ATQ/ATQM/DEF/DEFM/HP per research grade (types 141..145 / 241..245)
    const { techBonus } = require('./msg');
    for (const [type, key] of Object.entries(TECH_FLAT)) f2[key] += techBonus(this, Number(type));
    // generic flat additions of later features: s.adds[source] = { Power, Attack, Live, ... }
    for (const ad of Object.values(this.s.adds || {})) {
      p2.power += ad.Power || 0; p2.agility += ad.Agility || 0; p2.intellect += ad.Intellect || 0; p2.physique += ad.Physique || 0; p2.captain += ad.Captain || 0;
      f2.attack += ad.Attack || 0; f2.magicAttack += ad.MagicAttack || 0; f2.defence += ad.Defence || 0; f2.magicDefence += ad.MagicDefence || 0;
      f2.live += ad.Live || 0; f2.forceHit += ad.ForceHit || 0; f2.parry += ad.Parry || 0; f2.conat += ad.Conat || 0;
    }
    // honour equipment + rank (features/honor.js): flat, cached in s.honor.add
    const ha = this.s.honor && this.s.honor.add;
    if (ha) {
      p2.power += ha.Power || 0; p2.agility += ha.Agility || 0; p2.intellect += ha.Intellect || 0; p2.physique += ha.Physique || 0; p2.captain += ha.Captain || 0;
      f2.attack += ha.Attack || 0; f2.magicAttack += ha.MagicAttack || 0; f2.defence += ha.Defence || 0; f2.magicDefence += ha.MagicDefence || 0;
      f2.live += ha.Live || 0; f2.forceHit += ha.ForceHit || 0; f2.parry += ha.Parry || 0;
    }
    // rune holes (features/runegem.js): gems in the holes x (1 + hole bonus), cached in s.runeGem.add
    const ra = this.s.runeGem && this.s.runeGem.add;
    if (ra) {
      p2.power += ra.Power || 0; p2.agility += ra.Agility || 0; p2.intellect += ra.Intellect || 0; p2.physique += ra.Physique || 0; p2.captain += ra.Captain || 0;
      f2.attack += ra.Attack || 0; f2.magicAttack += ra.MagicAttack || 0; f2.defence += ra.Defence || 0; f2.magicDefence += ra.MagicDefence || 0;
      f2.live += ra.Live || 0; f2.forceHit += ra.ForceHit || 0; f2.parry += ra.Parry || 0;
    }
    // equipped luck stars (astrology): template attribute x star level (client Qc.getStarAttributeAdd)
    for (const st of Object.values((this.s.star && this.s.star.equip) || {})) {
      const tp = D.stars.get(st.tid); if (!tp) continue;
      const g = st.grade || 1;
      p2.power += (tp.Power || 0) * g; p2.agility += (tp.Agility || 0) * g; p2.intellect += (tp.Intellect || 0) * g;
      p2.physique += (tp.Physique || 0) * g; p2.captain += (tp.Captain || 0) * g;
      f2.attack += (tp.Attack || 0) * g; f2.magicAttack += (tp.MagicAttack || 0) * g; f2.defence += (tp.Defence || 0) * g;
      f2.magicDefence += (tp.MagicDefence || 0) * g; f2.live += (tp.Live || 0) * g; f2.conat += (tp.Conat || 0) * g;
      f2.forceHit += (tp.ForceHit || 0) * g; f2.parry += (tp.Parry || 0) * g;
    }
    // talents (features/talent.js): flat values, then percentages of the totals
    const ta = this.s.talent && this.s.talent.add;
    if (ta) for (const [k, v] of Object.entries(ta.flat || {})) f2[k] = (f2[k] || 0) + v;
    const total = derive(p2, f2);
    if (ta) {
      const PCT = { attack: 'phyAttack', magicAttack: 'magicAttack', defence: 'phyDefence', magicDefence: 'magicDefence', live: 'live', forceHit: 'forceHit', parry: 'parry' };
      for (const [k, v] of Object.entries(ta.pct || {})) if (PCT[k]) total[PCT[k]] = Math.floor(total[PCT[k]] * (1 + v / 100));
    }
    // generic percentage bonuses of later features: s.addsPct[source] = { attack: %, defence: %, ... }
    const PCT2 = { attack: 'phyAttack', magicAttack: 'magicAttack', defence: 'phyDefence', magicDefence: 'magicDefence', live: 'live', forceHit: 'forceHit', parry: 'parry' };
    for (const ap of Object.values(this.s.addsPct || {})) for (const [k, v] of Object.entries(ap)) if (PCT2[k] && v) total[PCT2[k]] = Math.floor(total[PCT2[k]] * (1 + v / 100));
    return { base, total };
  }
  attack() { const t = this.stats().total; return this.s.job === 3 ? t.magicAttack : t.phyAttack; }
  // client formula (Xo.calculatePlayerFightCapacity, all totalPre multipliers 100%); reproduces the capture's
  // fightingCapacity at every level 1..23
  fightingCapacity() {
    const t = this.stats().total;
    return t.phyAttack + Math.floor(1.05 * t.magicAttack) + t.phyDefence + t.magicDefence + Math.floor(t.live / 5) + t.conat + t.forceHit + t.parry;
  }

  // ---- progression ------------------------------------------------------------------------------
  // returns number of levels gained
  // Lv80 until the job change (features/transfer.js), then up to the table's 160
  maxLevel() { return this.s.jobChange ? D.maxLevel : Math.min(D.maxLevel, D.baseMaxLevel); }
  addExp(n) {
    let ups = 0;
    this.s.gp += n; this.s.totalGp += n;
    while (this.s.grades < this.maxLevel() && this.s.gp >= (D.levelExp.get(this.s.grades + 1) || Infinity)) {
      this.s.gp -= D.levelExp.get(this.s.grades + 1); this.s.grades++; ups++;
    }
    return ups;
  }
  // skill points: 1 at Lv5, +1 every odd level after (official capture: Lv5 1, Lv7 2 ... Lv21 9)
  // + Santo Graal extras (s.extraSkillPoint = cups used, each +1 spendable point; features/hero.js)
  skillPointsTotal() { return this.s.grades >= 5 ? Math.floor((this.s.grades - 3) / 2) : 0; }
  skillPointsLeft() { return Math.max(0, this.skillPointsTotal() + (this.s.extraSkillPoint || 0) - (this.s.skillSpent || 0)); }
  // ---- troops -----------------------------------------------------------------------------------
  population() { return Object.values(this.s.pawns).reduce((n, r) => n + (r.count || 0), 0) + (this.s.army.count || 0); }
  // ---- bag ---------------------------------------------------------------------------------------
  // client capacity = t_s_config Player_BagCount (100) + PlayerMsg.bagCount (the bought cells, rows of
  // Player_BagAdd 5; client bagTotalCount). bagCount used to be sent as 48: the client showed 148 cells while
  // the server called the bag full at 48.
  get bagSize() { return BASE_BAG + (this.s.bagBought || 0); }
  // rune gems (SonType 411-415 / 421-425) live in their own bag (client hr.RUNE 25): runehole_bag 80 cells
  // + PlayerMsg.runeCount bought (features/runegem.js)
  get runeBagSize() { return RUNE_BAG + ((this.s.runeGem && this.s.runeGem.bought) || 0); }
  sizeOf(bt) { return bt === RUNE_BAG_TYPE ? this.runeBagSize : bt === PE.PET_BAG ? PE.BAG_BASE + (this.s.petBagBought || 0) : this.bagSize; }
  freePos(bt = 1) {
    const used = new Set(this.s.bag.filter(i => (i.bagType ?? 1) === bt).map(i => i.pos));
    for (let p = 0; p < this.sizeOf(bt); p++) if (!used.has(p)) return p;
    return -1;
  }
  // add count of templateId (rune gems into the rune bag); returns list of changed item records
  addItem(templateId, count = 1) {
    const tp = D.items.get(templateId); if (!tp) return [];
    const changed = [];
    const max = tp.MaxCount || 1, bt = bagTypeOf(tp);
    for (const it of this.s.bag) {
      if (count <= 0) break;
      if (it.templateId === templateId && (it.bagType ?? 1) === bt && it.count < max) { const add = Math.min(max - it.count, count); it.count += add; count -= add; changed.push(it); }
    }
    while (count > 0) {
      const pos = this.freePos(bt); if (pos < 0) break;
      const n = Math.min(max, count);
      const it = { id: this.s.nextItemId++, templateId, pos, count: n, bagType: bt, isNew: true };
      E.init(it); PE.init(it);
      // time-limited medals (features/medal.js): Property1 seconds -> validDate minutes from now
      if ((tp.SonType === 1301 || tp.SonType === 1302) && tp.Property1 > 0) {
        const d = new Date(), z = x => String(x).padStart(2, '0');
        it.beginDate = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
        it.validDate = Math.ceil(tp.Property1 / 60);
      }
      this.s.bag.push(it); changed.push(it); count -= n;
    }
    return changed;
  }
  countTemplate(tid) { return this.s.bag.filter(i => i.templateId === tid && (i.bagType ?? 1) === 1).reduce((n, i) => n + i.count, 0); }
  // removes n of a template from the bag (smallest stacks first); returns the touched items
  takeTemplate(tid, n) {
    const touched = [];
    for (const it of this.s.bag.filter(i => i.templateId === tid && (i.bagType ?? 1) === 1).sort((a, b) => a.count - b.count)) {
      if (n <= 0) break;
      const k = Math.min(n, it.count); this.removeItem(it, k); n -= k; touched.push(it);
    }
    return touched;
  }
  itemAt(pos, bagType = 1) { return this.s.bag.find(i => i.pos === pos && (i.bagType ?? 1) === bagType); }
  removeItem(it, count = 1) {
    it.count -= count;
    if (it.count <= 0) this.s.bag = this.s.bag.filter(x => x !== it);
  }
}

module.exports = { Player, CASTLE_MAP, VERSION, isRuneGem, RUNE_BAG_TYPE, bagTypeOf };
