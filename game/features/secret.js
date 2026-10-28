// Gizli Alan (client PveSecretWnd / PveSecretSceneWnd, SecretManager; t_s_secret 101..108, t_s_secretevent,
// t_s_secretoption, t_s_secrettreasure; config Secret_Live 5). From the 2026-10-23 live capture (secret 106, 25 floors,
// a lost boss fight, a diamond revive, give up) and the client:
//  Start: U_C_CAMPAIGN_ROOM_CREATE {campaignId: secretId, roomType 2, capacity 1, enterType (1 free / 2 the entry
//  item 208079), startType (1 new run / 2 continue)} -> 12 RoomMsg; C_CAMPAIGN_START {paraInt2: secretId} -> 17, 32,
//  120, 4186, 125 RoomCreatedMsg {createdType 1, room}, 21 RoomEnterMsg, 452 AllSecretInfoMsg. Then the client asks
//  C_SECRET_LAYER_INFO -> 455 {secretId, type 1, maxLayer = the record}.
//  452 SecretInfoMsg {secretId, type 1, maxLayer (floor reached), curLayer, eventId, passSecret "101,102,..",
//  curStatus (1 the floor's event open, 3 its fight lost, 4 done: dropItem "tid:n,.." dropType 1), treasure "id:n,..",
//  enterNum (runs today; client MaxEnterCount 2)}. Out of a run: no secretId, curLayer 1, eventId -1.
//  C_SECRET_CHOOSE {secretId, optionId, curLayer, isSkip}: option Type 0 (id 99) = walk on, Type 2 = relic Param1
//  gained / Param2 given up -> 453 SecretTreasureMsg {receiveTreasure, lostTreasure "id,", ownTreasure, type 1};
//  Type 1 = fight Param2 boss "hero,pos" / Param3 troops "pawn,pos|..", Param1 = a relic it uses up, DropId the
//  loot. isSkip 1 (client: the secret already passed or the floor under the record) = no fight, the loot at once
//  (capture: floors 2..24 all skipped). Fight: battle type 3862, map = secretId; lost -> curStatus 3.
//  C_SECRET_OP {secretId, opType, curLayer, payType}: 1 next floor, 2 give up (22 CampaignExitMsg, the client goes
//  home), 3 revive (Secret_Live diamonds) -> 452 curStatus 1 again.
//  Floors (capture + event ids 1 T LL VV, LL = floor + 5 x (secretId - 101)): in each block of 5 floors
//  1 = item choice (HeadId 30 events), 2 = normal fight (T 0), 3 = normal or special fight (T 0, 2..5), 4 = relic
//  choice (HeadId 100, relics of the secret) or, owning a relic, the relic swap / upgrade event naming it, 5 = elite (T 1).
// Our choices: the pick among the matching events is random; relic effects are not modelled (the battle engine has
// no passive skills: their OwnSkill ids are only shown in the hero's skill list); 201 "Zayıflatma İksiri" takes 30 %
// of the enemy hp; a passed secret = its last floor won; sweep (PveSecretMopup) not built.
const SECRET_ITEM = 208079, MAX_ENTER = 2, BATTLE_TYPE = 3862, WALK = 99;

module.exports = (ctx) => {
  const { table, dec, sendT, alert, pay, grant, M, D, CONF, sysTime, log } = ctx;
  const SECRETS = new Map(table('t_s_secret').map(r => [r.SecretId, r]));
  const EVENTS = new Map(table('t_s_secretevent').map(r => [r.EventId, r]));
  const OPTIONS = new Map(table('t_s_secretoption').map(r => [r.OptionId, r]));
  const TREASURE = new Map(table('t_s_secrettreasure').map(r => [r.TreasureId, r]));
  const LIVE = Number(CONF.get('Secret_Live')) || 5;
  const day = () => sysTime().slice(0, 10);
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const opts = e => [e.Option1, e.Option2, e.Option3].filter(Boolean).map(id => OPTIONS.get(id)).filter(Boolean);
  const nums = s => String(s || '').split(',').map(Number).filter(Boolean);

  function state(p) {
    const s = p.s.secret = p.s.secret || { record: {}, pass: [], run: null };
    if (s.day !== day()) { s.day = day(); s.enter = 0; }
    return s;
  }
  const treasureText = t => Object.entries(t || {}).filter(([, n]) => n > 0).map(([id, n]) => `${id}:${n}`).join(',');
  const owned = run => Object.keys(run.treasure).map(Number).filter(id => run.treasure[id] > 0);
  function info(p) {
    const s = state(p), r = s.run;
    const base = { type: 1, passSecret: s.pass.join(','), enterNum: s.enter };
    if (!r) return Object.assign(base, { maxLayer: Math.max(0, ...Object.values(s.record)), curLayer: 1, eventId: -1, curStatus: 1 });
    return Object.assign(base, { secretId: r.id, maxLayer: r.layer, curLayer: r.layer, eventId: r.event, curStatus: r.status, treasure: treasureText(r.treasure) },
      r.drop ? { dropItem: r.drop, dropType: 1 } : {});
  }
  const send = c => sendT(c, 452, 'secret.AllSecretInfoMsg', { allSecretInfoMsg: [info(c.player)] });
  ctx.onLoad.push(c => send(c));

  // ---- the floor's event ----------------------------------------------------------------------------
  function eventFor(sec, layer, run) {
    const off = 5 * (sec.SecretId - 101), ll = layer + off, k = layer % 5;
    const fights = T => [...EVENTS.keys()].filter(id => id < 200000 && Math.floor(id / 10000) % 10 === T && Math.floor(id / 100) % 100 === ll);
    let pool = [];
    if (k === 0) pool = fights(1);
    else if (k === 2) pool = fights(0);
    else if (k === 3) pool = [0, 2, 3, 4, 5].flatMap(fights);
    else if (k === 1) pool = [...EVENTS.values()].filter(e => e.EventId >= 200000 && e.HeadId === 30).map(e => e.EventId);
    else {
      const mine = owned(run).filter(id => (TREASURE.get(id) || {}).Type === 1);
      const swaps = [...EVENTS.values()].filter(e => e.EventId >= 200100 && opts(e).some(o => o.Type === 2 && mine.includes(Number(o.Param2))));
      const allowed = nums(sec.Treasure);
      pool = (swaps.length ? swaps : [...EVENTS.values()].filter(e => e.HeadId === 100 && opts(e).every(o => allowed.includes(Number(o.Param1)))))
        .map(e => e.EventId);
    }
    if (!pool.length) pool = fights(0).length ? fights(0) : [...EVENTS.keys()].filter(id => id < 200000);   // every floor has something
    return pick(pool);
  }
  function startRun(p, sec) {
    const s = state(p);
    s.run = { id: sec.SecretId, layer: 1, status: 1, treasure: {}, drop: '' };
    s.run.event = eventFor(sec, 1, s.run);
  }
  function nextLayer(p) {
    const s = state(p), r = s.run, sec = SECRETS.get(r.id);
    r.layer++; r.status = 1; r.drop = '';
    r.event = eventFor(sec, r.layer, r);
  }
  // a floor won (or walked past): record, passed secret, loot
  function cleared(c, opt) {
    const p = c.player, s = state(p), r = s.run, sec = SECRETS.get(r.id);
    s.record[r.id] = Math.max(s.record[r.id] || 0, r.layer);
    if (r.layer >= sec.MaxLayer && !s.pass.includes(r.id)) s.pass.push(r.id);
    const loot = opt && opt.DropId ? ctx.DROPS.roll(opt.DropId).filter(([, n]) => n > 0) : [];
    if (loot.length && !grant(c, loot)) alert(c, 'Mochila cheia');
    r.status = 4; r.drop = loot.map(([t, n]) => `${t}:${n}`).join(',');
    p.save();
  }
  const useUp = (r, id) => { if (id && r.treasure[id]) r.treasure[id]--; };
  function fight(c, opt) {
    const p = c.player, r = state(p).run;
    const weak = Number(opt.Param1) === 201;
    useUp(r, Number(opt.Param1));
    ctx.startBattle(c, {
      Heros: opt.Param2, Soldiers: opt.Param3, BattleType: BATTLE_TYPE, battleScene: 34, mapTempId: r.id, Level: 80,
      setup(units, prep) {
        const me = prep.heros.find(h => h.userId === p.id);
        const skills = owned(r).map(id => (TREASURE.get(id) || {}).OwnSkill).filter(Boolean);
        if (me && skills.length) me.skillId = [...(me.skillId || []), ...skills];
        if (weak) for (const u of units.filter(x => x.side === 2)) { u.hp = u.start = Math.max(1, Math.floor(u.hp * 0.7)); }
      },
      onEnd(won) {
        const run = state(p).run; if (!run) return;
        if (won) cleared(c, opt); else { run.status = 3; p.save(); }
        send(c);
      },
    });
  }

  // the room / start (grouproom.js asks these first)
  ctx.secretRoom = (c, m) => {
    const sec = SECRETS.get(m.campaignId); if (!sec || m.roomType !== 2) return false;
    sendT(c, 12, 'room.RoomMsg', { roomPlayer: [], roomId: 900000 + c.player.id % 100000, campaignId: sec.SecretId, masterId: c.player.id, name: 'Combate não selecionado', capacity: 1, roomType: 2 });
    c.player.secretStart = { id: sec.SecretId, useItem: m.enterType === 2, cont: m.startType === 2 };
    return true;
  };
  ctx.secretStart = (c, m) => {
    const p = c.player, sec = SECRETS.get(m.paraInt2), want = p.secretStart;
    if (!sec || !want || want.id !== sec.SecretId) return false;
    p.secretStart = null;
    const s = state(p);
    if (p.s.grades < sec.NeedGrade) { alert(c, `Lv. ${sec.NeedGrade} necessário`); return true; }
    if (sec.PreSecret && !s.pass.includes(sec.PreSecret)) { alert(c, `${ctx.nameOf(SECRETS.get(sec.PreSecret), 'Name')} deve ser concluído`); return true; }
    if (!(want.cont && s.run && s.run.id === sec.SecretId)) {
      if (s.enter >= MAX_ENTER) {
        const it = want.useItem && p.s.bag.find(i => i.templateId === SECRET_ITEM && (i.bagType ?? 1) === 1);
        if (!it) { alert(c, 'Suas entradas de hoje acabaram'); return true; }
        p.removeItem(it, 1); ctx.sendItems(c, [M.movedEntry(p, it, it.count <= 0)]);
      } else s.enter++;
      startRun(p, sec);
    }
    p.save();
    const room = { roomPlayer: [{ playerId: p.id, grades: p.s.grades, nickName: p.s.nickName, job: p.s.job, tarIds: [] }], roomId: 900000 + p.id % 100000, campaignId: sec.SecretId,
      masterId: p.id, name: 'Combate não selecionado', count: 1, capacity: 1, roomState: 1, roomType: 2 };
    sendT(c, 17, 'room.PlaceStateRspMsg', { placeState: [p.id] });
    sendT(c, 32, 'room.EditRoomRspMsg', { roomId: room.roomId, startCampaignId: sec.SecretId, masterId: p.id, count: 1, capacity: 1, roomName: room.name });
    sendT(c, 4186, 'army.ArmyFightPosEditListMsg', { armyFightPos: [{ userId: p.id, heroPos: 2 }] });
    sendT(c, 125, 'room.RoomCreatedMsg', { createdType: 1, room });
    const a = M.mapArmy(p);
    sendT(c, 21, 'room.RoomEnterMsg', { player: [{ roomId: room.roomId, count: 1, playerState: 2, heroId: p.heroId, playerId: p.id, grades: p.s.grades, nickName: p.s.nickName,
      templateId: p.s.icon, arm: a.arm, cloth: a.cloth, armyId: p.armyId, fightingCapacity: p.fightingCapacity(), onlineState: true, job: p.s.job,
      hp: p.stats().total.live, maxHp: p.stats().total.live, tarIds: [] }], userIds: [], result: 1 });
    ctx.stat(c, 'secretEnter');
    send(c);
    log(`[#${c.id}] secret ${sec.SecretId} ${want.cont ? 'continued' : 'started'} at floor ${s.run.layer}`);
    return true;
  };

  return {
    C_SECRET_LAYER_INFO(c) {
      const s = state(c.player);
      const list = Object.entries(s.record).map(([id, n]) => ({ secretId: Number(id), type: 1, maxLayer: n }));
      sendT(c, 455, 'secret.AllSecretInfoMsg', { allSecretInfoMsg: list });
    },
    C_SECRET_CHOOSE(c, body) {
      const m = dec(c, 'C_SECRET_CHOOSE', body), p = c.player, s = state(p), r = s.run;
      if (!r || r.id !== m.secretId || r.layer !== m.curLayer || r.status !== 1 || c.battle) return send(c);
      const e = EVENTS.get(r.event), opt = OPTIONS.get(m.optionId);
      if (!e || !opt || ![e.Option1, e.Option2, e.Option3].includes(m.optionId)) return send(c);
      if (opt.Type === 0) { nextLayer(p); p.save(); return send(c); }   // walk on (capture: 452 with the next floor)
      if (opt.Type === 2) {
        const gain = Number(opt.Param1), lose = Number(opt.Param2);
        if (lose && !r.treasure[lose]) { alert(c, 'Você não possui as relíquias necessárias'); return; }
        useUp(r, lose);
        r.treasure[gain] = (r.treasure[gain] || 0) + 1;
        r.status = 4; p.save();
        sendT(c, 453, 'secret.SecretTreasureMsg', Object.assign({ receiveTreasure: String(gain), ownTreasure: treasureText(r.treasure), type: 1 }, lose ? { lostTreasure: `${lose},` } : {}));
        return;
      }
      // a fight: the relic it needs, then skip (passed secret / under the record) or the battle
      const need = Number(opt.Param1);
      if (need && !r.treasure[need]) { alert(c, 'Você não possui as relíquias necessárias'); return; }
      if (m.isSkip && (s.pass.includes(r.id) || r.layer < (s.record[r.id] || 0))) { useUp(r, need); cleared(c, opt); return send(c); }
      fight(c, opt);
    },
    C_SECRET_OP(c, body) {
      const m = dec(c, 'C_SECRET_OP', body), p = c.player, s = state(p), r = s.run;
      if (m.opType === 2) {   // give up: the run ends
        s.run = null; p.save();
        sendT(c, 22, 'campaign.CampaignExitMsg', { userIds: [], result: 1, playerId: p.id, armyId: p.armyId });
        return;
      }
      if (!r || r.id !== m.secretId) return send(c);
      if (m.opType === 1) {
        if (r.status !== 4 || r.layer !== m.curLayer) return send(c);
        if (r.layer >= SECRETS.get(r.id).MaxLayer) { alert(c, 'Área Secreta concluída'); return send(c); }
        nextLayer(p); p.save();
        return send(c);
      }
      if (m.opType === 3) {   // revive: the lost floor's event again
        if (r.status !== 3) return send(c);
        // payType 2 = bound diamonds (client YI.BindDiamond, capture), else diamonds
        const bound = m.payType === 2 && ctx.balance(p, -500) >= LIVE;
        if (!pay(c, [[bound ? -500 : -400, LIVE]])) { alert(c, 'Diamantes insuficientes'); return; }
        r.status = 1; p.save(); ctx.sendPlayer(c);
        return send(c);
      }
    },
  };
};
