// Periler / evcil hayvanlar — first stage (client Fy PetData, PetCtrl; t_s_pettemplate; system 139 "Peri", Lv40).
// Client-derived, no capture of the system:
//  A pet comes from a seal (MasterType 4 PET_CARD, SonType 306, Property1 = pet template) used from the bag.
//  4540 U_C_PLAYER_PETINFO pet.PlayerPetMsg {op 0: upsert (isDel removes), petCount = carry limit, petInfo [...]}.
//  Stats, as the client computes them (PetData):
//   base stat (power / intel / physi / armor) = template Power / Intel / Physi / Armor + floor((grade-1) x growthRate/80);
//   the shown stat adds the points the player put in (5 per level, Fy.EACH_LEVEL_POINT);
//   physical attack = floor(1.8 x power x powerApti / 1000), magic attack likewise with intel;
//   physical defence = floor((0.9 armor x armorApti + 0.9 power x powerApti) / 1000), magic defence with intel;
//   hp = InitHp + floor(6 x physi x physiApti / 1000); fighting capacity = ceil(700 + the four + hp / 5).
//   Aptitude limits (PetData.calculateCoeLimit): the template PowerApt / IntelApt / PhysiApt / ArmorApt [min, max]
//   of the star's template row; growthRate = its GrowthRate. quality = star index (temQuality, (Quality-1)*5+1 to
//   start), initQuality = Quality.
//  Levels: the hero's level table (t_s_upgradetemplate 25); a pet never passes its master's level.
//  C_PLAYER_PET_OP (pet.PlayerPetOpMsg {petId, opType, ...}): 2 add points (attributes [power, intel, physi,
//  armor]), 3 reset points, 9 to war (one at a time), 10 rest, 14 rename, 6 release; the rest are later stages.
// Our choices: a new pet rolls each aptitude in the lower half of its [min, max] range (training is a later
// stage); the pet in war gets the hero's battle / quest EXP; resetting points is free; releasing returns nothing.
// Stage 3: 12 carry slot (3 to start, add_pet_count 100 / 100 / 300 diamonds for slots 4..6, Fy.PET_CARRY_LIMIT 6);
//  7 aptitude training with Sepulcrum 3040001 (client PET_COE_STONE / tipItem Sepulcrum; up to the star's
//  limit, PetData.calculateCoeLimit; Wartune Ultra: each stone grants several aptitude points, not just +1);
//  5 learn a skill from the pet-type library (client petSkill[PetType] / getPetRealitySkill) for its
//  Parameter3 Peri Beceri Kitabı 208061 (Ultra: no NeedPlayerGrade; at most Fy.CHANGE_SKILL_NUM = 6).
//  Template ChangeSkills are the starter set; Ultra also accepts any MasterType = PetType (or 107) skill
//  whose Parameter4 <= the pet's stage (Property2). FollowSkills are always on and cannot be "re-learned".
//  18 forget for pet_forget_skill (300) diamonds. In battle the pet form uses learned active skills.
const SEAL_SONTYPE = 306, POINTS_PER_LEVEL = 5, CARRY_BASE = 3;
const COE_STONE = 208023, APT_STONE = 3040001, SKILL_BOOK = 208061, MAX_SKILLS = 6;   // Mahra / Sepulcrum / skill book; Fy.CHANGE_SKILL_NUM
const SKILL_STAT_BONUS = 1500;   // Ultra: each learned skill adds this much flat ATQ to the Silfo
// Potential crystals (client kX.potencyActiveTempIdArr / sendPetPotencyActive opType 17): +5 potential each
const POTENCY_CRYSTALS = {
  208067: -1,   // generic — random among open slots
  208068: 0,    // prioritize ATQ
  208069: 1,    // prioritize ATQM
  208070: 2,    // prioritize DEF
  208071: 3,    // prioritize DEFM
};
const POTENCY_KEYS = ['AtkPotential', 'MatPotential', 'DefPotential', 'MdfPotential', 'HpPotential'];
const POTENCY_PER_CRYSTAL = 5;

const PE = require('../petequip');
module.exports = (ctx) => {
  const { D, table, dec, sendT, alert, log, pay, CONF } = ctx;
  const SLOT_PRICE = String(CONF.str('add_pet_count') || '100,100,300').split(',').map(Number);
  const FORGET_PRICE = Number(CONF.str('pet_forget_skill')) || 300;
  const carry = p => CARRY_BASE + ((p.s.pets || {}).slots || 0);
  // follow skills (UseWay 2) of the pet in war: t_s_skillpropertytemplate AddType 0 = % of hero stats
  // (e.g. 701101 Attack/MagicAttack 5 → +5% ATQ when the pet is set to war)
  const PROPS = new Map(table('t_s_skillpropertytemplate').map(r => [r.TemplateId, r]));
  const PCT_KEYS = { Attack: 'attack', MagicAttack: 'magicAttack', Defence: 'defence', MagicDefence: 'magicDefence', Live: 'live' };
  function linkPet(p) {
    const pct = {}, pet = list(p).find(x => x.id === (p.s.pets || {}).fight);
    if (pet) {
      const tp = TPL.get(pet.templateId);
      for (const id of [].concat((tp && tp.FollowSkills) || [])) {
        const sk = D.skills.get(id), pr = PROPS.get(id);
        if (!sk || sk.UseWay !== 2 || !pr) continue;
        for (const [k, key] of Object.entries(PCT_KEYS)) if (pr[k]) pct[key] = (pct[key] || 0) + pr[k];
      }
    }
    (p.s.addsPct = p.s.addsPct || {}).pet = pct;
  }
  ctx.linkPet = linkPet;
  // pet in war as others see it on the map (ArmyMsg / MapUpdatedMsg / Room: petTempId + petTemplateId)
  ctx.M.addShow(p => {
    const pet = list(p).find(x => x.id === (p.s.pets || {}).fight);
    if (!pet) return {};
    return { petTempId: pet.templateId, petTemplateId: pet.templateId, petQuqlity: pet.quality || 0, petName: pet.name || '' };
  });
  const syncMap = c => {
    if (ctx.sendArmy) ctx.sendArmy(c);
    sendT(c, 140, 'army.MapUpdatedMsg', { updatedType: 3, army: ctx.M.mapArmy(c.player, 0) });
  };
  // aptitude limit of a star (PetData.calculateCoeLimit: the star's row, +1/5 of the gap to the next row per star)
  function coeLimit(tp, temQuality, key) {
    const s = Math.floor((temQuality - 1) / 5 + 1), n = (temQuality % 5 === 0 ? 5 : temQuality % 5) - 1;
    const a = TPL.get(tp.TemplateId + s - tp.Quality), b = TPL.get(tp.TemplateId + s - tp.Quality + 1);
    if (!a) return 0; const lo = apt(a, key)[1]; if (!b) return lo;
    return lo + Math.floor((apt(b, key)[1] - lo) / 5) * n;
  }
  const APT_KEYS = ['PowerApt', 'IntelApt', 'PhysiApt', 'ArmorApt'];
  // growth of a star: GrowthRate of the star's row + 1/5 of the gap to the next row per star (calculateCoeLimit "lateCoeLimit")
  function growthOf(tp, temQuality) {
    const s = Math.floor((temQuality - 1) / 5 + 1), n = (temQuality % 5 === 0 ? 5 : temQuality % 5) - 1;
    const a = TPL.get(tp.TemplateId + s - tp.Quality), b = TPL.get(tp.TemplateId + s - tp.Quality + 1);
    if (!a) return tp.GrowthRate || 0; if (!b) return a.GrowthRate || 0;
    return a.GrowthRate + Math.floor((b.GrowthRate - a.GrowthRate) / 5) * n;
  }
  // star (quality) upgrade: Kutsal Ruh Taşı 1 point each (pet_up_quality diamonds for a missing one); the stage
  // (template Property2) picks the table: 1 -> upgrade 27, 2 -> 29, 3 -> 107, 4 -> 108 (Fy.QUALITY_UPGRADE_TYPE*);
  // the row of the next star (Grades = quality + 1) holds the points it needs; top star 21 / 31 / 36 (MAX_TEM_QUALITY*)
  const QTABLE = { 1: 27, 2: 29, 3: 107, 4: 108 }, QMAX = { 1: 21, 2: 21, 3: 31, 4: 36 };
  const UP = table('t_s_upgradetemplate');
  const nextStar = (tp, q) => UP.find(x => x.Types === QTABLE[tp.Property2 || 1] && x.Grades === q + 1);
  const STAR_PRICE = Number(CONF.str('pet_up_quality')) || 10;
  // promotion (t_s_petpromotion, client UIPromotion): Material = the pet's template -> Product; NeedType "type,value|...":
  // 1 template stage (Property2) >= value, 2 the top star of its stage (no next quality row), 3 every aptitude at
  // its limit; costs NeedGold, NeedItem "id,n|...", NeedDiamond. Our choice: the promoted pet starts at the first
  // star of the product's Quality and keeps level, points, aptitudes and skills.
  const PROMO = table('t_s_petpromotion');
  // two skill pages (client PetSkillView): 19 opens the second for pet_skillpoint (300) diamonds, bound first
  // (payType 0); 20 switches (value = page). pet.skills is the page in use, pet.otherSkills the other one.
  const SECOND_PRICE = Number(CONF.str('pet_skillpoint')) || 300;
  // 16 resolve (client PetSaveSureWnd): per pet calcResolveCornea = added aptitudes + 2 and calcResolveSoulStone =
  // ceil((totalQualityGp + Data of every upgrade 27 row with Grades <= initQuality) / 12). Our choice of items:
  // "cornea" = Peri İncisi 3040001 (the aptitude stone), "soul stone" = Kutsal Ruh Taşı 208023 (the star stone).
  const CORNEA = 3040001;
  const soulStones = (tp, pet) => Math.ceil(((pet.qgpTotal || 0) + UP.filter(x => x.Types === 27 && x.Grades <= tp.Quality).reduce((n, x) => n + (x.Data || 0), 0)) / 12);
  const TPL = new Map(table('t_s_pettemplate').map(r => [r.TemplateId, r]));
  const apt = (row, key) => (Array.isArray(row[key]) ? row[key] : [0, 0]);
  // the template row of a star (PetData.calculateCoeLimit): stage = floor((temQuality - 1) / 5) + 1
  const rowOf = (tp, temQuality) => TPL.get(tp.TemplateId + Math.floor((temQuality - 1) / 5 + 1) - tp.Quality) || tp;
  const list = p => (p.s.pets = p.s.pets || { list: [], nextId: 1 }).list;

  // potential caps of the star's template row (client PetPotencyWnd.getMaxValue)
  function potencyLimit(tp, temQuality) {
    const row = rowOf(tp, temQuality);
    return POTENCY_KEYS.map(k => row[k] || 0);
  }
  function ensurePotency(pet) {
    if (!Array.isArray(pet.potency) || pet.potency.length !== 5) pet.potency = [0, 0, 0, 0, 0];
    return pet.potency;
  }
  // potential points → flat combat attrs (server-owned; client only displays *potentialAtr)
  function potencyAtr(pot) {
    const [atk, mat, def, mdf, hp] = pot || [0, 0, 0, 0, 0];
    return { atk, mat, def, mdf, hp };
  }
  function stats(p, pet) {
    const tp = TPL.get(pet.templateId), row = rowOf(tp, pet.quality);
    const growth = growthOf(tp, pet.quality) || row.GrowthRate || 0, g = pet.grade - 1;
    const base = k => (tp[k] || 0) + Math.floor(g * growth / 80);
    // worn pet equipment (game/petequip.js): attribute 1 Güç, 2 Zırh, 3 Zeka, 4 Beden into the base stats, 6..10 flat (bag*)
    const eq = PE.petAdds(p, pet.id), e = k => eq[k] || 0;
    const pc = (v, k) => v + Math.floor(v * e(k) / 10000);   // EX entries: 1001..1004 percent of the base stat (our choice), 1006..1010 below
    const power = pc(base('Power') + pet.points[0] + e(1), 1001), intel = pc(base('Intel') + pet.points[1] + e(3), 1003), physi = pc(base('Physi') + pet.points[2] + e(4), 1004), armor = pc(base('Armor') + pet.points[3] + e(2), 1002);
    const [pa, ia, ha, aa] = pet.apti;
    const patk = Math.floor(1.8 * power * pa / 1000), matk = Math.floor(1.8 * intel * ia / 1000);
    const pdef = Math.floor((0.9 * armor * aa + 0.9 * power * pa) / 1000), mdef = Math.floor((0.9 * armor * aa + 0.9 * intel * ia) / 1000);
    const hp = (tp.InitHp || 0) + Math.floor(6 * physi * ha / 1000);
    const bag = { attack: e(6), defence: e(7), magicAttack: e(8), magicDefence: e(9), live: e(10) };
    const up = (k, v, id) => { bag[k] += Math.floor((v + bag[k]) * e(id) / 10000); };   // client calAttr: 1006 attack, 1007 magic attack, 1008 defence, 1009 magic defence, 1010 hp
    up('attack', patk, 1006); up('magicAttack', matk, 1007); up('defence', pdef, 1008); up('magicDefence', mdef, 1009); up('live', hp, 1010);
    // Ultra: each learned skill on the active page adds +1500 flat ATQ (bagAttack / combate / FC)
    bag.attack += (pet.skills || []).length * SKILL_STAT_BONUS;
    const pot = ensurePotency(pet), atr = potencyAtr(pot);
    // potential stays out of bag* (client shows *potentialAtr separately) but counts in fight/combat
    const resi = { fire: e(14), water: e(15), wind: e(16), elect: e(17), dark: e(18), light: e(19) };
    return { power, intel, physi, armor, patk, matk, pdef, mdef, hp, growth, bag, resi, pot, atr,
      fight: Math.ceil(700 + patk + matk + pdef + mdef + bag.attack + bag.magicAttack + bag.defence + bag.magicDefence
        + atr.atk + atr.mat + atr.def + atr.mdf + (hp + bag.live + atr.hp) / 5),
      remain: g * POINTS_PER_LEVEL - pet.points.reduce((a, b) => a + b, 0) };
  }
  ctx.petStats = stats;
  ctx.petSend = (c, pets) => send(c, pets);
  ctx.petList = list;
  ctx.petInfos = p => list(p).map(x => petMsg(p, x));   // another player's pets (viewother.js 4608)
  // the pet in war for a fight (logic.js startBattle -> battle.js morph): its combat stats and attack skill =
  // the first active skill of the template's ChangeSkills (the pet-form skill bar)
  ctx.petBattle = p => { const pet = list(p).find(x => x.id === (p.s.pets || {}).fight); return pet ? combat(p, pet) : null; };
  // any pet's combat values (also the pet arena, features/petarena.js; arena skills chaSkillIndexs go first)
  ctx.petCombat = (p, pet) => combat(p, pet);
  ctx.petTemplate = id => TPL.get(id);
  // battle bar slots: client maps changeSkillId → petSkills only when SonType is listed in fastKey
  function syncFastKey(pet) {
    const keys = (pet.skills || []).map(id => D.skills.get(id)).filter(s => s && s.UseWay === 1).map(s => s.SonType).filter(Boolean);
    const cur = String(pet.fastKey || '').split(',').map(Number).filter(n => n > 0);
    const out = [];
    for (const k of cur) if (keys.includes(k) && !out.includes(k)) out.push(k);
    for (const k of keys) if (!out.includes(k) && out.length < MAX_SKILLS) out.push(k);
    pet.fastKey = out.length ? out.join(',') + ',' : '';
    return pet.fastKey;
  }
  function combat(p, pet) {
    const tp = TPL.get(pet.templateId), st = stats(p, pet);
    const active = (pet.skills || []).map(id => D.skills.get(id)).filter(s => s && s.UseWay === 1).sort((x, y) => (y.Parameter1 || 0) - (x.Parameter1 || 0));
    const fallback = [].concat(tp.DefaultSkills || []).map(Number).filter(id => D.skills.has(id));
    const skills = active.length ? active.map(s => s.TemplateId) : (fallback.length ? fallback : [701000]);
    const skill = skills[0];
    syncFastKey(pet);
    return { id: pet.id, templateId: pet.templateId, name: pet.name, grade: pet.grade, quality: pet.quality, hp: st.hp + st.bag.live + st.atr.hp, skill, skills,
      stats: {
        attack: st.patk + st.bag.attack + st.atr.atk,
        magicAttack: st.matk + st.bag.magicAttack + st.atr.mat,
        defence: st.pdef + st.bag.defence + st.atr.def,
        magicDefence: st.mdef + st.bag.magicDefence + st.atr.mdf,
      },
      // HeroMsg.changeSkillId (int32[]): learned actives; string changeSkills is PetInfo only
      changeSkillId: skills.slice(),
      changeSkills: skills.join(','), followSkills: [].concat(tp.FollowSkills || []).join(','),
      fastKey: pet.fastKey || '',
      arenaSkills: String(pet.chaSkills || '').split(',').map(Number).filter(id => D.skills.has(id)) };
  }
  function petMsg(p, pet) {
    const tp = TPL.get(pet.templateId), st = stats(p, pet);
    syncFastKey(pet);
    return { petId: pet.id, templateId: pet.templateId, petName: pet.name, curGp: pet.gp, totalGp: pet.totalGp, curGrade: pet.grade,
      power: st.power, intel: st.intel, physi: st.physi, armor: st.armor, remainPoints: st.remain,
      powerApti: pet.apti[0], intelApti: pet.apti[1], physiApti: pet.apti[2], armorApti: pet.apti[3], addPowerApti: 0, addIntelApti: 0, addPhysiApti: 0, addArmorApti: 0,
      growthRate: st.growth, maxHp: st.hp, fightingCapacity: st.fight, quality: pet.quality, initQuality: tp.Quality, curQualityGp: pet.qgp || 0, totalQualityGp: pet.qgpTotal || 0,
      fireResi: (tp.FireResi || 0) + st.resi.fire, waterResi: (tp.WaterResi || 0) + st.resi.water, electResi: (tp.ElectResi || 0) + st.resi.elect,
      windResi: (tp.WindResi || 0) + st.resi.wind, darkResi: (tp.DarkResi || 0) + st.resi.dark, lightResi: (tp.LightResi || 0) + st.resi.light,
      bagAttack: st.bag.attack, bagDefence: st.bag.defence, bagMagicattack: st.bag.magicAttack, bagMagicdefence: st.bag.magicDefence, bagLiving: st.bag.live,
      atkpotential: st.pot[0], matpotential: st.pot[1], defpotential: st.pot[2], mdfpotential: st.pot[3], hppotential: st.pot[4],
      atkpotentialAtr: st.atr.atk, matpotentialAtr: st.atr.mat, defpotentialAtr: st.atr.def, mdfpotentialAtr: st.atr.mdf, hppotentialAtr: st.atr.hp,
      followSkills: [].concat(tp.FollowSkills || []).join(','), changeSkills: (pet.skills || []).join(','),
      isFight: p.s.pets.fight === pet.id, isBind: true, chaSkillIndexs: pet.chaSkills || '', remotePetSkillIndexs: pet.remoteSkills || '', isLocked: false, fastKey: pet.fastKey || '', isActiveSecond: !!pet.second, skillIndex: pet.page || 0,
      ...(ctx.petBene ? ctx.petBene(p, pet.id) : {}) };   // artifact blessings (features/petartifact.js)
  }
  const formation = p => ctx.petFormation ? ctx.petFormation(p) : {};   // the pet arena line-up: 4540 op 0 sets it on the client (features/petarena.js)
  const send = (c, pets, deleted = []) => sendT(c, 4540, 'pet.PlayerPetMsg', { op: 0, userId: c.player.id, petCount: carry(c.player), ...formation(c.player),
    petInfo: pets.map(x => petMsg(c.player, x)).concat(deleted.map(id => ({ petId: id, isDel: true }))) });
  ctx.onLogin.push(c => { linkPet(c.player); });   // before the first PlayerMsg / ArmyMsg
  ctx.onLoad.push(c => {
    linkPet(c.player);
    if (list(c.player).length) send(c, list(c.player));
    else sendT(c, 4540, 'pet.PlayerPetMsg', { op: 2, userId: c.player.id, petCount: carry(c.player), ...formation(c.player) });
  });

  // pet EXP book (Property1 15, Property2 = EXP each): goes to the pet in war, capped at the master's level
  // (client checkForUsePetExpBook → enterWarPet; data SonType 208 / client enum 308)
  function givePetExp(c, n) {
    const p = c.player, pet = list(p).find(x => x.id === (p.s.pets || {}).fight);
    if (!pet || n <= 0) return null;
    pet.gp += n; pet.totalGp += n;
    let up = 0;
    while (pet.grade < p.s.grades && pet.gp >= (D.petLevelExp.get(pet.grade + 1) || Infinity)) { pet.gp -= D.petLevelExp.get(pet.grade + 1); pet.grade++; up++; }
    if (pet.grade >= p.s.grades) pet.gp = Math.min(pet.gp, (D.petLevelExp.get(pet.grade + 1) || pet.gp));
    send(c, [pet]);
    if (up) { linkPet(p); log(`[#${c.id}] pet ${pet.name} -> Lv${pet.grade}`); }
    return pet;
  }
  ctx.givePetExp = givePetExp;
  // Property1 15 pet EXP books (logic.js useConsumable / bag use): apply to the pet in war
  ctx.usePetExpBook = (c, it, tp, n) => {
    const p = c.player, need = tp.NeedGrades || 0;
    if (need && p.s.grades < need) { alert(c, `Nível ${need} necessário`); return false; }
    if (!(p.s.pets || {}).fight) { alert(c, 'Coloque um silfo em batalha primeiro'); return false; }
    const pet = list(p).find(x => x.id === p.s.pets.fight);
    if (!pet) { alert(c, 'Coloque um silfo em batalha primeiro'); return false; }
    if (pet.grade >= p.s.grades && pet.gp >= (D.petLevelExp.get(pet.grade + 1) || pet.gp)) { alert(c, 'EXP do silfo cheio'); return false; }
    const cnt = Math.min(n || 1, it.count), exp = (tp.Property2 || 0) * cnt;
    if (!exp) return false;
    p.removeItem(it, cnt);
    ctx.sendItems(c, [ctx.M.movedEntry(p, it, it.count <= 0)]);
    givePetExp(c, exp);
    p.save();
    alert(c, `${pet.name}: +${exp.toLocaleString('en-US')} EXP`);
    return true;
  };

  // a seal from the bag -> a new pet
  ctx.useItem[SEAL_SONTYPE] = (c, it, itp) => {
    const p = c.player, tp = TPL.get(itp.Property1);
    if (!tp) { alert(c, 'Este selo não pode ser usado'); return; }
    if (list(p).length >= carry(p)) { alert(c, `Você pode carregar no máximo ${carry(p)} silfos (abra novos espaços)`); return; }
    const roll = key => { const [lo, hi] = apt(tp, key); return lo + Math.floor(Math.random() * (Math.max(0, hi - lo) / 2 + 1)); };
    const pet = { id: p.s.pets.nextId++, templateId: tp.TemplateId, name: ctx.nameOf(tp), grade: 1, gp: 0, totalGp: 0,
      quality: (tp.Quality - 1) * 5 + 1, points: [0, 0, 0, 0], skills: [], apti: ['PowerApt', 'IntelApt', 'PhysiApt', 'ArmorApt'].map(roll) };
    list(p).push(pet);
    // Ultra: first silfo goes to war and accompanies the character on the map
    const first = !p.s.pets.fight;
    if (first) { p.s.pets.fight = pet.id; linkPet(p); }
    p.removeItem(it, 1);
    ctx.sendItems(c, [ctx.M.movedEntry(p, it, it.count <= 0)]);
    p.save();
    send(c, first ? list(p) : [pet]);
    if (first) { ctx.sendPlayer(c); if (ctx.sendArmy) ctx.sendArmy(c); syncMap(c); }
    alert(c, `${pet.name} entrou para os silfos!`);
    log(`[#${c.id}] pet ${pet.name} (${tp.TemplateId}) apti ${pet.apti.join('/')}`);
  };

  // EXP: the pet in war follows its master, up to the master's level
  ctx.onExp.push((c, n) => { givePetExp(c, n); });

  return {
    C_PLAYER_PET_OP(c, body) {
      const m = dec(c, 'C_PLAYER_PET_OP', body), p = c.player, pet = list(p).find(x => x.id === m.petId);
      switch (m.opType) {
        case 2: {
          if (!pet) return;
          const add = (m.attributes || []).slice(0, 4).map(x => Math.max(0, x | 0));
          const total = add.reduce((a, b) => a + b, 0);
          if (!total || total > stats(p, pet).remain) { alert(c, 'Pontos insuficientes'); return send(c, [pet]); }
          add.forEach((v, i) => { pet.points[i] += v; });
          break;
        }
        case 3: if (!pet) return; pet.points = [0, 0, 0, 0]; break;
        case 9: {
          if (!pet) return;
          p.s.pets.fight = pet.id; linkPet(p); p.save();
          send(c, list(p)); ctx.sendPlayer(c); syncMap(c); return;
        }
        case 10: {
          if (!pet || p.s.pets.fight !== pet.id) return;
          p.s.pets.fight = 0; linkPet(p); p.save();
          send(c, list(p)); ctx.sendPlayer(c); syncMap(c); return;
        }
        case 14: {
          if (!pet) return;
          const name = String(m.petName || '').trim().slice(0, 12);
          if (!name) { alert(c, 'Nome inválido'); return; }
          pet.name = name; break;
        }
        case 6: {
          if (!pet) return;
          const wasFight = p.s.pets.fight === pet.id;
          if (wasFight) p.s.pets.fight = 0;
          p.s.pets.list = list(p).filter(x => x !== pet);
          if (ctx.petGone) ctx.petGone(c, pet.id);   // its artifacts back to the bag (features/petartifact.js)
          if (wasFight) linkPet(p);
          p.save();
          alert(c, `${pet.name} foi liberado`);
          send(c, [], [pet.id]);
          if (wasFight) { ctx.sendPlayer(c); syncMap(c); }
          return;
        }
        case 12: {   // one more carry slot: add_pet_count diamonds each (3 -> 6)
          const p0 = p.s.pets = p.s.pets || { list: [], nextId: 1 }, n = p0.slots || 0;
          if (n >= SLOT_PRICE.length) { alert(c, 'Todos os espaços estão abertos'); return; }
          if (!pay(c, [[m.payType === 0 && ctx.balance(p, -500) >= SLOT_PRICE[n] ? -500 : -400, SLOT_PRICE[n]]])) { alert(c, 'Diamantes insuficientes'); return; }
          p0.slots = n + 1; p.save();
          return sendT(c, 4540, 'pet.PlayerPetMsg', { op: 2, userId: p.id, petCount: carry(p) });
        }
        case 4: {   // star upgrade: value points (stones first, then diamonds for the missing ones)
          if (!pet) return;
          const tp = TPL.get(pet.templateId), max = QMAX[tp.Property2 || 1] || 21;
          if (pet.quality >= max || !nextStar(tp, pet.quality)) { alert(c, 'Já está na estrela máxima'); return; }
          const n = Math.max(1, Math.min(m.value || 1, 100)), have = Math.min(n, p.countTemplate(COE_STONE));
          const cost = []; if (have) cost.push([COE_STONE, have]);
          if (n > have) { const price = (n - have) * STAR_PRICE; cost.push([m.payType === 0 && ctx.balance(p, -500) >= price ? -500 : -400, price]); }
          if (!pay(c, cost)) { alert(c, 'Pedra de Espírito Sagrado/diamantes insuficientes'); return; }
          // Wartune Ultra / classic Mahra: ~8..15 quality GP per stone (client treats > OnceExp=1 as crit)
          let gain = 0; for (let k = 0; k < n; k++) gain += 8 + Math.floor(Math.random() * 8);
          pet.qgp = (pet.qgp || 0) + gain; pet.qgpTotal = (pet.qgpTotal || 0) + gain;
          let row;
          while (pet.quality < max && (row = nextStar(tp, pet.quality)) && pet.qgp >= row.Data) { pet.qgp -= row.Data; pet.quality++; }
          if (pet.quality >= max) pet.qgp = 0;
          break;
        }
        case 16: {
          const ids = new Set(m.petIds || []), gone = list(p).filter(x => ids.has(x.id));
          if (!gone.length) return;
          let cornea = 0, stones = 0;
          for (const x of gone) { cornea += 2; stones += soulStones(TPL.get(x.templateId), x); if (p.s.pets.fight === x.id) p.s.pets.fight = 0; }
          p.s.pets.list = list(p).filter(x => !ids.has(x.id));
          ctx.grant(c, [[CORNEA, cornea], [COE_STONE, stones]].filter(([, n]) => n > 0));
          p.save();
          return send(c, [], gone.map(x => x.id));
        }
        case 19: {
          if (!pet || pet.second) return;
          if (!pay(c, [[m.payType !== 1 && ctx.balance(p, -500) >= SECOND_PRICE ? -500 : -400, SECOND_PRICE]])) { alert(c, 'Diamantes insuficientes'); return; }
          pet.second = true; pet.otherSkills = pet.otherSkills || [];
          break;
        }
        case 20: {
          const to = m.value ? 1 : 0;
          if (!pet || (to === 1 && !pet.second) || (pet.page || 0) === to) return;
          [pet.skills, pet.otherSkills] = [pet.otherSkills || [], pet.skills || []]; pet.page = to;
          break;
        }
        case 21: {
          // Client getPetPromotion(PetType, Property2) = MaterialType + MaterialOrder.
          // Last form (位格 / "Poder Inferior"): MaterialOrder 3 → Product *407; Material id is the Q7 row
          // (e.g. 101307), NOT the pet's stored templateId after the prior promo (101305).
          if (!pet) return;
          const tp = TPL.get(pet.templateId);
          const row = PROMO.find(x => x.MaterialType === tp.PetType && x.MaterialOrder === (tp.Property2 || 1))
            || PROMO.find(x => x.Material === pet.templateId);
          const prod = row && TPL.get(row.Product);
          if (!row || !prod) { alert(c, 'Este silfo não pode evoluir'); return; }
          // Ultra: only stage (NeedType 1); star/aptitude gates removed from config + ignored here
          const ok = String(row.NeedType || '').split('|').filter(Boolean).every(x => {
            const [ty, v] = x.split(',').map(Number);
            return ty !== 1 || (tp.Property2 || 1) >= v;
          });
          if (!ok) { alert(c, 'Condições de evolução não atendidas'); return; }
          const cost = String(row.NeedItem || '').split('|').filter(Boolean).map(x => x.split(',').map(Number));
          if (row.NeedGold) cost.push([-100, row.NeedGold]);
          if (row.NeedDiamond) cost.push([m.payType === 2 && ctx.balance(p, -500) >= row.NeedDiamond ? -500 : -400, row.NeedDiamond]);
          if (!pay(c, cost)) { alert(c, 'Materiais insuficientes'); return; }
          pet.templateId = prod.TemplateId; pet.quality = (prod.Quality - 1) * 5 + 1; pet.qgp = 0;
          if (pet.name === ctx.nameOf(tp)) pet.name = ctx.nameOf(prod);
          alert(c, `${pet.name} evoluiu!`);
          break;
        }
        case 7: {   // aptitude training: value Sepulcrum 3040001 (client PET_COE_STONE), not Mahra
          if (!pet) return;
          const tp = TPL.get(pet.templateId), lim = APT_KEYS.map(k => coeLimit(tp, pet.quality, k));
          if (pet.apti.every((v, i) => v >= lim[i])) { alert(c, 'Aptidões no limite desta estrela'); return; }
          const n = Math.max(1, Math.min(m.value || 1, 100));
          if (!pay(c, [[APT_STONE, n]])) { alert(c, 'Sepulcrum de Silfo insuficiente'); return; }
          // each stone: +5..12 total aptitude points, spread across stats still below the star limit
          for (let k = 0; k < n; k++) {
            let left = 5 + Math.floor(Math.random() * 8);
            while (left > 0) {
              const open = pet.apti.map((v, i) => (v < lim[i] ? i : -1)).filter(i => i >= 0);
              if (!open.length) break;
              const i = open[Math.floor(Math.random() * open.length)];
              pet.apti[i]++; left--;
            }
          }
          break;
        }
        case 5: {   // learn a skill from the type library (ChangeSkills + same PetType / stage)
          if (!pet) return;
          const tp = TPL.get(pet.templateId), sk = D.skills.get(m.skillId);
          pet.skills = pet.skills || [];
          const change = [].concat(tp.ChangeSkills || []).map(Number);
          const follow = [].concat(tp.FollowSkills || []).map(Number);
          const sameType = sk && (sk.MasterType === tp.PetType || sk.MasterType === 107);
          const stageOk = sk && (sk.Parameter4 || 0) <= (tp.Property2 || 1);
          const learnable = sk && (sk.UseWay === 1 || sk.UseWay === 2) && (change.includes(sk.TemplateId) || (sameType && stageOk));
          if (follow.includes(m.skillId)) { alert(c, 'Esta habilidade de acompanhamento já está ativa'); return; }
          if (!learnable) { alert(c, 'Este silfo não pode aprender esta habilidade'); return; }
          if (pet.skills.includes(sk.TemplateId)) { alert(c, 'Esta habilidade já foi aprendida'); return; }
          if (pet.skills.some(id => (D.skills.get(id) || {}).SonType === sk.SonType)) { alert(c, 'Esta linha de habilidade já foi aprendida'); return; }
          if (pet.skills.length >= MAX_SKILLS) { alert(c, 'Espaços de habilidade cheios'); return; }
          // Ultra: no pet/player level gate on skill books (NeedPlayerGrade ignored)
          if (!pay(c, [[SKILL_BOOK, sk.Parameter3 || 1]])) { alert(c, 'Livro de habilidade de silfo insuficiente'); return; }
          pet.skills.push(sk.TemplateId);
          syncFastKey(pet);
          alert(c, `${pet.name} ${ctx.nameOf(sk)} aprendeu a habilidade`);
          break;
        }
        case 18: {   // forget a learned skill: pet_forget_skill bound diamonds first (payType 0)
          if (!pet || !(pet.skills || []).includes(m.skillId)) return;
          if (!pay(c, [[m.payType === 0 && ctx.balance(p, -500) >= FORGET_PRICE ? -500 : -400, FORGET_PRICE]])) { alert(c, 'Diamantes insuficientes'); return; }
          pet.skills = pet.skills.filter(id => id !== m.skillId);
          syncFastKey(pet);
          break;
        }
        case 17: {   // potential crystal (itemPos = templateId 208067..208071, value = count)
          if (!pet) return;
          const tid = m.itemPos | 0, prefer = POTENCY_CRYSTALS[tid];
          if (prefer === undefined) { alert(c, 'Cristal potencial inválido'); return; }
          const lim = potencyLimit(TPL.get(pet.templateId), pet.quality);
          const pot = ensurePotency(pet);
          if (pot.every((v, i) => v >= lim[i])) { alert(c, 'Potencial no limite desta estrela'); return; }
          const room = lim.reduce((n, max, i) => n + Math.max(0, max - pot[i]), 0);
          const n = Math.max(1, Math.min(m.value || 1, p.countTemplate(tid), Math.ceil(room / POTENCY_PER_CRYSTAL)));
          if (n <= 0 || !pay(c, [[tid, n]])) { alert(c, 'Cristal potencial insuficiente'); return; }
          for (let k = 0; k < n; k++) {
            let left = POTENCY_PER_CRYSTAL;
            const open = () => pot.map((v, i) => (v < lim[i] ? i : -1)).filter(i => i >= 0);
            // specialized crystal: fill priority slot first
            if (prefer >= 0 && pot[prefer] < lim[prefer]) {
              const take = Math.min(left, lim[prefer] - pot[prefer]);
              pot[prefer] += take; left -= take;
            }
            while (left > 0) {
              const slots = open();
              if (!slots.length) break;
              const i = slots[Math.floor(Math.random() * slots.length)];
              pot[i]++; left--;
            }
          }
          alert(c, `${pet.name}: potencial ativado (+${n * POTENCY_PER_CRYSTAL})`);
          break;
        }
        default: alert(c, 'Esta ação de silfo ainda não existe'); return;
      }
      p.save();
      send(c, [pet]);
    },
  };
};
