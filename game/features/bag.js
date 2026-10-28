// Bag operations the client sends and nothing answered (not in the capture; client-derived):
//  C_BAG_BATCH_SELL {selledItemInfos: [{pos, count}]} (bag "Sat" mode): gold = um.getSellGold x count —
//   SellGold + 0.7 x sum over strengthen levels t of floor(1.5^(floor(NeedGrades/10)+1) x (min(Profile,4)+1)
//   x t^2.2 x 5 + 500). Ultra: SellGold 0 uses floor NeedGrades*10*Profile; locked/gems also sellable
//   (client bundle getSellGold + Sale checks patched the same way).
//  U_C_BAG_SELL {beginPos}: the same for one stack (old single sell).
//  U_C_BAG_BUY {payType 0 bound diamonds / 1 diamonds, property1 rows}: rows of Player_BagAdd (5) cells; row k
//   (0-based over all bought rows) costs (k+1) x Hero_EngagePrice for k < 10, else 10 x Hero_EngagePrice
//   (client getPointByLine); at most Player_BagCountLock (370) cells bought.
//  C_BAG_REMOVE {bagType, pos}: drop an item (the client sends it for expired ones).
//  C_BAG_BATCH_MOVE {beginBagType, endBagType, moveItemInfos: [{pos}]}: bag <-> personal storage (7) "put all
//   / take all"; each stack goes onto a stack with room or the first free cell (logic.js storeMove).
// Updates go out as 115 ItemMovedListMsg (removed cells) and PlayerMsg / castle (gold, bagCount).
module.exports = (ctx) => {
  const { D, dec, alert, pay, sendItems, sendPlayer, sendCastle, CONF, M, log } = ctx;
  const ROW = CONF.get('Player_BagAdd') || 5, PRICE = CONF.get('Hero_EngagePrice') || 20, MAX_BOUGHT = CONF.get('Player_BagCountLock') || 370;

  // Ultra: any bag item can be sold. Template SellGold 0 still pays a floor from level/quality
  // (client getSellGold is patched the same way so Sale mode accepts them).
  function sellGold(it) {
    const t = D.items.get(it.templateId) || {};
    const lv = t.NeedGrades || 0, q = Math.min(t.Profile || 0, 4), sg = it.strengthenGrade || 0;
    let e = 0;
    for (let k = 1; k <= sg; k++) e += Math.floor(Math.pow(1.5, Math.floor(lv / 10) + 1) * (q + 1) * Math.pow(k, 2.2) * 5 + 500);
    const base = t.SellGold > 0 ? t.SellGold : Math.max(1, (lv || 1) * 10 * Math.max(1, q || 1));
    return Math.max(1, Math.floor(base + 0.7 * e));
  }
  const bagItem = (p, pos) => p.s.bag.find(i => (i.bagType ?? 1) === 1 && i.pos === pos);

  // sell [{pos, count}] -> gold earned (0 when nothing sold)
  function sell(c, list) {
    const p = c.player, entries = [];
    let gold = 0;
    for (const { pos, count } of list) {
      const it = bagItem(p, pos); if (!it) continue;
      const price = sellGold(it);
      const n = Math.max(1, Math.min(it.count, count || it.count));
      p.removeItem(it, n);
      entries.push(M.movedEntry(p, it, it.count <= 0));
      gold += price * n;
    }
    if (!entries.length) { alert(c, 'Nenhum item pode ser vendido'); return 0; }
    const MONEY_MAX = 2147483647;
    p.s.gold = Math.min(MONEY_MAX, (p.s.gold || 0) + gold);
    p.save();
    sendItems(c, entries);
    sendCastle(c); sendPlayer(c);
    alert(c, `${gold.toLocaleString('en-US')} de ouro obtidos`);
    return gold;
  }

  return {
    C_BAG_BATCH_SELL(c, body) {
      const m = dec(c, 'C_BAG_BATCH_SELL', body);
      sell(c, (m.selledItemInfos || []).map(x => ({ pos: x.pos || 0, count: x.count || 0 })));
    },
    U_C_BAG_SELL(c, body) {
      const m = dec(c, 'U_C_BAG_SELL', body);
      sell(c, [{ pos: m.beginPos || 0, count: 0 }]);
    },
    U_C_BAG_BUY(c, body) {
      const m = dec(c, 'U_C_BAG_BUY', body), p = c.player;
      // type: none = the bag; 1 = rune gem bag (features/runegem.js); 2 = pet equipment bag; others not built
      if (m.type === 1 && ctx.buyRuneBag) return ctx.buyRuneBag(c, m);
      if (m.type === 2 && ctx.buyPetBag) return ctx.buyPetBag(c, m);   // pet equipment bag (features/petequip.js)
      if (m.type) { log(`[#${c.id}] bag buy type ${m.type} not implemented`); return; }
      const have = Math.floor((p.s.bagBought || 0) / ROW), rows = Math.max(1, m.property1 || 1);
      if ((have + rows) * ROW > MAX_BOUGHT) { alert(c, 'Mochila no tamanho máximo'); return; }
      let cost = 0;
      for (let k = have; k < have + rows; k++) cost += k < 10 ? (k + 1) * PRICE : 10 * PRICE;
      const bound = m.payType === 0 && ctx.balance(p, -500) >= cost;
      if (!pay(c, [[bound ? -500 : -400, cost]])) { alert(c, 'Diamantes insuficientes'); return; }
      p.s.bagBought = (have + rows) * ROW;
      p.save();
      sendPlayer(c);
      alert(c, `Mochila recebeu ${rows * ROW} espaços adicionais`);
    },
    C_BAG_REMOVE(c, body) {
      const m = dec(c, 'C_BAG_REMOVE', body), p = c.player;
      const it = p.s.bag.find(i => (i.bagType ?? 1) === (m.bagType || 1) && i.pos === m.pos);
      if (!it) return;
      p.removeItem(it, it.count);
      p.save();
      sendItems(c, [M.movedEntry(p, it, true)]);
    },
    // soul jewel (JewelFrame, "Ruh Mührü"): count Ruh Cristali (208014, Property1 gp each) into PlayerMsg storeGp;
    // levels from t_s_upgradetemplate Types 15 (Data = gp of the next level, gp starts again; client bar
    // jewelGp / Data); the level raises every inlaid gem's attributes (equip.js jewelPct)
    C_BAG_USESTORE(c, body) {
      const m = dec(c, 'C_BAG_USESTORE', body), p = c.player, j = p.s.jewel = p.s.jewel || { grade: 0, gp: 0 };
      const UP = ctx.table('t_s_upgradetemplate').filter(r => r.Types === 15), next = g => UP.find(r => r.Grades === g + 1);
      if (!next(j.grade)) { alert(c, 'Já está no nível máximo'); return; }
      const n = Math.min(Math.max(1, m.count || 1), p.countTemplate(208014));
      if (n <= 0) { alert(c, 'Cristais de Alma insuficientes'); return; }
      sendItems(c, p.takeTemplate(208014, n).map(it => M.movedEntry(p, it, it.count <= 0)));
      j.gp += n * ((D.items.get(208014) || {}).Property1 || 1);
      let up;
      while ((up = next(j.grade)) && j.gp >= up.Data) { j.gp -= up.Data; j.grade++; }
      if (!next(j.grade)) j.gp = 0;
      p.save(); sendPlayer(c); if (ctx.sendArmy) ctx.sendArmy(c);
    },
    C_BAG_BATCH_MOVE(c, body) {
      const m = dec(c, 'C_BAG_BATCH_MOVE', body), p = c.player, from = m.beginBagType, to = m.endBagType;
      if (![1, 7].includes(from) || ![1, 7].includes(to) || from === to) return;
      const entries = [];
      let full = false;
      for (const { pos } of m.moveItemInfos || []) {
        const e = ctx.storeMove(c, from, pos, to, -1, false);
        if (e) entries.push(...e); else if (p.itemAt(pos, from)) full = true;
      }
      if (full) alert(c, to === 7 ? 'Depo cheia' : 'Mochila cheia');
      if (entries.length) { sendItems(c, entries); p.save(); }
    },
  };
};
