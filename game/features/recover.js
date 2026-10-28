// Kaynak Geri Al (t_s_newrecovertemplate): rewards of the daily activities a player missed on the previous
// MaxDay (2) days. Client RecoverWnd: 554 NewRecoverRes {infos: [{moduleId, state 1 can / 2 done, time =
// times to recover, items = the full amounts}]}; C_NEW_RECOVER_REQ {op 1 free one / 2 full one / 3 free all /
// 4 full all, moduleId, payType}. Free returns 20% ("Ücretsiz geri alma yalnızca %20 kaynak iade eder"), full
// costs Price x time diamonds. The template's two drop condition types are exactly these: 82xx (ItemPercentPay)
// = 5 x 81xx (ItemPercentFree), e.g. Yeraltı floor 1: 8206 5200 EXP, 8106 1040.
//  rows: Para1 = player level (Ödüllü Görev 8x08, Vergi Topla 8x10: [lv, lv]), floor (labyrinths 8x06 / 8x09,
//   summed over floors 1..record = one run), group dungeon id (8x05: the best one the player cleared).
//  missed = Maximum (per day) - done that day, from a day log of feature events (stats maze, maze2, bounty,
//   levy, groupScene) kept from the first day this server tracked the player; untracked days count nothing.
// Only the modules this server has: 6 Grup Sahne, 7 Yeraltı, 9 Ödüllü Görev, 10 Uçurum, 11 Vergi Topla.
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const STAT_MODULE = { groupScene: 6, maze: 7, bounty: 9, maze2: 10, levy: 11 };
const BUILT = new Set(Object.values(STAT_MODULE));

module.exports = (ctx) => {
  const { dec, sendT, table, alert, grant, pay, DROPS, rewardName, sendPlayer, log } = ctx;
  const MODULES = table('t_s_newrecovertemplate').filter(r => BUILT.has(r.Id));

  function dayLog(p) {
    const l = p.s.dayLog = p.s.dayLog || { start: dayKey(), days: {} };
    const keep = new Set([0, 1, 2, 3].map(i => dayKey(new Date(Date.now() - i * 86400000))));
    for (const d of Object.keys(l.days)) if (!keep.has(d)) delete l.days[d];
    return l;
  }
  ctx.onStat((c, key, n) => {
    const mod = STAT_MODULE[key]; if (!mod || !c.player) return;
    const day = (dayLog(c.player).days[dayKey()] = dayLog(c.player).days[dayKey()] || {});
    day[mod] = (day[mod] || 0) + (n || 1);
  });
  ctx.onLogin.push(c => { dayLog(c.player); });

  // the reward of one recovery of module m at the given drop type family (81 free / 82 full)
  function unit(p, m, family) {
    const type = family * 100 + (m.Id <= 12 ? (m.ItemPercentFree % 100) : 0);
    const rows = DROPS.condition(type);
    const roll = rs => { const got = new Map(); for (const r of rs) for (const [t, n] of DROPS.roll(r.DropId)) got.set(t, (got.get(t) || 0) + n); return [...got]; };
    if (m.Id === 9 || m.Id === 11) return roll(rows.filter(r => (r.Para1 || [])[0] === p.s.grades));
    if (m.Id === 7 || m.Id === 10) {
      const rec = (((p.s.maze || {})[m.Id === 7 ? 0 : 1]) || {}).maxIndex || 0;
      return roll(rows.filter(r => (r.Para1 || [])[0] >= 1 && (r.Para1 || [])[0] <= rec));
    }
    if (m.Id === 6) {
      const best = rows.filter(r => (p.s.cleared || []).includes((r.Para1 || [])[0])).sort((a, b) => b.Para1[0] - a.Para1[0])[0];
      return best ? roll([best]) : [];
    }
    return [];
  }
  // missed times per module over the previous MaxDay days
  function missed(p, m) {
    const l = dayLog(p), done = p.s.recovered = p.s.recovered || {};
    let t = 0;
    for (let i = 1; i <= (m.MaxDay || 2); i++) {
      const d = dayKey(new Date(Date.now() - i * 86400000));
      if (d < l.start || done[d + '|' + m.Id]) continue;
      if (p.s.created && d < dayKey(new Date(p.s.created))) continue;
      t += Math.max(0, (m.Maximum || 1) - (((l.days[d] || {})[m.Id]) || 0));
    }
    return t;
  }
  const available = (p, m) => p.s.grades >= (m.Grades || 1) && p.s.grades <= (m.MaxLevel || 999);
  function infos(p) {
    const out = [];
    for (const m of MODULES) {
      if (!available(p, m)) continue;
      const time = missed(p, m);
      const items = time ? unit(p, m, 82).map(([itemId, count]) => ({ itemId, count: count * time })) : [];
      if (!items.length && time) continue;   // nothing to give (e.g. no record yet)
      out.push({ moduleId: m.Id, state: time ? 1 : 2, time, items });
    }
    return out;
  }
  const send = c => sendT(c, 554, 'recover.NewRecoverRes', { infos: infos(c.player) });
  ctx.onLoad.push(send);

  function recoverOne(c, m, full, payType) {
    const p = c.player, time = missed(p, m);
    if (!time) return null;
    const got = unit(p, m, full ? 82 : 81).map(([t, n]) => [t, n * time]);
    if (!got.length) return null;
    if (full) {
      const cost = (m.Price || 0) * time;
      const bound = payType === 0 && ctx.balance(p, -500) >= cost;
      if (!pay(c, [[bound ? -500 : -400, cost]])) { alert(c, 'Diamantes insuficientes'); return false; }
    }
    if (!grant(c, got, { quiet: true })) { alert(c, 'Mochila cheia'); return false; }
    const done = p.s.recovered = p.s.recovered || {};
    for (let i = 1; i <= (m.MaxDay || 2); i++) done[dayKey(new Date(Date.now() - i * 86400000)) + '|' + m.Id] = true;
    for (const k of Object.keys(done)) if (k.slice(0, 10) < dayKey(new Date(Date.now() - 5 * 86400000))) delete done[k];
    p.save();
    log(`[#${c.id}] recovered module ${m.Id} x${time} (${full ? 'full' : 'free'})`);
    return got;
  }

  return {
    C_NEW_RECOVER_REQ(c, body) {
      const msg = dec(c, 'C_NEW_RECOVER_REQ', body), p = c.player;
      const full = msg.op === 2 || msg.op === 4, all = msg.op === 3 || msg.op === 4;
      if (![1, 2, 3, 4].includes(msg.op)) return send(c);
      const list = all ? MODULES.filter(m => available(p, m)) : MODULES.filter(m => m.Id === msg.moduleId && available(p, m));
      const total = new Map();
      for (const m of list) {
        const got = recoverOne(c, m, full, msg.payType);
        if (got === false) break;
        for (const [t, n] of got || []) total.set(t, (total.get(t) || 0) + n);
      }
      if (total.size) { sendPlayer(c); alert(c, `Obtido:${[...total].map(([t, n]) => `${rewardName(t)} x${n}`).join(' ')}`); }
      else if (!list.length || list.every(m => !missed(p, m))) alert(c, 'Todos os recursos foram recuperados.');
      send(c);
    },
    // the old recover window (RecoverInfosMsg): closed
    C_RECOVER(c) { sendT(c, 4912, 'recover.RecoverInfosMsg', { openState: 0 }); },
  };
};
