// Mücevher Avı (gem maze; client vet GemMazeManager / uet model / GemMazeView; t_s_gemmazehelp = one row per gem
// level 1..25; config Gem_Maze_BuyNum 50, Gem_Maze_BuyInfo "10,8,99"). Client-derived, no capture:
//  A 5 x 5 board (mark = row * 5 + col), colors 1..5 (GemAction_1..5); gems fall down (client getDownCount) and the
//  new ones fill the top of each column, taking the removed gems' places in order (client updateAddData).
//  C_GET_GEMMAZE_INFO -> 4922 GemMazeInfoMsg {allGems [{mark, color}], score, weekScore, timesLeft, buyTimesLeft,
//  helpTimesLeft, gemLevel, curExp, maxExp, boxMark, scoreOrder, boxesId}. C_GEMMAZE_GEMMOVE {beginMark, endMark}
//  (neighbours; the client swaps at once and spends a move) -> one 4923 GemInfoUpdateMsg {gemDel, gemAdd, score [..],
//  curExp, maxExp, gemLevel, scoreOrder, rewardInfo [{rewardId}]} per cascade step. Score boxes at 500 / 1000 /
//  2000 / 3500 / 6000 points (client SORT_INDEX_ARRAY; boxMark bits 1 2 4 8 16): C_GEMMAZE_GETREWARDBOX {boxId 1..5}
//  -> 4928 {boxGetMark, rewardInfo}. Rewards go to the maze bag (bag 24, 48 cells; client getMazeBagList);
//  C_GEMMAZE_GETALL moves them into the bag. C_GEMMAZE_BUYTIMES -> 4927 (+10 moves for 8 diamonds, 99 a day).
// Our choices: each matched group gives the gem level row's Score and Exp, and its Reward x RewardNum with Rate %;
// maxExp = 10 x level; a swap without a match stays (one empty 4923 so the client finishes the move); the five
// boxes give one of each Şans Hazinesi (2131030..2131034); friend help (invite) is not built; moves and boxes are
// renewed each day, the week score each Monday.
module.exports = (ctx) => {
  const { D, table, dec, sendT, alert, pay, M, sysTime, online, playerById } = ctx;
  const HELP = new Map(table('t_s_gemmazehelp').map(r => [r.Id, r]));
  const TOP = Math.max(...HELP.keys()), N = 5, COLORS = 5, MAZE_BAG = 24, MAZE_BAG_SIZE = 48;
  const FREE = Number(ctx.CONF.str('Gem_Maze_BuyNum')) || 50;
  const [BUY_STEPS, BUY_PRICE, BUY_MAX] = String(ctx.CONF.str('Gem_Maze_BuyInfo') || '10,8,99').split(',').map(Number);
  const BOX_SCORE = [500, 1000, 2000, 3500, 6000], BOX_ITEM = [2131030, 2131031, 2131032, 2131033, 2131034];
  const day = () => sysTime().slice(0, 10);
  const week = () => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  const rnd = () => 1 + Math.floor(Math.random() * COLORS);
  const matches = b => {
    const out = new Set();
    for (let r = 0; r < N; r++) for (let c = 0; c + 2 < N; c++) { const v = b[r * N + c]; if (v && v === b[r * N + c + 1] && v === b[r * N + c + 2]) [0, 1, 2].forEach(k => out.add(r * N + c + k)); }
    for (let c = 0; c < N; c++) for (let r = 0; r + 2 < N; r++) { const v = b[r * N + c]; if (v && v === b[(r + 1) * N + c] && v === b[(r + 2) * N + c]) [0, 1, 2].forEach(k => out.add((r + k) * N + c)); }
    return out;
  };
  // groups of connected matched cells (one group = one scoring)
  const groups = (b, set) => { const left = new Set(set), out = []; while (left.size) { const s = [left.values().next().value], g = []; left.delete(s[0]); while (s.length) { const i = s.pop(); g.push(i); for (const j of [i - N, i + N, i % N ? i - 1 : -1, i % N < N - 1 ? i + 1 : -1]) if (left.has(j) && b[j] === b[i]) { left.delete(j); s.push(j); } } out.push(g); } return out; };
  function freshBoard() { let b; do { b = Array.from({ length: N * N }, rnd); } while (matches(b).size); return b; }
  function state(p) {
    const s = p.s.gemMaze = p.s.gemMaze || { level: 1, exp: 0, score: 0, board: freshBoard() };
    if (s.day !== day()) Object.assign(s, { day: day(), moves: FREE, buys: 0, box: 0, score: 0 });
    if (s.week !== week()) Object.assign(s, { week: week(), weekScore: 0 });
    return s;
  }
  const maxExp = s => 10 * s.level;
  const order = p => { const me = state(p).weekScore; const ids = [...online.keys()].filter(id => id !== p.id); return 1 + ids.filter(id => { const t = playerById(id); return t && t.s.gemMaze && t.s.gemMaze.week === week() && t.s.gemMaze.weekScore > me; }).length; };
  const info = c => { const p = c.player, s = state(p);
    sendT(c, 4922, 'minigame.GemMazeInfoMsg', { allGems: s.board.map((color, mark) => ({ mark, color })), score: s.score, weekScore: s.weekScore, timesLeft: s.moves, buyTimesLeft: Math.max(0, BUY_MAX - s.buys),
      helpTimesLeft: 0, gemLevel: s.level, curExp: s.exp, maxExp: maxExp(s), boxMark: s.box, scoreOrder: order(p), boxesId: BOX_ITEM }); };
  // the maze bag (24): items wait there until "take all"
  function toMazeBag(p, tid, n) {
    const used = new Set(p.s.bag.filter(i => i.bagType === MAZE_BAG).map(i => i.pos)), out = [];
    for (let k = 0; k < n; k++) { let pos = 0; while (used.has(pos)) pos++; if (pos >= MAZE_BAG_SIZE) break; used.add(pos); const it = { id: p.s.nextItemId++, templateId: tid, pos, count: 1, bagType: MAZE_BAG, isNew: true }; p.s.bag.push(it); out.push(it); }
    return out;
  }

  return {
    C_GET_GEMMAZE_INFO(c) { info(c); },
    C_GEMMAZE_GEMMOVE(c, body) {
      const m = dec(c, 'C_GEMMAZE_GEMMOVE', body), p = c.player, s = state(p), a = m.beginMark, b = m.endMark;
      const adj = Math.abs(a - b) === N || (Math.abs(a - b) === 1 && Math.floor(a / N) === Math.floor(b / N));
      if (!(a >= 0 && a < N * N && b >= 0 && b < N * N) || !adj) return info(c);
      if (s.moves <= 0) { alert(c, 'Tentativas de hoje usadas; compre mais ou volte amanhã'); return info(c); }
      if (p.s.bag.filter(i => i.bagType === MAZE_BAG).length >= MAZE_BAG_SIZE) { alert(c, 'Define hazinesi cheia, temizledikten sonra tekrar deneyin'); return info(c); }
      s.moves--;
      [s.board[a], s.board[b]] = [s.board[b], s.board[a]];
      const items = [];
      let set = matches(s.board), steps = 0;
      if (!set.size) sendT(c, 4923, 'minigame.GemInfoUpdateMsg', { gemDel: [], gemAdd: [], score: [], curExp: s.exp, maxExp: maxExp(s), gemLevel: s.level, scoreOrder: order(p), rewardInfo: [] });
      while (set.size && steps++ < 30) {
        const row = HELP.get(s.level) || HELP.get(TOP), score = [], rewards = [];
        for (const g of groups(s.board, set)) {
          if (g.length >= 4) ctx.stat(c, 'gemMatch4');   // season pass task 70: match-4
          score.push(row.Score || 0);
          s.exp += row.Exp || 0;
          if (Math.random() * 100 < (row.Rate || 0)) { for (const it of toMazeBag(p, row.Reward, row.RewardNum || 1)) { items.push(it); rewards.push({ rewardId: it.templateId }); } }
          while (s.level < TOP && s.exp >= maxExp(s)) { s.exp -= maxExp(s); s.level++; }
        }
        const gemDel = [...set].map(mark => ({ mark, color: s.board[mark] }));
        for (const i of set) s.board[i] = 0;
        const gemAdd = [];
        for (let col = 0; col < N; col++) {   // gravity: the column's gems fall, new ones fill the top
          const keep = []; for (let r = N - 1; r >= 0; r--) if (s.board[r * N + col]) keep.push(s.board[r * N + col]);
          for (let r = N - 1, k = 0; r >= 0; r--, k++) s.board[r * N + col] = keep[k] || 0;
          for (let r = 0; r < N && !s.board[r * N + col]; r++) { const v = rnd(); s.board[r * N + col] = v; gemAdd.push({ mark: r * N + col, color: v }); }
        }
        const got = score.reduce((x, y) => x + y, 0); s.score += got; s.weekScore += got;
        sendT(c, 4923, 'minigame.GemInfoUpdateMsg', { gemDel, gemAdd, score, curExp: s.exp, maxExp: maxExp(s), gemLevel: s.level, scoreOrder: order(p), rewardInfo: rewards });
        set = matches(s.board);
      }
      if (items.length) ctx.sendItems(c, items.map(it => M.movedEntry(p, it)));
      p.save();
    },
    C_GEMMAZE_GETREWARDBOX(c, body) {
      const m = dec(c, 'C_GEMMAZE_GETREWARDBOX', body), p = c.player, s = state(p), k = (m.boxId || 0) - 1, bit = 1 << k;
      if (k < 0 || k >= BOX_SCORE.length || s.score < BOX_SCORE[k] || s.box & bit) { alert(c, 'Este tesouro não pode ser recebido'); return info(c); }
      const its = toMazeBag(p, BOX_ITEM[k], 1); if (!its.length) { alert(c, 'Define hazinesi cheia, temizledikten sonra tekrar deneyin'); return; }
      s.box |= bit; p.save();
      ctx.sendItems(c, its.map(it => M.movedEntry(p, it)));
      sendT(c, 4928, 'minigame.GetRewardBoxRspMsg', { boxGetMark: s.box, rewardInfo: [{ rewardId: BOX_ITEM[k] }] });
    },
    C_GEMMAZE_GETALL(c) {   // the maze bag into the bag
      const p = c.player, its = p.s.bag.filter(i => i.bagType === MAZE_BAG), entries = [];
      for (const it of its) {
        const got = p.addItem(it.templateId, it.count); if (!got.length) { alert(c, 'Mochila cheia'); break; }
        entries.push({ changeType: MAZE_BAG, changeObjId: 0, changePos: it.pos }); p.s.bag = p.s.bag.filter(x => x !== it);
        for (const x of got) entries.push(M.movedEntry(p, x));
      }
      ctx.sendItems(c, entries); p.save();
    },
    C_GEMMAZE_BUYTIMES(c, body) {
      const m = dec(c, 'C_GEMMAZE_BUYTIMES', body), p = c.player, s = state(p);
      if (s.buys >= BUY_MAX) { alert(c, 'Número atingiu o limite'); return; }
      const bound = m.buyTypes === 1 && ctx.balance(p, -500) >= BUY_PRICE;
      if (!pay(c, [[bound ? -500 : -400, BUY_PRICE]])) { alert(c, 'Diamantes insuficientes'); return; }
      s.buys++; s.moves += BUY_STEPS; p.save(); ctx.sendPlayer(c);
      sendT(c, 4927, 'minigame.GemMazeBuyTimesRspMsg', { moveTimesLeft: s.moves, buyTimesLeft: BUY_MAX - s.buys });
    },
  };
};
