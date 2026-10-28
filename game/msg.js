// Message builders: player state -> protobuf objects. Recorded real messages (ref/*.json) give the
// exact field set the client expects; player-specific values come from the Player.
const path = require('path');
const fs = require('fs');
const { sysTime } = require('../util');
const cfg = require('../config');
const sites = require('../sites');
const D = require('./data');
const E = require('./equip');
const PE = require('./petequip');
const RUNE = require('./rune');

const REF = {};
for (const f of fs.readdirSync(path.join(__dirname, '../ref'))) if (f.endsWith('.json')) REF[f.split('_')[0]] = JSON.parse(fs.readFileSync(path.join(__dirname, '../ref', f), 'utf8'));
const clone = o => JSON.parse(JSON.stringify(o));
const SITE_LEN = 255;   // QuestSite bytes (this client version)
const ZERO_STATES = Buffer.alloc(SITE_LEN).toString('base64');

function questSite(p) {
  // bitset of finished quest template ids (QuestSite)
  const b = Buffer.alloc(SITE_LEN);
  for (const id of p.s.quests.done) if (id >= 1 && id <= SITE_LEN * 8) b[(id - 1) >> 3] |= (1 << ((id - 1) & 7));   // bit (id-1), as recorded
  return b.toString('base64');
}

function playerMsg(p) {
  const s = p.s, o = clone(REF[3]);
  Object.assign(o, {
    playerId: s.id, nickName: s.nickName, sex: s.sex, pic: s.icon, camp: s.camp, job: s.job,   // icon 4..6 are the female heroes of jobs 1..3
    point: s.point, giftToken: s.giftToken, grades: s.grades, gp: s.gp, totalGp: s.totalGp,
    noviceProcess: s.noviceProcess, sonNoviceProcess: s.sonNoviceProcess, newNoviceProcess: noviceNodes(s),
    weary: s.weary || 0, wearyLimit: s.wearyLimit || 0,   // potion quota (client BatchUseWnd / Weary_Limit)
    fightingCapacity: p.fightingCapacity(), questSite: questSite(p), questSiteLen: SITE_LEN,
    serverName: sites.showNameOf(s.site) || cfg.SERVER_NAME, createTime: s.created,
    bagCount: p.s.bagBought || 0,   // bought cells; the client adds Player_BagCount (player.js bagSize)
    // astrology (features/star.js): bought star bag cells, today's free rolls, star points
    // rune gems (features/runegem.js): Fragmento de Símbolo (-1000), bought rune bag cells, stone energy
    runeNum: (s.currency || {})[-1000] || 0, runeCount: (s.runeGem && s.runeGem.bought) || 0, runePowerPoint: (s.runeEnergy && s.runeEnergy.val) || 0,
    starCount: (s.star && s.star.bagAdd) || 0, startFree: s.star ? s.star.free || 0 : 1, starpoint: (s.star && s.star.point) || 0,
    isPassOpen: !!(module.exports.passOpen && module.exports.passOpen(p)),   // features/pass.js
    geste: s.geste || 0,   // onur puanı (features/honor.js ranks)
    petEquipStrengNum: (s.currency || {})[-910] || 0, petBagCount: s.petBagBought || 0,   // Peri Ruh Cristali, bought pet bag cells (features/petequip.js)
    storeGrade: (s.jewel && s.jewel.grade) || 0, storeGp: (s.jewel && s.jewel.gp) || 0,   // soul jewel (bag.js C_BAG_USESTORE)
    nuid: 'L' + s.id.toString(36).toUpperCase(),   // shown as the player's UID / invite code (recorded one was the official player's)
  });
  o.order = Object.assign({}, o.order, { playerId: s.id });
  Object.assign(o, guildFields(p));
  Object.assign(o, s.settings || {});   // setting switches (features/playerops.js): refuse*, mbSeting*, push*
  return o;
}
// guild part of PlayerMsg (client reads consortiaId, consortiaAttack -> consortiaPower, consortiaAbility ->
// consortiaIntellect ...; lastOutConsortia in seconds, compared with now - 86400)
function guildFields(p) {
  const m = p.s.guild, G = require('./guilds'), g = m && G.get(m.id), sk = (m && m.skills) || {};
  return { consortiaId: g ? g.id : 0, consortiaName: g ? g.name : '', consortiaOffer: g ? m.offer || 0 : 0, consortiaTotaloffer: g ? m.totalOffer || 0 : 0,
    guildDuty: g ? m.duty : 0, joinConsortiaTime: g ? m.joined : 0, lastOutConsortia: Math.floor((p.s.lastOutGuild || 0) / 1000), addGuildCount: p.s.guildJoins || 0,
    consortiaAttack: sk[6] || 0, consortiaAgility: sk[8] || 0, consortiaAbility: sk[9] || 0, consortiaCaptain: sk[10] || 0, consortiaGold: sk[11] || 0, consortiaPhysique: sk[12] || 0 };
}
const guildCard = p => { const f = guildFields(p); return f.consortiaId ? { consortiaId: f.consortiaId, consortiaName: f.consortiaName } : {}; };

function heroInfo(p) {
  const s = p.s, { base, total } = p.stats();
  const o = clone(REF[150].simpleHeroInfo);
  // talent tree (features/talent.js): client resets talentSkill/talentPoint to empty/0 when these fields are
  // missing on ArmyMsg — so every sendArmy must carry the active page (and the three seals).
  // Lazily seed the same default as talent.js state() so a mid-session ArmyMsg never wipes the tree.
  if (s.grades >= 50 && (!s.talent || !s.talent.pages || !s.talent.pages.length)) {
    s.talent = { grade: 0, index: 0, second: false, pages: [{ skills: [910001, 920001, 930001], spent: 0 }], seals: [1001, 1002, 1003], branch: 1002 };
  }
  const tal = s.talent, tpg = tal && tal.pages && tal.pages[tal.index || 0];
  Object.assign(o, {
    heroId: p.heroId, nickName: s.nickName, tempateId: s.icon, playerId: s.id,
    skillScript: s.skills.join(',') + ',', fastKey: s.fastKey.join(',') + ',',
    hp: total.live, skillPoint: p.skillPointsLeft(),
    extraSkillPoint: s.extraSkillPoint || 0,   // Santo Graal uses (features/hero.js); client skillCate.extraSkillPoint
    skillIndex: (s.skillPages && s.skillPages.index) || 0, isActiveSecond: !!(s.skillPages && s.skillPages.second),   // features/hero.js skill sets
    talentPoint: tal && tpg ? Math.max(0, (tal.grade || 0) - (tpg.spent || 0)) : 0,
    talentGrade: (tal && tal.grade) || 0,
    talentSkill: tpg ? (tpg.skills || []).join(',') : (s.grades >= 50 ? '910001,920001,930001' : ''),
    rune: RUNE.info(p),
  });
  const put = (pre, v) => {
    o[pre + 'Power'] = v.power; o[pre + 'Agility'] = v.agility; o[pre + 'Intellect'] = v.intellect;
    o[pre + 'Captain'] = v.captain; o[pre + 'Physique'] = v.physique; o[pre + 'PhyAttack'] = v.phyAttack;
    o[pre + 'PhyDefence'] = v.phyDefence; o[pre + 'MagicAttack'] = v.magicAttack; o[pre + 'MagicDefence'] = v.magicDefence;
    o[pre + 'ForceHit'] = v.forceHit; o[pre + 'Parry'] = v.parry; o[pre + 'ConatArmy'] = v.conat; o[pre + 'Live'] = v.live;
  };
  put('base', base); put('total', total);
  return o;
}

// riding mount shown on the army (features/mount.js: s.mount {tid, riding, grade})
// how others see the player on maps / in town (2026-10-23 capture 140 / 4595 / 169): head picture, VIP, frame, honour,
// plus what features register with addShow (fate skills, the following guard)
const SHOW = [];
const addShow = fn => SHOW.push(fn);
const showFields = p => Object.assign({ headId: (p.s.sns && p.s.sns.headId) || 0, isVip: (p.s.vip || 0) > 0, frameId: p.s.frameId || 0, geste: p.s.geste || 0 }, ...SHOW.map(f => { try { return f(p) || {}; } catch (e) { return {}; } }));
const mountFields = p => { const m = p.s.mount; return m && m.riding ? { mountTempId: m.tid, mountGrade: m.grade || 1 } : { mountTempId: 0, mountGrade: 0 }; };

function equipAvatar(p) {
  const w = p.s.equip[0] && D.items.get(p.s.equip[0].templateId);
  const c = p.s.equip[2] && D.items.get(p.s.equip[2].templateId);
  const o = { arm: (w && w.Avata) || '', cloth: (c && c.Avata) || '' };
  // wardrobe (features/fashion.js C_FASHION_EXCHANGE): status "hat,cloth,arm,wing", 0 = hidden
  const f = p.s.fashion;
  if (f) {
    const st = String(f.status || '1,1,1,1').split(','), av = (tid, i) => (tid && st[i] !== '0' && (D.items.get(tid) || {}).Avata) || '';
    const hat = av(f.hat, 0), cloth = av(f.cloth, 1), arm = av(f.arm, 2), wing = av(f.wing, 3);
    if (hat) o.hat = hat; if (cloth) o.fashionCloth = cloth; if (arm) o.fashionArm = arm; if (wing) o.wing = wing;
  }
  return o;
}

function armyMsg(p, state = 0) {
  const s = p.s, o = clone(REF[150]);
  Object.assign(o, {
    armyId: p.armyId, playerId: s.id, nickName: s.nickName, mapId: s.castle.mapId, curPosX: s.castle.posX, curPosY: s.castle.posY, state,
    armyPawn: armyPawns(p),
    simpleHeroInfo: heroInfo(p), fightingCapacity: p.fightingCapacity(), grades: s.grades,
  }, equipAvatar(p), guildCard(p), mountFields(p), { appellid: (s.appell && s.appell.cur) || 0 }, showFields(p));   // worn title + pet/guard on map (features/appell.js, pets.js, guards.js)
  return o;
}

// army as seen on a map (MapUpdatedMsg.army)
// PlayerMsg.newNoviceProcess (field 136) is a string: the finished guide nodes "10_20_50_.." (2026-10-23 capture:
// "290_270_150_.."); the client checks it with indexOf, and the castle opens once node 150 is in it (client
// checkEnterCastle). A finished tutorial without a recorded list gets the main nodes up to 150.
const CASTLE_NODES = [10, 20, 50, 70, 90, 110, 140, 150];
function noviceNodes(s) {
  const l = (s.noviceNodes || []).slice();
  if (s.tutorialDone) for (const n of CASTLE_NODES) if (!l.includes(n)) l.push(n);
  return l.join('_');
}

function mapArmy(p, state = 0, x, y) {
  const s = p.s, o = clone(REF[140].army);
  Object.assign(o, {
    armyId: p.armyId, playerId: s.id, nickName: s.nickName, mapId: s.castle.mapId, state,
    fightingCapacity: p.fightingCapacity(), grades: s.grades, job: s.job, heroTempId: s.icon,
  }, equipAvatar(p), guildCard(p), mountFields(p), { appellid: (s.appell && s.appell.cur) || 0 }, showFields(p));   // worn title (features/appell.js)
  if (x !== undefined) { o.curPosX = x; o.curPosY = y; }
  return o;
}

function itemMsg(p, it) {
  const o = clone(REF[115].moved[0].item);
  Object.assign(o, {
    id: it.id, templateId: it.templateId, pos: it.pos, exist: true,
    // worn by the hero (bag 4): objectId = the hero, as the official server sends it (2026-10-23 capture); the
    // client puts an item into the hero's slots by it. Pet equipment (bag 28) carries its pet.
    objectId: (it.bagType ?? 1) === 4 ? p.heroId : (it.objectId || 0),
    bagType: it.bagType ?? 1, count: it.count, userId: p.id, isNew: !!it.isNew, randomSkill_1: 0,
    bind: !!it.bind, strengthenGrade: it.strengthenGrade || 0, gp: it.gp || 0, mouldGrade: it.mouldGrade || 0, blessValue: it.blessValue || 0, medalLv: it.medalLv || 0,   // gp: rune gem level progress (features/runegem.js)
  }, E.fields(it), PE.fields(it));   // PE: pet equipment masterAttr / sonAttr / suitId (petequip.js)
  if (it.validDate) { o.validDate = it.validDate; o.beginDate = it.beginDate; }   // time-limited (features/medal.js)
  return o;
}
// changeType = bag type (client hr.*): 0 forge slot (Hide), 1 bag, 4 hero equipment (changeObjId = heroId)
function movedEntry(p, it, removed = false) {
  const bt = it.bagType ?? 1, hero = bt === 4;
  const e = { changeType: bt, changeObjId: hero ? p.heroId : (it.objectId || 0), changePos: it.pos };   // pet equipment bag 28: objectId = pet
  if (!removed) e.item = itemMsg(p, it);
  return e;
}

function questUpdate(p, ids) {
  const quest = [];
  for (const id of ids) {
    const q = p.s.quests.active[id]; if (!q) continue;
    quest.push({
      templateId: id, isComplete: !!q.complete, condition_1: q.c[0] || 0, condition_2: q.c[1] || 0,
      condition_3: q.c[2] || 0, condition_4: q.c[3] || 0, completedDate: '2000-01-01 00:00:00',
      repeatFinish: 1, isAccept: true, isSelect: true, addDate: q.addDate,
    });
  }
  return { quest, statesLength: SITE_LEN, states: questSite(p) };
}

function castleMsg(p) {
  return Object.assign(clone(REF[4153]), {
    id: p.castleId, mapId: p.s.castle.mapId, posX: p.s.castle.posX, posY: p.s.castle.posY,
    occupyPlayerId: p.id, occupyPlayerName: p.s.nickName, grade: p.s.grades, vipGrade: p.s.vip || 0,
  });
}

// technology effects (academy buildings): building Property1 -> t_s_effecttemplate, value = grade x Property1,
// PropertyType1 says what it raises (capture: 104 gold per hour, +200 per grade of "Ouro Üretimi")
const EFFECTS = new Map(require('../templates').table('t_s_effecttemplate').map(e => [e.TemplateId, e]));
function techBonus(p, type) {
  let n = 0;
  for (const b of p.s.buildings) {
    const t = D.buildings.get(b.templateId), e = t && EFFECTS.get(t.Property1);
    if (e && e.PropertyType1 === type) n += (b.grade || 0) * (e.Property1 || 0);
  }
  return n;
}
// gold per hour: council (901) Property1 + gold technologies; population: houses (1201) Property2 + its
// technologies (type 105); gold cap: warehouse (301) Property2, 10000 before it is built
// (capture: 10000 -> 1250000 at Depo Lv1 ...)
function goldYield(p) {
  const council = p.s.buildings.find(x => x.sonType === 901), ct = council && D.buildings.get(council.templateId);
  // guild skill "Ouro Kazancı": +2 % per level (t_s_consortialevel type 11)
  const guildGold = ((p.s.guild && p.s.guild.skills) || {})[11] || 0;
  return Math.floor((((ct && ct.Property1) || 500) + techBonus(p, 104)) * (1 + 0.02 * guildGold));
}
function goldMax(p) {
  const depot = p.s.buildings.find(x => x.sonType === 301), dt = depot && D.buildings.get(depot.templateId);
  return (dt && dt.Property2) || 10000;
}
function castleYield(p) {
  const house = p.s.buildings.filter(x => x.sonType === 1201).reduce((n, x) => n + ((D.buildings.get(x.templateId) || {}).Property2 || 0), 0);
  return Object.assign(clone(REF[109]), {
    goldMax: goldMax(p),
    goldTotalCount: Math.floor(p.s.gold), crystalsCount: p.s.crystals, goldYield: goldYield(p),
    curPopulation: p.population(), maxPopulation: house + techBonus(p, 105),
  });
}

// ---- troops ---------------------------------------------------------------------------------------
// ArmyPawn.pawnLive: [attack, defence, magicAttack, magicDefence, live, forceHit, -]
// academy troop techs (PropertyType1 120..124 / 220..224) add flat values on top of the template
const TROOP_TECH = [
  [121, 221], // attack
  [122, 222], // defence
  [123, 223], // magic attack
  [124, 224], // magic defence
  [120, 220], // live
  [],         // forceHit (no academy tech)
  [],
];
function pawnLive(tid, join, p) {
  const t = D.pawns.get(tid) || {}, b = D.pawns.get(join) || null;
  return [t.Attack, t.Defence, t.MagicAttack, t.MagicDefence, t.Live, t.ForceHit, 0].map((v, i) => {
    let tech = 0;
    if (p) for (const type of TROOP_TECH[i] || []) tech += techBonus(p, type);
    const o = {}; if (v || tech) o.tempData = (v || 0) + tech;
    if (b) { const w = [b.Attack, b.Defence, b.MagicAttack, b.MagicDefence, b.Live, b.ForceHit, 0][i]; if (w) o.base_Join = w; }
    return o;
  });
}
const pawnSon = tid => (D.pawns.get(tid) || {}).SonType || 0;
// troops carried by the hero's army (ArmyMsg.armyPawn): the chosen pawn type, count = in army
function armyPawns(p) {
  const a = p.s.army; if (!a || !a.tempId) return [];
  const base = Number(String(a.tempId).slice(0, -2) + '01');
  const r = Object.values(p.s.pawns || {}).find(x => x.tempId === a.tempId), sp = reservePawn(p, null, r);
  return [{ pawnLive: pawnLive(a.tempId, base, p), armyId: p.armyId, sonType: pawnSon(a.tempId), tempateId: a.tempId, ownPawns: a.count || 0, fightPos: 3,
    specialTempIds: sp.specialTempIds, comprehednTempIds: sp.comprehednTempIds, blessNum: sp.blessNum }];
}
// castle reserve (ArmyPawnUpdatedMsg.armyPawn): every unlocked pawn type, count = in reserve
function reservePawn(p, son, rec) {
  const r = rec || p.s.pawns[son] || { tempId: p.s.army && p.s.army.tempId };
  // special ability (features/pawnspecial.js): saved one (else the template default), candidate, bless
  const def = Number((D.pawns.get(r.tempId) || {}).DefaultSpecialTemps) || 0, sp = r.special || def;
  return { pawnLive: pawnLive(r.tempId, null, p), sonType: Number(son), tempateId: r.tempId, ownPawns: r.count || 0, fightPos: 3,
    specialTempIds: sp ? String(sp) : '', comprehednTempIds: r.comprehend ? String(r.comprehend) : '', blessNum: r.bless || 0 };
}
function reservePawns(p, sons) { return { armyPawn: (sons || Object.keys(p.s.pawns)).map(s => reservePawn(p, s)) }; }

function buildingList(p) {
  return {
    result: true,
    building: p.s.buildings.map(b => ({ userId: p.id, buildingId: b.id, templateId: b.templateId, sonType: b.sonType, propterty1: b.p1 || 0, propterty2: b.p2 || 0, levyNum: b.levyNum || 0 })),
  };
}

module.exports = { guildFields, goldYield, goldMax, techBonus, REF, clone, pawnLive, armyPawns, reservePawn, reservePawns, SITE_LEN, playerMsg, heroInfo, armyMsg, mapArmy, itemMsg, movedEntry, questUpdate, castleMsg, castleYield, buildingList, ZERO_STATES, addShow, showFields };
