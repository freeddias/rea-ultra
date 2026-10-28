// VIP (client Hd / VipPrivilegeWnd). This version's VIP is VIP EXP: 4410 VipInfoMsg {vipGp, vipGrade,
// giftState[]}; the grade from t_s_upgradetemplate Types 4 (Data = VIP EXP of the grade: 60, 120, 360 ..).
// It was a recorded copy (the official player's vipGp 10). VIP EXP comes only from rewards (-5500, kept in
// p.s.currency) — there is no real-money top-up here. p.s.vip / p.s.vipGrade hold the grade for the other
// features (shop daily limits Vipp<grade>, level gifts, chat).
// Packs (t_s_vippackage, C_VIP_OPEN_GIFT {type, grade} -> 4409 OpenGiftRsp {type, grade, ret}): type -1 the
// daily pack (PayQuality -1) once a day at that grade or higher, 0 the benefit pack (PayQuality 0) once, 1 the
// paid pack (PayQuality 1) once for Price diamonds (client checks playerInfo.point). VipGiftState per grade:
// dayGiftState 1 = taken today, isFreeGift / isPayGift = taken (our reading of the fields).
// C_VIP_OPEN (time-based VIP for days, a friend's gift), C_VIP_COIN_OPEN (VIP money) and C_VIPCUSTOM_ADD
// (VIP customer service) belong to systems this version does not have: answered with a message.
const VIP_EXP = -5500;
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

module.exports = (ctx) => {
  const { dec, sendT, alert, pay, grant, table, parseRewards, log } = ctx;
  const STEPS = table('t_s_upgradetemplate').filter(r => r.Types === 4).sort((a, b) => a.Grades - b.Grades);
  const PACKS = table('t_s_vippackage');
  const pack = (grade, type) => PACKS.find(r => r.Grade === grade && r.PayQuality === type);
  const exp = p => (p.s.currency || {})[VIP_EXP] || 0;
  const gradeOf = gp => STEPS.reduce((g, s) => (gp >= s.Data ? s.Grades : g), 0);
  function state(p) {
    const v = p.s.vipGifts = p.s.vipGifts || { day: '', days: [], free: [], paid: [] };
    if (v.day !== dayKey()) { v.day = dayKey(); v.days = []; }
    return v;
  }
  function info(p) {
    const g = gradeOf(exp(p)), v = state(p);
    p.s.vip = g; p.s.vipGrade = g;
    const grades = [...new Set(PACKS.map(r => r.Grade))].sort((a, b) => a - b);
    return { vipGp: exp(p), vipGrade: g, isGainBuff: false, giftState: grades.map(n => ({ vipGrade: n, dayGiftState: v.days.includes(n) ? 1 : 0, dayGiftTime: v.day,
      isFreeGift: v.free.includes(n), isPayGift: v.paid.includes(n) })) };
  }
  const send = c => sendT(c, 4410, 'vip.VipInfoMsg', info(c.player));
  ctx.onLoad.push(send);
  ctx.vipRefresh = c => { const before = c.player.s.vip || 0; send(c); if ((c.player.s.vip || 0) > before) alert(c, `Parabéns, você se tornou VIP ${c.player.s.vip}!`); };
  ctx.vipGrade = p => gradeOf(exp(p));
  // VIP privileges (t_s_vipprerogativetemplate: type + grade -> para1): 4 campaign EXP +%, 36 extra free levies,
  // 38 bounty rewards +% (used by logic.js, castle.js, bounty.js)
  const PRIV = ctx.table('t_s_vipprerogativetemplate');
  ctx.vipPriv = (p, type) => { const g = gradeOf(exp(p)), r = PRIV.find(x => x.type === type && x.grade === g); return r ? Number(r.para1) || 0 : 0; };

  const notHere = text => c => alert(c, text);
  return {
    C_VIP_OPEN_GIFT(c, body) {
      const m = dec(c, 'C_VIP_OPEN_GIFT', body), p = c.player, v = state(p), g = gradeOf(exp(p)), r = pack(m.grade, m.type);
      const reply = ret => { sendT(c, 4409, 'vip.OpenGiftRsp', { type: m.type, grade: m.grade, ret }); send(c); };
      if (!r) return reply(0);
      if (g < m.grade) { alert(c, `VIP ${m.grade} necessário`); return reply(0); }
      const list = m.type === -1 ? v.days : m.type === 0 ? v.free : v.paid;
      if (list.includes(m.grade)) { alert(c, m.type === -1 ? 'Pacote de hoje já recebido' : 'Este pacote já foi recebido'); return reply(0); }
      if (m.type === 1 && !pay(c, [[-400, r.Price || 0]])) { alert(c, 'Diamantes insuficientes'); return reply(0); }
      if (!grant(c, parseRewards(r.Item))) { if (m.type === 1) grant(c, [[-400, r.Price || 0]], { quiet: true }); alert(c, 'Mochila cheia'); return reply(0); }
      list.push(m.grade); p.save();
      log(`[#${c.id}] vip pack ${r.Id}`);
      reply(1);
    },
    C_VIP_OPEN: notHere('VIP temporário não disponível nesta versão'),
    C_VIP_COIN_OPEN: notHere('Moeda VIP não pode ser usada nesta versão'),
    C_VIPCUSTOM_ADD: notHere('Atendimento VIP não disponível'),
  };
};
