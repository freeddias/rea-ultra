// Lonca Labirenti (guild maze; client TT / ConsortiaMazeModel, ConsortiaMazeWnd; t_s_guildmaze 10 floors,
// t_s_guildmazeevent, t_s_guildmazebattle 12 guards a floor, t_s_guildmazetask, t_s_guildmazelist; config
// t_s_Guildmaze_pick 10, t_s_Guildmaze_fight 3, t_s_Guildmaze_time "6,12|20,26"). Client-derived (help texts
// ConsortiaMazeWnd / ConsortiaMazeChallengeWnd / ConsortiaMazeTreasureWnd), no capture:
//  One grid per guild (EventGrid "W*H"; data pos = y * W + x). Every cell starts as a brick (EventGroup2: durability
//  1 / 2 = Type 5 / 6); EventGroup1 events lie under them: the guard seal (Type 1), big treasures (2), small
//  treasures (3), placed inside each event's Coordinate "x1,y1|x2,y2" (1-based); the portal (4, RefreshType 2)
//  appears on the guard seal once the floor is done. C_GUILD_MAZE_OP {opType, pos, levelId}: 1 enter, 2 leave,
//  3 pick pos (a brick: one action, 2 for the hard one; a small treasure: its finder takes Reward1; a big treasure:
//  every member takes Reward2 once once it is fully dug (client checkAroundGridUnlock: all 8 neighbours empty); the
//  portal: chairman / vice only, next floor), 4 fight guard pos = t_s_guildmazebattle id (unlocked when every big
//  treasure is found and the seal is dug free; one attack; Property "hero,pos"; shared hp), 5 take a beaten guard's
//  Reward1 (every member once), 6 take a task reward, 8 damage ranking.
//  -> 869 GuildMazeMsg {levelId, defaultEventId, grid (cells that differ from the default brick), boss [{bossId, hp,
//  maxHp}]}, 870 one cell, 871 one guard, 872 / 873 tasks [{templateId, count, state 0 / 1 done / 2 taken}], 874 user
//  {pickCount, fightCount (both left today), bossReward, boxReward (taken ids)}, 879 ranking, 880 active
//  {startTime, stopTime}. A small treasure is shown only to its finder (client: ownerUserId).
// Our choices: the activity runs on days 6..12 and 20..26 of each month (t_s_Guildmaze_time; the start date is a
// 6th); a new run starts on floor 101; a fight lasts at most 10 turns; the rare small treasure is not placed (no
// reward in its row); the end-of-run ranking rewards (t_s_guildmazelist) are not paid out.
const G = require('../guilds');

module.exports = (ctx) => {
  const { D, table, dec, sendT, alert, grant, CONF, sysTime, log, playerById } = ctx;
  const FLOORS = new Map(table('t_s_guildmaze').map(r => [r.TemplateId, r]));
  const EVENTS = new Map(table('t_s_guildmazeevent').map(r => [r.EventId, r]));
  const BATTLE = table('t_s_guildmazebattle'), TASKS = table('t_s_guildmazetask');
  const PICKS = Number(CONF.str('t_s_Guildmaze_pick')) || 10, FIGHTS = Number(CONF.str('t_s_Guildmaze_fight')) || 3;
  const WINDOWS = String(CONF.str('t_s_Guildmaze_time') || '6,12|20,26').split('|').map(x => x.split(',').map(Number));
  const parse = s => String(s || '').split('|').map(x => x.split(',').map(Number)).filter(([t, n]) => t && n);
  const z = n => String(n).padStart(2, '0'), day = () => sysTime().slice(0, 10);
  const size = f => String(f.EventGrid).split('*').map(Number);   // [W, H]
  const type = id => (EVENTS.get(id) || {}).Type || 0;
  function windowNow() {
    const d = new Date(), dd = d.getDate(), ym = `${d.getFullYear()}-${z(d.getMonth() + 1)}`;
    const w = WINDOWS.find(([a, b]) => dd >= a && dd <= b) || WINDOWS.find(([a]) => dd < a) || WINDOWS[0];
    const cal = (dd >= w[0] && dd <= w[1]) || !!process.env.GUILDMAZE_OPEN;
    const f = ctx.events && ctx.events.force('guildMaze');
    const open = f === true ? true : f === false ? false : cal;
    return { open, key: `${ym}-${w[0]}`, start: `${ym}-${z(w[0])} 00:00:00`, stop: `${ym}-${z(w[1])} 23:59:59` };
  }
  if (ctx.events) ctx.events.register('guildMaze', () => {
    const d = new Date(), dd = d.getDate();
    return WINDOWS.some(([a, b]) => dd >= a && dd <= b) || !!process.env.GUILDMAZE_OPEN;
  });
  // ---- the guild's maze ----
  function newFloor(levelId) {
    const f = FLOORS.get(levelId), [W, H] = size(f), cells = W * H;
    const bricks = parse(f.EventGroup2), brick = bricks.sort((a, b) => b[1] - a[1])[0][0], hard = bricks.find(([id]) => id !== brick);
    const top = new Array(cells).fill(brick), hidden = new Array(cells).fill(0);
    const free = new Set(Array.from({ length: cells }, (_, i) => i));
    if (hard) { const all = [...free].sort(() => Math.random() - 0.5).slice(0, hard[1]); for (const i of all) top[i] = hard[0]; }
    const groups = parse(f.EventGroup1).filter(([id]) => type(id) !== 4).sort((a, b) => (EVENTS.get(a[0]).Priority || 0) - (EVENTS.get(b[0]).Priority || 0));
    for (const [id, n] of groups) {
      const e = EVENTS.get(id), c = String(e.Coordinate || '').split('|').map(x => x.split(',').map(Number));
      const [[x1, y1], [x2, y2]] = c.length === 2 ? c : [[1, 1], [W, H]];
      const area = [...free].filter(i => { const x = i % W + 1, y = Math.floor(i / W) + 1; return x >= x1 && x <= x2 && y >= y1 && y <= y2; })
        .filter(i => type(id) === 3 || neighbours(f, i).every(j => !hidden[j]));   // big events keep their neighbours free (they must be dug clear)
      for (let k = 0; k < n && area.length; k++) { const i = area.splice(Math.floor(Math.random() * area.length), 1)[0]; hidden[i] = id; free.delete(i); }
    }
    const boss = {}; for (const r of BATTLE.filter(b => b.FloorId === levelId)) { const t = D.heroes.get(Number(String(r.Property).split(',')[0])) || {}; boss[r.TemplateId] = { hp: t.Live || 1, max: t.Live || 1, dmg: {} }; }
    return { levelId, top, hidden, owner: {}, boss, done: false };
  }
  function maze(g) {
    const w = windowNow();
    if (!g.maze || g.maze.key !== w.key) g.maze = { key: w.key, floor: newFloor(101), floors: 0, picks: 0, boxes: 0, fights: 0 };
    return g.maze;
  }
  function neighbours(f, i) {
    const [W, H] = size(f), x = i % W, y = Math.floor(i / W), out = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const a = x + dx, b = y + dy; if (a >= 0 && a < W && b >= 0 && b < H) out.push(b * W + a); }
    return out;
  }
  // what a cell shows: a brick until broken, then its event (0 = empty)
  const shown = (fl, i) => fl.top[i] || fl.hidden[i];
  const clear = (fl, i) => neighbours(FLOORS.get(fl.levelId), i).every(j => shown(fl, j) === 0);
  const cell = (fl, i) => ({ pos: i, eventId: shown(fl, i), ownerUserId: !fl.top[i] && type(fl.hidden[i]) === 3 ? fl.owner[i] || 0 : 0, hideEventId: 0 });
  const bigFound = fl => fl.hidden.every((id, i) => type(id) !== 2 || (!fl.top[i] && clear(fl, i)));
  const seal = fl => fl.hidden.findIndex(id => type(id) === 1);
  const guardsOpen = fl => { const s = seal(fl); return bigFound(fl) && s >= 0 && !fl.top[s] && clear(fl, s); };
  const user = (p, m) => {
    const u = p.s.guildMaze = p.s.guildMaze || {};
    if (u.key !== m.key) Object.assign(u, { key: m.key, boss: [], box: [], tasks: {}, picks: 0, smalls: 0, fights: 0 });
    if (u.day !== day()) Object.assign(u, { day: day(), pickLeft: PICKS, fightLeft: FIGHTS });
    return u;
  };
  // ---- messages ----
  function sendAll(c, g) {
    const m = maze(g), fl = m.floor, def = fl.top[0] && parse(FLOORS.get(fl.levelId).EventGroup2).sort((a, b) => b[1] - a[1])[0][0];
    const grid = fl.top.map((_, i) => cell(fl, i)).filter(x => x.eventId !== def || x.ownerUserId);
    sendT(c, 869, 'guildmaze.GuildMazeMsg', { levelId: fl.levelId, defaultEventId: def, grid, boss: Object.entries(fl.boss).map(([id, b]) => ({ bossId: Number(id), hp: b.hp, maxHp: b.max })) });
    sendUser(c, m); sendTasks(c, g, 872);
  }
  const sendUser = (c, m) => { const u = user(c.player, m); sendT(c, 874, 'guildmaze.GuildMazeUserMsg', { pickCount: u.pickLeft, fightCount: u.fightLeft, bossReward: u.boss.slice(), boxReward: u.box.slice() }); };
  function taskList(p, m) {
    const u = user(p, m), done = TASKS.filter(t => t.MasterType === 1 && t.SonType !== 4 && progress(t, u, m) >= t.PassCount).length;
    return TASKS.map(t => { const n = t.SonType === 4 ? done : progress(t, u, m); return { templateId: t.TemplateId, count: n, state: u.tasks[t.TemplateId] ? 2 : n >= t.PassCount ? 1 : 0 }; });
  }
  const progress = (t, u, m) => ({ 1: u.picks, 2: u.smalls, 3: u.fights, 10: m.floors, 11: m.picks, 12: m.boxes, 13: m.fights }[t.SonType] || 0);
  const sendTasks = (c, g, code = 873) => sendT(c, code, code === 872 ? 'guildmaze.GuildMazeTaskListMsg' : 'guildmaze.GuildMazeTaskUpdateMsg', { task: taskList(c.player, maze(g)) });
  // a changed cell / guard to every member online
  const members = g => [...ctx.online.values()].filter(x => x.player && x.player.s.guild && x.player.s.guild.id === g.id);
  const pushCell = (g, i) => { for (const x of members(g)) sendT(x, 870, 'guildmaze.GuildMazeGridUpdateMsg', { grid: cell(maze(g).floor, i) }); };
  const pushBoss = (g, id) => { const b = maze(g).floor.boss[id]; for (const x of members(g)) sendT(x, 871, 'guildmaze.GuildMazeBossUpdateMsg', { boss: { bossId: Number(id), hp: b.hp, maxHp: b.max } }); };
  ctx.onLoad.push(c => { const w = windowNow(); sendT(c, 880, 'guildmaze.GuildMazeActiveMsg', { startTime: w.start, stopTime: w.stop }); });

  return {
    C_GUILD_MAZE_OP(c, body) {
      const m = dec(c, 'C_GUILD_MAZE_OP', body), p = c.player, gm = p.s.guild, g = gm && G.get(gm.id);
      if (!g) { alert(c, 'Entre em uma guilda primeiro'); return; }
      if (!windowNow().open && m.opType !== 2) { alert(c, 'Labirinto da Guilda está fechado agora'); return; }
      const mz = maze(g), fl = mz.floor, u = user(p, mz), i = m.pos;
      switch (m.opType) {
        case 1: return sendAll(c, g);
        case 2: return;
        case 3: {
          if (!(i >= 0 && i < fl.top.length)) return;
          const t = type(shown(fl, i));
          if (fl.top[i]) {   // a brick
            if (u.pickLeft <= 0) { alert(c, 'Ações esgotadas'); return; }
            u.pickLeft--; u.picks++; mz.picks++;
            fl.top[i] = type(fl.top[i]) === 6 ? parse(FLOORS.get(fl.levelId).EventGroup2).sort((a, b) => b[1] - a[1])[0][0] : 0;
            if (!fl.top[i] && type(fl.hidden[i]) === 3) fl.owner[i] = p.id;
            pushCell(g, i);
          } else if (t === 3) {   // a small treasure: its finder takes it
            if (fl.owner[i] !== p.id) return;
            grant(c, parse(EVENTS.get(fl.hidden[i]).Reward1)); fl.hidden[i] = 0; delete fl.owner[i]; u.smalls++; mz.boxes++;
            sendT(c, 870, 'guildmaze.GuildMazeGridUpdateMsg', { grid: cell(fl, i) });
          } else if (t === 2) {   // a big treasure, once dug free: every member once
            const id = fl.hidden[i];
            if (!clear(fl, i)) { alert(c, 'Escavação não concluída'); return; }
            if (u.box.includes(id)) { alert(c, 'Você já recebeu esta recompensa'); return; }
            if (!grant(c, parse(EVENTS.get(id).Reward2))) { alert(c, 'Mochila cheia'); return; }
            u.box.push(id);
          } else if (t === 4) {   // the portal: the chairman / vice opens the next floor
            if (![1, 2].includes(gm.duty)) { alert(c, 'Somente o líder ou vice-líder da guilda pode fazer isso'); return; }
            const next = EVENTS.get(fl.hidden[i]).Property;
            if (!FLOORS.has(next)) return;
            mz.floor = newFloor(next); G.save();
            for (const x of members(g)) sendAll(x, g);
            return;
          } else return;
          G.save(); p.save(); sendUser(c, mz); sendTasks(c, g);
          return;
        }
        case 4: {
          if (c.battle) return;
          const row = BATTLE.find(r => r.TemplateId === i && r.FloorId === fl.levelId), b = row && fl.boss[i];
          if (!b || b.hp <= 0) { alert(c, 'Este guarda foi derrotado'); return; }
          if (!guardsOpen(fl)) { alert(c, 'Os guardas deste andar ainda não foram liberados'); return; }
          if (u.fightLeft <= 0) { alert(c, 'Suas tentativas de desafio de hoje acabaram'); return; }
          u.fightLeft--; u.fights++; mz.fights++; p.save();
          const startHp = b.hp;
          ctx.startBattle(c, { Heros: row.Property, BattleType: 3907, mapTempId: row.BattleGround || 1, bossHp: startHp, maxTurns: 10, onEnd: (won, battle) => {
            const boss = battle.units.find(x => x.side === 2 && x.hero), cur = maze(g).floor.boss[i]; if (!cur) return;
            const dmg = Math.max(0, startHp - (boss ? boss.hp : startHp));
            cur.hp = Math.max(0, cur.hp - dmg); cur.dmg[p.id] = (cur.dmg[p.id] || 0) + dmg;
            const fl2 = maze(g).floor;
            if (!fl2.done && Object.values(fl2.boss).every(x => x.hp <= 0)) {   // floor done: the portal opens on the guard seal
              fl2.done = true; mz.floors++;
              const s = seal(fl2), portal = parse(FLOORS.get(fl2.levelId).EventGroup1).find(([id]) => type(id) === 4);
              if (s >= 0 && portal) { fl2.hidden[s] = portal[0]; pushCell(g, s); }
            }
            G.save(); pushBoss(g, i); sendUser(c, maze(g)); sendTasks(c, g);
            log(`[#${c.id}] guild maze guard ${i}: ${dmg} damage, hp ${cur.hp}`);
          } });
          return;
        }
        case 5: {
          const row = BATTLE.find(r => r.TemplateId === i && r.FloorId === fl.levelId), b = row && fl.boss[i];
          if (!b || b.hp > 0) { alert(c, 'Este guarda ainda não foi derrotado'); return; }
          if (u.boss.includes(i)) { alert(c, 'Você já recebeu esta recompensa'); return; }
          if (!grant(c, parse(row.Reward1))) { alert(c, 'Mochila cheia'); return; }
          u.boss.push(i); p.save(); return sendUser(c, mz);
        }
        case 6: {
          const t = TASKS.find(x => x.TemplateId === i || x.TemplateId === m.levelId), st = t && taskList(p, mz).find(x => x.templateId === t.TemplateId);
          if (!st || st.state !== 1) { alert(c, 'Missão ainda não concluída'); return; }
          if (!grant(c, parse(t.Reward))) { alert(c, 'Mochila cheia'); return; }
          u.tasks[t.TemplateId] = true; p.save(); return sendTasks(c, g);
        }
        case 8: {
          const dmg = {}; for (const b of Object.values(fl.boss)) for (const [id, n] of Object.entries(b.dmg)) dmg[id] = (dmg[id] || 0) + n;
          const order = Object.entries(dmg).sort((a, b) => b[1] - a[1]).map(([id, n], k) => ({ order: k + 1, userId: Number(id), damage: n, nickName: (playerById(Number(id)) || { s: {} }).s.nickName || '' }));
          return sendT(c, 879, 'guildmaze.GuildMazeOrderListMsg', { order });
        }
        default: return;
      }
    },
  };
};
