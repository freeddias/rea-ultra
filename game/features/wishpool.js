// Dilek Havuzu (client nY / ZV, wishpool window in the shop; t_s_wishingpool, t_s_wishingset). Client-derived,
// no capture:
//  A pool (Moda / Ouro Moda / Montaria / Ouro Montaria Dileği) costs CostItemNum x CostItemId per wish; with
//  UnitPrice > 0 the missing items are paid at UnitPrice diamonds each (client descTxt13), with 0 they are
//  required. WeeklyLimit wishes a week. Every wish adds 1 luck (buyCount); at MaxLuckValue the next wish is the
//  lucky one (client status 1: the weekly limit does not apply) drawn from LuckPoolRandom instead of
//  PoolRandom, and luck starts again.
//  PoolRandom / LuckPoolRandom "groupId,weight|..." -> a t_s_wishingset row of that PoolId by Random -> ItemId x
//  Data.
//  C_WISH_POOL_OP {poolId, optype 1} -> 198 WishPoolRespMsg {optype, wishResult, items} + 199 WishPoolInfoMsg
//  {Id, buyCount, WeekBuyCount}; 197 WishPoolAllMsg at login (the window reads its counters from it).
// Our choice: the lucky wish costs the same as a normal one.
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const weekKey = (d = new Date()) => { const m = new Date(d); m.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return dayKey(m); };

module.exports = (ctx) => {
  const { table, dec, sendT, alert, pay, grant, D } = ctx;
  const POOLS = new Map(table('t_s_wishingpool').map(r => [r.Id, r]));
  const SET = table('t_s_wishingset');
  const groups = s => String(s || '').split('|').filter(Boolean).map(x => x.split(',').map(Number));
  const weighted = (rows, w) => { let x = Math.random() * rows.reduce((n, r) => n + (w(r) || 0), 0); for (const r of rows) if ((x -= w(r) || 0) < 0) return r; return rows[rows.length - 1]; };

  function state(p) {
    const s = p.s.wishPool = p.s.wishPool || { week: '', pools: {} };
    if (s.week !== weekKey()) { s.week = weekKey(); for (const x of Object.values(s.pools)) x.week = 0; }
    return s;
  }
  const poolState = (s, id) => (s.pools[id] = s.pools[id] || { luck: 0, week: 0 });
  const infoOf = (s, id) => { const x = poolState(s, id); return { Id: id, buyCount: x.luck, WeekBuyCount: x.week }; };
  const sendAll = c => { const s = state(c.player); sendT(c, 197, 'active.WishPoolAllMsg', { allWishes: [...POOLS.keys()].map(id => infoOf(s, id)) }); };
  ctx.onLoad.push(sendAll);

  return {
    C_WISH_POOL_OP(c, body) {
      const m = dec(c, 'C_WISH_POOL_OP', body), p = c.player, s = state(p), pool = POOLS.get(m.poolId);
      const fail = msg => { if (msg) alert(c, msg); sendT(c, 198, 'active.WishPoolRespMsg', { optype: m.optype || 1, wishResult: false, items: [] }); };
      if (!pool) return fail('Poço dos desejos desconhecido');
      const x = poolState(s, pool.Id), lucky = x.luck >= pool.MaxLuckValue;
      if (!lucky && x.week >= pool.WeeklyLimit) return fail('Seus desejos desta semana acabaram');
      // the cost: the items owned, the rest in diamonds when the pool allows it
      const have = Math.min(p.countTemplate(pool.CostItemId), pool.CostItemNum), missing = pool.CostItemNum - have;
      if (missing && !pool.UnitPrice) return fail('Item de desejo insuficiente');
      const cost = []; if (have) cost.push([pool.CostItemId, have]); if (missing) cost.push([-400, missing * pool.UnitPrice]);
      if (!pay(c, cost)) return fail('Diamantes insuficientes');
      const gid = weighted(groups(lucky ? pool.LuckPoolRandom : pool.PoolRandom), g => g[1])[0];
      const rows = SET.filter(r => r.PoolId === gid && D.items.has(r.ItemId));
      const row = rows.length ? weighted(rows, r => r.Random) : null;
      if (!row) return fail('Poço de recompensas vazio');
      grant(c, [[row.ItemId, row.Data || 1]], { quiet: true });
      if (lucky) x.luck = 0; else { x.luck = Math.min(pool.MaxLuckValue, x.luck + 1); x.week++; }
      p.save();
      sendT(c, 198, 'active.WishPoolRespMsg', { optype: m.optype || 1, wishResult: true, items: [{ itemId: row.ItemId, count: row.Data || 1 }] });
      sendT(c, 199, 'active.WishPoolInfoMsg', infoOf(s, pool.Id));
    },
  };
};
