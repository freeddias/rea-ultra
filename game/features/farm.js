// Farm ("Ev"/çiftlik) and the holy tree. Replaces the recorded copies (they sent the official character's
// lands, bag rows and gold). Rules from the capture (CH_FARM_OPER_CHECK opTypes, CH_TREE_WATER,
// U_C_TREE_PICK) and t_s_config:
//  lands: 3 at land grade 1 (capture). opType 0 view (own or a friend's), 1 plant (seed SonType 216 from
//   bagPos: Property1 minutes, Property2 reward currency, Property3 base reward), 3 clear a pest/weed,
//   4 harvest, 7 accelerate (Farm_Accelerate_Point 15, bound diamonds first; capture: 27 of 60 minutes
//   taken off = 45 % of the growth time).
//  reward: full = base x (1 + FarmCrop_Gains_Percent 3 %) (capture: 3000 -> 3090 harvested); a fresh crop
//   has a weed and a pest (capture: both flags on every planting), each -10 % of base until cleared
//   (capture: 2490 at planting, 2790 and 3090 after the two clearings).
//  tree: everyone's watering adds to its count; 5 waters grow a fruit (capture: fruitCount 1 at waterCount 5);
//   the owner picks it once a day (next pick at midnight, capture) for 5,000 gold x farm level; own tree every
//   10 minutes (capture leftTime 599): gold 20 x farm level (capture +20 at Lv1, +40 at Lv2); a friend's
//   tree once a day: gold 30 x farm level (capture +60 at Lv2), "Amizade +1".
//  farm EXP: +1 per watering, clearing (FarmCrop_Operate_GP 1) and pick; a level per 5 EXP (capture: Lv2
//   after the 5th point, "Sua fazenda 2 evoluiu para o nível"; the real curve is not in the data).
//  opens with the "Ev" guide system at character Lv12 (t_s_system_introduce).
const OPEN_LEVEL = 12, LANDS_DEFAULT = 3, LANDS_MAX = 12, LAND_GRADE_MAX = 10;
const NEVER = '2000-01-01 00:00:00';
const TREE_COOLDOWN = 600, FRUIT_AT = 5;
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nextMidnight = () => { const d = new Date(); d.setHours(24, 0, 0, 0); return d.getTime(); };

module.exports = (ctx) => {
  const { D, dec, sendT, sendItems, sendCastle, sendPlayer, grant, pay, alert, chat, rewardName, playerById, online, sysTime, CONF, M, table } = ctx;
  const GAIN = (CONF.get('FarmCrop_Gains_Percent') || 3) / 100, ACCEL = CONF.get('Farm_Accelerate_Point') || 15;
  const fmt = t => t ? sysTime(new Date(t)) : NEVER;
  // t_s_upgradetemplate Types 17 (client UPGRADE_TYPE_FARM): Data = EXP to reach that grade
  const FARM_UP = table('t_s_upgradetemplate').filter(r => r.Types === 17).sort((a, b) => a.Grades - b.Grades);
  const MAX_FARM = FARM_UP.length ? Math.max(...FARM_UP.map(r => r.Grades)) : 80;
  const gpForLevel = target => {
    let gp = 0;
    for (const row of FARM_UP) {
      if (row.Grades <= 1) continue;
      if (row.Grades > target) break;
      gp += row.Data || 0;
    }
    return gp;
  };

  function farm(p) {
    const f = p.s.farm = p.s.farm || { gp: 0, landGrades: 1, lands: Array.from({ length: LANDS_DEFAULT }, () => null), tree: { water: 0, fruit: 0, ownWater: 0, nextPick: 0 }, friendWater: {} };
    if (f.landGrades == null) f.landGrades = 1;
    if (!Array.isArray(f.lands) || !f.lands.length) f.lands = Array.from({ length: LANDS_DEFAULT }, () => null);
    if (f.friendWater.day !== dayKey()) f.friendWater = { day: dayKey() };
    return f;
  }
  const level = f => {
    let lv = 1, left = f.gp || 0;
    for (const row of FARM_UP) {
      if (row.Grades <= 1) continue;
      const need = row.Data || 0;
      if (left < need) break;
      left -= need;
      lv = row.Grades;
    }
    return Math.min(lv, MAX_FARM);
  };
  function addGp(c, f, n = 1) {
    const before = level(f); f.gp += n;
    if (level(f) > before) alert(c, `Sua fazenda ${level(f)} evoluiu para o nível`);
  }
  function landMsg(owner, i, extra = {}) {
    const l = farm(owner).lands[i], m = { userId: owner.id, stolenUsers: [], plantingTime: NEVER, matureTime: NEVER, originMatureTime: NEVER };
    if (i) m.pos = i;
    if (l) Object.assign(m, { itemTemplateId: l.tid, plantingTime: fmt(l.plant), matureTime: fmt(l.mature), originMatureTime: fmt(l.origin), rewardCount: l.reward,
      ...(l.accel ? { accelerateCount: l.accel } : {}), ...(l.worm ? { isWormParam1: true } : {}), ...(l.grass ? { isGrassParam1: true } : {}) });
    return Object.assign(m, extra);
  }
  function treeMsg(owner) {
    const f = farm(owner), t = f.tree, now = Date.now();
    const m = { userId: owner.id, nickName: owner.s.nickName, nextPickTime: fmt(t.nextPick || owner.s.created), canWater: true };
    if (t.water) m.waterCount = t.water;
    if (t.fruit) m.fruitCount = t.fruit;
    const left = Math.ceil((t.ownWater + TREE_COOLDOWN * 1000 - now) / 1000);
    if (left > 0) m.leftTime = left;
    if (t.nextPick > now) m.leftPickTime = Math.ceil((t.nextPick - now) / 1000);
    return m;
  }
  const farmInfo = owner => { const f = farm(owner); return { farmLandInfo: f.lands.map((_, i) => landMsg(owner, i)), petInfo: [], userId: owner.id, nickName: owner.s.nickName,
    grades: level(f), landGrades: f.landGrades || 1, gp: f.gp, treeInfo: treeMsg(owner) }; };
  const landUpdate = (c, owner, i, op) => sendT(c, 4387, 'farm.FarmInfoRspMsg', { farmLandInfo: [landMsg(owner, i, { opType: op })], petInfo: [] });
  function water(t) { t.water++; if (t.water >= FRUIT_AT && !t.fruit && Date.now() >= (t.nextPick || 0)) t.fruit = 1; }
  const isFriend = (p, id) => ((p.s.relations || {})[id] || {}).relation === 1;
  const open = c => { if (c.player.s.grades >= OPEN_LEVEL) return true; alert(c, `Karakter Lv. ${OPEN_LEVEL} necessário`); return false; };

  // GM / admin: fazenda no teto (nível, terreno e todos os lotes)
  ctx.gmMaxFarm = c => {
    const f = farm(c.player);
    f.gp = gpForLevel(MAX_FARM);
    f.landGrades = LAND_GRADE_MAX;
    while (f.lands.length < LANDS_MAX) f.lands.push(null);
    c.player.save();
    sendT(c, 4386, 'farm.FarmInfoRspMsg', farmInfo(c.player));
    sendT(c, 4157, 'farm.LoadFarmRsp', { friendFarmState: [], farmLog: [], farm: farmInfo(c.player) });
    return `Fazenda Nv.${level(f)}, terreno Nv.${f.landGrades}, ${f.lands.length} lotes`;
  };

  // login: the farm loading step (4157 U_C_LOAD_WATER; the recorded one was the official character's farm)
  ctx.onLoad.push(c => sendT(c, 4157, 'farm.LoadFarmRsp', { friendFarmState: [], farmLog: [], farm: farmInfo(c.player) }));

  return {
    CH_FARM_OPER_CHECK(c, body) {
      const m = dec(c, 'CH_FARM_OPER_CHECK', body), p = c.player;
      const owner = !m.friendId || m.friendId === p.id ? p : playerById(m.friendId);
      if (!owner) { alert(c, 'Jogador não encontrado'); return; }
      const f = farm(owner), i = m.pos || 0, l = f.lands[i];
      if (!m.opType) return sendT(c, 4386, 'farm.FarmInfoRspMsg', farmInfo(owner));
      if (!open(c)) return;
      const mine = owner === p;
      if (m.opType === 1) {   // plant
        if (!mine || l || i < 0 || i >= f.lands.length) { alert(c, 'Este tarlaya ekilemez'); return; }
        const seed = p.itemAt(m.bagPos, 1), st = seed && D.items.get(seed.templateId);
        if (!st || st.SonType !== 216) { alert(c, 'Selecione uma semente'); return; }
        if (st.NeedGrades && p.s.grades < st.NeedGrades) { alert(c, `Karakter Lv. ${st.NeedGrades} necessário`); return; }
        const now = Date.now(), grow = (st.Property1 || 60) * 60000, full = Math.round((st.Property3 || 0) * (1 + GAIN));
        f.lands[i] = { tid: st.TemplateId, plant: now, mature: now + grow, origin: now + grow, reward: full - Math.round(0.2 * (st.Property3 || 0)), full, base: st.Property3 || 0, cur: st.Property2, worm: true, grass: true, accel: 0 };
        p.removeItem(seed, 1);
        p.save();
        sendItems(c, [M.movedEntry(p, seed, seed.count <= 0)]);
        landUpdate(c, p, i, 1);
        ctx.stat(c, 'farmPlant');
        return;
      }
      if (m.opType === 2 || m.opType === 3) {   // 2 WORM / 3 WEED (own land or a friend's: helping)
        const wantWorm = m.opType === 2;
        if (!l || (wantWorm ? !l.worm : !l.grass)) { alert(c, 'Nada para limpar'); return; }
        if (!mine && !isFriend(p, owner.id)) { alert(c, 'Você só pode ajudar seus amigos'); return; }
        if (wantWorm) l.worm = false; else l.grass = false;
        l.reward = Math.min(l.full, l.reward + Math.round(0.1 * l.base));
        addGp(c, farm(p));
        owner.save(); p.save();
        sendT(c, 4386, 'farm.FarmInfoRspMsg', farmInfo(owner));
        landUpdate(c, owner, i, m.opType);
        if (!mine) ctx.stat(c, 'farmHelp');
        return;
      }
      if (m.opType === 4) {   // harvest
        if (!mine || !l) { alert(c, 'Nenhuma colheita disponível'); return; }
        if (Date.now() < l.mature) { alert(c, 'A produção ainda não amadureceu'); return; }
        if (!grant(c, [[l.cur, l.reward]], { quiet: true })) { alert(c, 'Mochila cheia'); return; }
        const text = `Obtido:${rewardName(l.cur)} x${l.reward}`;
        f.lands[i] = null;
        p.save();
        sendCastle(c);
        alert(c, text);
        sendT(c, 4387, 'farm.FarmInfoRspMsg', { farmLandInfo: [landMsg(p, i, { opType: 4, rewardCount: l.reward })], petInfo: [] });
        chat(c, text);
        ctx.stat(c, 'farmHarvest');
        return;
      }
      if (m.opType === 7) {   // accelerate
        if (!mine || !l || Date.now() >= l.mature) { alert(c, 'Nenhuma produção para acelerar'); return; }
        if (!(pay(c, [[-500, ACCEL]]) || pay(c, [[-400, ACCEL]]))) { alert(c, 'Diamantes insuficientes'); return; }
        l.mature = Math.max(Date.now(), l.mature - Math.round(0.45 * (l.origin - l.plant)));
        l.accel = (l.accel || 0) + 1;
        p.save();
        sendPlayer(c);
        landUpdate(c, p, i, 7);
        return;
      }
      if (m.opType === 8) {   // CLEAR — arrancar plantação morta / limpar o lote
        if (!mine || !l) { alert(c, 'Nada para arrancar'); return; }
        f.lands[i] = null;
        p.save();
        sendT(c, 4386, 'farm.FarmInfoRspMsg', farmInfo(p));
        landUpdate(c, p, i, 8);
        return;
      }
      alert(c, 'Esta ação da fazenda ainda não existe');
    },
    C_REQ_FRIEND_FARM_STATE(c, body) {
      const m = dec(c, 'C_REQ_FRIEND_FARM_STATE', body), p = c.player, now = Date.now();
      const state = (o, self) => {
        const f = farm(o), s = { userId: o.id };
        if (f.lands.some(l => l && now >= l.mature) && self) s.isReap = true;
        if (self ? now >= f.tree.ownWater + TREE_COOLDOWN * 1000 : !farm(p).friendWater[o.id]) s.isChargeEnergy = true;
        if (f.lands.some(l => l && l.grass)) s.isGrass = true;
        if (f.lands.some(l => l && l.worm)) s.isWorm = true;
        return s;
      };
      const list = [state(p, true), ...(m.friendId || []).map(id => playerById(id)).filter(Boolean).map(o => state(o, false))];
      sendT(c, 4190, 'farm.LoadFarmRsp', { friendFarmState: list, farmLog: [] });
    },
    C_TREE_FRIEND(c, body) {
      const m = dec(c, 'C_TREE_FRIEND', body);
      sendT(c, 4146, 'farm.FriendTreeRsp', { treeInfo: (m.friendId || []).map(id => playerById(id)).filter(Boolean).map(treeMsg) });
    },
    CH_TREE_WATER(c, body) {
      const m = dec(c, 'CH_TREE_WATER', body), p = c.player, mf = farm(p);
      if (!open(c)) return;
      const owner = !m.userId || m.userId === p.id ? p : playerById(m.userId);
      if (!owner) { alert(c, 'Jogador não encontrado'); return; }
      const lv = level(mf);
      let gold, msg;
      if (owner === p) {
        if (Date.now() < mf.tree.ownWater + TREE_COOLDOWN * 1000) { alert(c, 'A árvore ainda não pode ser regada'); return; }
        mf.tree.ownWater = Date.now();
        gold = 20 * lv; msg = [`Enerji + 1`, `Ouro + ${gold}`, 'Ev EXP +1'];
        ctx.stat(c, 'treeWater');   // carnival daily challenge 7 (features/carnival.js)
      } else {
        if (!isFriend(p, owner.id)) { alert(c, 'Você só pode regar árvores de amigos'); return; }
        if (mf.friendWater[owner.id]) { alert(c, 'Você já regou esta árvore hoje'); return; }
        mf.friendWater[owner.id] = true;
        gold = 30 * lv; msg = ['EXP da Fazenda +1', `Dficouruldu, Ouro +${gold}`, 'Amizade +1'];
        sendT(c, 4158, 'farm.FarmLogRsp', { playerId: p.id, operUserId: owner.id });
        ctx.stat(c, 'treeWaterFriend');
      }
      water(farm(owner).tree);
      p.s.gold += gold;
      addGp(c, mf);
      p.save(); if (owner !== p) owner.save();
      sendCastle(c);
      sendT(c, 146, 'farm.TreeUpdateRsp', { tree: [], harvestMsg: msg, pickMsg: [] });
      chat(c, owner === p ? `Dficouruldu, Ouro + ${gold}, Enerji + 1, Ev EXP +1` : `Dficouruldu, Ouro +${gold}, EXP da Fazenda +1, Amizade +1`);
      sendT(c, 4386, 'farm.FarmInfoRspMsg', farmInfo(p));
      sendT(c, 147, 'farm.TreeUpdateRsp', { tree: owner === p ? [treeMsg(p)] : [treeMsg(owner), treeMsg(p)], harvestMsg: [], pickMsg: [] });
      const oc = owner !== p && online.get(owner.id);
      if (oc) sendT(oc, 147, 'farm.TreeUpdateRsp', { tree: [treeMsg(owner)], harvestMsg: [], pickMsg: [] });
    },
    U_C_TREE_PICK(c) {
      const p = c.player, f = farm(p), t = f.tree;
      if (!open(c)) return;
      if (!t.fruit) { alert(c, 'Toplanacak meyve não há'); return; }
      const gold = 5000 * level(f);
      p.s.gold += gold;
      t.fruit = 0; t.water = 0; t.nextPick = nextMidnight();
      addGp(c, f);
      p.save();
      sendCastle(c);
      alert(c, `Obtido:Ouro x${gold}`);
      sendT(c, 4189, 'farm.TreeUpdateRsp', { tree: [], harvestMsg: ['Ev EXP +1'], pickMsg: [] });
      sendT(c, 147, 'farm.TreeUpdateRsp', { tree: [treeMsg(p)], harvestMsg: [], pickMsg: [] });
      chat(c, `Obtido:Ouro x${gold}`);
    },
  };
};
