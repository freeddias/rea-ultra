// Guilds (consortia) between our players. The capture shows the official flow for one character (search,
// apply -> applyId, accepted by the chairman -> U_C_CONSORTIA_STATIC {consortiaId}, "Parabéns, [X]
// você entrou na guilda!", PASS_USER, guild-chat welcome, FRESHINFO, PlayerMsg with the guild; gold
// contribution 10,000 -> offer +10). Everything else from the client (ConsortiaManager / Ug senders /
// ConsortiaContributeWnd) and t_s_consortialevel / t_s_config:
//  create: Consortia_Grade 12, Consortia_Gold 700,000 gold   contribute: offer = gold / 1000 or diamonds / 2
//  members: 32 at Lv1, +2 per level                           wealth cap: the guild level's Property1
//  upgrades (chairman / vice): the next level's NeedOffer from the guild wealth, then its CodeTime is the
//  cooldown before the next upgrade (capture: Lv6, codeNeedDate 57600 = Lv6 CodeTime); buildings need the
//  level in PreTemplateId (Types*100 + level)
//  skills (6 power, 8 Zırh, 9 intellect, 10 captain, 11 gold, 12 physique): each member learns them with
//  personal offer (NeedOffer), up to the skill school's level, at most 10 (client ifCanUpdata, MAX_LEVEL)
//  duties: 1 chairman, 2 vice chairman, 3-4 officers, 5 member (capture: a new member is 5)
//  leaving: no new guild for 24 h unless Consortia_ClearCD_Point (50) diamonds are paid (client applyJoinConsortiaSend)
const G = require('../guilds');
const P = require('../people');
const CHAIRMAN = 1, VICE = 2, MEMBER = 5;
const NEVER = '2000-01-01 00:00:00';
// recorded duty rights (bitsets the client decodes, no player data)
const DUTY_RIGHTS = ['//9/6P//AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==', '/v996P//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
  'sL9ASAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==', 'oP5AAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
  'oP5AAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='];
const SKILL_FIELD = { 6: 'consortiaAttack', 8: 'consortiaAgility', 9: 'consortiaAbility', 10: 'consortiaCaptain', 11: 'consortiaGold', 12: 'consortiaPhysique' };
const INFO_FIELD = { 2: 'shopLevel', 3: 'altarLevel', 4: 'schoolLevel', 20: 'storeLevel' };

module.exports = (ctx) => {
  const { dec, sendT, sendPlayer, sendCastle, sendArmy, alert, online, playerById, pay, sysTime, CONF, log } = ctx;
  const CREATE_GRADE = CONF.get('Consortia_Grade') || 12, CREATE_GOLD = CONF.get('Consortia_Gold') || 700000;
  const RENAME_COST = CONF.get('Consortia_Rename') || 1000, CLEAR_CD = CONF.get('Consortia_ClearCD_Point') || 50;
  const DIAMOND_RATE = CONF.get('PointConsortiaOffer_Price') || 2;
  const today = () => sysTime().slice(0, 10);
  const mine = p => p.s.guild && G.get(p.s.guild.id) ? G.get(p.s.guild.id) : null;
  const duty = p => (p.s.guild || {}).duty || MEMBER;
  const officer = p => duty(p) <= VICE;
  const conns = g => g.members.map(id => online.get(id)).filter(Boolean);
  const toAll = (g, code, type, msg) => { for (const o of conns(g)) sendT(o, code, type, msg); };
  const ok = (c, code, extra = {}) => sendT(c, code, 'consortia.ConsortiaMsg', Object.assign({ result: true }, extra));
  const fail = (c, code, text) => { alert(c, text); sendT(c, code, 'consortia.ConsortiaMsg', { result: false }); };

  function info(g) {
    election(g);
    const school = g.levels[4] || 0;
    const fight = g.members.map(id => playerById(id)).filter(Boolean).reduce((n, m) => n + m.fightingCapacity(), 0);
    const code = g.code && Date.now() < g.code.begin + g.code.need * 1000 ? g.code : null;
    const o = { consortiaId: g.id, consortiaName: g.name, creatorId: g.creatorId, creatorName: g.creatorName, chairmanId: g.chairmanId,
      chairmanName: (playerById(g.chairmanId) || { s: {} }).s.nickName || '', levels: g.levels[1], currentCount: g.members.length,
      attackLevel: school, defenceLevel: school, agilityLevel: school, abilityLevel: school, captainLevel: school, goldLevel: school, physiqueLevel: school,
      fightPower: fight, offer: g.offer, totalOffer: g.totalOffer, placard: g.placard, description: g.description, groupPlacard: g.groupPlacard,
      openApp: g.openApp, isExist: true, createDate: sysTime(new Date(g.created)), currentDate: sysTime(), kickDate: NEVER, quitDate: NEVER,
      deductDate: sysTime(new Date(g.created)), warnDate: sysTime(new Date(g.created)), codeType: code ? code.type : 0,
      codeBeginDate: code ? sysTime(new Date(code.begin)) : NEVER, codeNeedDate: code ? code.need : 0, speakTimes: 5, orderInfo: { consortiaId: g.id },
      votingStatic: g.vote ? VOTING : 0, votingDate: g.vote ? sysTime(new Date(g.vote.since)) : NEVER, votingId: g.vote ? g.vote.id : 0,
      site: [], hiSkillList: [] };
    for (const [t, f] of Object.entries(INFO_FIELD)) o[f] = g.levels[t] || 0;
    return o;
  }
  function member(g, p) {
    const m = p.s.guild || {};
    return Object.assign(P.playerInfo(p, online.has(p.id)), { consortiaID: g.id, consortiaName: g.name, consortiaOffer: m.offer || 0, consortiaTotalOffer: m.totalOffer || 0,
      dutyId: m.duty || MEMBER, logOutTime: sysTime(new Date(p.s.lastSeen || p.s.created || Date.now())), gp: p.s.totalGp });
  }
  const fresh = g => toAll(g, 164, 'consortia.ConsortiaInfoMsg', info(g));
  const isMember = (g, id) => g.members.includes(id);

  // chairman election (ConsortiaElectionWnd, client RIt states; 4 = VOTINGING shows the impeach button): opens
  // when the chairman has been away 7 days, the 3 members with the most contribution are the candidates, every
  // member with 100+ contribution (client hasVotePermission) votes once; it ends 14 days after the chairman was
  // last seen (the client shows votingDate + 14 days) and the most voted becomes chairman. The chairman coming
  // back ends it. Day counts are our choice.
  const VOTING = 4, AWAY = 7 * 86400000, END = 14 * 86400000;
  function election(g) {
    const ch = playerById(g.chairmanId), seen = (ch && (online.has(ch.id) ? Date.now() : ch.s.lastSeen)) || Date.now();
    if (g.vote && (online.has(g.chairmanId) || seen > g.vote.since)) { g.vote = null; G.save(); }
    if (!g.vote && Date.now() - seen >= AWAY && g.members.length > 1) {
      const cands = g.members.filter(id => id !== g.chairmanId).map(id => playerById(id)).filter(Boolean)
        .sort((a, b) => ((b.s.guild || {}).totalOffer || 0) - ((a.s.guild || {}).totalOffer || 0)).slice(0, 3).map(p => p.id);
      g.vote = { id: (g.voteSeq = (g.voteSeq || 0) + 1), since: seen, cands, votes: {} };
      event(g, 4, 'Eleição de líder iniciada'); G.save();
    }
    if (g.vote && Date.now() - g.vote.since >= END) {
      const count = id => Object.values(g.vote.votes).filter(v => v === id).length;
      const win = g.vote.cands.slice().sort((a, b) => count(b) - count(a))[0];
      const w = win && playerById(win);
      if (w && isMember(g, win)) {
        const old = playerById(g.chairmanId);
        if (old && old.s.guild) { old.s.guild.duty = MEMBER; old.save(); }
        g.chairmanId = win; w.s.guild.duty = CHAIRMAN; w.save();
        event(g, 4, `${w.s.nickName} foi eleito líder`);
      }
      g.vote = null; G.save();
    }
  }
  // event log (U_C_EVENT_LIST -> 4136): the newest 50; type is our numbering (1 join, 2 leave, 3 contribution,
  // 4 upgrade), the client shows remark and date
  function event(g, type, remark) {
    const list = g.events = g.events || [];
    list.push({ id: (g.nextEventId = (g.nextEventId || 0) + 1), type, remark, date: sysTime() });
    if (list.length > 50) list.splice(0, list.length - 50);
  }
  // join / leave ----------------------------------------------------------------------------------------
  function join(g, p) {
    if (!G.sameSite(g, p)) return;
    p.s.guild = { id: g.id, duty: p.id === g.chairmanId ? CHAIRMAN : MEMBER, offer: 0, totalOffer: 0, joined: Date.now(), skills: (p.s.guild || {}).skills || {} };
    p.s.guildJoins = (p.s.guildJoins || 0) + 1;
    if (!isMember(g, p.id)) { g.members.push(p.id); event(g, 1, `${p.s.nickName} entrou na guilda`); }
    // the player's other applications / invitations on this server are over
    for (const o of G.all(p.s.site)) o.applies = o.applies.filter(a => a.userId !== p.id);
    G.save(); p.save();
    const c = online.get(p.id);
    if (c) ctx.refreshQuests(c);   // quest condition 22 "Criar ou Entrar na Guilda"
    if (c) {
      sendT(c, 117, 'consortia.ConsortiaMsg', { consortiaId: g.id });
      alert(c, `Parabéns, [${g.name}] você entrou na guilda!`);
      sendT(c, 4266, 'consortia.ConsortiaMsg', {});
      sendPlayer(c); sendArmy(c); sendCastle(c);
    }
    toAll(g, 83, 'chat.ChatChannelMsg', { channel: 5, type: 5, encodeMsg: `<a t="1" id="${p.id}" name="${p.s.nickName}" consortiaId="${g.id}" serverName="" /> bem-vindo à guilda!`, otherId: -1, userType: 1, curTime: Date.now() });
    fresh(g);
    log(`guild ${g.id} + ${p.id}`);
  }
  function leave(g, p, text) {
    g.members = g.members.filter(id => id !== p.id);
    event(g, 2, `${p.s.nickName} saiu da guilda`);
    p.s.guild = null; p.s.lastOutGuild = Date.now();
    p.save();
    const c = online.get(p.id);
    if (c) { sendT(c, 117, 'consortia.ConsortiaMsg', { consortiaId: 0 }); if (text) alert(c, text); sendPlayer(c); sendArmy(c); sendCastle(c); }
    if (!g.members.length) { G.remove(g.id); log(`guild ${g.id} dissolved`); return; }
    G.save(); fresh(g);
  }
  function cooldown(c, p, isPay) {
    if (!p.s.lastOutGuild || (p.s.guildJoins || 0) <= 1 || Date.now() - p.s.lastOutGuild >= 86400000) return true;
    if (isPay && pay(c, [[-400, CLEAR_CD]])) { sendPlayer(c); return true; }
    alert(c, 'Após sair da guilda, você não pode entrar em outra por 24 horas');
    return false;
  }
  // a guild's applicant / invitation record for the lists
  function applyInfo(g, a) {
    const t = playerById(a.userId), inviter = a.inviteId && playerById(a.inviteId);
    return { id: a.id, consortiaId: g.id, consortiaName: g.name, createDate: sysTime(new Date(g.created)), userId: a.userId, userNickname: t ? t.s.nickName : '',
      inviteId: a.inviteId || 0, inviteNickname: inviter ? inviter.s.nickName : '', chairmanNickname: (playerById(g.chairmanId) || { s: {} }).s.nickName || '',
      inviteDate: sysTime(new Date(a.at)), fromType: !!a.invite, isexist: true, consortiaLevels: g.levels[1], consortiaCount: g.members.length };
  }

  ctx.onLoad.push(c => {
    const p = c.player, g = p.s.guild && G.get(p.s.guild.id);
    if (p.s.guild && !g) { p.s.guild = null; p.save(); }   // the guild was dissolved meanwhile
    if (g) for (const o of conns(g)) if (o !== c) sendT(o, 162, 'consortia.ConsortiaMsg', { otherId: p.id });
  });
  ctx.onClose(c => {
    const p = c.player, g = p && mine(p);
    if (p) { p.s.lastSeen = Date.now(); }
    if (g) for (const o of conns(g)) if (o !== c) sendT(o, 163, 'consortia.ConsortiaMsg', { otherId: p.id });
  });
  ctx.guildOf = mine;

  return {
    U_C_CONSORTIA_CREATE(c, body) {
      const m = dec(c, 'U_C_CONSORTIA_CREATE', body), p = c.player, name = String(m.consortiaName || '').trim();
      if (mine(p)) return fail(c, 34, 'Você já está em uma guilda');
      if (p.s.grades < CREATE_GRADE) return fail(c, 34, `Personagem Lv. ${CREATE_GRADE} necessário`);
      if (name.length < 2 || name.length > 12 || /[<>"&]/.test(name)) return fail(c, 34, 'Nome de guilda inválido');
      if (G.byName(name, p.s.site)) return fail(c, 34, 'Este nome de guilda já está em uso');
      if (!cooldown(c, p, false)) return sendT(c, 34, 'consortia.ConsortiaMsg', { result: false });
      if (p.s.gold < CREATE_GOLD) return fail(c, 34, 'Ouro insuficiente');
      p.s.gold -= CREATE_GOLD;
      const g = G.create(name, p);
      event(g, 1, `${p.s.nickName} fundou a guilda`);
      ok(c, 34, { consortiaId: g.id, consortiaName: name });
      join(g, p);
    },
    U_C_CONSORTIA_SEARCH(c, body) {
      const m = dec(c, 'U_C_CONSORTIA_SEARCH', body), q = String(m.consortiaName || '').trim().toLowerCase();
      const list = G.all(c.player.s.site).filter(g => !q || g.name.toLowerCase().includes(q)).sort((a, b) => b.levels[1] - a.levels[1] || b.offer - a.offer);
      const page = Math.max(1, m.pageIndex || 1), per = 10;
      sendT(c, 4139, 'consortia.ConsortiaSearchRspMsg', { consortiaInfo: list.slice((page - 1) * per, page * per).map(info), totalRows: list.length, isReset: !!m.isNewOpen });
    },
    U_C_CONSORTIA_INFO(c, body) {
      const m = dec(c, 'U_C_CONSORTIA_INFO', body), p = c.player;
      const asked = G.get(m.consortiaId), g = (asked && G.sameSite(asked, p) ? asked : null) || mine(p);
      if (g) sendT(c, 4138, 'consortia.ConsortiaInfoMsg', info(g));
    },
    U_C_CONSORTIAUSER_LIST(c) {
      const g = mine(c.player); if (!g) return;
      const list = g.members.map(id => playerById(id)).filter(Boolean).map(p => member(g, p));
      sendT(c, 4133, 'simple.SimplePlayerListRspMsg', { playerInfo: list, totalRows: list.length, uuid: `${g.id}-${Date.now()}` });
    },
    U_C_DUTY_LIST(c) {
      sendT(c, 4137, 'consortia.ConsortiaDutyListRspMsg', { dutyInfo: DUTY_RIGHTS.map((r, i) => ({ levels: i + 1, rights: Buffer.from(r, 'base64') })) });
    },
    C_CONSORTIA_BOX_CHECK(c) { const g = mine(c.player); sendT(c, 4466, 'consortia.ConsortiaStorageInfoMsg', { storageInfo: g ? [{ consortiaId: g.id }] : [] }); },

    // applications: player -> guild
    U_C_CONSORTIA_USERINVITE(c, body) {
      const m = dec(c, 'U_C_CONSORTIA_USERINVITE', body), p = c.player, g = G.get(m.consortiaId);
      if (mine(p)) return fail(c, 35, 'Você já está em uma guilda');
      if (!g || !G.sameSite(g, p)) return fail(c, 35, 'Guilda não encontrada');
      if (!g.openApp) return fail(c, 35, 'Esta guilda não está aceitando pedidos no momento');
      if (g.members.length >= G.maxMembers(g)) return fail(c, 35, 'Guilda cheia');
      if (!cooldown(c, p, m.isPay)) return sendT(c, 35, 'consortia.ConsortiaMsg', {});
      let a = g.applies.find(x => x.userId === p.id && !x.invite);
      if (!a) { a = { id: G.nextApplyId(), userId: p.id, at: Date.now() }; g.applies.push(a); G.save(); }
      sendT(c, 35, 'consortia.ConsortiaMsg', { applyId: a.id });
    },
    // my applications and the invitations I got
    U_C_INVITEINFO_LIST(c) {
      const p = c.player, out = [];
      for (const g of G.all(p.s.site)) for (const a of g.applies) if (a.userId === p.id) out.push(applyInfo(g, a));
      sendT(c, 4135, 'consortia.ConsortiaUserInviteInfoListRspMsg', { inviteInfo: out });
    },
    U_C_CONSORTIA_INVITEDEL(c, body) {
      const m = dec(c, 'U_C_CONSORTIA_INVITEDEL', body), p = c.player;
      for (const g of G.all(p.s.site)) g.applies = g.applies.filter(a => !(a.id === m.applyId && a.userId === p.id));
      G.save();
      ok(c, 36, { applyId: m.applyId });
    },
    // the guild's applicants (officers): parameter1 carries the applyId (client consortiaAcceptOrRejectApply)
    U_C_CONSORTIA_INVITE_LIST(c) {
      const g = mine(c.player); if (!g) return;
      const list = g.applies.filter(a => !a.invite).map(a => { const t = playerById(a.userId); return t && Object.assign(P.playerInfo(t, online.has(t.id)), { parameter1: a.id }); }).filter(Boolean);
      sendT(c, 4140, 'simple.SimplePlayerListRspMsg', { playerInfo: list, totalRows: list.length });
    },
    U_C_CONSORTIA_PASS(c, body) {
      const m = dec(c, 'U_C_CONSORTIA_PASS', body), g = mine(c.player);
      if (!g || !officer(c.player)) return fail(c, 40, 'Permissão insuficiente');
      const a = g.applies.find(x => x.id === m.applyId && !x.invite);
      if (!a) return fail(c, 40, 'Pedido não encontrado');
      g.applies = g.applies.filter(x => x !== a); G.save();
      const t = playerById(a.userId);
      if (m.result && t && !mine(t)) {
        if (g.members.length >= G.maxMembers(g)) return fail(c, 40, 'Guilda cheia');
        ok(c, 40, { applyId: a.id });
        join(g, t);
      } else ok(c, 40, { applyId: a.id, result: !!m.result });
    },
    // invitations: guild officer -> player (the player answers with U_C_CONSORTIA_USERPASS)
    U_C_CONSORTIA_INVITE(c, body) {
      const m = dec(c, 'U_C_CONSORTIA_INVITE', body), g = mine(c.player), t = playerById(m.otherId);
      if (!g || !officer(c.player)) return fail(c, 41, 'Permissão insuficiente');
      if (!t || mine(t) || !G.sameSite(g, t)) return fail(c, 41, 'Este jogador não pode ser convidado');
      if (t.s.refuseGuildInvite) return fail(c, 41, 'Este jogador não aceita convites');
      let a = g.applies.find(x => x.userId === t.id && x.invite);
      if (!a) { a = { id: G.nextApplyId(), userId: t.id, invite: true, inviteId: c.player.id, at: Date.now() }; g.applies.push(a); G.save(); }
      ok(c, 41);
      const tc = online.get(t.id);
      if (tc) sendT(tc, 41, 'consortia.ConsortiaMsg', { applyId: a.id, consortiaId: g.id, consortiaName: g.name });
    },
    U_C_CONSORTIA_USERPASS(c, body) {
      const m = dec(c, 'U_C_CONSORTIA_USERPASS', body), p = c.player;
      const g = G.all(p.s.site).find(x => x.applies.some(a => a.id === m.applyId && a.userId === p.id && a.invite));
      if (!g) return fail(c, 37, 'Convite não encontrado');
      g.applies = g.applies.filter(a => a.id !== m.applyId); G.save();
      if (!m.result) return ok(c, 37, { applyId: m.applyId, result: false });
      if (mine(p)) return fail(c, 37, 'Você já está em uma guilda');
      if (g.members.length >= G.maxMembers(g)) return fail(c, 37, 'Guilda cheia');
      if (!cooldown(c, p, false)) return sendT(c, 37, 'consortia.ConsortiaMsg', {});
      ok(c, 37, { applyId: m.applyId });
      join(g, p);
    },
    U_C_CONSORTIA_OPENAPP(c, body) {
      const m = dec(c, 'U_C_CONSORTIA_OPENAPP', body), g = mine(c.player);
      if (!g || !officer(c.player)) return fail(c, 51, 'Permissão insuficiente');
      g.openApp = !!m.result; G.save(); ok(c, 51); fresh(g);
    },

    // members -------------------------------------------------------------------------------------------
    U_C_CONSORTIA_QUIT(c) {
      const p = c.player, g = mine(p); if (!g) return;
      if (p.id === g.chairmanId && g.members.length > 1) { alert(c, 'Transfira a liderança primeiro'); return; }
      leave(g, p, 'Você saiu da guilda');
    },
    U_C_CONSORTIA_DELUSER(c, body) {
      const m = dec(c, 'U_C_CONSORTIA_DELUSER', body), p = c.player, g = mine(p), t = playerById(m.otherId);
      if (!g || !officer(p) || !t || !isMember(g, t.id) || t.id === p.id || duty(t) <= duty(p)) { alert(c, 'Permissão insuficiente'); return; }
      leave(g, t, `Você foi expulso da guilda [${g.name}]`);
    },
    U_C_CONSORTIA_DUTYUPDATE(c, body) {
      const m = dec(c, 'U_C_CONSORTIA_DUTYUPDATE', body), p = c.player, g = mine(p), t = playerById(m.otherId);
      const pos = m.positionId;
      if (!g || !t || !isMember(g, t.id) || t.id === p.id || pos <= duty(p) || duty(t) <= duty(p) || pos < VICE || pos > MEMBER) return fail(c, 50, 'Permissão insuficiente');
      if (pos === VICE && g.members.filter(id => duty(playerById(id) || { s: {} }) === VICE).length >= 2) return fail(c, 50, 'No máximo 2 vice-líderes');
      t.s.guild.duty = pos; t.save();
      toAll(g, 50, 'consortia.ConsortiaMsg', { otherId: t.id, positionId: pos, result: true });
    },
    // cool the guild building down (client btnQuickCoolClick): ConsortiaQuic_Price (2) diamonds per started
    // 10 minutes left; sendQuickTime(useBind): payType 0 bound first, 1 diamonds; officers only
    C_CONSORTIA_QUICK(c, body) {
      const m = dec(c, 'C_CONSORTIA_QUICK', body), p = c.player, g = mine(p);
      if (!g || !officer(p)) return alert(c, 'Permissão insuficiente');
      const left = g.code ? Math.ceil((g.code.begin + g.code.need * 1000 - Date.now()) / 1000) : 0;
      if (left <= 0) { g.code = null; return fresh(g); }
      const price = (CONF.get('ConsortiaQuic_Price') || 2) * Math.ceil(left / 600), bound = m.payType === 0 && ctx.balance(p, -500) >= price;
      if (!pay(c, [[bound ? -500 : -400, price]])) return alert(c, 'Diamantes insuficientes');
      g.code = null; G.save();
      fresh(g);
      alert(c, 'Edifício da guilda acelerado');
    },
    C_CONSORTIA_VOTING_LIST(c) {
      const g = mine(c.player); if (!g) return;
      election(g);
      const v = g.vote, n = id => v ? Object.values(v.votes).filter(x => x === id).length : 0;
      const info = v ? g.members.map(id => playerById(id)).filter(Boolean).map(p => ({ userId: p.id, nickName: p.s.nickName, votingId: v.id,
        isVotingman: v.cands.includes(p.id), votingTime: v.votes[p.id] ? 1 : 0, votingData: n(p.id) })) : [];
      sendT(c, 4389, 'consortia.ConsortiaVotingUsersMsg', { info });
    },
    C_CONSORTIA_VOTING(c, body) {
      const m = dec(c, 'C_CONSORTIA_VOTING', body), p = c.player, g = mine(p);
      const no = text => { if (text) alert(c, text); sendT(c, 4390, 'consortia.ConsortiaVotingRspMsg', { result: false }); };
      if (!g) return no();
      election(g);
      const v = g.vote;
      if (!v) return no('Não há eleição em andamento');
      if (((p.s.guild.totalOffer || 0) < 100) && ((p.s.guild.offer || 0) < 100)) return no('É necessário pelo menos 100 de contribuição da guilda para votar');
      if (v.votes[p.id]) return no('Você já votou');
      if (!v.cands.includes(m.votingUser)) return no('Candidato inválido');
      v.votes[p.id] = m.votingUser; G.save();
      sendT(c, 4390, 'consortia.ConsortiaVotingRspMsg', { result: true });
    },
    U_C_CONSORTIA_CHANGE(c, body) {
      const m = dec(c, 'U_C_CONSORTIA_CHANGE', body), p = c.player, g = mine(p), t = playerById(m.otherId);
      if (!g || p.id !== g.chairmanId || !t || !isMember(g, t.id) || t.id === p.id) return fail(c, 47, 'Permissão insuficiente');
      g.chairmanId = t.id; t.s.guild.duty = CHAIRMAN; p.s.guild.duty = MEMBER;
      G.save(); t.save(); p.save();
      ok(c, 47);
      toAll(g, 50, 'consortia.ConsortiaMsg', { otherId: t.id, positionId: CHAIRMAN, result: true });
      toAll(g, 50, 'consortia.ConsortiaMsg', { otherId: p.id, positionId: MEMBER, result: true });
      fresh(g);
    },
    U_C_CONSORTIA_MODIFYBBS(c, body) { edit(c, body, 'U_C_CONSORTIA_MODIFYBBS', 38, 'placard', 200); },
    U_C_CONSORTIA_MODIFYDESC(c, body) { edit(c, body, 'U_C_CONSORTIA_MODIFYDESC', 39, 'description', 200); },
    U_C_CONSORTIA_GROUP_PLACARD(c, body) { edit(c, body, 'U_C_CONSORTIA_GROUP_PLACARD', 38, 'groupPlacard', 200); },
    U_C_CONSORTIA_RENAME(c, body) {
      const m = dec(c, 'U_C_CONSORTIA_RENAME', body), p = c.player, g = mine(p), name = String(m.newName || '').trim();
      const reply = r => sendT(c, 49, 'consortia.ConsortiaRenameRspMsg', { result: r });
      if (!g || p.id !== g.chairmanId) { alert(c, 'Permissão insuficiente'); return reply(false); }
      if (name.length < 2 || name.length > 12 || /[<>"&]/.test(name) || G.byName(name, g.site, g.id)) { alert(c, 'Este nome de guilda não pode ser usado'); return reply(false); }
      if (!pay(c, [[m.payType === 0 ? -500 : -400, RENAME_COST]])) { alert(c, 'Diamantes insuficientes'); return reply(false); }
      g.name = name; G.save(); sendPlayer(c); reply(true); fresh(g);
    },

    // wealth, levels, skills ----------------------------------------------------------------------------
    U_C_CONSORTIA_OFF(c, body) {
      const m = dec(c, 'U_C_CONSORTIA_OFF', body), p = c.player, g = mine(p);
      if (!g) return fail(c, 42, 'Você não é membro de uma guilda');
      const gold = Math.floor((m.offerGold || 0) / 1000) * 1000, point = m.offerPoint || 0;
      let add = 0;
      if (gold > 0) {
        if (p.s.gold < gold) return fail(c, 42, 'Ouro insuficiente');
        p.s.gold -= gold; add += gold / 1000;
      }
      if (point > 0) {
        if (point < DIAMOND_RATE) return fail(c, 42, `Mínimo de ${DIAMOND_RATE} diamantes`);
        if (!pay(c, [[-400, point]])) return fail(c, 42, 'Diamantes insuficientes');
        add += Math.floor(point / DIAMOND_RATE);
      }
      if (add <= 0) return fail(c, 42, 'Quantidade de contribuição inválida');
      g.offer = Math.min(G.wealthCap(g), g.offer + add); g.totalOffer += add;
      const k = g.contrib[p.id] = g.contrib[p.id] || { total: 0, today: 0, day: today() };
      if (k.day !== today()) { k.day = today(); k.today = 0; }
      k.total += add; k.today += add;
      event(g, 3, `${p.s.nickName} contribuiu ${add}`);
      p.s.guild.offer = (p.s.guild.offer || 0) + add; p.s.guild.totalOffer = (p.s.guild.totalOffer || 0) + add;
      G.save(); p.save();
      ctx.stat(c, 'guildOffer', add);
      sendCastle(c); sendPlayer(c);
      alert(c, 'Contribuição realizada com sucesso!');
      ok(c, 42);
      fresh(g);
    },
    U_C_CONSORTIA_OFFER_LIST(c, body) {
      const m = dec(c, 'U_C_CONSORTIA_OFFER_LIST', body), p = c.player, g = mine(p); if (!g) return;
      const rows = Object.entries(g.contrib).map(([id, k]) => {
        const t = playerById(Number(id));
        return { nickName: t ? t.s.nickName : '', totalOffer: k.total, todayOffer: k.day === today() ? k.today : 0, userId: Number(id) };
      }).filter(r => r.nickName).sort((a, b) => m.isHistory ? b.totalOffer - a.totalOffer : b.todayOffer - a.todayOffer || b.totalOffer - a.totalOffer);
      const self = rows.find(r => r.userId === p.id) || { nickName: p.s.nickName, totalOffer: 0, todayOffer: 0 };
      const page = Math.max(1, m.pageIndex || 1), per = 10;
      sendT(c, 4134, 'consortia.ConsortiaContributeRspMsg', { contributeInfo: rows.slice((page - 1) * per, page * per).map(({ userId, ...r }) => r), selfInfo: { nickName: self.nickName, totalOffer: self.totalOffer, todayOffer: self.todayOffer },
        totalRows: rows.length, selfOrder: rows.indexOf(self) + 1 });
    },
    U_C_EVENT_LIST(c) {
      const g = mine(c.player); if (!g) return;
      sendT(c, 4136, 'consortia.ConsortiaEventListRspMsg', { eventInfo: (g.events || []).map(e => ({ id: e.id, consortiaId: g.id, remark: e.remark, createDate: e.date, type: e.type, isExist: true })) });
    },
    // a guild link in chat (client consortiaLink {consortiaId}) -> 4267 its card
    C_CONSORTIA_LINK(c, body) {
      const m = dec(c, 'C_CONSORTIA_LINK', body), g = G.get(m.consortiaId);
      if (!g || !G.sameSite(g, c.player)) { alert(c, 'Guilda não encontrada'); return; }
      sendT(c, 4267, 'consortia.ConsortiaLinkRspMsg', { consortiaId: g.id, consortiaName: g.name, creatorName: (playerById(g.chairmanId) || { s: {} }).s.nickName || g.creatorName,
        levels: g.levels[1], Offer: g.offer, currentCount: g.members.length, honor: 0, description: g.description || '', materials: 0 });
    },
    // recruitment call (RecruitMemberFrame, officers): to world chat with the guild link (chat tag t 7 =
    // uK.CONSORTIA, attribute consortiaId); ConsortiaInfo
    // speakTimes (5) a day
    C_CONSORTIA_SPEAK(c, body) {
      const m = dec(c, 'C_CONSORTIA_SPEAK', body), p = c.player, g = mine(p);
      if (!g || !officer(p)) { alert(c, 'Permissão insuficiente'); return; }
      const d = today(); if (g.speakDay !== d) { g.speakDay = d; g.speakUsed = 0; }
      if (g.speakUsed >= 5) { alert(c, 'Suas buscas de membros de hoje acabaram'); return; }
      g.speakUsed++; G.save();
      const text = String(m.speak || '').slice(0, 100) || 'Procuramos membros, juntem-se!';
      const msg = { channel: 10, type: 5, encodeMsg: `<a t="7" consortiaId="${g.id}" name="${g.name}" /> ${text}`, otherId: p.id, name: p.s.nickName, headid: p.s.icon, level: p.s.grades, job: p.s.job, curTime: Date.now() };
      for (const o of online.values()) if (o.player) sendT(o, 83, 'chat.ChatChannelMsg', msg);
      alert(c, 'Mensagem de recrutamento enviada');
    },
    U_C_CONSORTIA_LEVEL(c, body) {
      const m = dec(c, 'U_C_CONSORTIA_LEVEL', body), p = c.player, g = mine(p), type = m.upgradeType;
      if (!g || !officer(p)) return fail(c, 43, 'Permissão insuficiente');
      if (!G.BUILDINGS.includes(type)) return fail(c, 43, 'Melhoria inválida');
      const cur = g.levels[type] || 0, next = G.level(type, cur + 1);
      if (!next) return fail(c, 43, 'Já está no nível máximo');
      if (g.code && Date.now() < g.code.begin + g.code.need * 1000) return fail(c, 43, 'Edifício da guilda ainda está evoluindo');
      if (next.PreTemplateId) {
        const need = Math.floor(next.PreTemplateId / 100), lv = next.PreTemplateId % 100;
        if ((g.levels[need] || 0) < lv) { const t = G.level(need, lv); return fail(c, 43, `${ctx.nameOf(t, 'LevelName') || 'Guilda'} Lv. ${lv} necessário`); }
      }
      if (g.offer < next.NeedOffer) return fail(c, 43, 'Riqueza da guilda insuficiente');
      g.offer -= next.NeedOffer;
      g.levels[type] = cur + 1;
      event(g, 4, `${ctx.nameOf(next, 'LevelName') || 'Guilda'} Lv. ${cur + 1} concluído`);
      g.code = next.CodeTime ? { type, begin: Date.now(), need: next.CodeTime } : null;
      G.save();
      ok(c, 43, { upgradeType: type });
      fresh(g);
      log(`guild ${g.id} type ${type} -> ${cur + 1}`);
    },
    U_C_CONSORTIA_LEARN(c, body) {
      const m = dec(c, 'U_C_CONSORTIA_LEARN', body), p = c.player, g = mine(p), type = m.studySkill;
      if (!g || !G.SKILLS.includes(type)) return fail(c, 48, 'Habilidade inválida');
      const sk = p.s.guild.skills = p.s.guild.skills || {}, cur = sk[type] || 0, next = G.level(type, cur + 1);
      if (!next || cur >= G.MAX_SKILL) return fail(c, 48, 'Já está no nível máximo');
      if (cur + 1 > (g.levels[4] || 0)) return fail(c, 48, `Instituto de Habilidades Lv. ${cur + 1} necessário`);
      if ((p.s.guild.offer || 0) < next.NeedOffer) return fail(c, 48, 'Pontos de contribuição insuficientes');
      p.s.guild.offer -= next.NeedOffer;
      sk[type] = cur + 1;
      p.save();
      ok(c, 48, { studySkill: type });
      sendPlayer(c); sendArmy(c); sendCastle(c);
    },
    // guild tasks: the recorded copy showed the official guild's members; no tasks here yet
    // C_CONSORTIA_TASK_INFO: features/guildtask.js
    U_C_CONSORTIA_ROBOTJOIN() {},   // the official "auto guild" for newcomers does not exist here
  };

  function edit(c, body, name, code, field, max) {
    const m = dec(c, name, body), g = mine(c.player);
    if (!g || !officer(c.player)) return fail(c, code, 'Permissão insuficiente');
    g[field] = String(m[field] || '').slice(0, max); G.save();
    ok(c, code); fresh(g);
  }
};

module.exports.SKILL_FIELD = SKILL_FIELD;
