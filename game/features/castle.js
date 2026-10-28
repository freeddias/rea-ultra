// Castle queues and the council levy ("Vergi Topla").
//  levy (C_GOLD_IMPOSE {op, payType}): the council (901) building's propterty1 = levies used today,
//   propterty2 = free levies per day (5), levyNum = paid levies used today (client: remaining =
//   propterty2 - propterty1, the paid button shows once those are gone). Capture: one free levy at goldYield
//   6500 gave exactly 39,000 gold (6 hours of production) and put the levy order (type 3) on 600 s.
//   Paid levies: t_s_config Inner_Levy (diamonds per extra levy, its length = extra levies per day),
//   payType 1 bound diamonds, 2 diamonds (client alertCallback); the client needs character Lv14.
//  second build queue (U_C_BUILDING_ORDERADD {payType}): Order_NeedPay (150), payType 0 bound / 1 diamonds
//   (client buyCallBack), at most 2 build queues (client buildOrderLimit).
//  quick-cool (U_C_BUILDING_ORDER_QUICK {orderId, index}): QuickenOrder_Price (2) per started 10 minutes;
//   orderId 0 = every build queue; index 1 diamonds, 2 bound diamonds, 0 (the client's VIP shortcut) bound
//   first. Not in the capture: reply format from the client handler (OrderQuickRspMsg.orderInfo).
const LEVY_HOURS = 6, LEVY_COOL = 600, LEVY_GRADE = 14, BUILD_LIMIT = 2;

module.exports = (ctx) => {
  const { dec, sendT, sendCastle, sendPlayer, alert, chat, pay, produceGold, M, CONF, table, sysTime, orders: O } = ctx;
  const cfg = name => String((table('t_s_config').find(r => r.ConfigName === name) || {}).ConfigValue || '');
  const INNER_LEVY = cfg('Inner_Levy').split(',').map(Number).filter(Boolean);
  const ORDER_PAY = CONF.get('Order_NeedPay') || 150, QUICK_PRICE = CONF.get('QuickenOrder_Price') || 2;

  const council = p => p.s.buildings.find(b => b.sonType === 901);
  // daily reset of the levy counters
  function today(p) {
    const b = council(p), day = sysTime().slice(0, 10);
    if (b && p.s.levyDay !== day) { p.s.levyDay = day; b.p1 = 0; b.levyNum = 0; b.p2 = 5 + (ctx.vipPriv ? ctx.vipPriv(p, 36) : 0); }   // 5 free + VIP privilege 36
    return b;
  }
  ctx.onLoad.push(c => { if (today(c.player)) c.player.save(); });   // before the building list goes out

  // bound diamonds or diamonds; prefer: 'bind' | 'point' | 'any' (bound first)
  function payPoints(c, n, prefer) {
    if (n <= 0) return true;
    if (prefer !== 'point' && pay(c, [[-500, n]])) return true;
    if (prefer !== 'bind' && pay(c, [[-400, n]])) return true;
    return false;
  }
  const levyState = b => ({ leftImpose: b.p1 || 0, maxImpose: b.p2 || 5, payImpose: b.levyNum || 0 });

  return {
    // a new building (client BuildingManager.creatBuilding {sonType}): the grade-1 template of that SonType for
    // the player's camp; its PreTemplateId buildings (at least that grade) and PlayerGrades are needed, it costs
    // GoldConsume gold and CrystalsConsume crystals. Answer as the quest unlocks do: 4130 + castle.
    C_BUILDING_CREATE(c, body) {
      const m = dec(c, 'C_BUILDING_CREATE', body), p = c.player, D = ctx.D;
      if (p.s.buildings.some(b => b.sonType === m.sonType)) { alert(c, 'Este edifício já existe'); return; }
      const t = [...D.buildings.values()].filter(x => x.SonType === m.sonType && (!x.Camp || x.Camp === p.s.camp)).sort((x, y) => x.BuildingGrade - y.BuildingGrade)[0];
      if (!t) { alert(c, 'Este edifício não pode ser construído'); return; }
      if (p.s.grades < (t.PlayerGrades || 0)) { alert(c, `Nível ${t.PlayerGrades} necessário`); return; }
      for (const id of String(t.PreTemplateId || '').split(',').map(Number).filter(Boolean)) {
        const need = D.buildings.get(id);
        if (need && !p.s.buildings.some(b => b.sonType === need.SonType && b.grade >= need.BuildingGrade)) { alert(c, `${ctx.nameOf(need, 'BuildingName')} Lv. ${need.BuildingGrade} necessário`); return; }
      }
      if (!pay(c, [[-100, t.GoldConsume || 0], [-600, t.CrystalsConsume || 0]])) { alert(c, 'Recursos insuficientes'); return; }
      p.s.nextBuildingId = p.s.nextBuildingId || p.id * 100 + 50;
      const b = { id: p.s.nextBuildingId++, templateId: t.TemplateId, sonType: t.SonType, grade: t.BuildingGrade, p1: 0, p2: 0 };
      p.s.buildings.push(b); p.save();
      sendT(c, 4130, 'building.BuildingInfoListMsg', { result: true, building: [{ userId: p.id, buildingId: b.id, templateId: b.templateId, sonType: b.sonType }] });
      sendCastle(c);
      alert(c, `${ctx.nameOf(t, 'BuildingName')} construído`);
    },
    C_GOLD_IMPOSE(c, body) {
      const m = dec(c, 'C_GOLD_IMPOSE', body), p = c.player, b = today(p);
      if (!b) return;
      if (p.s.grades < LEVY_GRADE) { alert(c, `Personagem Lv. ${LEVY_GRADE} necessário`); return; }
      O.ensureOrders(c);
      const order = O.ordersOf(p, O.LEVY)[0];
      if (!m.op) {
        if ((b.p1 || 0) >= (b.p2 || 5)) { alert(c, 'Suas coletas de imposto de hoje acabaram'); return; }
        if (order && O.remainOf(order)) { alert(c, 'Imposto ainda não pode ser coletado'); return; }
        b.p1 = (b.p1 || 0) + 1;
      } else {
        const used = b.levyNum || 0;
        if (used >= INNER_LEVY.length) { alert(c, 'Suas coletas extras de imposto de hoje acabaram'); return; }
        if (!payPoints(c, INNER_LEVY[used], m.payType === 1 ? 'bind' : 'point')) { alert(c, m.payType === 1 ? 'Diamantes vinculados insuficientes' : 'Diamantes insuficientes'); return; }
        b.levyNum = used + 1;
        sendPlayer(c);
      }
      produceGold(p);
      const gold = LEVY_HOURS * M.goldYield(p);
      p.s.gold += gold;
      ctx.bump(c, 42, 0);   // quest condition 42 "Vergi Topla"
      ctx.stat(c, 'levy');   // day log (features/recover.js)
      p.save();
      sendCastle(c);
      const text = `Coletado com sucesso: ${gold.toLocaleString('en-US')} de ouro`;
      alert(c, text);
      sendT(c, 4242, 'simple.GoldImposeMsg', levyState(b));
      if (!m.op && order) O.useOrder(c, order, ctx.vipPriv && ctx.vipPriv(c.player, 33) ? 0 : LEVY_COOL);   // VIP privilege 33 (TAX_COOLDOWN): no levy wait
      chat(c, text);
      p.save();
    },

    U_C_BUILDING_ORDERADD(c, body) {
      const m = dec(c, 'U_C_BUILDING_ORDERADD', body), p = c.player;
      O.ensureOrders(c);
      if (O.ordersOf(p, O.BUILD).length >= BUILD_LIMIT) { alert(c, 'Fila de construção no limite máximo'); return; }
      if (!payPoints(c, ORDER_PAY, m.payType === 0 ? 'bind' : 'point')) { alert(c, m.payType === 0 ? 'Diamantes vinculados insuficientes' : 'Diamantes insuficientes'); return; }
      sendPlayer(c);
      O.addOrder(c, O.BUILD);
    },

    U_C_BUILDING_ORDER_QUICK(c, body) {
      const m = dec(c, 'U_C_BUILDING_ORDER_QUICK', body), p = c.player;
      O.ensureOrders(c);
      const list = (m.orderId ? (p.s.orders || []).filter(o => o.id === m.orderId) : O.ordersOf(p, O.BUILD)).filter(o => O.remainOf(o));
      if (!list.length) { sendT(c, 102, 'building.OrderQuickRspMsg', { orderInfo: [] }); return; }
      const cost = list.reduce((n, o) => n + QUICK_PRICE * Math.ceil(O.remainOf(o) / 600), 0);
      const prefer = m.index === 1 ? 'point' : m.index === 2 ? 'bind' : 'any';
      if (!payPoints(c, cost, prefer)) { alert(c, prefer === 'bind' ? 'Diamantes vinculados insuficientes' : 'Diamantes insuficientes'); return; }
      for (const o of list) { o.end = Date.now(); o.need = 0; }
      p.save();
      sendPlayer(c);
      sendT(c, 102, 'building.OrderQuickRspMsg', { orderInfo: list.map(o => ({ orderId: o.id, orderType: o.type, remainTime: 0 })) });
    },
  };
};

module.exports.LEVY_HOURS = LEVY_HOURS;
