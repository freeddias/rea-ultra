// Teams (client FreedomTeamManager / yh senders; shown in the town square and pet / mine maps). Online
// players only, kept in memory: up to 4 members (client teamIsFull), Lv20 to invite (canInviteMember).
//  C_INVITE_TEAM {param1 target} -> the target 4620 InviteTeamMsg {teamId, inviterId, inviterName}
//  C_APPLY_INVITE_TEAM {param1 inviter, param7 accepted}: a team is made around the inviter when needed;
//   the joiner (and a new captain) get 4622 TeamInfoMsg, the others 4626 with the new member list
//  C_KICK_TEAM_MEMBER {param1} (captain) -> 4630 {param1} to everyone; C_QUIT_TEAM -> 4629 {param1}; a team of
//   one is dismissed (4625); a leaving captain hands over to the next member (4627 {param1})
//  C_CHANGE_CAPTAIN {param1} -> 4627; C_EDIT_TEAM_FIGHT_POS {isGet, memberPos} -> 4628 positions
//  C_CAPTAIN_SPEAK {inviteContent}: the captain's call on world chat
// Team chat (channel 6) goes to the members (chat.js ctx.teamMembers). Team fights (several heroes in one
// battle) are not built: battle.js is one player against the server.
const MAX = 4, INVITE_GRADE = 20;

module.exports = (ctx) => {
  const { dec, sendT, online, alert, M, cfg, log } = ctx;
  const sites = require('../../sites');
  const srv = p => sites.showNameOf(p.s.site) || cfg.SERVER_NAME;
  const teams = new Map();   // teamId -> { id, captain, members: [ids], pos: [{memberId, pos}] }
  let nextId = 1;
  const teamOf = c => c.player && c.player.teamId && teams.get(c.player.teamId);
  const conns = t => t.members.map(id => online.get(id)).filter(Boolean);
  function memberMsg(t, p) {
    const a = M.mapArmy(p);
    return { playerId: p.id, heroId: p.heroId, grades: p.s.grades, nickName: p.s.nickName, sex: p.s.sex, templateId: p.s.icon, headId: p.s.icon, arm: a.arm, cloth: a.cloth,
      armyId: p.armyId, fightingCapacity: p.fightingCapacity(), onlineState: true, teamId: t.id, serverName: srv(p), hasLeftForNow: false,
      guardShowInfo: {}, ...M.showFields(p) };
  }
  const info = t => ({ teamId: t.id, captainId: t.captain, memberId: t.members.slice(), memberDetail: conns(t).map(o => memberMsg(t, o.player)) });
  const toAll = (t, code, type, msg) => { for (const o of conns(t)) sendT(o, code, type, msg); };
  ctx.teamMembers = c => { const t = teamOf(c); return t ? conns(t) : [c]; };

  function leave(c, kicked = false) {
    const t = teamOf(c); if (!t) return;
    const id = c.player.id;
    toAll(t, kicked ? 4630 : 4629, 'simple.PropertyMsg', { param1: id });
    t.members = t.members.filter(x => x !== id); c.player.teamId = null;
    if (t.members.length <= 1) {
      for (const o of conns(t)) { sendT(o, 4625, 'team.TeamInfoMsg', { teamId: t.id }); o.player.teamId = null; }
      teams.delete(t.id); return;
    }
    if (t.captain === id) { t.captain = t.members[0]; toAll(t, 4627, 'simple.PropertyMsg', { param1: t.captain }); }
    t.pos = (t.pos || []).filter(x => x.memberId !== id);
  }
  ctx.onClose(c => leave(c));

  return {
    C_INVITE_TEAM(c, body) {
      const m = dec(c, 'C_INVITE_TEAM', body), p = c.player, tc = online.get(m.param1), t = teamOf(c);
      if (p.s.grades < INVITE_GRADE) { alert(c, `Equipe libera no nível ${INVITE_GRADE}`); return; }
      if (!tc || !tc.player || tc === c) { alert(c, 'Jogador não está online'); return; }
      if (t && t.captain !== p.id) { alert(c, 'Somente o capitão pode convidar'); return; }
      if (t && t.members.length >= MAX) { alert(c, 'Equipe cheia'); return; }
      if (tc.player.teamId) { alert(c, 'Jogador já está em uma equipe'); return; }
      if (ctx.setting && ctx.setting(tc.player, 'refuseTeamInvite')) { alert(c, 'Este jogador não aceita convites de equipe'); return; }
      (c.teamInvites = c.teamInvites || new Set()).add(tc.player.id);
      sendT(tc, 4620, 'team.InviteTeamMsg', { teamId: t ? t.id : 0, inviterId: p.id, inviterName: p.s.nickName });
      alert(c, 'Convite de equipe enviado');
    },
    C_APPLY_INVITE_TEAM(c, body) {
      const m = dec(c, 'C_APPLY_INVITE_TEAM', body), p = c.player, ic = online.get(m.param1);
      if (!ic || !ic.player || !(ic.teamInvites && ic.teamInvites.has(p.id))) return;
      ic.teamInvites.delete(p.id);
      if (!m.param7) { alert(ic, `${p.s.nickName} recusou o convite de equipe`); return; }
      if (p.teamId) { alert(c, 'Você já está em uma equipe'); return; }
      let t = teamOf(ic), fresh = false;
      if (!t) { t = { id: nextId++, captain: ic.player.id, members: [ic.player.id], pos: [] }; teams.set(t.id, t); ic.player.teamId = t.id; fresh = true; }
      if (t.members.length >= MAX) { alert(c, 'Equipe cheia'); return; }
      const before = conns(t);
      t.members.push(p.id); p.teamId = t.id;
      sendT(c, 4622, 'team.TeamInfoMsg', info(t));
      for (const o of before) sendT(o, fresh ? 4622 : 4626, 'team.TeamInfoMsg', info(t));
      log(`team ${t.id}: + ${p.id} (${t.members.join(',')})`);
    },
    C_KICK_TEAM_MEMBER(c, body) {
      const m = dec(c, 'C_KICK_TEAM_MEMBER', body), t = teamOf(c), tc = online.get(m.param1);
      if (!t || t.captain !== c.player.id || !tc || !t.members.includes(m.param1) || tc === c) return;
      leave(tc, true);
    },
    C_QUIT_TEAM(c) { leave(c); },
    C_CHANGE_CAPTAIN(c, body) {
      const m = dec(c, 'C_CHANGE_CAPTAIN', body), t = teamOf(c);
      if (!t || t.captain !== c.player.id || !t.members.includes(m.param1)) return;
      t.captain = m.param1;
      toAll(t, 4627, 'simple.PropertyMsg', { param1: t.captain });
    },
    C_EDIT_TEAM_FIGHT_POS(c, body) {
      const m = dec(c, 'C_EDIT_TEAM_FIGHT_POS', body), t = teamOf(c);
      if (!t) return;
      if (m.isGet) return sendT(c, 4628, 'team.MemberFightPosListMsg', { isGet: true, memberPos: t.pos || [] });
      if (t.captain !== c.player.id) return;
      t.pos = (m.memberPos || []).filter(x => t.members.includes(x.memberId)).map(x => ({ memberId: x.memberId, pos: x.pos }));
      toAll(t, 4628, 'team.MemberFightPosListMsg', { isGet: false, memberPos: t.pos });
    },
    C_CAPTAIN_SPEAK(c, body) {
      const m = dec(c, 'C_CAPTAIN_SPEAK', body), p = c.player, text = String(m.inviteContent || '').slice(0, 100);
      if (!text.trim()) return;
      const msg = { channel: 10, type: 0, encodeMsg: text, otherId: p.id, name: p.s.nickName, headid: p.s.icon, level: p.s.grades, job: p.s.job, serverName: srv(p), curTime: Date.now() };
      for (const o of online.values()) if (o.player) sendT(o, 83, 'chat.ChatChannelMsg', msg);
    },
  };
};
