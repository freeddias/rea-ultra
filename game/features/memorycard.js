// Hafıza Kartı (new memory card; client M_ MemoryCardManager / NewMemoryCardFrame; t_s_memorycard Type 1 normal,
// Type 2 the round's special item; config memorycard_*). Client-derived (help text NewMemoryCardFrame.helpTxt):
//  20 cards (k_.CARD_NUM) = 10 pairs; two equal cards turned = the item. C_NEW_MEMORY_CARD_OP {opType, value1,
//  value2}: 1 open, 2 choose cards value1 / value2 (one step), 3 buy memorycard_buytimes (10) steps for
//  memorycard_costdiamond (100) diamonds (memorycard_maxtimes 10 a day, at most memorycard_limittimes 99 bought steps),
//  4 refresh = a new round (once the special item is won, or the board is empty).
//  -> 4301 NewMemoryCardMsg {opType, freeStep, buyStep, buyCount, dropInfo "tid,n|..." (today's wins), posInfo
//  "i,j,..." (matched cards), specialInfo "tid,n", canRefresh, isMatch, result "i,tid,n|j,tid,n"}; 4300
//  NewMemoryCardState {isOpen, beginDate, endDate} (the client drops 4301 while it is closed).
// Our choices: the activity is always open (a 30-day window from today, renewed); memorycard_defaulttimes (15) free
// steps a day, free steps first; a round = the special pair (one Type 2 row) + 9 distinct Type 1 pairs.
module.exports = (ctx) => {
  const { table, dec, sendT, alert, pay, grant, CONF, sysTime } = ctx;
  const ROWS = table('t_s_memorycard'), N1 = ROWS.filter(r => r.Type === 1), N2 = ROWS.filter(r => r.Type === 2);
  const FREE = CONF.get('memorycard_defaulttimes') || 15, BUY_STEPS = CONF.get('memorycard_buytimes') || 10, PRICE = CONF.get('memorycard_costdiamond') || 100;
  const MAX_BUYS = CONF.get('memorycard_maxtimes') || 10, MAX_STEPS = CONF.get('memorycard_limittimes') || 99, CARDS = 20;
  const day = () => sysTime().slice(0, 10);
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  function newRound(s) {
    const sp = N2[Math.floor(Math.random() * N2.length)], pairs = [sp, ...shuffle(N1.slice()).slice(0, CARDS / 2 - 1)];
    s.board = shuffle(pairs.flatMap(r => [[r.ItemId, r.ItemNum], [r.ItemId, r.ItemNum]]));
    s.special = [sp.ItemId, sp.ItemNum]; s.matched = []; s.gotSpecial = false;
  }
  function state(p) {
    const s = p.s.memoryCard = p.s.memoryCard || { buyStep: 0 };
    if (s.day !== day()) Object.assign(s, { day: day(), free: FREE, buys: 0, drops: [] });
    if (!s.board) newRound(s);
    return s;
  }
  const msg = (s, op, extra = {}) => Object.assign({ opType: op, freeStep: s.free, buyStep: s.buyStep, buyCount: s.buys, dropInfo: s.drops.map(([t, n]) => `${t},${n}`).join('|'),
    posInfo: s.matched.join(','), specialInfo: s.special.join(','), canRefresh: s.gotSpecial || s.matched.length >= CARDS, isMatch: false, result: '' }, extra);
  const fmt = d => d.toISOString().slice(0, 10) + ' 00:00:00';
  if (ctx.events) ctx.events.register('memoryCard', () => true);
  const cardOpen = () => {
    const f = ctx.events && ctx.events.force('memoryCard');
    if (f === false) return false;
    if (f === true) return true;
    return true;
  };
  const openState = c => {
    const now = new Date(), open = cardOpen();
    sendT(c, 4300, 'NewMemoryCardState', { isOpen: open, beginDate: fmt(now), endDate: fmt(new Date(now.getTime() + 30 * 86400000)) });
  };
  ctx.onLoad.push(openState);

  return {
    C_NEW_MEMORY_CARD_OP(c, body) {
      if (!cardOpen()) { alert(c, 'Cartas da Memória não estão abertas'); return; }
      const m = dec(c, 'C_NEW_MEMORY_CARD_OP', body), p = c.player, s = state(p);
      const send = (extra) => sendT(c, 4301, 'NewMemoryCardMsg', msg(s, m.opType, extra));
      switch (m.opType) {
        case 2: {
          const a = m.value1, b = m.value2;
          if (a === b || [a, b].some(i => !(i >= 0 && i < CARDS) || s.matched.includes(i))) return send();
          if (s.free + s.buyStep <= 0) { alert(c, 'Passos restantes insuficientes, compre passos!'); return send(); }
          if (s.free > 0) s.free--; else s.buyStep--;
          const [x, y] = [s.board[a], s.board[b]], match = x[0] === y[0] && x[1] === y[1];
          if (match) {
            s.matched.push(a, b); ctx.stat(c, 'cardMatch');   // season pass task 74
            grant(c, [[x[0], x[1]]]);
            const d = s.drops.find(e => e[0] === x[0]); if (d) d[1] += x[1]; else s.drops.push([x[0], x[1]]);
            if (x[0] === s.special[0] && x[1] === s.special[1]) s.gotSpecial = true;
          }
          p.save();
          return send({ isMatch: match, result: `${a},${x[0]},${x[1]}|${b},${y[0]},${y[1]}` });
        }
        case 3:
          if (s.buys >= MAX_BUYS) { alert(c, 'Compras de hoje atingiram o limite'); break; }
          if (s.buyStep + BUY_STEPS > MAX_STEPS) { alert(c, 'Número de passos atingiu o limite'); break; }
          if (!pay(c, [[-400, PRICE]])) { alert(c, 'Diamantes insuficientes'); break; }
          s.buys++; s.buyStep += BUY_STEPS; p.save(); ctx.sendPlayer(c);
          break;
        case 4:
          if (!(s.gotSpecial || s.matched.length >= CARDS)) { alert(c, 'Obtenha primeiro o item especial desta rodada'); break; }
          newRound(s); p.save();
          break;
        default: break;
      }
      send();
    },
  };
};
