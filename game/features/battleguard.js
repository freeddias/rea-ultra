// Savaş koruması (client UB / GB battleGuardInfo, BattleGuardView; resist crystals). Client-derived, no capture:
//  Grid type 1 = the will slot (İrade Cristali, item Property1 100, ReduceResi), grid type 2 = 6 notches for
//  resist crystals (Property1 101..106, FireResi / WaterResi / ...); 3 crystals each, and a notch takes one of each
//  kind (client existSameGoods). C_BATTLEGUARD_OP (watch.HeroWatchOpMsg {opType, gridType, gridPos 1.., jionPos
//  1..3, itemPos}): 2 put the bag item at itemPos in (a crystal already there goes back to the bag), 3 take one out
//  -> 4631 U_C_BATTLEGUARD_INFO watch.HeroWatchMsg {userId, watchInfo [{gridType, gridPos, jion1..3 = templates}]}
//  (also on load; a listed grid counts as open, and the client never sends the open request 1, so all are open).
//  Totals: p.s.battleGuard.resist {FireResi, ...} and reduce (ReduceResi), kept for the battle engine.
// Not modelled: the effect in battle. The help texts say resists cut the damage of pet attacks of their element,
// the attacker's resist reduction adds damage and a cut over 30 % raises a shield — no numbers anywhere.
const RESIST_KEYS = ['FireResi', 'WaterResi', 'WindResi', 'ElectResi', 'DarkResi', 'LightResi'];

module.exports = (ctx) => {
  const { D, dec, sendT, alert, M } = ctx;
  function state(p) {
    const s = p.s.battleGuard = p.s.battleGuard || { grids: {} };
    for (const [type, n] of [[1, 1], [2, 6]]) for (let pos = 1; pos <= n; pos++) s.grids[`${type}_${pos}`] = s.grids[`${type}_${pos}`] || [0, 0, 0];
    return s;
  }
  function totals(p) {
    const s = state(p), resist = Object.fromEntries(RESIST_KEYS.map(k => [k, 0]));
    let reduce = 0;
    for (const ids of Object.values(s.grids)) for (const id of ids) {
      const tp = id && D.items.get(id); if (!tp) continue;
      for (const k of RESIST_KEYS) resist[k] += tp[k] || 0;
      reduce += tp.ReduceResi || 0;
    }
    s.resist = resist; s.reduce = reduce;
  }
  const send = c => {
    const s = state(c.player);
    sendT(c, 4631, 'watch.HeroWatchMsg', { userId: c.player.id, watchInfo: Object.entries(s.grids).map(([k, ids]) => {
      const [gridType, gridPos] = k.split('_').map(Number);
      return { gridType, gridPos, jion1: ids[0], jion2: ids[1], jion3: ids[2], jion4: 0 };
    }) });
  };
  ctx.onLoad.push(c => { totals(c.player); send(c); });

  return {
    C_BATTLEGUARD_OP(c, body) {
      const m = dec(c, 'C_BATTLEGUARD_OP', body), p = c.player, s = state(p);
      const grid = s.grids[`${m.gridType}_${m.gridPos}`], j = (m.jionPos || 0) - 1;
      if (!grid || j < 0 || j > 2) return send(c);
      const entries = [];
      if (m.opType === 2) {
        const it = p.itemAt(m.itemPos, 1), tp = it && D.items.get(it.templateId);
        const kind = tp && tp.Property1;
        const ok = tp && (m.gridType === 1 ? kind === 100 : kind >= 101 && kind <= 106);
        if (!ok) { alert(c, 'Esta pedra não pode ser equipada aqui'); return send(c); }
        if (m.gridType === 2 && grid.some((id, k) => k !== j && id && (D.items.get(id) || {}).Property1 === kind)) { alert(c, 'Uma pedra deste tipo já está equipada'); return send(c); }
        if (grid[j]) for (const x of p.addItem(grid[j], 1)) entries.push(M.movedEntry(p, x));
        grid[j] = tp.TemplateId;
        p.removeItem(it, 1); entries.push(M.movedEntry(p, it, it.count <= 0));
      } else if (m.opType === 3) {
        if (!grid[j]) return send(c);
        if (p.freePos(1) < 0) { alert(c, 'Mochila cheia'); return send(c); }
        for (const x of p.addItem(grid[j], 1)) entries.push(M.movedEntry(p, x));
        grid[j] = 0;
      }
      totals(p); p.save();
      if (entries.length) ctx.sendItems(c, entries);
      send(c);
    },
  };
};
