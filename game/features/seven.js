// First-week events, counted from character creation:
//  - seven-day goals (t_s_seventarget): tasks per day, status 1 claimable / 2 in progress / 3 claimed;
//    stars = sum of Num of claimed tasks (capture: 1101, 1102, 1104 -> 1, 2, 3); star chests t_s_seventreasure
//    (Integral = stars needed, rewardSite bit = Id); daily discount packs t_s_sevengiftbag (giftSite bit = Id)
//  - seven-day login rewards (t_s_sevensignin): one per day logged in, rewardSite bit = day
// The table has no condition type, only Para1..3 and a title, so goals are evaluated by Id; goals of systems
// this server doesn't run yet stay in progress (value 0).
const DAY = 86400000;
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

module.exports = (ctx) => {
  const { table, D, dec, sendT, alert, chat, grant, pay, parseRewards, rewardName, log } = ctx;
  const TASKS = table('t_s_seventarget');
  const TASK = new Map(TASKS.map(t => [t.Id, t]));
  const CHESTS = table('t_s_seventreasure');
  const BAGS = table('t_s_sevengiftbag');
  const LOGIN = table('t_s_sevensignin');

  const st = p => (p.s.seven = p.s.seven || { claimed: [], stars: 0, rewardSite: 0, giftSite: 0, loginDays: [], loginSite: 0 });
  const curDay = p => Math.min(7, Math.floor((Date.now() - p.s.created) / DAY) + 1);
  const left = p => Math.max(0, Math.floor((p.s.created + 7 * DAY - Date.now()) / 1000));

  // ---- goal values ----------------------------------------------------------------------------------
  const allItems = p => [...p.s.bag, ...Object.values(p.s.equip)];
  const bGrade = (p, master) => Math.max(0, ...p.s.buildings.filter(b => (D.buildings.get(b.templateId) || {}).MasterType === master).map(b => b.grade));
  const level = p => p.s.grades;
  const building = (p, t) => bGrade(p, t.Para2);
  const counter = key => p => (p.s.stats || {})[key] || 0;
  const VALUE = {
    1101: level, 1102: building, 2102: building, 3101: building,
    1103: counter('recruited'),
    1104: p => Math.max(0, ...p.s.skills.map(id => (D.skills.get(id) || {}).Grades || 0)),
    1106: counter('strengthen'),
    2101: p => p.fightingCapacity(),
    2104: p => Math.max(0, ...allItems(p).map(i => i.strengthenGrade || 0)),
    7103: (p, t) => allItems(p).filter(i => (i.strengthenGrade || 0) >= t.Para3).length,
  };
  const TARGET = { 2104: t => t.Para3 };
  const target = t => (TARGET[t.Id] ? TARGET[t.Id](t) : t.Para1) || 1;
  function taskMsg(p, t) {
    const s = st(p), v = VALUE[t.Id] ? VALUE[t.Id](p, t) : 0;
    const status = s.claimed.includes(t.Id) ? 3 : v >= target(t) ? 1 : 2;
    return { taskId: t.Id, taskType: t.MainType, status, finishNum: Math.min(v, target(t)) };
  }
  function info(c) {
    const p = c.player, s = st(p), day = curDay(p);
    ctx.sendN(c, 'U_C_SEVEN_TARGET_INFO', {
      sevenTask: TASKS.filter(t => t.Day <= day).map(t => taskMsg(p, t)),
      startTime: Math.floor(p.s.created / 1000), rewardSite: s.rewardSite, giftSite: s.giftSite, starNum: s.stars, day, residualTime: left(p),
    });
  }

  // the official server pushes the goal list when progress moves (capture: after recruiting, buying)
  ctx.onStat(c => { if (c.player && curDay(c.player) <= 7 && Date.now() - c.player.s.created < 7 * DAY) info(c); });

  // ---- seven-day login ------------------------------------------------------------------------------
  ctx.onLogin.push(c => {
    const s = st(c.player), today = dayKey();
    if (!s.loginDays.includes(today) && s.loginDays.length < 7) { s.loginDays.push(today); c.player.save(); }
  });
  const loginInfo = c => {
    const p = c.player, s = st(p);
    ctx.sendN(c, 'U_C_SEVEN_SIGN_INFO', { rewardInfo: LOGIN.map(r => ({ days: r.Day, item: r.Item })), startTime: Math.floor(p.s.created / 1000), days: s.loginDays.length, rewardSite: s.loginSite });
  };

  return {
    C_SEVEN_TARGET_INFO: info,
    C_SEVEN_TARGET_TASK_RECEIVE(c, body) {
      const m = dec(c, 'C_SEVEN_TARGET_TASK_RECEIVE', body), p = c.player, s = st(p), t = TASK.get(m.taskId);
      if (!t || t.Day > curDay(p) || taskMsg(p, t).status !== 1) { alert(c, 'Missão ainda não concluída'); return; }
      const items = parseRewards(t.Item);
      if (!grant(c, items, { quiet: true })) { alert(c, 'Mochila cheia'); return; }
      s.claimed.push(t.Id); s.stars += t.Num || 0; p.save();
      ctx.sendN(c, 'U_C_SEVEN_TARGET_TASK_RECEIVE', { starNum: s.stars, status: taskMsg(p, t) });
      chat(c, `Recompensa recebida! Obtido:${items.map(([id, n]) => `${rewardName(id)} x ${n.toLocaleString('en-US')}`).join(',')}`);
      chat(c, `Sua pontuação do objetivo de 7 dias ${s.stars} alcançou`);
    },
    // op 1 = star chest (site = t_s_seventreasure Id), op 2 = daily discount pack (site = t_s_sevengiftbag Id)
    C_SEVEN_TARGET_GIFT_RECEIVE(c, body) {
      const m = dec(c, 'C_SEVEN_TARGET_GIFT_RECEIVE', body), p = c.player, s = st(p), bit = 1 << m.site;
      if (m.op === 1) {
        const ch = CHESTS.find(x => x.Id === m.site);
        if (!ch || s.stars < ch.Integral || (s.rewardSite & bit)) { alert(c, 'Pontos insuficientes'); return; }
        if (!grant(c, parseRewards(ch.Item))) return;
        s.rewardSite |= bit;
      } else if (m.op === 2) {
        const b = BAGS.find(x => x.Id === m.site);
        if (!b || b.Day > curDay(p) || (s.giftSite & bit)) return;
        if (!pay(c, [[-400, b.Currency]])) { alert(c, 'Diamantes insuficientes'); return; }
        if (!grant(c, parseRewards(b.Item))) { grant(c, [[-400, b.Currency]], { quiet: true }); return; }
        s.giftSite |= bit;
      } else { log(`[#${c.id}] seven gift op ${m.op} not implemented`); return; }
      p.save();
      ctx.sendN(c, 'U_C_SEVEN_TARGET_GIFT_RECEIVE', { rewardSite: s.rewardSite, giftSite: s.giftSite });
      info(c);
    },
    C_SEVEN_SIGN_INFO: loginInfo,
    C_SEVEN_SIGN_RECEIVE(c, body) {
      const m = dec(c, 'C_SEVEN_SIGN_RECEIVE', body), p = c.player, s = st(p), r = LOGIN.find(x => x.Day === m.site), bit = 1 << m.site;
      if (!r || m.site > s.loginDays.length || (s.loginSite & bit)) return;
      if (!grant(c, parseRewards(r.Item))) return;
      s.loginSite |= bit; p.save();
      ctx.sendN(c, 'U_C_SEVEN_SIGN_RECEIVE', { rewardSite: s.loginSite });
      loginInfo(c);
    },
  };
};
