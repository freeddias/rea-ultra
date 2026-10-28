// Shop (t_s_shop): buying with diamonds / bound diamonds / gold / medals, daily (per VIP level: VippN),
// weekly and monthly limits, gifts to other players (delivered by mail).
// Client: w_.sendShoping — payType 0 = bound diamonds first (BuyFrameI buy(true)), 1 = diamonds (after the
// "not enough bound diamonds" prompt, buy(false)); same as the cart / bag buys (useBind -> 0).
const MEDAL = 208001;    // "Madalya": the Honor price column
const MAZE_COIN = 208009;   // "Token de Cripta" / Labirent Parası (client d_.SHOP_MAZE_COIN_TEMPID)
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const weekKey = (d = new Date()) => { const m = new Date(d); m.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return dayKey(m); };
const monthKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const fmt = (d = new Date()) => `${dayKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

module.exports = (ctx) => {
  const { table, D, dec, sendT, alert, pay, grant, log } = ctx;
  const GOODS = new Map(table('t_s_shop').map(r => [r.Id, r]));

  // purchase counters, reset when their period changes
  function counters(p) {
    const s = p.s.shop = p.s.shop || {};
    if (s.day !== dayKey()) { s.day = dayKey(); s.daily = {}; }
    if (s.week !== weekKey()) { s.week = weekKey(); s.weekly = {}; }
    if (s.month !== monthKey()) { s.month = monthKey(); s.monthly = {}; }
    return s;
  }
  const infos = (p, m) => Object.entries(m).map(([id, n]) => ({ userId: p.id, itemId: Number(id), counts: n, buyDate: fmt() }));
  const state = p => { const s = counters(p); return { hasDataInfo: infos(p, s.daily), weeklyDataInfo: infos(p, s.weekly), monthDataInfo: infos(p, s.monthly) }; };

  // what n of this good cost; null when it has a price this server can't take
  function cost(p, g, n, payType) {
    const out = [];
    if (g.Point) out.push([payType === 0 && ctx.balance(p, -500) >= g.Point * n ? -500 : -400, g.Point * n]);
    if (g.GiftToken) out.push([-500, g.GiftToken * n]);
    if (g.Gold) out.push([-100, g.Gold * n]);
    if (g.Honor) out.push([MEDAL, g.Honor * n]);
    // Labirent Marketi (ShopType 4): Labirent Parası, an item (older official capture: 117 -> 92 for a
    // 25-coin good, then "Kronos’un Yetkisi x1 comprado com sucesso!")
    if (g.MazeCoin) out.push([MAZE_COIN, g.MazeCoin * n]);
    if (g.ConsortiaOffer) out.push(['offer', g.ConsortiaOffer * n]);   // Lonca Marketi: the member's own contribution (taken below)
    for (const k of [ 'ConsortiaPve', 'LordsScore', 'MineScore', 'Score']) if (g[k]) return null;
    return out;
  }

  const hasBuy = c => sendT(c, 4145, 'shop.ShopMsg', Object.assign(state(c.player), { refreshDate: fmt() }));
  ctx.onLoad.push(hasBuy);   // replaces the recorded login copy (logic.js NATIVE 4145)

  // one purchase; reply(result, message) is called once (also when it fails)
  function buy(c, b, payType, reply) {
      const p = c.player, g = GOODS.get(b.goodId), m = { payType };
      const n = Math.max(1, b.count || 1), to = b.receiveId && b.receiveId !== p.id ? b.receiveId : p.id;
      if (!g || !D.items.has(g.ItemId)) return reply(0, 'Produto não encontrado');
      const lv = p.s.grades;
      if ((g.NeedGrades && lv < g.NeedGrades) || (g.NeedMinGrade && lv < g.NeedMinGrade) || (g.NeedMaxGrade && lv > g.NeedMaxGrade)) return reply(0, 'Nível insuficiente');
      // maze goods need a record floor (client maze.shop.tips / tips2): MazeLayers Catacumbas, MazeLayers2 Necrópole
      // Lonca Marketi (ShopType 2): a member, the guild shop (building 2) at NeedConsortiaLevels
      if (g.ConsortiaOffer) {
        const G = require('../guilds'), guild = p.s.guild && G.get(p.s.guild.id);
        if (!guild) return reply(0, 'Você não é membro de uma guilda');
        if ((guild.levels[2] || 0) < (g.NeedConsortiaLevels || 0)) return reply(0, `Mercado da Guilda Lv. ${g.NeedConsortiaLevels} necessário`);
      }
      const rec = i => (((p.s.maze || {})[i]) || {}).maxIndex || 0;
      if (g.MazeLayers && rec(0) < g.MazeLayers) return reply(0, `É necessário passar o andar ${g.MazeLayers} das Catacumbas Esquecidas`);
      if (g.MazeLayers2 && rec(1) < g.MazeLayers2) return reply(0, `É necessário passar o andar ${g.MazeLayers2} da Necrópole Atormentada`);
      const s = counters(p), day = g['Vipp' + (p.s.vip || 0)];
      if (day >= 0 && (s.daily[g.Id] || 0) + n > day) return reply(0, 'Limite de compras de hoje atingido');
      if (g.WeeklyLimit >= 0 && (s.weekly[g.Id] || 0) + n > g.WeeklyLimit) return reply(0, 'Limite semanal de compra atingido');
      if (g.MonthLimit >= 0 && (s.monthly[g.Id] || 0) + n > g.MonthLimit) return reply(0, 'Limite mensal de compra atingido');
      const price = cost(p, g, n, m.payType);
      if (!price) { log(`[#${c.id}] shop ${g.Id}: price currency not implemented`); return reply(0, 'Este produto ainda não pode ser comprado'); }
      const name = ctx.itemName(g.ItemId);
      if (to === p.id) {
        // check the bag before paying: grant() refuses when full
        const slots = Math.ceil(n / ((D.items.get(g.ItemId) || {}).MaxCount || 1));
        if (p.s.bag.filter(i => (i.bagType ?? 1) === 1).length + slots > p.bagSize) return reply(0, 'Mochila cheia');
        const offer = price.filter(([t]) => t === 'offer').reduce((a, [, v]) => a + v, 0), rest = price.filter(([t]) => t !== 'offer');
        if (offer && ((p.s.guild && p.s.guild.offer) || 0) < offer) return reply(0, 'Contribuição de guilda insuficiente');
        if (!pay(c, rest)) return reply(0, 'Saldo insuficiente');
        if (offer) { p.s.guild.offer -= offer; ctx.sendPlayer(c); }
        grant(c, [[g.ItemId, n]], { quiet: true });
      } else {
        if (price.some(([t]) => t === 'offer')) return reply(0, 'Produtos do Mercado da Guilda não podem ser presenteados');
        if (!ctx.playerById(to)) return reply(0, 'Destinatário não encontrado');
        if (!pay(c, price)) return reply(0, 'Saldo insuficiente');
        ctx.sendMail(to, { title: 'Presente', contents: `${p.s.nickName} enviou ${name} x${n} para você.`, annex: [[g.ItemId, n]], from: p.id, fromName: p.s.nickName });
      }
      for (const k of ['daily', 'weekly', 'monthly']) s[k][g.Id] = (s[k][g.Id] || 0) + n;
      p.save();
      if (g.MazeCoin || g.ConsortiaOffer) { alert(c, `${name} x${n} comprado com sucesso!`); ctx.chat(c, `${name} x${n} comprado com sucesso!`); }   // official wording (capture)
      else alert(c, `${name} x${n} comprado`);
      reply(1);
  }

  return {
    U_C_SHOP_HASBUY: hasBuy,
    // a discounted good's bought counts (client getGoodsBuyNum {buyInfo {goodId, isDiscount}}) -> 4599 the same
    // counters with buyInfo {goodId} (capture: the reply carried the counters and the goodId; was a recorded copy)
    C_BUY_DISCOUNT(c, body) { const m = dec(c, 'C_BUY_DISCOUNT', body), b = m.buyInfo || {}; sendT(c, 4599, 'shop.ShopMsg', Object.assign(state(c.player), { buyInfo: { goodId: b.goodId || 0 } })); },
    // timed goods (client refreshTimeGoods): the same counters as 4145, on 4547 U_C_FLASHSALE_FRESH (client reads
    // refreshDate + FreshSeconds for the next refresh)
    C_FLASH_SALE_FRESH(c) { sendT(c, 4547, 'shop.ShopMsg', Object.assign(state(c.player), { refreshDate: fmt() })); },
    U_C_SHOP_BUY(c, body) {
      const m = dec(c, 'U_C_SHOP_BUY', body), p = c.player, b = m.buyInfo || {};
      const n = Math.max(1, b.count || 1), to = b.receiveId && b.receiveId !== p.id ? b.receiveId : p.id;
      buy(c, b, m.payType, (result, msg) => {
        if (msg) alert(c, msg);
        sendT(c, 90, 'shop.ShopMsg', Object.assign(state(p), { buyInfo: { goodId: b.goodId, count: n, receiveId: to, result, type: b.type || 0 } }));
      });
    },
    // fashion goods (client sendShoping with C_FASHION_SHOP_BUY {buyInfos: [one], payType}) -> 4486 (the
    // client registers that reply for the request); bought as U_C_SHOP_BUY would
    C_FASHION_SHOP_BUY(c, body) {
      const m = dec(c, 'C_FASHION_SHOP_BUY', body), p = c.player, b = (m.buyInfos || [])[0] || {};
      buy(c, b, m.payType, (result, msg) => {
        if (msg) alert(c, msg);
        sendT(c, 4486, 'shop.FashionShopMsg', { buyInfos: [{ goodId: b.goodId, count: Math.max(1, b.count || 1), receiveId: b.receiveId || p.id, result, type: b.type || 0 }], result: !!result, payType: m.payType || 0 });
        if (result) hasBuy(c);
      });
    },
    // shopping cart (client sendShopingCart): every line bought as U_C_SHOP_BUY would, stops at the first
    // failure; one 90 at the end (the client clears its pending state on it)
    C_SHOP_CAR_BUY(c, body) {
      const m = dec(c, 'C_SHOP_CAR_BUY', body), p = c.player, lines = m.carBuyInfo || [];
      let last = { goodId: 0, count: 0, result: 0 };
      for (const b of lines) {
        let ok = 0;
        buy(c, b, b.payType || 0, (result, msg) => { ok = result; if (msg) alert(c, msg); });
        last = { goodId: b.goodId, count: Math.max(1, b.count || 1), receiveId: b.receiveId || p.id, result: ok, type: 0 };
        if (!ok) break;
      }
      sendT(c, 90, 'shop.ShopMsg', Object.assign(state(p), { buyInfo: last }));
    },
  };
};
