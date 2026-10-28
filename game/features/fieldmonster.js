// Dış şehir canavarları (world map 5): the map had none — nothing to attack, no boss list of our own (the
// boss list 4938 was the official server's recorded copy). Everything comes from t_s_mapphysicposition:
//  Type 4 field bosses (15, RefreshNum 1 each), 5 elites (8 x 50), 6 common monsters (9 x 100); Grade,
//  Heroes / Soldiers, Property1 = DropId of the reward (e.g. 601 Orman Kurdu Lv20 -> 107120: Gizemli Taş x1 +
//  15,000 gold), RefreshMinute = respawn time, RefreshCoordinateRange "x1,y1,x2,y2|..." = spawn rectangles in
//  map tiles (20 px; map 5 is 30,000 px = 1500 tiles).
//  Client: wild land types 4/5/6 (Gl.OUTERCITY_BOSS_NPC / COMMON_JINGYING / COMMON_NPC); tempInfo is the
//  position row (templateId = row ID); state 0 (Bl.NONE) removes the node.
//  C_PHYSICLIST_BYGRID (worldmap.js) lists the ones in the requested files; U_C_ARMY_ATTACK without nodeId at
//  a monster's tile (mine.js forwards it here) fights its troops/hero; a win gives the drop and removes it for
//  everyone (140 MapUpdatedMsg updatedType 1 with state 0) until it respawns elsewhere in its rectangles.
//  C_MAPBOSS_DATAS -> 4938 MapBossMsg: the field bosses (alive: state 1; fallen: state 0 + seconds to respawn).
// Monsters live in memory: a restart spawns them all again.
const MAP = 5, TILE = 20, FILE = 1000;

module.exports = (ctx) => {
  const { dec, sendT, table, alert, chat, online, grant, DROPS, rewardName, log, stat } = ctx;
  const ROWS = table('t_s_mapphysicposition').filter(r => [4, 5, 6].includes(Number(r.Type)))
    .map(r => Object.assign({}, r, { ID: Number(r.ID), Type: Number(r.Type), Grade: Number(r.Grade),
      rects: String(r.RefreshCoordinateRange || '').split('|').map(x => x.split(',').map(Number)).filter(a => a.length === 4) }))
    .filter(r => r.rects.length);
  const fileOf = (x, y) => `${Math.floor(x * TILE / FILE)}_${Math.floor(y * TILE / FILE)}`;
  const mobs = new Map();     // id -> { id, row, x, y, alive, respawnAt }
  const byTile = new Map();   // "x,y" -> id (alive ones)
  let seq = 9100000;

  function place(m) {
    const r = m.row, area = q => Math.max(1, (q[2] - q[0]) * (q[3] - q[1]));
    const total = r.rects.reduce((n, q) => n + area(q), 0);
    for (let tries = 0; tries < 50; tries++) {
      let x = Math.random() * total, q = r.rects[0];
      for (const z of r.rects) { x -= area(z); if (x < 0) { q = z; break; } }
      const tx = q[0] + Math.floor(Math.random() * (q[2] - q[0] + 1)), ty = q[1] + Math.floor(Math.random() * (q[3] - q[1] + 1));
      if (byTile.has(tx + ',' + ty)) continue;
      m.x = tx; m.y = ty; m.alive = true; m.respawnAt = 0;
      byTile.set(tx + ',' + ty, m.id);
      return true;
    }
    return false;
  }
  for (const r of ROWS) for (let i = 0; i < (Number(r.RefreshNum) || 1); i++) { const m = { id: seq++, row: r }; mobs.set(m.id, m); place(m); }
  log(`field monsters: ${mobs.size} on map ${MAP}`);

  function respawnDue() {
    const now = Date.now();
    for (const m of mobs.values()) if (!m.alive && m.respawnAt <= now && place(m)) broadcast(m);
  }
  setInterval(respawnDue, 30000).unref();

  function soldiers(row) {
    return String(row.Soldiers || '').split('|').filter(Boolean).slice(0, 2).map((s, i) => { const [tid] = s.split(',').map(Number); return { id: i + 1, armyId: 0, tempateId: tid, ownPawns: 1 }; });
  }
  const wildMsg = m => ({ id: m.id, mapId: MAP, posX: m.x, posY: m.y, templateId: m.row.ID, type: m.row.Type, level: m.row.Grade,
    state: m.alive ? 1 : 0, refreshTime: 0, armyPawn: soldiers(m.row), allNodeInfo: [], occupyNodeInfo: [], curArmyId: [], occupyPlayerName: '', occupyLeagueName: '' });
  function broadcast(m) {
    for (const c of online.values()) sendT(c, 140, 'army.MapUpdatedMsg', { updatedType: 1, wildLand: wildMsg(m) });
  }
  // for worldmap.js C_PHYSICLIST_BYGRID
  ctx.wildLandsIn = (mapId, files) => {
    if ((mapId || MAP) !== MAP) return [];
    respawnDue();
    const out = [];
    for (const m of mobs.values()) if (m.alive && files.has(fileOf(m.x, m.y))) out.push(wildMsg(m));
    return out;
  };

  // for mine.js U_C_ARMY_ATTACK without a mine node; true when it was a monster
  ctx.attackWild = (c, msg) => {
    if ((msg.mapId || MAP) !== MAP) return false;
    const id = byTile.get(msg.posX + ',' + msg.posY), m = id && mobs.get(id);
    if (!m || !m.alive) return false;
    if (c.battle) return true;
    const r = m.row;
    const onEnd = won => {
      if (!won) { alert(c, 'Ataque falhou'); return; }
      if (!m.alive) { alert(c, 'Este monstro foi derrotado por outro jogador'); return; }
      m.alive = false; m.respawnAt = Date.now() + (Number(r.RefreshMinute) || 15) * 60000;
      byTile.delete(m.x + ',' + m.y);
      broadcast(m);
      const loot = DROPS.roll(Number(r.Property1)).filter(([, n]) => n > 0);
      if (loot.length && !grant(c, loot, { quiet: true })) {
        const items = loot.filter(([t]) => t > 0);
        grant(c, loot.filter(([t]) => t < 0), { quiet: true });
        if (items.length && ctx.sendMail) ctx.sendMail(c.player.id, { title: ctx.nameOf(r, 'Name'), contents: `${ctx.nameOf(r, 'Name')} - loot enviado pelo correio (mochila cheia)`, annex: items, sendType: 4 });
      }
      const text = `Obtido:${loot.map(([t, n]) => `${rewardName(t)} x${n}`).join(' ')}`;
      if (loot.length) { alert(c, text); chat(c, text); }
      log(`[#${c.id}] field monster ${r.Name_tr} Lv${r.Grade} (${m.id}) defeated`);
      stat(c, r.Type === 5 ? 'fieldElite' : r.Type === 6 ? 'fieldCommon' : 'fieldBoss');   // daily activity 39 / 40
    };
    ctx.startBattle(c, { Soldiers: r.Soldiers, Heros: r.Heroes, BattleType: 3841, battleScene: 5, mapTempId: MAP, Level: r.Grade, onEnd });   // 2026-10-23 capture: outer city monster = type 3841, scene 5
    return true;
  };

  return {
    C_MAPBOSS_DATAS(c, body) {
      const m = dec(c, 'C_MAPBOSS_DATAS', body);
      respawnDue();
      const now = Date.now();
      const bosslist = (m.mapId || MAP) !== MAP ? [] : [...mobs.values()].filter(x => x.row.Type === 4).map(x => ({
        bossName: ctx.nameOf(x.row, 'Name'), grade: x.row.Grade, type: 1, posX: x.x || 0, posY: x.y || 0, physicId: x.id, posId: x.row.ID,
        state: x.alive ? 1 : 0, leftTime: x.alive ? 0 : Math.max(0, Math.ceil((x.respawnAt - now) / 1000)), uuid: String(x.id) }));
      sendT(c, 4938, 'army.MapBossMsg', { bosslist, count1: 0, count2: 0, count3: 0, leftFogTime: 0 });
    },
  };
};
