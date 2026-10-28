// Süreli hediye (limited time gift; client TimeGiftWnd / Wj LimitedTimeGiftManager; t_s_limitedtimegift).
// Client-derived, no capture:
//  4209 U_C_LIMITEDTIMEGIFT_LIST LimitedTimeGiftRspMsg {gifts [{templateId, lastShowTime "YYYY-MM-DD hh:mm:ss" =
//  the end of the offer, showSecond, status 0 Normal / 1 Finish (removed), type 0 = t_s_limitedtimegift}]}; the
//  window pops up for a new gift with IfEject. C_LIMITEDTIMEGIFT_REQ {op 1, templateId, type}: buy it (Price
//  diamonds, Item "tid,n|...").
// Our choices: only Condition 3 is built — the offer appears when the hero reaches level Para1 (it equals MinLevel in
// every row) and lasts ItemTime seconds; MaxTimes purchases, DayTimes a day. Conditions 1 / 2 (one row each:
// weary potions, luck stones; Para1 2 / 3) are not built — their trigger is not known.
module.exports = (ctx) => {
  const { table, dec, sendT, alert, pay, grant } = ctx;
  const ROWS = table('t_s_limitedtimegift').filter(r => r.Condition === 3);
  const parse = s => String(s || '').split('|').map(x => x.split(',').map(Number)).filter(([t, n]) => t && n);
  const z = x => String(x).padStart(2, '0');
  const fmt = ms => { const d = new Date(ms); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`; };
  const day = () => fmt(Date.now()).slice(0, 10);
  const state = p => (p.s.ltGift = p.s.ltGift || { level: p.s.grades, offers: {} });   // level: offers are for levels reached after this
  const giftMsg = (id, o, status = 0) => ({ templateId: Number(id), lastShowTime: fmt(o.until), showSecond: Math.max(0, Math.floor((o.until - Date.now()) / 1000)), status, type: 0 });
  function check(c, push) {
    const p = c.player, s = state(p), now = Date.now(), fresh = [];
    for (const r of ROWS) if (r.Para1 > s.level && r.Para1 <= p.s.grades && p.s.grades <= (r.MaxLevel || 999) && !s.offers[r.Id]) { s.offers[r.Id] = { until: now + r.ItemTime * 1000, bought: 0 }; fresh.push(r.Id); }
    s.level = Math.max(s.level, p.s.grades);
    for (const [id, o] of Object.entries(s.offers)) if (o.until < now - 86400000) delete s.offers[id];   // long expired
    if (fresh.length) p.save();
    const active = Object.entries(s.offers).filter(([id, o]) => o.until > now && o.bought < ((ROWS.find(r => r.Id === Number(id)) || {}).MaxTimes || 1));
    if (push || fresh.length) sendT(c, 4209, 'limitedtimegift.LimitedTimeGiftRspMsg', { op: 0, gifts: active.map(([id, o]) => giftMsg(id, o)) });
  }
  ctx.onLoad.push(c => check(c, true));
  ctx.onExp.push(c => check(c, false));

  return {
    C_LIMITEDTIMEGIFT_REQ(c, body) {
      const m = dec(c, 'C_LIMITEDTIMEGIFT_REQ', body), p = c.player, s = state(p);
      if (m.op !== 1) return check(c, true);
      const r = ROWS.find(x => x.Id === m.templateId), o = s.offers[m.templateId];
      if (!r || !o || o.until < Date.now()) { alert(c, 'Este teklif sona erdi'); return check(c, true); }
      if (o.day !== day()) { o.day = day(); o.today = 0; }
      if (o.bought >= (r.MaxTimes || 1) || (r.DayTimes && o.today >= r.DayTimes)) { alert(c, 'Limite de compra atingido'); return check(c, true); }
      if (!pay(c, [[-400, r.Price]])) { alert(c, 'Diamantes insuficientes'); return; }
      if (!grant(c, parse(r.Item))) { alert(c, 'Mochila cheia'); return; }
      o.bought++; o.today++; p.save(); ctx.sendPlayer(c);
      const done = o.bought >= (r.MaxTimes || 1);
      sendT(c, 4209, 'limitedtimegift.LimitedTimeGiftRspMsg', { op: 1, gifts: [giftMsg(m.templateId, o, done ? 1 : 0)] });
    },
  };
};
