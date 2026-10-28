// Seviye hediyeleri (Welfare window, client iw / $A, t_s_growthfund): C_GROWTH_FUND_LEVEL {op, giftId} ->
// 512 GrowthFundRes {buyIds, receiveIds}. It was answered with recorded copies (the official player's
// receiveIds, nothing granted). Types (client XA): 1 Growth = free at level Para1; 2 Special = bought for
// Discount diamonds (op 1; client LevelGiftItem1 checks playerInfo.point >= Discount), then taken at level
// Para1; 3 VIP = level Para1 and VIP level Para2. op 0 info, 1 buy, 2 take; Reward "tid,count|...".
// C_GROWTH_FUND_RECEIVE belongs to the real-money growth fund (U_C_GROWTH_FUND_INFO isPay 1 = not bought):
// refused with a message.
module.exports = (ctx) => {
  const { dec, sendT, alert, pay, grant, table, parseRewards, log } = ctx;
  const GIFT = new Map(table('t_s_growthfund').map(r => [r.Id, r]));
  const state = p => (p.s.levelGift = p.s.levelGift || { buy: [], got: [] });
  const send = c => { const s = state(c.player); sendT(c, 512, 'growthfund.GrowthFundRes', { buyIds: s.buy, receiveIds: s.got }); };
  ctx.onLoad.push(send);

  return {
    C_GROWTH_FUND_LEVEL(c, body) {
      const m = dec(c, 'C_GROWTH_FUND_LEVEL', body), p = c.player, s = state(p), g = GIFT.get(m.giftId);
      if (m.op === 1 && g) {
        if (g.Type !== 2 || s.buy.includes(g.Id)) return send(c);
        if (!pay(c, [[-400, Number(g.Discount) || 0]])) { alert(c, 'Diamantes insuficientes'); return send(c); }
        s.buy.push(g.Id); p.save();
        alert(c, 'Pacote comprado');
      } else if (m.op === 2 && g) {
        if (s.got.includes(g.Id)) return send(c);
        if (p.s.grades < (g.Para1 || 0)) { alert(c, `Nível ${g.Para1} necessário`); return send(c); }
        if (g.Type === 2 && !s.buy.includes(g.Id)) { alert(c, 'Compre o pacote primeiro'); return send(c); }
        if (g.Type === 3 && (p.s.vip || 0) < (g.Para2 || 0)) { alert(c, `VIP ${g.Para2} necessário`); return send(c); }
        if (!grant(c, parseRewards(g.Reward))) { alert(c, 'Mochila cheia'); return send(c); }
        s.got.push(g.Id); p.save();
        log(`[#${c.id}] level gift ${g.Id} taken`);
      }
      send(c);
    },
    C_GROWTH_FUND_RECEIVE(c) { alert(c, 'Fundo de Crescimento não comprado'); },
  };
};
