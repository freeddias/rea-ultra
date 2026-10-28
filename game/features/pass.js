// Passe de Batalha / Passport (Welfare window, client av / passRewardInfo / passTaskModel). Client-derived:
//  seasons t_s_passindex (OpenDate .. StopDate tasks run, .. CloseDate rewards can still be taken; state 1 / 2);
//  PlayerMsg.isPassOpen from Lv passcheck_open_time[1] (30). 100 EXP a grade (client passExp % 100), at most
//  passcheck_max_grade (100); rewards t_s_passcheck per Grade (FreeReward / PayReward / LuxuryReward; the
//  Index 0 set for every season: our choice). Taken grades are bit sets (bytes, bit g-1; client checkIsReceived).
//  C_PASS_REWARD_INFO {op 1 info, 2 take (type 1 free / 2 paid / 3 luxury, index grade), 3 take all free}
//   -> 4725 PassInfoResMsg. The paid and luxury tracks are real-money (client recharge): isPay stays false.
//  C_PASS_BUY {op 2, grade}: grades for passcheck_grade_diamond (150) diamonds each; op 1 (after a top-up) no.
//  Tasks t_s_passchecktask: area 1 = passcheck_tasknum[0] (5) random daily tasks, area 2 = the weekly ones;
//   only those this server counts are offered. C_PASS_Task_INFO -> 4726, C_PASS_TASK_FRESH {op 1 take one
//   (taskId, area, id), 2 refresh area (buyType 0 bound first) for passcheck_refresh_day[n] diamonds (n = today's
//   refreshes, 3 a day), 3 take all of an area} -> 4727. Task status 0 running, 1 done, 2 taken.
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function weekKey(d = new Date()) { const m = new Date(d); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return dayKey(m); }
// task type -> our stat key (amount = the stat's n)
const TASK_STAT = { 35: 'guildOffer', 45: 'fieldElite', 44: 'fieldCommon', 46: 'fieldBoss', 19: 'groupScene', 2: 'farmHarvest', 20: 'weary', 18: 'levy',
  1: 'spendPoint', 3: 'treeWaterFriend', 57: 'farmHelp' };

module.exports = (ctx) => {
  const { dec, sendT, sendPlayer, alert, pay, grant, table, CONF, parseRewards, log } = ctx;
  const cfg = n => String((table('t_s_config').find(r => r.ConfigName === n) || {}).ConfigValue || '').split(',').map(Number);
  const SEASONS = table('t_s_passindex'), TASKS = table('t_s_passchecktask').filter(t => TASK_STAT[t.TaskType]);
  const REWARD = new Map(table('t_s_passcheck').filter(r => r.Index === 0 && r.Grade > 0).map(r => [r.Grade, r]));
  const OPEN_LV = cfg('passcheck_open_time')[1] || 30, MAX = CONF.get('passcheck_max_grade') || 100, PRICE = CONF.get('passcheck_grade_diamond') || 150;
  const REFRESH = cfg('passcheck_refresh_day'), DAILY = cfg('passcheck_tasknum')[0] || 5;
  const parse = s => new Date(String(s).replace(' ', 'T'));
  const seasonCal = (now = new Date()) => SEASONS.find(r => parse(r.OpenDate) <= now && now < parse(r.CloseDate));
  const season = (now = new Date()) => {
    const f = ctx.events && ctx.events.force('warriorPass');
    if (f === false) return undefined;
    if (f === true) return seasonCal(now) || SEASONS.slice().sort((a, b) => parse(b.OpenDate) - parse(a.OpenDate))[0];
    return seasonCal(now);
  };
  if (ctx.events) ctx.events.register('warriorPass', () => !!seasonCal());
  const weighted = (list, n) => { const pool = list.slice(), out = []; while (out.length < n && pool.length) { let x = Math.random() * pool.reduce((s, t) => s + (t.Rand || 1), 0); const i = pool.findIndex(t => (x -= t.Rand || 1) < 0); out.push(pool.splice(i < 0 ? 0 : i, 1)[0]); } return out; };
  const newTask = (t, area) => ({ taskId: t.Id, taskType: t.TaskType, area, status: 0, finishNum: 0, id: t.Id });

  function state(p) {
    const se = season();
    let s = p.s.pass;
    if (!s || !se || s.season !== se.Id) s = p.s.pass = { season: se ? se.Id : 0, exp: 0, base: [], paid: [], luxury: [], isPay: false, isPayLuxury: false, day: '', week: '', fresh: 0, daily: [], weekly: [] };
    if (s.paid == null) s.paid = [];
    if (s.luxury == null) s.luxury = [];
    if (s.day !== dayKey()) { s.day = dayKey(); s.fresh = 0; s.daily = weighted(TASKS.filter(t => t.Area === 1 && p.s.grades >= (t.NeedGrades || 0)), DAILY).map(t => newTask(t, 1)); }
    if (s.week !== weekKey()) { s.week = weekKey(); s.weekly = TASKS.filter(t => t.Area === 2 && p.s.grades >= (t.NeedGrades || 0)).map(t => newTask(t, 2)); }
    return s;
  }
  const grade = s => Math.min(MAX, Math.floor(s.exp / 100));
  const bits = list => { const b = Buffer.alloc(Math.ceil(MAX / 8)); for (const g of list) b[Math.floor((g - 1) / 8)] |= 1 << ((g - 1) % 8); return b; };
  const open = p => !!season() && p.s.grades >= OPEN_LV;
  function info(c) {
    const p = c.player, s = state(p), se = season();
    sendT(c, 4725, 'active.PassInfoResMsg', { leftTime: se ? Math.max(0, Math.floor((parse(se.CloseDate) - Date.now()) / 1000)) : 0, state: se && new Date() >= parse(se.StopDate) ? 2 : 1,
      passIndex: s.season, exp: s.exp, grade: grade(s), rewardGrade: grade(s), isPay: !!s.isPay, isPayLuxury: !!s.isPayLuxury,
      baseReward: bits(s.base), advancedReward: bits(s.paid), luxuryReward: bits(s.luxury) });
  }
  // Ultra / GM: activate advanced (+ optional luxury) warrior battle pass
  ctx.grantWarriorPass = (c, { luxury = true } = {}) => {
    const s = state(c.player);
    s.isPay = true; if (luxury) s.isPayLuxury = true;
    c.player.save(); info(c); sendPlayer(c);
    return 'Passe de Guerreiro avançado ativado' + (luxury ? ' (luxo incluso)' : '');
  };
  const taskMsg = t => ({ taskId: t.taskId, taskType: t.taskType, status: t.status, finishNum: t.finishNum, id: t.id, area: t.area });
  const all = s => [...s.daily, ...s.weekly];
  const sendTasks = (c, op = 1) => { const s = state(c.player); sendT(c, 4726, 'active.PassTaskAllInfoMsg', { opType: op, passTask: all(s).map(taskMsg), dayFreshNum: s.fresh, weekFreshNum: 0, exp: s.exp, grade: grade(s) }); };
  const sendChanged = (c, list) => { const s = state(c.player); sendT(c, 4727, 'active.PassTaskInfoRsp', { status: list.map(taskMsg), exp: s.exp, grade: grade(s), dayFreshNum: s.fresh, weekFreshNum: 0 }); };
  const stopped = () => { const se = season(); return !se || new Date() >= parse(se.StopDate); };

  ctx.passOpen = open; ctx.M.passOpen = open;   // msg.js PlayerMsg.isPassOpen
  ctx.onStat((c, key, n) => {
    if (!c.player || !open(c.player) || stopped()) return;
    const s = state(c.player), changed = [];
    for (const t of all(s)) {
      if (t.status !== 0 || TASK_STAT[t.taskType] !== key) continue;
      const need = (TASKS.find(x => x.Id === t.taskId) || {}).TaskNum || 1;
      t.finishNum = Math.min(need, t.finishNum + (n || 1));
      if (t.finishNum >= need) t.status = 1;
      changed.push(t);
    }
    if (changed.length) { c.player.save(); sendChanged(c, changed); }
  });
  function take(c, list) {
    const s = state(c.player), done = list.filter(t => t.status === 1);
    for (const t of done) { t.status = 2; s.exp = Math.min(MAX * 100, s.exp + ((TASKS.find(x => x.Id === t.taskId) || {}).Experience || 0)); }
    if (done.length) c.player.save();
    return done;
  }

  return {
    C_PASS_REWARD_INFO(c, body) {
      const m = dec(c, 'C_PASS_REWARD_INFO', body), p = c.player, s = state(p);
      if (!open(p)) { alert(c, `Passe de Batalha ${OPEN_LV}. libera no nível`); return info(c); }
      // op 2: type 1 free / 2 paid / 3 luxury one grade; op 3: take all free (and paid/luxury if unlocked)
      const grades = m.op === 2 ? [m.index] : m.op === 3 ? [...REWARD.keys()].filter(g => g <= grade(s)) : [];
      const tracks = m.op === 2 ? [m.type || 1] : m.op === 3 ? [1, s.isPay ? 2 : 0, s.isPayLuxury ? 3 : 0].filter(Boolean) : [];
      const got = [];
      for (const g of grades) {
        const r = REWARD.get(g); if (!r || g > grade(s)) continue;
        for (const ty of tracks) {
          const key = ty === 1 ? 'base' : ty === 2 ? 'paid' : 'luxury';
          const field = ty === 1 ? 'FreeReward' : ty === 2 ? 'PayReward' : 'LuxuryReward';
          if (ty === 2 && !s.isPay) { alert(c, 'Passe avançado necessário'); continue; }
          if (ty === 3 && !s.isPayLuxury) { alert(c, 'Passe luxo necessário'); continue; }
          if ((s[key] || []).includes(g) || !r[field]) continue;
          if (!grant(c, parseRewards(r[field]), { quiet: true })) { alert(c, 'Mochila cheia'); break; }
          s[key].push(g); got.push(`${ty}:${g}`);
        }
      }
      if (got.length) { p.save(); log(`[#${c.id}] pass rewards ${got.join(',')}`); }
      info(c);
    },
    C_PASS_BUY(c, body) {
      const m = dec(c, 'C_PASS_BUY', body), p = c.player, s = state(p);
      // op 1 = activate advanced after top-up / Ultra token; op 2 = buy levels with diamonds
      if (m.op === 1) {
        s.isPay = true; s.isPayLuxury = true; p.save();
        alert(c, 'Passe de Guerreiro avançado ativado!');
        return info(c);
      }
      if (m.op !== 2) return info(c);
      const n = Math.min(Math.max(0, (m.grade || 0) - grade(s)), MAX - grade(s));
      if (n <= 0) return info(c);
      if (!pay(c, [[-400, n * PRICE]])) { alert(c, 'Diamantes insuficientes'); return info(c); }
      s.exp = (grade(s) + n) * 100; p.save();
      info(c); sendTasks(c);
    },
    C_PASS_Task_INFO(c) { sendTasks(c); },
    C_PASS_TASK_FRESH(c, body) {
      const m = dec(c, 'C_PASS_TASK_FRESH', body), p = c.player, s = state(p);
      if (stopped()) { alert(c, 'As missões desta temporada acabaram'); return; }
      if (m.op === 1) return sendChanged(c, take(c, all(s).filter(t => t.taskId === m.taskId && t.area === m.area)));
      if (m.op === 3) return sendChanged(c, take(c, all(s).filter(t => t.area === m.area)));
      if (m.op === 2) {
        if (m.area !== 1) { alert(c, 'Estas missões não podem ser renovadas'); return; }
        if (s.fresh >= REFRESH.length) { alert(c, 'Atualizações de hoje acabaram'); return; }
        const price = REFRESH[s.fresh] || 0, bound = m.buyType === 0 && ctx.balance(p, -500) >= price;
        if (price && !pay(c, [[bound ? -500 : -400, price]])) { alert(c, 'Diamantes insuficientes'); return; }
        s.fresh++;
        const keep = s.daily.filter(t => t.status === 2);
        s.daily = [...keep, ...weighted(TASKS.filter(t => t.Area === 1 && p.s.grades >= (t.NeedGrades || 0) && !keep.some(k => k.taskId === t.Id)), DAILY - keep.length).map(t => newTask(t, 1))];
        p.save();
        sendTasks(c, 2);
      }
    },
  };
};
