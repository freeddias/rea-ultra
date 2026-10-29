// Campo de Batalha / CB (cliente RvrBattleWnd; campanhas Types=5 ids 4001..4011).
//  4248 U_C_WARFIELD_STATE WorldBossStateMsg {worldBossInfo[{campaignId,state}]} — state 0 = aberto agora
//  4252 U_C_WARFIELD_INFO WarFightInfoMsg {hitCount,leftTime,...}
//  C_ENTER_WARFIELD WorldBossMsg {param1=campaignId}; C_LEAVE_WARFIELD; C_CHECK_WARFIELD_COUNT
//  C_WARFIELD_ATTACK WarFieldAttackMsg {userId,defenceServerName} → PvP battleType 32
// Horário neste servidor: toda hora cheia, nos primeiros 20 min (xx:00–xx:20). Campanhas oficiais
// 13→4001 … 23→4011; demais horas rotacionam a lista. GM pode forçar aberto/fechado.
module.exports = (ctx) => {
  const { dec, sendT, table, alert, online, log, CONF, D, cfg } = ctx;
  const sites = require('../../sites');
  const srv = p => sites.showNameOf(p && p.s && p.s.site) || cfg.SERVER_NAME;
  const CAMPS = table('t_s_campaign').filter(r => Number(r.Types) === 5).sort((a, b) => a.CampaignId - b.CampaignId);
  const ALL = CAMPS.map(c => c.CampaignId);
  const ALL_SET = new Set(ALL);
  const MAX = Number(CONF.str('WarField_MaxCount')) || 1;
  const WINDOW_MIN = 20;
  const day = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const parseHM = s => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

  // campanha da hora: tabela oficial (13–23) ou rotação 4001..4011
  const hourCamp = (h = new Date().getHours()) => CAMPS.find(c => Math.floor(parseHM(c.OpenTime) / 60) === h)
    || (CAMPS.length ? CAMPS[h % CAMPS.length] : null);
  // calendário: aberta só nos minutos 0..19 de qualquer hora
  const openCal = () => {
    const d = new Date();
    if (d.getMinutes() >= WINDOW_MIN) return null;
    return hourCamp(d.getHours());
  };
  const openNow = () => {
    const f = ctx.events && ctx.events.force('warField');
    if (f === false) return null;
    if (f === true) return openCal() || hourCamp();
    return openCal();
  };
  if (ctx.events) ctx.events.register('warField', () => !!openCal());

  function leftSec(camp) {
    if (!camp) return 0;
    const d = new Date();
    if (ctx.events && ctx.events.force('warField') === true && d.getMinutes() >= WINDOW_MIN) return 3600;
    return Math.max(0, (WINDOW_MIN - d.getMinutes()) * 60 - d.getSeconds());
  }
  function stateList() {
    const cur = openNow();
    return ALL.map(id => ({ campaignId: id, state: cur && cur.CampaignId === id ? 0 : 1 }));
  }
  const sendState = c => sendT(c, 4248, 'campaign.WorldBossStateMsg', { worldBossInfo: stateList(), multiple: 100 });
  const broadcastState = () => { for (const o of online.values()) if (o.player) sendState(o); };

  function counts() {
    let one = 0, two = 0, oneScore = 0, twoScore = 0;
    for (const o of online.values()) {
      const w = o.player && o.player.s.warField;
      if (!w || !o.player.s.campaign || !ALL_SET.has(o.player.s.campaign.campaignId)) continue;
      if (w.teamId === 1) { one++; oneScore += w.score || 0; }
      else if (w.teamId === 2) { two++; twoScore += w.score || 0; }
    }
    return { oneCount: one, twoCount: two, oneScore, twoScore };
  }
  function sendInfo(c, camp) {
    const p = c.player, w = p.s.warField = p.s.warField || {};
    if (w.day !== day()) Object.assign(w, { day: day(), entries: 0 });
    sendT(c, 4252, 'campaign.WarFightInfoMsg', {
      teamId: w.teamId || 0, score: w.score || 0, order: w.order || 0, geste: p.s.geste || 0,
      hitCount: Math.max(0, MAX - (w.entries || 0)), leftTime: leftSec(camp),
      ...counts(),
    });
  }
  ctx.onLoad.push(c => { sendState(c); const cur = openNow(); if (cur) sendInfo(c, cur); });

  function inField(o) {
    return o && o.player && o.player.s.campaign && ALL_SET.has(o.player.s.campaign.campaignId);
  }
  function fieldConns(except) {
    return [...online.values()].filter(o => inField(o) && o !== except);
  }
  function playerEntry(p) {
    const st = p.s.campaign || {}, a = ctx.M.mapArmy(p), w = p.s.warField || {};
    return {
      tarIds: [], playerState: 7, heroId: p.heroId, playerId: p.id, grades: p.s.grades, nickName: p.s.nickName,
      templateId: p.s.icon, armyId: p.armyId, fightingCapacity: p.fightingCapacity(),
      curPosX: st.posX || 0, curPosY: st.posY || 0, campaignId: st.campaignId || 0, onlineState: true,
      teamId: w.teamId || 0, geste: p.s.geste || 0, serverName: srv(p), job: p.s.job,
      hp: p.stats().total.live, maxHp: p.stats().total.live, arm: a.arm, cloth: a.cloth,
      guardShowInfo: {}, ...ctx.M.showFields(p),
    };
  }
  function syncPresence(c) {
    const others = fieldConns(c);
    if (!others.length) return;
    sendT(c, 21, 'room.RoomEnterMsg', { player: others.map(o => playerEntry(o.player)), userIds: [], result: 1 });
    const me = { player: [playerEntry(c.player)], userIds: [], result: 1 };
    for (const o of others) sendT(o, 21, 'room.RoomEnterMsg', me);
  }
  function pickTeam() {
    const n = counts();
    return n.oneCount <= n.twoCount ? 1 : 2;
  }
  function spawnPos(campId, teamId) {
    const nodes = (D.campNodesByCampaign.get(campId) || []);
    const sp = nodes.find(n => n.MasterType === 40 && Number(n.Param1) === teamId) || nodes.find(n => n.MasterType === 40);
    return sp ? [sp.Property1, sp.Property2] : null;
  }

  ctx.openWarField = (force = true) => {
    if (ctx.events) ctx.events.setForce('warField', force ? true : null);
    broadcastState();
    const cur = openNow();
    for (const o of online.values()) if (o.player && cur) sendInfo(o, cur);
    return cur;
  };
  ctx.closeWarField = () => {
    if (ctx.events) ctx.events.setForce('warField', false);
    broadcastState();
  };

  const tick = setInterval(() => {
    try {
      const cur = openNow();
      for (const o of online.values()) if (o.player) { sendState(o); if (cur && inField(o)) sendInfo(o, cur); }
    } catch (e) { log('warfield tick: ' + e.message); }
  }, 30000);
  if (tick.unref) tick.unref();

  const leavePresence = c => {
    if (!c.player) return;
    for (const o of fieldConns(c)) {
      sendT(o, 4494, 'army.CrossArmyListMsg', { armyList: [{ armyId: c.player.armyId, playerId: c.player.id, serverName: srv(c.player), state: 0 }] });
    }
  };
  ctx.onClose(c => { if (inField(c)) leavePresence(c); });

  return {
    C_CHECK_WARFIELD_COUNT(c, body) {
      const m = dec(c, 'C_CHECK_WARFIELD_COUNT', body), p = c.player;
      const w = p.s.warField = p.s.warField || {};
      if (w.day !== day()) Object.assign(w, { day: day(), entries: 0 });
      const remain = Math.max(0, MAX - (w.entries || 0));
      sendT(c, 4493, 'campaign.CampaignReqMsg', { paraInt1: m.paraInt1 || 0, paraBool1: remain > 0 });
    },
    C_ENTER_WARFIELD(c, body) {
      const m = dec(c, 'C_ENTER_WARFIELD', body), p = c.player;
      const campId = m.param1 || m.paraInt1;
      const cur = openNow();
      if (!cur) {
        alert(c, 'O Campo de Batalha ainda não começou');
        return sendState(c);
      }
      // during a real calendar window, only that camp; otherwise accept any Types=5 / the open camp
      let camp = cur;
      if (campId) {
        const want = CAMPS.find(x => x.CampaignId === campId);
        if (!want) { alert(c, 'Campo de Batalha inválido'); return sendState(c); }
        if (openCal() && want.CampaignId !== cur.CampaignId && ctx.events && ctx.events.force('warField') !== true) {
          alert(c, 'O Campo de Batalha ainda não começou');
          return sendState(c);
        }
        camp = want;
      }
      if (p.s.grades < (camp.MinLevel || 30)) { alert(c, `Lv. ${camp.MinLevel || 30} necessário`); return; }
      const w = p.s.warField = p.s.warField || {};
      if (w.day !== day()) Object.assign(w, { day: day(), entries: 0 });
      if ((w.entries || 0) >= MAX && !(ctx.events && ctx.events.force('warField') === true)) {
        alert(c, 'Sem entradas restantes no Campo de Batalha hoje');
        return sendInfo(c, camp);
      }
      const map = table('t_s_map').find(r => r.CampaignId === camp.CampaignId || r.Id === camp.CampaignId);
      if (!map) { alert(c, 'Mapa do Campo de Batalha indisponível'); return; }
      w.teamId = pickTeam();
      w.score = w.score || 0;
      w.entries = (w.entries || 0) + 1;
      w.protectUntil = Date.now() + 15000;
      p.save();
      const pos = spawnPos(camp.CampaignId, w.teamId);
      ctx.enterMap(c, map.Id, pos, 1, { isCross: true, teamId: w.teamId, playerState: 7 });
      syncPresence(c);
      sendInfo(c, camp);
      sendState(c);
      ctx.stat(c, 'warField');   // daily activity Type 27
      log(`[#${c.id}] entered warfield ${camp.CampaignId} team ${w.teamId}`);
    },
    C_LEAVE_WARFIELD(c) {
      if (c.player && c.player.s.campaign && ALL_SET.has(c.player.s.campaign.campaignId)) {
        leavePresence(c);
        ctx.finishCampaign(c);
      }
      sendState(c);
    },
    C_WARFIELD_ATTACK(c, body) {
      const m = dec(c, 'C_WARFIELD_ATTACK', body), p = c.player;
      if (!inField(c)) return;
      const tc = online.get(m.userId);
      if (!tc || !tc.player || !inField(tc)) { alert(c, 'Jogador não está no Campo de Batalha'); return; }
      if (tc === c) return;
      const tw = tc.player.s.warField || {}, mw = p.s.warField || {};
      if (mw.teamId && tw.teamId && mw.teamId === tw.teamId) { alert(c, 'Não é possível atacar aliados'); return; }
      if (c.battle || tc.battle) { alert(c, 'Jogador está em batalha'); return; }
      if ((tw.protectUntil || 0) > Date.now()) { alert(c, 'Este jogador está sob proteção'); return; }
      if ((mw.protectUntil || 0) > Date.now()) { alert(c, 'Você ainda está sob proteção'); return; }
      alert(tc, `${p.s.nickName} atacou você`);
      ctx.startPvp(c, tc.player, {
        battleType: 32, mapTempId: 5,
        onEnd: won => {
          const w = p.s.warField = p.s.warField || {};
          const gain = won ? 100 : 20, geste = won ? 50 : 10;
          w.score = (w.score || 0) + gain;
          p.s.geste = (p.s.geste || 0) + geste;
          // Baú da Vitória (2131009) / Baú da Falha (2131010) — recompensa por combate no CB
          // (herança dos Tank Trials; o baú abre pela drop table Property1 = TemplateId).
          const atkChest = won ? 2131009 : 2131010;
          const defChest = won ? 2131010 : 2131009;
          const atkGot = ctx.grant(c, [[atkChest, 1]], { quiet: true });
          const defGot = ctx.grant(tc, [[defChest, 1]], { quiet: true });
          const atkName = won ? 'Baú da Vitória' : 'Baú da Falha';
          const defName = won ? 'Baú da Falha' : 'Baú da Vitória';
          alert(c, won
            ? `Vitória! +${gain} pontos, +${geste} honra${atkGot ? `, ${atkName} x1` : ''}`
            : `Derrota. +${gain} pontos, +${geste} honra${atkGot ? `, ${atkName} x1` : ''}`);
          alert(tc, (won ? `${p.s.nickName} venceu o combate` : `Você derrotou ${p.s.nickName}`)
            + (defGot ? ` (${defName} x1)` : ''));
          p.save(); tc.player.save();
          const cur = openNow();
          if (cur) { sendInfo(c, cur); if (inField(tc)) sendInfo(tc, cur); }
          ctx.sendPlayer(c); ctx.sendPlayer(tc);
          if (won) tw.protectUntil = Date.now() + 20000;
        },
      });
      log(`[#${c.id}] warfield attack vs ${tc.player.id}`);
    },
    C_WARORDER_REQUEST(c) {
      const cur = openNow();
      sendInfo(c, cur || CAMPS[0]);
      const info = [];
      for (const o of fieldConns()) {
        const w = o.player.s.warField || {};
        info.push({
          nickName: o.player.s.nickName, userId: o.player.id, score: w.score || 0,
          teamId: w.teamId || 0, geste: o.player.s.geste || 0, serverName: srv(o.player),
        });
      }
      const me = c.player.s.warField || {};
      if (inField(c)) {
        info.push({
          nickName: c.player.s.nickName, userId: c.player.id, score: me.score || 0,
          teamId: me.teamId || 0, geste: c.player.s.geste || 0, serverName: srv(c.player),
        });
      }
      sendT(c, 4255, 'campaign.WarReportListMsg', { info });
    },
  };
};
