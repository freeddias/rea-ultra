// Madalyalar (client HonorEuipTrainWnd / HonorEquipAddTimeWnd; t_s_medalstrengthen). Client-derived, no capture:
//  A medal (SonType 1301 / 1302, e.g. 30100012 Özel Asker Madalyası) is worn in hero slot 14 and is
//  time-limited: Property1 = 604800 s; ItemInfoMsg validDate is in minutes from beginDate.
//  C_MEDAL_ITEM (medal.MedalOpReq {op, delayDays}):
//   op 1 = level up the worn medal: the t_s_medalstrengthen row (MedalId = item template, MedalLv = medalLv)
//     costs Consume gold + Item ("tid,n|..."); no next row = max (only Kutsal Ejder Kontu has levels 0..9).
//   op 2 = extend: delayDays x Medal_TimeConsume ("208090,300" Alacakaranlık Madalyası) for
//     delayDays x Medal_Timelimited (1) days.
//  No reply code: the client redraws on the bag update (115) of slot 14.
// Not modelled: the medal attributes (23 armour penetration, 24 crit resistance, 25 parry penetration) have no
// place in battle.js yet; expiry is not enforced (the client counts the time down itself).
const SLOT = 14, SONS = new Set([1301, 1302]);
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

module.exports = (ctx) => {
  const { table, D, dec, sendItems, alert, pay, M, CONF } = ctx;
  const ROWS = table('t_s_medalstrengthen');
  const row = (tid, lv) => ROWS.find(r => r.MedalId === tid && (r.MedalLv || 0) === lv);
  const parse = s => String(s || '').split('|').filter(Boolean).map(x => x.split(',').map(Number)).filter(([t, n]) => t && n);
  const DELAY_COST = parse(CONF.str('Medal_TimeConsume') || '208090,300'), DELAY_DAYS = Number(CONF.get('Medal_Timelimited')) || 1;
  const name = tid => ctx.itemName(tid) || String(tid);

  return {
    C_MEDAL_ITEM(c, body) {
      const m = dec(c, 'C_MEDAL_ITEM', body), p = c.player, it = p.s.equip[SLOT];
      const tp = it && D.items.get(it.templateId);
      if (!tp || !SONS.has(tp.SonType)) return alert(c, 'Equipe uma medalha primeiro');
      if (m.op === 1) {
        const lv = it.medalLv || 0, cur = row(it.templateId, lv);
        if (!cur || !row(it.templateId, lv + 1)) return alert(c, 'Medalha no nível máximo');
        const cost = parse(cur.Item);
        if (Number(cur.Consume)) cost.push([-100, Number(cur.Consume)]);
        if (!pay(c, cost)) return alert(c, 'Ouro ou material insuficiente');
        it.medalLv = lv + 1;
        alert(c, `${name(it.templateId)} chegou ao Lv. ${it.medalLv}`);
      } else if (m.op === 2) {
        const n = Math.max(1, Math.min(999, m.delayDays || 1));
        if (!pay(c, DELAY_COST.map(([t, k]) => [t, k * n]))) return alert(c, 'Materiais insuficientes');
        const now = Date.now(), begin = it.beginDate ? new Date(it.beginDate.replace(' ', 'T')).getTime() : now;
        const end = Math.max(now, begin + (it.validDate || 0) * 60000) + n * DELAY_DAYS * 86400000;
        if (!it.beginDate) it.beginDate = fmt(new Date(now));
        const b = new Date(it.beginDate.replace(' ', 'T')).getTime();
        it.validDate = Math.ceil((end - b) / 60000);
        alert(c, `Duração da medalha ${n * DELAY_DAYS} dias estendida`);
      } else return;
      p.save();
      sendItems(c, [M.movedEntry(p, it)]);
      ctx.sendArmy(c); ctx.sendPlayer(c);
    },
  };
};
