// Sezon (season activity, system 177; client ib SeasonManager / KP; t_s_season, t_s_seasonpass_task / _reward /
// _shop; config SeasonPass_Exp 400, SeasonPass_Levelcost 300, SeasonPass_Maxgrade 35). Client-derived, no capture:
//  815 U_C_SEASON_ACTIVITY_INFO SeasonModuleStateRes {states [{type, template, status}]}: the season modules
//  (t_s_season Type: 1 main, 2 hall, 3 pass, 4 guardian, 5 market, 6 top arena, 7 dragon nest); status 1 = open
//  (client checkSeasonActivityOpen; 0 / 2 closed) and inside the row's OpenTime..CloseTime.
//  Pass (the current Type 3 row = one month; its tables by LinkID = the row's order in the season, 1.. for season 1,
//  101.. for season 2): C_SEASON_PASS_REQ {op, buyLevel, taskId}: 0 info, 1 buy levels (SeasonPass_Levelcost
//  diamonds each), 2 take the level rewards, 3 take a finished task's experience (taskId 0 = all) -> 816
//  SeasonPassInfoRes {seasonId, passId, passLevel, passExp, status (1 = premium bought), freeProgress (levels
//  taken), payProgress, tasks [{taskId, status 0 doing / 1 done / 2 taken, progress}]}; 824 SeasonTaskUpdateMsg.
//  Tasks: Area 1 every day, Area 2 for the whole pass; TaskType + TaskNum + Experience.
//  Market: C_SEASON_SHOP_REQ {op, shopId, buyCount, freeId}: 0 info, 1 buy (Price x Currency, Count = limit)
//  -> 822 SeasonShopInfoRes {seasonId, shopRecords {id: bought}, giftRecords}.
// Our choices: only the main, pass and market modules are opened (the others are not built); the premium track is a
// real-money purchase (status 0); passExp is the experience inside the current level; task types without a
// counterpart here never progress (mini games, dragon nest, group arena, season hall). The free gift packs of the
// market (op 2) are not built.
module.exports = (ctx) => {
  const { table, dec, sendT, alert, pay, grant, CONF, sysTime } = ctx;
  const SEASONS = table('t_s_season');
  const TASKS = table('t_s_seasonpass_task').map(r => Object.assign({}, r, { TemplateId: Number(r.TemplateId) }));
  const REWARDS = table('t_s_seasonpass_reward'), SHOP = table('t_s_seasonpass_shop');
  const EXP = CONF.get('SeasonPass_Exp') || 400, COST = CONF.get('SeasonPass_Levelcost') || 300, MAX = CONF.get('SeasonPass_Maxgrade') || 35;
  // TaskType -> our stat key (ctx.stat)
  const STAT = { 3: 'treeWaterFriend', 5: 'bountyOrange', 19: 'groupScene', 56: 'petArenaWin', 67: 'dragonNestEnter', 68: 'dragonNestFloor', 70: 'gemMatch4', 71: 'miniWar', 73: 'sudokuStage', 74: 'cardMatch' };
  const parse = s => String(s || '').split('|').map(x => x.split(',').map(Number)).filter(([t, n]) => t && n);
  const OPEN_TYPES = [1, 3, 5, 7];   // 7: İblis Ejderha Yuvası (features/dragonnest.js)
  const TYPE_EVENT = { 1: 'season', 3: 'seasonPass', 5: 'seasonShop', 7: 'dragonNest' };
  const pickClosest = (list, now) => {
    if (!list.length) return null;
    const open = list.find(r => String(r.OpenTime) <= now && now <= String(r.CloseTime));
    if (open) return open;
    const future = list.filter(r => String(r.OpenTime) > now).sort((a, b) => String(a.OpenTime).localeCompare(String(b.OpenTime)));
    if (future.length) return future[0];
    return list.slice().sort((a, b) => String(b.CloseTime).localeCompare(String(a.CloseTime)))[0];
  };

  // the season rows open now; LinkID of a Type 3 / 5 row = its order among that type in the season (+100 per season)
  function current() {
    const now = sysTime();
    let rows = SEASONS.filter(r => String(r.OpenTime) <= now && now <= String(r.CloseTime));
    const mainCal = rows.find(r => r.Type === 1) || pickClosest(SEASONS.filter(r => r.Type === 1), now);
    const sid = mainCal && mainCal.SeasonId;
    for (const t of OPEN_TYPES) {
      const key = TYPE_EVENT[t], f = ctx.events && ctx.events.force(key);
      if (f === false) rows = rows.filter(r => r.Type !== t);
      else if (f === true) {
        rows = rows.filter(r => r.Type !== t);
        const pool = SEASONS.filter(r => r.Type === t && (sid == null || r.SeasonId === sid));
        const pick = pickClosest(pool.length ? pool : SEASONS.filter(r => r.Type === t), now);
        if (pick) rows.push(pick);
      }
    }
    const link = r => { const same = SEASONS.filter(x => x.SeasonId === r.SeasonId && x.Type === r.Type).sort((a, b) => a.TemplateId - b.TemplateId); return (r.SeasonId > 1 ? (r.SeasonId - 1) * 100 : 0) + same.indexOf(r) + 1; };
    const of = t => rows.find(r => r.Type === t);
    return { rows, main: of(1), pass: of(3), shop: of(5), link };
  }
  if (ctx.events) {
    for (const [t, key] of Object.entries(TYPE_EVENT)) {
      ctx.events.register(key, () => {
        const now = sysTime();
        return SEASONS.some(r => r.Type === Number(t) && String(r.OpenTime) <= now && now <= String(r.CloseTime));
      });
    }
  }
  function state(p) {
    const cur = current(); if (!cur.pass) return null;
    const passId = cur.link(cur.pass);
    let s = p.s.seasonPass;
    if (!s || s.passId !== passId) s = p.s.seasonPass = { passId, exp: 0, free: 0, paid: 0, premium: 0, tasks: {}, shop: {}, shopId: 0 };
    if (s.paid == null) s.paid = 0;
    if (s.premium == null) s.premium = 0;
    const day = sysTime().slice(0, 10);
    if (s.day !== day) { s.day = day; for (const t of TASKS.filter(x => x.LinkId === passId && x.Area === 1)) delete s.tasks[t.TemplateId]; }
    return s;
  }
  const level = s => Math.min(MAX, Math.floor(s.exp / EXP));
  const tasksOf = s => TASKS.filter(t => t.LinkId === s.passId);
  const taskMsg = (s, t) => { const x = s.tasks[t.TemplateId] || { progress: 0, status: 0 }; return { taskId: t.TemplateId, status: x.status, progress: Math.min(x.progress, t.TaskNum) }; };
  function info(c) {
    const s = state(c.player), cur = current(); if (!s) return;
    sendT(c, 816, 'gamebox.SeasonPassInfoRes', { seasonId: cur.pass.SeasonId, passId: s.passId, passLevel: level(s), passExp: level(s) >= MAX ? EXP : s.exp % EXP, status: s.premium ? 1 : 0,
      freeProgress: s.free, payProgress: s.paid || 0, tasks: tasksOf(s).map(t => taskMsg(s, t)) });
  }
  ctx.grantSeasonPass = c => {
    const s = state(c.player);
    if (!s) return 'Temporada fechada — passe de temporada indisponível agora';
    s.premium = 1; c.player.save(); info(c);
    return 'Passe de Temporada premium ativado';
  };
  function shopInfo(c) {
    const s = state(c.player), cur = current(); if (!s || !cur.shop) return;
    const shopId = cur.link(cur.shop); if (s.shopId !== shopId) { s.shopId = shopId; s.shop = {}; }
    sendT(c, 822, 'gamebox.SeasonShopInfoRes', { seasonId: cur.shop.SeasonId, shopRecords: Object.assign({}, s.shop), giftRecords: {} });
  }
  ctx.onLoad.push(c => {
    const cur = current();
    const anchor = cur.main || cur.pass || cur.shop || cur.rows[0];
    if (!anchor) return;
    sendT(c, 815, 'gamebox.SeasonModuleStateRes', { states: [...new Set(SEASONS.filter(r => r.SeasonId === anchor.SeasonId).map(r => r.Type))].map(type => {
      const r = cur.rows.find(x => x.Type === type) || SEASONS.find(x => x.SeasonId === anchor.SeasonId && x.Type === type);
      return { type, template: r.TemplateId, status: OPEN_TYPES.includes(type) && cur.rows.includes(r) ? 1 : 0 };
    }), serverOpenTimeInterval: 0 });
    info(c); shopInfo(c);
  });
  ctx.onStat((c, key, n) => {
    const types = Object.entries(STAT).filter(([, k]) => k === key).map(([t]) => Number(t)); if (!types.length) return;
    const s = state(c.player); if (!s) return;
    const changed = [];
    for (const t of tasksOf(s).filter(x => types.includes(x.TaskType))) {
      const x = s.tasks[t.TemplateId] = s.tasks[t.TemplateId] || { progress: 0, status: 0 };
      if (x.status) continue;
      x.progress += n; if (x.progress >= t.TaskNum) x.status = 1;
      changed.push(t);
    }
    if (changed.length) sendT(c, 824, 'gamebox.SeasonTaskUpdateMsg', { tasks: changed.map(t => taskMsg(s, t)) });
  });

  return {
    C_SEASON_PASS_REQ(c, body) {
      const m = dec(c, 'C_SEASON_PASS_REQ', body), p = c.player, s = state(p);
      if (!s) { alert(c, 'Temporada fechada'); return; }
      if (m.op === 1) {
        const n = Math.max(1, Math.min(m.buyLevel || 1, MAX - level(s)));
        if (level(s) >= MAX) { alert(c, 'Já está no nível máximo'); return info(c); }
        if (!pay(c, [[-400, COST * n]])) { alert(c, 'Diamantes insuficientes'); return info(c); }
        s.exp = (level(s) + n) * EXP + (s.exp % EXP); if (level(s) >= MAX) s.exp = MAX * EXP;
        ctx.sendPlayer(c);
      } else if (m.op === 2) {
        const lv = level(s);
        const freeRows = REWARDS.filter(r => r.LinkID === s.passId && r.Level > s.free && r.Level <= lv);
        const freeItems = freeRows.flatMap(r => parse(r.FreeReward));
        if (freeItems.length && !grant(c, freeItems)) { alert(c, 'Mochila cheia'); return info(c); }
        s.free = lv;
        if (s.premium) {
          const payRows = REWARDS.filter(r => r.LinkID === s.passId && r.Level > (s.paid || 0) && r.Level <= lv);
          const payItems = payRows.flatMap(r => parse(r.PayReward || r.PaidReward || ''));
          if (payItems.length && !grant(c, payItems)) { alert(c, 'Mochila cheia'); return info(c); }
          s.paid = lv;
        }
      } else if (m.op === 3) {
        const list = tasksOf(s).filter(t => (m.taskId ? t.TemplateId === m.taskId : true) && (s.tasks[t.TemplateId] || {}).status === 1);
        for (const t of list) { s.tasks[t.TemplateId].status = 2; s.exp = Math.min(MAX * EXP, s.exp + (t.Experience || 0)); }
        if (!list.length) alert(c, 'Nenhuma recompensa de missão para receber');
      }
      p.save();
      info(c);
    },
    C_SEASON_SHOP_REQ(c, body) {
      const m = dec(c, 'C_SEASON_SHOP_REQ', body), p = c.player, s = state(p);
      if (!s) { alert(c, 'Temporada fechada'); return; }
      shopInfo(c);
      if (m.op === 1) {
        const r = SHOP.find(x => x.TemplateId === m.shopId && x.LinkID === s.shopId), n = Math.max(1, m.buyCount || 1);
        if (!r) { alert(c, 'Este item não está à venda'); return; }
        if (r.Count && (s.shop[r.TemplateId] || 0) + n > r.Count) { alert(c, 'Limite de compra atingido'); return; }
        if (!pay(c, [[r.Currency, r.Price * n]])) { alert(c, 'Emblema de Temporada insuficiente'); return; }
        if (!grant(c, parse(r.Item).map(([t, k]) => [t, k * n]))) { alert(c, 'Mochila cheia'); return; }
        s.shop[r.TemplateId] = (s.shop[r.TemplateId] || 0) + n; p.save();
        shopInfo(c);
      } else if (m.op === 2) alert(c, 'Pacotes de presente ainda não disponíveis');
    },
  };
};
