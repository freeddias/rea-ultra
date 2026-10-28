// Karnaval (嘉年华; client Jj / oh, Ent.Carnival pages; t_s_carnivalpointexchange, t_s_carnivaldailychallenge,
// t_s_carnivalluckdraw; config Carnival*). Client-derived, no capture:
//  Shown by 4590 U_C_TOP_TOOL_BTN simple.PropertyMsg {param1 1 (jo.CARNIVAL), param7 open, param9 rewards
//  claimable, param6 end time}. C_CARNIVAL_OP (player.PlayerOpMsg {op, id, count}) -> 4304 CarnivalMsg (opType =
//  op) and 4305 CarnivalTaskListMsg:
//   1 open; 2 score reward (exchange Type 1: Target = carnival score; scoreRewardInfo "id,id"); 3 charge lottery
//   (lotteryCount draws, luck draw MasterType 1); 6 luck treasure (CarnivalLuckyDraw 208054 per draw, luck draw
//   MasterType 3; result = the drawn row ids "id,id"); 5 daily gift (Type 2: Price diamonds, carnival_buy_gift_limit
//   a day; giftBuyInfo "id,n|id,n"); 7 daily challenge reward (t_s_carnivaldailychallenge: Para1 times ->
//   Points score); 8 online reward (Type 3: Target minutes online today, dayOnline; onlineRewardInfo "id,id");
//   9 a mini game (id = the exchange row Type: 4 memory cards, 5 link game, 6 sudoku) -> 381 U_C_MINI_GAME_OPEN
//   player.CommonMsg {param1: 1 memory card, 2 link game, 3 sudoku} (client cv); link game and sudoku: minigames.js.
//  Memory cards (Kart Eşleştirme; client jV / AirGardenGameMemoryCard, 4 x 6 cards, icons 1..12):
//   C_MEMORY_CARD_OP (carnival.MemoryCardMsg {op, cIndex1, cIndex2}): 1 start -> 194 {cards [{index 1..24, type}],
//   duration, leftAutoChance, leftCheckChance, score}; 2 flip two -> {result, addScore, addScore2}; 3 auto (a
//   pair found for you) -> {cIndex1, cIndex2}; 4 show (the hidden cards flash) -> {cards}; 5 close: a score of at
//   least t_s_gameboxreward Count (150) gives its Reward (2275150 x1) -> 195 {templateId, count, score}, at most
//   CarnivalGameCount (2) rewarded games a day.
//   Our choices (no capture): 90 s, 10 points a pair, +5 for each pair in a row after the first, 2 auto and 2 show
//   chances.
//  Challenges: 7 Kadim Ağaç (tree watering, own or a friend's), 9 Peri Turnuvası wins (arena), 11 group scene;
//  12 world boss and 13 battlefield do not exist on this server.
// Our choices: the carnival is always open here (CARNIVAL=0 hides it; the table dates CarnivalStartDate..
// CarnivalStopDate are long past); the score comes from the daily challenges (no real charges: lotteryCount
// stays 0); the daily parts reset at midnight (CarnivalDailControl 00:00).
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TASK_STATS = { 7: ['treeWater', 'treeWaterFriend'], 9: ['arenaWin'], 11: ['groupScene'] };
const MC = { duration: 90, pair: 10, combo: 5, auto: 2, show: 2 };

module.exports = (ctx) => {
  const { table, dec, sendT, alert, pay, grant, CONF } = ctx;
  const OPEN = () => {
    const f = ctx.events && ctx.events.force('carnival');
    if (f === true) return true;
    if (f === false) return false;
    return process.env.CARNIVAL !== '0';
  };
  if (ctx.events) ctx.events.register('carnival', () => process.env.CARNIVAL !== '0');
  const EX = table('t_s_carnivalpointexchange'), TASKS = table('t_s_carnivaldailychallenge'), LUCK = table('t_s_carnivalluckdraw');
  const byType = t => EX.filter(r => r.Type === t);
  const LUCK_ITEM = Number(String(CONF.str('CarnivalLuckyDraw') || '208054,1').split(',')[0]);
  const GIFT_LIMIT = Object.fromEntries(String(CONF.str('carnival_buy_gift_limit') || '').split('|').filter(Boolean).map(x => x.split(',').map(Number)));
  const items = r => [1, 2, 3, 4].filter(i => r['Item' + i] && r['ItemNum' + i]).map(i => [r['Item' + i], r['ItemNum' + i]]);
  const weighted = rows => { let x = Math.random() * rows.reduce((n, r) => n + (r.Random || 0), 0); for (const r of rows) if ((x -= r.Random || 0) < 0) return r; return rows[rows.length - 1]; };

  function state(p) {
    const s = p.s.carnival = p.s.carnival || { score: 0, claimed: [], luck: 0, lottery: 0, day: '', gifts: {}, online: 0, onlineClaimed: [], tasks: {}, since: Date.now() };
    if (s.day !== dayKey()) { s.day = dayKey(); s.gifts = {}; s.online = 0; s.onlineClaimed = []; s.tasks = {}; s.since = Date.now(); }
    return s;
  }
  const minutes = s => Math.floor(s.online + (Date.now() - (s.since || Date.now())) / 60000);
  function send(c, op = 1, result = '') {
    const s = state(c.player);
    sendT(c, 4304, 'carnival.CarnivalMsg', { opType: op, score: s.score, scoreRewardInfo: s.claimed.join(','), totalCharge: 0, lotteryCount: s.lottery, dayCharge: 0,
      giftBuyInfo: Object.entries(s.gifts).map(([id, n]) => `${id},${n}`).join('|'), dayOnline: minutes(s), onlineDate: s.day,
      onlineRewardInfo: s.onlineClaimed.join(','), luckCount: s.luck, luckNum: 0, result, snowRewardCount: 0, gameInfo: '' });
    sendT(c, 4305, 'carnival.CarnivalTaskListMsg', { tasks: TASKS.map(t => ({ taskId: t.Id, data: (s.tasks[t.Id] || {}).n || 0, isReward: !!(s.tasks[t.Id] || {}).done })) });
  }
  ctx.onLoad.push(c => {
    if (!OPEN()) return;
    const s = state(c.player); s.since = Date.now();
    sendT(c, 4590, 'simple.PropertyMsg', { param1: 1, param7: true, param9: true, param6: '' });
  });
  // the online minutes of the day are kept across sessions
  ctx.onClose(c => { const p = c.player; if (!p || !p.s.carnival) return; const s = state(p); s.online = minutes(s); s.since = Date.now(); p.save(); });
  ctx.onStat((c, key, n = 1) => {
    if (!OPEN() || !c.player) return;
    const s = state(c.player);
    for (const t of TASKS) if ((TASK_STATS[t.TaskType] || []).includes(key)) { const x = s.tasks[t.Id] = s.tasks[t.Id] || { n: 0, done: false }; x.n = Math.min(t.Para1, x.n + n); }
  });

  // ---- memory cards ----
  const GAME_REWARD = new Map(table('t_s_gameboxreward').map(r => [r.GameID, r]));
  const GAME_DAILY = String(CONF.str('CarnivalGameCount') || '2,2,2').split(',').map(Number);
  const mcMsg = (g, o = {}) => Object.assign({ op: 0, curTurn: 0, score: g.score, leftAutoChance: g.auto, leftCheckChance: g.show, duration: 0, addScore: 0, addScore2: 0, result: false }, o);
  // a finished mini game (t_s_gameboxreward GameID 1 memory cards, 2 link game, 3 sudoku): a score of at least
  // Count gives Reward, CarnivalGameCount rewarded games a day each -> [templateId, count] or null
  ctx.carnivalGameReward = (c, gameId, score) => {
    const p = c.player, s = state(p), cfg = GAME_REWARD.get(gameId);
    s.games = s.games || {}; const done = s.games[gameId] || 0;
    if (!cfg || !cfg.Reward || score < cfg.Count || done >= (GAME_DAILY[gameId - 1] || 2)) return null;
    const [tid, n] = String(cfg.Reward).split(',').map(Number);
    grant(c, [[tid, n]], { quiet: true });
    s.games[gameId] = done + 1; p.save();
    return [tid, n];
  };
  function mcFinish(c) {
    const g = c.memoryCard; if (!g) return;
    c.memoryCard = null;
    const got = ctx.carnivalGameReward(c, 1, g.score);
    if (got) sendT(c, 195, 'carnival.MemoryCardRewardMsg', { templateId: got[0], count: got[1], score: g.score });
  }
  ctx.onClose(c => mcFinish(c));

  function draw(c, s, master, count) {
    const pool = LUCK.filter(r => r.MasterType === master);
    const got = [];
    for (let i = 0; i < count; i++) got.push(weighted(pool));
    grant(c, got.map(r => [r.Item, r.ItemNum]), { quiet: true });
    return got.map(r => r.Id).join(',');
  }

  return {
    C_MEMORY_CARD_OP(c, body) {
      const m = dec(c, 'C_MEMORY_CARD_OP', body);
      if (m.op === 1) {
        const types = []; for (let i = 1; i <= 12; i++) types.push(i, i);
        for (let i = types.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [types[i], types[j]] = [types[j], types[i]]; }
        const g = c.memoryCard = { cards: types.map((type, i) => ({ index: i + 1, type })), matched: new Set(), score: 0, combo: 0, auto: MC.auto, show: MC.show, end: Date.now() + MC.duration * 1000 };
        return sendT(c, 194, 'carnival.MemoryCardMsg', mcMsg(g, { op: 1, cards: g.cards, duration: MC.duration }));
      }
      const g = c.memoryCard; if (!g) return;
      if (m.op === 5 || Date.now() > g.end + 5000) return mcFinish(c);
      const type = i => (g.cards[i - 1] || {}).type;
      if (m.op === 2) {
        const a = m.cIndex1, b = m.cIndex2;
        const ok = a !== b && type(a) && type(a) === type(b) && !g.matched.has(a) && !g.matched.has(b);
        let add = 0, add2 = 0;
        if (ok) { g.matched.add(a); g.matched.add(b); add = MC.pair; add2 = g.combo > 0 ? MC.combo : 0; g.combo++; g.score += add + add2; } else g.combo = 0;
        sendT(c, 194, 'carnival.MemoryCardMsg', mcMsg(g, { op: 2, result: ok, cIndex1: a, cIndex2: b, addScore: add, addScore2: add2 }));
      } else if (m.op === 3) {
        if (g.auto <= 0) return;
        const left = g.cards.filter(x => !g.matched.has(x.index)); if (!left.length) return;
        const a = left[0], b = left.find(x => x.index !== a.index && x.type === a.type);
        g.auto--; g.matched.add(a.index); g.matched.add(b.index); g.combo = 0; g.score += MC.pair;
        sendT(c, 194, 'carnival.MemoryCardMsg', mcMsg(g, { op: 3, result: true, cIndex1: a.index, cIndex2: b.index, addScore: MC.pair }));
      } else if (m.op === 4) {
        if (g.show <= 0) return;
        g.show--;
        sendT(c, 194, 'carnival.MemoryCardMsg', mcMsg(g, { op: 4, cards: g.cards.filter(x => !g.matched.has(x.index)) }));
      }
      if (g.matched.size === g.cards.length) mcFinish(c);
    },
    C_CARNIVAL_OP(c, body) {
      const m = dec(c, 'C_CARNIVAL_OP', body), p = c.player, s = state(p);
      if (!OPEN()) { alert(c, 'Carnaval não está aberto'); return; }
      let result = '';
      switch (m.op) {
        case 1: break;
        case 2: {
          const r = byType(1).find(x => x.Id === m.id);
          if (!r || s.claimed.includes(r.Id)) return send(c, 2);
          if (s.score < r.Target) { alert(c, 'Pontos de carnaval insuficientes'); return send(c, 2); }
          grant(c, items(r)); s.claimed.push(r.Id);
          break;
        }
        case 3: {
          const n = Math.max(1, Math.min(m.count || 1, s.lottery));
          if (s.lottery <= 0) { alert(c, 'Sem tentativas de sorteio'); return send(c, 3); }
          s.lottery -= n; result = draw(c, s, 1, n);
          break;
        }
        case 6: case 4: {
          const n = Math.max(1, Math.min(10, m.count || 1));
          if (!pay(c, [[LUCK_ITEM, n]])) { alert(c, 'Itens de sorte insuficientes'); return send(c, m.op); }
          s.luck += n; result = draw(c, s, 3, n);
          break;
        }
        case 5: {
          const r = byType(2).find(x => x.Id === m.id); if (!r) return send(c, 5);
          if ((s.gifts[r.Id] || 0) >= (GIFT_LIMIT[r.Id] ?? 1)) { alert(c, 'Limite de compras de hoje atingido'); return send(c, 5); }
          if (r.Price && !pay(c, [[-400, r.Price]])) { alert(c, 'Diamantes insuficientes'); return send(c, 5); }
          grant(c, items(r)); s.gifts[r.Id] = (s.gifts[r.Id] || 0) + 1;
          break;
        }
        case 7: {
          const t = TASKS.find(x => x.Id === m.id), x = t && s.tasks[t.Id];
          if (!t || !x || x.done || x.n < t.Para1) { alert(c, 'Missão ainda não concluída'); return send(c, 7); }
          x.done = true; s.score += t.Points || 0;
          break;
        }
        case 8: {
          const r = byType(3).find(x => x.Id === m.id);
          if (!r || s.onlineClaimed.includes(r.Id)) return send(c, 8);
          if (minutes(s) < r.Target) { alert(c, `${r.Target} minutos online necessários`); return send(c, 8); }
          grant(c, items(r)); s.onlineClaimed.push(r.Id);
          break;
        }
        case 9: {
          const game = { 4: 1, 5: 2, 6: 3 }[m.id];   // exchange Type -> client cv (1 memory cards, 2 link game, 3 sudoku)
          if (!game) return;
          sendT(c, 381, 'player.CommonMsg', { param1: game });
          return;
        }
        default: return;
      }
      p.save();
      send(c, m.op, result);
    },
  };
};
