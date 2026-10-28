// Single arena ("Meydan Oku") between our players, with robots when there are not enough of them.
// From the capture (4 fights): C_CHALLENGEINFO_REQUEST {type 0} -> 4169 ChallengeInfoMsg (4 opponents around
// our score, robots have ids 1300000000+ and a heroTempId; start score 1000; 10 a day); C_CHALLENGE
// {tarUserId, payType} -> a PvP battle (battleType 16, map 992, logic.startPvp); after it 4103 report
// (scene 7), 4176 {challengeCount, totalCount, totalBuyCount}, "+24 Puan", a new opponent list.
// Score: the win base is single_arena_reward_win 30, adjusted by the score difference: recorded gains
// +24 / +24 / +27 / +33 for differences -147 / -180 / -57 / +48 fit round(30 + diff / 17.5) clamped to
// [24, 36] (0.8x .. 1.2x of the base). The beaten defender lost single_arena_reward_lose 9 (853 -> 844); we
// take the same 9 from an attacker who loses (not recorded).
// Tables / config: ChallengeTotalCount 10, ChallengeBuy (diamonds per extra fight), RefreshNum 3 free list
// refreshes, PaidRefreshPrice 45, Number_Limit paid refreshes, t_s_singlearenarewards (Type 1: score
// reached -> reward, Type 2: wins -> reward; claimed ids in winCountReward, client indexOf).
const { Player } = require('../player');
const ROBOT_BASE = 1300000000, START = 1000, WIN = 30, LOSE = 9, OPPONENTS = 4, LIST_MS = 30 * 60000;

module.exports = (ctx) => {
  const { D, dec, sendT, online, playerById, alert, chat, pay, grant, parseRewards, CONF, table, sysTime, bump, log } = ctx;
  const cfg = n => String((table('t_s_config').find(r => r.ConfigName === n) || {}).ConfigValue || '');
  const TOTAL = CONF.get('ChallengeTotalCount') || 10, BUY = cfg('ChallengeBuy').split(',').map(Number).filter(Boolean);
  const FREE_REFRESH = CONF.get('RefreshNum') || 3, PAID_REFRESH = CONF.get('Number_Limit') || 3, REFRESH_PRICE = CONF.get('PaidRefreshPrice') || 45;
  const REWARDS = table('t_s_singlearenarewards');
  const day = () => sysTime().slice(0, 10);
  const heroOf = job => [...D.heroes.keys()].find(k => D.heroes.get(k).Job === job && k <= 3) || [...D.heroes.keys()].find(k => D.heroes.get(k).Job === job);

  function state(p) {
    const a = p.s.arena = p.s.arena || { score: START, best: START, wins: 0, claimed: [], log: [], opponents: [], robots: {}, next: 0 };
    if (a.day !== day()) Object.assign(a, { day: day(), count: 0, freeRefresh: 0, paidRefresh: 0 });
    return a;
  }
  const scoreOf = id => { if (id >= ROBOT_BASE) return null; const t = playerById(id); return t ? state(t).score : START; };

  // robots: generated around the challenger (level and troops), named from syllables (no real names)
  function robot(p, id) {
    const a = state(p), r = a.robots[id]; if (!r) return null;
    const job = r.job, icon = heroOf(job), tpl = D.heroes.get(icon) || {};
    return new Player({ id, nickName: r.nick, sex: r.sex, icon, job, camp: 1, grades: r.grades, totalGp: 0, equip: {}, bag: [], skills: (tpl.SkillScript || []).slice(),
      fastKey: [], castle: p.s.castle, army: { tempId: p.s.army.tempId, count: p.s.army.count }, pawns: {}, guild: null, buildings: [] });
  }
  function makeRobot(p, score) {
    const a = state(p), id = ROBOT_BASE + Math.floor(Math.random() * 99999);
    const grades = Math.max(1, p.s.grades + Math.floor(Math.random() * 3) - 1), rb = require('../robots').arena(grades);   // the client's robot names (t_s_robottemplate)
    a.robots[id] = { nick: rb.nick, sex: rb.sex, job: 1 + Math.floor(Math.random() * 3), grades, score };
    return id;
  }
  const opponent = (p, id) => id >= ROBOT_BASE ? robot(p, id) : playerById(id);
  const oppScore = (p, id) => id >= ROBOT_BASE ? (state(p).robots[id] || {}).score || START : scoreOf(id);

  // 4 opponents: one below our score, the rest at or above it (capture: 853 / 1000 / 1056 / 1083 at 1000)
  function pickOpponents(p) {
    const a = state(p);
    const ids = new Set([...Object.values(ctx.db.state.accounts).filter(x => x.char).map(x => x.userId), ...online.keys()]);
    ids.delete(p.id);
    const real = [...ids].filter(id => playerById(id)).map(id => ({ id, score: scoreOf(id) }));
    const below = real.filter(x => x.score < a.score).sort((x, y) => y.score - x.score);
    const above = real.filter(x => x.score >= a.score).sort((x, y) => x.score - y.score);
    const pick = [...below.slice(0, 1), ...above.slice(0, OPPONENTS - 1)];
    for (const x of below.slice(1)) if (pick.length < OPPONENTS) pick.push(x);
    a.robots = {};
    while (pick.length < OPPONENTS) {
      const s = a.score + [-120, 0, 60, 110][pick.length] + Math.floor(Math.random() * 30);
      pick.push({ id: makeRobot(p, Math.max(0, s)), score: s });
    }
    a.opponents = pick.sort((x, y) => x.score - y.score).map(x => x.id);
    a.next = Date.now() + LIST_MS;
  }
  function infoMsg(p) {
    const a = state(p);
    if (!a.opponents.length || Date.now() > a.next) pickOpponents(p);
    const simplePlayer = [], avater = [];
    for (const id of a.opponents) {
      const t = opponent(p, id); if (!t) continue;
      const e = { userId: id, nickName: t.s.nickName, sexs: t.s.sex, pics: t.s.icon, grades: t.s.grades, fightingCapacity: t.fightingCapacity(), job: t.s.job, challengeScore: oppScore(p, id) };
      if (id >= ROBOT_BASE) e.heroTempId = t.s.icon;
      simplePlayer.push(e);
      const w = t.s.equip[0], cl = t.s.equip[2];
      if (w) avater.push({ userId: id, armTempId: w.templateId });
      if (cl) avater.push({ userId: id, clothTempId: cl.templateId });
    }
    return { simplePlayer, avater, challengeLog: a.log.slice(-10), curScore: a.score, challengeCount: a.count, totalCount: TOTAL, totalBuyCount: BUY.length,
      lastWinCount: a.wins, winCountReward: a.claimed.join(','), nextRefreshTime: Math.floor(a.next / 1000), freeRefreshTimes: a.freeRefresh, payRefreshTimes: a.paidRefresh };
  }
  const send = c => sendT(c, 4169, 'simple.ChallengeInfoMsg', infoMsg(c.player));
  const logEntry = (owner, tar, isAttack, won, forward, score) => ({ userId: owner.id, result: won ? 1 : 0, tarUserId: tar.id, tarNickName: tar.s.nickName, isAttack,
    logDate: sysTime(), job: tar.s.job, forward, curScore: score });
  const gainFor = (me, tar) => Math.max(Math.round(WIN * 0.8), Math.min(Math.round(WIN * 1.2), Math.round(WIN + (tar - me) / 17.5)));

  // login: the colosseum order (a loading step of the client, capture packets 66 / 67: single arena, then
  // the pet arena with type 1)
  ctx.onLoad.push(c => {
    const a = state(c.player);
    sendT(c, 4176, 'player.ChallengeCoolTimeMsg', { challengeCount: a.count, totalCount: TOTAL, totalBuyCount: BUY.length });
    ctx.petArenaCount(c);   // pet arena fights left (features/petarena.js)
  });

  return {
    C_CHALLENGEINFO_REQUEST(c, body) {
      const m = dec(c, 'C_CHALLENGEINFO_REQUEST', body), p = c.player, a = state(p);
      if (m.type === 1 && ctx.petArenaInfo) { if (ctx.petArenaCount) ctx.petArenaCount(c); return ctx.petArenaInfo(c); }   // the pet arena (features/petarena.js); 2026-10-23 capture: 4176 {challengeCount, type 1} first, then 4611
      if (m.type === 4) {   // refresh the opponents: free ones first, then PaidRefreshPrice diamonds
        if (a.freeRefresh < FREE_REFRESH) a.freeRefresh++;
        else if (a.paidRefresh < PAID_REFRESH && pay(c, [[m.payType === 1 ? -500 : -400, REFRESH_PRICE]])) { a.paidRefresh++; ctx.sendPlayer(c); }
        else { alert(c, a.paidRefresh >= PAID_REFRESH ? 'Suas atualizações de hoje acabaram' : 'Diamantes insuficientes'); return send(c); }
        pickOpponents(p);
      }
      p.save();
      send(c);
    },
    C_CHALLENGE(c, body) {
      const m = dec(c, 'C_CHALLENGE', body), p = c.player, a = state(p);
      if (c.battle) return;
      if (!a.opponents.includes(m.tarUserId)) { alert(c, 'Este adversário não está na lista'); return send(c); }
      if (a.count >= TOTAL) {   // extra fights: ChallengeBuy[n] diamonds
        const k = a.count - TOTAL;
        if (k >= BUY.length) { alert(c, 'Suas tentativas de desafio de hoje acabaram'); return; }
        if (!m.payType || !pay(c, [[m.payType === 1 ? -500 : -400, BUY[k]]])) { alert(c, 'Diamantes insuficientes'); return; }
        ctx.sendPlayer(c);
      }
      const t = opponent(p, m.tarUserId);
      if (!t) { alert(c, 'Adversário não encontrado'); return; }
      a.count++;
      p.save();
      bump(c, 35, 1);   // quest condition 35 "Meydan Oku"
      ctx.stat(c, 'arena');
      const tarScore = oppScore(p, t.id);
      ctx.startPvp(c, t, {
        battleType: 16, mapTempId: 992, scene: 7,
        onEnd(won) {
          const d = won ? gainFor(a.score, tarScore) : -Math.min(LOSE, a.score);
          a.score += d; a.best = Math.max(a.best, a.score);
          if (won) { a.wins++; ctx.stat(c, 'arenaWin'); }
          a.log.push(logEntry(p, t, true, won, d, a.score)); a.log = a.log.slice(-20);
          // the defender (a real player) loses / keeps its score and sees the fight in its log
          if (t.id < ROBOT_BASE) {
            const ta = state(t), td = won ? -Math.min(LOSE, ta.score) : 0;
            ta.score += td;
            ta.log.push(logEntry(t, p, false, !won, td, ta.score)); ta.log = ta.log.slice(-20);
            t.save();
          }
          pickOpponents(p);
          p.save();
          sendT(c, 4176, 'player.ChallengeCoolTimeMsg', { challengeCount: a.count, totalCount: TOTAL, totalBuyCount: BUY.length });
          chat(c, `${d >= 0 ? '+' : ''}${d} Puan`);
          log(`[#${c.id}] arena vs ${t.id}: ${won ? 'won' : 'lost'} ${d} -> ${a.score}`);
        },
      });
    },
    // milestone rewards: Type 1 score reached (best score), Type 2 wins
    C_CHALLENGE_REQUEST(c, body) {
      const m = dec(c, 'C_CHALLENGE_REQUEST', body), p = c.player, a = state(p), r = REWARDS.find(x => x.Id === m.rewardId);
      const reached = r && (r.Type === 1 ? a.best >= r.Property1 : a.wins >= r.Property1);
      if (!r || a.claimed.includes(r.Id) || !reached) { alert(c, 'Esta recompensa não pode ser recebida'); return send(c); }
      const items = [[r.RewardItemID1, r.RewardItemCount1], [r.RewardItemID2, r.RewardItemCount2]].filter(([t, n]) => t && n);
      if (!grant(c, items)) { alert(c, 'Mochila cheia'); return; }
      a.claimed.push(r.Id); p.save();
      sendT(c, 4243, 'player.ChallengeRankRewardMsg', { isTake: true });
      send(c);
    },
    // "cool down" (client sendCoolColosseun; type 0 arena, 1 pet arena): fights here have no waiting time, so the
    // answer is the counter with leftTime 0 and nothing is charged
    C_QUICKCOOL_CHALLENGE_TIME(c, body) {
      const m = dec(c, 'C_QUICKCOOL_CHALLENGE_TIME', body), a = state(c.player);
      if (m.type === 1) return ctx.petArenaCount(c);   // features/petarena.js
      sendT(c, 4176, 'player.ChallengeCoolTimeMsg', { leftTime: 0, challengeCount: a.count, totalCount: TOTAL, totalBuyCount: BUY.length });
    },
    C_TAKE_CHALLENGEREWARD(c) { sendT(c, 4243, 'player.ChallengeRankRewardMsg', { isTake: false }); },   // ranking rewards: no ranking periods yet
  };
};
