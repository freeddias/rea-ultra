// Dünya Boss (client WorldBossFrame, map scene of campaigns 5001..5008 "Dünya BOSS"; t_s_campaigndata boss node
// CNWorldBossAi, exit node CNExitCampaignAi; t_s_activityschedule row 1 "Katılım Zamanı: 11:30-12:30 / 21:00-22:00";
// config NewWorldBoss_MaxHp "level,hp|...", Live_Pay 2, Live_Fight_Pay 5). Client-derived + one recorded 4182:
//  4182 U_C_CAMPAIGN_STATE WorldBossStateMsg {worldBossInfo [{campaignId, state}], multiple}: state 0 = open now
//  (client worldbossState), 1 = not today / not yet, 2 = over (capture: 5001 state 2 after its fight, the rest 1,
//  multiple 100). C_WORLD_BOSS_CMD worldmap.WorldBossMsg {param1 = campaignId} enters the boss map. Arriving at
//  the boss node starts a fight (battle type 12) against the shared hp; 4174 U_C_SYNC_BOSS_HP simple.WorldBossInfoMsg
//  {curHp, totalHp, campaignId, myWound, totalNum, currentMillis} keeps every map player's bar in step. After a fight
//  the hero waits (4175 U_C_PLAYER_DIE_STATE {playerState [{armyId, state 1, leftTime}]}); C_WORLDBOSS_PLAYER_LIVE
//  {payType} revives at once for Live_Pay (2) diamonds (bound first when payType 0). C_WORLDBOSS_BUFFER {op, type}
//  -> 4374 {type, pointValue, giftValue, op, result, wound}: op 0 asks the prices, 1 buys +5 % (client text) with
//  diamonds (type 1) or bound diamonds (type 2). At the end 4203 WorldBossReportMsg {type 1, campaignId, order,
//  gold, totalWound} (client texts: damage, rank, gold).
// Our choices: the noon fight is 5001, the evening one 5002; boss hp = NewWorldBoss_MaxHp of the boss level, which
// rises by one each time the boss falls (falls back by one when it survives); a fight lasts at most 10 turns; gold =
// damage / 20 per fight; waiting time after a fight 60 s; buff 20 diamonds or 20 bound diamonds for +5 %, at most
// 10; the killing blow gets the boss's level x 100000 extra gold.
module.exports = (ctx) => {
  const { D, table, dec, sendT, alert, pay, grant, CONF, sysTime, online, log } = ctx;
  const HP = new Map(String(CONF.str('NewWorldBoss_MaxHp') || '1,7200000').split('|').map(x => x.split(',').map(Number)));
  const MAXLV = Math.max(...HP.keys()), LIVE = Number(CONF.str('Live_Pay')) || 2;
  const ALL = [5001, 5002, 5003, 5004, 5005, 5006, 5007, 5008];
  const WINDOWS = [{ from: 11 * 60 + 30, to: 12 * 60 + 30, campaign: 5001 }, { from: 21 * 60, to: 22 * 60, campaign: 5002 }];
  const BUFF = { price: 20, step: 5, max: 10 }, WAIT_MS = 60000, GOLD_DIV = 20;
  const node = camp => table('t_s_campaigndata').find(r => r.CampaignId === camp && /CNWorldBossAi/.test(r.AI || ''));
  const W = { level: 1, fight: null };   // the running fight: {campaign, key, hp, max, dmg {id: n}, gold {id: n}}
  const minutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const nowWindowCal = () => (process.env.WORLDBOSS_OPEN ? WINDOWS[0] : WINDOWS.find(w => minutes() >= w.from && minutes() < w.to));
  const nowWindow = () => {
    const f = ctx.events && ctx.events.force('worldBoss');
    if (f === false) return null;
    if (f === true) return nowWindowCal() || WINDOWS[0];
    return nowWindowCal();
  };
  if (ctx.events) ctx.events.register('worldBoss', () => !!nowWindowCal());
  function current() {
    const w = nowWindow(), key = w && `${sysTime().slice(0, 10)}-${w.from}`;
    if (W.fight && W.fight.key !== key) finish();
    if (w && !W.fight && !(W.done || []).includes(key)) { const max = HP.get(W.level) || 7200000; W.fight = { campaign: w.campaign, key, hp: max, max, dmg: {}, gold: {}, dead: {}, buff: {} }; broadcastState(); }
    return W.fight;
  }
  function stateList() {
    const f = W.fight, today = sysTime().slice(0, 10), over = WINDOWS.filter(w => (W.done || []).includes(`${today}-${w.from}`)).map(w => w.campaign);
    return ALL.map(id => ({ campaignId: id, state: f && f.campaign === id ? 0 : over.includes(id) ? 2 : 1 }));
  }
  const sendState = c => sendT(c, 4182, 'campaign.WorldBossStateMsg', { worldBossInfo: stateList(), multiple: 100 });
  const broadcastState = () => { for (const c of online.values()) if (c.player) sendState(c); };
  const onMap = f => [...online.values()].filter(c => c.player && c.player.s.campaign && c.player.s.campaign.campaignId === f.campaign);
  const hpMsg = (f, c) => ({ curHp: f.hp, totalHp: f.max, campaignId: f.campaign, myWound: f.dmg[c.player.id] || 0, totalNum: Object.keys(f.dmg).length, currentMillis: Date.now(), grades: W.level, bossState: f.hp > 0 ? 0 : 1 });
  const syncHp = f => { for (const c of onMap(f)) sendT(c, 4174, 'simple.WorldBossInfoMsg', hpMsg(f, c)); };
  const rankOf = (f, id) => { const order = Object.entries(f.dmg).sort((a, b) => b[1] - a[1]).map(([u]) => Number(u)); const k = order.indexOf(id); return k < 0 ? 0 : k + 1; };
  // the window ended or the boss fell: reports to everyone who took part, the boss level moves
  function finish() {
    const f = W.fight; if (!f) return;
    W.fight = null; (W.done = W.done || []).push(f.key); W.done = W.done.slice(-10);
    W.level = f.hp <= 0 ? Math.min(MAXLV, W.level + 1) : Math.max(1, W.level - 1);
    for (const c of online.values()) {
      if (!c.player || !(c.player.id in f.dmg)) continue;
      sendT(c, 4203, 'campaign.WorldBossReportMsg', { type: 1, campaignId: f.campaign, order: rankOf(f, c.player.id), gold: f.gold[c.player.id] || 0, totalWound: f.dmg[c.player.id] || 0 });
    }
    broadcastState();
    log(`world boss ${f.campaign} over: hp ${f.hp}/${f.max}, ${Object.keys(f.dmg).length} players, level -> ${W.level}`);
  }
  const timer = setInterval(() => { try { current(); } catch (e) { log('world boss tick: ' + e.message); } }, 10000); if (timer.unref) timer.unref();
  ctx.onLoad.push(c => { current(); sendState(c); });
  const deadLeft = (f, p) => Math.max(0, Math.ceil(((f.dead[p.id] || 0) - Date.now()) / 1000));
  const dieState = (c, f) => sendT(c, 4175, 'simple.PlayerStateListMsg', { userId: c.player.id, playerState: [{ armyId: c.player.armyId, state: deadLeft(f, c.player) > 0 ? 1 : 0, leftTime: deadLeft(f, c.player), serverName: ctx.cfg.SERVER_NAME || '' }] });

  // the boss node of the map
  ctx.onArrive.push((c, cd) => {
    if (!/CNWorldBossAi/.test(cd.AI || '') || !ALL.includes(cd.CampaignId)) return false;
    const f = current(), p = c.player;
    if (!f || f.campaign !== cd.CampaignId || f.hp <= 0) { alert(c, 'A batalha do Chefe Mundial terminou'); return true; }
    if (c.battle) return true;
    if (deadLeft(f, p) > 0) { dieState(c, f); return true; }
    const startHp = f.hp, buff = f.buff[p.id] || 0;
    ctx.startBattle(c, Object.assign({}, cd, { BattleType: 12, mapTempId: cd.CampaignId, bossHp: startHp, maxTurns: 10,
      setup(units, prep) {
        const boss = units.find(u => u.side === 2 && u.hero), bp = prep.heros.find(h => h.side === 2);
        if (boss) { boss.maxHp = f.max; if (bp) bp.maxHp = f.max; }
        if (buff) { const me = units.find(u => u.playerHero); if (me) for (const k of ['attack', 'magicAttack', 'defence', 'magicDefence']) me.stats[k] = Math.floor(me.stats[k] * (1 + buff / 100)); }
      },
      onEnd: (won, b) => {
        const g = W.fight; if (!g || g !== f) return;
        const boss = b.units.find(u => u.side === 2 && u.hero), dmg = Math.max(0, Math.min(f.hp, startHp - (boss ? boss.hp : startHp)));
        f.hp -= dmg; f.dmg[p.id] = (f.dmg[p.id] || 0) + dmg;
        let gold = Math.floor(dmg / GOLD_DIV);
        if (f.hp <= 0) gold += W.level * 100000;   // the killing blow
        f.gold[p.id] = (f.gold[p.id] || 0) + gold;
        if (gold) grant(c, [[-100, gold]], { quiet: true });
        f.dead[p.id] = Date.now() + WAIT_MS;
        syncHp(f); dieState(c, f); ctx.sendPlayer(c);
        log(`[#${c.id}] world boss ${f.campaign}: ${dmg} damage, hp ${f.hp}`);
        if (f.hp <= 0) finish();
      } }));
    return true;
  });

  return {
    C_WORLDBOSS_STATE(c) { current(); sendState(c); },
    C_WORLD_BOSS_CMD(c, body) {
      const m = dec(c, 'C_WORLD_BOSS_CMD', body), f = current(), camp = m.param1;
      if (!ALL.includes(camp)) return;
      if (!f || f.campaign !== camp) { alert(c, 'O Chefe Mundial ainda não começou'); return sendState(c); }
      if (c.player.s.grades < 20) { alert(c, 'Lv. 20 necessário'); return; }
      const n = node(camp), map = table('t_s_map').find(r => r.CampaignId === camp);
      if (!map || !n) return;
      ctx.enterMap(c, map.Id, null, 1);
      sendT(c, 4174, 'simple.WorldBossInfoMsg', hpMsg(f, c));
      dieState(c, f);
    },
    C_WORLDBOSS_PLAYER_LIVE(c, body) {
      const m = dec(c, 'C_WORLDBOSS_PLAYER_LIVE', body), f = current(), p = c.player;
      if (!f || deadLeft(f, p) <= 0) { if (f) dieState(c, f); return; }
      const bound = m.payType === 0 && ctx.balance(p, -500) >= LIVE;
      if (!pay(c, [[bound ? -500 : -400, LIVE]])) { alert(c, 'Diamantes insuficientes'); return; }
      f.dead[p.id] = 0; ctx.sendPlayer(c); dieState(c, f);
    },
    C_WORLDBOSS_BUFFER(c, body) {
      const m = dec(c, 'C_WORLDBOSS_BUFFER', body), f = current(), p = c.player, have = f ? f.buff[p.id] || 0 : 0;
      const reply = result => sendT(c, 4374, 'campaign.WorldBossBufferMsg', { type: m.type, pointValue: BUFF.price, giftValue: BUFF.price, op: m.op, result, wound: have + (result && m.op === 1 ? BUFF.step : 0) });
      if (!f || m.op !== 1) return reply(false);
      if (have >= BUFF.step * BUFF.max) { alert(c, 'O limite de benefícios foi atingido'); return reply(false); }
      if (!pay(c, [[m.type === 2 ? -500 : -400, BUFF.price]])) { alert(c, 'Diamantes insuficientes'); return reply(false); }
      reply(true); f.buff[p.id] = have + BUFF.step; ctx.sendPlayer(c);
    },
  };
};
