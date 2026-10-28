// Pazar (client TY market manager / Market windows): an order book between our players, priced in diamonds.
// Client-derived (no capture). Reply types are the client's readBody ones (codemap had other names):
//  C_MARKET_INFO_REQ {op, templateId}: 1 -> 4353 MarketItemListMsg {list: [{templateId, total sell count,
//   point = lowest sell price, purchaseTotal}]}, 2 -> 4354 MarketOrderListMsg {op 2, orderList: my orders},
//   4 -> 4356 MarketItemSellInfoMsg {sellTotal, sellMinPrice, purchaseMaxPrice}, 5 -> 4357
//   MarketItemPurchaseInfoMsg {sellPriceList / purchasePriceList: [{top, point, count}] best first}
//  C_MARKET_ORDER_ACTION {op, orderId, type, templateId, count, point} -> 4352 MarketOrderRespMsg {op, result,
//   type, orderMsg: changed orders}: op 1 place (type 1 sell one item at point — the item leaves the bag;
//   type 2 buy count at point each — count x point diamonds held), op 2 cancel (what is left comes back),
//   op 3 take (items bought / diamonds earned). A new order trades at once with the best opposite order
//   (sell: highest buy >= price; buy: cheapest sells <= price) at the waiting order's price; the seller gets
//   the price minus Market_TaxRare (10) %. Owners online get 4354 op 100 with their changed orders.
//  Order status: 1 waiting, 2 traded (to take), 6 taken; cancelled orders are dropped (client op 3 removes).
//  Daily orders: sells Market_OrderDayCount "5,5,500000" (free, then paid ones for gold each), buys
//  Market_PurchaseRelease "5,10,500000"; Market_MaxOrder 100 = most items in one buy order.
// Shared state in the database's meta 'market' (store.js). Our choices: no expiry, bound items can be sold.
const store = require('../../store');
const SELL = 1, BUY = 2, WAIT = 1, TRADED = 2, TAKEN = 6;
const LIMITS = new Map(require('../../templates').table('t_s_itempricelimit').map(r => [r.ItemId, r]));
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

module.exports = (ctx) => {
  const { D, dec, sendT, online, alert, pay, grant, table, CONF, sysTime, log } = ctx;
  const state = store.getMeta('market', { seq: 0, orders: [] });
  const save = () => store.setMeta('market', state);
  const cfg = n => String((table('t_s_config').find(r => r.ConfigName === n) || {}).ConfigValue || '').split(',').map(Number);
  const [SELL_FREE, SELL_PAID, SELL_GOLD] = cfg('Market_OrderDayCount'), [BUY_FREE, BUY_PAID, BUY_GOLD] = cfg('Market_PurchaseRelease');
  const TAX = (CONF.get('Market_TaxRare') || 10) / 100, MAX_COUNT = CONF.get('Market_MaxOrder') || 100;

  function day(p) {
    const d = p.s.market = p.s.market || {};
    if (d.day !== dayKey()) Object.assign(d, { day: dayKey(), sellFree: 0, sellPaid: 0, buyFree: 0, buyPaid: 0 });
    return d;
  }
  const counts = p => { const d = day(p); return { freeUseMarkeOrderCount: d.sellFree, payUseMarketOrderCount: d.sellPaid, freeUsePurchaseCount: d.buyFree, payUsePurchaseCount: d.buyPaid }; };
  const msg = o => ({ orderId: String(o.id), type: o.type, templateId: o.tid, count: o.count, point: o.point, status: o.status, createTime: sysTime(new Date(o.created)),
    extract: o.extract, tradingPoint: o.earned, tax: o.tax, isExist: o.status !== TAKEN, actionTime: sysTime(new Date(o.action || o.created)) });
  const waiting = (tid, type) => state.orders.filter(o => o.tid === tid && o.type === type && o.status === WAIT && o.left > 0);
  const mine = p => state.orders.filter(o => o.owner === p.id && o.status !== TAKEN);
  function notify(owners) {
    for (const id of new Set(owners)) {
      const c = online.get(id); if (!c || !c.player) continue;
      sendT(c, 4354, 'market.MarketOrderListMsg', Object.assign({ op: 100, orderList: mine(c.player).map(msg) }, counts(c.player)));
    }
  }
  // one trade of n items at price: the sell order's item to the buy order, diamonds less tax to the seller
  function trade(sell, buy, n, price) {
    const now = Date.now(), tax = Math.ceil(price * n * TAX);
    sell.left -= n; sell.earned += price * n - tax; sell.tax += tax; sell.action = now;
    buy.left -= n; buy.extract += n; buy.refund += (buy.point - price) * n; buy.action = now;
    if (sell.left <= 0) sell.status = TRADED;
    if (buy.left <= 0) buy.status = TRADED;
  }
  function match(o) {
    const touched = [];
    if (o.type === SELL) {
      for (const b of waiting(o.tid, BUY).filter(b => b.point >= o.point && b.owner !== o.owner).sort((x, y) => y.point - x.point || x.created - y.created)) {
        if (o.left <= 0) break;
        trade(o, b, Math.min(o.left, b.left), b.point); touched.push(b);
      }
    } else {
      for (const s of waiting(o.tid, SELL).filter(s => s.point <= o.point && s.owner !== o.owner).sort((x, y) => x.point - y.point || x.created - y.created)) {
        if (o.left <= 0) break;
        trade(s, o, Math.min(o.left, s.left), s.point); touched.push(s);
      }
    }
    return touched;
  }
  const priceList = (list, best) => {
    const by = new Map();
    for (const o of list) by.set(o.point, (by.get(o.point) || 0) + o.left);
    return [...by].sort((a, b) => best(a[0], b[0])).slice(0, 5).map(([point, count], i) => ({ top: i + 1, point, count }));
  };

  return {
    C_MARKET_INFO_REQ(c, body) {
      const m = dec(c, 'C_MARKET_INFO_REQ', body), p = c.player;
      if (m.op === 1) {
        const tids = [...new Set(state.orders.filter(o => o.status === WAIT && o.left > 0).map(o => o.tid))];
        return sendT(c, 4353, 'market.MarketItemListMsg', { list: tids.map(tid => {
          const s = waiting(tid, SELL), b = waiting(tid, BUY);
          return { templateId: tid, total: s.reduce((n, o) => n + o.left, 0), point: s.length ? Math.min(...s.map(o => o.point)) : 0, purchaseTotal: b.reduce((n, o) => n + o.left, 0) };
        }) });
      }
      if (m.op === 2) return sendT(c, 4354, 'market.MarketOrderListMsg', Object.assign({ op: 2, orderList: mine(p).map(msg) }, counts(p)));
      const s = waiting(m.templateId, SELL), b = waiting(m.templateId, BUY);
      if (m.op === 4) return sendT(c, 4356, 'market.MarketItemSellInfoMsg', { templateId: m.templateId, sellTotal: s.reduce((n, o) => n + o.left, 0),
        sellMinPrice: s.length ? Math.min(...s.map(o => o.point)) : 0, purchaseMaxPrice: b.length ? Math.max(...b.map(o => o.point)) : 0 });
      if (m.op === 5) return sendT(c, 4357, 'market.MarketItemPurchaseInfoMsg', { templateId: m.templateId, sellTotal: s.reduce((n, o) => n + o.left, 0), purchaseTotal: b.reduce((n, o) => n + o.left, 0),
        sellPriceList: priceList(s, (x, y) => x - y), purchasePriceList: priceList(b, (x, y) => y - x) });
    },
    C_MARKET_ORDER_ACTION(c, body) {
      const m = dec(c, 'C_MARKET_ORDER_ACTION', body), p = c.player;
      const reply = (result, orders = [], text) => { if (text) alert(c, text); sendT(c, 4352, 'market.MarketOrderRespMsg', Object.assign({ op: m.op, result, type: m.type || 0, orderMsg: orders.map(msg) }, counts(p))); };
      if (m.op === 1) {
        const tp = D.items.get(m.templateId), point = Math.floor(m.point || 0), d = day(p);
        if (!tp || point <= 0) return reply(false, [], 'Pedido inválido');
        // price range of the item (t_s_itempricelimit MinPrice..MaxPrice; the client limits its price box to it)
        const lim = LIMITS.get(tp.TemplateId);
        if (lim && (point < lim.MinPrice || point > lim.MaxPrice)) return reply(false, [], `O preço deve estar entre ${lim.MinPrice}-${lim.MaxPrice} diamantes`);
        const sell = m.type === SELL, n = sell ? 1 : Math.min(MAX_COUNT, Math.max(1, Math.floor(m.count || 1)));
        // the day's free orders, then paid ones
        const [free, paid, gold] = sell ? [SELL_FREE, SELL_PAID, SELL_GOLD] : [BUY_FREE, BUY_PAID, BUY_GOLD];
        const used = sell ? [d.sellFree, d.sellPaid] : [d.buyFree, d.buyPaid];
        const fee = used[0] + n <= free ? 0 : used[1] + n <= paid ? gold * n : -1;
        if (fee < 0) return reply(false, [], 'Limite de ordens de hoje esgotado');
        if (fee && ctx.balance(p, -100) < fee) return reply(false, [], 'Ouro insuficiente');
        if (sell) {
          if (!p.countTemplate(m.templateId)) return reply(false, [], 'Este item não está na mochila');
          if (!pay(c, [[m.templateId, 1]])) return reply(false);
        } else if (!pay(c, [[-400, point * n]])) return reply(false, [], 'Diamantes insuficientes');
        if (fee) pay(c, [[-100, fee]]);
        if (fee) sell ? d.sellPaid += n : d.buyPaid += n; else sell ? d.sellFree += n : d.buyFree += n;
        const o = { id: ++state.seq, owner: p.id, type: sell ? SELL : BUY, tid: m.templateId, count: n, left: n, point, status: WAIT, created: Date.now(), extract: 0, earned: 0, tax: 0, refund: 0 };
        state.orders.push(o);
        const touched = match(o);
        save(); p.save();
        reply(true, [o]);
        notify(touched.map(x => x.owner).filter(id => id !== p.id));
        log(`[#${c.id}] market ${sell ? 'sell' : 'buy'} ${m.templateId} x${n} @${point}${touched.length ? ' traded' : ''}`);
        return;
      }
      const o = state.orders.find(x => String(x.id) === String(m.orderId) && x.owner === p.id);
      if (!o) return reply(false, [], 'Ordem não encontrada');
      if (m.op === 2) {   // cancel: back what is left (and take what was traded)
        if (o.status !== WAIT) return reply(false, [], 'Esta ordem não pode mais ser cancelada');
        const back = o.type === SELL ? [[o.tid, o.left]] : [[-400, o.left * o.point + o.refund], [o.tid, o.extract]];
        back.push([-400, o.earned]);
        if (!grant(c, back.filter(([, n]) => n > 0), { quiet: true })) return reply(false, [], 'Mochila cheia');
        o.left = 0; o.extract = 0; o.earned = 0; o.refund = 0; o.status = TAKEN;
        state.orders = state.orders.filter(x => x !== o); save();
        return reply(true, [o]);
      }
      if (m.op === 3) {   // take
        const got = o.type === SELL ? [[-400, o.earned]] : [[o.tid, o.extract], [-400, o.refund]];
        if (!got.some(([, n]) => n > 0)) return reply(false, [], 'Nada para retirar');
        if (!grant(c, got.filter(([, n]) => n > 0))) return reply(false, [], 'Mochila cheia');
        o.earned = 0; o.extract = 0; o.refund = 0;
        if (o.status === TRADED) { o.status = TAKEN; state.orders = state.orders.filter(x => x !== o); }
        save();
        return reply(true, [o]);
      }
      reply(false);
    },
  };
};
