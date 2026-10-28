// Peri arenası (pet challenge; client PetChallengeCtrl / PetFormationFrame, system PET_PVP Lv50). Client-derived,
// no capture:
//  Line-up: C_PET_CHALLENGE_FORMATION pet.PlayerPetMsg {chaPos} = 6 pet ids (-1 empty) for the battle positions
//  [2, 5, 8, 3, 6, 9]; 4540 PlayerPetMsg op 0 / 1 carries it back (chaPos, fightIndex -> petChallengeFormation).
//  C_PET_CHALLENGE_SKILL pet.PetInfoMsg {petId, chaSkillIndexs}: the pet's arena skills (PetInfoMsg chaSkillIndexs).
//  List: C_CHALLENGEINFO_REQUEST {type 1} -> 4611 pet.PetChallengeInfoMsg {playerInfo {score, order, ...},
//  playerPets [PlayerPetMsg {userId, nickName, order, score, petInfo}], challengeLog [PetChallengeLogMsg]}.
//  Fights a day: 4176 ChallengeCoolTimeMsg {type 1, challengeCount = fights left, leftTime}; more with
//  U_C_PLAYER_ADD_ATTACKCOUNT {type 1, tarArmyId = n} for Jion_pet_challenge (50000) gold each.
//  C_CHALLENGE_PET player.ChallengeMsg {tarUserId} -> a pets-only fight (battle type 35 PET_PK, watch-only);
//  C_PET_CHALLENGE_END_BATTLE {battleId} = skip to the result.
// Our choices: start score 1000; a won fight +Pet_arena_reward_win (50), a lost one +Pet_arena_reward_lose (15);
// the defender's score does not change (it sees the fight in its log); Pet_Challenge_Count (10) fights a day;
// opponents are 4 players near our score with a line-up, the rest robots (the client's pet arena robots, t_s_robottemplate Type 2: name + pets, at our pets' level,
// mid aptitudes); day / week rank rewards (C_PET_RANK_REWARD) have no reward table and answer "none".
const ROBOT_BASE = 1310000000, START = 1000, OPPONENTS = 4, LIST_MS = 30 * 60000;
const POS = [2, 5, 8, 3, 6, 9];

module.exports = (ctx) => {
  const { D, dec, sendT, alert, pay, CONF, table, sysTime, online, playerById, log } = ctx;
  const COUNT = CONF.get('Pet_Challenge_Count') || 10, WIN = CONF.get('Pet_arena_reward_win') || 50, LOSE = CONF.get('Pet_arena_reward_lose') || 15;
  const BUY_GOLD = CONF.get('Jion_pet_challenge') || 50000, NEED_GRADE = CONF.get('Pet_Challenge_Grade') || 50;
  const SEALS = table('t_s_pettemplate').filter(r => r.Quality <= 2 && [...D.items.values()].some(t => t.SonType === 306 && t.Property1 === r.TemplateId));
  const day = () => sysTime().slice(0, 10);
  const pets = p => ((p.s.pets || {}).list || []);

  function state(p) {
    const a = p.s.petArena = p.s.petArena || { score: START, formation: [-1, -1, -1, -1, -1, -1], log: [], opponents: [], robots: {}, next: 0 };
    if (a.day !== day()) Object.assign(a, { day: day(), used: 0, bought: 0 });
    a.formation = a.formation.map(id => (id > 0 && pets(p).some(x => x.id === id) ? id : -1));   // released pets drop out
    return a;
  }
  const left = a => Math.max(0, COUNT + a.bought - a.used);
  ctx.petFormation = p => { const a = state(p); return { chaPos: a.formation.join(','), fightIndex: '' }; };
  const lineup = p => state(p).formation.map((id, k) => ({ pos: POS[k], pet: pets(p).find(x => x.id === id) })).filter(x => x.pet);

  // robots: seal pets at our pets' level, mid aptitudes, no equipment
  const dummy = () => ({ id: 0, s: { bag: [], pets: { list: [] } } });
  function robotPets(r) {
    return r.pets.map((x, i) => {
      const tp = ctx.petTemplate(x.templateId), mid = k => { const [lo, hi] = Array.isArray(tp[k]) ? tp[k] : [0, 0]; return Math.floor((lo + hi) / 2); };
      return { id: i + 1, templateId: tp.TemplateId, name: ctx.nameOf(tp), grade: x.grade, quality: (tp.Quality - 1) * 5 + 1, gp: 0, totalGp: 0,
        points: [0, 0, 0, 0], skills: [], apti: ['PowerApt', 'IntelApt', 'PhysiApt', 'ArmorApt'].map(mid) };
    });
  }
  function makeRobot(p, score) {
    const a = state(p), id = ROBOT_BASE + Math.floor(Math.random() * 9e6);
    const lv = Math.max(1, Math.round(lineup(p).reduce((n, x) => n + x.pet.grade, 0) / Math.max(1, lineup(p).length)) + Math.floor(Math.random() * 5) - 2);
    const n = Math.max(1, Math.min(6, lineup(p).length || 1));
    const rb = require('../robots').pet(), tpls = rb.pets.filter(t => ctx.petTemplate(t));   // the client's pet arena robots (t_s_robottemplate Type 2)
    a.robots[id] = { nick: rb.nick, score, pets: Array.from({ length: n }, (_, k) => ({ templateId: tpls.length ? tpls[k % tpls.length] : SEALS[Math.floor(Math.random() * SEALS.length)].TemplateId, grade: lv })) };
    return id;
  }
  // an opponent's fighters: [{pos, combat}] and its pets as PetInfoMsg for the list
  function side(p, id) {
    if (id >= ROBOT_BASE) {
      const r = state(p).robots[id]; if (!r) return null;
      const ps = robotPets(r), d = dummy();
      return { userId: id, nickName: r.nick, score: r.score, fighters: ps.map((x, k) => ({ pos: POS[k], combat: ctx.petCombat(d, x) })),
        infos: ps.map(x => { const cb = ctx.petCombat(d, x); return { petId: x.id, templateId: x.templateId, petName: x.name, curGrade: x.grade, quality: x.quality, maxHp: cb.hp, fightingCapacity: Math.ceil(700 + cb.stats.attack + cb.stats.magicAttack + cb.stats.defence + cb.stats.magicDefence + cb.hp / 5) }; }) };
    }
    const t = playerById(id); if (!t) return null;
    const lu = lineup(t), ids = new Set(lu.map(x => x.pet.id));
    return { userId: id, nickName: t.s.nickName, score: state(t).score, fighters: lu.map(x => ({ pos: x.pos, combat: ctx.petCombat(t, x.pet) })),
      infos: ctx.petInfos(t).filter(x => ids.has(x.petId)), player: t };
  }
  function allIds(p) {
    const ids = new Set([...Object.values(ctx.db.state.accounts).filter(x => x.char).map(x => x.userId), ...online.keys()]);
    ids.delete(p.id);
    return [...ids].filter(id => { const t = playerById(id); return t && lineup(t).length; });
  }
  function order(p) {   // rank by score among players with a line-up (0 = none yet)
    if (!lineup(p).length) return 0;
    const me = state(p).score;
    return 1 + allIds(p).filter(id => state(playerById(id)).score > me).length;
  }
  function pickOpponents(p) {
    const a = state(p), real = allIds(p).map(id => ({ id, score: state(playerById(id)).score }));
    const below = real.filter(x => x.score < a.score).sort((x, y) => y.score - x.score), above = real.filter(x => x.score >= a.score).sort((x, y) => x.score - y.score);
    const pick = [...below.slice(0, 1), ...above.slice(0, OPPONENTS - 1)];
    for (const x of below.slice(1)) if (pick.length < OPPONENTS) pick.push(x);
    a.robots = {};
    while (pick.length < OPPONENTS) { const s = Math.max(0, a.score + [-100, 0, 50, 100][pick.length] + Math.floor(Math.random() * 30)); pick.push({ id: makeRobot(p, s), score: s }); }
    a.opponents = pick.sort((x, y) => y.score - x.score).map(x => x.id);
    a.next = Date.now() + LIST_MS;
  }
  function infoMsg(p) {
    const a = state(p);
    if (!a.opponents.length || Date.now() > a.next) pickOpponents(p);
    const playerPets = a.opponents.map(id => side(p, id)).filter(Boolean)
      .map(sd => ({ userId: sd.userId, nickName: sd.nickName, score: sd.score, order: sd.player ? order(sd.player) : 0, petInfo: sd.infos }));
    return { playerInfo: { score: a.score, order: order(p), challengeCount: left(a), totalCount: COUNT + a.bought, leftTime: 0 }, playerPets, challengeLog: a.log.slice(-10) };
  }
  const sendInfo = c => sendT(c, 4611, 'pet.PetChallengeInfoMsg', infoMsg(c.player));
  const sendCount = c => sendT(c, 4176, 'player.ChallengeCoolTimeMsg', { type: 1, leftTime: 0, challengeCount: left(state(c.player)) });
  ctx.petArenaInfo = sendInfo;      // arena.js C_CHALLENGEINFO_REQUEST type 1
  ctx.petArenaCount = sendCount;    // arena.js login order / C_QUICKCOOL_CHALLENGE_TIME type 1
  const logEntry = (owner, tar, isAttack, won, d, infos) => ({ userId: owner, tarUserId: tar.userId, tarNickName: tar.nickName, result: won ? 1 : 0, isAttack,
    logDate: sysTime(), score: d, tarPets: { userId: tar.userId, nickName: tar.nickName, petInfo: infos } });

  return {
    C_PET_CHALLENGE_FORMATION(c, body) {
      const m = dec(c, 'C_PET_CHALLENGE_FORMATION', body), p = c.player, a = state(p);
      const ids = String(m.chaPos || '').split(',').map(Number).slice(0, 6), seen = new Set();
      a.formation = POS.map((_, k) => { const id = ids[k]; if (!(id > 0) || seen.has(id) || !pets(p).some(x => x.id === id)) return -1; seen.add(id); return id; });
      p.save();
      sendT(c, 4540, 'pet.PlayerPetMsg', Object.assign({ op: 1, userId: p.id }, ctx.petFormation(p)));
    },
    C_PET_CHALLENGE_SKILL(c, body) {
      const m = dec(c, 'C_PET_CHALLENGE_SKILL', body), p = c.player, pet = pets(p).find(x => x.id === m.petId);
      if (!pet) return;
      const known = new Set([...(pet.skills || []), ...[].concat((ctx.petTemplate(pet.templateId) || {}).DefaultSkills || [])]);
      pet.chaSkills = String(m.chaSkillIndexs || '').split(',').map(Number).filter(id => known.has(id)).slice(0, 3).join(',');
      p.save();
      ctx.petSend(c, [pet]);
    },
    U_C_PLAYER_ADD_ATTACKCOUNT(c, body) {
      const m = dec(c, 'U_C_PLAYER_ADD_ATTACKCOUNT', body), p = c.player, a = state(p);
      if (m.type !== 1) return;
      const n = Math.max(1, m.tarArmyId || 1);
      if (!pay(c, [[-100, BUY_GOLD * n]])) { alert(c, 'Ouro insuficiente'); return; }
      a.bought += n; p.save();
      ctx.sendPlayer(c); sendCount(c);
    },
    C_CHALLENGE_PET(c, body) {
      const m = dec(c, 'C_CHALLENGE_PET', body), p = c.player, a = state(p);
      if (c.battle) return;
      if (p.s.grades < NEED_GRADE) { alert(c, `Lv. ${NEED_GRADE} necessário`); return; }
      const mine = lineup(p);
      if (!mine.length) { alert(c, 'Escolha um silfo para a formação'); return; }
      if (!a.opponents.includes(m.tarUserId)) { alert(c, 'Este adversário não está na lista'); return sendInfo(c); }
      if (left(a) <= 0) { alert(c, 'Suas tentativas de desafio de hoje acabaram'); return sendCount(c); }
      const foe = side(p, m.tarUserId);
      if (!foe || !foe.fighters.length) { alert(c, 'Adversário não encontrado'); return; }
      a.used++; p.save();
      ctx.stat(c, 'petArena');
      const myInfos = ctx.petInfos(p).filter(x => mine.some(y => y.pet.id === x.petId));
      ctx.startPetPvp(c, [{ userId: p.id, nickName: p.s.nickName, pets: mine.map(x => ({ pos: x.pos, combat: ctx.petCombat(p, x.pet) })) },
        { userId: foe.userId, nickName: foe.nickName, pets: foe.fighters }], {
        battleType: 35, mapTempId: 992, scene: 19,   // capture: report scene 19
        onEnd(won) {
          const d = won ? WIN : LOSE;
          a.score += d;
          if (won) { ctx.stat(c, 'arenaWin'); ctx.stat(c, 'petArenaWin'); }   // daily "vitória no Torneio de Silfos" (welfare), season pass task 56
          a.log.push(logEntry(p.id, foe, true, won, d, foe.infos)); a.log = a.log.slice(-20);
          if (foe.player) {
            const ta = state(foe.player);
            ta.log.push(logEntry(foe.userId, { userId: p.id, nickName: p.s.nickName }, false, !won, 0, myInfos)); ta.log = ta.log.slice(-20);
            foe.player.save();
          }
          pickOpponents(p); p.save();
          sendCount(c); sendInfo(c);
          ctx.chat(c, `+${d} Puan`);
          log(`[#${c.id}] pet arena vs ${foe.userId}: ${won ? 'won' : 'lost'} +${d} -> ${a.score}`);
        },
      });
    },
    C_PET_CHALLENGE_END_BATTLE(c) {   // skip: decide the rest at once (as B_BATTLE_OVER)
      const b = c.battle; if (!b || !b.engine || b.type !== 35) return;
      b.engine.send = () => {};
      if (!b.engine.started) { b.engine.started = true; b.engine.t0 = Date.now(); b.engine.nextTurn(); }
      if (b.engine.timer) { b.engine.timers.clear(b.engine.timer); b.engine.timer = null; }
      b.engine.finishNow();
    },
    C_PET_RANK_REWARD(c, body) {
      const m = dec(c, 'C_PET_RANK_REWARD', body);
      sendT(c, 4613, 'pet.RankRewardMsg', { type: m.type, opType: m.opType, status: 2, rank: order(c.player) });   // STATUS_NONE: no reward table
    },
  };
};
