// Güneş Ağacı (golden tree / "bottle"; client Wb manager, config Bottle_Price 30|300|1500). From the 2026-10-23 live
// capture + client:
//  Login: 295 BottleDropListMsg {dropItem [{tempId, count, isShow, isNewItems, isSpecial, clientRate}], score [{item,
//  param = own opens}], storey [{item, param = server opens}], open, startTime, endTime, activeUuid, atMostCount}
//  (data/bottle.json = the capture's list). C_BOTTLE_OP {opType, alterType, stickFirst}: 4 info -> 4526
//  BottleScoreMsg {openView true, count, curCount, personRecord}, 4825 BottleMsg {playerBottle [], total = server
//  opens}; 0 open (alterType 1 / 2 / 3 = x1 / x10 / x50 for Bottle_Price) then, after the tree animation, 3 -> the
//  "Güneş Ağacı'nı N kez açtın, obtido: .." alert, 4526 {count, curCount, alterBottle true}, 4825;
//  5 take the own-opens reward alterType = its param -> mail "Güneş Ağacı Kişisel Diamante Harcama Ödülü", personRecord
//  "10,.." = the taken ones.
// Our choices: draws weighted by clientRate; the event runs Monday..Sunday (opens and records reset weekly); a storey
// reward is mailed to every player who opened that week when the server total passes it; bag full -> mail.
const DATA = require('../../data/bottle.json');
const COUNTS = { 1: 1, 2: 10, 3: 50 };

module.exports = (ctx) => {
  const { dec, sendT, alert, pay, grant, CONF, db, online, playerById, log } = ctx;
  const PRICE = String(CONF.str('Bottle_Price') || '30|300|1500').split('|').map(Number);
  const totalW = DATA.dropItem.reduce((n, d) => n + (d.clientRate || 0), 0);
  const roll = () => { let x = Math.random() * totalW; for (const d of DATA.dropItem) { x -= d.clientRate || 0; if (x < 0) return d; } return DATA.dropItem[0]; };
  const pad = n => String(n).padStart(2, '0');
  function week() {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const e = new Date(d); e.setDate(d.getDate() + 7); e.setTime(e.getTime() - 1000);
    return { start: d.getTime(), end: e.getTime(), key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` };
  }
  function server() {
    const w = week().key, g = db.state.bottle = db.state.bottle || {};
    if (g.week !== w) Object.assign(g, { week: w, total: 0, storeys: [], players: [] });
    return g;
  }
  function state(p) {
    const w = week().key;
    if (!p.s.bottle || p.s.bottle.week !== w) p.s.bottle = { week: w, count: 0, taken: [], pending: null };
    return p.s.bottle;
  }
  const scoreMsg = (p, extra = {}) => { const s = state(p); return Object.assign({ count: s.count, curCount: s.count, personRecord: s.taken.join(','), serverRecord: server().storeys.join(',') }, extra); };
  const active = c => sendT(c, 4825, 'item.BottleMsg', { playerBottle: [], total: server().total });
  ctx.onLoad.push(c => {
    const w = week();
    sendT(c, 295, 'item.BottleDropListMsg', { dropItem: DATA.dropItem, score: DATA.score, storey: DATA.storey, open: true, startTime: w.start, endTime: w.end,
      activeUuid: `bottle-${w.key}`, atMostCount: DATA.atMostCount });
  });
  // a storey passed: its reward by mail to everyone who opened this week
  function storeys(before, after) {
    const g = server();
    for (const st of DATA.storey) if (before < st.param && after >= st.param && !g.storeys.includes(st.param)) {
      g.storeys.push(st.param);
      for (const id of g.players) ctx.sendMail(id, { title: 'Recompensa do Servidor — Árvore Solar', contents: `A Árvore Solar foi aberta ${st.param} vezes no servidor. Recompensa:`, annex: st.item.map(i => [i.tempId, i.count]), sendType: 4 });
    }
  }

  return {
    C_BOTTLE_OP(c, body) {
      const m = dec(c, 'C_BOTTLE_OP', body), p = c.player, s = state(p);
      if (m.opType === 4) { sendT(c, 4526, 'item.BottleScoreMsg', scoreMsg(p, { openView: true })); return active(c); }
      if (m.opType === 0) {
        const n = COUNTS[m.alterType]; if (!n || s.pending) return;
        const price = PRICE[[1, 2, 3].indexOf(m.alterType)] || 30 * n;
        if (!pay(c, [[-400, price]])) { alert(c, 'Diamantes insuficientes'); return; }
        ctx.sendPlayer(c);
        const got = new Map();
        for (let i = 0; i < n; i++) { const d = roll(); got.set(d.tempId, (got.get(d.tempId) || 0) + d.count); }
        s.pending = { n, items: [...got] };
        const g = server(), before = g.total;
        g.total += n; if (!g.players.includes(p.id)) g.players.push(p.id);
        s.count += n; p.save(); db.save && db.save();
        storeys(before, g.total);
        return;
      }
      if (m.opType === 3) {   // after the animation: the items and the result
        const pd = s.pending; if (!pd) return;
        s.pending = null;
        const names = pd.items.map(([t, k]) => `${ctx.rewardName ? ctx.rewardName(t) : t} x${k}`).join(', ');
        let text = `Você abriu a Árvore Solar ${pd.n} vezes, obtido: ${names}`;
        if (!grant(c, pd.items, { quiet: true })) {
          ctx.sendMail(p.id, { title: 'Árvore Solar', contents: 'Mochila cheia. Recompensas:', annex: pd.items, sendType: 4 });
          text += '. Mochila cheia — confira a caixa de correio!';
        }
        p.save();
        alert(c, text);
        sendT(c, 4526, 'item.BottleScoreMsg', scoreMsg(p, { alterBottle: true }));
        return active(c);
      }
      if (m.opType === 5) {
        const r = DATA.score.find(x => x.param === m.alterType);
        if (!r || s.count < r.param || s.taken.includes(r.param)) { alert(c, 'Esta recompensa não pode ser recebida'); return; }
        s.taken.push(r.param); p.save();
        ctx.sendMail(p.id, { title: 'Recompensa Pessoal — Árvore Solar (Diamantes)', contents: r.item.map(i => `${ctx.rewardName ? ctx.rewardName(i.tempId) : i.tempId} x${i.count}`).join(', '),
          annex: r.item.map(i => [i.tempId, i.count]), sendType: 4 });
        sendT(c, 4526, 'item.BottleScoreMsg', scoreMsg(p));
        return active(c);
      }
    },
  };
};
