// Ustalık (专精; client mastery window "Bag.masterySoul"; t_s_extrajob, t_s_extrajobequip, t_s_extrajobequipstrengthen;
// config ExtraJob_*). Client-derived, no capture:
//  Jobs (JobType 41..44, levels 1..80): C_EXTRAJOB_REQ {op, jobType}: 1 activate (level 1; how many may be active
//  depends on the total job level, ExtraJob_CountActive "0,15,30"), 2 level up (the next row's CostGold +
//  CostItemId x CostItemCount, hero level >= NeedPlayerLevel, total job level >= NeedTotalJobLevel), 3 reset
//  everything -> 449 U_EXTRAJOB_LIST ExtraJobMsg {op, activeList [{jobType, jobLevel, skillScript}]}.
//  A job's skills are the t_s_skilltemplate rows of MasterType = jobType: per Index, the highest grade whose
//  NeedPlayerGrade (= job level) is reached; passives (UseWay 2) add their t_s_skillpropertytemplate values as
//  percentages ("Fiziksel saldırı %N artar") -> p.s.addsPct.mastery.
//  Soul equipment (EquipType 1..6): C_EXTRAJOBEQUIP_REQ {op, equipType, bagType, bagPos, pos}: 1 activate (level 1),
//  2 advance (next EquipLevel row's cost; total job level >= NeedTotalJobLevel), 3 strengthen (next StrengthenLevel
//  row with NeedEquipLevel <= level: cost; ExtraPropertyPercent of the equipment's own values), 4 put a gem from the
//  bag in hole pos (holes open at equipment level ExtraJob_EquipGemOpen "2,3,4,5"; one gem of a kind), 5 take one
//  out -> 450 U_EXTRAJOB_EQUIP_LIST {equipList [{equipType, equipLevel, strengthenLevel, join1..4}]}. Equipment and
//  gem values are flat (p.s.adds.mastery). Another player's view: 451 (viewother.js answers with this data).
// Our choices: resetting refunds every gold / item spent on job levels; the active skills (Index 2.., UseWay 1) are
// listed in skillScript but not added to the battle skill bar.
module.exports = (ctx) => {
  const { D, table, dec, sendT, alert, pay, grant, CONF, M } = ctx;
  const JOBS = table('t_s_extrajob'), EQ = table('t_s_extrajobequip'), STR = table('t_s_extrajobequipstrengthen');
  const PROPS = new Map(table('t_s_skillpropertytemplate').map(r => [r.TemplateId, r]));
  const E = require('../equip');
  const ACTIVE_NEED = String(CONF.str('ExtraJob_CountActive') || '0,15,30').split(',').map(Number);
  const GEM_OPEN = String(CONF.str('ExtraJob_EquipGemOpen') || '2,3,4,5').split(',').map(Number);
  const jobRow = (type, lv) => JOBS.find(r => r.JobType === type && r.JobLevel === lv);
  const eqRow = (type, lv) => EQ.find(r => r.EquipType === type && r.EquipLevel === lv);
  const state = p => (p.s.mastery = p.s.mastery || { jobs: {}, equips: {}, spent: [] });
  const total = s => Object.values(s.jobs).reduce((n, v) => n + v, 0);

  function skillsOf(type, lv) {
    const best = {};
    for (const s of D.skills.values()) if (s.MasterType === type && (s.NeedPlayerGrade || 0) <= lv) { const b = best[s.Index]; if (!b || s.Grades > b.Grades) best[s.Index] = s; }
    return Object.values(best);
  }
  function restat(p) {
    const s = state(p), pct = {}, flat = {};
    const KEYS = { Attack: 'attack', MagicAttack: 'magicAttack', Defence: 'defence', MagicDefence: 'magicDefence', Live: 'live' };
    for (const [type, lv] of Object.entries(s.jobs)) for (const sk of skillsOf(Number(type), lv)) {
      if (sk.UseWay !== 2) continue;
      const pr = PROPS.get(sk.TemplateId) || {};
      for (const [k, key] of Object.entries(KEYS)) if (pr[k]) pct[key] = (pct[key] || 0) + pr[k];
    }
    for (const [type, e] of Object.entries(s.equips)) {
      const row = eqRow(Number(type), e.level), sr = STR.find(r => r.StrengthenLevel === e.str) || {};
      if (row) for (const k of Object.keys(KEYS)) if (row[k]) flat[k] = (flat[k] || 0) + row[k] + Math.floor(row[k] * (sr.ExtraPropertyPercent || 0) / 100);
      const x = E.extras({ joins: e.joins.filter(Boolean) }, 0);
      for (const k of Object.keys(KEYS)) if (x[k]) flat[k] = (flat[k] || 0) + x[k];
    }
    (p.s.addsPct = p.s.addsPct || {}).mastery = pct;
    (p.s.adds = p.s.adds || {}).mastery = flat;
  }
  const jobMsg = (p, op = 0) => ({ op, activeList: Object.entries(state(p).jobs).map(([type, lv]) => ({ jobType: Number(type), jobLevel: lv, skillScript: skillsOf(Number(type), lv).map(s => s.TemplateId).join(',') })) });
  const equipMsg = (p, op = 0) => ({ op, equipList: Object.entries(state(p).equips).map(([type, e]) => ({ equipType: Number(type), equipLevel: e.level, strengthenLevel: e.str, join1: e.joins[0] || 0, join2: e.joins[1] || 0, join3: e.joins[2] || 0, join4: e.joins[3] || 0 })) });
  ctx.masteryView = p => Object.assign({ activeList: jobMsg(p).activeList }, { equipList: equipMsg(p).equipList });   // viewother.js 451
  ctx.onLoad.push(c => { restat(c.player); sendT(c, 449, 'extrajob.ExtraJobMsg', jobMsg(c.player)); sendT(c, 450, 'extrajob.ExtraJobEquipMsg', equipMsg(c.player)); });
  const costOf = r => { const l = []; if (r.CostItemId && r.CostItemCount) l.push([r.CostItemId, r.CostItemCount]); if (r.CostGold) l.push([-100, r.CostGold]); return l; };
  const done = (c, msg) => { const p = c.player; restat(p); p.save(); ctx.sendPlayer(c); ctx.sendArmy(c); if (msg) alert(c, msg); };

  return {
    C_EXTRAJOB_REQ(c, body) {
      const m = dec(c, 'C_EXTRAJOB_REQ', body), p = c.player, s = state(p);
      if (m.op === 1) {
        const row = jobRow(m.jobType, 1);
        if (!row || s.jobs[m.jobType]) return sendT(c, 449, 'extrajob.ExtraJobMsg', jobMsg(p, 1));
        const n = Object.keys(s.jobs).length;
        if (n >= ACTIVE_NEED.length || total(s) < ACTIVE_NEED[n]) { alert(c, `Nível total de maestria para a próxima maestria ${ACTIVE_NEED[n] ?? '-'} necessário`); return sendT(c, 449, 'extrajob.ExtraJobMsg', jobMsg(p, 1)); }
        if (p.s.grades < (row.NeedPlayerLevel || 0)) { alert(c, `Karakter Lv. ${row.NeedPlayerLevel} necessário`); return sendT(c, 449, 'extrajob.ExtraJobMsg', jobMsg(p, 1)); }
        s.jobs[m.jobType] = 1; done(c);
      } else if (m.op === 2) {
        const lv = s.jobs[m.jobType], row = lv && jobRow(m.jobType, lv + 1);
        if (!row) { alert(c, 'Já está no nível máximo'); return sendT(c, 449, 'extrajob.ExtraJobMsg', jobMsg(p, 2)); }
        if (p.s.grades < (row.NeedPlayerLevel || 0)) { alert(c, `Personagem Lv. ${row.NeedPlayerLevel} necessário`); return sendT(c, 449, 'extrajob.ExtraJobMsg', jobMsg(p, 2)); }
        if (total(s) < (row.NeedTotalJobLevel || 0)) { alert(c, `Nível total de maestria ${row.NeedTotalJobLevel} necessário`); return sendT(c, 449, 'extrajob.ExtraJobMsg', jobMsg(p, 2)); }
        const cost = costOf(row);
        if (!pay(c, cost)) { alert(c, 'Ouro ou material insuficiente'); return sendT(c, 449, 'extrajob.ExtraJobMsg', jobMsg(p, 2)); }
        s.spent.push(...cost); s.jobs[m.jobType] = lv + 1; done(c);
      } else if (m.op === 3) {
        const back = {}; for (const [id, n] of s.spent) back[id] = (back[id] || 0) + n;
        grant(c, Object.entries(back).map(([id, n]) => [Number(id), n]));
        s.jobs = {}; s.spent = []; done(c, 'Maestrias reiniciadas; recursos gastos foram devolvidos');
      }
      sendT(c, 449, 'extrajob.ExtraJobMsg', jobMsg(p, m.op));
    },
    C_EXTRAJOBEQUIP_REQ(c, body) {
      const m = dec(c, 'C_EXTRAJOBEQUIP_REQ', body), p = c.player, s = state(p), e = s.equips[m.equipType];
      const reply = () => sendT(c, 450, 'extrajob.ExtraJobEquipMsg', equipMsg(p, m.op));
      switch (m.op) {
        case 1: {
          const row = eqRow(m.equipType, 1);
          if (!row || e) return reply();
          if (total(s) < (row.NeedTotalJobLevel || 0)) { alert(c, `Nível total de maestria ${row.NeedTotalJobLevel} necessário`); return reply(); }
          if (!pay(c, costOf(row))) { alert(c, 'Ouro ou material insuficiente'); return reply(); }
          s.equips[m.equipType] = { level: 1, str: 0, joins: [0, 0, 0, 0] }; break;
        }
        case 2: {
          const row = e && eqRow(m.equipType, e.level + 1);
          if (!row) { alert(c, 'No estágio máximo'); return reply(); }
          if (total(s) < (row.NeedTotalJobLevel || 0)) { alert(c, `Nível total de maestria ${row.NeedTotalJobLevel} necessário`); return reply(); }
          if (!pay(c, costOf(row))) { alert(c, 'Ouro ou material insuficiente'); return reply(); }
          e.level++; break;
        }
        case 3: {
          const row = e && STR.find(r => r.StrengthenLevel === e.str + 1);
          if (!row) { alert(c, 'No aprimoramento máximo'); return reply(); }
          if (e.level < (row.NeedEquipLevel || 0)) { alert(c, `Equipamento no estágio ${row.NeedEquipLevel} necessário`); return reply(); }
          if (!pay(c, costOf(row))) { alert(c, 'Ouro ou material insuficiente'); return reply(); }
          e.str++; break;
        }
        case 4: {
          const k = (m.pos || 1) - 1, it = e && p.itemAt(m.bagPos, m.bagType || 1), tp = it && D.items.get(it.templateId);
          if (!tp || k < 0 || k > 3) return reply();
          if (e.level < (GEM_OPEN[k] || 99)) { alert(c, `Este espaço abre no estágio ${GEM_OPEN[k]}`); return reply(); }
          if (e.joins.some((id, j) => j !== k && id && (D.items.get(id) || {}).Property1 === tp.Property1)) { alert(c, 'Uma joia deste tipo já está equipada'); return reply(); }
          const entries = [];
          if (e.joins[k]) for (const x of p.addItem(e.joins[k], 1)) entries.push(M.movedEntry(p, x));
          e.joins[k] = tp.TemplateId; p.removeItem(it, 1); entries.push(M.movedEntry(p, it, it.count <= 0));
          ctx.sendItems(c, entries); break;
        }
        case 5: {
          const k = (m.pos || 1) - 1;
          if (!e || !e.joins[k]) return reply();
          ctx.sendItems(c, p.addItem(e.joins[k], 1).map(x => M.movedEntry(p, x)));
          e.joins[k] = 0; break;
        }
        default: return reply();
      }
      done(c);
      reply();
    },
  };
};
