// Etkinlikler (the "funny" activity panel; client Tp manager, t_ / $c models). From the 2026-10-23 live capture:
//  Login: 4475 SumActivesMsg {actives [{activeId, activeType, title, detail, beginDate, endDate, startTime, stopTime, getway,
//  order, packages [{packageId, order, items [{templateId, templateType (4 = the cost shown), count}], conditions
//  [{conditionId, conditionValue, conditionBak, conditionBak2}]}]}], dataStamp, curPage, maxPage, mainType (0 events,
//  3 wonderland)} in pages of 4; the client reads them once curPage = maxPage and asks C_SUMACTIVE_GATE {type 1} ->
//  4476 SumActiveDataMsg {datas [{activeId, type, value, isShow, consumeMsg, packdata [{packId, status (3 not reached,
//  1 can take, 2 taken), isShow, finishValue, getCount}]}]}. {type 2, activeId, packageId, count} takes a package ->
//  items, "Pacote de presente recebido com sucesso", 4476 again (capture: Peri Turnuvası 3 fights -> 1, taken -> 2).
//  Exchanges (condition 11): hand in conditionValue x conditionBak per exchange, at most conditionBak2 times (getCount
//  = exchanges left; capture: getCount = conditionBak2 before any exchange).
//  data/sumactive.json = the capture's 36 activities; each one's dates move by whole weeks (its own next run that has
//  not ended yet), so the same week plan repeats.
// Our choices: counted from the moment the activity runs: 110 Peri Turnuvası fights, 23 bounty tasks, 26 arena fights,
// 505 weary spent, 18 mount trainings, 522 guard expeditions, 516 items used (conditionBak), 13 today's activity points,
// 14 / 131 login days; getway 3 activities (daily) restart every day; 166 recharge days and the trial / king towers
// (518, 105) and pet training (47, 48) never progress here (no recharge, not built, unknown); 45 compensation is free.
const DATA = require('../../data/sumactive.json');
const WEEK = 7 * 864e5;
const STAT = { 110: 'petArena', 23: 'bounty', 26: 'arena', 505: 'weary', 18: 'mountTrain', 522: 'guardExp' };
const COST = 4;   // templateType of the shown cost item

module.exports = (ctx) => {
  const { dec, sendT, alert, pay, grant, sysTime } = ctx;
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const parse = s => { const [a, b] = String(s).split(' '); const [y, m, d] = a.split('-').map(Number); const [h, mi, se] = (b || '0:0:0').split(':').map(Number); return new Date(y, m - 1, d, h, mi, se); };
  const day = () => sysTime().slice(0, 10);
  // the capture's weeks moved to now: an activity moves by as many weeks as it takes to end today or later (the
  // capture spans two weeks, one shift for all would push the second week's running ones past today)
  function actives() {
    const now = Date.now();
    return DATA.actives.map(a => {
      const end = parse(a.endDate).getTime(), shift = end >= now ? 0 : Math.ceil((now - end) / WEEK) * WEEK;
      const mv = s => fmt(new Date(parse(s).getTime() + shift));
      return Object.assign({}, a, { beginDate: mv(a.beginDate), endDate: mv(a.endDate), startTime: mv(a.startTime), stopTime: mv(a.stopTime) });
    });
  }
  const panelForced = () => ctx.events && ctx.events.force('sumActive');
  const runningCal = a => { const now = Date.now(); return parse(a.beginDate).getTime() <= now && now <= parse(a.endDate).getTime(); };
  const running = a => {
    const f = panelForced();
    if (f === false) return false;
    if (f === true) return runningCal(a) || parse(a.stopTime).getTime() >= Date.now();
    return runningCal(a);
  };
  if (ctx.events) ctx.events.register('sumActive', () => actives().some(runningCal));
  const condOf = a => ((a.packages[0] || {}).conditions || [])[0] || {};
  function state(p) {
    const s = p.s.sumActive = p.s.sumActive || { runs: {} };
    return s;
  }
  // one activity's run: a new one when its dates moved (next week) or, for daily ones, a new day
  function run(p, a) {
    const s = state(p), key = a.getway === 3 ? `${a.beginDate}|${day()}` : a.beginDate;
    let r = s.runs[a.activeId];
    if (!r || r.key !== key) r = s.runs[a.activeId] = { key, value: 0, taken: {}, logins: [] };
    return r;
  }
  function value(p, a, r) {
    const c = condOf(a);
    if (c.conditionId === 13) return ((p.s.leed || {}).active) || 0;
    if (c.conditionId === 14 || c.conditionId === 131) return r.logins.length;
    if (c.conditionId === 45) return c.conditionValue || 1;
    return r.value;
  }
  function packStatus(p, a, r, pk) {
    const c = (pk.conditions || [])[0] || {};
    if (c.conditionId === 11) return { status: 1, getCount: Math.max(0, (c.conditionBak2 || 1) - (r.taken[pk.packageId] || 0)) };
    if (r.taken[pk.packageId]) return { status: 2 };
    return { status: value(p, a, r) >= (c.conditionValue || 0) ? 1 : 3 };
  }
  function dataMsg(p) {
    const datas = [];
    for (const a of actives().filter(running)) {
      const r = run(p, a), v = value(p, a, r);
      datas.push({ activeId: a.activeId, type: a.activeType, value: v, isShow: true, consumeMsg: [],
        packdata: a.packages.map(pk => Object.assign({ packId: pk.packageId, isShow: true, finishValue: v }, packStatus(p, a, r, pk))) });
    }
    return { datas };
  }
  const sendData = c => sendT(c, 4476, 'active.SumActiveDataMsg', dataMsg(c.player));
  function sendTemplates(c) {
    const list = actives().filter(a => parse(a.stopTime).getTime() >= Date.now());
    for (const mt of [0, 3]) {
      const mine = list.filter(a => (a.mainType || 0) === mt), pages = Math.max(1, Math.ceil(mine.length / 4));
      for (let i = 0; i < pages; i++) sendT(c, 4475, 'active.SumActivesMsg', Object.assign({ actives: mine.slice(i * 4, i * 4 + 4).map(({ mainType, ...a }) => a), dataStamp: 106, curPage: i + 1, maxPage: pages }, mt ? { mainType: mt } : {}));
    }
  }
  ctx.onLoad.push(c => {
    if (panelForced() === false) return;
    const p = c.player;
    for (const a of actives().filter(running)) { const cid = condOf(a).conditionId; if (cid === 14 || cid === 131) { const r = run(p, a); if (!r.logins.includes(day())) r.logins.push(day()); } }
    p.save();
    sendTemplates(c);
  });
  // progress: the stat a condition counts, from the moment the activity runs
  ctx.onStat((c, key, n = 1) => {
    const p = c.player; let changed = false;
    for (const a of actives().filter(running)) {
      const cnd = condOf(a);
      const hit = STAT[cnd.conditionId] === key || (cnd.conditionId === 516 && key === `use:${cnd.conditionBak}`);
      if (hit) { run(p, a).value += n; changed = true; }
    }
    if (changed) p.save();
  });

  return {
    C_SUMACTIVE_GATE(c, body) {
      const m = dec(c, 'C_SUMACTIVE_GATE', body), p = c.player;
      if (m.type !== 2) return sendData(c);
      const a = actives().find(x => x.activeId === m.activeId), pk = a && a.packages.find(x => x.packageId === m.packageId);
      if (!a || !pk) return sendData(c);
      if (!running(a)) { alert(c, 'Etkinlik sona erdi'); return sendData(c); }
      const r = run(p, a), st = packStatus(p, a, r, pk), cnd = (pk.conditions || [])[0] || {};
      const rewards = pk.items.filter(i => i.templateType !== COST).map(i => [i.templateId, i.count]);
      if (cnd.conditionId === 11) {   // an exchange: count times the handed-in items
        const n = Math.max(1, Math.min(m.count || 1, st.getCount));
        if (st.getCount <= 0) { alert(c, 'Sem tentativas de troca restantes'); return sendData(c); }
        if (!pay(c, [[cnd.conditionBak, cnd.conditionValue * n]])) { alert(c, 'Materiais insuficientes'); return sendData(c); }
        if (!grant(c, rewards.map(([t, k]) => [t, k * n]), { quiet: true })) { grant(c, [[cnd.conditionBak, cnd.conditionValue * n]], { quiet: true }); alert(c, 'Mochila cheia'); return sendData(c); }
        r.taken[pk.packageId] = (r.taken[pk.packageId] || 0) + n;
      } else {
        if (st.status !== 1) { alert(c, st.status === 2 ? 'Esta recompensa já foi recebida' : 'Condição ainda não concluída'); return sendData(c); }
        if (!grant(c, rewards, { quiet: true })) { alert(c, 'Mochila cheia'); return sendData(c); }
        r.taken[pk.packageId] = 1;
      }
      p.save();
      alert(c, 'Pacote de presente recebido com sucesso');   // the official wording (capture)
      sendData(c);
    },
  };
};
