// Lonca Sahnesi (consortia PvE): t_s_consortiapve — 5 areas x 12 scenes (normal, Difficulty 0, nodes 1..60),
// then hard mode areas 6.. (nodes 61..); each scene a boss (Boss "heroTemplate,pos", hp = the hero's Live,
// e.g. [1-1] 24,000,000) shared by the whole guild: every member's fight takes from the same hp, the next
// scene opens when it falls. Client: ConsortiaPveManager (wg), model NI, ConsortiaPve.help text:
//  - members only, guild level >= consortiapve_level (2); consortiapve_times_day (1) fights a day, the
//    attempt is used on entering; the chairman can buy extra fights for everyone with guild wealth
//    (consortia_pve_buy_times "500000,1,3": cost, fights per buy, buys a week; valid until Monday 05:00)
//  - a completed scene gives its NodeReward, a completed area (all its scenes) its AreaReward, once per
//    player; only to players who were members when it was completed ("loncaya katılmadan önceki sahneler")
//  - seasons are calendar months (state 1 running; the last day of the month is settlement: no fights)
// C_CONSORTIA_PVE_REQ {op 0 data / 1 scene / 2 fight / 3 scene reward / 4 all rewards / 5 area box / 6 extra
// fights / 8 damage ranking, value1 area, value2 node} -> 4884 data {nodes [{nodeId, attackCount,
// awardState 0 open / 1 done / 2 taken}], boxs [{areaId, difficulty, awardState, leader}], curNodeId,
// extraTimes}, 4886 scene {players by damage, bossHp, bossMaxHp, attackCount}, 4887 season, 4890 own fights
// {dayTimes, weekExtraTimes}, 4891 damage ranking.
// Assumption (no data): a fight lasts at most MAX_TURNS turns; the damage done until then counts.
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const weekKey = (d = new Date()) => { const m = new Date(d.getTime() - 5 * 3600000); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return dayKey(m); };
const MAX_TURNS = 10;

module.exports = (ctx) => {
  const { D, dec, sendT, table, alert, grant, parseRewards, CONF, cfg, log } = ctx;
  const G = require('../guilds');
  const NODES = new Map(table('t_s_consortiapve').map(r => [r.NodeId, r]));
  const AREAS = new Map(); for (const r of NODES.values()) (AREAS.get(r.AreaId) || AREAS.set(r.AreaId, []).get(r.AreaId)).push(r);
  const conf = n => String((table('t_s_config').find(r => r.ConfigName === n) || {}).ConfigValue || '');
  const NEED_LEVEL = Number(conf('consortiapve_level')) || 2, DAY_TIMES = Number(conf('consortiapve_times_day')) || 1;
  const [BUY_COST, BUY_TIMES, BUY_MAX] = (conf('consortia_pve_buy_times') || '500000,1,3').split(',').map(Number);
  const bossOf = r => { const [tid] = String(r.Boss || '').split(',').map(Number); return D.heroes.get(tid) || { Live: 1 }; };

  function gstate(g) {
    const s = g.pve = g.pve || { cur: 1, nodes: {}, week: '', extra: 0 };
    if (s.week !== weekKey()) { s.week = weekKey(); s.extra = 0; }
    return s;
  }
  const nodeState = (s, id) => (s.nodes[id] = s.nodes[id] || { hp: bossOf(NODES.get(id)).Live, count: 0, dmg: {}, doneAt: 0, members: [] });
  function pstate(p) {
    const s = p.s.gpve = p.s.gpve || { day: '', times: 0, week: '', weekExtra: 0, taken: {}, boxes: {} };
    if (s.day !== dayKey()) { s.day = dayKey(); s.times = 0; }
    if (s.week !== weekKey()) { s.week = weekKey(); s.weekExtra = 0; }
    return s;
  }
  const guildOf = p => p.s.guild && G.get(p.s.guild.id);
  const settlementDay = () => { const d = new Date(), t = new Date(d); t.setDate(d.getDate() + 1); return t.getDate() === 1; };
  const done = (gs, id) => !!(gs.nodes[id] && gs.nodes[id].doneAt);
  const wasMember = (gs, id, pid) => done(gs, id) && gs.nodes[id].members.includes(pid);

  function dataMsg(p, g) {
    const gs = gstate(g), ps = pstate(p);
    const nodes = [...NODES.keys()].filter(id => id <= gs.cur).map(id => ({ nodeId: id, attackCount: (gs.nodes[id] || {}).count || 0,
      awardState: ps.taken[id] ? 2 : wasMember(gs, id, p.id) ? 1 : 0 }));
    const boxs = [...AREAS.entries()].map(([areaId, rows]) => {
      const complete = rows.every(r => done(gs, r.NodeId));
      const top = complete ? leaderOf(gs, rows) : null;
      return { areaId, difficulty: rows[0].Difficulty || 0, awardState: ps.boxes[areaId] ? 2 : complete && rows.every(r => wasMember(gs, r.NodeId, p.id)) ? 1 : 0, leader: top || { userId: 0, nickName: '' } };
    });
    return { nodes, boxs, curNodeId: gs.cur, serverName: cfg.SERVER_NAME, extraTimes: gs.extra };
  }
  function playerMsg(pid, dmg, count) {
    const o = ctx.playerById(pid);
    return { userId: pid, headId: o ? o.s.icon : 0, nickName: o ? o.s.nickName : '', fightPower: o ? o.fightingCapacity() : 0, attackCount: count || 0, totalDamage: dmg, job: o ? o.s.job : 0 };
  }
  function leaderOf(gs, rows) {
    const sum = {};
    for (const r of rows) for (const [pid, d] of Object.entries((gs.nodes[r.NodeId] || {}).dmg || {})) sum[pid] = (sum[pid] || 0) + d.dmg;
    const best = Object.entries(sum).sort((a, b) => b[1] - a[1])[0];
    return best ? playerMsg(Number(best[0]), best[1]) : null;
  }
  function nodeMsg(g, id) {
    const gs = gstate(g), n = nodeState(gs, id), max = bossOf(NODES.get(id)).Live;
    const players = Object.entries(n.dmg).sort((a, b) => b[1].dmg - a[1].dmg).map(([pid, d]) => playerMsg(Number(pid), d.dmg, d.count));
    return { players, curNodeId: id, bossHp: Math.max(0, n.hp), bossMaxHp: max, attackCount: n.count, buffers: [] };
  }
  const sendData = (c, g) => sendT(c, 4884, 'consortiapve.ConsortiaPveDataMsg', dataMsg(c.player, g));
  const sendTimes = c => { const ps = pstate(c.player); sendT(c, 4890, 'consortiapve.ConsortiaPlayerDataMsg', { dayTimes: ps.times, weekExtraTimes: ps.weekExtra }); };
  function sendSeason(c) {
    const d = new Date(), y = d.getFullYear(), m = d.getMonth();
    const end = new Date(y, m + 1, 0);
    sendT(c, 4887, 'consortiapve.ConsortiaPveSeasonMsg', { seasonId: y * 100 + m + 1, state: settlementDay() ? 2 : 1,
      beginTime: `${y}-${pad(m + 1)}-01 05:00:00`, endTime: `${y}-${pad(m + 1)}-${pad(end.getDate())} 23:59:59` });
  }
  const members = g => g.members.map(id => ctx.online.get(id)).filter(Boolean);

  function fight(c, msg) {
    const p = c.player, g = guildOf(p);
    if (!g) return alert(c, 'Você não é membro de uma guilda');
    if ((g.levels[1] || 0) < NEED_LEVEL) return alert(c, `Guilda Lv. ${NEED_LEVEL} necessária`);
    if (settlementDay()) return alert(c, 'Último dia da temporada: ranking em cálculo, não é possível desafiar');
    const gs = gstate(g), id = msg.value2 || gs.cur, row = NODES.get(id);
    if (!row || id !== gs.cur) return alert(c, 'Conclua o capítulo anterior primeiro');
    const ps = pstate(p);
    if (ps.times >= DAY_TIMES + Math.max(0, gs.extra * BUY_TIMES - ps.weekExtra)) return alert(c, 'Suas tentativas de desafio de hoje acabaram');
    if (c.battle) return;
    if (ps.times >= DAY_TIMES) ps.weekExtra++; else ps.times++;   // used on entering (help text)
    const n = nodeState(gs, id);
    n.count++;
    G.save(); p.save();
    sendTimes(c);
    const startHp = n.hp;
    ctx.startBattle(c, { Heros: row.Boss, BattleType: 6, mapTempId: 1, bossHp: startHp, maxTurns: MAX_TURNS, onEnd: (won, b) => {
      const boss = b.units.find(u => u.side === 2 && u.hero);
      const dmg = Math.max(0, startHp - (boss ? boss.hp : startHp));
      const cur = nodeState(gstate(g), id);
      cur.hp = Math.max(0, cur.hp - dmg);
      const d = cur.dmg[p.id] = cur.dmg[p.id] || { dmg: 0, count: 0 };
      d.dmg += dmg; d.count++;
      if (cur.hp <= 0 && !cur.doneAt) {
        cur.doneAt = Date.now(); cur.members = g.members.slice();
        if (row.NextNodeId && NODES.has(row.NextNodeId)) gstate(g).cur = row.NextNodeId;
        log(`guild ${g.id} pve scene ${id} done`);
        for (const o of members(g)) { alert(o, `${ctx.nameOf(row, 'Name')} concluído!`); sendData(o, g); }
      }
      G.save();
      alert(c, `Você causou ${dmg.toLocaleString('en-US')} de dano na cena da guilda`);
      sendT(c, 4886, 'consortiapve.ConsortiaPveCurNodeMsg', nodeMsg(g, id));
      sendData(c, g);
    } });
  }

  function takeNode(c, g, id) {
    const p = c.player, gs = gstate(g), ps = pstate(p), row = NODES.get(id);
    if (!row || ps.taken[id] || !wasMember(gs, id, p.id)) return false;
    const items = parseRewards(row.NodeReward);
    if (!grant(c, items, { quiet: true })) { alert(c, 'Mochila cheia'); return null; }
    ps.taken[id] = true; p.save();
    return items;
  }

  return {
    C_CONSORTIA_PVE_REQ(c, body) {
      const msg = dec(c, 'C_CONSORTIA_PVE_REQ', body), p = c.player, g = guildOf(p);
      if (!g) return;
      if (msg.op === 0) { sendData(c, g); sendSeason(c); sendTimes(c); return; }
      if (msg.op === 1) { sendT(c, 4886, 'consortiapve.ConsortiaPveCurNodeMsg', nodeMsg(g, msg.value2 || gstate(g).cur)); sendTimes(c); return; }
      if (msg.op === 2) return fight(c, msg);
      if (msg.op === 3 || msg.op === 4) {
        const ids = msg.op === 3 ? [msg.value2 || msg.value1] : [...NODES.keys()];
        const got = new Map();
        for (const id of ids) { const r = takeNode(c, g, id); if (r === null) break; for (const [t, n] of r || []) got.set(t, (got.get(t) || 0) + n); }
        if (got.size) alert(c, 'Obtido:' + [...got].map(([t, n]) => `${ctx.rewardName(t)} x${n}`).join(' '));
        else alert(c, 'Nenhuma recompensa de cena para receber');
        return sendData(c, g);
      }
      if (msg.op === 5) {
        const ps = pstate(p), gs = gstate(g), rows = AREAS.get(msg.value1) || [];
        if (!rows.length || ps.boxes[msg.value1] || !rows.every(r => wasMember(gs, r.NodeId, p.id))) { alert(c, 'Recompensa de área não pode ser recebida'); return sendData(c, g); }
        const items = parseRewards(rows[0].AreaReward);
        if (!grant(c, items, { quiet: true })) { alert(c, 'Mochila cheia'); return; }
        ps.boxes[msg.value1] = true; p.save();
        alert(c, 'Obtido:' + items.map(([t, n]) => `${ctx.rewardName(t)} x${n}`).join(' '));
        return sendData(c, g);
      }
      if (msg.op === 6) {
        if (g.chairmanId !== p.id) return alert(c, 'Somente o líder da guilda pode comprar tentativas extras');
        const gs = gstate(g);
        if (gs.extra >= BUY_MAX) return alert(c, 'Todas as tentativas extras desta semana já foram compradas.');
        if ((g.offer || 0) < BUY_COST) return alert(c, 'Riqueza da guilda insuficiente');
        g.offer -= BUY_COST; gs.extra++; G.save();
        for (const o of members(g)) sendData(o, g);
        return alert(c, `Foram adicionadas ${BUY_TIMES} tentativas extras para todos os membros`);
      }
      if (msg.op === 8) {
        const gs = gstate(g), sum = {};
        for (const n of Object.values(gs.nodes)) for (const [pid, d] of Object.entries(n.dmg)) sum[pid] = (sum[pid] || 0) + d.dmg;
        const list = Object.entries(sum).sort((a, b) => b[1] - a[1]).map(([pid, dmg], i) => ({ rank: i + 1, userId: Number(pid), nickName: (ctx.playerById(Number(pid)) || { s: {} }).s.nickName || '', totalDmg: dmg }));
        return sendT(c, 4891, 'consortiapve.ConsortiaPveDmgRankInfos', { info: list, order: (list.find(x => x.userId === p.id) || {}).rank || 0, date: ctx.sysTime() });
      }
      log(`[#${c.id}] guild pve op ${msg.op} not implemented`);
    },
  };
};
