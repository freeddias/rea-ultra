// GvG clássico / Batalha de Guilda (cliente GvgRankListWnd, C_ENTER_GUILDCAMPAIGN).
// Mapa: 7502 "Campo de Batalha de Guilda" (t_s_campaign / t_s_map). Cliente: checkConsortiaBattle.
// Calendário: ClanWar_OpenDay + ClanWar_OpenTime (t_s_config). Emparelha guildas do mesmo site por poder.
// Inscrição: cliente envia C_CONSORTIA_BATTLE_REQUEST op=BAO_MING (1) — mesma UI da lista de atividades /
// ícone da barra (U_C_CONSORTIA_BATTLE_ICON). Taxa: ClanWar_SignWealth (riqueza da guilda).
// Combate: C_PLAYER_REFAIRE → PvP battleType 24 (GUILD_WAR_BATTLE_PLAYER); placar ClanWar_*.
const G = require('../guilds');
const store = require('../../store');

const MAP_ID = 7502;
const BATTLE_TYPE = 24;   // TC.GUILD_WAR_BATTLE_PLAYER
const CHAIRMAN = 1, VICE = 2;
// CrossGuildRequestMsg.op (cliente kA)
const OP_BAO_MING = 1, OP_MAIN = 2, OP_SCHEDULE = 3, OP_RANK = 4, OP_RECORD = 5;
const OP_NOTICE = 6, OP_ENTER = 7, OP_PATH = 8, OP_GET_NOTICE = 9, OP_LEAVE = 10;
// iconType: 1 = botão inscrição, 2 = botão entrar (cliente checkConsortiaBattleSign/Enter)
const ICON_SIGN = 1, ICON_ENTER = 2;
// state no board: 5/6 = batalha aberta (cliente enterConsortiaBattle)
const STATE_IDLE = 0, STATE_FIGHT = 5;

module.exports = (ctx) => {
  const { dec, sendT, alert, online, log, CONF, cfg, playerById, sysTime } = ctx;
  const sites = require('../../sites');
  const srv = p => sites.showNameOf(p && p.s && p.s.site) || cfg.SERVER_NAME;

  const MAX_ROSTER = Number(CONF.str('GVG_People')) || 25;
  const END_SCORE = Number(CONF.str('ClanWar_EndPoint')) || 5000;
  const SIGN_FEE = Number(CONF.str('ClanWar_SignWealth')) || 50000;
  const OPEN_DAYS = String(CONF.str('ClanWar_OpenDay') || '6,7').split(',').map(Number).filter(Boolean);
  const OPEN_WINDOWS = String(CONF.str('ClanWar_OpenTime') || '20:00:00,20:20:00|20:30:00,20:50:00')
    .split('|').map(s => s.split(',').map(x => x.trim())).filter(x => x.length === 2);
  const SIGN_WINDOW = String(CONF.str('ClanWar_SignTime') || '00:00:00,23:59:59')
    .split(',').map(x => x.trim());
  const [WIN_G, LOSE_G] = String(CONF.str('ClanWar_ClanPoint') || '10,0').split(',').map(Number);
  const [WIN_P, LOSE_P] = String(CONF.str('ClanWar_PersonPoint') || '20,5').split(',').map(Number);
  const [SOLO_EVERY, SOLO_PTS] = String(CONF.str('ClanWar_PersonPointSolo') || '10,1').split(',').map(Number);

  // persisted: signed / roster / weekly bracket snapshot
  const meta = () => store.getMeta('guildwar', { week: '', matches: [], rosters: {}, signed: {} });
  const saveMeta = m => store.setMeta('guildwar', m);

  // live match state (RAM): key = `${site}|${redId}|${blueId}`
  const live = new Map();

  const parseHM = s => {
    const [h, m, sec] = String(s || '0:0:0').split(':').map(Number);
    return ((h || 0) * 60 + (m || 0)) * 60 + (sec || 0);
  };
  const weekKey = () => {
    const d = new Date();
    const onejan = new Date(d.getFullYear(), 0, 1);
    const w = Math.ceil((((d - onejan) / 864e5) + onejan.getDay() + 1) / 7);
    return `${d.getFullYear()}-W${w}`;
  };
  // JS: 0=Sun … 6=Sat. Config Chinese often 1=Mon … 7=Sun.
  const todayCfgDay = () => { const js = new Date().getDay(); return js === 0 ? 7 : js; };
  const secOfDay = () => {
    const d = new Date();
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  };
  const openCal = () => {
    if (!OPEN_DAYS.includes(todayCfgDay())) return null;
    const now = secOfDay();
    for (const [a, b] of OPEN_WINDOWS) {
      const lo = parseHM(a), hi = parseHM(b);
      if (now >= lo && now < hi) return { start: lo, end: hi, left: hi - now };
    }
    return null;
  };
  const openNow = () => {
    const f = ctx.events && ctx.events.force('guildWar');
    if (f === false) return null;
    if (f === true) {
      const cal = openCal();
      if (cal) return cal;
      return { start: secOfDay(), end: secOfDay() + 1200, left: 1200, forced: true };
    }
    return openCal();
  };
  if (ctx.events) ctx.events.register('guildWar', () => !!openCal());

  const signWindowOpen = () => {
    const f = ctx.events && ctx.events.force('guildWar');
    if (f === false) return false;
    if (f === true) return true;   // GM aberto: ainda permite inscrição
    if (!OPEN_DAYS.includes(todayCfgDay())) return false;
    if (openCal()) return false;   // durante a luta, a inscrição já fechou
    const now = secOfDay();
    const lo = parseHM(SIGN_WINDOW[0] || '0:0:0');
    const hi = parseHM(SIGN_WINDOW[1] || '23:59:59');
    return now >= lo && now <= hi;
  };
  const iconTypeNow = (p) => {
    const open = !!openNow();
    const g = p && guildOf(p);
    const signed = !!(g && isSigned(g));
    // batalha aberta + já inscrita → entrar; senão, se dá para inscrever → botão de inscrição
    if (open && signed) return ICON_ENTER;
    if (signWindowOpen() || (OPEN_DAYS.includes(todayCfgDay()) && !open)) return ICON_SIGN;
    if (open) return ICON_ENTER;
    return 0;
  };

  const guildOf = p => p && p.s.guild && G.get(p.s.guild.id);
  const duty = p => (p.s.guild || {}).duty || 5;
  const officer = p => duty(p) <= VICE;
  const fightPower = g => (g.members || []).map(id => playerById(id)).filter(Boolean)
    .reduce((n, p) => n + (p.fightingCapacity ? p.fightingCapacity() : 0), 0);

  function ensureWeek() {
    const m = meta();
    const wk = weekKey();
    if (m.week !== wk) {
      m.week = wk; m.matches = []; m.rosters = m.rosters || {}; m.signed = {};
      saveMeta(m);
    }
    if (!m.signed) m.signed = {};
    if (!m.rosters) m.rosters = {};
    return m;
  }

  function signedIds(site) {
    const m = ensureWeek();
    return (m.signed[site] || []).slice();
  }
  function isSigned(g) {
    if (!g) return false;
    return signedIds(g.site || cfg.SITE_NAME).includes(g.id);
  }
  function markSigned(g) {
    const m = ensureWeek();
    const site = g.site || cfg.SITE_NAME;
    const arr = m.signed[site] || (m.signed[site] = []);
    if (!arr.includes(g.id)) arr.push(g.id);
    // re-emparelha a partir das inscritas (antes da luta)
    m.matches = m.matches.filter(x => x.site !== site);
    saveMeta(m);
  }

  function pairGuilds(site) {
    const signed = new Set(signedIds(site));
    let pool = G.all(site).filter(g => (g.members || []).length > 0);
    const inscritos = pool.filter(g => signed.has(g.id));
    // se alguém se inscreveu, o chaveamento usa só as inscritas; senão (teste/GM) todas
    if (inscritos.length) pool = inscritos;
    const list = pool.map(g => ({ g, fp: fightPower(g) })).sort((a, b) => b.fp - a.fp);
    const pairs = [];
    for (let i = 0; i + 1 < list.length; i += 2) {
      pairs.push({ site, red: list[i].g.id, blue: list[i + 1].g.id, redName: list[i].g.name, blueName: list[i + 1].g.name });
    }
    // odd guild: bye vs empty — still listed so they can enter alone for testing
    if (list.length % 2 === 1) {
      const last = list[list.length - 1];
      pairs.push({ site, red: last.g.id, blue: 0, redName: last.g.name, blueName: '—' });
    }
    return pairs;
  }

  function ensureMatches() {
    const m = ensureWeek();
    const sitesSeen = new Set(G.all().map(g => g.site || cfg.SITE_NAME));
    let dirty = false;
    for (const site of sitesSeen) {
      if (m.matches.some(x => x.site === site)) continue;
      m.matches.push(...pairGuilds(site));
      dirty = true;
    }
    if (dirty) saveMeta(m);
    return m;
  }

  function sendIcon(c) {
    const g = guildOf(c.player);
    sendT(c, 520, 'crossguild.CrossGuildIconMsg', {
      iconType: iconTypeNow(c.player),
      hasSignIn: !!(g && isSigned(g)),
    });
  }
  function pushIconSite(site) {
    for (const o of online.values()) {
      if (!o.player) continue;
      const g = guildOf(o.player);
      if ((g && (g.site || cfg.SITE_NAME) === site) || (!g && (o.player.s.site || cfg.SITE_NAME) === site)) sendIcon(o);
    }
  }
  function guildInfoMsg(g) {
    if (!g) return { guildName: '', serverName: '', guildLevel: 0 };
    return { guildName: g.name, serverName: sites.showNameOf(g.site) || cfg.SERVER_NAME, guildLevel: g.levels[1] || 1 };
  }
  function boardMsg(p) {
    const g = guildOf(p);
    const match = g ? matchOf(p) : null;
    const red = match ? G.get(match.red) : null;
    const blue = match && match.blue ? G.get(match.blue) : null;
    const win = openNow();
    const now = Math.floor(Date.now() / 1000);
    return {
      state: win ? STATE_FIGHT : STATE_IDLE,
      startTime: win ? now : now + 3600,
      endTime: win ? now + (win.left || 1200) : now + 7200,
      guildInfo: { groupId: 1, redInfo: guildInfoMsg(red), blueInfo: guildInfoMsg(blue) },
    };
  }

  function matchOf(p) {
    const g = guildOf(p); if (!g) return null;
    const m = ensureMatches();
    return m.matches.find(x => x.site === g.site && (x.red === g.id || x.blue === g.id)) || null;
  }

  function liveKey(match) { return `${match.site}|${match.red}|${match.blue}`; }
  function getLive(match) {
    const k = liveKey(match);
    let L = live.get(k);
    if (!L) {
      const win = openNow();
      L = {
        match, redScore: 0, blueScore: 0,
        players: new Map(),   // userId -> { team, score, wound }
        started: Date.now(),
        endsAt: Date.now() + (win ? win.left : 1200) * 1000,
        ended: false,
      };
      live.set(k, L);
    }
    return L;
  }

  function rosterOf(g) {
    const m = ensureWeek();
    const key = `${g.site}|${g.id}`;
    let r = m.rosters[key];
    if (!r || !r.length) r = (g.members || []).slice(0, MAX_ROSTER);
    return r.filter(id => (g.members || []).includes(id)).slice(0, MAX_ROSTER);
  }
  function setRoster(g, ids) {
    const m = ensureWeek();
    m.rosters[`${g.site}|${g.id}`] = ids.slice(0, MAX_ROSTER);
    saveMeta(m);
  }
  function onRoster(g, p) {
    const r = rosterOf(g);
    return r.includes(p.id);
  }

  function groupListMsg(site) {
    const m = ensureMatches();
    const rows = m.matches.filter(x => x.site === site);
    const group = [];
    const pushGuild = (g, foeId) => {
      if (!g) return;
      group.push({
        consortiaId: g.id, consortiaName: g.name, group1: foeId || 0, group2: 0, group3: 0,
        result1: 0, result2: 0, result3: 0, score: 0, order: group.length + 1, fightPower: fightPower(g),
      });
    };
    for (const x of rows) {
      const red = G.get(x.red), blue = x.blue ? G.get(x.blue) : null;
      pushGuild(red, blue ? blue.id : 0);
      pushGuild(blue, red ? red.id : 0);
    }
    // cliente: gvgScheduling = guildGroup.length > 2; com 1 partida (2 guildas) a UI mostrava "sem data"
    while (group.length <= 2) {
      group.push({
        consortiaId: 0, consortiaName: '', group1: 0, group2: 0, group3: 0,
        result1: 0, result2: 0, result3: 0, score: 0, order: group.length + 1, fightPower: 0,
      });
    }
    return { group, orderTime: sysTime(), isGuildSize: group.some(x => x.consortiaId) };
  }

  function sendState(c) {
    const open = !!openNow();
    sendT(c, 4451, 'guildcampaign.GuildMsg', { param5: open });
  }
  function sendLeft(c) {
    const w = openNow();
    sendT(c, 4457, 'guildcampaign.GuildMsg', { param1: w ? w.left : 0 });
  }
  function sendScore(L) {
    const red = G.get(L.match.red), blue = L.match.blue ? G.get(L.match.blue) : null;
    const infos = [];
    if (red) infos.push({
      consortiaId: red.id, consrotiaName: red.name, noviceCount: [...L.players.values()].filter(x => x.team === 1).length,
      score: L.redScore, fightPower: fightPower(red), param1: 0, param2: 0,
    });
    if (blue) infos.push({
      consortiaId: blue.id, consrotiaName: blue.name, noviceCount: [...L.players.values()].filter(x => x.team === 2).length,
      score: L.blueScore, fightPower: fightPower(blue), param1: 0, param2: 0,
    });
    const userIds = [...L.players.keys()];
    for (const id of userIds) {
      const o = online.get(id); if (!o) continue;
      sendT(o, 4439, 'guildcampaign.GuildWarInfoListMsg', { guildWarInfos: infos, userIds });
    }
  }
  function sendJoinCount(L) {
    const msg = {
      redConsortiaId: L.match.red, redCount: [...L.players.values()].filter(x => x.team === 1).length,
      blueConsortiaId: L.match.blue || 0, blueCount: [...L.players.values()].filter(x => x.team === 2).length,
      userIds: [...L.players.keys()],
    };
    for (const id of msg.userIds) {
      const o = online.get(id); if (o) sendT(o, 4462, 'guildcampaign.GuildJoinPlayerInfoMsg', msg);
    }
  }
  function sendBuffers(c, g) {
    sendT(c, 4440, 'guildcampaign.GuildBufferListMsg', { consortiaId: g.id, buffers: [] });
  }

  function inField(o) {
    return o && o.player && o.player.s.campaign && o.player.s.campaign.campaignId === MAP_ID
      && o.player.s.guildWar && o.player.s.guildWar.matchKey;
  }
  function fieldConns(except) {
    return [...online.values()].filter(o => inField(o) && o !== except);
  }
  function playerEntry(p) {
    const st = p.s.campaign || {}, a = ctx.M.mapArmy(p), gw = p.s.guildWar || {};
    return {
      tarIds: [], playerState: 7, heroId: p.heroId, playerId: p.id, grades: p.s.grades, nickName: p.s.nickName,
      templateId: p.s.icon, armyId: p.armyId, fightingCapacity: p.fightingCapacity(),
      curPosX: st.posX || 0, curPosY: st.posY || 0, campaignId: MAP_ID, onlineState: true,
      teamId: gw.team || 0, geste: p.s.geste || 0, serverName: srv(p), job: p.s.job,
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
  function leavePresence(c) {
    if (!c.player) return;
    for (const o of fieldConns(c)) {
      sendT(o, 4494, 'army.CrossArmyListMsg', {
        armyList: [{ armyId: c.player.armyId, playerId: c.player.id, serverName: srv(c.player), state: 0 }],
      });
    }
  }
  function spawnPos(teamId) {
    const nodes = (ctx.D.campNodesByCampaign.get(MAP_ID) || []);
    const sp = nodes.find(n => n.MasterType === 40 && Number(n.Param1) === teamId)
      || nodes.find(n => n.MasterType === 40)
      || nodes[0];
    return sp ? [sp.Property1, sp.Property2] : (teamId === 1 ? [20, 20] : [80, 80]);
  }

  function endMatch(L, reason) {
    if (L.ended) return;
    L.ended = true;
    const redWin = L.redScore >= L.blueScore;
    const winId = redWin ? L.match.red : L.match.blue;
    const loseId = redWin ? L.match.blue : L.match.red;
    for (const [uid, st] of L.players) {
      const o = online.get(uid); if (!o || !o.player) continue;
      const won = st.team === (redWin ? 1 : 2);
      const pts = won ? WIN_P : LOSE_P;
      st.score = (st.score || 0) + pts;
      o.player.s.geste = (o.player.s.geste || 0) + pts;
      o.player.save();
      alert(o, won
        ? `Vitória na Batalha de Guilda! +${pts} honra (${reason})`
        : `Derrota na Batalha de Guilda. +${pts} honra (${reason})`);
      if (inField(o)) { leavePresence(o); ctx.finishCampaign(o); }
    }
    if (winId) {
      const wg = G.get(winId); if (wg) { wg.offer = (wg.offer || 0) + (WIN_G || 0); G.save(); }
    }
    if (loseId) {
      const lg = G.get(loseId); if (lg) { lg.offer = (lg.offer || 0) + (LOSE_G || 0); G.save(); }
    }
    log(`guildwar end ${liveKey(L.match)} red=${L.redScore} blue=${L.blueScore} (${reason})`);
  }

  function addScore(L, team, n, personalId) {
    if (L.ended || n <= 0) return;
    if (team === 1) L.redScore += n; else if (team === 2) L.blueScore += n;
    if (personalId && L.players.has(personalId)) L.players.get(personalId).score = (L.players.get(personalId).score || 0) + n;
    sendScore(L);
    if (L.redScore >= END_SCORE || L.blueScore >= END_SCORE) endMatch(L, 'placar');
  }

  ctx.onLoad.push(c => {
    sendState(c);
    sendIcon(c);
    if (openNow()) sendLeft(c);
  });
  function leaveMatch(c) {
    if (!c.player) return;
    const was = inField(c);
    if (was) leavePresence(c);
    const gw = c.player.s.guildWar;
    if (gw && gw.matchKey && live.has(gw.matchKey)) {
      const L = live.get(gw.matchKey);
      L.players.delete(c.player.id);
      sendJoinCount(L); sendScore(L);
    }
    if (c.player.s.guildWar) { delete c.player.s.guildWar; c.player.save(); }
  }
  ctx.onClose(c => { if (inField(c) || (c.player && c.player.s.guildWar)) leaveMatch(c); });
  // exit button / campaign finish while inside the GvG map
  ctx.before('U_C_CAMPAIGN_FINISH', c => { if (inField(c)) leaveMatch(c); });
  ctx.before('U_C_CAMPAIGN_EXIT', c => { if (inField(c)) leaveMatch(c); });

  ctx.openGuildWar = (force = true) => {
    if (ctx.events) ctx.events.setForce('guildWar', force ? true : null);
    ensureMatches();
    for (const o of online.values()) if (o.player) {
      sendState(o); sendIcon(o); if (openNow()) sendLeft(o);
    }
    return openNow();
  };
  ctx.closeGuildWar = () => {
    if (ctx.events) ctx.events.setForce('guildWar', false);
    for (const L of live.values()) if (!L.ended) endMatch(L, 'fechamento');
    for (const o of online.values()) if (o.player) { sendState(o); sendIcon(o); }
  };

  function doEnter(c) {
    const p = c.player, g = guildOf(p);
    if (!g) { alert(c, 'Você precisa estar em uma guilda'); return false; }
    const win = openNow();
    if (!win) { alert(c, 'A Batalha de Guilda ainda não começou'); sendState(c); return false; }
    ensureMatches();
    const match = matchOf(p);
    if (!match) { alert(c, 'Sua guilda não está no chaveamento desta semana'); return false; }
    if (!onRoster(g, p) && !officer(p)) {
      const r = rosterOf(g);
      if (r.length < MAX_ROSTER) setRoster(g, r.concat([p.id]));
      else { alert(c, 'Você não está na lista de participantes'); return false; }
    }
    const team = match.red === g.id ? 1 : 2;
    const L = getLive(match);
    if (L.ended) { alert(c, 'Esta batalha já terminou'); return false; }
    L.players.set(p.id, L.players.get(p.id) || { team, score: 0, wound: 0 });
    p.s.guildWar = { matchKey: liveKey(match), team, protectUntil: Date.now() + 15000 };
    p.save();
    const pos = spawnPos(team);
    ctx.enterMap(c, MAP_ID, pos, 1, { isCross: true, teamId: team, playerState: 7 });
    syncPresence(c);
    sendBuffers(c, g);
    sendScore(L);
    sendJoinCount(L);
    sendLeft(c);
    sendState(c);
    log(`[#${c.id}] guildwar enter ${g.name} team ${team} vs match ${liveKey(match)}`);
    return true;
  }

  function signGuild(c) {
    const p = c.player, g = guildOf(p);
    if (!g) { alert(c, 'Você precisa estar em uma guilda'); return; }
    if (!officer(p)) { alert(c, 'Apenas o líder ou vice pode inscrever a guilda'); return; }
    if (isSigned(g)) { alert(c, 'Sua guilda já está inscrita'); sendIcon(c); return; }
    if (!signWindowOpen() && !openNow()) {
      alert(c, 'Fora do horário de inscrição da Batalha de Guilda');
      sendIcon(c);
      return;
    }
    if ((g.offer || 0) < SIGN_FEE) {
      alert(c, `Riqueza da guilda insuficiente (precisa de ${SIGN_FEE})`);
      return;
    }
    g.offer -= SIGN_FEE;
    G.save();
    markSigned(g);
    ensureMatches();
    alert(c, `Guilda [${g.name}] inscrita na Batalha de Guilda (−${SIGN_FEE} riqueza)`);
    pushIconSite(g.site || cfg.SITE_NAME);
    log(`[#${c.id}] guildwar sign ${g.name} fee=${SIGN_FEE}`);
  }

  const tick = setInterval(() => {
    try {
      const w = openNow();
      for (const o of online.values()) if (o.player) {
        sendState(o); sendIcon(o); if (w) sendLeft(o);
      }
      if (!w) {
        for (const L of live.values()) if (!L.ended) endMatch(L, 'tempo');
        return;
      }
      const now = Date.now();
      for (const L of live.values()) {
        if (L.ended) continue;
        if (now >= L.endsAt) { endMatch(L, 'tempo'); continue; }
        // passive personal score while inside the map
        if (SOLO_EVERY > 0 && SOLO_PTS > 0 && (!L._soloAt || now - L._soloAt >= SOLO_EVERY * 1000)) {
          L._soloAt = now;
          for (const [uid, st] of L.players) {
            const o = online.get(uid);
            if (o && inField(o)) addScore(L, st.team, SOLO_PTS, uid);
          }
        }
        for (const id of L.players.keys()) {
          const o = online.get(id); if (o) sendLeft(o);
        }
        sendScore(L); sendJoinCount(L);
      }
    } catch (e) { log('guildwar tick: ' + e.message); }
  }, 10000);
  if (tick.unref) tick.unref();

  return {
    C_CONSORTIA_BATTLE_REQUEST(c, body) {
      const m = dec(c, 'C_CONSORTIA_BATTLE_REQUEST', body) || {};
      const op = m.op | 0;
      const g = guildOf(c.player);
      if (op === OP_BAO_MING) return signGuild(c);
      if (op === OP_MAIN) {
        ensureMatches();
        sendT(c, 516, 'crossguild.CrossGuildGroupBordInfoMsg', boardMsg(c.player));
        sendIcon(c);
        return;
      }
      if (op === OP_SCHEDULE) {
        ensureMatches();
        const match = matchOf(c.player);
        const red = match ? G.get(match.red) : null;
        const blue = match && match.blue ? G.get(match.blue) : null;
        const round = {
          guildInfo: { groupId: 1, redInfo: guildInfoMsg(red), blueInfo: guildInfoMsg(blue) },
          guildInfo2: { groupId: 2, redInfo: guildInfoMsg(null), blueInfo: guildInfoMsg(null) },
        };
        sendT(c, 517, 'crossguild.CrossGuildGroupScheduleInfoMsg', { groupInfo1: round, groupInfo2: round });
        return;
      }
      if (op === OP_RANK) {
        const match = matchOf(c.player);
        const L = match ? live.get(liveKey(match)) : null;
        sendT(c, 519, 'crossguild.CrossGuildRankMsg', {
          redServerName: match ? (sites.showNameOf(match.site) || cfg.SERVER_NAME) : '',
          blueServerName: match ? (sites.showNameOf(match.site) || cfg.SERVER_NAME) : '',
          redGuildScore: L ? L.redScore : 0, blueGuildScore: L ? L.blueScore : 0,
          redRankList: [], blueRankList: [], rank: 0,
        });
        return;
      }
      if (op === OP_RECORD) {
        sendT(c, 518, 'crossguild.CrossGuildReportListMsg', { op: 0, list: [] });
        return;
      }
      if (op === OP_NOTICE || op === OP_GET_NOTICE) {
        sendT(c, 528, 'crossguild.CrossGuildNoticeMsg', { notice: m.notice || (g ? (g.groupPlacard || '') : '') });
        return;
      }
      if (op === OP_PATH) {
        sendT(c, 521, 'crossguild.RoadInfoMsg', {
          roadInfo: [0, 1, 2].map(index => ({ index, peopleCount: 0, tower: -1 })),
        });
        return;
      }
      if (op === OP_ENTER) {
        // ConsortiaBattleWnd pede a cena de rotas; neste servidor o combate clássico é o mapa 7502
        if (!doEnter(c)) return;
        sendT(c, 515, 'crossguild.CrossGuildCampaignInfoMsg', {
          state: STATE_FIGHT, playerCamp: (c.player.s.guildWar || {}).team === 2 ? 1 : 0,
          roadInfo: [], playerRank: 0, startTime: Math.floor(Date.now() / 1000),
          endTime: Math.floor(Date.now() / 1000) + (openNow() ? openNow().left : 0),
          road: m.road || 0, redScore: 0, blueScore: 0, playerScore: 0,
        });
        return;
      }
      if (op === OP_LEAVE) {
        if (c.player && c.player.s.guildWar) {
          leaveMatch(c);
          if (c.player.s.campaign && c.player.s.campaign.campaignId === MAP_ID) ctx.finishCampaign(c);
        }
        return;
      }
      log(`[#${c.id}] guildwar consortia-battle op=${op} ignorado`);
    },
    C_GUILD_GROUP(c) {
      const g = guildOf(c.player);
      const site = (g && g.site) || c.player.s.site || cfg.SITE_NAME;
      ensureMatches();
      sendT(c, 4441, 'guildcampaign.GuildGroupListMsg', groupListMsg(site));
    },
    C_REQUEST_GUILDLIST(c) {
      const g = guildOf(c.player);
      const site = (g && g.site) || c.player.s.site || cfg.SITE_NAME;
      const info = G.all(site).map((x, i) => ({
        order: i + 1, id: x.id, name: x.name, count: (x.members || []).length,
        power: fightPower(x), chairmanName: (playerById(x.chairmanId) || { s: {} }).s.nickName || x.creatorName || '',
      })).sort((a, b) => b.power - a.power).map((x, i) => Object.assign(x, { order: i + 1 }));
      sendT(c, 4379, 'guildcampaign.GuildChallengeOrderListMsg', {
        info, challenge: [], guildName: g ? g.name : '', guildGrade: g ? (g.levels[1] || 1) : 0,
        guildOffer: g ? g.offer : 0, guildOrder: info.findIndex(x => g && x.id === g.id) + 1,
        guildFighPower: g ? fightPower(g) : 0,
      });
    },
    C_REQUEST_GUILDCHALLENGE(c) {
      const g = guildOf(c.player);
      sendT(c, 4377, 'guildcampaign.GuildChallengeOrderListMsg', {
        info: [], challenge: [], guildName: g ? g.name : '', guildGrade: g ? (g.levels[1] || 1) : 0,
        guildOffer: g ? (g.offer || 0) : 0, guildOrder: 0, guildFighPower: g ? fightPower(g) : 0,
      });
    },
    C_GUILDTEAM_PLAYER_EDIT(c, body) {
      const m = dec(c, 'C_GUILDTEAM_PLAYER_EDIT', body), p = c.player, g = guildOf(p);
      if (!g || !officer(p)) { alert(c, 'Permissão insuficiente'); return; }
      let r = rosterOf(g).slice();
      const uid = m.userId | 0;
      if (m.op === 1 || m.op === 0) {   // add
        if (!(g.members || []).includes(uid)) { alert(c, 'Jogador não é da guilda'); return; }
        if (!r.includes(uid) && r.length >= MAX_ROSTER) { alert(c, `Máximo de ${MAX_ROSTER} participantes`); return; }
        if (!r.includes(uid)) r.push(uid);
      } else if (m.op === 2) {   // remove
        r = r.filter(id => id !== uid);
      }
      setRoster(g, r);
      alert(c, 'Lista de participantes atualizada');
      // refresh group packet so the client sees fight membership
      sendT(c, 4441, 'guildcampaign.GuildGroupListMsg', groupListMsg(g.site));
    },
    C_OPRATE_REPLACEMENTS(c, body) {
      // OprateReplacemntMsg {op, campaignId}: campaignId carries the target userId in guild-war usage
      const m = dec(c, 'C_OPRATE_REPLACEMENTS', body);
      const p = c.player, g = guildOf(p);
      if (!g || !officer(p)) { alert(c, 'Permissão insuficiente'); return; }
      let r = rosterOf(g).slice();
      const uid = (m.campaignId || 0) | 0;
      if (!uid) { sendT(c, 4424, 'guildcampaign.GuildMsg', { param5: false }); return; }
      if (m.op === 2 || r.includes(uid)) r = r.filter(id => id !== uid);
      else {
        if (!(g.members || []).includes(uid)) { alert(c, 'Jogador não é da guilda'); return; }
        if (r.length >= MAX_ROSTER) { alert(c, `Máximo de ${MAX_ROSTER} participantes`); return; }
        r.push(uid);
      }
      setRoster(g, r);
      sendT(c, 4424, 'guildcampaign.GuildMsg', { param1: uid, param5: r.includes(uid) });
    },
    C_GUILD_BUYBUFFER(c) {
      const g = guildOf(c.player);
      if (!g) return;
      alert(c, 'Buffs de guilda ainda não disponíveis nesta versão');
      sendBuffers(c, g);
    },
    C_ENTER_GUILDCAMPAIGN(c) { doEnter(c); },
    C_PLAYER_REFAIRE(c, body) {
      const m = dec(c, 'C_PLAYER_REFAIRE', body), p = c.player;
      if (!inField(c)) { alert(c, 'Você não está na Batalha de Guilda'); return; }
      const targetId = (m.param1 || m.userId || 0) | 0;
      const tc = online.get(targetId);
      if (!tc || !inField(tc)) { alert(c, 'Jogador não está na batalha'); return; }
      if (tc === c) return;
      const mw = p.s.guildWar || {}, tw = tc.player.s.guildWar || {};
      if (mw.team && tw.team && mw.team === tw.team) { alert(c, 'Não é possível atacar aliados'); return; }
      if (c.battle || tc.battle) { alert(c, 'Jogador está em batalha'); return; }
      if ((tw.protectUntil || 0) > Date.now()) { alert(c, 'Este jogador está sob proteção'); return; }
      if ((mw.protectUntil || 0) > Date.now()) { alert(c, 'Você ainda está sob proteção'); return; }
      const L = live.get(mw.matchKey);
      if (!L || L.ended) { alert(c, 'A batalha já terminou'); return; }
      alert(tc, `${p.s.nickName} atacou você`);
      ctx.startPvp(c, tc.player, {
        battleType: BATTLE_TYPE, mapTempId: 5,
        onEnd: won => {
          const pts = won ? WIN_P : LOSE_P;
          addScore(L, mw.team, pts, p.id);
          if (L.players.has(p.id)) L.players.get(p.id).wound = (L.players.get(p.id).wound || 0) + (won ? 10 : 2);
          if (L.players.has(tc.player.id)) L.players.get(tc.player.id).wound = (L.players.get(tc.player.id).wound || 0) + (won ? 2 : 5);
          p.s.geste = (p.s.geste || 0) + pts;
          p.save();
          alert(c, won ? `Vitória! +${pts} pontos de guilda` : `Derrota. +${pts} pontos`);
          alert(tc, won ? `${p.s.nickName} venceu o combate` : `Você derrotou ${p.s.nickName}`);
          if (won) tw.protectUntil = Date.now() + 20000;
          tc.player.save();
          // wound board
          const castleWound = [...L.players.entries()].map(([userId, st]) => {
            const pl = playerById(userId);
            return { userId, nickName: pl ? pl.s.nickName : '', job: pl ? pl.s.job : 0, wound: st.wound || 0 };
          }).sort((a, b) => b.wound - a.wound).slice(0, 10);
          for (const id of L.players.keys()) {
            const o = online.get(id);
            if (o) sendT(o, 4460, 'simple.WorldBossInfoMsg', { castleWound });
          }
        },
      });
      log(`[#${c.id}] guildwar attack vs ${tc.player.id}`);
    },
  };
};
