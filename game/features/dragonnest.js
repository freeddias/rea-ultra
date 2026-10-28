// İblis Ejderha Yuvası (season PvE, campaign 4201 AreaId 303 "SEASON_PVE", Capacity 3; season module Type 7; 40
// floors = the CNDragonBossNodeAi nodes, Param1 = floor, Heros = the floor's boss; config Season_pve_skiplevel "5,5",
// Season_pve_rebirth 30). Client-derived, no capture:
//  The client lists the campaign while the season module is open and enters it like any group campaign. 857
//  U_C_MAGIC_DRAGON_CAMPAIGN_INFO SeasonMagicDragonCampaignRes {curLevel, endTime (ms)} (client MagicNestMapWnd: the
//  floor and the time left); in battle the client shows "beat it within Season_pve_skiplevel[0] turns to jump
//  Season_pve_skiplevel[1] floors" (BattleWnd.MagicNestJumpTip). Battle type 3906 SEASON_PVE_BATTLE.
// Our choices: only the current floor's boss node is shown (others state 9 HIDE); the floor is kept for the season
// module's whole run (its CloseTime = endTime); a lost fight waits Season_pve_rebirth seconds; each new floor gives
// the campaign's Item rewards: 5 Sezon Rozeti (208105) and floor x 20000 gold (our numbers); a jump pays every
// floor passed.
module.exports = (ctx) => {
  const { table, alert, sendT, grant, CONF, sysTime, log } = ctx;
  const CAMP = 4201;
  const NODES = table('t_s_campaigndata').filter(r => r.CampaignId === CAMP && /CNDragonBossNodeAi/.test(r.AI || '')).sort((a, b) => a.Param1 - b.Param1);
  const TOP = NODES.length ? NODES[NODES.length - 1].Param1 : 40;
  const [SKIP_TURNS, SKIP_FLOORS] = String(CONF.str('Season_pve_skiplevel') || '5,5').split(',').map(Number);
  const REBIRTH = (Number(CONF.str('Season_pve_rebirth')) || 30) * 1000;
  const SEASON = table('t_s_season').filter(r => r.Type === 7);
  const runCal = () => { const now = sysTime(); return SEASON.find(r => String(r.OpenTime) <= now && now <= String(r.CloseTime)); };
  const pickClosest = () => {
    const now = sysTime();
    const open = runCal(); if (open) return open;
    const future = SEASON.filter(r => String(r.OpenTime) > now).sort((a, b) => String(a.OpenTime).localeCompare(String(b.OpenTime)));
    if (future.length) return future[0];
    return SEASON.slice().sort((a, b) => String(b.CloseTime).localeCompare(String(a.CloseTime)))[0] || null;
  };
  const run = () => {
    const f = ctx.events && ctx.events.force('dragonNest');
    if (f === false) return null;
    if (f === true) return runCal() || pickClosest();
    return runCal();
  };
  function state(p) {
    const r = run(), key = r ? r.TemplateId : 0;
    const s = p.s.dragonNest = p.s.dragonNest || {};
    if (s.key !== key) Object.assign(s, { key, floor: 1, wait: 0 });
    return s;
  }
  const endMs = () => { const r = run(); return r ? new Date(String(r.CloseTime).replace(' ', 'T')).getTime() : 0; };
  const info = c => sendT(c, 857, 'gamebox.SeasonMagicDragonCampaignRes', { curLevel: state(c.player).floor, endTime: endMs() });
  const nodeOf = f => NODES.find(n => n.Param1 === Math.min(f, TOP));
  // entering the nest: only the current floor's boss is there
  ctx.onEnterMap.push((c, mapId, st) => {
    if (mapId !== CAMP) return;
    const s = state(c.player), cur = nodeOf(s.floor);
    for (const n of NODES) st.nodes[n.Id] = n === cur && s.floor <= TOP ? 1 : 9;
    ctx.stat(c, 'dragonNestEnter');   // season pass task 67
    info(c);
  });
  ctx.onArrive.push((c, cd) => {
    if (cd.CampaignId !== CAMP || !/CNDragonBossNodeAi/.test(cd.AI || '')) return false;
    const p = c.player, s = state(p);
    if (!run()) { alert(c, 'Ninho do Dragão Demoníaco está fechado agora'); return true; }
    if (cd.Param1 !== s.floor) return true;
    if (c.battle) return true;
    const left = Math.ceil((s.wait - Date.now()) / 1000);
    if (left > 0) { alert(c, `${left} sn sonra tekrar meydan okuyabilirsin`); return true; }
    ctx.startBattle(c, Object.assign({}, cd, { BattleType: 3906, mapTempId: CAMP, onEnd: (won, b) => {
      if (!won) { s.wait = Date.now() + REBIRTH; p.save(); return; }
      const turns = b.engine ? b.engine.turn : 99, from = s.floor;
      s.floor = Math.min(TOP + 1, from + (turns <= SKIP_TURNS ? SKIP_FLOORS : 1));
      const passed = s.floor - from, gold = [...Array(passed).keys()].reduce((n, k) => n + (from + k) * 20000, 0);
      grant(c, [[208105, 5 * passed], [-100, gold]]);
      ctx.stat(c, 'dragonNestFloor', passed);   // season pass task 68
      const next = s.floor <= TOP && nodeOf(s.floor);
      for (const n of NODES) if (n !== next && (p.s.campaign || {}).nodes) p.s.campaign.nodes[n.Id] = 9;
      if (next) ctx.nodeUpdate(c, next, 1);
      ctx.nodeUpdate(c, cd, 9);
      p.save(); info(c);
      log(`[#${c.id}] dragon nest floor ${from} -> ${s.floor} (${turns} turns)`);
    } }));
    return true;
  });
  ctx.onLoad.push(c => { if (run()) info(c); });
  return {};
};
