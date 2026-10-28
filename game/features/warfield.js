// Campo de Batalha / CG (cliente RvrBattleWnd; campanhas Types=5 ids 4001..4011).
//  4248 U_C_WARFIELD_STATE WorldBossStateMsg {worldBossInfo[{campaignId,state}]} — state 0 = aberto agora
//  4252 U_C_WARFIELD_INFO WarFightInfoMsg {hitCount,leftTime,...}
//  C_ENTER_WARFIELD WorldBossMsg {param1=campaignId}; C_LEAVE_WARFIELD; C_CHECK_WARFIELD_COUNT
// Horário: OpenTime–StopTime de cada campanha (ex.: 13:00–13:20). GM/admin pode forçar aberto.
module.exports = (ctx) => {
  const { dec, sendT, table, alert, online, log, CONF } = ctx;
  const CAMPS = table('t_s_campaign').filter(r => Number(r.Types) === 5).sort((a, b) => a.CampaignId - b.CampaignId);
  const ALL = CAMPS.map(c => c.CampaignId);
  const MAX = Number(CONF.str('WarField_MaxCount')) || 1;
  const day = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const parseHM = s => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const minutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

  const openCal = () => {
    const min = minutes();
    return CAMPS.find(c => {
      const a = parseHM(c.OpenTime), b = parseHM(c.StopTime);
      return a <= b ? (min >= a && min < b) : (min >= a || min < b);
    }) || null;
  };
  const openNow = () => {
    const f = ctx.events && ctx.events.force('warField');
    if (f === false) return null;
    if (f === true) return openCal() || CAMPS[0] || null;
    return openCal();
  };
  if (ctx.events) ctx.events.register('warField', () => !!openCal());

  function leftSec(camp) {
    if (!camp) return 0;
    const f = ctx.events && ctx.events.force('warField');
    if (f === true && !openCal()) return 3600; // forçado fora do horário: 1h
    const stop = parseHM(camp.StopTime), min = minutes();
    let left = stop - min;
    if (left < 0) left += 24 * 60;
    return left * 60;
  }
  function stateList() {
    const cur = openNow();
    return ALL.map(id => ({ campaignId: id, state: cur && cur.CampaignId === id ? 0 : 1 }));
  }
  const sendState = c => sendT(c, 4248, 'campaign.WorldBossStateMsg', { worldBossInfo: stateList(), multiple: 100 });
  const broadcastState = () => { for (const o of online.values()) if (o.player) sendState(o); };
  function sendInfo(c, camp) {
    const p = c.player, w = p.s.warField = p.s.warField || {};
    if (w.day !== day()) Object.assign(w, { day: day(), entries: 0 });
    sendT(c, 4252, 'campaign.WarFightInfoMsg', {
      teamId: w.teamId || 0, score: w.score || 0, order: w.order || 0, geste: w.geste || 0,
      hitCount: Math.max(0, MAX - (w.entries || 0)), leftTime: leftSec(camp),
      oneCount: 0, twoCount: 0, oneScore: 0, twoScore: 0,
    });
  }
  ctx.onLoad.push(c => { sendState(c); const cur = openNow(); if (cur) sendInfo(c, cur); });

  // admin/GM: reopen and push state to everyone online
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
      for (const o of online.values()) if (o.player) { sendState(o); if (cur) sendInfo(o, cur); }
    } catch (e) { log('warfield tick: ' + e.message); }
  }, 30000);
  if (tick.unref) tick.unref();

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
      if (!cur || (campId && cur.CampaignId !== campId && !(ctx.events && ctx.events.force('warField') === true))) {
        alert(c, 'O Campo de Batalha ainda não começou');
        return sendState(c);
      }
      const camp = CAMPS.find(x => x.CampaignId === (campId || cur.CampaignId)) || cur;
      if (p.s.grades < (camp.MinLevel || 30)) { alert(c, `Lv. ${camp.MinLevel || 30} necessário`); return; }
      const w = p.s.warField = p.s.warField || {};
      if (w.day !== day()) Object.assign(w, { day: day(), entries: 0 });
      if ((w.entries || 0) >= MAX && !(ctx.events && ctx.events.force('warField') === true)) {
        alert(c, 'Sem entradas restantes no Campo de Batalha hoje');
        return sendInfo(c, camp);
      }
      const map = table('t_s_map').find(r => r.CampaignId === camp.CampaignId || r.Id === camp.CampaignId);
      if (!map) { alert(c, 'Mapa do Campo de Batalha indisponível'); return; }
      w.entries = (w.entries || 0) + 1; p.save();
      ctx.enterMap(c, map.Id, null, 1);
      sendInfo(c, camp);
      sendState(c);
      log(`[#${c.id}] entered warfield ${camp.CampaignId}`);
    },
    C_LEAVE_WARFIELD(c) {
      if (c.player && c.player.s.campaign && ALL.includes(c.player.s.campaign.campaignId)) {
        ctx.finishCampaign(c);
      }
      sendState(c);
    },
    C_WARFIELD_ATTACK(c) { alert(c, 'Ataque no Campo de Batalha ainda em preparação neste servidor'); },
    C_WARORDER_REQUEST(c) {
      const cur = openNow();
      sendInfo(c, cur || CAMPS[0]);
    },
  };
};
