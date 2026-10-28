// Reward panel ("Ödül paneli"): 4 offers from t_s_rewardtemplate (level range, weight Rands) with a quality
// 2..5; accept one (C_REWARD_ADD slot), fulfil its t_s_rewardcondiction conditions, finish for
// RewardGold / RewardPlayGP * level * quality factor (capture: q2 x2, q3 x3, q4 x4, q5 x6 for exp).
// Slot state isIsValid: 1 open, 2 accepted, 3 done. Captured: rewardTimes = done today, freeTimes = free
// refreshes used. Our choices (not in the capture): 10 per day, 3 free refreshes, then 10 bound diamonds;
// only templates whose conditions this server can track are offered.
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmt = (d = new Date()) => `${dayKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const FACTOR = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 6 };
const QUALITY_WEIGHT = [[2, 40], [3, 35], [4, 17], [5, 8]];
const PER_DAY = 10, FREE_REFRESH = 3, REFRESH_COST = [[-500, 10]];
// condition types: 1 hand in Para2 troops of sonType Para1 (taken on finish), 14 catch (C_REWARD_ARREST),
// others count a lifetime stat from the moment of accepting
const STAT_OF = { 2: 'strengthen', 7: 'kills' };
const SUPPORTED = new Set([1, 14, ...Object.keys(STAT_OF).map(Number)]);

module.exports = (ctx) => {
  const { table, D, dec, sendN, alert, pay, grant, giveExp, sendPlayer, log } = ctx;
  const TPL = new Map(table('t_s_rewardtemplate').map(t => [t.TemplateId, t]));
  const CONDS = new Map();
  for (const r of table('t_s_rewardcondiction')) { if (!CONDS.has(r.TemplateId)) CONDS.set(r.TemplateId, []); CONDS.get(r.TemplateId).push(r); }
  const offerable = [...TPL.values()].filter(t => t.Type === 0 && (CONDS.get(t.TemplateId) || []).length && CONDS.get(t.TemplateId).every(cd => SUPPORTED.has(cd.CondictionType)));

  const weighted = (list, w) => { let x = Math.random() * list.reduce((n, e) => n + w(e), 0); for (const e of list) { x -= w(e); if (x < 0) return e; } return list[list.length - 1]; };
  function state(p) {
    let b = p.s.bounty;
    if (!b || b.day !== dayKey()) b = p.s.bounty = { day: dayKey(), done: 0, free: 0, offers: null, active: null, last: fmt() };
    if (!b.offers) roll(p);
    return b;
  }
  function roll(p) {
    const b = p.s.bounty, lv = p.s.grades;
    const pool = offerable.filter(t => lv >= (t.NeedMinLevel || 0) && lv <= (t.NeedMaxLevel || 999));
    b.offers = [0, 1, 2, 3].map(() => ({ id: pool.length ? weighted(pool, t => t.Rands || 1).TemplateId : 0, q: weighted(QUALITY_WEIGHT, e => e[1])[0], v: 1 }));
    b.last = fmt();
  }
  const fresh = c => {
    const b = state(c.player);
    sendN(c, 'U_C_REWARD_FRESH', { templateId: b.offers.map(o => o.id), isIsValid: b.offers.map(o => o.v), qualitys: b.offers.map(o => o.q), rewardLastdate: b.last, rewardTimes: b.done, freeTimes: b.free });
  };

  // ---- conditions -----------------------------------------------------------------------------------
  const reserve = (p, son) => (p.s.pawns[son] || {}).count || 0;
  function progress(p, a) {
    return (CONDS.get(a.id) || []).map((cd, i) => {
      if (cd.CondictionType === 1) return Math.min(reserve(p, cd.Para1), cd.Para2);
      if (cd.CondictionType === 14) return a.caught ? 1 : 0;
      const key = STAT_OF[cd.CondictionType];
      return Math.min(((p.s.stats || {})[key] || 0) - (a.base[i] || 0), cd.Para2 || 1);
    });
  }
  const target = cd => cd.CondictionType === 14 ? 1 : (cd.Para2 || 1);
  const complete = (p, a) => { const v = progress(p, a); return (CONDS.get(a.id) || []).every((cd, i) => v[i] >= target(cd)); };
  function update(c, extra = {}) {
    const p = c.player, a = state(p).active; if (!a) return;
    const v = progress(p, a);
    sendN(c, 'U_C_REWARD_UPDATE', { reward: [Object.assign({ templateId: a.id, condition_1: v[0] || 0, condition_2: v[1] || 0, condition_3: v[2] || 0, condition_4: v[3] || 0,
      completedDate: '2000-01-01 00:00:00', repeatFinish: 1, isSelect: true, quality: a.q }, extra)] });
  }
  ctx.onStat((c, key) => { const a = c.player.s.bounty && c.player.s.bounty.active; if (a && Object.values(STAT_OF).includes(key)) update(c); });
  ctx.onLoad.push(c => { if (state(c.player).active) update(c); });   // replaces the recorded empty one (NATIVE 4198)

  return {
    C_REWARD_FRESH(c, body) {
      const m = dec(c, 'C_REWARD_FRESH', body), p = c.player, b = state(p);
      if (m.isButton) {
        if (b.active) { alert(c, 'Conclua a missão aceita primeiro'); return fresh(c); }
        if (m.payType === 1 && b.free < FREE_REFRESH) b.free++;
        else if (!pay(c, REFRESH_COST)) { alert(c, 'Diamantes vinculados insuficientes'); return fresh(c); }
        roll(p); p.save();
      }
      fresh(c);
    },
    C_REWARD_ADD(c, body) {
      const m = dec(c, 'C_REWARD_ADD', body), p = c.player, b = state(p), o = b.offers[m.rewardId];
      if (!o || o.v !== 1 || !o.id) return;
      if (b.active) { alert(c, 'Só é possível aceitar uma missão por vez'); return; }
      if (b.done >= PER_DAY) { alert(c, 'Suas missões de recompensa de hoje acabaram'); return; }
      const stats = p.s.stats || {};
      b.active = { slot: m.rewardId, id: o.id, q: o.q, caught: false, base: (CONDS.get(o.id) || []).map(cd => stats[STAT_OF[cd.CondictionType]] || 0) };
      o.v = 2; p.save();
      update(c); fresh(c);
    },
    // catch target of a type-14 condition (Para1 = the target id the client sends)
    C_REWARD_ARREST(c, body) {
      const m = dec(c, 'C_REWARD_ARREST', body), a = state(c.player).active;
      if (!a || !(CONDS.get(a.id) || []).some(cd => cd.CondictionType === 14 && cd.Para1 === m.param1)) return;
      a.caught = true; c.player.save();   // simplification: the official server ran a fight here
      update(c);
    },
    // give up the accepted task: it goes back to the board as an open offer (our choice; no day count used).
    // isComplete takes it out of the client's task list (__updateRewardHandler)
    C_REWARD_REMOVE(c, body) {
      const m = dec(c, 'C_REWARD_REMOVE', body), p = c.player, b = state(p), a = b.active;
      if (!a || a.id !== m.templateId) return;
      b.offers[a.slot].v = 1; b.active = null; p.save();
      sendN(c, 'U_C_REWARD_UPDATE', { reward: [{ templateId: a.id, isComplete: true, completedDate: fmt(), repeatFinish: 1, isSelect: true, quality: a.q }] });
      fresh(c);
    },
    C_REWARD_FINISH(c, body) {
      const m = dec(c, 'C_REWARD_FINISH', body), p = c.player, b = state(p), a = b.active;
      if (!a || a.id !== m.templateId) return;
      // VIP privilege 19 (client OFFER_REWARD_LIMIT): the task may be handed in before its conditions are met
      const vipDone = ctx.vipPriv && ctx.vipPriv(p, 19) > 0;
      if (!vipDone && !complete(p, a)) { alert(c, 'Condições da missão não concluídas'); update(c); return; }
      const handed = [];
      for (const cd of CONDS.get(a.id) || []) if (cd.CondictionType === 1 && p.s.pawns[cd.Para1]) { p.s.pawns[cd.Para1].count = Math.max(0, p.s.pawns[cd.Para1].count - cd.Para2); handed.push(cd.Para1); }
      // the castle reserve changed: the official server follows with U_C_ARMY_UPDATE_ARMYPAWN (capture)
      if (handed.length) ctx.sendT(c, 100, 'army.ArmyPawnUpdatedMsg', ctx.M.reservePawns(p, handed));
      const t = TPL.get(a.id), k = (FACTOR[a.q] || 1) * p.s.grades;
      const vb = 1 + (ctx.vipPriv ? ctx.vipPriv(p, 38) : 0) / 100;   // VIP privilege 38: bounty rewards +%
      if (!grant(c, [[-100, Math.floor((t.RewardGold || 0) * k * vb)]])) return;
      giveExp(c, Math.floor((t.RewardPlayGP || 0) * k * vb));
      sendPlayer(c);
      b.offers[a.slot].v = 3; b.done++; b.active = null; p.save();
      ctx.stat(c, 'bounty');
      if (a.q >= 4) ctx.stat(c, 'bountyPurple');   // guide task: purple-quality bounty
      if (a.q >= 5) ctx.stat(c, 'bountyOrange');   // season pass task 5 (features/season.js)
      fresh(c);
      const v = (CONDS.get(a.id) || []).map(target);
      sendN(c, 'U_C_REWARD_UPDATE', { reward: [{ templateId: a.id, isComplete: true, condition_1: v[0] || 0, condition_2: v[1] || 0, completedDate: fmt(), repeatFinish: 1, isAccept: true, isSelect: true, quality: a.q }] });
      if (ctx.sendArmy) ctx.sendArmy(c);
    },
  };
};
