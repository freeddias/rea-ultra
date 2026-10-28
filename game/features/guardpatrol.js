// Muhafız devriyesi (client guard patrol window; t_s_guardpatrol; config GuardPatrol_*). Client-derived, no capture:
//  C_GUARD_PATRO_REQ (guardpatrol.GuardPatrolReq {op, id = task list id, guardId "ids", payType}): 1 info, 2 send
//  guards on a task, 3 speed up (GuardPatrol_Boost "5,2": 2 diamonds per started 5 minutes left), 4 reward, 5 refresh
//  the waiting tasks (GuardPatrol_FreeRefreshTimes 3 free a day, then GuardPatrol_DiamondRefresh 15 diamonds)
//  -> 859 U_C_GUARD_PATRO_BASE_INFO GuardPatrolBaseCampMsg {totalInfo {task [{id, taskId, finishTime, state 0 waiting
//  / 1 running / 2 done, guardIds}], dayPatrolCount}, totalCount (GuardPatrol_DayLimit 10 a day), freeCount, level}.
//  GuardPatrol_TasksNumber (5) tasks. MissionType: 1 total stars >= target, 2 total awakening stages, 3 total
//  expertise, 4 "attackProperty,n": n guards whose ResiAttackProperty is that, 5 total fighting capacity, 6 total
//  skill levels; NeedTime seconds; Reward "item,n".
// Our choices: tasks drawn with weight 6 - Rarity; the awakening stage of a guard = its quality - 1; a guard on a
// running task can not go on another one.
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

module.exports = (ctx) => {
  const { table, dec, sendT, alert, pay, grant, CONF, D } = ctx;
  const TASKS = table('t_s_guardpatrol'), GT = new Map(table('t_s_guardtemplate').map(r => [r.TemplateId, r]));
  const num = (k, d) => Number(CONF.str(k)) || d;
  const N = num('GuardPatrol_TasksNumber', 5), DAY = num('GuardPatrol_DayLimit', 10), FREE = num('GuardPatrol_FreeRefreshTimes', 3), PRICE = num('GuardPatrol_DiamondRefresh', 15);
  const [BOOST_MIN, BOOST_PRICE] = String(CONF.str('GuardPatrol_Boost') || '5,2').split(',').map(Number);
  const weighted = rows => { let x = Math.random() * rows.reduce((n, r) => n + (6 - r.Rarity), 0); for (const r of rows) if ((x -= 6 - r.Rarity) < 0) return r; return rows[0]; };
  function state(p) {
    const s = p.s.guardPatrol = p.s.guardPatrol || { tasks: [], next: 1, day: '', sent: 0, refreshed: 0 };
    if (s.day !== dayKey()) { s.day = dayKey(); s.sent = 0; s.refreshed = 0; }
    while (s.tasks.length < N) s.tasks.push({ id: s.next++, taskId: weighted(TASKS).Id, state: 0, finish: 0, guards: [] });
    for (const t of s.tasks) if (t.state === 1 && t.finish <= Date.now()) t.state = 2;
    return s;
  }
  const send = c => {
    const p = c.player, s = state(p);
    sendT(c, 859, 'guardpatrol.GuardPatrolBaseCampMsg', { level: 1, totalCount: DAY, freeCount: Math.max(0, FREE - s.refreshed), finishTime: 0,
      totalInfo: { dayPatrolCount: s.sent, task: s.tasks.map(t => ({ id: t.id, taskId: t.taskId, finishTime: t.finish, state: t.state, guardIds: t.guards.join(',') })) } });
  };
  // does this group of guards meet the task?
  function meets(p, row, guards) {
    const [a, b] = String(row.TargetValue).split(',').map(Number);
    const sum = f => guards.reduce((n, g) => n + f(g), 0);
    switch (row.MissionType) {
      case 1: return sum(g => g.star) >= a;
      case 2: return sum(g => Math.max(0, g.stage - 1)) >= a;
      case 3: return sum(g => g.talent || 0) >= a;
      case 4: return guards.filter(g => String((GT.get(g.id) || {}).ResiAttackProperty || '').split('|').map(Number).includes(a)).length >= b;
      case 5: return sum(g => ctx.guardFight ? ctx.guardFight(p, g) : 0) >= a;
      case 6: return sum(g => (g.skills || []).reduce((n, id) => n + ((D.skills.get(id) || {}).Grades || 0), 0)) >= a;
    }
    return false;
  }

  return {
    C_GUARD_PATRO_REQ(c, body) {
      const m = dec(c, 'C_GUARD_PATRO_REQ', body), p = c.player, s = state(p), task = s.tasks.find(t => t.id === m.id);
      switch (m.op) {
        case 2: {
          if (!task || task.state !== 0) return send(c);
          if (s.sent >= DAY) { alert(c, 'Limite de patrulhas de hoje atingido'); return send(c); }
          const own = (p.s.guards || {}).list || {}, busy = new Set(s.tasks.filter(t => t.state === 1).flatMap(t => t.guards));
          const ids = String(m.guardId || '').split(',').filter(Boolean).map(Number);
          const guards = ids.map(id => own[id]).filter(Boolean);
          if (!guards.length || guards.length !== ids.length || ids.some(id => busy.has(id))) { alert(c, 'Estes guardas não podem ser enviados'); return send(c); }
          const row = TASKS.find(r => r.Id === task.taskId);
          if (!meets(p, row, guards)) { alert(c, 'Condição da missão não atendida'); return send(c); }
          Object.assign(task, { state: 1, finish: Date.now() + row.NeedTime * 1000, guards: ids }); s.sent++;
          break;
        }
        case 3: {
          if (!task || task.state !== 1) return send(c);
          const price = Math.ceil(Math.max(0, task.finish - Date.now()) / (BOOST_MIN * 60000)) * BOOST_PRICE;
          if (price && !pay(c, [[m.payType === 0 && ctx.balance(p, -500) >= price ? -500 : -400, price]])) { alert(c, 'Diamantes insuficientes'); return send(c); }
          task.finish = Date.now(); task.state = 2;
          break;
        }
        case 4: {
          if (!task || task.state !== 2) return send(c);
          const row = TASKS.find(r => r.Id === task.taskId);
          grant(c, String(row.Reward || '').split('|').filter(Boolean).map(x => x.split(',').map(Number)));
          s.tasks = s.tasks.filter(t => t !== task);
          state(p);
          break;
        }
        case 5: {
          if (s.refreshed >= FREE && !pay(c, [[m.payType === 0 && ctx.balance(p, -500) >= PRICE ? -500 : -400, PRICE]])) { alert(c, 'Diamantes insuficientes'); return send(c); }
          s.refreshed++;
          s.tasks = s.tasks.filter(t => t.state !== 0);
          state(p);
          break;
        }
      }
      p.save();
      send(c);
    },
  };
};
