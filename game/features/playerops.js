// Small player requests: the settings window (C_PLAYER_SETTING switches, friend / team / room refusals),
// searching a player by name (mail receiver, guild transfer: C_PLAYER_SEARCH; shop gift: U_C_CHECK_NICK),
// renaming with a rename card (C_PLAYER_RENAME_REQ), a fresh PlayerMsg (U_C_PLAYER_INFO), battle chat and
// retreat. Settings are stored in p.s.settings under their PlayerMsg field names (msg.js copies them).
// Client telemetry requests that need no answer are taken here so they stop showing as unhandled.
const P = require('../people');
const RENAME_CARD = 208018;               // client Lt.RENAME_CARD_TEMPID
const TYPE_RENAME_CARD = 1, TYPE_COMPOSE = 2;   // client aM
const NAME_MIN = 2, NAME_MAX = 14;
const BATTLE_CHAT = 16;                   // client zr.BATTLE_CHAT
// C_PLAYER_SETTING optType -> PlayerMsg field (client HC enum and __uPlayerInfoHandler); 18..20 have no field
const SETTING = { 1: 'refuseFamInvite', 2: 'refuseLookInfo', 3: 'refuseConsortiaInvite', 4: 'receivePushMsg', 5: 'mbSetingTK', 6: 'mbSetingYW',
  7: 'mbSetingFB', 8: 'mbSetingHD', 9: 'mbSetingZD', 10: 'mbSetingDW', 11: 'pushFarm', 12: 'pushWorldBoss', 13: 'pushGuildTree', 14: 'pushGuildWar',
  15: 'pushMultiCamp', 16: 'pushBuildingOrder', 17: 'pushTempleReward' };

module.exports = (ctx) => {
  const { D, M, db, dec, sendT, sendItems, sendPlayer, online, playerById, alert, cfg, log } = ctx;
  const sites = require('../../sites');
  const srv = p => sites.showNameOf(p.s.site) || cfg.SERVER_NAME;
  const settings = p => (p.s.settings = p.s.settings || {});
  const byNick = name => {
    const n = String(name || '').trim().toLowerCase(); if (!n) return null;
    for (const c of online.values()) if (c.player && c.player.s.nickName.toLowerCase() === n) return c.player;
    const a = Object.values(db.state.accounts).find(x => x.char && String(x.char.nickName).toLowerCase() === n);
    return a ? playerById(a.userId) : null;
  };
  ctx.playerByNick = byNick;
  ctx.setting = (p, field) => !!(p.s.settings || {})[field];
  const toggle = field => c => { const s = settings(c.player); s[field] = !s[field]; c.player.save(); sendPlayer(c); };
  const quiet = () => {};
  function frameOrBubble(c, body) {
    const b = c.decode('bubble.ChangeBubbleReq', body);
    if (Object.prototype.hasOwnProperty.call(b, 'op')) return bubble(c, b);
    const m = c.decode('frame.ChangeFrameReq', body), p = c.player, ok = !m.frameId || (p.s.frames || []).includes(m.frameId);
    if (ok) { p.s.frameId = m.frameId || 0; p.save(); } else alert(c, 'Este quadro não foi liberado');
    sendT(c, 4728, 'frame.ChangeFrameResp', { frameId: m.frameId || 0, ret: ok ? 1 : 0 });
  }
  // avatars (t_s_avatar: Type 1 always open, Type 2 opened by its NeedItemId item, SonType 228 Property1 = avatar):
  // C_AVATAR_REQ -> 863 avatar.AvatarInfoRes {unlockAvatar [Type 2 ids opened], usingAvatar = the SNS head};
  // C_GET_ALL_FRAME -> 4729 frame.FrameInfoMsgList {op 0, frames [{frameId, isUse}]} (client requestAllFrame).
  // Both were recorded copies (empty bodies).
  const AVATARS = new Map(ctx.table('t_s_avatar').map(r => [r.Id, r]));
  const avatarInfo = c => { const p = c.player; sendT(c, 863, 'avatar.AvatarInfoRes', { unlockAvatar: (p.s.avatars || []).slice(), usingAvatar: (p.s.sns && p.s.sns.headId) || p.s.icon }); };
  ctx.useItem[228] = (c, it, tp) => {
    const p = c.player, a = AVATARS.get(tp.Property1);
    if (!a) { alert(c, 'Este avatar não pode ser usado'); return; }
    p.s.avatars = p.s.avatars || [];
    if (p.s.avatars.includes(a.Id)) { alert(c, 'Este avatar já está liberado'); return; }
    p.s.avatars.push(a.Id); p.removeItem(it, 1); ctx.sendItems(c, [ctx.M.movedEntry(p, it, it.count <= 0)]); p.save();
    alert(c, `Avatar liberado: ${ctx.nameOf(a) || a.Id}`);
    avatarInfo(c);
  };
  function bubble(c, m) {
    const p = c.player, ok = !m.bubbleId || (p.s.bubbles || []).includes(m.bubbleId);
    if (!ok) { alert(c, 'Este balão de chat não foi liberado'); return; }
    p.s.bubbleId = m.bubbleId || 0; p.save();
    sendT(c, 4728, 'bubble.ChangeBubbleInfoMsg', { op: 1, bubbleInfo: { bubbleId: p.s.bubbleId, isUse: 1 } });
  }

  return {
    U_C_PLAYER_INFO(c) { sendPlayer(c); },
    C_PLAYER_SETTING(c, body) {
      const m = dec(c, 'C_PLAYER_SETTING', body), p = c.player, field = SETTING[m.optType];
      if (field) settings(p)[field] = m.result === 1;
      else (p.s.settingsExtra = p.s.settingsExtra || {})[m.optType] = { result: m.result || 0, value: m.value || 0 };   // shortcut / translate options
      p.save();
      sendT(c, 4708, 'player.PlayerSettingMsg', { optType: m.optType, result: m.result || 0, value: m.value || 0 });
    },
    // switches with no body: each press flips it; the client reads the new value from PlayerMsg
    C_FRIEND_REFUSE: toggle('refuseFriend'),
    C_TEAM_REFUSE: toggle('refuseTeamInvite'),
    C_ROOM_REFUSE: toggle('refuseInvite'),

    C_PLAYER_SEARCH(c, body) {
      const m = dec(c, 'C_PLAYER_SEARCH', body), t = byNick(m.otherNickname);
      sendT(c, 4170, 'simple.SimplePlayerSearchRspMsg', t ? { info: P.playerInfo(t, online.has(t.id)) } : {});
    },
    U_C_CHECK_NICK(c, body) {
      const m = dec(c, 'U_C_CHECK_NICK', body), t = byNick(m.nickName);
      sendT(c, 4148, 'player.CheckNickMsg', { playerId: t ? t.id : -1, nickName: m.nickName || '' });
    },

    // the client checked the name over HTTP (/web/nicknamecheck) first; checked again here
    C_PLAYER_RENAME_REQ(c, body) {
      const m = dec(c, 'C_PLAYER_RENAME_REQ', body), p = c.player, name = String(m.nickName || '').trim();
      const reply = (ok, msg) => { if (msg) alert(c, msg); sendT(c, 4271, 'player.PlayerRenameRspMsg', { result: ok }); };
      if (name.length < NAME_MIN || name.length > NAME_MAX || /[<>"'&\s]/.test(name)) return reply(false, 'Nome inválido');
      const other = byNick(name);
      if (other && other.id !== p.id) return reply(false, 'Este nome já está em uso');
      if (name === p.s.nickName) return reply(false, 'O novo nome é igual ao atual');
      let entries = [];
      if (m.type === TYPE_COMPOSE) {
        if (!p.s.mustRename) return reply(false, 'Cartão de mudança de nome necessário');   // only after a server merge
        p.s.mustRename = false;
      } else {
        const it = p.itemAt(m.pos) && p.itemAt(m.pos).templateId === RENAME_CARD ? p.itemAt(m.pos) : p.s.bag.find(i => i.templateId === RENAME_CARD && (i.bagType ?? 1) === 1);
        if (!it) return reply(false, 'Cartão de mudança de nome insuficiente');
        p.removeItem(it, 1);
        entries = [M.movedEntry(p, it, it.count <= 0)];
      }
      const old = p.s.nickName;
      p.s.nickName = name;
      const a = Object.values(db.state.accounts).find(x => x.userId === p.id);
      if (a && a.char) { a.char.nickName = name; db.save(); }
      c.rw = null;   // recorded packets are rewritten with the player's name (logic.js rw)
      p.save();
      sendItems(c, entries);
      sendPlayer(c);
      reply(true, `Seu nome foi alterado para "${name}"`);
      log(`[#${c.id}] rename ${p.id}: ${old} -> ${name}`);
    },

    // battle chat: the fights are against the server, so it goes back to the sender only
    B_BATTLE_CHAT(c, body) {
      const m = c.decode('chat.ChatChannelMsg', body), p = c.player, text = String(m.encodeMsg || '').slice(0, 100);
      if (!c.battle || !text.trim()) return;
      sendT(c, 83, 'chat.ChatChannelMsg', { channel: BATTLE_CHAT, type: m.type || 0, encodeMsg: text, otherId: p.id, name: p.s.nickName, headid: p.s.icon,
        level: p.s.grades, job: p.s.job, fight: m.fight || 0, vipGrade: p.s.vipGrade || 0, serverName: srv(p), curTime: Date.now(), battleId: m.battleId });
    },
    // otherObj 0 = retreat (settings window in a fight); 1 / 2 = team retreat votes (no team fights here)
    B_WITHDRAW_BATTLE(c, body) {
      const m = dec(c, 'B_WITHDRAW_BATTLE', body);
      if ((m.otherObj || 0) !== 0 || !c.battle || !c.battle.engine) return;
      log(`[#${c.id}] retreat from ${c.battle.id}`);
      c.battle.engine.retreat();
    },

    // "auto attack after the fight" switch (client sendAutoAttackBattleOver): kept, nothing answered
    C_SET_ATUO_ATTACK(c, body) { const m = dec(c, 'C_SET_ATUO_ATTACK', body); c.player.s.autoAttackAfter = m.mode || 0; c.player.save(); },
    // barracks "auto recruit" box (CasernWnd checkAuto): PlayerMsg.autoRecruit; the refill itself is not built
    C_CASERN_AUTO_SETTING(c, body) { const m = dec(c, 'C_CASERN_AUTO_SETTING', body); settings(c.player).autoRecruit = !!m.autoRecruit; c.player.save(); sendPlayer(c); },
    // profile (SNS window: signature, birthday, star sign, blood type, place; the head picture from the avatar
    // list sends only headId) -> 4245 with what is kept. Name and sex are not changed here.
    C_AVATAR_REQ(c) { avatarInfo(c); },
    C_GET_ALL_FRAME(c) { const p = c.player; sendT(c, 4729, 'frame.FrameInfoMsgList', { op: 0, frames: (p.s.frames || []).map(frameId => ({ frameId, isUse: frameId === p.s.frameId ? 1 : 0 })) }); },
    CH_SNS_UPDATE(c, body) {
      const m = dec(c, 'CH_SNS_UPDATE', body), p = c.player, sns = p.s.sns = p.s.sns || {};
      const av = Object.prototype.hasOwnProperty.call(m, 'headId') && AVATARS.get(m.headId);
      if (av && av.Type === 2 && !(p.s.avatars || []).includes(av.Id)) { alert(c, 'Este avatar não foi liberado'); return avatarInfo(c); }
      for (const k of ['signDesc', 'birthdayType', 'birthYear', 'birthMonth', 'birthDay', 'starId', 'bloodType', 'country', 'province', 'city', 'headId'])
        if (Object.prototype.hasOwnProperty.call(m, k)) sns[k] = typeof m[k] === 'string' ? m[k].slice(0, 60) : m[k];   // only the fields sent (decoded defaults live on the prototype)
      p.save();
      // 2026-10-23 capture: CH_SNS_UPDATE {headId 52} -> 4239 SNSUpdatedMsg {snsInfo {id, userId, nickname, headId}, result 1}
      // and 863 with the avatar in use
      sendT(c, 4239, 'simple.SNSUpdatedMsg', { snsInfo: Object.assign({ headId: p.s.icon }, sns, { id: p.id, userId: p.id, nickname: p.s.nickName }), result: 1 });
      if (Object.prototype.hasOwnProperty.call(m, 'headId')) avatarInfo(c);
    },
    // profile frame / chat bubble: owned ones (p.s.frames / p.s.bubbles; the unlocking items are not known yet,
    // the recorded lists were empty) or 0 = none -> 4728 (frame.ChangeFrameResp / bubble.ChangeBubbleInfoMsg)
    // C_FRAME_CHANGE and C_BUBBLE_CHANGE share code 8808 (client enum; the dispatcher names it either way):
    // the bubble request always carries op (field 2), the frame one never
    C_FRAME_CHANGE: frameOrBubble,
    C_BUBBLE_CHANGE: frameOrBubble,
    // telemetry / login markers: nothing to answer
    U_C_PLAYER_LOGINSTATE: quiet,
    C_CLIENT_EVENT: quiet,
    C_CLICKDATALIST: quiet,
    C_MICRO_CLIENT_INFO: quiet,
    C_KF_REPLY_QUERY: quiet,
    C_BATTER_COUNT: quiet,      // combo count of the fight just played (client report)
    C_FASHION_SPECIAL: quiet,   // the "new" mark of a fashion item seen
  };
};
