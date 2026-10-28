// Channel chat between our players (U_CH_CHANNEL_CHA 15005 -> 83 ChatChannelMsg). The capture holds only
// system lines on these channels (the recorded player never wrote); sender fields as the client reads them
// (ChatManager.__channelChatHandler): otherId = sender id, name, headid, level, job, fight, vipGrade,
// serverName, curTime. Channels (client zr): 10 world, 1 big bugle, 8 current scene (the town square, else
// only the sender), 5 guild (members of the sender's guild once guilds exist), 6 team (features/team.js members). Receivers that blacklisted the sender do not get it.
// World chat does not come through U_CH_CHANNEL_CHA: the client's world input always sends
// C_BAG_USESMALLBUGLE (chatBySmallBugle), which costs a free daily use (t_s_config SMALL_BUGLE_FREE_COUNT,
// 10) or one Hoparlör (208003); it asks C_SMALL_BUGLE_FREE_COUNT -> 4500 {paraInt1 = free left} when it has
// no Hoparlör. Big bugle (C_BAG_USEBIGBUGLE, 208002) goes to everyone on channel 1 (shown on top).
const MAX_MSG = 300, GAP_MS = 2000;
const WORLD = 10, BIGBUGLE = 1, CURRENT = 8, CONSORTIA = 5, TEAM = 6;
const SMALL_BUGLE = 208003, BIG_BUGLE = 208002, CROSS_BUGLE = 208025;   // client n_.SMALL_BUGLE_TEMP_ID / BIG_BUGLE_TEMP_ID
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

module.exports = (ctx) => {
  const { dec, sendT, sendItems, online, alert, cfg, CONF, M, log } = ctx;
  const FREE = CONF.get('SMALL_BUGLE_FREE_COUNT') ?? 10;
  const last = new WeakMap();
  const blocked = (rcv, sender) => ((rcv.s.relations || {})[sender.id] || {}).relation === 2;
  const freeLeft = p => { const b = p.s.bugle; return b && b.day === dayKey() ? Math.max(0, FREE - b.used) : FREE; };
  const sendFree = c => sendT(c, 4500, 'campaign.CampaignReqMsg', { paraInt1: freeLeft(c.player) });
  ctx.onLoad.push(sendFree);

  // text checks shared by every channel; null = not sent
  function text(c, m) {
    const t = String(m.encodeMsg || '').slice(0, MAX_MSG);
    if (!t.trim()) return null;
    if (ctx.gmCommand && ctx.gmCommand(c, t.trim())) return null;   // test commands (features/gm.js)
    const now = Date.now();
    if (now - (last.get(c) || 0) < GAP_MS) { alert(c, 'Você está enviando mensagens rápido demais'); return null; }
    last.set(c, now);
    return t;
  }
  function deliver(c, channel, t, m, to) {
    const p = c.player;
    const msg = { channel, encodeMsg: t, otherId: p.id, name: p.s.nickName, headid: p.s.icon, level: p.s.grades, job: p.s.job,
      fight: p.fightingCapacity(), vipGrade: p.s.vipGrade || 0, serverName: require('../../sites').showNameOf(p.s.site) || cfg.SERVER_NAME, curTime: Date.now(), items: m.items || [], stars: m.stars || [], powcards: m.powcards || [] };
    for (const o of to) if (o.player && !blocked(o.player, p)) sendT(o, 83, 'chat.ChatChannelMsg', msg);
    log(`[#${c.id}] chat ch${channel} ${p.id}: ${t.slice(0, 60)}`);
  }
  const everyone = () => [...online.values()];
  // one of the template from the bag; false when there is none
  function useOne(c, tid) {
    const p = c.player, touched = p.takeTemplate(tid, 1);
    if (!touched.length) return false;
    sendItems(c, touched.map(it => M.movedEntry(p, it, it.count <= 0)));
    return true;
  }

  return {
    U_CH_CHANNEL_CHA(c, body) {
      const m = c.decode('chat.ChatChannelMsg', body), p = c.player;   // not in codemap: the client's bC.sendChat type
      const t = text(c, m); if (t === null) return;
      const channel = m.channel === BIGBUGLE ? WORLD : m.channel;
      let to;
      if (channel === WORLD) to = everyone();
      else if (channel === CURRENT) { const sq = ctx.squareMembers ? ctx.squareMembers() : []; to = sq.includes(c) ? sq : [c]; }
      else if (channel === CONSORTIA) {
        const g = p.s.guild && p.s.guild.id;
        if (!g) { alert(c, 'Você não é membro de uma guilda'); return; }
        to = everyone().filter(o => o.player && o.player.s.guild && o.player.s.guild.id === g);
      } else if (channel === TEAM) to = ctx.teamMembers ? ctx.teamMembers(c) : [c];   // features/team.js
      else return;   // system channels are not writable
      deliver(c, channel, t, m, to);
    },
    C_SMALL_BUGLE_FREE_COUNT: sendFree,
    // world chat: a free use of today first, then a Hoparlör
    C_BAG_USESMALLBUGLE(c, body) {
      const m = dec(c, 'C_BAG_USESMALLBUGLE', body), p = c.player;
      const t = text(c, m); if (t === null) return;
      if (freeLeft(p) > 0) {
        const b = p.s.bugle = p.s.bugle && p.s.bugle.day === dayKey() ? p.s.bugle : { day: dayKey(), used: 0 };
        b.used++;
      } else if (!useOne(c, SMALL_BUGLE)) { alert(c, 'Sem megafone'); sendFree(c); return; }
      p.save();
      sendFree(c);
      deliver(c, WORLD, t, m, everyone());
    },
    C_BAG_USEBIGBUGLE(c, body) {
      const m = dec(c, 'C_BAG_USEBIGBUGLE', body), p = c.player;
      const t = text(c, m); if (t === null) return;
      if (!useOne(c, BIG_BUGLE)) { alert(c, 'Sem megafone grande'); return; }
      p.save();
      deliver(c, BIGBUGLE, t, m, everyone());
    },
    // cross-server big bugle (client chatByCross, item 208025 n_.CROSS_BUGLE_TEMP_ID): one server here, so it goes to
    // everyone on it as 4541 U_C_CROSS_BIGBUGLE cross.CrossBigBugleMsg (client __crossBugleHandler)
    C_SEND_CROSS_BIGBUGLE(c, body) {
      const m = dec(c, 'C_SEND_CROSS_BIGBUGLE', body), p = c.player;
      const t = text(c, { encodeMsg: m.content }); if (t === null) return;
      if (!useOne(c, CROSS_BUGLE)) { alert(c, 'Sem megafone interservidor'); return; }
      p.save();
      const msg = { serverName: require('../../sites').showNameOf(p.s.site) || ctx.cfg.SERVER_NAME || '', uid: p.id, userId: p.id, nickName: p.s.nickName, isLookInfo: true, content: t, headId: p.s.icon || 0, level: p.s.grades, curTime: Date.now() };
      for (const o of everyone()) sendT(o, 4541, 'cross.CrossBigBugleMsg', msg);
      log(`[#${c.id}] cross bugle ${p.id}: ${t.slice(0, 60)}`);
    },
  };
};
