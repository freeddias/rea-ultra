// Unvanlar (titles; client AppellManager, t_s_appell 142 rows). Was a recorded copy (the official player's list);
// now native. Client-derived + the recorded 4484:
//  C_APPELL_EXCHANGE player.AppellExchangeMsg {appellId, look}: look = the list -> 4484 AppellsMsg {appells
//  [{appellId, isGet, value (progress), validDate}]} (capture: not owned = value "0", validDate 2000-01-01 00:00:00);
//  otherwise wear appellId (0 = none). 4491 U_APPELL_GET {appellId} = "a new title" tip (rows with Notice). The worn
//  title shows on the map army (ArmyMsg appellid). A row's Skills are t_s_skillpropertytemplate passives.
//  Conditions (CondtionType, Para) built here: 7 honour (geste) >= Para[0]; 39 the title card item (SonType 221 /
//  224, Property1 = the title) used from the bag; 202 every mount in Para owned; 203 every fashion in Para owned.
// Our choices: only the worn title's Skills count (flat values -> s.adds.appell); a card title without IsLong lasts
// 30 days; the ranking / cross-server / event conditions are not built (those titles can't be won here).
module.exports = (ctx) => {
  const { D, table, dec, sendT, alert, M } = ctx;
  const ROWS = new Map(table('t_s_appell').map(r => [r.TemplateId, r]));
  const PROPS = new Map(table('t_s_skillpropertytemplate').map(r => [r.TemplateId, r]));
  const KEYS = ['Power', 'Agility', 'Intellect', 'Physique', 'Captain', 'Attack', 'MagicAttack', 'Defence', 'MagicDefence', 'Live', 'ForceHit', 'Parry'];
  const NEVER = '2000-01-01 00:00:00', FOREVER = '2099-12-31 23:59:59';
  const z = n => String(n).padStart(2, '0');
  const fmt = ms => { const d = new Date(ms); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`; };
  const state = p => (p.s.appell = p.s.appell || { cur: 0, got: {} });
  const para = r => [].concat(r.Para || []).map(Number);
  const has = (p, id) => { const v = state(p).got[id]; return !!v && v > fmt(Date.now()); };
  function progress(p, r) {
    switch (r.CondtionType) {
      case 7: return [p.s.geste || 0, para(r)[0]];
      case 202: { const own = (p.s.mount && p.s.mount.owned) || {}; return [para(r).filter(id => own[id]).length, para(r).length]; }
      case 203: { const book = (p.s.fashion && p.s.fashion.book) || {}; return [para(r).filter(id => book[id]).length, para(r).length]; }
      default: return null;
    }
  }
  function restat(p) {
    const s = state(p), r = has(p, s.cur) && ROWS.get(s.cur), add = {};
    if (r) for (const sk of [].concat(r.Skills || [])) { const pr = PROPS.get(Number(sk)); if (pr && pr.AddType === 1) for (const k of KEYS) if (pr[k]) add[k] = (add[k] || 0) + pr[k]; }
    (p.s.adds = p.s.adds || {}).appell = add;
  }
  function grant(c, id, until) {
    const p = c.player, s = state(p), r = ROWS.get(id); if (!r) return;
    const had = has(p, id);
    s.got[id] = until; p.save();
    if (!had && r.Notice) sendT(c, 4491, 'player.AppellExchangeMsg', { appellId: id });
  }
  // conditions met since the last look
  function check(c) {
    const p = c.player;
    for (const r of ROWS.values()) {
      if (r.Job && r.Job !== p.s.job) continue;
      const pr = progress(p, r);
      if (pr && pr[0] >= pr[1] && !has(p, r.TemplateId)) grant(c, r.TemplateId, FOREVER);
    }
  }
  function list(c) {
    const p = c.player;
    check(c);
    const appells = [...ROWS.values()].filter(r => !r.Job || r.Job === p.s.job).map(r => {
      const pr = progress(p, r), got = has(p, r.TemplateId);
      return { appellId: r.TemplateId, isGet: got, value: String(pr ? Math.min(pr[0], pr[1]) : 0), validDate: got ? state(p).got[r.TemplateId] : NEVER };
    });
    sendT(c, 4484, 'player.AppellsMsg', { appells });
  }
  ctx.onLoad.push(c => { check(c); restat(c.player); });
  // title cards from the bag
  for (const son of [221, 224]) ctx.useItem[son] = (c, it, tp) => {
    const p = c.player, r = ROWS.get(tp.Property1);
    if (!r) { alert(c, 'Este cartão de título não pode ser usado'); return; }
    p.removeItem(it, 1); ctx.sendItems(c, [M.movedEntry(p, it, it.count <= 0)]);
    grant(c, r.TemplateId, r.IsLong ? FOREVER : fmt(Date.now() + 30 * 86400000));
    alert(c, `Título obtido: ${ctx.nameOf(r, 'Perfix', 'Descript') || r.TemplateId}`);
    list(c);
  };

  return {
    C_APPELL_EXCHANGE(c, body) {
      const m = dec(c, 'C_APPELL_EXCHANGE', body), p = c.player, s = state(p);
      if (m.look) return list(c);
      if (m.appellId && !has(p, m.appellId)) { alert(c, 'Você não possui este título'); return list(c); }
      s.cur = m.appellId || 0; restat(p); p.save();
      ctx.sendArmy(c); ctx.sendPlayer(c);
      list(c);
    },
  };
};
