// "Fırsat paketi" (t_s_giftpackage) and the one-time account-upgrade reward. Both were recorded copies:
// every character got the official one's mails ("Ücretsiz Günlük Paket ... comprado") and bag.
//  packages: Type 1 daily, 2 weekly, 3 monthly; PurchaseLimit per period; NeedGrades. Only the free ones
//   (no ProductId: 1, 10, 21) can be taken — the others are real-money products. Loot goes by mail (capture:
//   title "Fırsat paketi comprado", "X comprado com sucesso, obtido: Diamante Vinculado*10, , lütfen
//   zamanında toplayın!", alert "Pacote comprado e recompensas enviadas pelo correio!"), then 4971
//   GiftPackageTotalInfo {infos: [{id, num bought this period}]}.
//  account upgrade (C_USER_UPACCOUNT_REWARD): once per character, the capture's reward and wording
//   ("İşte hesabınızı yükselttiğiniz için alacağınız ödüller:Diamante Vinculado x200, Büyük Ouro Kesesi x2,
//   Lv. 3 - 5 Mücevher Kutusu x2"), 4868 {ret: 1}.
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const weekKey = (d = new Date()) => { const m = new Date(d); m.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return dayKey(m); };
const monthKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const UPACCOUNT = [[-500, 200], [2030102, 2], [2060020, 2]];

module.exports = (ctx) => {
  const { table, dec, sendT, grant, alert, chat, rewardName, parseRewards, sendPlayer } = ctx;
  const PACKS = new Map(table('t_s_giftpackage').map(r => [r.Id, r]));
  const periodKey = type => type === 1 ? dayKey() : type === 2 ? weekKey() : monthKey();

  function bought(p) {
    const g = p.s.giftpack = p.s.giftpack || { keys: {}, num: {} };
    for (const r of PACKS.values()) {
      const k = periodKey(r.Type);
      if (g.keys[r.Id] !== k) { g.keys[r.Id] = k; delete g.num[r.Id]; }
    }
    return g;
  }
  const info = c => { const g = bought(c.player); sendT(c, 4971, 'giftpackage.GiftPackageTotalInfo', { infos: Object.entries(g.num).map(([id, num]) => ({ id: Number(id), num })) }); };
  ctx.onLoad.push(info);   // replaces the recorded one (NATIVE 4971)

  return {
    C_SHOP_GIFT_PACKAGE_TOTAL_INFO(c, body) {
      const m = dec(c, 'C_SHOP_GIFT_PACKAGE_TOTAL_INFO', body), p = c.player;
      if (m.op !== 1) return info(c);
      const r = PACKS.get(m.id);
      if (!r) { alert(c, 'Pacote não encontrado'); return info(c); }
      if (r.ProductId) { alert(c, 'Este pacote é vendido por dinheiro real; este servidor não tem pagamento'); return info(c); }
      if (r.NeedGrades && p.s.grades < r.NeedGrades) { alert(c, `Personagem Lv. ${r.NeedGrades} necessário`); return info(c); }
      const g = bought(p);
      if ((g.num[r.Id] || 0) >= (r.PurchaseLimit || 1)) { alert(c, 'Você já recebeu este pacote neste período'); return info(c); }
      const items = parseRewards(r.Item);
      const list = items.map(([t, n]) => `${rewardName(t)}*${n}`).join(', ');
      if (!ctx.sendMail(p.id, { title: 'Pacote especial comprado', contents: `${ctx.nameOf(r, 'Name')} comprado com sucesso, obtido: ${list}, retire a tempo!`, annex: items, sendType: 4 })) { alert(c, 'Caixa de correio cheia'); return info(c); }
      g.num[r.Id] = (g.num[r.Id] || 0) + 1;
      p.save();
      ctx.stat(c, 'giftpack');
      alert(c, 'Pacote comprado e recompensas enviadas pelo correio!');
      info(c);
    },
    C_USER_UPACCOUNT_REWARD(c) {
      const p = c.player;
      if (p.s.upaccountReward) return sendT(c, 4868, 'player.UserBindReward', { ret: 0 });
      if (!grant(c, UPACCOUNT, { quiet: true })) { alert(c, 'Mochila cheia'); return sendT(c, 4868, 'player.UserBindReward', { ret: 0 }); }
      p.s.upaccountReward = true; p.save();
      sendPlayer(c);
      const text = 'Recompensas por elevar sua conta: ' + UPACCOUNT.map(([t, n]) => `${rewardName(t)} x${n}`).join(', ');
      alert(c, text);
      sendT(c, 4868, 'player.UserBindReward', { ret: 1 });
      chat(c, text);
    },
  };
};
