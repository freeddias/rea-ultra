// Friends, blacklist, friend groups, friend requests and private chat between our own players.
// Formats from the official capture where they occur (CH_BATCHADD_RELATIONSHIP -> 78 FriendInfoMsg per
// player, relation 3 on a one-sided add; U_CH_FRIEND_UPDATE 165 relation 1 / tarRelation 1 once both sides
// added each other; 160 / 161 friend login / logout; 4231 private message), the rest from the client
// handlers (FriendManager: __addFriend, __removeFriend, __friendAddHandler, __addFriendConfirmHandler,
// __loadFriendListHandler, IM __receiveIMMsgHandler / __imSendMsgResponseHandler).
// Relations (client qr): 1 friend, 2 blacklist, 3 stranger (one-sided). Kept per player in s.relations
// {id: {relation, groupId}}; pending requests in s.friendReqs; private messages to offline players in
// s.offlineMsgs, delivered at the next login.
const P = require('../people');
const FRIEND = 1, BLACK = 2, STRANGER = 3;
const MAX_FRIENDS = 200, MAX_MSG = 300, MSG_GAP_MS = 1000, MAX_OFFLINE = 50;

module.exports = (ctx) => {
  const { dec, sendT, sendN, online, playerById, alert, sysTime, log } = ctx;
  const rels = p => (p.s.relations = p.s.relations || {});
  const relOf = (a, b) => rels(a)[b.id] || null;
  const conn = id => online.get(id);
  const isOn = id => online.has(id);
  const byName = name => {
    const n = String(name || '').trim().toLowerCase(); if (!n) return null;
    for (const c of online.values()) if (c.player && c.player.s.nickName.toLowerCase() === n) return c.player;
    const a = Object.values(ctx.db.state.accounts).find(x => x.char && String(x.char.nickName).toLowerCase() === n);
    return a ? playerById(a.userId) : null;
  };
  const info = (me, t) => P.friendInfo(t, isOn(t.id), Object.assign({}, relOf(me, t), { tarRelation: (relOf(t, me) || {}).relation || 0 }));
  const saveBoth = (a, b) => { a.save(); b.save(); };

  function add(c, t, relation) {
    const p = c.player;
    const fail = msg => sendT(c, 78, 'simple.FriendInfoMsg', { userId: t ? t.id : 0, result: false, addMsg: msg });
    if (!t) return fail('Jogador não encontrado');
    if (t.id === p.id) return fail('Kendini ekleyemezsin');
    const mine = relOf(p, t);
    if (relation === BLACK) {
      rels(p)[t.id] = { relation: BLACK, groupId: -1 };
      p.save();
      return sendT(c, 78, 'simple.FriendInfoMsg', Object.assign(info(p, t), { addMsg: 'success' }));
    }
    if (mine && mine.relation === FRIEND) return fail('Vocês já são amigos');
    if (Object.values(rels(p)).filter(r => r.relation === FRIEND).length >= MAX_FRIENDS) return fail('Lista de amigos cheia');
    const theirs = relOf(t, p);
    if (theirs && theirs.relation === BLACK) return fail('Este jogador bloqueou você');
    if (relation === FRIEND && !theirs && ctx.setting && ctx.setting(t, 'refuseFriend')) return fail('Este jogador não aceita pedidos de amizade');   // settings (playerops.js)
    if (theirs && (theirs.relation === FRIEND || theirs.relation === STRANGER)) {
      // both sides added each other: friends (capture: U_CH_FRIEND_UPDATE relation 1, tarRelation 1)
      rels(p)[t.id] = { relation: FRIEND, groupId: (mine && mine.groupId) ?? -1 };
      theirs.relation = FRIEND;
      saveBoth(p, t);
      sendT(c, 78, 'simple.FriendInfoMsg', Object.assign(info(p, t), { addMsg: 'success' }));
      const tc = conn(t.id);
      if (tc) sendT(tc, 165, 'simple.FriendInfoMsg', { userId: p.id, relation: FRIEND, relationGrade: 1, groupId: theirs.groupId ?? -1, tarRelation: FRIEND });
      ctx.refreshQuests(c); if (tc) ctx.refreshQuests(tc);   // quest condition 21 "Adicionar Amigo"
      return;
    }
    // one-sided: a stranger for us (capture: relation 3), a friend request for them
    rels(p)[t.id] = { relation: STRANGER, groupId: -1 };
    const req = { reqId: `${p.id}-${Date.now()}`, userId: p.id, nickName: p.s.nickName, grades: p.s.grades, sex: p.s.sex, job: p.s.job };
    t.s.friendReqs = (t.s.friendReqs || []).filter(r => r.userId !== p.id).concat(req).slice(-50);
    saveBoth(p, t);
    sendT(c, 78, 'simple.FriendInfoMsg', Object.assign(info(p, t), { addMsg: 'success' }));
    const tc = conn(t.id);
    if (tc) sendT(tc, 4246, 'friend.FriendAddedMsg', req);
  }

  function friendList(p) {
    const relationList = [];
    for (const [id, r] of Object.entries(rels(p))) {
      const t = playerById(Number(id)); if (!t) continue;
      relationList.push({ player: P.playerInfo(t, isOn(t.id)), snsInfo: P.snsInfo(t), relation: r.relation, groupId: r.groupId ?? -1, friendGrade: 1,
        tarRelation: (relOf(t, p) || {}).relation || 0 });
    }
    return { relationList, group: (p.s.friendGroups || []).map(g => ({ groupId: g.groupId, groupName: g.groupName })), maxPage: 1, curPage: 1 };
  }
  // players who list p (friend or stranger) and are online
  const watchers = p => [...online.values()].filter(o => o.player && o.player.id !== p.id && [FRIEND, STRANGER].includes((relOf(o.player, p) || {}).relation));

  ctx.onLoad.push(c => {
    const p = c.player;
    sendT(c, 4156, 'simple.FriendRelationList', friendList(p));   // replaces the recorded (empty) list, NATIVE 4156
    for (const m of p.s.offlineMsgs || []) sendT(c, 4231, 'chat.ChatFriendMsg', m);
    if ((p.s.offlineMsgs || []).length) { p.s.offlineMsgs = []; p.save(); }
    for (const o of watchers(p)) sendT(o, 160, 'friend.FriendRelationMsg', { otherId: p.id });
  });
  ctx.onClose(c => { if (c.player) for (const o of watchers(c.player)) sendT(o, 161, 'friend.FriendRelationMsg', { otherId: c.player.id }); });

  return {
    U_CH_ADD_RELATIONSHIP(c, body) { const m = dec(c, 'U_CH_ADD_RELATIONSHIP', body); add(c, byName(m.nickName), m.relation || FRIEND); },
    CH_BATCHADD_RELATIONSHIP(c, body) {
      const m = dec(c, 'CH_BATCHADD_RELATIONSHIP', body);
      for (const id of (m.otherId || []).slice(0, 20)) add(c, playerById(id), m.relation || FRIEND);
    },
    // "ask them to add me": the client shows the requester's name with a confirm window (client __addFriendConfirmHandler)
    U_CH_FRIENDADD_CONFIRM(c, body) {
      const m = dec(c, 'U_CH_FRIENDADD_CONFIRM', body), t = byName(m.nickName), tc = t && conn(t.id);
      if (!tc) { alert(c, 'Jogador não está online'); return; }
      sendT(tc, 84, 'friend.FriendRelationMsg', { otherId: c.player.id, nickName: c.player.s.nickName, relation: FRIEND, noticeMsg: '', result: true });
    },
    U_CH_REMOVE_RELATIONSHIP(c, body) {
      const m = dec(c, 'U_CH_REMOVE_RELATIONSHIP', body), p = c.player, t = playerById(m.otherId);
      if (!rels(p)[m.otherId]) return sendT(c, 79, 'friend.FriendRelationMsg', { otherId: m.otherId, result: false });
      const was = rels(p)[m.otherId].relation;
      delete rels(p)[m.otherId];
      p.save();
      sendT(c, 79, 'friend.FriendRelationMsg', { otherId: m.otherId, result: true });
      const theirs = t && relOf(t, p);
      if (was === FRIEND && theirs && theirs.relation === FRIEND) {
        theirs.relation = STRANGER; t.save();
        const tc = conn(t.id);
        if (tc) sendT(tc, 165, 'simple.FriendInfoMsg', { userId: p.id, relation: STRANGER, groupId: theirs.groupId ?? -1, tarRelation: 0 });
      }
    },
    // friend requests: op 2 list (capture: sent at login), 0 drop one, 1 drop all
    CH_FRIEND_REQMSG_ACT(c, body) {
      const m = dec(c, 'CH_FRIEND_REQMSG_ACT', body), p = c.player;
      if (m.op === 2) return sendT(c, 4712, 'friend.FriendAddMsgList', { list: p.s.friendReqs || [] });
      p.s.friendReqs = m.op === 0 ? (p.s.friendReqs || []).filter(r => r.reqId !== m.reqId) : [];
      p.save();
      sendT(c, 4713, 'friend.FriendAddedMsgAct', { op: m.op, reqId: m.reqId || '' });
    },
    CH_FRIEND_SEARCH_NICKNAME(c, body) {
      const m = dec(c, 'CH_FRIEND_SEARCH_NICKNAME', body), q = String(m.nickName || '').trim().toLowerCase();
      if (!q) return sendT(c, 4274, 'friend.FriendSearchNickNameRspMsg', { list: [] });
      const ids = new Set([...Object.values(ctx.db.state.accounts).filter(a => a.char && String(a.char.nickName).toLowerCase().includes(q)).map(a => a.userId),
        ...[...online.values()].filter(o => o.player && o.player.s.nickName.toLowerCase().includes(q)).map(o => o.player.id)]);
      const list = [...ids].filter(id => id !== c.player.id).slice(0, 20).map(id => playerById(id)).filter(Boolean)
        .map(t => ({ playerId: t.id, nickName: t.s.nickName, level: t.s.grades, sex: t.s.sex, attack: t.fightingCapacity(), mapName: '', headId: t.s.icon, job: t.s.job }));
      sendT(c, 4274, 'friend.FriendSearchNickNameRspMsg', { list });
    },
    // search by SNS profile (birthday, star sign, city ...): profiles are not kept, nothing matches
    CH_FRIEND_SEARCH(c) { sendT(c, 4273, 'simple.FriendSearchRspMsg', { totalRows: 0, snsInfo: [] }); },
    CH_INBLACK_LIST(c, body) {
      const m = dec(c, 'CH_INBLACK_LIST', body), t = playerById(m.otherId);
      sendT(c, 447, 'chat.IsInBlackListMsg', { otherId: m.otherId, isInBlackList: !!(t && (relOf(t, c.player) || {}).relation === BLACK) });
    },

    // ---- groups ----
    CH_ADD_GROUP(c, body) {
      const m = dec(c, 'CH_ADD_GROUP', body), p = c.player, g = p.s.friendGroups = p.s.friendGroups || [];
      const name = String(m.groupName || '').trim().slice(0, 12);
      if (!name || g.length >= 10) return sendT(c, 4227, 'simple.FriendGroupMsg', { result: 0 });
      const groupId = g.reduce((n, x) => Math.max(n, x.groupId), 0) + 1;
      g.push({ groupId, groupName: name }); p.save();
      sendT(c, 4227, 'simple.FriendGroupMsg', { groupId, groupName: name, result: 1 });
    },
    CH_DEL_GROUP(c, body) {
      const m = dec(c, 'CH_DEL_GROUP', body), p = c.player;
      p.s.friendGroups = (p.s.friendGroups || []).filter(g => g.groupId !== m.groupId);
      for (const r of Object.values(rels(p))) if (r.groupId === m.groupId) r.groupId = -1;
      p.save();
      sendT(c, 4228, 'simple.FriendGroupMsg', { groupId: m.groupId, result: 1 });
    },
    CH_RENAME_GROUP(c, body) {
      const m = dec(c, 'CH_RENAME_GROUP', body), p = c.player, g = (p.s.friendGroups || []).find(x => x.groupId === m.groupId);
      const name = String(m.groupName || '').trim().slice(0, 12);
      if (!g || !name) return sendT(c, 4229, 'simple.FriendGroupMsg', { groupId: m.groupId, result: 0 });
      g.groupName = name; p.save();
      sendT(c, 4229, 'simple.FriendGroupMsg', { groupId: g.groupId, groupName: name, result: 1 });
    },
    CH_FRIEND_MOVE(c, body) {
      const m = dec(c, 'CH_FRIEND_MOVE', body), p = c.player, r = rels(p)[m.firendId];
      const ok = r && (m.groupId === -1 || (p.s.friendGroups || []).some(g => g.groupId === m.groupId));
      if (ok) { r.groupId = m.groupId; p.save(); }
      sendT(c, 4230, 'friend.MoveFriendReqMsg', { firendId: m.firendId, groupId: m.groupId, result: ok ? 1 : 0 });
    },

    // ---- private chat ----
    CH_PRIVATE_CHAT(c, body) {
      const m = dec(c, 'CH_PRIVATE_CHAT', body), p = c.player, t = playerById(m.toId);
      const text = String(m.encodeMsg || '').slice(0, MAX_MSG);
      const now = Date.now();
      if (!t || !text.trim() || t.id === p.id) return;
      if (now - (c.lastPm || 0) < MSG_GAP_MS) { alert(c, 'Você está enviando mensagens rápido demais'); return; }
      c.lastPm = now;
      const msg = { fromId: p.id, fromNick: p.s.nickName, toId: t.id, encodeMsg: text, sendDate: sysTime(), job: p.s.job, headid: p.s.icon, level: p.s.grades, fight: p.fightingCapacity(), result: 0 };
      // blocked by the receiver: the client's "could not be sent" (result -1)
      if ((relOf(t, p) || {}).relation === BLACK) return sendT(c, 4236, 'chat.ChatFriendMsg', Object.assign(msg, { result: -1 }));
      const tc = conn(t.id);
      if (tc) sendT(tc, 4231, 'chat.ChatFriendMsg', msg);
      else { t.s.offlineMsgs = (t.s.offlineMsgs || []).concat(msg).slice(-MAX_OFFLINE); t.save(); }
      sendT(c, 4236, 'chat.ChatFriendMsg', msg);
      log(`[#${c.id}] private ${p.id} -> ${t.id}${tc ? '' : ' (offline)'}`);
    },
  };
};
