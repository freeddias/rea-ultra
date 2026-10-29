// Daily / weekly activity ("Atividade diária", leed). Replaces the recorded copies, which gave every
// character the official one's progress (login 4152) and its box loot (C_LEED_FINISH).
//  tasks: t_s_leedtemplate, Kind 0 daily / 1 weekly, for characters with LevelMin <= level <= LevelMax and
//   level >= Level; done after PassCount; adds Num to the daily (totalNum) or weekly (weekActive) points
//   (capture: "Atividade diária 70 alcançada.", "Atividade semanal 100 alcançada.")
//  boxes: t_s_dropcondition type 13 (client Pa.DEGREE): Para1 = points, Para2 = 0 daily / 1 weekly; site n
//   = the n-th by points; taken boxes are bits of leedProcess: daily n -> bit n, weekly n -> bit n + 15
//   (client hasPick; capture: 2 after daily box 1, 65538 after weekly box 1). Loot: the box's drop
//   (capture: 13001 "Ouro x40000, Canavar Taşı x3", 13101 "Kutsal Ruh Taşı x10, Büyük Ouro Kesesi x1").
//  resets: daily at midnight, weekly on Monday (day keys, as the other daily systems here).
// Counted from our events (ctx.stat). Types still without a system (guild blessing 12, sylph atoll 46, …) stay at 0.
const TYPE_OF_STAT = {
  spendPoint: 15, arena: 19, bounty: 24, refine: 42, weary: 47, giftpack: 62,
  farmHarvest: 25, treeWaterFriend: 3, groupScene: 5, maze: 23,
  fieldCommon: 39, fieldElite: 40, fieldBoss: 41,
  worldBoss: 18, warField: 27, petArena: 35, mysteryShop: 36, guildShop: 34,
  towerKings: 37, spire: 28, petCampaign: 48, secretEnter: 49, petEquipResolve: 44,
};
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const weekKey = (d = new Date()) => { const m = new Date(d); m.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return dayKey(m); };

module.exports = (ctx) => {
  const { table, dec, sendT, grant, alert, chat, rewardName, DROPS, sysTime } = ctx;
  const TASKS = table('t_s_leedtemplate');
  const BOXES = [0, 1].map(kind => DROPS.condition(13).filter(r => [].concat(r.Para2)[0] === kind).sort((a, b) => [].concat(a.Para1)[0] - [].concat(b.Para1)[0]));

  function state(p) {
    const l = p.s.leed = p.s.leed || { counts: {}, done: {}, active: 0, weekActive: 0, process: 0 };
    if (l.day !== dayKey()) {
      l.day = dayKey(); l.active = 0; l.process &= ~0x7fff;   // daily boxes: bits 1..15
      for (const t of TASKS) if (!t.Kind) { delete l.counts[t.TemplateId]; delete l.done[t.TemplateId]; }
    }
    if (l.week !== weekKey()) {
      l.week = weekKey(); l.weekActive = 0; l.process &= 0x7fff;
      for (const t of TASKS) if (t.Kind === 1) { delete l.counts[t.TemplateId]; delete l.done[t.TemplateId]; }
    }
    return l;
  }
  const fits = (p, t) => p.s.grades >= (t.Level || 0) && p.s.grades >= (t.LevelMin || 0) && p.s.grades <= (t.LevelMax || 999);
  const entry = (p, l, t) => {
    const e = { templateId: t.TemplateId, userId: p.id, beginDate: `${l.day} 00:00:00` };
    if (l.counts[t.TemplateId]) e.currentCount = l.counts[t.TemplateId];
    if (l.done[t.TemplateId]) e.isComplete = true;
    return e;
  };
  const send = (c, leed) => { const p = c.player, l = state(p); sendT(c, 4152, 'leed.LeedUpdatedRspMsg', { leed, leedProcess: l.process, totalNum: l.active, weekActive: l.weekActive }); };

  function progress(c, type, n = 1) {
    const p = c.player, l = state(p), changed = [];
    for (const t of TASKS) {
      if (t.Type !== type || !fits(p, t) || l.done[t.TemplateId]) continue;
      l.counts[t.TemplateId] = Math.min(t.PassCount || 1, (l.counts[t.TemplateId] || 0) + n);
      if (l.counts[t.TemplateId] >= (t.PassCount || 1)) {
        l.done[t.TemplateId] = true;
        if (t.Kind === 1) { l.weekActive += t.Num || 0; chat(c, `Atividade semanal ${l.weekActive} alcançada.`); }
        else { l.active += t.Num || 0; chat(c, `Atividade diária ${l.active} alcançada.`); }
      }
      changed.push(entry(p, l, t));
    }
    if (!changed.length) return;
    p.save();
    send(c, changed);
  }
  ctx.onStat((c, key, n) => { const t = TYPE_OF_STAT[key]; if (t && c.player) progress(c, t, n || 1); });
  // login Type 1: only mark the day once a fitting daily login task exists (Lv < 5 must wait for level-up)
  function tryLogin(c) {
    const p = c.player, l = state(p);
    if (l.loginDay === l.day) return;
    if (!TASKS.some(t => t.Type === 1 && !t.Kind && fits(p, t))) return;
    l.loginDay = l.day;
    progress(c, 1);
  }
  // login: the full list (replaces the recorded one, NATIVE 4152), then the daily login task
  ctx.onLoad.push(c => {
    const p = c.player, l = state(p);
    send(c, TASKS.filter(t => fits(p, t)).map(t => entry(p, l, t)));
    tryLogin(c);
  });
  ctx.onExp.push(c => tryLogin(c));

  return {
    // the client asks at 05:00 (new day): the whole list again (state() starts the new day)
    C_DEGREE_ACTIVITY_DATA_REFRESH(c) { const p = c.player, l = state(p); send(c, TASKS.filter(t => fits(p, t)).map(t => entry(p, l, t))); },
    C_LEED_FINISH(c, body) {
      const m = dec(c, 'C_LEED_FINISH', body), p = c.player, l = state(p);
      const kind = m.kind ? 1 : 0, box = BOXES[kind][(m.site || 0) - 1], bit = (m.site || 0) + (kind ? 15 : 0);
      const reply = ok => sendT(c, 4150, 'leed.LeedFinishedRspMsg', { result: ok, site: m.site, leedProcess: l.process });
      if (!box) return reply(false);
      if (l.process >> bit & 1) { alert(c, 'Esta recompensa já foi recebida'); return reply(false); }
      if ((kind ? l.weekActive : l.active) < [].concat(box.Para1)[0]) { alert(c, 'Pontos de atividade insuficientes'); return reply(false); }
      const loot = DROPS.roll(box.DropId);
      if (!grant(c, loot, { quiet: true })) { alert(c, 'Mochila cheia'); return reply(false); }
      l.process |= 1 << bit;
      p.save();
      const text = 'Obtido:' + loot.map(([t, n]) => `${rewardName(t)} x${n}`).join(', ');
      alert(c, text);
      reply(true);
      chat(c, text);
    },
    // client-side counters (C_LEED_CLIENT {templateId}): opening a window etc.; none of those tasks exist here
    C_LEED_CLIENT() {},
  };
};

module.exports.weekKey = weekKey;
