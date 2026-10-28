// Montaria kralları (client dm.mountKingList, MountKingTrainWnd): the four king mounts (t_s_mountkingupgrade
// TemplateId 9001..9004) a player owns (mount.js p.s.mount.owned) are trained with Canavar Taşı (208017,
// client MOUNT_FOOD_TEMPID): C_MOUNT_KING_ADD_GP {param1 templateId, param2 count} -> 771 MountKingInfoMsg;
// the list goes out at login as 789 MountKingListMsg {kingList}.
//  level row: Data = gp for that level, Basic = the level's attributes ("1,5|3,5|4,5|2,5", t_s_attribute
//  ids), Bonuscap. bonus = t_s_mountkingbonus by the mounts' soul score (client getMountBonusBySoulScore).
// Our choices (not in the client): 10 gp per stone; the attributes go to the hero as they are (the bonus is
// sent for display only).
const A = require('../attrs');
const FOOD = 208017, GP_PER = 10;

module.exports = (ctx) => {
  const { dec, sendT, sendItems, sendPlayer, sendArmy, alert, table, M, log } = ctx;
  const ROWS = table('t_s_mountkingupgrade');
  const BONUS = table('t_s_mountkingbonus');
  const KINGS = [...new Set(ROWS.map(r => r.TemplateId))];
  const row = (tid, lv) => ROWS.find(r => r.TemplateId === tid && r.Grades === lv);
  const owned = p => KINGS.filter(tid => p.s.mount && p.s.mount.owned && p.s.mount.owned[tid]);
  const state = (p, tid) => { const k = p.s.mountKing = p.s.mountKing || {}; return (k[tid] = k[tid] || { level: 0, gp: 0 }); };
  const soul = p => (ctx.mountSoul ? ctx.mountSoul(p) : 0);
  const bonusOf = p => { const n = soul(p); const b = BONUS.find(x => { const [lo, hi] = x.SoulScoreinterval.split(',').map(Number); return n >= lo && n <= hi; }); return b ? b.Bonus : 0; };
  function info(p, tid) {
    const s = state(p, tid), r = row(tid, s.level) || {};
    return { templateId: tid, level: s.level, gp: s.gp, bonus: bonusOf(p), oriBonus: bonusOf(p), propertyList: A.parse(r.Basic).map(([propertyType, value]) => ({ propertyType, value })) };
  }
  function recalc(p) {
    const add = {};
    for (const tid of owned(p)) { const r = row(tid, state(p, tid).level); if (r) A.add(add, A.parse(r.Basic)); }
    (p.s.adds = p.s.adds || {}).mountKing = add;
  }
  ctx.onLoad.push(c => { recalc(c.player); sendT(c, 789, 'campaign.MountKingListMsg', { kingList: owned(c.player).map(tid => info(c.player, tid)) }); });

  return {
    C_MOUNT_KING_ADD_GP(c, body) {
      const m = dec(c, 'C_MOUNT_KING_ADD_GP', body), p = c.player, tid = m.param1, n = Math.max(1, m.param2 || 1);
      if (!owned(p).includes(tid)) { alert(c, 'Este rei das montarias não está ativo'); return; }
      const s = state(p, tid);
      if (!row(tid, s.level + 1)) { alert(c, 'Já está no nível máximo'); return; }
      const have = p.countTemplate(FOOD), use = Math.min(n, have);
      if (use <= 0) { alert(c, 'Sem Pedra de Monstro'); return; }
      sendItems(c, p.takeTemplate(FOOD, use).map(it => M.movedEntry(p, it, it.count <= 0)));
      s.gp += use * GP_PER;
      let next;
      while ((next = row(tid, s.level + 1)) && s.gp >= next.Data) { s.gp -= next.Data; s.level++; }
      if (!row(tid, s.level + 1)) s.gp = 0;
      recalc(p); p.save();
      sendT(c, 771, 'campaign.MountKingInfoMsg', info(p, tid));
      sendPlayer(c); sendArmy(c);
      log(`[#${c.id}] mount king ${tid} lv ${s.level} gp ${s.gp}`);
    },
  };
};
