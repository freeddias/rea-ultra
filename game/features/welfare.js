// Welfare: online-time reward wheel (t_s_onlinerewards), level gift packs (t_s_growthgiftpack),
// 28-day sign-in (t_s_dropcondition type 17 -> drop table).
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DAY = 86400000;
module.exports = (ctx) => {
  const { table, dec, sendT, alert, chat, grant, pay, parseRewards, DROPS, rewardName, log } = ctx;
  // seconds of online time per draw: t_s_config onlinerewards_times "5,10,...,40" minutes (8 draws a day; the
  // capture's 300 / 600 / 900 / 1200 match); after the last one leftTime = -1 (client: "daily maximum reached")
  const ONLINE_STEPS = String((table('t_s_config').find(r => r.ConfigName === 'onlinerewards_times') || {}).ConfigValue || '5,10,15,20,25,30,35,40')
    .split(',').map(Number).filter(Boolean).map(m => m * 60);

  // ---- online reward -------------------------------------------------------------------------------
  const WHEEL = table('t_s_onlinerewards').map(r => ({ id: r.Id, itemId: r.ItemId, num: r.ItemNum, weight: r.Random }));
  function online(p) {
    let o = p.s.onlineReward;
    if (!o || o.day !== dayKey()) o = p.s.onlineReward = { day: dayKey(), draws: 0, step: 0, remaining: ONLINE_STEPS[0], since: o && o.since ? Date.now() : null, pending: 0 };
    if (o.since) {   // the clock runs only while the player is online
      let t = (Date.now() - o.since) / 1000;
      while (o.remaining != null && t >= o.remaining) { t -= o.remaining; o.draws++; o.step++; o.remaining = ONLINE_STEPS[o.step] ?? null; }
      if (o.remaining != null) o.remaining -= t;
      o.since = Date.now();
    }
    return o;
  }
  ctx.onLogin.push(c => { const o = online(c.player); o.since = Date.now(); c.player.save(); });
  ctx.onClose(c => { if (!c.player) return; online(c.player).since = null; c.player.save(); });

  const wheelInfo = (c, op = 1, extra = {}) => {
    const o = online(c.player);
    sendT(c, 4697, 'active.OnlineRewardInfoRsp', Object.assign({ op, allItem: WHEEL, rewardTime: o.draws, leftTime: o.remaining == null ? -1 : Math.ceil(o.remaining) }, extra));
  };
  function spin() {
    const total = WHEEL.reduce((n, w) => n + w.weight, 0);
    let x = Math.random() * total;
    for (const w of WHEEL) { x -= w.weight; if (x < 0) return w; }
    return WHEEL[WHEEL.length - 1];
  }
  function claim(c, w) {
    if (!grant(c, [[w.itemId, w.num]], { quiet: true })) { alert(c, 'Mochila cheia'); return false; }
    chat(c, `Recompensas diárias online:&nbsp;${rewardName(w.itemId)} x${w.num}`);   // capture: chat channel 3
    return true;
  }

  // ---- level gift packs ----------------------------------------------------------------------------
  const PACKS = table('t_s_growthgiftpack').map(r => ({ id: r.Id, grade: r.Grade, packet: r.FreeId, preferPacket: r.PreferentialId, price: r.Price, discount: r.Discount }));
  const packState = p => (p.s.gradePack = p.s.gradePack || { recv: 0, buy: 0 });

  // ---- sign-in -------------------------------------------------------------------------------------
  const SIGN_DAYS = DROPS.condition(17).filter(r => (r.Para1 || [])[0] > 0).sort((a, b) => a.Para1[0] - b.Para1[0]);
  const TOTAL = SIGN_DAYS.length;
  const bit = day => 1 << (TOTAL - day);   // client: signSite & 1 << totalSignDayNum - day
  function sign(p) {
    let s = p.s.sign;
    const today = new Date(dayKey()).getTime();
    if (!s || today - new Date(s.start).getTime() >= TOTAL * DAY) s = p.s.sign = { start: dayKey(), site: 0, times: 0 };
    s.todayIndex = Math.round((today - new Date(s.start).getTime()) / DAY) + 1;
    return s;
  }
  const signInfo = (c, extra = {}) => { const s = sign(c.player); sendT(c, 4177, 'player.PlayerSignRspMsg', Object.assign({ signDate: s.start, signTimes: s.times, signSite: s.site }, extra)); };
  ctx.onLoad.push(c => signInfo(c));   // replaces the recorded login copy (logic.js NATIVE 4177)

  return {
    // op 1 info, 2 spin (result id; claimed with C_ONLINE_REWARD_ENSURE), 3 spin and claim at once
    C_ONLINE_REWARD(c, body) {
      const m = dec(c, 'C_ONLINE_REWARD', body), p = c.player, o = online(p);
      if (m.op === 2 || m.op === 3) {
        if (o.draws < 1 || o.pending) { wheelInfo(c); return; }
        const w = spin();
        o.draws--;
        if (m.op === 3) { if (!claim(c, w)) o.draws++; p.save(); wheelInfo(c); return; }
        o.pending = w.id; p.save();
        wheelInfo(c, 2, { id: w.id });
        return;
      }
      wheelInfo(c);
    },
    C_ONLINE_REWARD_ENSURE(c) {   // the reward is the server's pending spin, whatever the client names
      const p = c.player, o = online(p), w = WHEEL.find(x => x.id === o.pending);
      if (w && claim(c, w)) o.pending = 0;
      p.save();
      wheelInfo(c);
    },
    // op 1 info, 2 free pack of id `grade` (once its level is reached), 3 discounted pack for diamonds
    C_GRADE_PACKET(c, body) {
      const m = dec(c, 'C_GRADE_PACKET', body), p = c.player, st = packState(p);
      const send = () => sendT(c, 4699, 'active.GradePacketRsp', { allPacket: PACKS, receiveSite: st.recv, buySite: st.buy });
      if (m.op === 2 || m.op === 3) {
        const pk = PACKS.find(x => x.id === m.grade), flag = pk ? 1 << pk.id : 0;
        if (!pk || p.s.grades < pk.grade) { alert(c, 'Nível insuficiente'); return send(); }
        if (m.op === 2 && !(st.recv & flag)) { if (grant(c, parseRewards(pk.packet))) st.recv |= flag; }
        else if (m.op === 3 && !(st.buy & flag)) {
          if (!pay(c, [[-400, pk.discount]])) { alert(c, 'Diamantes insuficientes'); return send(); }
          if (grant(c, parseRewards(pk.preferPacket))) st.buy |= flag;
          else grant(c, [[-400, pk.discount]], { quiet: true });   // bag full: refund
        }
        p.save();
        sendT(c, 4700, 'active.GradeReceiveRsp', { receiveSite: st.recv, buySite: st.buy });
      }
      send();
    },
    // optType 1 info, 2 sign day `index` (only today; making up missed days is not implemented)
    C_PLAYER_SIGN_CMD(c, body) {
      const m = dec(c, 'C_PLAYER_SIGN_CMD', body), p = c.player, s = sign(p);
      if (m.optType === 2) {
        const day = m.index || s.todayIndex, row = SIGN_DAYS[day - 1];
        if (day !== s.todayIndex) { alert(c, 'Só é possível fazer check-in hoje'); return signInfo(c); }
        if (s.site & bit(day)) { alert(c, 'Check-in de hoje já realizado'); return signInfo(c); }
        if (row && !grant(c, DROPS.roll(row.DropId))) return signInfo(c);
        s.site |= bit(day); s.times++;
        p.save();
        alert(c, 'Check-in realizado');
      } else if (m.optType !== 1) log(`[#${c.id}] sign optType ${m.optType} not implemented`);
      signInfo(c);
    },
  };
};
