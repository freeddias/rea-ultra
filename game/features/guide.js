// New-system guide ("sistem rehberi"): t_s_system_introduce (25 systems, unlock level in
// RelieveCondition_tr, Award) and t_s_system_task (their tasks: TaskType, TaskCount, Limit). Replaces the
// recorded copies, which sent the official character's guide progress plus a fog update of its map.
// Capture: C_NEWBIE_GUIDE_OP {op 0, id} -> 533 GuideInfoMsg {guideTask: [{id, value, status 1 = done}], id,
// status 1 = all done / 2 = award taken}; {op 1, id} takes the award ("-500,20": bound diamonds) -> 3
// PlayerMsg, 533 with status 2, 544 RedPointMsg {redPoint: [{systemId, redPoint}]}.
// Counted task types (the systems that exist here): 41 arena fights, 42 arena wins, 120 reward-panel tasks
// (Limit 4: purple ones), 18 runes learned, 19 total rune grades (state). The other systems' tasks stay 0.
const R = require('../rune');
const STAT_TYPE = { arena: 41, arenaWin: 42, bounty: 120, runeStudy: 18, farmPlant: 110, farmHelp: 111, treeWaterFriend: 111, farmHarvest: 112, groupScene: 34, astrology: 130 };

module.exports = (ctx) => {
  const { table, dec, sendT, grant, parseRewards, sendPlayer, alert, rewardName } = ctx;
  const SYSTEMS = table('t_s_system_introduce');
  const TASKS = table('t_s_system_task');
  const unlockLevel = s => Number((String(s.RelieveCondition_tr || '').match(/(\d+)\.\s*seviye/) || [])[1] || 1);

  const state = p => (p.s.guide = p.s.guide || { counts: {}, claimed: {} });
  function value(p, t) {
    if (t.TaskType === 19) return R.studied(p).reduce((n, r) => n + ((R.RUNES.get(r.id) || {}).RuneGrade || 0), 0);
    if (t.TaskType === 131) return Object.values((p.s.star && p.s.star.equip) || {}).filter(s => ((ctx.D.stars.get(s.tid) || {}).Profile || 0) >= Number(t.Limit || 0)).length;
    return state(p).counts[t.Id] || 0;
  }
  const tasksOf = sysId => TASKS.filter(t => t.SystemType === sysId);
  const done = (p, t) => value(p, t) >= t.TaskCount;
  function sysStatus(p, s) {
    if (state(p).claimed[s.Id]) return 2;
    const ts = tasksOf(s.Id);
    return ts.length && p.s.grades >= unlockLevel(s) && ts.every(t => done(p, t)) ? 1 : 0;
  }
  function infoMsg(p, s) {
    const guideTask = tasksOf(s.Id).map(t => {
      const e = { id: t.Id }, v = Math.min(value(p, t), t.TaskCount);
      if (v) e.value = v;
      if (done(p, t)) e.status = 1;
      return e;
    });
    const m = { guideTask, id: s.Id }, st = sysStatus(p, s);
    if (st) m.status = st;
    return m;
  }
  const redDots = c => sendT(c, 544, 'guide.RedPointMsg', { redPoint: SYSTEMS.map(s => ({ systemId: s.Id, redPoint: sysStatus(c.player, s) === 1 })) });

  ctx.onStat((c, key) => {
    const p = c.player; if (!p) return;
    const type = key === 'bountyPurple' ? 120 : STAT_TYPE[key];
    if (!type) return;
    let changed = false;
    for (const t of TASKS) {
      if (t.TaskType !== type) continue;
      const purple = t.TaskType === 120 && String(t.Limit) === '4';
      if (purple !== (key === 'bountyPurple')) continue;
      if ((state(p).counts[t.Id] || 0) >= t.TaskCount) continue;
      state(p).counts[t.Id] = (state(p).counts[t.Id] || 0) + 1; changed = true;
    }
    if (changed) { p.save(); redDots(c); }
  });
  ctx.onLoad.push(redDots);

  return {
    C_NEWBIE_GUIDE_OP(c, body) {
      const m = dec(c, 'C_NEWBIE_GUIDE_OP', body), p = c.player, s = SYSTEMS.find(x => x.Id === m.id);
      if (!s) return;
      if (m.op === 1) {
        if (sysStatus(p, s) !== 1) { alert(c, 'Missões do guia não concluídas'); return sendT(c, 533, 'guide.GuideInfoMsg', infoMsg(p, s)); }
        const award = parseRewards(s.Award);
        if (!grant(c, award, { quiet: true })) { alert(c, 'Mochila cheia'); return; }
        state(p).claimed[s.Id] = true; p.save();
        sendPlayer(c);
        alert(c, 'Obtido:' + award.map(([t, n]) => `${rewardName(t)} x${n}`).join(', '));
        sendT(c, 533, 'guide.GuideInfoMsg', infoMsg(p, s));
        return redDots(c);
      }
      sendT(c, 533, 'guide.GuideInfoMsg', infoMsg(p, s));
    },
  };
};
