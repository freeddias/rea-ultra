// Missões rotineirasi (ring tasks, client RingTaskManager gc; Lv35). Client-derived, no capture beyond an empty
// 4616 at login:
//  80 rings a week, renewed Monday 05:00 (t_s_rewardtemplate Type 3 Detail text). Each ring is a random
//  Type 1 template of the level range (weight Rands) with RewardGold / RewardPlayGP; every ring whose number is
//  in t_s_rewardgood RepeatStep (10, 20 .. 80) also gives RewardItemID x RewardItemCount for the level range.
//  C_TAKE_REPEAT_REWARD accept -> 4614 RewardUpdatedRspMsg {reward: [task]}; C_REPEAT_REWARD_FINISH hand in
//  -> 4614 isComplete + 4617; 4616 PropertyMsg {param1 = rings done this week}; 4615 when all 80 are done.
//  C_REPEAT_REWARD_FINISH_IMMEDIATELY {param1 0 = bound diamonds allowed}: free with İmparatorluk Geçidi
//  (2131021, kept), else 10 diamonds (client TaskFrameII).
//  C_REPEAT_REWARD_UPDATE_FINISH: the client finished a talk condition (type 16, TALKRINGTASK_COMPLETE).
//  Conditions offered: 1 hand in Para2 troops of Para1 (taken on finish), 2 strengthen, 3 inlay, 6 astrology,
//  9 guild donation (stats counted from accepting), 16 talk. Others (pets, dungeon monsters) are not offered.
const OPEN = 35, RINGS = 80, PASS = 2131021, INSTANT = 10;
const STAT_OF = { 2: 'strengthen', 3: 'inlay', 6: 'astrology', 9: 'guildOffer' };
const SUPPORTED = new Set([1, 16, ...Object.keys(STAT_OF).map(Number)]);
const pad = n => String(n).padStart(2, '0');
const fmt = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
// the week starts Monday 05:00
function weekKey(d = new Date()) {
  const m = new Date(d.getTime() - 5 * 3600 * 1000);
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())}`;
}

module.exports = (ctx) => {
  const { D, dec, sendT, alert, pay, grant, giveExp, sendPlayer, table, log } = ctx;
  const TPL = new Map(table('t_s_rewardtemplate').filter(t => t.Type === 1).map(t => [t.TemplateId, t]));
  const CONDS = new Map();
  for (const r of table('t_s_rewardcondiction')) if (TPL.has(r.TemplateId)) { if (!CONDS.has(r.TemplateId)) CONDS.set(r.TemplateId, []); CONDS.get(r.TemplateId).push(r); }
  const offerable = [...TPL.values()].filter(t => (CONDS.get(t.TemplateId) || []).length && CONDS.get(t.TemplateId).every(c => SUPPORTED.has(c.CondictionType)));
  const GOODS = table('t_s_rewardgood');

  function state(p) {
    let r = p.s.ring;
    if (!r || r.week !== weekKey()) r = p.s.ring = { week: weekKey(), done: 0, active: null };
    return r;
  }
  const reserve = (p, son) => (p.s.pawns[son] || {}).count || 0;
  const target = cd => cd.Para2 || 1;
  function progress(p, a) {
    return (CONDS.get(a.id) || []).map((cd, i) => {
      if (cd.CondictionType === 1) return Math.min(reserve(p, cd.Para1), cd.Para2);
      if (cd.CondictionType === 16) return a.talked ? target(cd) : 0;
      return Math.min(((p.s.stats || {})[STAT_OF[cd.CondictionType]] || 0) - (a.base[i] || 0), target(cd));
    });
  }
  const complete = (p, a) => { const v = progress(p, a); return (CONDS.get(a.id) || []).every((cd, i) => v[i] >= target(cd)); };
  function update(c, extra = {}) {
    const p = c.player, a = state(p).active; if (!a) return;
    const v = progress(p, a);
    sendT(c, 4614, 'reward.RewardUpdatedRspMsg', { reward: [Object.assign({ templateId: a.id, condition_1: v[0] || 0, condition_2: v[1] || 0, condition_3: v[2] || 0, condition_4: v[3] || 0,
      completedDate: '2000-01-01 00:00:00', repeatFinish: 1, isAccept: true, isSelect: true, quality: 1 }, extra)] });
  }
  const sendSum = c => sendT(c, 4616, 'simple.PropertyMsg', { param1: state(c.player).done });
  const weighted = list => { let x = Math.random() * list.reduce((n, t) => n + (t.Rands || 1), 0); for (const t of list) { x -= t.Rands || 1; if (x < 0) return t; } return list[list.length - 1]; };

  ctx.onLoad.push(c => { if (c.player.s.grades < OPEN) return; sendSum(c); update(c); });
  ctx.onStat((c, key) => { const a = c.player.s.ring && c.player.s.ring.active; if (a && Object.values(STAT_OF).includes(key)) update(c); });

  // takeTroops false: a bought task hands nothing in
  function finish(c, takeTroops = true) {
    const p = c.player, r = state(p), a = r.active, t = TPL.get(a.id);
    const handed = [];
    if (takeTroops) for (const cd of CONDS.get(a.id) || []) if (cd.CondictionType === 1) { p.s.pawns[cd.Para1].count -= cd.Para2; handed.push(cd.Para1); }
    if (handed.length) sendT(c, 100, 'army.ArmyPawnUpdatedMsg', ctx.M.reservePawns(p, handed));
    r.done++; r.active = null;
    const goods = GOODS.filter(g => String(g.RepeatStep).split(',').map(Number).includes(r.done) && p.s.grades >= g.RepeatMinLevel && p.s.grades < g.RepeatMaxLevel).map(g => [g.RewardItemID, g.RewardItemCount]);
    grant(c, [[-100, t.RewardGold || 0], ...goods], { quiet: true });
    if (t.RewardPlayGP) giveExp(c, t.RewardPlayGP);
    sendPlayer(c); p.save();
    const v = (CONDS.get(a.id) || []).map(target);
    const done = { reward: [{ templateId: a.id, isComplete: true, condition_1: v[0] || 0, condition_2: v[1] || 0, completedDate: fmt(), repeatFinish: 1, isAccept: true, isSelect: true, quality: 1 }] };
    sendT(c, 4614, 'reward.RewardUpdatedRspMsg', done);
    sendT(c, 4617, 'reward.RewardUpdatedRspMsg', done);
    sendSum(c);
    if (r.done >= RINGS) sendT(c, 4615, 'simple.PropertyMsg', { param1: r.done });
    const extra = goods.map(([tid, n]) => `, ${ctx.rewardName(tid)} x${n}`).join('');
    alert(c, `${r.done}. missão rotineira concluída: Ouro ${(t.RewardGold || 0).toLocaleString('en-US')}, EXP ${(t.RewardPlayGP || 0).toLocaleString('en-US')}${extra}`);
    ctx.stat(c, 'ringTask');
    log(`[#${c.id}] ring ${r.done} done (${a.id})`);
  }

  return {
    C_TAKE_REPEAT_REWARD(c) {
      const p = c.player, r = state(p);
      if (p.s.grades < OPEN) { alert(c, `Missões rotineiras ${OPEN}. libera no nível`); return; }
      if (r.active) return update(c);
      if (r.done >= RINGS) { alert(c, 'As missões rotineiras desta semana acabaram'); return sendSum(c); }
      const pool = offerable.filter(t => p.s.grades >= t.NeedMinLevel && p.s.grades < t.NeedMaxLevel);
      if (!pool.length) { alert(c, 'Nenhuma missão rotineira adequada'); return; }
      const t = weighted(pool), stats = p.s.stats || {};
      r.active = { id: t.TemplateId, talked: false, base: (CONDS.get(t.TemplateId) || []).map(cd => stats[STAT_OF[cd.CondictionType]] || 0) };
      p.save();
      update(c); sendSum(c);
    },
    C_REPEAT_REWARD_UPDATE_FINISH(c) {
      const p = c.player, a = state(p).active;
      if (!a || !(CONDS.get(a.id) || []).some(cd => cd.CondictionType === 16)) return;
      a.talked = true; p.save();
      update(c);
    },
    C_REPEAT_REWARD_FINISH(c) {
      const p = c.player, a = state(p).active;
      if (!a) return;
      if (!complete(p, a)) { alert(c, 'Condições da missão não concluídas'); return update(c); }
      finish(c);
    },
    C_REPEAT_REWARD_FINISH_IMMEDIATELY(c, body) {
      const m = dec(c, 'C_REPEAT_REWARD_FINISH_IMMEDIATELY', body), p = c.player, a = state(p).active;
      if (!a) return;
      if (!p.countTemplate(PASS)) {
        const bound = m.param1 === 0 && ctx.balance(p, -500) >= INSTANT;
        if (!pay(c, [[bound ? -500 : -400, INSTANT]])) { alert(c, 'Diamantes insuficientes'); return; }
      }
      finish(c, false);
    },
  };
};
