// Player-to-player presence: the town square (PLAYER_SPACE, map 10000) where online players see and follow
// each other, other players' profiles and equipment, friend recommendations, contacts' online state.
// All of these were answered from the official capture before, which showed the official server's real
// players (MoonPresence, insanejoe67 ...) to everyone. Formats from the capture:
//  enter  -> 4595 CREATE (own entry) + 4597 SEND_EXSIT per player already there; the others get 4597 too
//  move   -> the others get 4594 SYNC_POS {players:[{playerId, path}]}
//  leave  -> the others get 4607 REMOVE_IN_SPACE {players:[{playerId}]}
//  node   -> 4601 SPACE_EVENT echo
const SPACE_MAP = 10000;
const SPAWN = { x: 172, y: 98 };   // the capture's first entry position

module.exports = (ctx) => {
  const { dec, sendT, online, playerById, M, D, log } = ctx;
  const square = new Map();   // player id -> connection
  // Ultra / GM: activate monthly pass (cardType 1 basic / 2 premium) for `days` days
  ctx.grantMonthCard = (c, cardType = 1, days = 30) => {
    const p = c.player, cards = p.s.monthCards = p.s.monthCards || {};
    const cur = cards[cardType], base = Math.max(Date.now(), (cur && cur.until) || 0);
    cards[cardType] = { until: base + days * 864e5, received: (cur && cur.received) || '' };
    p.save();
    const info = [1, 2].map(t => {
      const m = cards[t], active = m && m.until > Date.now();
      return { cardType: t, isPay: !!active, isReceive: false, leftDays: active ? Math.max(1, Math.ceil((m.until - Date.now()) / 864e5)) : 0 };
    });
    sendT(c, 4698, 'active.MonthCardRsp', { info, mainType: 1 });
    return `Passe Mensal ${cardType === 2 ? 'Premium' : 'Básico'} +${days} dias`;
  };

  function entry(p) {
    const s = p.s, sp = s.space || SPAWN, a = M.mapArmy(p);
    return { heroId: p.heroId, playerId: p.id, grades: s.grades, nickName: s.nickName, templateId: s.icon, arm: a.arm, cloth: a.cloth, armyId: p.armyId,
      fightingCapacity: p.fightingCapacity(), curPosX: sp.x, curPosY: sp.y, campaignId: SPACE_MAP, onlineState: true, hp: p.stats().total.live, maxHp: p.stats().total.live,
      mountTempId: a.mountTempId, mountGrade: a.mountGrade, appellid: a.appellid, guardShowInfo: {}, ...M.showFields(p) };   // 4595 as in the 2026-10-23 capture
  }
  const others = c => [...square.values()].filter(o => o !== c && o.player);
  function leave(c) {
    if (!c.player || square.get(c.player.id) !== c) return;
    square.delete(c.player.id);
    for (const o of others(c)) sendT(o, 4607, 'campaign.SpacePlayerMoveMsg', { players: [{ playerId: c.player.id, path: [], receivers: [] }] });
  }
  ctx.onClose(leave);
  ctx.squareMembers = () => [...square.values()];   // chat channel 8 (current scene)
  // going anywhere else takes the player out of the square
  for (const name of ['C_CAMPAIGN_START', 'U_C_CAMPAIGN_TRAINING', 'C_ENTER_CASTLE']) ctx.before(name, c => leave(c));

  // ---- profiles ---------------------------------------------------------------------------------------
  const playerInfo = p => require('../people').playerInfo(p, online.has(p.id));
  function equipItems(p) {
    return Object.values(p.s.equip).map(it => ({ id: it.id, templateId: it.templateId, pos: it.pos, exist: true, objectId: p.heroId, bagType: 4, bind: true,
      beginDate: '2000-01-01 00:00:00', count: 1, strengthenGrade: it.strengthenGrade || 0, userId: p.id, ...require('../equip').fields(it) }));
  }
  const notFound = c => ctx.alert(c, 'Jogador não encontrado');

  // PK in the square / outer map (client SpacePKHandler; C_SPACEMAP_ATTACK and C_HANGUP_PVP carry the same
  // HangupAttackMsg): op 1 invite -> the defender 4421 U_C_HANGUP_PVP op 1 (a popup); 2 accept -> the fight;
  // 3 refuse -> the attacker gets op 3. 4..6 are the pet versions (no pets here: refused). The fight runs for the
  // attacker against the defender's copy (logic.startPvp is one-sided); the defender is told the result.
  const pk = new Map();   // defender id -> { attacker id, at }
  function pkMsg(c, m) {
    const p = c.player;
    if (m.op === 1) {
      const tc = online.get(m.defenceId);
      if (!tc || !tc.player || tc === c) { ctx.alert(c, 'Jogador não está online'); return; }
      if (tc.battle || c.battle) { ctx.alert(c, 'Jogador está em batalha'); return; }
      pk.set(tc.player.id, { attacker: p.id, at: Date.now() });
      sendT(tc, 4421, 'campaign.HangupAttackMsg', { op: 1, attackId: p.id, attackName: p.s.nickName, defenceId: tc.player.id, defenceName: tc.player.s.nickName });
      ctx.alert(c, 'Desafio enviado');
      return;
    }
    if (m.op === 4) { ctx.alert(c, 'Evcil hayvan PK bu sunucuda não há'); return; }
    const want = pk.get(p.id), ac = want && online.get(want.attacker);
    if (!want || want.attacker !== m.attackId || Date.now() - want.at > 60000 || !ac || !ac.player) { pk.delete(p.id); return; }
    pk.delete(p.id);
    if (m.op === 3 || m.op === 6) {
      sendT(ac, 4421, 'campaign.HangupAttackMsg', { op: 3, attackId: ac.player.id, attackName: ac.player.s.nickName, defenceId: p.id, defenceName: p.s.nickName });
      ctx.alert(ac, `${p.s.nickName} recusou o desafio`);
      return;
    }
    if (m.op !== 2) return;
    if (ac.battle) { ctx.alert(c, 'Adversário está em batalha'); return; }
    ctx.startPvp(ac, p, { scene: 7, onEnd: won => {
      ctx.alert(c, `${ac.player.s.nickName} ile PK: ${won ? 'você perdeu' : 'você venceu'}`);
      ctx.chat(ac, `${p.s.nickName} ile PK: ${won ? 'você venceu' : 'você perdeu'}`);
    } });
    ctx.alert(c, `${ac.player.s.nickName} PK iniciado (o adversário está assistindo)`);
    log(`[#${c.id}] square pk ${ac.player.id} vs ${p.id}`);
  }

  return {
    C_SPACEMAP_ATTACK(c, body) { pkMsg(c, dec(c, 'C_SPACEMAP_ATTACK', body)); },
    C_HANGUP_PVP(c, body) { pkMsg(c, dec(c, 'C_HANGUP_PVP', body)); },
    C_PLAYER_SPACE_ENTER(c) {
      const p = c.player;
      if (square.get(p.id) && square.get(p.id) !== c) leave(square.get(p.id));
      square.set(p.id, c);
      sendT(c, 4595, 'room.RoomEnterMsg', { player: [entry(p)], userIds: [] });
      for (const o of others(c)) {
        sendT(c, 4597, 'room.RoomEnterMsg', { player: [entry(o.player)], userIds: [] });
        sendT(o, 4597, 'room.RoomEnterMsg', { player: [entry(p)], userIds: [] });
      }
    },
    C_PLAYER_SPACE_LEAVE(c) { leave(c); },
    // stuck on an obstacle (client resetSpacePosition when isOnObstacle): back to the spawn point, sent as a
    // one-step move to the player and to the square
    C_CHECK_MOVEABLE(c) {
      const p = c.player;
      p.s.space = { x: SPAWN.x, y: SPAWN.y };
      const move = { players: [{ playerId: p.id, path: [{ x: SPAWN.x, y: SPAWN.y }], receivers: [] }] };
      sendT(c, 4594, 'campaign.SpacePlayerMoveMsg', move);
      if (square.get(p.id) === c) for (const o of others(c)) sendT(o, 4594, 'campaign.SpacePlayerMoveMsg', move);
    },
    C_PLAYER_SPACE_MOVE(c, body) {
      const m = dec(c, 'C_PLAYER_SPACE_MOVE', body), p = c.player;
      const mine = (m.players || []).find(x => x.playerId === p.id) || (m.players || [])[0];
      if (!mine || !(mine.path || []).length) return;
      const last = mine.path[mine.path.length - 1];
      p.s.space = { x: last.x, y: last.y };   // saved with the next save; positions change every step
      if (square.get(p.id) !== c) return;
      for (const o of others(c)) sendT(o, 4594, 'campaign.SpacePlayerMoveMsg', { players: [{ playerId: p.id, path: mine.path, receivers: [] }] });
    },
    C_PLAYER_SPACE_NODE_TRIGGER(c, body) {
      const m = dec(c, 'C_PLAYER_SPACE_NODE_TRIGGER', body);
      sendT(c, 4601, 'simple.PropertyMsg', { param1: m.param1 });
    },

    // other players' profile (InfoRspMsg) and their relation card (RelationPlayerMsg)
    C_SIMPLEUSER_INFO(c, body) {
      const m = dec(c, 'C_SIMPLEUSER_INFO', body), t = playerById(m.otherId);
      if (!t) return notFound(c);
      sendT(c, 4128, 'simple.InfoRspMsg', { info: playerInfo(t), from: m.from || 0 });
    },
    CH_SIMPLEUSER_INFO(c, body) {
      const m = dec(c, 'CH_SIMPLEUSER_INFO', body), t = playerById(m.otherId);
      if (!t) return notFound(c);
      sendT(c, 4256, 'simple.RelationPlayerMsg', { player: playerInfo(t), snsInfo: require('../people').snsInfo(t), from: m.from || 0 });
    },
    // another player's equipment and hero (the view-player window)
    C_BAG_EQUIPLOOK(c, body) {
      const m = dec(c, 'C_BAG_EQUIPLOOK', body), t = playerById(m.otherId);
      if (!t) return notFound(c);
      const a = M.armyMsg(t);
      sendT(c, 4125, 'simple.DetailRspMsg', {
        otherId: t.id, item: m.itemInfo === false ? [] : equipItems(t),
        army: { armyPawn: [], armyId: a.armyId, playerId: t.id, nickName: t.s.nickName, mapId: a.mapId, curPosX: a.curPosX, curPosY: a.curPosY, type: 2, simpleHero: M.heroInfo(t) },
        hideFashion: !!t.s.hideFashion,
      });
    },
    // friend recommendations: other characters of this server, by sex as the client lists them
    U_CH_RECOMMENDLIST(c) {
      const p = c.player, friends = new Set(Object.keys(p.s.relations || {}).map(Number));
      const ids = new Set([...Object.values(ctx.db.state.accounts).filter(a => a.char).map(a => a.userId), ...online.keys()]);
      const list = [...ids].filter(id => id !== p.id && !friends.has(id)).map(id => playerById(id)).filter(Boolean)
        .sort((x, y) => Number(online.has(y.id)) - Number(online.has(x.id)) || Math.abs(x.s.grades - p.s.grades) - Math.abs(y.s.grades - p.s.grades)).slice(0, 8);
      const row = t => ({ playerId: t.id, nickName: t.s.nickName, level: t.s.grades, sex: t.s.sex, attack: t.fightingCapacity(), mapName: '', headId: t.s.icon, job: t.s.job });
      sendT(c, 85, 'friend.RecommendListMsg', { girlList: list.filter(t => t.s.sex === 0).map(row), boyList: list.filter(t => t.s.sex !== 0).map(row) });
    },
    // contacts' online state (1 online / 0 offline: our reading of the capture, where all four were 1)
    CH_CHAT_STATE(c, body) {
      const m = dec(c, 'CH_CHAT_STATE', body);
      sendT(c, 4272, 'chat.ChatStateListRspMsg', { chatState: (m.userId || []).map(id => ({ userId: id, chatState: online.has(id) ? 1 : 0 })) });
    },
    // own chat status (busy / away ...): confirmed as the official server does
    CH_EXCHANGE_STATE(c, body) {
      const m = dec(c, 'CH_EXCHANGE_STATE', body);
      c.player.s.chatState = m.chatState; c.player.save();
      sendT(c, 4232, 'chat.ChatStateMsg', { userId: c.player.id, chatState: m.chatState, result: 1 });
    },
    // hide-fashion toggle: no reply in the capture
    U_C_HERO_UPDATE_EQUIPMENT(c, body) { const m = dec(c, 'U_C_HERO_UPDATE_EQUIPMENT', body); c.player.s.hideFashion = !!m.hide; c.player.save(); },
    // monthly cards: p.s.monthCards[1|2] = { until: ms, received: 'YYYY-MM-DD' }
    C_MONTH_CARD(c) {
      const cards = c.player.s.monthCards || {}, now = Date.now(), day = ctx.sysTime().slice(0, 10);
      const info = [1, 2].map(cardType => {
        const m = cards[cardType], active = m && m.until > now;
        const leftDays = active ? Math.max(1, Math.ceil((m.until - now) / 864e5)) : 0;
        return { cardType, isPay: !!active, isReceive: !!(active && m.received === day), leftDays };
      });
      sendT(c, 4698, 'active.MonthCardRsp', { info, mainType: 1 });
    },
    // speed-hack probe: the official server never answered it
    C_CHECK_ACCELERATOR() {},
  };
};
