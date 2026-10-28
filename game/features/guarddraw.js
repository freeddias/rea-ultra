// Muhafız çağırma (gacha; client hb / CP / fP, GuardLotteryWnd; t_s_gachacontrol pools, t_s_gachaset rewards).
// Client-derived, no capture:
//  C_GUARD_DRAW (carnival.GuardDrawInfoReq {op, templateId = pool, drawTimes}): 1 draw (1 or 10), 2 records.
//  4948 GuardDrawInfoRes {infos [{templateId, hadDrawTimes (toward PityCounter), freeTime (ms when the free draw is
//  back)}]} (also at load), 4947 GuardDrawAwardRes {awards [{templateId = the reward's ItemId, count}]}, 4949 records
//  (Guard_Draw_Record_Max 100).
//  A pool is open inside OpenTime "from|to"; a draw costs Cost "item,n" (FreeReset 1: one free single draw a day).
//  Group by PoolRandom weights "group,weight|...", with Assurance "group,n|..." (a group of that rank or better at
//  least every n draws) and PityCounter "group,n" (the top group by the n-th draw, then the counter restarts);
//  the reward is a t_s_gachaset row of that PoolId by Random, ItemId x Data.
// Our choices: "better" = higher group id within the pool; the free draw resets at midnight;
// t_s_gachacontrol_revise (per-draw weight revisions) is not applied.
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const MAX_RECORDS = 100;

module.exports = (ctx) => {
  const { table, dec, sendT, alert, pay, grant, CONF } = ctx;
  const POOLS = table('t_s_gachacontrol'), SET = table('t_s_gachaset');
  const pairs = s => String(s || '').split('|').filter(Boolean).map(x => x.split(',').map(Number));
  const weighted = (rows, w) => { let x = Math.random() * rows.reduce((n, r) => n + (w(r) || 0), 0); for (const r of rows) if ((x -= w(r) || 0) < 0) return r; return rows[rows.length - 1]; };
  const parseTime = s => { const t = new Date(String(s).trim().replace(' ', 'T')).getTime(); return isNaN(t) ? null : t; };
  function isOpenCal(pool, now = Date.now()) {
    if (!pool.Open) return false;
    const [a, b] = String(pool.OpenTime || '').split('|').map(parseTime);
    return a != null && b != null && now >= a && now <= b;
  }
  function isOpen(pool, now = Date.now()) {
    const f = ctx.events && ctx.events.force('guardDraw');
    if (f === false) return false;
    if (f === true) return !!pool.Open;
    return isOpenCal(pool, now);
  }
  if (ctx.events) ctx.events.register('guardDraw', () => POOLS.some(p => isOpenCal(p)));
  const state = p => (p.s.guardDraw = p.s.guardDraw || { pools: {}, records: [] });
  const poolState = (s, id) => (s.pools[id] = s.pools[id] || { had: 0, since: {}, freeDay: '' });
  const nextMidnight = () => { const d = new Date(); d.setHours(24, 0, 0, 0); return d.getTime(); };
  const info = (p) => {
    const s = state(p);
    return { infos: POOLS.filter(x => isOpen(x)).map(x => { const ps = poolState(s, x.TemplateId); return { templateId: x.TemplateId, hadDrawTimes: ps.had, freeTime: x.FreeReset && ps.freeDay === dayKey() ? nextMidnight() : 0 }; }) };
  };
  const sendInfo = c => sendT(c, 4948, 'carnival.GuardDrawInfoRes', info(c.player));
  ctx.onLoad.push(sendInfo);

  function drawOne(pool, ps) {
    const groups = pairs(pool.PoolRandom), [pityGroup, pityN] = pairs(pool.PityCounter)[0] || [];
    ps.had++;
    let group;
    if (pityGroup && ps.had >= pityN) group = pityGroup;
    else {
      // an assurance whose count ran out forces that group (or better)
      for (const [g, n] of pairs(pool.Assurance).sort((a, b) => b[0] - a[0])) if ((ps.since[g] || 0) + 1 >= n) { group = g; break; }
      if (!group) group = weighted(groups, g => g[1])[0];
    }
    if (pityGroup && group >= pityGroup) ps.had = 0;
    for (const [g] of pairs(pool.Assurance)) ps.since[g] = group >= g ? 0 : (ps.since[g] || 0) + 1;
    const rows = SET.filter(r => r.PoolId === group);
    const row = rows.length ? weighted(rows, r => r.Random) : null;
    return row ? { row, group } : null;
  }

  return {
    C_GUARD_DRAW(c, body) {
      const m = dec(c, 'C_GUARD_DRAW', body), p = c.player, s = state(p);
      if (m.op === 2) return sendT(c, 4949, 'carnival.GuardDrawRecordRes', { record: s.records });
      if (m.op !== 1) return sendInfo(c);
      const pool = POOLS.find(x => x.TemplateId === m.templateId);
      if (!pool || !isOpen(pool)) { alert(c, 'Esta convocação não está aberta agora'); return sendT(c, 4947, 'carnival.GuardDrawAwardRes', { awards: [] }); }
      const ps = poolState(s, pool.TemplateId), times = m.drawTimes >= 10 ? 10 : 1;
      const free = times === 1 && pool.FreeReset && ps.freeDay !== dayKey();
      if (!free) {
        const [item, n] = pairs(pool.Cost)[0] || [];
        if (!item || !pay(c, [[item, n * times]])) { alert(c, 'Itens de convocação insuficientes'); return sendT(c, 4947, 'carnival.GuardDrawAwardRes', { awards: [] }); }
      } else ps.freeDay = dayKey();
      const got = [];
      for (let i = 0; i < times; i++) { const d = drawOne(pool, ps); if (d) got.push(d); }
      grant(c, got.map(({ row }) => [row.ItemId, row.Data || 1]), { quiet: true });
      const now = Date.now();
      s.records = got.map(({ row, group }) => ({ templateId: row.ItemId, count: row.Data || 1, drawTime: now, groupId: group })).concat(s.records).slice(0, MAX_RECORDS);
      p.save();
      sendT(c, 4947, 'carnival.GuardDrawAwardRes', { awards: got.map(({ row }) => ({ templateId: row.ItemId, count: row.Data || 1 })) });
      sendInfo(c);
    },
  };
};
