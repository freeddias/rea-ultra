// Ouro Yol (golden road; client RA manager / yA model / GoldenRoadWnd). From the 2026-10-23 live capture + client:
//  Shown by 4590 U_C_TOP_TOOL_BTN {param1 2, param4 start, param5 end, param7 open}. C_GOLDENROAD_FRESH
//  {refreshType 1 view / 2 new cells for Refresh_Price 10 diamonds} -> 4933 GoldenRoadMsg {cellInfo [20 x {itemID,
//  count}] (itemID -1 = "?" cell), playerStatue = the cell the player stands on, score}. C_GOLDENROAD_CASTDICE
//  {diceType = mode 1 / 2 / 5 (DicePrice 10 x mode diamonds, rewards x mode) or 0 = super dice with consumeType = the
//  point chosen 1..6 (one per Special_Dice_Redeem_Points 100 score, max 10 kept, rewards x2), isBatch = BatchCount 50
//  throws} -> 4934 CastDiceMsg {curPos, diceNumber, score, tempIds "tid,.."}. Each walk +1 score (capture 1, 2, 3).
//  The client then sends C_GOLDENROAD_BROADCAST {requestBroadcast true} and the items arrive (capture: 115 bag
//  update + "Obtido:" alert after it).
// Our choices: the capture's 20 cells are the board (a paid refresh shuffles them); "?" moves 1..3 cells forward or
// back and takes that cell; the event runs Monday..Sunday every week, score and position reset with it.
const BOARD = [[208023, 1], [2040111, 1], [-1, 0], [2271001, 5], [-1000, 50], [208023, 1], [2271001, 5], [2030102, 1], [208017, 1], [2125057, 1],
  [2125057, 1], [2160043, 1], [208017, 1], [3040001, 1], [2120043, 1], [2060014, 1], [3040001, 1], [2300001, 5], [-910, 10], [208052, 1]];
const PRICE = 10, BATCH = 50, REDEEM = 100, SUPER_MAX = 10, REFRESH = 10, QUESTION = -1;

module.exports = (ctx) => {
  const { dec, sendT, alert, pay, grant, sysTime } = ctx;
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function week() {
    const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const e = new Date(d); e.setDate(d.getDate() + 6);
    return { start: `${ymd(d)} 00:00:00`, end: `${ymd(e)} 23:59:59`, key: ymd(d) };
  }
  function state(p) {
    const w = week().key;
    let s = p.s.goldenRoad;
    if (!s || s.week !== w) s = p.s.goldenRoad = { week: w, pos: 0, score: 0, cells: BOARD.map(x => x.slice()), pending: [] };
    return s;
  }
  const superDice = s => Math.min(SUPER_MAX, Math.floor(s.score / REDEEM));
  const info = c => { const s = state(c.player);
    sendT(c, 4933, 'goldenroad.GoldenRoadMsg', { cellInfo: s.cells.map(([itemID, count]) => ({ itemID, count })), playerStatue: s.pos, score: s.score }); };
  function flush(c) {
    const s = state(c.player); if (!s.pending.length) return;
    const merged = new Map(); for (const [t, n] of s.pending) merged.set(t, (merged.get(t) || 0) + n);
    if (!grant(c, [...merged])) { alert(c, 'Mochila cheia'); return; }
    s.pending = []; c.player.save();
  }
  if (ctx.events) ctx.events.register('goldenRoad', () => true);
  const roadOpen = () => {
    const f = ctx.events && ctx.events.force('goldenRoad');
    if (f === false) return false;
    if (f === true) return true;
    return true;
  };
  ctx.onLoad.push(c => {
    if (!roadOpen()) return;
    const w = week();
    sendT(c, 4590, 'simple.PropertyMsg', { param1: 2, param4: w.start, param5: w.end, param6: w.end, param7: true, param9: true });
  });

  // one walk of n cells; returns the template ids gained
  function walk(s, n, k) {
    const got = [];
    s.pos = (s.pos + n) % s.cells.length;
    let [tid, cnt] = s.cells[s.pos];
    if (tid === QUESTION) {
      const step = (1 + Math.floor(Math.random() * 3)) * (Math.random() < 0.5 ? -1 : 1);
      s.pos = (s.pos + step + s.cells.length) % s.cells.length;
      [tid, cnt] = s.cells[s.pos];
    }
    if (tid !== QUESTION && cnt > 0) { s.pending.push([tid, cnt * k]); got.push(tid); }
    s.score++;
    return got;
  }

  return {
    C_GOLDENROAD_FRESH(c, body) {
      if (!roadOpen()) { alert(c, 'Estrada Dourada não está aberta'); return; }
      const m = dec(c, 'C_GOLDENROAD_FRESH', body), s = state(c.player);
      if (m.refreshType === 2) {
        if (!pay(c, [[-400, REFRESH]])) { alert(c, 'Diamantes insuficientes'); return; }
        for (let i = s.cells.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [s.cells[i], s.cells[j]] = [s.cells[j], s.cells[i]]; }
        c.player.save(); ctx.sendPlayer(c);
      }
      info(c);
    },
    C_GOLDENROAD_CASTDICE(c, body) {
      if (!roadOpen()) { alert(c, 'Estrada Dourada não está aberta'); return; }
      const m = dec(c, 'C_GOLDENROAD_CASTDICE', body), p = c.player, s = state(p);
      flush(c);   // the last throw's items, if its broadcast never came
      let throws = 1, k, fixed = 0;
      if (!m.diceType) {   // super dice: the point is chosen, rewards x2
        if (superDice(s) < 1) { alert(c, 'Super dado insuficiente'); return; }
        if (!(m.consumeType >= 1 && m.consumeType <= 6)) return;
        s.score -= REDEEM; k = 2; fixed = m.consumeType;
      } else {
        k = [1, 2, 5].includes(m.diceType) ? m.diceType : 1;
        throws = m.isBatch ? BATCH : 1;
        if (!pay(c, [[-400, PRICE * k * throws]])) { alert(c, 'Diamantes insuficientes'); return; }
        ctx.sendPlayer(c);
      }
      const got = []; let last = 0;
      for (let i = 0; i < throws; i++) { last = fixed || 1 + Math.floor(Math.random() * 6); got.push(...walk(s, last, k)); }
      p.save();
      sendT(c, 4934, 'goldenroad.CastDiceMsg', { curPos: s.pos, diceNumber: last, score: s.score, tempIds: got.join(',') });
    },
    C_GOLDENROAD_BROADCAST(c) { flush(c); },
  };
};
