// Labirent: "Yeraltı Labirenti" (index 0, maps 8001-8100, one floor per map) and "Uçurum Labirenti"
// (index 1, maps 8101-8130, opens after Yeraltı floor 100) and "Cehennem Labirenti" (index 2, maps 8301-8330,
// opens after Uçurum floor 30). Cehennem from the 2026-10-23 live capture: C_ENTER_TOWER {campaignId 8301,
// isDouble 1} continues on map 8300 + floor, the floor bosses are Uçurum's (hero 81xx), the monster gives 12.5 x the
// Uçurum row's EXP (floor 22: 1,600,000 = 12.5 x 128,000; floor 23: 1,650,000), reports scene 10. No key, no double.
//  window (client MazeFrameWnd): C_TOWER_INFO {index} -> 4205 TowerInfoMsg; free entries shown as
//   maxEnterCount - enterCount, record = maxIndex, current floor = towerIndex, "Obtido: EXP" = totalGp.
//   Login: 4373 TowerListMsg with all three (it was a recorded empty copy).
//  entering: C_ENTER_TOWER {chooseIndex 1 start / 0 continue, campaignId, isDouble 2}. A start at floor 0
//   uses the day's entry (help text: once a day each); Yeraltı doubles everything with 1 Labirent Chaveı
//   (CT.MAZE_STONE 208008, MAZE_STONE_USE 1; the very first run is double for free — "firstOpenTipTxt");
//   Uçurum always takes 3 (MAZE2_STONE_USE). The floor map is base + towerIndex + 1.
//  floors: the CNTowerNodeAi monster; the CNTowerTransAi portal (MoveToNodeIds = next floor's spawn) works
//   only once it fell. Floor loot = t_s_dropcondition type 8106 (Yeraltı, Para1 = floor, 100 rows) /
//   8109 (Uçurum, 30 rows): EXP (-700) + from floor 10 on Labirent Parası and a gem.
//   (8106/8109 are the per-floor rows Kaynak Geri Al sums for a missed run — 1/5 of 8206/8209 — and the best
//   per-floor table there is; the older official capture had 400 x floor base EXP; the monster gives the row's
//   EXP, the floor's CNTowerBoxAi chest its items, a sweep both.)
//   Every 10th floor is announced (capture: "Tebrikler <a .../>, Yeraltı Labirenti’nin 70.katını geçti").
//  death: 4207 TowerDiedMsg {msg: revive cost}; C_TOWER_LIVE {payType 0: bound diamonds first, 1: diamonds}
//   pays Tower_Live (5) and 4175 sets the army alive again. Leaving dead (U_C_CAMPAIGN_ROOM_EXIT) gives up
//   the day's run (client text "Bugün tekrar labirente girilemez"); leaving alive keeps it for "Devam".
//   On leaving, 4419 shows what the run collected.
//  C_TOWER_RESET: back to floor 0, collected list and EXP counter cleared.
// Labirent Baskını: see the sweep part below. Not built: the ranking window, first-clear names.
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const MAZE_STONE = 208008;
const KINDS = [
  { index: 0, campaignId: 8001, base: 8000, floors: 100, drop: 8106, stones: 1, name: 'Catacumbas Esquecidas' },
  { index: 1, campaignId: 8101, base: 8100, floors: 30, drop: 8109, stones: 3, name: 'Necrópole Atormentada' },
  { index: 2, campaignId: 8301, base: 8300, floors: 30, drop: 8109, stones: 0, expMul: 12.5, name: 'Cripta do Purgatório' },
];
const kindOfMap = mapId => KINDS.find(k => mapId > k.base && mapId <= k.base + k.floors);

module.exports = (ctx) => {
  const { D, dec, sendT, grant, pay, alert, stat, online, table, CONF, log } = ctx;
  const LIVE_COST = CONF.get('Tower_Live') || 5;
  const FLOOR_DROP = new Map();   // kind index -> floor -> DropId
  for (const r of table('t_s_dropcondition')) {
    for (const k of KINDS.filter(x => x.drop === r.CondictionType)) { if (!FLOOR_DROP.has(k.index)) FLOOR_DROP.set(k.index, new Map()); FLOOR_DROP.get(k.index).set((r.Para1 || [])[0], r.DropId); }
  }

  function stateOf(p, k) {
    const all = p.s.maze = p.s.maze || {};
    const s = all[k.index] = all[k.index] || { towerIndex: 0, maxIndex: 0, totalGp: 0, items: {}, chests: {}, enterCount: 0, day: '' };
    if (s.day !== dayKey()) {   // new day: a new run (the record stays)
      Object.assign(s, { day: dayKey(), enterCount: 0, towerIndex: 0, at: 0, totalGp: 0, items: {}, chests: {}, double: false, dead: false, pass: 0 });
    }
    return s;
  }
  const opened = (p, k) => k.index === 0 || stateOf(p, KINDS[k.index - 1]).maxIndex >= KINDS[k.index - 1].floors;
  const itemText = s => Object.entries(s.items).map(([t, n]) => `${t},${n}`).join('|');
  function infoMsg(p, idx) {
    const k = KINDS[idx];
    if (!k || !opened(p, k)) return { index: idx, campaignId: 0, maxEnterCount: 1, enterCount: 0, freeEnterCount: 1, itemTempIds: '', firstHitName: '' };
    const s = stateOf(p, k);
    return {
      index: idx, campaignId: k.campaignId, enterCount: s.enterCount, maxEnterCount: 1, freeEnterCount: 1,
      // capture (older Legend Online TR, same protocol): towerIndex is the floor the player is on — 2 while on
      // floor 2 even before its monster fell, 3 right after the portal — not the floors passed
      towerIndex: Math.max(s.towerIndex, s.at || 0), maxIndex: s.maxIndex, totalGp: s.totalGp, itemTempIds: itemText(s),
      order: 0, firstHitId: 0, firstHitName: '', passIndex: s.maxIndex, pass: s.pass || 0,
    };
  }
  const sendInfo = (c, idx) => sendT(c, 4205, 'campaign.TowerInfoMsg', infoMsg(c.player, idx));
  ctx.onLoad.push(c => sendT(c, 4373, 'campaign.TowerListMsg', { towerInfo: [0, 1, 2].map(i => infoMsg(c.player, i)) }));

  const inMaze = c => { const st = c.player.s.campaign; return st && kindOfMap(st.campaignId); };
  const floorNodes = mapId => D.campNodesByCampaign.get(mapId) || [];

  function enterFloor(c, k, s) {
    const mapId = k.base + s.towerIndex + 1;
    s.at = s.towerIndex + 1;
    c.player.s.campaign = null;
    ctx.enterMap(c, mapId, null, 1);
    Object.assign(c.player.s.campaign, { maze: k.index, battleScene: 10 });   // maze fights report scene 10 (2026-10-23 capture)
    c.player.save();
  }

  // loot of a cleared floor; doubled on a double run. The bag being full sends the items by mail.
  // part: 'exp' (the floor's monster), 'items' (its CNTowerBoxAi chest: Labirent Parası + a gem on floors
  // 5, 10, 15 ...; older official capture, floor 5 chest: "Defans Taşı Lv.1 x2, Labirent Parası x2"), 'all' (sweep)
  function floorLoot(c, k, s, floor, part = 'all') {
    const dropId = (FLOOR_DROP.get(k.index) || new Map()).get(floor);
    const got = (dropId ? ctx.DROPS.roll(dropId).filter(([, n]) => n > 0) : [])
      .filter(([t]) => part === 'all' || (part === 'exp' ? t === -700 : t !== -700));
    const mul = s.double ? 2 : 1;
    const loot = got.map(([t, n]) => [t, Math.floor(n * mul * (t === -700 ? (k.expMul || 1) : 1))]);
    const exp = loot.filter(([t]) => t === -700).reduce((a, [, n]) => a + n, 0);
    if (!grant(c, loot, { quiet: true })) {
      grant(c, loot.filter(([t]) => t < 0), { quiet: true });
      const items = loot.filter(([t]) => t > 0);
      if (items.length && ctx.sendMail) ctx.sendMail(c.player.id, { title: k.name, contents: `Ganho do andar ${floor} (mochila cheia)`, annex: items, sendType: 4 });
    }
    s.totalGp += exp;
    for (const [t, n] of loot) if (t > 0) s.items[t] = (s.items[t] || 0) + n;
    return loot;
  }

  function announce(p, k, floor) {
    const g = ctx.guildOf ? ctx.guildOf(p) : null;
    const text = `Parabéns <a t="1" id="${p.id}" name="${p.s.nickName}" consortiaId="${g ? g.id : 0}" serverName="" />, passou o andar ${floor} de ${k.name}`;
    for (const oc of online.values()) sendT(oc, 83, 'chat.ChatChannelMsg', { channel: 2, encodeMsg: text, curTime: Date.now() });
  }

  ctx.onBattleEnd.push((c, cd, won) => {
    const k = inMaze(c); if (!k || !/CNTowerNodeAi/.test(cd.AI || '')) return;
    const p = c.player, s = stateOf(p, k), floor = cd.CampaignId - k.base;
    if (k.index === 0) stat(c, 'mazeFight');   // quest condition 38 "Atacar Catacumbas Esquecidas"
    if (!won) {
      s.dead = true; p.save();
      sendT(c, 4207, 'campaign.TowerDiedMsg', { title: '', msg: String(LIVE_COST) });
      return;
    }
    if (floor !== s.towerIndex + 1) return;   // a floor already counted
    const loot = clearFloor(c, k, s, floor);
    // abre o portal do andar (NodeState 16 → EXIST) para o autodirigir subir
    const portal = floorNodes(cd.CampaignId).find(n => /CNTowerTransAi/.test(n.AI || ''));
    if (portal) ctx.nodeUpdate(c, portal, 1);
    if (loot.length) alert(c, `Obtido:${loot.map(([t, n]) => `${ctx.rewardName(t)} x${n}`).join(' ')}`);
    sendInfo(c, k.index);
  });
  function clearFloor(c, k, s, floor, part = 'exp') {
    const p = c.player;
    s.towerIndex = floor;
    if (floor > s.maxIndex) s.maxIndex = floor;
    if (floor >= k.floors) s.pass = 2;
    const loot = floorLoot(c, k, s, floor, part);
    p.save();
    log(`[#${c.id}] ${k.name} floor ${floor} cleared`);
    if (floor % 10 === 0) announce(p, k, floor);
    return loot;
  }
  // a new day's run (entry, keys); false when refused
  function startRun(c, k, s, isDouble) {
    if (s.enterCount >= 1) { alert(c, 'Quantidade diária esgotada!'); return false; }
    const first = k.index === 0 && s.maxIndex === 0;
    const double = k.index === 0 && isDouble === 2;
    const stones = k.index === 1 ? k.stones : (double && !first ? k.stones : 0);
    if (stones && !pay(c, [[MAZE_STONE, stones]])) { alert(c, `${stones} Chaves do Labirinto necessárias`); return false; }
    Object.assign(s, { enterCount: s.enterCount + 1, totalGp: 0, items: {}, chests: {}, double: double || first, dead: false, pass: 0 });
    stat(c, k.index === 0 ? 'maze' : 'maze2');
    return true;
  }

  // the floor's chest (CNTowerBoxAi): its items, once per floor and run
  ctx.onArrive.push((c, cd) => {
    const k = inMaze(c); if (!k || !/CNTowerBoxAi/.test(cd.AI || '')) return false;
    const p = c.player, s = stateOf(p, k), floor = cd.CampaignId - k.base;
    s.chests = s.chests || {};
    if (s.chests[floor]) return true;
    s.chests[floor] = true;
    const loot = floorLoot(c, k, s, floor, 'items');
    p.save();
    ctx.nodeUpdate(c, cd, 8);
    if (loot.length) { const text = `Obtido:${loot.map(([t, n]) => `${ctx.rewardName(t)} x${n}`).join(', ')}`; alert(c, text); ctx.chat(c, text); }
    sendInfo(c, k.index);
    return true;
  });

  // the portal opens once the floor's monster fell; the last floor's portal (no next map) ends the run
  ctx.onArrive.push((c, cd) => {
    const k = inMaze(c); if (!k || !/CNTowerTransAi/.test(cd.AI || '')) return false;
    const p = c.player, s = stateOf(p, k), floor = cd.CampaignId - k.base;
    if (s.towerIndex < floor) { alert(c, 'Derrote o monstro deste andar primeiro'); return true; }
    if ((cd.MoveToNodeIds || []).length) { s.at = floor + 1; p.save(); sendInfo(c, k.index); return false; }   // the engine moves the army to the next floor
    leave(c);
    ctx.finishCampaign(c);
    return true;
  });

  // leaving the maze map: the run's loot window; leaving dead gives the day's run up
  function leave(c) {
    const k = inMaze(c); if (!k) return;
    const p = c.player, s = stateOf(p, k);
    sendT(c, 4419, 'campaign.TowerInfoMsg', Object.assign(infoMsg(p, k.index), { itemTempIds: itemText(s) }));
    if (s.dead) Object.assign(s, { towerIndex: 0, at: 0, totalGp: 0, items: {}, chests: {}, dead: false, double: false });
    p.s.campaign = null; p.save();
  }
  ctx.before('U_C_CAMPAIGN_ROOM_EXIT', c => leave(c));

  // Labirent Baskını (C_CAMPAIGN_SWEEP sweepType 2, forwarded by sweep.js): floors towerIndex+1 .. eIndex
  // (at most the record, from record 11 on: CT.OPEN_SWEEP_LEVEL), Tower_Sweep_Time 30 s and Tower_Sweep_Gold
  // 1000 gold a floor — not in this client's t_s_config, values from the older client DB (latestdb.db).
  // Capture (older Legend Online TR): opType 1 -> status 1; 3 (result) -> result [{type 1, gp, time, cIndex
  // floor, eIndex last}], status 11, then the floor counter moves on; 4 -> status 5. Finishing early costs
  // FastSweep_Price (1 when absent) diamonds a started minute (client MazeMopupIngFrame AccelerateTip).
  const SWEEP_TIME = 30, SWEEP_GOLD = 1000, OPEN_SWEEP = 11;
  const sweepReply = (c, o) => sendT(c, 4425, 'campaign.CampaignSweepRsp', Object.assign({ result: [], dropItems: [], sweepType: 2 }, o));
  (ctx.sweepHandlers = ctx.sweepHandlers || {})[2] = (c, m) => {
    const p = c.player;
    if (m.opType === 1) {
      const k = KINDS.find(x => x.campaignId === m.campaignId) || KINDS[0];
      if (!opened(p, k)) { alert(c, 'Este labirinto ainda não abriu'); return; }
      const s = stateOf(p, k), from = s.towerIndex + 1, to = m.eIndex || 0;
      if (s.maxIndex < OPEN_SWEEP) { alert(c, 'É preciso passar pelo menos 10 andares para incursão'); return; }
      if (inMaze(c)) { alert(c, 'Saia do labirinto primeiro'); return; }
      if (to < from) { alert(c, 'O andar da incursão deve ser maior que o atual'); return; }
      if (to > s.maxIndex) { alert(c, 'O andar da incursão deve ser menor que o maior registro'); return; }   // client layerTipData3
      if ((p.s.gold || 0) < (to - from + 1) * SWEEP_GOLD) { alert(c, 'Ouro insuficiente'); return; }
      if (s.towerIndex === 0 && !startRun(c, k, s, m.enterType)) return;
      p.s.mazeSweep = { k: k.index, from, to, started: Date.now() };
      p.save();
      sweepReply(c, { status: 1, campaignId: k.campaignId });
      sendInfo(c, k.index);
    } else if (m.opType === 3) {
      const w = p.s.mazeSweep; if (!w) return sweepReply(c, { status: 5 });
      const floors = w.to - w.from + 1, left = w.started + floors * SWEEP_TIME * 1000 - Date.now();
      if (left > 1000) {   // finish now for diamonds
        const cost = (CONF.get('FastSweep_Price') || 1) * Math.ceil(left / 60000);
        const bound = m.payType !== 1 && ctx.balance(p, -500) >= cost;
        if (!pay(c, [[bound ? -500 : -400, cost]])) { alert(c, 'Diamantes insuficientes'); return; }
      }
      const k = KINDS[w.k], s = stateOf(p, k), result = [];
      for (let f = w.from; f <= w.to; f++) {
        if (f !== s.towerIndex + 1) break;
        if (!pay(c, [[-100, SWEEP_GOLD]])) { alert(c, 'Ouro insuficiente, incursão interrompida'); break; }
        const loot = clearFloor(c, k, s, f, 'all');   // a sweep takes the chests too
        result.push({ type: 1, gp: loot.filter(([t]) => t === -700).reduce((a, [, n]) => a + n, 0), time: SWEEP_TIME, cIndex: f, eIndex: w.to,
          items: loot.filter(([t]) => t !== -700).map(([templateId, count]) => ({ templateId, count })) });
      }
      s.at = 0;
      p.s.mazeSweep = null; p.save();
      ctx.sendPlayer(c);
      sweepReply(c, { result, status: 11, campaignId: k.campaignId, totalGp: s.totalGp });
      sendInfo(c, k.index);
    } else if (m.opType === 4) {
      p.s.mazeSweep = null; p.save();
      sweepReply(c, { status: 5, sweepType: 0 });
    }
  };
  for (const n of ['C_ENTER_CASTLE', 'C_PLAYER_SPACE_ENTER']) ctx.before(n, c => leave(c));

  return {
    C_TOWER_INFO(c, body) {
      const m = dec(c, 'C_TOWER_INFO', body);
      sendInfo(c, m.index || 0);
    },
    C_ENTER_TOWER(c, body) {
      const m = dec(c, 'C_ENTER_TOWER', body), p = c.player;
      const k = KINDS.find(x => x.campaignId === m.campaignId) || kindOfMap(m.campaignId);
      if (!k || !opened(p, k)) { alert(c, 'Este labirinto ainda não abriu'); return; }
      const s = stateOf(p, k);
      if (s.towerIndex >= k.floors) { alert(c, 'Você concluiu todos os andares hoje'); return sendInfo(c, k.index); }
      if (s.towerIndex === 0 && m.chooseIndex !== 0 && !startRun(c, k, s, m.isDouble)) return sendInfo(c, k.index);   // a new run
      s.dead = false;
      p.save();
      enterFloor(c, k, s);
      sendInfo(c, k.index);
    },
    C_TOWER_RESET(c, body) {
      const m = dec(c, 'C_TOWER_RESET', body), k = KINDS[m.index || 0];
      if (!k) return;
      const s = stateOf(c.player, k);
      Object.assign(s, { towerIndex: 0, at: 0, totalGp: 0, items: {}, chests: {}, dead: false, double: false, pass: 0 });
      c.player.save();
      sendInfo(c, k.index);
    },
    C_TOWER_LIVE(c, body) {
      const m = dec(c, 'C_TOWER_LIVE', body), p = c.player, k = inMaze(c);
      if (!k) return;
      const s = stateOf(p, k);
      if (!s.dead) return;
      const bound = m.payType === 0 && ctx.balance(p, -500) >= LIVE_COST;
      if (!pay(c, [[bound ? -500 : -400, LIVE_COST]])) { alert(c, 'Diamantes insuficientes'); return sendT(c, 4207, 'campaign.TowerDiedMsg', { title: '', msg: String(LIVE_COST) }); }
      s.dead = false; p.save();
      sendT(c, 4175, 'simple.PlayerStateListMsg', { playerState: [{ armyId: p.armyId, state: 0, leftTime: 0, serverName: ctx.cfg.SERVER_NAME }], userId: [p.id] });
    },
  };
};
