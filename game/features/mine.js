// Dış şehir ouro madenleri (world map 5). Was a recorded copy of the official map's mine list (436) and the
// attack itself (U_C_ARMY_ATTACK) had no answer at all. Client: OuterCityManager (onAllNodeInfo,
// _secondAllNodeInfo, _threeNodeInfoUpdate, _secondNodeInfoUpdate), OuterCityModel, GoldMineInfoView.
//  data: t_s_mapphysicposition Type 3 rows 301..342 = the 42 mine sites (PhysicId -> t_s_physic PosX/PosY,
//   Property1 = slots one player may hold at that site); t_s_mapmine = each site's grade nodes (ID, Grade,
//   Soldiers/Heroes guarding, ResourcesId -100 gold, ResourcesNumPerhour, TotalNum = slots in the node).
//  C_OUT_CITY_GOLDN_LIST {op 1} -> 436 OutCityAllInfoMsg (sites with node counts, occupyNodeInfo = own slots);
//   {mapId, posX, posY, nodeId} -> 438 OutCityGoldNodeInfoMsg (the node's occupied slots, count = how many).
//  U_C_ARMY_ATTACK {mapId, posX, posY, nodeId, sonNodeId}: a free slot -> fight its guards, a held one -> fight
//   the holder's hero and troops (PvP, on auto). A win takes the slot if the limits allow (t_s_config
//   Mine_UpperLimit "1,3|40,4|..." slots by level, Property1 per site; the client warns "Saldırmaya devam
//   edebilirsiniz ancak işgal edemezsiniz" past them) -> 437 OneMineInfoMsg + 439 OutCityNodeInfoMsg.
//  U_C_UNOCCPWILDLAND {position, nodeId, sonNodeId}: give a slot up.
//  income: ResourcesNumPerhour gold per hour held, paid when the holder's account is settled (login, map list,
//   losing or leaving the slot). How long a slot may be held is not in any table: no limit here.
// Shared state in the database's meta 'mines' (store.js). Not built: guild city regions, dragon crystal mines,
// rebels and castle attacks (U_C_ARMY_ATTACK without nodeId).
const store = require('../../store');
const MAP = 5, HOUR = 3600000;

module.exports = (ctx) => {
  const { dec, sendT, table, alert, chat, online, playerById, sendCastle, log, CONF } = ctx;
  const state = store.getMeta('mines', { slots: {} });   // "nodeId:son" -> { playerId, since, paid }
  const save = () => store.setMeta('mines', state);

  const PHYSIC = new Map(table('t_s_physic').map(r => [Number(r.Id), r]));
  // some ids are strings in the table ("33120")
  const NODES = new Map(table('t_s_mapmine').map(r => Object.assign({}, r, { ID: Number(r.ID), Positionid: Number(r.Positionid) })).map(r => [r.ID, r]));
  const SITES = table('t_s_mapphysicposition').filter(r => Number(r.Type) === 3 && PHYSIC.has(Number(r.PhysicId))).map(r => {
    const ph = PHYSIC.get(Number(r.PhysicId));
    return { posId: Number(r.ID), physicId: r.PhysicId, x: ph.PosX, y: ph.PosY, mapId: ph.MapId || MAP, perPlayer: r.Property1 || 3,
      nodes: [...NODES.values()].filter(n => n.Positionid === Number(r.ID)).sort((a, b) => a.ID - b.ID) };
  });
  const SITE_OF = new Map(); for (const s of SITES) for (const n of s.nodes) SITE_OF.set(n.ID, s);
  const UPPER = String((table('t_s_config').find(r => r.ConfigName === 'Mine_UpperLimit') || {}).ConfigValue || '1,3')
    .split('|').map(x => x.split(',').map(Number));
  const maxSlots = grade => UPPER.reduce((n, [lv, cnt]) => grade >= lv ? cnt : n, 0);

  const key = (nodeId, son) => `${nodeId}:${son}`;
  const slotsOf = pid => Object.entries(state.slots).filter(([, s]) => s.playerId === pid).map(([k, s]) => { const [n, o] = k.split(':').map(Number); return { nodeId: n, son: o, s }; });
  const nameOf = pid => { const p = playerById(pid); return p ? p.s.nickName : ''; };
  const guildOf = pid => { const p = playerById(pid); return p && ctx.guildOf ? (ctx.guildOf(p) || {}).id || 0 : 0; };

  // pay the gold a holder's slots made since last time
  function settle(pid, quiet) {
    let gold = 0;
    const now = Date.now();
    for (const { nodeId, s } of slotsOf(pid)) {
      const n = NODES.get(nodeId); if (!n) continue;
      const amount = Math.floor((now - s.paid) / HOUR * n.ResourcesNumPerhour);
      if (amount > 0) { gold += amount; s.paid += Math.floor(amount / n.ResourcesNumPerhour * HOUR); }
    }
    if (!gold) return 0;
    const p = playerById(pid); if (!p) return 0;
    p.s.gold = (p.s.gold || 0) + gold; p.save(); save();
    const c = online.get(pid);
    if (c) { sendCastle(c); if (!quiet) chat(c, `Renda da mina de ouro: Ouro x${gold.toLocaleString('en-US')}`); }
    return gold;
  }
  ctx.onLoad.push(c => settle(c.player.id));

  const mineMsg = (site, nodeId, son, s) => ({ posId: site.posId, nodeId, sonNodeId: son, occupyPlayerId: s ? s.playerId : 0,
    playerName: s ? nameOf(s.playerId) : '', guildId: s ? guildOf(s.playerId) : 0, isOccupy: !!s });
  function nodeMsg(site, n, pid) {
    const held = Object.entries(state.slots).filter(([k]) => k.startsWith(n.ID + ':'));
    return { posId: site.posId, nodeId: n.ID, occupyNum: held.filter(([, s]) => s.playerId === pid).length, allOccupyNum: held.length, posX: site.x, posY: site.y };
  }
  function siteMsg(site, pid) {
    const mine = slotsOf(pid).filter(x => SITE_OF.get(x.nodeId) === site);
    return { id: site.physicId, mapId: site.mapId, posX: site.x, posY: site.y, templateId: site.posId, type: 3, state: 1,
      allNodeInfo: site.nodes.map(n => nodeMsg(site, n, pid)), occupyNodeInfo: mine.map(x => mineMsg(site, x.nodeId, x.son, x.s)), armyPawn: [], curArmyId: [] };
  }
  const sendAll = c => sendT(c, 436, 'army.OutCityAllInfoMsg', { allInfo: SITES.map(s => siteMsg(s, c.player.id)) });
  function changed(site, n, son, pids) {   // tell the players concerned (online) about one slot
    for (const pid of new Set(pids)) {
      const c = online.get(pid); if (!c) continue;
      sendT(c, 437, 'army.OneMineInfoMsg', mineMsg(site, n.ID, son, state.slots[key(n.ID, son)]));
      sendT(c, 439, 'army.OutCityNodeInfoMsg', nodeMsg(site, n, pid));
      sendAll(c);
    }
  }

  function take(c, site, n, son) {
    const p = c.player, k = key(n.ID, son), old = state.slots[k];
    if (slotsOf(p.id).length >= maxSlots(p.s.grades) || slotsOf(p.id).filter(x => SITE_OF.get(x.nodeId) === site).length >= site.perPlayer) {
      alert(c, 'Limite de recursos ocupados atingido; espaço não tomado');
      return;
    }
    if (old) settle(old.playerId, true);
    state.slots[k] = { playerId: p.id, since: Date.now(), paid: Date.now() };
    save();
    log(`[#${c.id}] gold mine ${n.ID}:${son} taken${old ? ' from ' + old.playerId : ''}`);
    alert(c, `Mina de Ouro Lv. ${n.Grade} ocupada (por hora ${n.ResourcesNumPerhour.toLocaleString('en-US')} ouro)`);
    if (old) { const oc = online.get(old.playerId); if (oc) alert(oc, `${p.s.nickName} sua mina de ouro (Lv. ${n.Grade}) tomou`); }
    changed(site, n, son, [p.id, old && old.playerId].filter(Boolean));
  }

  return {
    C_OUT_CITY_GOLDN_LIST(c, body) {
      const m = dec(c, 'C_OUT_CITY_GOLDN_LIST', body);
      settle(c.player.id);
      if (!m.nodeId) return sendAll(c);
      const n = NODES.get(m.nodeId), site = SITE_OF.get(m.nodeId); if (!n || !site) return;
      const held = Object.entries(state.slots).filter(([k]) => k.startsWith(n.ID + ':')).map(([k, s]) => mineMsg(site, n.ID, Number(k.split(':')[1]), s));
      sendT(c, 438, 'army.OutCityGoldNodeInfoMsg', { nodeMineInfo: held, posId: site.posId, nodeId: n.ID, posX: site.x, posY: site.y, count: held.length });
    },
    U_C_ARMY_ATTACK(c, body) {
      const m = dec(c, 'U_C_ARMY_ATTACK', body), p = c.player;
      if (!m.nodeId) {
        if (ctx.attackTreasure && ctx.attackTreasure(c, m)) return;   // Minas de Tesouro (treasuremine.js)
        if (ctx.attackWild && ctx.attackWild(c, m)) return;             // monstros do mapa (fieldmonster.js)
        alert(c, 'Ataque a este alvo ainda não disponível'); return;
      }
      const n = NODES.get(m.nodeId), site = SITE_OF.get(m.nodeId);
      if (!n || !site || !(m.sonNodeId >= 1 && m.sonNodeId <= n.TotalNum)) { alert(c, 'Mina não encontrada'); return; }
      if (c.battle) return;
      const k = key(n.ID, m.sonNodeId), holder = state.slots[k];
      if (holder && holder.playerId === p.id) { alert(c, 'Este espaço já é seu'); return; }
      const onEnd = won => { if (won) take(c, site, n, m.sonNodeId); else alert(c, 'Ataque falhou'); };
      const opp = holder && playerById(holder.playerId);
      if (opp) ctx.startPvp(c, opp, { onEnd, scene: 1 });
      else ctx.startBattle(c, { Soldiers: n.Soldiers, Heros: n.Heroes, BattleType: 1, mapTempId: MAP, Level: n.Grade, onEnd });
    },
    U_C_UNOCCPWILDLAND(c, body) {
      const m = dec(c, 'U_C_UNOCCPWILDLAND', body), p = c.player;
      const n = NODES.get(m.nodeId), site = SITE_OF.get(m.nodeId), k = key(m.nodeId, m.sonNodeId);
      if (!n || !site || !state.slots[k] || state.slots[k].playerId !== p.id) return;
      settle(p.id);
      delete state.slots[k]; save();
      alert(c, 'Espaço da mina abandonado');
      changed(site, n, m.sonNodeId, [p.id]);
    },
  };
};
