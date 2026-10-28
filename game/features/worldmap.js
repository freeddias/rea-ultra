// Outer city (world map 5) presence: every player's army on the map, visible to the others who look at
// that part of the map, moving, returning home. The capture never opened the map (its army stayed at the
// town "Kasaba", 361,1314, the castle node every character shares in this client version); requests and
// replies follow the client (OuterCitySocketOutManager g4, OuterCityManager listeners):
//  U_C_USER_DISPLAY {mapId, position}  the 9 screens around the camera ("gx_gy,..." of 1000 px files)
//  U_C_ARMY_UPDATE_GRID {mapId, files} -> 169 ArmyUpdatedGridMsg {updatedArmy: ArmyMsg[]} in those files
//  C_PHYSICLIST_BYGRID {mapId, reqGrid} -> 4129 PhysicListUpdateMsg (wild lands: none yet, our castle)
//  C_MOVE_POS PosMoveMsg {routes px, armyId, gridStr, mapId} -> the others watching: 4167 U_C_BROAD_POS
//  C_ARMYPOS_REQUEST -> 4241 ArmyPositionMsg; U_C_ARMY_RETURNHOME -> 98 OutercityRspMsg {result: armyId}
//  leaving (castle, campaign, square, disconnect) -> the others: 4168 ArmyRemoveMsg
// Positions: armies in 20 px tiles (client x = curPosX * 20), files are floor(px / 1000).
const MAP = 5, TILE = 20, FILE = 1000;

module.exports = (ctx) => {
  const { dec, sendT, online, M, log } = ctx;
  const viewers = new Map();   // connection -> { files: Set, known: Set(armyId) }
  const pos = p => p.s.worldPos || { mapId: MAP, x: p.s.castle.posX, y: p.s.castle.posY };
  const fileOf = (x, y) => `${Math.floor(x * TILE / FILE)}_${Math.floor(y * TILE / FILE)}`;
  const files = s => new Set(String(s || '').split(',').map(x => x.trim()).filter(Boolean));
  const armyOf = p => { const w = pos(p); return Object.assign(M.armyMsg(p), { mapId: w.mapId, curPosX: w.x, curPosY: w.y, type: 2 }); };

  function leave(c) {
    const v = viewers.get(c); if (!v || !c.player) return;
    viewers.delete(c);
    c.player.save();   // keeps worldPos (moves only change it in memory)
    for (const [o, ov] of viewers) if (ov.known.delete(c.player.armyId)) sendT(o, 4168, 'army.ArmyRemoveMsg', { armyId: c.player.armyId });
  }
  ctx.onClose(leave);
  // the login messages place the army at the castle node (ArmyMsg / U_C_SERIAL_ARMY): start from there
  ctx.onLoad.push(c => { c.player.s.worldPos = null; });
  for (const name of ['C_ENTER_CASTLE', 'C_CAMPAIGN_START', 'U_C_CAMPAIGN_TRAINING', 'C_PLAYER_SPACE_ENTER']) ctx.before(name, c => leave(c));
  const view = c => { let v = viewers.get(c); if (!v) viewers.set(c, v = { files: new Set(), known: new Set() }); return v; };
  // tell everyone watching p's file about p (first sight) or that p left their view
  function announce(c) {
    const p = c.player, f = fileOf(pos(p).x, pos(p).y);
    for (const [o, v] of viewers) {
      if (o === c) continue;
      if (v.files.has(f) && !v.known.has(p.armyId)) { v.known.add(p.armyId); sendT(o, 169, 'army.ArmyUpdatedGridMsg', { updatedArmy: [armyOf(p)] }); }
    }
  }

  return {
    U_C_USER_DISPLAY(c, body) {
      const m = dec(c, 'U_C_USER_DISPLAY', body);
      view(c).files = files(m.position);
      announce(c);
    },
    U_C_ARMY_UPDATE_GRID(c, body) {
      const m = dec(c, 'U_C_ARMY_UPDATE_GRID', body), want = files(m.files), v = view(c);
      for (const f of want) v.files.add(f);
      const list = [armyOf(c.player)];
      for (const [o] of viewers) {
        if (o === c || !o.player) continue;
        const w = pos(o.player);
        if (w.mapId === (m.mapId || MAP) && want.has(fileOf(w.x, w.y))) { list.push(armyOf(o.player)); v.known.add(o.player.armyId); }
      }
      sendT(c, 169, 'army.ArmyUpdatedGridMsg', { updatedArmy: list });
      announce(c);
    },
    C_PHYSICLIST_BYGRID(c, body) {
      const m = dec(c, 'C_PHYSICLIST_BYGRID', body), p = c.player, want = files(m.reqGrid);
      const castle = want.has(fileOf(p.s.castle.posX, p.s.castle.posY)) ? [M.castleMsg(p)] : [];
      const wild = ctx.wildLandsIn ? ctx.wildLandsIn(m.mapId || MAP, want) : [];   // field monsters (fieldmonster.js)
      sendT(c, 4129, 'army.PhysicListUpdateMsg', { wildLand: wild, baseCastle: castle, reqGrid: m.reqGrid || '' });
    },
    C_MOVE_POS(c, body) {
      const m = c.decode('worldmap.PosMoveMsg', body), p = c.player;   // not in codemap: the client's R4 (sendWalkPathII)
      const routes = (m.routes || []).slice(0, 200);
      if (!routes.length) return;
      const last = routes[routes.length - 1];
      p.s.worldPos = { mapId: m.mapId || MAP, x: Math.max(0, Math.floor(last.x / TILE)), y: Math.max(0, Math.floor(last.y / TILE)) };
      const from = files(m.gridStr), to = fileOf(p.s.worldPos.x, p.s.worldPos.y);
      const msg = { routes, mapId: p.s.worldPos.mapId, armyId: p.armyId, gridStr: m.gridStr || '', armyUserId: p.id, headId: p.s.icon, moveType: m.moveType || 0, armyState: 0, userStates: [], userId: [] };
      for (const [o, v] of viewers) {
        if (o === c) continue;
        if (v.known.has(p.armyId)) sendT(o, 4167, 'worldmap.PosMoveMsg', msg);
        else if (v.files.has(to) || [...from].some(f => v.files.has(f))) { v.known.add(p.armyId); sendT(o, 169, 'army.ArmyUpdatedGridMsg', { updatedArmy: [armyOf(p)] }); }
      }
    },
    C_ARMYPOS_REQUEST(c) {
      const w = pos(c.player);
      sendT(c, 4241, 'army.ArmyPositionMsg', { mapId: w.mapId, posX: w.x, posY: w.y });
    },
    // teleport (client TransmitHandler.senPosation {posX, posY tiles, payType}): payType 0 = one Enerji Taşı
    // (2131056), 1 = 100 diamonds, 2 = 100 bound diamonds first (client promptCallback) -> 4237 {posX, posY,
    // leftEnergy}; the others watching see a one-step jump as for U_C_ARMY_RETURNHOME
    C_ARMY_POSATION(c, body) {
      const m = dec(c, 'C_ARMY_POSATION', body), p = c.player, PRICE = 100;
      if (!(m.posX >= 0) || !(m.posY >= 0)) return;
      if (m.payType === 0) {
        const it = p.takeTemplate(2131056, 1);
        if (!it.length) { ctx.alert(c, 'Sem Pedra de Energia'); return; }
        ctx.sendItems(c, it.map(x => M.movedEntry(p, x, x.count <= 0)));
      } else {
        const bound = m.payType === 2 && ctx.balance(p, -500) >= PRICE;
        if (!ctx.pay(c, [[bound ? -500 : -400, PRICE]])) { ctx.alert(c, 'Diamantes insuficientes'); return; }
      }
      p.s.worldPos = { mapId: MAP, x: m.posX, y: m.posY };
      p.save();
      sendT(c, 4237, 'army.ArmyPositionMsg', { mapId: MAP, posX: m.posX, posY: m.posY, leftEnergy: 0 });
      const jump = { routes: [{ x: m.posX * TILE, y: m.posY * TILE }], mapId: MAP, armyId: p.armyId, armyUserId: p.id, headId: p.s.icon, userStates: [], userId: [] };
      for (const [o, v] of viewers) if (o !== c && v.known.has(p.armyId)) sendT(o, 4167, 'worldmap.PosMoveMsg', jump);
      log(`[#${c.id}] army teleport ${m.posX},${m.posY}`);
    },
    U_C_ARMY_RETURNHOME(c) {
      const p = c.player, from = pos(p);
      p.s.worldPos = { mapId: MAP, x: p.s.castle.posX, y: p.s.castle.posY };
      p.save();
      sendT(c, 98, 'outercity.OutercityRspMsg', { result: p.armyId, startPosX: from.x, startPosY: from.y, curPosX: p.s.worldPos.x, curPosY: p.s.worldPos.y, endPosX: p.s.worldPos.x, endPosY: p.s.worldPos.y });
      const jump = { routes: [{ x: p.s.worldPos.x * TILE, y: p.s.worldPos.y * TILE }], mapId: MAP, armyId: p.armyId, armyUserId: p.id, headId: p.s.icon, userStates: [], userId: [] };
      for (const [o, v] of viewers) if (o !== c && v.known.has(p.armyId)) sendT(o, 4167, 'worldmap.PosMoveMsg', jump);
      log(`[#${c.id}] army home`);
    },
  };
};
