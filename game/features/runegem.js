// Pedras de runa ve rün yuvaları (Beceri penceresi; OpenRuneGrade 35). Everything below is client-derived (no
// capture of this system):
//  Energy: t_s_config runehole_spot "10,30,200": +10 every 30 minutes up to 200 (start full: assumption);
//   Sembol Enerjisi items (SonType 402) add Property1. PlayerMsg.runePowerPoint.
//  Draws C_LOTTERY_RUNE {op 1 info, 2 one, 3 ten}: runehole_spot_use (10) energy each, one gem per free rune
//   bag cell; drop 300000 (combat gems, quality 1..5), and every runehole_special_add (20) points towards 1000
//   the special drop 300001 (purple / orange; drop condition 300 Para2 1000) instead, points back to 0.
//   Answer 4742 LotteryRuneRspMsg {powerPointNum, runePointNum, leftTime}.
//  Rune bag (hr.RUNE 25): runehole_bag "80,160" cells; U_C_BAG_BUY type 1 buys rows of runehole_bag_buy
//   "8,30" (8 cells for 8 x 30 diamonds; PlayerMsg.runeCount = bought cells). Gems are items (SonType 411-415
//   primary, 421-425 combat; Profile = quality, Property1 = attribute 1..19), player.js addItem puts them here.
//  Gem level (ItemMsg strengthenGrade, gp): C_RUNE_UP {pos, id, runeNum, bagType} spends Fragmento de Símbolo
//   (-1000, PlayerMsg.runeNum) as gp; t_s_upgradetemplate Types 200 (TemplateId = SonType) Data = gp for the
//   next level, gp starts again at 0 (client RuneGemUpgradeWnd: need = Data(grade + 1) - gp; resolve sums
//   Data(1..grade)). Level 0 = item template stats, level g = t_s_runegem (Types SonType, Grades g, RuneGemTypes).
//  Resolve C_RUNE_RESOLVE {pos: "1,2,.."}: Fragmento de Símbolo = floor((Property2 / Refresh.Property2 + sum
//   Data(1..grade)) x runehole_decompose / 100) (client onRecvResolve); answer 4260 (empty).
//  Holes: 10, hole i opens at RuneHole_OpenLevel[i-1]. RuneHoleInfoMsg {holeId, grade, skill, tempSkillId, pos:
//   "a,b,c,d,e"} with 0 = locked slot, -1 = open and empty, else the gem's item id (bag RUNE_EQUIP 26).
//   C_RUNE_HOLE_OP {holeId, op, opPos}: 3 open slot opPos (RuneOpen_Cost "0,0,0,1,3" Soket Delici 4010001;
//   cost-0 slots open with the hole: assumption), 1 engrave (Effect_Engraving_Cost 5; a random rune effect
//   from t_s_runeactivation as tempSkillId; weights by effect grade 50/25/13/8/4: assumption), 4 keep it as
//   skill, 2 hole level up (t_s_upgradetemplate Types 201: Data Soket Delici, bonus TemplateId %). 1 and 2 need
//   every slot opened (client checkOpenAllRune).
//  C_EQUIP_RUNE_STOME {runeId hole, runeIndex 1..5, beginPos rune bag pos} (an occupied slot swaps),
//  C_RUNE_UNLOAD {runeId hole, index 1..5 or 101 = all}.
//  Stats: per hole, each attribute summed over its gems + floor(value x bonus) (client HoldOptionlCom); the
//  effect skills (passives 910xx) are not applied in fights (no passive skills in battle.js).
const { RUNE_BAG_TYPE } = require('../player');
const RUNE_EQUIP = 26, SOCKET_DRILL = 4010001, FRAGMENT = -1000, HOLES = 10, SLOTS = 5, ALL = 101;
const KEYS = ['Power', 'Agility', 'Intellect', 'Physique', 'Captain', 'Attack', 'MagicAttack', 'Defence', 'MagicDefence', 'Live', 'ForceHit', 'Parry'];
const ENGRAVE_WEIGHT = { 1: 50, 2: 25, 3: 13, 4: 8, 5: 4 };

module.exports = (ctx) => {
  const { D, dec, sendT, sendRaw, sendItems, sendPlayer, alert, grant, pay, CONF, DROPS, table, M, log } = ctx;
  const cfg = name => String((table('t_s_config').find(r => r.ConfigName === name) || {}).ConfigValue || '');
  const nums = name => cfg(name).split(',').map(Number);
  const [ADD, MIN, MAX] = nums('runehole_spot').length === 3 ? nums('runehole_spot') : [10, 30, 200];
  const STEP = MIN * 60 * 1000, USE = CONF.get('runehole_spot_use') || 10, SPECIAL_ADD = CONF.get('runehole_special_add') || 20;
  const [BAG_BASE, BAG_MAX] = nums('runehole_bag'), [ROW, ROW_PRICE] = nums('runehole_bag_buy');
  const DECOMPOSE = (CONF.get('runehole_decompose') || 100) / 100;
  const OPEN_LEVEL = nums('RuneHole_OpenLevel'), OPEN_COST = nums('RuneOpen_Cost'), ENGRAVE_COST = CONF.get('Effect_Engraving_Cost') || 5;
  const OPEN_GRADE = CONF.get('OpenRuneGrade') || 35;
  const UP = table('t_s_upgradetemplate');
  const gemUp = new Map();   // SonType -> [Data for level 1, 2, ...]
  for (const r of UP.filter(r => r.Types === 200).sort((a, b) => a.Grades - b.Grades)) { if (!gemUp.has(r.TemplateId)) gemUp.set(r.TemplateId, []); gemUp.get(r.TemplateId).push(r.Data); }
  const holeUp = UP.filter(r => r.Types === 201).sort((a, b) => a.Grades - b.Grades);
  const GEM = new Map(table('t_s_runegem').map(r => [`${r.Types}_${r.Grades}_${r.RuneGemTypes}`, r]));
  const EFFECTS = table('t_s_runeactivation');

  // ---- state ----
  function energy(p) {
    const e = p.s.runeEnergy = p.s.runeEnergy || { val: MAX, t: Date.now() };
    if (e.val >= MAX) { e.t = Date.now(); return e; }
    const n = Math.floor((Date.now() - e.t) / STEP);
    if (n > 0) { e.val = Math.min(MAX, e.val + n * ADD); e.t += n * STEP; }
    return e;
  }
  function state(p) {
    const r = p.s.runeGem = p.s.runeGem || { bought: 0, point: p.s.runePoint || 0, holes: {} };
    // holes the level has opened; cost-0 slots open with them
    for (let h = 1; h <= HOLES; h++) {
      if (r.holes[h] || p.s.grades < (OPEN_LEVEL[h - 1] || 999)) continue;
      r.holes[h] = { grade: 0, skill: 0, temp: 0, slots: OPEN_COST.slice(0, SLOTS).map(x => (x || 0) === 0 ? -1 : 0) };
    }
    return r;
  }
  const holeMsg = (h, x) => ({ id: h, holeId: h, exp: 0, grade: x.grade, skill: x.skill, tempSkillId: x.temp, pos: x.slots.join(',') });
  const sendHoles = c => sendT(c, 4980, 'army.RuneHoleAllInfoMsg', { info: Object.entries(state(c.player).holes).map(([h, x]) => holeMsg(Number(h), x)) });
  function info(c) {
    const e = energy(c.player);
    sendT(c, 4742, 'army.LotteryRuneRspMsg', { powerPointNum: e.val, runeChipNum: 0, runePointNum: state(c.player).point || 0,
      leftTime: e.val >= MAX ? -1 : Math.ceil((e.t + STEP - Date.now()) / 1000) });
  }
  const fragments = p => (p.s.currency || {})[FRAGMENT] || 0;
  const addFragments = (p, n) => { (p.s.currency = p.s.currency || {})[FRAGMENT] = fragments(p) + n; };
  const gemsIn = (p, bt) => p.s.bag.filter(i => i.bagType === bt);

  // one gem's attributes: level 0 the item template, else t_s_runegem
  function gemStats(it) {
    const tp = D.items.get(it.templateId); if (!tp) return {};
    const g = it.strengthenGrade || 0, row = g ? GEM.get(`${tp.SonType}_${g}_${tp.Property1}`) : tp;
    return Object.fromEntries(KEYS.map(k => [k, (row && row[k]) || 0]));
  }
  const bonus = x => { const u = holeUp[x.grade - 1]; return u ? u.TemplateId / 100 : 0; };
  // cached for player.js stats()
  function recalc(p) {
    const r = state(p), add = Object.fromEntries(KEYS.map(k => [k, 0]));
    for (const x of Object.values(r.holes)) {
      const sum = Object.fromEntries(KEYS.map(k => [k, 0]));
      for (const id of x.slots) { const it = id > 0 && p.s.bag.find(i => i.id === id && i.bagType === RUNE_EQUIP); if (it) for (const [k, v] of Object.entries(gemStats(it))) sum[k] += v; }
      for (const k of KEYS) add[k] += sum[k] + Math.floor(sum[k] * bonus(x));
    }
    r.add = add;
  }
  function changed(c, entries = []) {
    const p = c.player;
    recalc(p);
    sendItems(c, entries);
    sendHoles(c);
    sendPlayer(c);
    if (ctx.sendArmy) ctx.sendArmy(c);
    p.save();
  }
  const pick = list => { let x = Math.random() * list.reduce((n, [, w]) => n + w, 0); for (const [v, w] of list) { x -= w; if (x < 0) return v; } return list[list.length - 1][0]; };
  const drills = p => p.countTemplate(SOCKET_DRILL);
  function useDrills(c, n) {
    const p = c.player;
    if (drills(p) < n) return false;
    if (n > 0) sendItems(c, p.takeTemplate(SOCKET_DRILL, n).map(it => M.movedEntry(p, it, it.count <= 0)));
    return true;
  }

  ctx.onLoad.push(c => { if (c.player.s.grades >= OPEN_GRADE) { state(c.player); recalc(c.player); } });

  // Sembol Enerjisi: Property1 energy each (may go past the natural 200)
  ctx.useItem[402] = (c, it, tp, n) => {
    const p = c.player, e = energy(p);
    e.val += (tp.Property1 || 0) * n;
    p.removeItem(it, n);
    sendItems(c, [M.movedEntry(p, it, it.count <= 0)]);
    p.save(); sendPlayer(c); info(c);
    alert(c, `Parabéns, obtido: Sembol Enerjisi ${(tp.Property1 || 0) * n}`);
  };
  // rune bag rows (bag.js U_C_BAG_BUY type 1)
  ctx.buyRuneBag = (c, m) => {
    const p = c.player, r = state(p), rows = Math.max(1, m.property1 || 1);
    if (BAG_BASE + r.bought + rows * ROW > BAG_MAX) { alert(c, 'Mochila de runas no tamanho máximo'); return; }
    const cost = rows * ROW * ROW_PRICE, bound = m.payType === 0 && ctx.balance(p, -500) >= cost;
    if (!pay(c, [[bound ? -500 : -400, cost]])) { alert(c, 'Diamantes insuficientes'); return; }
    r.bought += rows * ROW; p.save(); sendPlayer(c);
    alert(c, `Mochila de runas recebeu ${rows * ROW} espaços adicionais`);
  };

  return {
    C_LOTTERY_RUNE(c, body) {
      const m = dec(c, 'C_LOTTERY_RUNE', body), p = c.player;
      if (m.op === 2 || m.op === 3) {
        if (p.s.grades < OPEN_GRADE) { alert(c, `Pedras de runa ${OPEN_GRADE}. libera no nível`); return info(c); }
        const r = state(p), e = energy(p), free = p.runeBagSize - gemsIn(p, RUNE_BAG_TYPE).length;
        const n = Math.min(m.op === 2 ? 1 : 10, free, Math.floor(e.val / USE));
        if (free <= 0) { alert(c, 'Mochila de runas cheia'); return info(c); }
        if (n <= 0) { alert(c, 'Sembol Enerjisi insuficiente'); return info(c); }
        const got = [];
        for (let i = 0; i < n; i++) {
          r.point = (r.point || 0) + SPECIAL_ADD;
          const drop = r.point >= 1000 ? 300001 : 300000;
          if (drop === 300001) r.point = 0;
          got.push(...DROPS.roll(drop));
        }
        e.val -= n * USE;
        grant(c, got, { quiet: true });
        log(`[#${c.id}] rune draw x${n}: ${got.map(([t]) => t).join(' ')}`);
      }
      info(c);
    },
    C_RUNE_HOLE_INFO(c) { if (c.player.s.grades >= OPEN_GRADE) sendHoles(c); },

    C_EQUIP_RUNE_STOME(c, body) {
      const m = dec(c, 'C_EQUIP_RUNE_STOME', body), p = c.player, x = state(p).holes[m.runeId], k = m.runeIndex - 1;
      const gem = p.itemAt(m.beginPos, RUNE_BAG_TYPE);
      if (!x || !gem || k < 0 || k >= SLOTS) return;
      if (x.slots[k] === 0) { alert(c, 'Este espaço está bloqueado'); return; }
      const entries = [{ changeType: RUNE_BAG_TYPE, changeObjId: 0, changePos: gem.pos }];
      const old = x.slots[k] > 0 && p.s.bag.find(i => i.id === x.slots[k] && i.bagType === RUNE_EQUIP);
      if (old) {   // the gem in the slot goes to the freed cell
        entries.push({ changeType: RUNE_EQUIP, changeObjId: 0, changePos: old.pos });
        old.bagType = RUNE_BAG_TYPE; old.pos = gem.pos; entries.push(M.movedEntry(p, old));
      }
      gem.bagType = RUNE_EQUIP; gem.pos = m.runeId * 10 + k; gem.isNew = false;
      x.slots[k] = gem.id;
      entries.push(M.movedEntry(p, gem));
      changed(c, entries);
    },
    C_RUNE_UNLOAD(c, body) {
      const m = dec(c, 'C_RUNE_UNLOAD', body), p = c.player, x = state(p).holes[m.runeId];
      if (!x) return;
      const ks = m.index === ALL ? [0, 1, 2, 3, 4] : [m.index - 1];
      const entries = [];
      for (const k of ks) {
        const it = x.slots[k] > 0 && p.s.bag.find(i => i.id === x.slots[k] && i.bagType === RUNE_EQUIP);
        if (!it) continue;
        const pos = p.freePos(RUNE_BAG_TYPE);
        if (pos < 0) { alert(c, 'Mochila de runas cheia'); break; }
        entries.push({ changeType: RUNE_EQUIP, changeObjId: 0, changePos: it.pos });
        it.bagType = RUNE_BAG_TYPE; it.pos = pos; x.slots[k] = -1;
        entries.push(M.movedEntry(p, it));
      }
      if (entries.length) changed(c, entries);
    },
    C_RUNE_UP(c, body) {
      const m = dec(c, 'C_RUNE_UP', body), p = c.player;
      const it = p.s.bag.find(i => i.id === m.id && (i.bagType === RUNE_BAG_TYPE || i.bagType === RUNE_EQUIP));
      const tp = it && D.items.get(it.templateId), steps = tp && gemUp.get(tp.SonType);
      if (!it || !steps) return;
      const g = it.strengthenGrade || 0;
      if (g >= steps.length) { alert(c, 'Pedra de runa no nível máximo'); return; }
      const toMax = steps.slice(g).reduce((n, d) => n + d, 0) - (it.gp || 0);
      const spend = Math.min(Math.max(0, m.runeNum || 0), toMax, fragments(p));
      if (spend <= 0) { alert(c, 'Fragmentos de Símbolo insuficientes'); return; }
      addFragments(p, -spend);
      it.gp = (it.gp || 0) + spend;
      while ((it.strengthenGrade || 0) < steps.length && it.gp >= steps[it.strengthenGrade || 0]) { it.gp -= steps[it.strengthenGrade || 0]; it.strengthenGrade = (it.strengthenGrade || 0) + 1; }
      if ((it.strengthenGrade || 0) >= steps.length) it.gp = 0;
      changed(c, [M.movedEntry(p, it)]);
      if (it.strengthenGrade > g) alert(c, `${ctx.nameOf(tp)} Lv. ${it.strengthenGrade} ficou`);
    },
    C_RUNE_RESOLVE(c, body) {
      const m = dec(c, 'C_RUNE_RESOLVE', body), p = c.player;
      const poss = String(m.pos || '').split(',').map(Number).filter(n => n >= 0 && String(m.pos).length);
      const entries = [];
      let total = 0;
      for (const pos of [...new Set(poss)]) {
        const it = p.itemAt(pos, RUNE_BAG_TYPE), tp = it && D.items.get(it.templateId);
        if (!tp) continue;
        const base = D.items.get(tp.Refresh) || { Property2: 1 }, steps = gemUp.get(tp.SonType) || [];
        total += Math.floor(((tp.Property2 || 0) / (base.Property2 || 1) + steps.slice(0, it.strengthenGrade || 0).reduce((n, d) => n + d, 0)) * DECOMPOSE);
        p.removeItem(it, it.count);
        entries.push(M.movedEntry(p, it, true));
      }
      if (!entries.length) return;
      addFragments(p, total);
      sendItems(c, entries);
      sendPlayer(c); p.save();
      sendRaw(c, 4260);
      alert(c, `Obtido: Fragmento de Símbolo x${total}`);
    },
    C_RUNE_HOLE_OP(c, body) {
      const m = dec(c, 'C_RUNE_HOLE_OP', body), p = c.player, x = state(p).holes[m.holeId];
      if (!x) { alert(c, 'Este espaço de runa ainda não abriu'); return; }
      const allOpen = x.slots.every(v => v !== 0);
      if (m.op === 3) {
        const k = (m.opPos || 0) - 1;
        if (k < 0 || k >= SLOTS || x.slots[k] !== 0) return;
        if (!useDrills(c, OPEN_COST[k] || 0)) { alert(c, 'Soket Delici insuficiente'); return; }
        x.slots[k] = -1;
      } else if (m.op === 1) {
        if (!allOpen) { alert(c, 'Abra todos os encaixes primeiro'); return; }
        if (!useDrills(c, ENGRAVE_COST)) { alert(c, 'Soket Delici insuficiente'); return; }
        x.temp = pick(EFFECTS.map(r => [r.SKillId, ENGRAVE_WEIGHT[r.SKillId % 10] || 1]));
      } else if (m.op === 4) {
        if (!x.temp) return;
        x.skill = x.temp; x.temp = 0;
      } else if (m.op === 2) {
        if (!allOpen) { alert(c, 'Abra todos os encaixes primeiro'); return; }
        const next = holeUp[x.grade];
        if (!next) { alert(c, 'Espaço no nível máximo'); return; }
        if (!useDrills(c, next.Data)) { alert(c, 'Soket Delici insuficiente'); return; }
        x.grade++;
      } else return;
      changed(c);
    },
  };
};
