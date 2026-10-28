// Minas de Tesouro (mapa 5, t_s_mapphysicposition Type 2). Cliente: OuterCityTreasureWnd /
// U_C_TREASURE_MINE_INFO (4741). Ataque: U_C_ARMY_ATTACK só com mapId/posX/posY (sem nodeId).
// Estados (config mapphysicstreasure_*): 1 reset, 2 paz, 3 guerra (pode atacar/ocupar).
const store = require('../../store');
const MAP = 5, HOUR = 3600000;

module.exports = (ctx) => {
  const { dec, sendT, table, alert, chat, online, playerById, sendCastle, log, CONF } = ctx;
  const PHYSIC = new Map(table('t_s_physic').map(r => [Number(r.Id), r]));
  const SITES = table('t_s_mapphysicposition').filter(r => Number(r.Type) === 2 && PHYSIC.has(Number(r.PhysicId))).map(r => {
    const ph = PHYSIC.get(Number(r.PhysicId));
    return {
      id: Number(r.PhysicId), templateId: Number(r.ID), x: Number(ph.PosX), y: Number(ph.PosY),
      mapId: Number(ph.MapId) || MAP, type: 2, grade: Number(r.Grade) || 50,
      heroes: r.Heroes || '', soldiers: r.Soldiers || '', bonus: Number(r.Property1) || 40,
      name: r.Name_pt || r.Name_en || `Mina ${r.ID}`,
    };
  });
  const BY_POS = new Map(SITES.map(s => [`${s.x},${s.y}`, s]));
  const BY_ID = new Map(SITES.map(s => [s.id, s]));
  const state = store.getMeta('treasureMines', { slots: {} }); // physicId -> { playerId, since, paid }
  const save = () => store.setMeta('treasureMines', state);

  const parseWindows = key => String(CONF.str(key) || '').split('|').filter(Boolean).map(s => {
    const [a, b] = s.split(',').map(x => x.split(':').map(Number));
    return { from: (a[0] || 0) * 60 + (a[1] || 0), to: (b[0] || 0) * 60 + (b[1] || 0) };
  });
  const RESET = parseWindows('mapphysicstreasure_Reset_time');
  const WAR = parseWindows('mapphysicstreasure_Warfare_time');
  const PEACE = parseWindows('mapphysicstreasure_peace_time');
  const inWin = (wins, min) => wins.some(w => w.from <= w.to ? (min >= w.from && min <= w.to) : (min >= w.from || min <= w.to));
  const minutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const phaseCal = () => {
    const m = minutes();
    if (inWin(RESET, m)) return 1;
    if (inWin(WAR, m)) return 3;
    if (inWin(PEACE, m)) return 2;
    return 2;
  };
  const phase = () => {
    const f = ctx.events && ctx.events.force('treasureMine');
    if (f === false) return 2;
    if (f === true) return 3;
    return phaseCal();
  };
  if (ctx.events) ctx.events.register('treasureMine', () => phaseCal() === 3);

  const endOfPhase = () => {
    const m = minutes(), ph = phase();
    const wins = ph === 1 ? RESET : ph === 3 ? WAR : PEACE;
    const hit = wins.find(w => w.from <= w.to ? (m >= w.from && m <= w.to) : (m >= w.from || m <= w.to));
    const d = new Date();
    if (!hit) { d.setHours(23, 59, 59, 0); return Math.floor(d.getTime() / 1000); }
    d.setHours(Math.floor(hit.to / 60), hit.to % 60, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return Math.floor(d.getTime() / 1000);
  };

  const nameOf = pid => { const p = playerById(pid); return p ? p.s.nickName : ''; };
  const guildOf = pid => {
    const p = playerById(pid); if (!p || !ctx.guildOf) return { id: 0, name: '' };
    const g = ctx.guildOf(p); return g ? { id: g.id || 0, name: g.name || '' } : { id: 0, name: '' };
  };

  function settle(pid, quiet) {
    let gold = 0;
    const now = Date.now();
    for (const [id, s] of Object.entries(state.slots)) {
      if (s.playerId !== pid) continue;
      const site = BY_ID.get(Number(id)); if (!site) continue;
      const rate = Math.max(500, site.bonus * 100);
      const amount = Math.floor((now - s.paid) / HOUR * rate);
      if (amount > 0) { gold += amount; s.paid += Math.floor(amount / rate * HOUR); }
    }
    if (!gold) return 0;
    const p = playerById(pid); if (!p) return 0;
    p.s.gold = (p.s.gold || 0) + gold; p.save(); save();
    const c = online.get(pid);
    if (c) { sendCastle(c); if (!quiet) chat(c, `Renda da Mina de Tesouro: Ouro x${gold.toLocaleString('en-US')}`); }
    return gold;
  }
  ctx.onLoad.push(c => settle(c.player.id, true));

  function landMsg(site) {
    const s = state.slots[site.id], g = s ? guildOf(s.playerId) : null;
    return {
      id: site.id, mapId: site.mapId, posX: site.x, posY: site.y, templateId: site.templateId, type: 2, state: 1,
      occupyPlayerId: s ? s.playerId : 0, occupyPlayerName: s ? nameOf(s.playerId) : '',
      occupyGuildId: g ? g.id : 0, occupyGuildName: g ? g.name : '',
    };
  }
  function infoMsg(c) {
    const p = c.player, st = p.s.treasureMine = p.s.treasureMine || {};
    return {
      minerals: SITES.map(landMsg), consortiaMinerals: [],
      state: phase(), stateEndTime: endOfPhase(),
      failCount: st.failCount || 0, skipCount: st.skipCount || 0,
      sumCD: st.cdUntil && st.cdUntil > Date.now() / 1000 ? Math.floor(st.cdUntil) : 0,
      isDeath: !!st.isDeath,
    };
  }
  const sendInfo = c => sendT(c, 4741, 'treasuremine.TreasureMineMsg', infoMsg(c));
  const broadcast = () => { for (const c of online.values()) if (c.player) sendInfo(c); };
  ctx.onLoad.push(c => { settle(c.player.id, true); sendInfo(c); });

  function take(c, site) {
    const p = c.player, old = state.slots[site.id];
    if (old && old.playerId === p.id) { alert(c, 'Esta mina já é sua'); return; }
    const held = Object.values(state.slots).filter(s => s.playerId === p.id).length;
    if (held >= 2) { alert(c, 'Limite de Minas de Tesouro ocupadas atingido'); return; }
    if (old) settle(old.playerId, true);
    state.slots[site.id] = { playerId: p.id, since: Date.now(), paid: Date.now() };
    save();
    alert(c, `${site.name} ocupada (+${site.bonus}% recursos)`);
    if (old) { const oc = online.get(old.playerId); if (oc) alert(oc, `${p.s.nickName} tomou sua ${site.name}`); }
    broadcast();
    log(`[#${c.id}] treasure mine ${site.id} taken${old ? ' from ' + old.playerId : ''}`);
  }

  ctx.attackTreasure = (c, msg) => {
    if ((msg.mapId || MAP) !== MAP) return false;
    const site = BY_POS.get(`${msg.posX},${msg.posY}`);
    if (!site) return false;
    if (c.battle) return true;
    if (phase() !== 3) { alert(c, 'Mina de Tesouro fora do horário de guerra'); sendInfo(c); return true; }
    const p = c.player, holder = state.slots[site.id];
    if (holder && holder.playerId === p.id) { alert(c, 'Esta mina já é sua'); return true; }
    const cd = (p.s.treasureMine || {}).cdUntil || 0;
    if (cd > Date.now() / 1000) { alert(c, 'Aguarde o tempo de espera da Mina de Tesouro'); return true; }
    const onEnd = won => {
      if (!won) {
        const st = p.s.treasureMine = p.s.treasureMine || {};
        st.failCount = (st.failCount || 0) + 1;
        st.cdUntil = Date.now() / 1000 + (Number(CONF.str('mapphysicstreasure_cd')) || 30);
        p.save(); sendInfo(c); alert(c, 'Ataque falhou'); return;
      }
      take(c, site);
    };
    const opp = holder && playerById(holder.playerId);
    if (opp) ctx.startPvp(c, opp, { onEnd, scene: 1 });
    else ctx.startBattle(c, { Soldiers: site.soldiers, Heros: site.heroes, BattleType: 1, mapTempId: MAP, Level: site.grade, onEnd });
    return true;
  };

  // when phase leaves warfare, clear occupations after reset window starts
  let lastPhase = phase();
  const tick = setInterval(() => {
    try {
      const ph = phase();
      if (ph !== lastPhase) {
        if (ph === 1) { state.slots = {}; save(); }
        lastPhase = ph; broadcast();
      }
    } catch (e) { log('treasure mine tick: ' + e.message); }
  }, 15000);
  if (tick.unref) tick.unref();

  return {
    C_TREASURE_MINE_LIVE(c, body) {
      const m = dec(c, 'C_TREASURE_MINE_LIVE', body), p = c.player, st = p.s.treasureMine = p.s.treasureMine || {};
      const left = Math.max(0, (st.cdUntil || 0) - Date.now() / 1000);
      if (left <= 0) return sendInfo(c);
      const spend = String(CONF.str('mapphysicstreasure_cd_accelerate_spend') || '10,20,30').split(',').map(Number);
      const price = spend[Math.min(st.skipCount || 0, spend.length - 1)] || 30;
      const bound = m.payType === 0 && ctx.balance(p, -500) >= price;
      if (!ctx.pay(c, [[bound ? -500 : -400, price]])) { alert(c, 'Diamantes insuficientes'); return sendInfo(c); }
      st.cdUntil = 0; st.skipCount = (st.skipCount || 0) + 1; p.save(); sendInfo(c);
    },
    C_TREASURE_MINE_UNOCCP(c, body) {
      const m = dec(c, 'C_TREASURE_MINE_UNOCCP', body), p = c.player;
      const id = m.orderId || m.nodeId;
      const site = BY_ID.get(id) || SITES.find(s => s.templateId === id);
      if (!site || !state.slots[site.id] || state.slots[site.id].playerId !== p.id) return;
      settle(p.id); delete state.slots[site.id]; save();
      alert(c, `${site.name} abandonada`); broadcast();
    },
  };
};
