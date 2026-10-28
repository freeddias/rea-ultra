// Campaign sweep (auto-clear of an already cleared campaign). Capture flow: opType 1 start (status 1),
// 3 finish now -> rewards + result (status 11), 4 close (status 5).
// Reward per run: exp = BaseGp + HeroGP of the campaign's fighting nodes (1001: 700 + 140 = 840 as captured),
// plus the campaign's reward card (recorded card, else BaseGp * 4 gold like U_C_CAMPAIGN_TAKE_CARD).
// Weary: 20 per run (ctx.spendWeary), as captured.
const RUN_SECONDS = 300;

module.exports = (ctx) => {
  const { D, dec, sendN, alert, grant, giveExp, sendPlayer, refreshQuests, CAMPAIGN_MAPS } = ctx;

  function runReward(camp) {
    const t = D.campaigns.get(camp) || {};
    let gp = t.BaseGp || 0;
    for (const m of CAMPAIGN_MAPS.get(camp) || []) for (const cd of D.campNodesByCampaign.get(m.Id) || []) gp += cd.HeroGP || 0;
    const card = ctx.campaignCard(camp);
    const items = card && card.templateId ? [[card.templateId, card.count || 1]] : [[-100, (t.BaseGp || 500) * 4]];
    return { gp, items };
  }
  const reply = (c, o) => sendN(c, 'U_C_CAMPAIGN_SWEEP', Object.assign({ result: [], dropItems: [] }, o));

  return {
    C_CAMPAIGN_SWEEP(c, body) {
      const m = dec(c, 'C_CAMPAIGN_SWEEP', body), p = c.player;
      // other sweep kinds (2 = labyrinth, features/maze.js) register themselves
      const other = (ctx.sweepHandlers || {})[m.sweepType];
      if (other) return other(c, m);
      const s = p.s.sweep;
      if (m.opType === 1) {
        if (!p.s.cleared.includes(m.campaignId)) { alert(c, 'Conclua esta expedição primeiro'); return; }
        // each run costs the campaign weary like entering it (capture: 20 per sweep)
        if (!ctx.spendWeary(c, ctx.CAMPAIGN_WEARY * Math.max(1, m.count || 1))) return;
        p.s.sweep = { campaignId: m.campaignId, count: Math.max(1, m.count || 1), started: Date.now(), type: m.sweepType || 1 };
        p.save();
        ctx.sendT(c, 140, 'army.MapUpdatedMsg', { updatedType: 3, army: ctx.M.mapArmy(p, 2) });   // army busy (capture: state 2)
        reply(c, { status: 1, sweepType: p.s.sweep.type });
      } else if (m.opType === 3) {
        if (!s) { reply(c, { status: 5 }); return; }
        const result = [];
        for (let i = 0; i < s.count; i++) {
          const r = runReward(s.campaignId);
          if (!grant(c, r.items, { quiet: true })) { alert(c, 'Mochila cheia'); break; }
          giveExp(c, r.gp);
          result.push({ items: r.items.map(([templateId, count]) => ({ templateId, count })), type: 1, gp: r.gp, time: RUN_SECONDS });
        }
        p.s.sweep = null; p.save();
        sendPlayer(c);
        ctx.sendT(c, 140, 'army.MapUpdatedMsg', { updatedType: 3, army: ctx.M.mapArmy(p, 0) });
        reply(c, { result, status: 11, sweepType: s.type });
        refreshQuests(c);
      } else if (m.opType === 4) {
        p.s.sweep = null; p.save();
        reply(c, { status: 5 });
      } else ctx.log(`[#${c.id}] sweep opType ${m.opType} not implemented`);
    },
  };
};
