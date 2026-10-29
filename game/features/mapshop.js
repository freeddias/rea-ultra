// Gizemli Market (outer city / town "mystery shop"; client fV / outerCityShopModel; t_s_outcityshop).
// Client-derived, no capture:
//  Type 2 = random goods (Random weight, MinLevel..MaxLevel, Point diamonds; client checks point + giftToken),
//  Type 1 = exchange goods (SecretStone = Gizemli Taş 2131057, or Score = the shop's points; WeeklyLimit).
//  C_MAPSHOPINFO {op, para1, para2, payType, count}: 1 info, 2 buy (para1 = Type; Type 2: para2 = slot index,
//  Type 1: para2 = MapShopId, count), 3 refresh (para1 = payType 1 diamonds: ShopFresh_NeedDiamond 75, at most
//  ShopFresh_DayCount 10 a day) -> 4946 MapShopInfoMsg {items, weeklyLimitItems, freshTime = the next automatic
//  refresh (ShopFresh_Time 1:00, 10:00, 15:00, 20:00), freshCount, score}.
// Our choices: 8 random slots; every diamond spent on random goods is one shop point.
const STONE = 2131057, SLOTS = 8;
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const dayKey = (d = new Date()) => fmt(d).slice(0, 10);
function weekKey(d = new Date()) { const m = new Date(d); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return dayKey(m); }

module.exports = (ctx) => {
  const { dec, sendT, alert, pay, grant, table, CONF, log } = ctx;
  const GOODS = table('t_s_outcityshop');
  const BY_ID = new Map(GOODS.map(g => [g.MapShopId, g]));
  const TIMES = String((table('t_s_config').find(r => r.ConfigName === 'ShopFresh_Time') || {}).ConfigValue || '1:00,10:00,15:00,20:00').split(',').map(t => t.split(':').map(Number));
  const PRICE = CONF.get('ShopFresh_NeedDiamond') || 75, PER_DAY = CONF.get('ShopFresh_DayCount') || 10;
  // the latest automatic refresh time before now / the next one after now
  function slot(now, dir) {
    const cands = [];
    for (let d = -1; d <= 1; d++) for (const [h, m] of TIMES) { const t = new Date(now); t.setDate(t.getDate() + d); t.setHours(h, m, 0, 0); cands.push(t); }
    cands.sort((a, b) => a - b);
    return dir < 0 ? cands.filter(t => t <= now).pop() : cands.find(t => t > now);
  }
  const weighted = (list, n) => { const pool = list.slice(), out = []; while (out.length < n && pool.length) { let x = Math.random() * pool.reduce((s, g) => s + (g.Random || 1), 0); const i = pool.findIndex(g => (x -= g.Random || 1) < 0); out.push(pool.splice(i < 0 ? 0 : i, 1)[0]); } return out; };
  function roll(p, s) {
    const pool = GOODS.filter(g => g.Type === 2 && p.s.grades >= (g.MinLevel || 0) && p.s.grades <= (g.MaxLevel || 999));
    s.items = weighted(pool, SLOTS).map((g, i) => ({ index: i, id: g.MapShopId, bought: false }));
  }
  function state(p) {
    const s = p.s.mapShop = p.s.mapShop || { items: [], score: 0, day: '', fresh: 0, week: '', weekly: {}, rolled: 0 };
    const now = new Date();
    if (s.day !== dayKey()) { s.day = dayKey(); s.fresh = 0; }
    if (s.week !== weekKey()) { s.week = weekKey(); s.weekly = {}; }
    if (!s.items.length || s.rolled < slot(now, -1).getTime()) { roll(p, s); s.rolled = now.getTime(); }
    return s;
  }
  function send(c) {
    const s = state(c.player);
    sendT(c, 4946, 'mapshop.MapShopInfoMsg', { userId: c.player.id, freshTime: fmt(slot(new Date(), 1)), freshCount: s.fresh, score: s.score, bless: 0,
      items: s.items.map(it => ({ index: it.index, mapshopitemid: it.id, isbuy: it.bought, count: (BY_ID.get(it.id) || {}).Count || 1 })),
      weeklyLimitItems: Object.entries(s.weekly).map(([id, n]) => ({ mapshopitemid: Number(id), count: n })) });
  }

  return {
    C_MAPSHOPINFO(c, body) {
      const m = dec(c, 'C_MAPSHOPINFO', body), p = c.player, s = state(p);
      if (m.op === 2) {
        if (m.para1 === 2) {
          const it = s.items.find(x => x.index === m.para2), g = it && BY_ID.get(it.id);
          if (!g || it.bought) { alert(c, 'Este produto já foi vendido'); return send(c); }
          const price = g.Point || 0, bound = m.payType === 0 && ctx.balance(p, -500) >= price;
          if (!pay(c, [[bound ? -500 : -400, price]])) { alert(c, 'Diamantes insuficientes'); return send(c); }
          if (!grant(c, [[g.ItemId, g.Count || 1]])) { grant(c, [[bound ? -500 : -400, price]], { quiet: true }); alert(c, 'Mochila cheia'); return send(c); }
          it.bought = true; s.score += price;
          ctx.stat(c, 'mysteryShop');   // daily activity Type 36
        } else if (m.para1 === 1) {
          const g = BY_ID.get(m.para2), n = Math.max(1, m.count || 1);
          if (!g || g.Type !== 1) return send(c);
          const lim = Number(g.WeeklyLimit);
          if (lim >= 0 && (s.weekly[g.MapShopId] || 0) + n > lim) { alert(c, 'Limite semanal atingido'); return send(c); }
          if (g.SecretStone) { if (!pay(c, [[STONE, g.SecretStone * n]])) { alert(c, 'Pedras Misteriosas insuficientes'); return send(c); } }
          else if (g.Score) { if (s.score < g.Score * n) { alert(c, 'Pontos insuficientes'); return send(c); } s.score -= g.Score * n; }
          if (!grant(c, [[g.ItemId, (g.Count || 1) * n]])) { alert(c, 'Mochila cheia'); return send(c); }
          s.weekly[g.MapShopId] = (s.weekly[g.MapShopId] || 0) + n;
          ctx.stat(c, 'mysteryShop');   // daily activity Type 36
        }
        p.save();
      } else if (m.op === 3) {
        if (s.fresh >= PER_DAY) { alert(c, 'Atualizações de hoje acabaram'); return send(c); }
        const bound = m.para2 === 2 && ctx.balance(p, -500) >= PRICE;
        if (!pay(c, [[bound ? -500 : -400, PRICE]])) { alert(c, 'Diamantes insuficientes'); return send(c); }
        s.fresh++; roll(p, s); s.rolled = Date.now(); p.save();
        log(`[#${c.id}] mystery shop refreshed (${s.fresh})`);
      }
      send(c);
    },
  };
};
