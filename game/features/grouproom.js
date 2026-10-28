// Group scene ("Grup Sahne" / Kahraman Kapısı, t_s_campaign 9000+): rooms and the dungeon run.
// Capture (one room, created and left without playing): U_C_CAMPAIGN_ROOM_CREATE {capacity 1} -> 12 RoomMsg
// {roomId, masterId, name "Savaş seçilmedi", capacity 3}, 17 {placeState: [master, 0, 0]}, 32 EditRoomRsp,
// 120 members (RoomPlayerMsg), 4186 {armyFightPos: [{userId, heroPos: 2}]}; ROOM_EDIT {dungeonId, campaignId}
// -> 32 {startCampaignId, roomName}, 24 {readyState: [{playerId, readyState: 2}]}; ROOM_EXIT -> 15 {playerId}.
// The rest from the client (RoomListSocketOutManager / uC senders, room.* messages): list (13), join (12 to
// the joiner, 120 to all), ready (24), kick (28), invite (16 to the invited), slots (17), new master (121),
// start U_C_CAMPAIGN_ENTER {paraInt2: campaignId} by the master.
// Start: MultiCampaign_Weary (20) each; the day's first run of a dungeon is rewarded (MultiCampaign_MaxCount 1:
// BaseGp at the end), later ones are not. Levels from MinLevel.
// NOT co-op yet: every member plays the dungeon in its own copy of the map (the battle engine has one player
// hero); the room only gathers and starts them together.
const NONAME = 'Combate não selecionado';
const READY = 2;

module.exports = (ctx) => {
  const { dec, sendT, online, alert, M, CONF, table, sysTime, log } = ctx;
  // group scenes 9000..9299 and the season nest (4201, features/dragonnest.js; its runs cost no weary and have no daily cap here)
  const CAMPAIGNS = new Map(table('t_s_campaign').filter(r => (r.CampaignId >= 9000 && r.CampaignId < 9300) || r.CampaignId === 4201).map(r => [r.CampaignId, r]));
  const WEARY = CONF.get('MultiCampaign_Weary') || 20, PER_DAY = CONF.get('MultiCampaign_MaxCount') || 1;
  const rooms = new Map();   // roomId -> { id, master, members: [ids], places: [id|0|-1 x3], ready: {id: state}, campaignId, password, type }
  let nextId = 1000;
  const roomOf = c => c.player && c.player.roomId && rooms.get(c.player.roomId);
  const conns = r => r.members.map(id => online.get(id)).filter(Boolean);
  const toAll = (r, code, type, msg) => { for (const o of conns(r)) sendT(o, code, type, msg); };
  const name = r => r.campaignId ? ctx.nameOf(CAMPAIGNS.get(r.campaignId), 'CampaignName') || NONAME : NONAME;

  function member(r, p) {
    const a = M.mapArmy(p);
    return { roomId: r.id, count: r.members.length, playerState: r.ready[p.id] || 0, heroId: p.heroId, playerId: p.id, grades: p.s.grades, nickName: p.s.nickName,
      sex: p.s.sex, templateId: p.s.icon, arm: a.arm, cloth: a.cloth, armyId: p.armyId, fightingCapacity: p.fightingCapacity(), curPosX: p.s.castle.posX,
      curPosY: p.s.castle.posY, onlineState: true, job: p.s.job, hp: p.stats().total.live, maxHp: p.stats().total.live, tarIds: [],
      guardShowInfo: {}, ...M.showFields(p) };
  }
  const roomMsg = r => ({ roomPlayer: r.members.map(id => online.get(id)).filter(Boolean).map(o => member(r, o.player)), roomId: r.id, campaignId: r.campaignId || 0,
    masterId: r.master, name: name(r), count: r.members.length, capacity: 3, roomType: r.type || 0, isSetPassword: !!r.password });
  const edit = r => ({ roomId: r.id, startCampaignId: r.campaignId || 0, masterId: r.master, count: r.members.length, capacity: 3, roomName: name(r), passWord: r.password || '' });
  const readyMsg = r => ({ readyState: r.members.map(id => ({ playerId: id, readyState: r.ready[id] || 0 })) });
  const members = r => ({ roomPlayer: r.members.map(id => online.get(id)).filter(Boolean).map(o => member(r, o.player)) });

  // the joiner's view of the room (also after creating it), then everyone's member list
  function showRoom(c, r) {
    sendT(c, 12, 'room.RoomMsg', roomMsg(r));
    sendT(c, 17, 'room.PlaceStateRspMsg', { placeState: r.places });
    sendT(c, 32, 'room.EditRoomRspMsg', edit(r));
    toAll(r, 120, 'room.RoomPlayerListMsg', members(r));
    sendT(c, 4186, 'army.ArmyFightPosEditListMsg', { armyFightPos: r.members.map((id, i) => ({ userId: id, heroPos: 2 + i })) });
    toAll(r, 24, 'room.PlayerReadyRspMsg', readyMsg(r));
  }
  function leave(c, reason = 0) {
    const r = roomOf(c); if (!r) return;
    const id = c.player.id;
    toAll(r, 15, 'room.RoomExitRspMsg', { playerId: id, exitType: reason });
    r.members = r.members.filter(x => x !== id);
    r.places = r.places.map(x => x === id ? 0 : x);
    delete r.ready[id]; c.player.roomId = null;
    if (!r.members.length) { rooms.delete(r.id); return; }
    if (r.master === id) { r.master = r.members[0]; r.ready[r.master] = READY; toAll(r, 121, 'room.ChangeMasterRspMsg', { roomId: r.id, masterId: r.master }); }
    toAll(r, 120, 'room.RoomPlayerListMsg', members(r));
    toAll(r, 17, 'room.PlaceStateRspMsg', { placeState: r.places });
  }
  ctx.onClose(c => leave(c));
  // (not C_CAMPAIGN_START: that is also the room's own start, ctx.groupStart)
  for (const n of ['C_ENTER_CASTLE', 'C_PLAYER_SPACE_ENTER']) ctx.before(n, c => leave(c));
  function join(c, r) {
    const id = c.player.id, slot = r.places.indexOf(0);
    if (slot < 0) { alert(c, 'Oda cheia'); return false; }
    r.members.push(id); r.places[slot] = id; r.ready[id] = 0; c.player.roomId = r.id;
    showRoom(c, r);
    return true;
  }
  const today = () => sysTime().slice(0, 10);
  function runs(p) { const g = p.s.groupRuns = p.s.groupRuns || {}; if (g.day !== today()) { g.day = today(); g.count = {}; } return g; }
  ctx.onCampaignCleared.push((c, camp) => { if (CAMPAIGNS.has(camp)) ctx.stat(c, 'groupScene'); });

  // the start (U_C_CAMPAIGN_ENTER = C_CAMPAIGN_START, code 5039): called by logic.js before a normal run;
  // true = handled here
  ctx.groupStart = (c, m) => {
      if (ctx.secretStart && ctx.secretStart(c, m)) return true;
      const r = roomOf(c);
      const camp = m.paraInt2 || (r && r.campaignId), t = CAMPAIGNS.get(camp);
      if (!t) { if (!r) return false; alert(c, 'Selecione uma cena primeiro'); return true; }
      if (r && r.master !== c.player.id) return true;
      const players = r ? r.members.map(id => online.get(id)).filter(Boolean) : [c];
      if (r && r.members.some(id => id !== r.master && r.ready[id] !== READY)) { alert(c, 'Todos os jogadores devem estar prontos'); return true; }
      const low = players.find(o => o.player.s.grades < (t.MinLevel || 0));
      if (low) { alert(c, `${low.player.s.nickName}: Karakter Lv. ${t.MinLevel} necessário`); return true; }
      for (const o of players) {
        if (camp !== 4201 && !ctx.spendWeary(o, WEARY)) continue;   // that member stays behind (its own "Energia insuficiente")
        const g = runs(o.player), n = g.count[camp] || 0;
        g.count[camp] = n + 1;
        const income = n < PER_DAY && !m.paraBool1;
        o.player.roomId = null;
        // a short team gets the campaign buffer the client shows in a PvE room (LM.CAMPAIGN_BUFFER_TEMPLATEID1 / 2:
        // t_s_campaignbuffer 81101 "HP/Saldırı +%50" alone, 81102 +%30 with two; not in the season nest, client isShowPveBuffer)
        const teamBuff = camp === 4201 ? 0 : players.length === 1 ? 50 : players.length === 2 ? 30 : 0;
        ctx.startCampaign(o, camp, { dungeon: camp, income, teamBuff });
        if (!income && camp !== 4201) alert(o, 'Suas entradas premiadas de hoje acabaram; esta entrada não dará recompensa');
      }
      if (r) rooms.delete(r.id);
      log(`[#${c.id}] group scene ${camp} started for ${players.length}`);
      return true;
  };

  return {
    U_C_CAMPAIGN_ROOM_CREATE(c, body) {
      const m = dec(c, 'U_C_CAMPAIGN_ROOM_CREATE', body);
      if (ctx.secretRoom && ctx.secretRoom(c, m)) return;   // Gizli Alan (features/secret.js): a one-player room
      leave(c);
      const r = { id: nextId++, master: c.player.id, members: [], places: [0, 0, 0], ready: {}, campaignId: m.campaignId || 0, password: m.password || '', type: m.roomType || 0 };
      rooms.set(r.id, r);
      join(c, r);
      r.ready[r.master] = READY;
      log(`[#${c.id}] room ${r.id} created`);
    },
    U_C_CAMPAIGN_ROOM_EDIT(c, body) {
      const m = dec(c, 'U_C_CAMPAIGN_ROOM_EDIT', body), r = roomOf(c);
      if (!r || r.master !== c.player.id) return;
      if (m.campaignId && !CAMPAIGNS.has(m.campaignId)) { alert(c, 'Esta cena não foi encontrada'); return; }
      r.campaignId = m.campaignId; r.ready[r.master] = READY;
      toAll(r, 32, 'room.EditRoomRspMsg', edit(r));
      toAll(r, 24, 'room.PlayerReadyRspMsg', readyMsg(r));
    },
    U_C_CAMPAIGN_ROOM_LIST(c, body) {
      const m = dec(c, 'U_C_CAMPAIGN_ROOM_LIST', body);
      sendT(c, 13, 'room.RoomListRspMsg', { room: [...rooms.values()].filter(r => (r.type || 0) === (m.roomType || 0)).map(roomMsg) });
    },
    U_C_ROOM_FIND(c, body) {
      const m = dec(c, 'U_C_ROOM_FIND', body), r = rooms.get(m.roomId);
      if (!r) { alert(c, 'Sala não encontrada'); return; }
      sendT(c, 4370, 'room.RoomMsg', roomMsg(r));
    },
    U_C_CAMPAIGN_ROOM_ENTER(c, body) {
      const m = dec(c, 'U_C_CAMPAIGN_ROOM_ENTER', body), r = rooms.get(m.roomId);
      if (!r) { alert(c, 'Sala não encontrada'); return; }
      if (r.password && r.password !== m.password && !(r.invited || []).includes(c.player.id)) { alert(c, 'Senha da sala incorreta'); return; }
      if (roomOf(c) === r) return;
      leave(c);
      join(c, r);
    },
    U_C_CAMPAIGN_ROOM_EXIT(c) { if (!roomOf(c)) return sendT(c, 15, 'room.RoomExitRspMsg', { playerId: c.player.id }); leave(c); },
    U_C_PLAYER_READY_STATE(c, body) {
      const m = dec(c, 'U_C_PLAYER_READY_STATE', body), r = roomOf(c); if (!r) return;
      r.ready[c.player.id] = m.state || 0;
      toAll(r, 24, 'room.PlayerReadyRspMsg', readyMsg(r));
      toAll(r, 120, 'room.RoomPlayerListMsg', members(r));
    },
    U_C_CAMPAIGN_ROOM_KILLPLAYER(c, body) {
      const m = dec(c, 'U_C_CAMPAIGN_ROOM_KILLPLAYER', body), r = roomOf(c);
      if (!r || r.master !== c.player.id || m.userId === c.player.id || !r.members.includes(m.userId)) return;
      toAll(r, 28, 'room.KillPlayerRspMsg', { roomId: r.id, killedPlayerId: m.userId });
      const kc = online.get(m.userId);
      if (kc) leave(kc, 1);
    },
    U_C_CAMPAIGN_ROOM_MASTER_CHANGE(c, body) {
      const m = dec(c, 'U_C_CAMPAIGN_ROOM_MASTER_CHANGE', body), r = roomOf(c);
      if (!r || r.master !== c.player.id || !r.members.includes(m.paraInt1)) return;
      r.master = m.paraInt1; r.ready[r.master] = READY;
      toAll(r, 121, 'room.ChangeMasterRspMsg', { roomId: r.id, masterId: r.master });
      toAll(r, 120, 'room.RoomPlayerListMsg', members(r));
    },
    // team positions in the room (client RoomManager armyFightPos): the master edits, everyone gets 4186
    // U_C_CAMPAIGN_ARMYPOS_SEND; a request answers with the current ones. Kept for the room view only (each member
    // fights its own instance here)
    C_CAMPIAGN_ARMYPOS_REQ(c) {
      const r = roomOf(c); if (!r) return;
      sendT(c, 4186, 'army.ArmyFightPosEditListMsg', { armyFightPos: r.pos || r.members.map((id, i) => ({ userId: id, heroPos: i, pawnPos: i })) });
    },
    C_CAMPIAGN_ARMYPOS_EDIT(c, body) {
      const m = dec(c, 'C_CAMPIAGN_ARMYPOS_EDIT', body), r = roomOf(c);
      if (!r || r.master !== c.player.id) return;
      r.pos = (m.armyFightPos || []).filter(x => r.members.includes(x.userId)).map(x => ({ userId: x.userId, heroPos: x.heroPos || 0, pawnPos: x.pawnPos || 0 }));
      toAll(r, 4186, 'army.ArmyFightPosEditListMsg', { armyFightPos: r.pos });
    },
    // the master locks / unlocks the room (client sendLockCampaignRoom; empty = no password)
    C_ROOM_PWDCHANGE(c, body) {
      const m = dec(c, 'C_ROOM_PWDCHANGE', body), r = roomOf(c);
      if (!r || r.master !== c.player.id || (m.roomId && m.roomId !== r.id)) return;
      r.password = String(m.roomPwd || '').slice(0, 12);
      toAll(r, 32, 'room.EditRoomRspMsg', edit(r));
      alert(c, r.password ? 'Sala bloqueada' : 'Sala desbloqueada');
    },
    // an invitation's room state (client sendSearchRoomState {param1 roomId, param10 echo}) -> 4913 {param1 id,
    // param2 campaign, param3 room type, param7 in a fight (rooms are gone once started), param10, param11 1 =
    // it exists}
    C_MULITY_CAMPAIGN_REQUEST(c, body) {
      const m = dec(c, 'C_MULITY_CAMPAIGN_REQUEST', body), r = rooms.get(m.param1);
      sendT(c, 4913, 'simple.PropertyMsg', r ? { param1: r.id, param2: r.campaignId || 0, param3: r.type || 0, param7: 0, param10: m.param10 || 0, param11: 1 }
        : { param1: m.param1 || 0, param2: 0, param3: 0, param10: m.param10 || 0, param11: 0 });
      if (!r) alert(c, 'Sala não encontrada');
    },
    U_C_CAMPAIGN_ROOM_INVITE(c, body) {
      const m = dec(c, 'U_C_CAMPAIGN_ROOM_INVITE', body), r = roomOf(c), tc = online.get(m.userId);
      if (!r) return;
      if (!tc) { alert(c, 'Jogador não está online'); return; }
      if (ctx.setting && ctx.setting(tc.player, 'refuseInvite')) { alert(c, 'Este jogador não aceita convites de sala'); return; }   // settings (playerops.js)
      (r.invited = r.invited || []).push(m.userId);
      sendT(tc, 16, 'room.RoomInviteMsg', { roomId: r.id, playerId: c.player.id, nickName: c.player.s.nickName, name: name(r), roomType: r.type || 0, tempId: r.campaignId || 0 });
      alert(c, 'Convite enviado');
    },
    U_C_CAMPAGIN_ROOM_PLACESTATE(c, body) {
      const m = dec(c, 'U_C_CAMPAGIN_ROOM_PLACESTATE', body), r = roomOf(c);
      if (!r || r.master !== c.player.id || m.index < 0 || m.index > 2 || r.places[m.index] > 0) return;
      r.places[m.index] = m.open ? 0 : -1;
      toAll(r, 17, 'room.PlaceStateRspMsg', { placeState: r.places });
    },
    U_C_ROOM_STATE(c, body) { const m = dec(c, 'U_C_ROOM_STATE', body); sendT(c, 25, 'room.RoomStateRspMsg', { roomState: m.state || 0 }); },
    U_C_CAMPAIGN_INVITE_PLAYER_LIST(c) {
      // online players who could join: not in a room or a fight
      const list = [...online.values()].filter(o => o !== c && o.player && !o.player.roomId && !o.battle).slice(0, 20).map(o => member({ id: 0, members: [], ready: {} }, o.player));
      sendT(c, 4161, 'room.RoomPlayerListMsg', { roomPlayer: list });
    },
  };
};
