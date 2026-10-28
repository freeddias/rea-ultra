// Forge: equipment strengthening. The item sits in the forge slot (bag type 0 "Hide", pos 0), an optional
// luck stone in pos 1 (its template Property1 adds success rate). Cost and rate are the client's own formulas
// (um.getIntensifuGold, cJ.getSuccessRate); from +80 on t_s_equipstrengthen (Level = target grade) applies.
// Stat effect of the grade: Player.stats().
const FORGE = 0;
const RESULT = 86;
const JOB_CHANGE_GRADES = 80;

module.exports = (ctx) => {
  const { D, table, sendT, sendItems, sendCastle, alert, refreshQuests, M } = ctx;
  const HIGH = new Map(table('t_s_equipstrengthen').map(r => [r.Level, r]));

  const goldFor = (tp, g) => Math.floor(Math.pow(1.5, Math.floor((tp.NeedGrades || 0) / 10) + 1) * (Math.min(tp.Profile || 1, 4) + 1) * Math.pow(g + 1, 2.2) * 5 + 500);
  const rateFor = g => Math.min(100, Math.max(10, 100 - g * 10));
  function price(tp, g, stone) {
    const high = g >= JOB_CHANGE_GRADES && HIGH.get(g + 1);
    let gold = high ? high.Gold : goldFor(tp, g), rate = high ? high.Rate : rateFor(g);
    if (stone) rate += (D.items.get(stone.templateId) || {}).Property1 || 0;
    return { gold, rate: Math.min(100, rate) };
  }
  ctx.strengthenPrice = price;

  return {
    U_C_ITEM_STRENGTHEN(c) {
      const p = c.player, it = p.itemAt(0, FORGE), stone = p.itemAt(1, FORGE);
      const fail = (msg) => { if (msg) alert(c, msg); sendT(c, RESULT, 'store.StoreRspMsg', { strengResult: false, strengthenGrade: it ? it.strengthenGrade || 0 : 0 }); };
      if (!it) return fail('Coloque um equipamento primeiro');
      const tp = D.items.get(it.templateId), g = it.strengthenGrade || 0;
      if (!tp || !tp.StrengthenMax) return fail('Este item não pode ser fortalecido');
      if (g >= tp.StrengthenMax) return fail('Já está no nível máximo de fortalecimento');
      const { gold, rate } = price(tp, g, stone);
      if (p.s.gold < gold) return fail('Ouro insuficiente');
      p.s.gold -= gold;
      const entries = [];
      if (stone) { p.removeItem(stone, 1); entries.push(M.movedEntry(p, stone, stone.count <= 0)); }
      const ok = Math.random() * 100 < rate;
      if (ok) it.strengthenGrade = g + 1;
      ctx.stat(c, 'strengthen');
      entries.push(M.movedEntry(p, it));
      p.save();
      sendCastle(c);
      sendItems(c, entries);
      sendT(c, RESULT, 'store.StoreRspMsg', { strengResult: ok, strengthenGrade: it.strengthenGrade || 0 });
      if (ok) refreshQuests(c);
    },
  };
};
