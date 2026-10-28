// Muhafız Arenası (guard challenge; client GuardChallengeWnd / Dh guard controller, system GUARD_CHALLENGE; config
// guard_Challenge_Grade 50, guard_Challenge_Count 10, guard_arena_reward_win 50 / lose 15, guard_fresh_count 3,
// guard_fresh_time 1800). Client-derived, no capture:
//  The line-up is the guard formation (C_GUARD_REQ op 11, guards.js). C_GUARD_ARENA_REQ carnival.GuardArenaReq
//  {op, opponentId}: 0 info, 1 new opponents (a free refresh), 2 ranking, 3 fight opponentId, 4 fight records ->
//  4950 GuardArenaInfoRes {freeTimes, nextFreeTime, rank, score, fight, challengeTimes, opponent [GuardArenaOpponentPB
//  {opponentId, opponentName, score, rank, fight, guards [{guardId, stage, fight}]}], buyTimes}, 4951 GuardArenaRankRes
//  {rankers [{rank, score, nickName, guards}]}, 4952 GuardBattleResultRes {reports [{userId, tarUserId, tarNickName,
//  result, isAttack, score, logDate}]}. The fight: battle type 3896 GUARD_CHALLENGE (client isAllGuardBattle: the
//  heros list is empty, the fighters are the 157 guards), watch-only.
// Our choices: start score 1000; a won fight +guard_arena_reward_win, a lost one -guard_arena_reward_lose (capture), the
// defender's score unchanged (it sees the fight in its records); challengeTimes = fights left today; the free
// refreshes come back each day (nextFreeTime 0); opponents are players near our score with a line-up, the rest
// robots (the client's guard arena robot names, t_s_robottemplate Type 4) that copy our own line-up at 85..105 % of its values.
const ROBOT_BASE = 1320000000, START = 1000, OPPONENTS = 4;

module.exports = (ctx) => {
  const { dec, sendT, alert, CONF, sysTime, online, playerById, log } = ctx;
  const COUNT = CONF.get('guard_Challenge_Count') || 10, WIN = CONF.get('guard_arena_reward_win') || 50, LOSE = CONF.get('guard_arena_reward_lose') || 15;
  const FREE = CONF.get('guard_fresh_count') || 3, NEED = CONF.get('guard_Challenge_Grade') || 50;
  const FRESH = CONF.get('guard_fresh_time') || 1800;
  const day = () => sysTime().slice(0, 10);
  function state(p) {
    const a = p.s.guardArena = p.s.guardArena || { score: START, log: [], opponents: [], robots: {} };
    if (a.day !== day()) Object.assign(a, { day: day(), used: 0, refresh: 0 });
    return a;
  }
  const fightOf = cb => cb.stats.fight || Math.ceil(cb.stats.attack + cb.stats.magicAttack + cb.stats.defence + cb.stats.magicDefence + cb.stats.hp / 5);
  const lineup = p => (ctx.guardLineup ? ctx.guardLineup(p) : []).map(x => ({ pos: x.pos, combat: ctx.guardCombat(p, x.id) })).filter(x => x.combat);
  const scale = (cb, k) => Object.assign({}, cb, { stats: Object.fromEntries(Object.entries(cb.stats).map(([n, v]) => [n, typeof v === 'number' ? Math.floor(v * k) : v])) });
  function side(p, id) {
    if (id >= ROBOT_BASE) {
      const r = state(p).robots[id]; if (!r) return null;
      return { userId: id, nickName: r.nick, score: r.score, fighters: lineup(p).map(x => ({ pos: x.pos, combat: scale(x.combat, r.k) })) };
    }
    const t = playerById(id); if (!t) return null;
    return { userId: id, nickName: t.s.nickName, score: state(t).score, fighters: lineup(t), player: t };
  }
  const guardsPB = sd => sd.fighters.map(x => ({ guardId: x.combat.id, stage: x.combat.stage || 0, fight: fightOf(x.combat) }));
  function allIds(p) {
    const ids = new Set([...Object.values(ctx.db.state.accounts).filter(x => x.char).map(x => x.userId), ...online.keys()]);
    ids.delete(p.id);
    return [...ids].filter(id => { const t = playerById(id); return t && lineup(t).length; });
  }
  const rankOf = p => lineup(p).length ? 1 + allIds(p).filter(id => state(playerById(id)).score > state(p).score).length : 0;
  function pick(p) {
    const a = state(p), real = allIds(p).map(id => ({ id, score: state(playerById(id)).score }));
    const near = real.sort((x, y) => Math.abs(x.score - a.score) - Math.abs(y.score - a.score)).slice(0, OPPONENTS);
    a.robots = {};
    while (near.length < OPPONENTS) {
      const id = ROBOT_BASE + Math.floor(Math.random() * 9e6), score = Math.max(0, a.score + [-80, 0, 40, 90][near.length] + Math.floor(Math.random() * 30));
      a.robots[id] = { nick: require('../robots').guard().nick, score, k: 0.85 + Math.random() * 0.2 };   // the client's guard arena robot names
      near.push({ id, score });
    }
    a.opponents = near.map(x => x.id);
  }
  function info(c) {
    const p = c.player, a = state(p);
    if (!a.opponents.length) pick(p);
    const opponent = a.opponents.map(id => side(p, id)).filter(Boolean).map(sd => ({ opponentId: sd.userId, opponentName: sd.nickName, score: sd.score,
      rank: sd.player ? rankOf(sd.player) : 0, fight: guardsPB(sd).reduce((n, g) => n + g.fight, 0), guards: guardsPB(sd) }));
    // 2026-10-23 capture: challengeTimes = fights used today (absent, 1, 2), nextFreeTime = now + guard_fresh_time (ms)
    sendT(c, 4950, 'carnival.GuardArenaInfoRes', { freeTimes: a.refresh, nextFreeTime: Date.now() + FRESH * 1000, rank: rankOf(p), score: a.score,
      fight: lineup(p).reduce((n, x) => n + fightOf(x.combat), 0), challengeTimes: a.used, opponent, buyTimes: 0 });
  }

  return {
    C_GUARD_ARENA_REQ(c, body) {
      const m = dec(c, 'C_GUARD_ARENA_REQ', body), p = c.player, a = state(p);
      switch (m.op) {
        case 1:
          if (a.refresh >= FREE) { alert(c, 'Suas atualizações gratuitas de hoje acabaram'); break; }
          a.refresh++; pick(p); p.save(); break;
        case 2: {
          const ids = [p.id, ...allIds(p)].filter(id => lineup(playerById(id)).length);
          const rankers = ids.map(id => { const t = playerById(id); return { score: state(t).score, nickName: t.s.nickName, guards: guardsPB({ fighters: lineup(t) }) }; })
            .sort((x, y) => y.score - x.score).slice(0, 50).map((r, i) => Object.assign({ rank: i + 1 }, r));
          return sendT(c, 4951, 'carnival.GuardArenaRankRes', { rankers });
        }
        case 4: return sendT(c, 4952, 'carnival.GuardBattleResultRes', { reports: a.log.slice(-20).reverse() });
        case 3: {
          if (c.battle) return;
          if (p.s.grades < NEED) { alert(c, `Lv. ${NEED} necessário`); break; }
          const mine = lineup(p);
          if (!mine.length) { alert(c, 'Coloque um guarda na formação'); break; }
          if (!a.opponents.includes(m.opponentId)) { alert(c, 'Este adversário não está na lista'); break; }
          if (a.used >= COUNT) { alert(c, 'Suas tentativas de desafio de hoje acabaram'); break; }
          const foe = side(p, m.opponentId);
          if (!foe || !foe.fighters.length) { alert(c, 'Adversário não encontrado'); break; }
          a.used++; p.save();
          ctx.startPetPvp(c, [{ userId: p.id, nickName: p.s.nickName, pets: [], guards: mine }, { userId: foe.userId, nickName: foe.nickName, pets: [], guards: foe.fighters }], {
            battleType: 3896, mapTempId: 5, scene: 54,   // capture: map 5, report scene 54
            onEnd(won) {
              const d = won ? WIN : -LOSE;   // capture: "Puan +50" after a win, "Puan-15" after a loss
              a.score = Math.max(0, a.score + d);
              a.log.push({ userId: p.id, tarUserId: foe.userId, tarNickName: foe.nickName, result: won ? 1 : 0, isAttack: true, score: d, logDate: sysTime() }); a.log = a.log.slice(-20);
              if (foe.player) {
                const ta = state(foe.player);
                ta.log.push({ userId: foe.userId, tarUserId: p.id, tarNickName: p.s.nickName, result: won ? 0 : 1, isAttack: false, score: 0, logDate: sysTime() }); ta.log = ta.log.slice(-20);
                foe.player.save();
              }
              pick(p); p.save(); info(c);
              ctx.chat(c, d > 0 ? `Puan +${d}` : `Puan ${d}`);
              log(`[#${c.id}] guard arena vs ${foe.userId}: ${won ? 'won' : 'lost'} +${d} -> ${a.score}`);
            },
          });
          return;
        }
        default: break;
      }
      info(c);
    },
  };
};
