// Muhafız seferi (client Wf / Gf; t_s_guardexpedition, t_s_guardexpedition_addrewards). Client-derived, no capture:
//  C_GUARD_EXPEDITIONARY (GuardExpeditionReqInfoMsg {op, areaId, nodeId, num}): 1 info, 2 fight a node, 3 sweep a
//  cleared node, 5 accumulated reward (addrewards row whose Num = num), 6 buy a reward time with one 208088
//  (client GUARD_EXPEDITION_ITEM_ID) -> 4945 GuardExpeditionResInfoMsg {areaInfo [{areaId, maxNodeId,
//  finishNodeId}], rewardTimes, buyTimes, num, rewards "ids", payRewardTimes}.
//  Nodes are fought in order (an area opens after the previous one's last node); MonsterId "pawn,pos|..." are the
//  troops, BossId "hero,pos" a boss. The first win gives FirstRewards; later wins and sweeps give SweepRewards and
//  use a reward time: guardexpedition_income_times (5) a day, plus bought ones (up to guardexpedition_max_times 45).
//  Every rewarded run counts toward the addrewards Num thresholds.
// Our choices: rewardTimes = free times used today, buyTimes = bought times left; the hero fights together with
// the guard in battle (battle type 54); a lost fight uses nothing.
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const BUY_ITEM = 208088, BATTLE_TYPE = 54;

module.exports = (ctx) => {
  const { table, dec, sendT, alert, pay, grant, CONF } = ctx;
  const NODES = table('t_s_guardexpedition'), ADD = table('t_s_guardexpedition_addrewards');
  const FREE = Number(CONF.str('guardexpedition_income_times')) || 5, MAX_BUY = Number(CONF.str('guardexpedition_max_times')) || 45;
  const pairs = s => String(s || '').split('|').filter(Boolean).map(x => x.split(',').map(Number));
  const node = (a, n) => NODES.find(r => r.AreaId === a && r.NodeId === n);
  const maxNode = a => Math.max(0, ...NODES.filter(r => r.AreaId === a).map(r => r.NodeId));
  const areas = [...new Set(NODES.map(r => r.AreaId))].sort((x, y) => x - y);
  function state(p) {
    const s = p.s.guardExp = p.s.guardExp || { done: {}, day: '', used: 0, bought: 0, num: 0, claimed: [] };
    if (s.day !== dayKey()) { s.day = dayKey(); s.used = 0; }
    return s;
  }
  const send = c => {
    const s = state(c.player);
    sendT(c, 4945, 'carnival.GuardExpeditionResInfoMsg', { userId: c.player.id, rewardTimes: s.used, buyTimes: s.bought, num: s.num, rewards: s.claimed.join(','), payRewardTimes: 0,
      areaInfo: areas.filter(a => a === 1 || (s.done[a - 1] || 0) >= maxNode(a - 1)).map(a => ({ areaId: a, maxNodeId: maxNode(a), finishNodeId: s.done[a] || 0 })) });
  };
  // a reward time: free first, then a bought one
  function useTime(s) { if (s.used < FREE) { s.used++; return true; } if (s.bought > 0) { s.bought--; return true; } return false; }
  const reachable = (s, a, n) => (a === 1 || (s.done[a - 1] || 0) >= maxNode(a - 1)) && n <= (s.done[a] || 0) + 1;

  return {
    C_GUARD_EXPEDITIONARY(c, body) {
      const m = dec(c, 'C_GUARD_EXPEDITIONARY', body), p = c.player, s = state(p);
      switch (m.op) {
        case 2: {
          const row = node(m.areaId, m.nodeId);
          if (!row || !reachable(s, m.areaId, m.nodeId)) { alert(c, 'Este nodo ainda não abriu'); return send(c); }
          const first = (s.done[m.areaId] || 0) < m.nodeId;
          if (!first && s.used >= FREE && s.bought <= 0) { alert(c, 'Suas recompensas de hoje acabaram'); return send(c); }
          ctx.startBattle(c, { Soldiers: row.MonsterId, Heros: row.BossId, BattleType: BATTLE_TYPE, mapTempId: 1, onEnd: (won) => {
            if (!won) return send(c);
            ctx.stat(c, 'guardExp');   // Etkinlikler condition 522 (features/sumactive.js)
            if (first) { s.done[m.areaId] = m.nodeId; grant(c, pairs(row.FirstRewards)); }
            else if (useTime(s)) { s.num++; grant(c, pairs(row.SweepRewards)); }
            p.save(); send(c);
          } });
          return;
        }
        case 3: {
          const row = node(m.areaId, m.nodeId);
          if (!row || (s.done[m.areaId] || 0) < m.nodeId) { alert(c, 'Conclua este nodo primeiro'); return send(c); }
          if (!useTime(s)) { alert(c, 'Suas recompensas de hoje acabaram'); return send(c); }
          s.num++; grant(c, pairs(row.SweepRewards)); ctx.stat(c, 'guardExp');
          break;
        }
        case 5: {
          const row = ADD.find(r => r.Num === m.num);
          if (!row || s.claimed.includes(row.Id) || s.num < row.Num) { alert(c, 'Esta recompensa não pode ser recebida'); return send(c); }
          grant(c, pairs(row.AccumulateRewards)); s.claimed.push(row.Id);
          break;
        }
        case 6: {
          if (s.bought >= MAX_BUY) { alert(c, 'Limite de tentativas extras atingido'); return send(c); }
          if (!pay(c, [[BUY_ITEM, 1]])) { alert(c, 'Sem ordem de expedição'); return send(c); }
          s.bought++;
          break;
        }
      }
      p.save();
      send(c);
    },
  };
};
