// Carnival mini games besides the memory cards (carnival.js): the link game and sudoku. Opened from the
// carnival game tab (381 U_C_MINI_GAME_OPEN); a finished game is rewarded by ctx.carnivalGameReward (score >=
// t_s_gameboxreward Count, CarnivalGameCount games a day). Client-derived, no capture.
//
// Eşleştirme Oyunu (client JV / XV, AirGardenGameLLK): a 7 x 10 grid (row = index / 10), the outer ring empty,
// the inner 5 x 8 holds 20 pairs of icons 1..26 (asset.llk.nodeIcon_N). Two equal icons are removed when a path of
// at most two turns through empty cells joins them (client checkByPos: straight, one corner, two corners —
// ported below). C_LINKGAME_OP (carnival.LinkGameMsg {opType}): 1 start, 2 remove {aX, aY, bX, bY} (row, col),
// 3 bomb (removes a joinable pair), 4 reshuffle, 5 close -> 196 U_C_LINK_GAME_INFO {points: 70 values, time,
// score, bombCount, resetCount, tollgate, aX..bY + pointValue / combCount / addScore for a removal, reward
// "count,templateId" at the end}. A cleared grid deals the next one (tollgate + 1).
// Our choices: 120 s, 10 points a pair + 2 per running combo (removals within 3 s), 1 bomb, 1 reshuffle; a grid
// without a joinable pair is reshuffled for free.
//
// Sudoku (client lY, AirGardenGameSuDuWnd; com.road.yishi.pb.minigame, proto.js "pb." names): C_SUDOKU_OP
// (SudokuGameReqMsg {opType, cell {row, col, value}}): 1 start (or the next board), 2 fill a cell, 3 tool (a correct
// value placed for you, addTimeCount uses), 4 undo the last answer, 5 clear the answers, 6 close -> 200
// SudokuGameMsg {result, board / actCell, valueNumList [{value, Num left}], lastAns, startTime, totalTime (ms),
// addTimeCount, score}. Carnival_Sudoku_Blankgrid (15) empty cells; the client refuses values that clash with a
// row / column / box, the server takes any value that does not clash.
// Our choices: 300 s, 10 points a cell, 3 tool uses; a full board deals the next.
module.exports = (ctx) => {
  const { sendT, dec, CONF, log } = ctx;

  // ---------------- link game ----------------
  const ROW = 7, COL = 10, LLK = { time: 120, pair: 10, combo: 2, comboMs: 3000, bomb: 1, reset: 1 };
  const at = (g, r, c) => g.grid[r * COL + c];
  function connectRow(g, a, b) { if (a.r !== b.r) return false; for (let c = Math.min(a.c, b.c) + 1; c < Math.max(a.c, b.c); c++) if (at(g, a.r, c) > 0) return false; return true; }
  function connectCol(g, a, b) { if (a.c !== b.c) return false; for (let r = Math.min(a.r, b.r) + 1; r < Math.max(a.r, b.r); r++) if (at(g, r, a.c) > 0) return false; return true; }
  const empty = (g, p) => at(g, p.r, p.c) === 0;
  function joinable(g, a, b) {
    if (a.r === b.r && a.c === b.c) return false;
    const v = at(g, a.r, a.c); if (v <= 0 || v !== at(g, b.r, b.c)) return false;
    if (a.r === b.r && connectRow(g, a, b)) return true;
    if (a.c === b.c && connectCol(g, a, b)) return true;
    for (const s of [{ r: a.r, c: b.c }, { r: b.r, c: a.c }]) if (empty(g, s) && ((s.r === a.r ? connectRow(g, s, a) : connectCol(g, s, a)) && (s.r === b.r ? connectRow(g, s, b) : connectCol(g, s, b)))) return true;
    for (let r = 0; r < ROW; r++) { const s = { r, c: a.c }, t = { r, c: b.c }; if (empty(g, s) && empty(g, t) && connectRow(g, s, t) && connectCol(g, s, a) && connectCol(g, t, b)) return true; }
    for (let c = 0; c < COL; c++) { const s = { r: a.r, c }, t = { r: b.r, c }; if (empty(g, s) && empty(g, t) && connectCol(g, s, t) && connectRow(g, s, a) && connectRow(g, t, b)) return true; }
    return false;
  }
  const inner = () => { const l = []; for (let r = 1; r < ROW - 1; r++) for (let c = 1; c < COL - 1; c++) l.push(r * COL + c); return l; };
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  function findPair(g) {
    const cells = g.grid.map((v, i) => ({ v, r: Math.floor(i / COL), c: i % COL })).filter(x => x.v > 0);
    for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) if (cells[i].v === cells[j].v && joinable(g, cells[i], cells[j])) return [cells[i], cells[j]];
    return null;
  }
  function reshuffle(g) {
    const idx = g.grid.map((v, i) => v > 0 ? i : -1).filter(i => i >= 0), vals = shuffle(idx.map(i => g.grid[i]));
    idx.forEach((i, k) => { g.grid[i] = vals[k]; });
  }
  function deal(g) {
    g.grid = new Array(ROW * COL).fill(0);
    const cells = inner(), vals = [];
    for (let k = 0; k < cells.length / 2; k++) { const v = 1 + Math.floor(Math.random() * 26); vals.push(v, v); }
    shuffle(vals).forEach((v, k) => { g.grid[cells[k]] = v; });
    for (let n = 0; n < 20 && !findPair(g); n++) reshuffle(g);
  }
  const llkMsg = (g, o = {}) => Object.assign({ opType: 0, points: g.grid.join(','), time: LLK.time, score: g.score, bombCount: g.bomb, resetCount: g.reset, tollgate: g.gate, combCount: 0, addScore: 0 }, o);
  function llkRemove(g, a, b) {
    const v = at(g, a.r, a.c);
    g.grid[a.r * COL + a.c] = 0; g.grid[b.r * COL + b.c] = 0;
    const now = Date.now(); g.comb = now - g.last <= LLK.comboMs ? g.comb + 1 : 0; g.last = now;
    const add = LLK.pair + LLK.combo * g.comb; g.score += add;
    return { aX: a.r, aY: a.c, bX: b.r, bY: b.c, pointValue: v, combCount: g.comb, addScore: add };
  }
  function llkAfter(c, g, o) {
    if (g.grid.every(v => v === 0)) { g.gate++; deal(g); }
    else if (!findPair(g)) reshuffle(g);
    sendT(c, 196, 'carnival.LinkGameMsg', llkMsg(g, o));
  }
  function llkFinish(c) {
    const g = c.linkGame; if (!g) return; c.linkGame = null;
    const got = ctx.carnivalGameReward && ctx.carnivalGameReward(c, 2, g.score);
    if (got) sendT(c, 196, 'carnival.LinkGameMsg', llkMsg(g, { opType: 5, points: '', reward: `${got[1]},${got[0]}` }));
  }

  // ---------------- sudoku ----------------
  const SU = { time: 300, cell: 10, tools: 3 };
  const BLANKS = Number(String(CONF.str('Carnival_Sudoku_Blankgrid') || '15,15').split(',')[0]) || 15;
  function solved() {   // a random full board: a valid base pattern with shuffled digits, rows and columns
    const digits = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]), band = () => shuffle([0, 1, 2]);
    const rows = shuffle([0, 1, 2]).flatMap(b => band().map(r => b * 3 + r)), cols = shuffle([0, 1, 2]).flatMap(b => band().map(x => b * 3 + x));
    return rows.map(r => cols.map(x => digits[(3 * (r % 3) + Math.floor(r / 3) + x) % 9]));
  }
  const clash = (b, r, c, v) => { for (let i = 0; i < 9; i++) if ((b[r][i] === v && i !== c) || (b[i][c] === v && i !== r)) return true; const r0 = r - r % 3, c0 = c - c % 3; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (b[r0 + i][c0 + j] === v && (r0 + i !== r || c0 + j !== c)) return true; return false; };
  function newBoard(g) {
    g.solution = solved(); g.board = g.solution.map(r => r.slice()); g.given = g.board.map(r => r.map(() => true)); g.answers = [];
    const cells = shuffle([...Array(81).keys()]).slice(0, BLANKS);
    for (const k of cells) { g.board[Math.floor(k / 9)][k % 9] = 0; g.given[Math.floor(k / 9)][k % 9] = false; }
  }
  const boardCells = g => g.board.flatMap((row, r) => row.map((value, col) => ({ row: r, col, value })));
  const valueNums = g => [1, 2, 3, 4, 5, 6, 7, 8, 9].map(v => ({ value: v, Num: 9 - g.board.flat().filter(x => x === v).length }));
  const suMsg = (g, o = {}) => Object.assign({ result: true, startTime: g.start, totalTime: SU.time * 1000, addTimeCount: g.tools, score: g.score, valueNumList: valueNums(g) }, o);
  const sendSu = (c, o) => sendT(c, 200, 'pb.minigame.SudokuGameMsg', o);
  function suFinish(c) {
    const g = c.sudoku; if (!g) return; c.sudoku = null;
    const got = ctx.carnivalGameReward && ctx.carnivalGameReward(c, 3, g.score);
    if (got) log(`[#${c.id}] sudoku ${g.score} points: reward ${got[0]} x${got[1]}`);
  }
  ctx.onClose(c => { llkFinish(c); suFinish(c); });

  return {
    C_LINKGAME_OP(c, body) {
      const m = dec(c, 'C_LINKGAME_OP', body);
      if (m.opType === 1) {
        const g = c.linkGame = { score: 0, bomb: LLK.bomb, reset: LLK.reset, gate: 1, comb: 0, last: 0, end: Date.now() + LLK.time * 1000 };
        deal(g);
        return sendT(c, 196, 'carnival.LinkGameMsg', llkMsg(g, { opType: 1 }));
      }
      const g = c.linkGame; if (!g) return;
      if (m.opType === 5 || Date.now() > g.end + 5000) return llkFinish(c);
      if (m.opType === 2) {
        const a = { r: m.aX, c: m.aY }, b = { r: m.bX, c: m.bY };
        const ok = [a, b].every(p => p.r >= 0 && p.r < ROW && p.c >= 0 && p.c < COL) && joinable(g, a, b);
        if (!ok) return sendT(c, 196, 'carnival.LinkGameMsg', llkMsg(g, { opType: 2 }));
        return llkAfter(c, g, Object.assign({ opType: 2 }, llkRemove(g, a, b)));
      }
      if (m.opType === 3) {
        if (g.bomb <= 0) return;
        const pair = findPair(g); if (!pair) return;
        g.bomb--;
        return llkAfter(c, g, Object.assign({ opType: 3 }, llkRemove(g, pair[0], pair[1])));
      }
      if (m.opType === 4) {
        if (g.reset <= 0) return;
        g.reset--; reshuffle(g); if (!findPair(g)) reshuffle(g);
        return sendT(c, 196, 'carnival.LinkGameMsg', llkMsg(g, { opType: 4 }));
      }
    },

    C_SUDOKU_OP(c, body) {
      const m = dec(c, 'C_SUDOKU_OP', body);
      if (m.opType === 1) {
        let g = c.sudoku;
        if (!g || Date.now() > g.start + SU.time * 1000) g = c.sudoku = { score: 0, tools: SU.tools, start: Date.now() };
        newBoard(g);
        return sendSu(c, suMsg(g, { opType: 1, board: boardCells(g) }));
      }
      const g = c.sudoku; if (!g) return;
      if (m.opType === 6) { suFinish(c); return sendSu(c, { opType: 6, result: true }); }
      if (Date.now() > g.start + SU.time * 1000 + 5000) { suFinish(c); return; }
      const fill = (r, col, v) => { g.board[r][col] = v; g.answers.push({ row: r, col }); g.score += SU.cell; };
      // a full board: the next one (the client says "next" on a second opType 1)
      const next = () => { if (g.board.flat().every(x => x > 0)) { ctx.stat(c, 'sudokuStage'); newBoard(g); sendSu(c, suMsg(g, { opType: 1, board: boardCells(g) })); } };
      if (m.opType === 2) {
        const cell = m.cell || {}, r = cell.row, col = cell.col, v = cell.value;
        const ok = r >= 0 && r < 9 && col >= 0 && col < 9 && v >= 1 && v <= 9 && !g.given[r][col] && g.board[r][col] === 0 && !clash(g.board, r, col, v);
        if (!ok) return sendSu(c, { opType: 2, result: false });
        fill(r, col, v);
        sendSu(c, suMsg(g, { opType: 2, actCell: { row: r, col, value: v }, lastAns: { row: r, col, value: v } }));
        return next();
      }
      if (m.opType === 3) {
        if (g.tools <= 0) return sendSu(c, { opType: 3, result: false });
        const free = []; for (let r = 0; r < 9; r++) for (let col = 0; col < 9; col++) if (g.board[r][col] === 0 && !clash(g.board, r, col, g.solution[r][col])) free.push([r, col]);
        if (!free.length) return sendSu(c, { opType: 3, result: false });
        const [r, col] = free[0]; g.tools--; fill(r, col, g.solution[r][col]);
        sendSu(c, suMsg(g, { opType: 3, actCell: { row: r, col, value: g.solution[r][col] }, lastAns: { row: r, col, value: g.solution[r][col] } }));
        return next();
      }
      if (m.opType === 4) {
        const last = g.answers.pop(); if (!last) return sendSu(c, { opType: 4, result: false });
        const v = g.board[last.row][last.col]; g.board[last.row][last.col] = 0; g.score = Math.max(0, g.score - SU.cell);
        const prev = g.answers[g.answers.length - 1];
        return sendSu(c, suMsg(g, { opType: 4, actCell: { row: last.row, col: last.col, value: v }, lastAns: prev ? Object.assign({ value: g.board[prev.row][prev.col] }, prev) : undefined }));
      }
      if (m.opType === 5) {
        for (const a of g.answers) g.board[a.row][a.col] = 0;
        g.score = Math.max(0, g.score - SU.cell * g.answers.length); g.answers = [];
        return sendSu(c, suMsg(g, { opType: 5, board: boardCells(g) }));
      }
    },
  };
};
