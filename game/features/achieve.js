// Achievements (t_s_achievement categories Type1/Type2, t_s_achievement_award rows with Target / Award /
// Achievement points). The official server never answered C_ACHIEVE_OP in the capture, so this follows the
// client (tg.sendReq / handlers): op 1 (0,0) board, op 1 (type1,type2) category list, op 2 claim id, op 3 points.
// Status (client stateCtrl index, inferred): 0 in progress, 1 claimable, 2 claimed.
// Category values computed here: 1/1 level, 1/2 fighting capacity, 2/1 campaigns cleared, 0/0 total points.
module.exports = (ctx) => {
  const { table, dec, sendN, alert, grant, parseRewards } = ctx;
  const CATS = table('t_s_achievement');
  const AWARDS = table('t_s_achievement_award');
  const BY_ID = new Map(AWARDS.map(a => [a.Id, a]));

  const claimed = p => (p.s.achieve = p.s.achieve || { claimed: [] }).claimed;
  const points = p => claimed(p).reduce((n, id) => n + ((BY_ID.get(id) || {}).Achievement || 0), 0);
  const VALUE = {
    '0/0': points,
    '1/1': p => p.s.grades,
    '1/2': p => p.fightingCapacity(),
    '2/1': p => p.s.cleared.length,
  };
  const value = (p, t1, t2) => (VALUE[t1 + '/' + t2] || (() => 0))(p);
  const status = (p, a) => claimed(p).includes(a.Id) ? 2 : value(p, a.Type1, a.Type2) >= a.Target ? 1 : 0;
  const list = (p, t1, t2) => AWARDS.filter(a => a.Type1 === t1 && a.Type2 === t2).map(a => ({ id: a.Id, value: value(p, t1, t2), status: status(p, a) }));

  const board = c => sendN(c, 'U_C_ACHIEVE_BOARD_LIST_INFO', { activeRspInfo: CATS.map(k => ({
    type1: k.Type1, type2: k.Type2, value: value(c.player, k.Type1, k.Type2),
    showRedPoint: AWARDS.some(a => a.Type1 === k.Type1 && a.Type2 === k.Type2 && status(c.player, a) === 1) })) });
  const totals = c => {
    const p = c.player, per = {};
    for (const id of claimed(p)) { const a = BY_ID.get(id); if (a) per[a.Type1] = (per[a.Type1] || 0) + (a.Achievement || 0); }
    sendN(c, 'U_C_ACHIEVE_TOTAL_POINT_INFO', { totalPoint: points(p), pointInfo: Object.entries(per).map(([type1, point]) => ({ type1: Number(type1), point })) }, 'active.AchieveTotalPointInfoMsg');
  };

  return {
    C_ACHIEVE_OP(c, body) {
      const m = dec(c, 'C_ACHIEVE_OP', body), p = c.player;
      if (m.op === 1) {
        if (!m.type1 && !m.type2) { board(c); sendN(c, 'U_C_ACHIEVE_LIST_INFO', { activeRspInfo: list(p, 0, 0) }); }
        else sendN(c, 'U_C_ACHIEVE_LIST_INFO', { activeRspInfo: list(p, m.type1, m.type2) });
      } else if (m.op === 2) {
        const a = BY_ID.get(m.id);
        if (!a || status(p, a) !== 1) { alert(c, 'Conquista ainda não concluída'); return; }
        if (!grant(c, parseRewards(a.Award))) return;
        claimed(p).push(a.Id); p.save();
        sendN(c, 'U_C_ACHIEVE_LIST_INFO', { activeRspInfo: list(p, a.Type1, a.Type2) });
        totals(c); board(c);
      } else if (m.op === 3) totals(c);
    },
  };
};
