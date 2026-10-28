// Yetenek ağacı (talent, Beceri penceresi; client ar.TALENT = Lv50). Client-derived, no capture:
//  Tree (client getAllTalentTemplateInfoByJob): t_s_skilltemplate MasterType 100 = the three seals (Index 10 /
//   20 / 30, SonType 1001..1003, level 1 owned from the start), MasterType 9 = common attribute talents
//   (Index x1..x4), MasterType 10 x job = job talents (Index x5..x7). Every level needs PreTemplateId (a talent
//   at that Index with at least that level) and NeedPlayerGrade = talent grade (client checkTalentUpgradeCondition).
//  Talent grade: C_HERO_TALENT_GRADE_UP -> t_s_upgradetemplate Types 21 (TemplateId gold, Data EXP of the
//   current level, Lv50 needed; client checkUpgrade) -> 4430 {upresult}. Points = talent grade - points spent
//   (client advanced talent: "talentGrade == talentPoint" = nothing spent).
//  Learning: C_HERO_SKILL_UPGRADE with a talent template (hero.js forwards it) -> 60 UpdatedSkillMsg type 1.
//  Reset: C_HERO_SKILLPOINT_RESET type 1 for talent_reset_gold (5000) x talent grade gold (client __washPoint).
//  Two pages: C_ACTIVE_SECONDTALENT {payType} opens the second for Second_talent (600) diamonds,
//   C_HERO_TALENT_CHANGE {index} switches; each page has its own talents and spent points.
//  C_TELENT_TREE {seal1 = branch shown}, C_TELENT_SORT {seal1..3 = seal order}. State -> 4431 HeroTalentMsg.
//  Stats: the common talents' values (Description_en "ATK +50", "HP +1%", PDEF, MDEF, Crit, Block) are added;
//  the seal / job talents are battle effects (buffs) not applied by battle.js.
const OPEN = 50, SEALS = [910001, 920001, 930001], SEAL_TYPES = [1001, 1002, 1003];
const STAT = { ATK: ['attack', 'magicAttack'], HP: ['live'], PDEF: ['defence'], MDEF: ['magicDefence'], Crit: ['forceHit'], 'Crit Value': ['forceHit'], Block: ['parry'], 'Block Value': ['parry'] };

module.exports = (ctx) => {
  const { D, dec, sendT, sendPlayer, sendArmy, alert, pay, table, CONF, log } = ctx;
  const SK = new Map(table('t_s_skilltemplate').map(r => [r.TemplateId, r]));
  const GRADE_UP = table('t_s_upgradetemplate').filter(r => r.Types === 21).sort((a, b) => a.Grades - b.Grades);
  const RESET_GOLD = CONF.get('talent_reset_gold') || 100, SECOND = CONF.get('Second_talent') || 600;
  const isTalent = (p, t) => {
    if (!t) return false;
    const mt = Number(t.MasterType), job = Number(p.s.job);
    return mt === 9 || mt === 100 || mt === 10 * job;
  };

  function state(p) {
    const s = p.s.talent = p.s.talent || { grade: 0, index: 0, second: false, pages: [{ skills: SEALS.slice(), spent: 0 }], seals: SEAL_TYPES.slice(), branch: 1002 };
    return s;
  }
  const page = s => s.pages[s.index] || s.pages[0];
  const msg = p => { const s = state(p), pg = page(s);
    return { userId: p.id, talentPoint: Math.max(0, s.grade - pg.spent), talentGrade: s.grade, talentSkill: pg.skills.join(','), currentBranch: s.branch,
      isActiveSecond: s.second, talentIndex: s.index, sealOrder: s.seals }; };
  const sendInfo = c => sendT(c, 4431, 'army.HeroTalentMsg', msg(c.player));
  // a talent at that Index with at least that level
  const owns = (pg, id) => {
    const t = SK.get(Number(id)) || SK.get(id); if (!t) return false;
    return pg.skills.some(x => {
      const o = SK.get(Number(x)) || SK.get(x);
      return o && Number(o.Index) === Number(t.Index) && Number(o.Grades) >= Number(t.Grades);
    });
  };

  // stat additions of the active page, cached for player.js stats()
  function recalc(p) {
    const flat = {}, pct = {};
    for (const id of page(state(p)).skills) {
      const t = SK.get(id); if (!t || t.MasterType !== 9) continue;
      const m = /^(ATK|HP|PDEF|MDEF|Crit Value|Crit|Block Value|Block) \+(\d+)(%?)/.exec(t.Description_en || '');
      if (!m) continue;
      for (const k of STAT[m[1]]) { const o = m[3] ? pct : flat; o[k] = (o[k] || 0) + Number(m[2]); }
    }
    state(p).add = { flat, pct };
  }
  function changed(c) { recalc(c.player); c.player.save(); sendInfo(c); sendPlayer(c); sendArmy(c); }

  ctx.onLoad.push(c => { if (c.player.s.grades >= OPEN) { recalc(c.player); sendInfo(c); } });

  // Walk NextTemplateId from `from` until `wantId` (inclusive). Returns the steps to learn, or null.
  // Client TalentItemTips stepper sends the *final* template once; official UX spends N points in one click.
  const climb = (pg, from, wantId) => {
    const steps = [];
    let cur = from;
    const seen = new Set();
    while (cur && Number(cur.TemplateId) !== Number(wantId)) {
      const nextId = Number(cur.NextTemplateId);
      if (!nextId || seen.has(nextId)) return null;
      seen.add(nextId);
      const next = SK.get(nextId) || D.skills.get(nextId);
      if (!next) return null;
      steps.push(next);
      cur = next;
    }
    if (!cur || Number(cur.TemplateId) !== Number(wantId)) return null;
    // `from` already owned: steps are the levels to buy. If from is null (first learn), want itself is step 1.
    return steps;
  };
  const canLearnStep = (p, s, pg, step, phantom) => {
    if (!isTalent(p, step)) return 'Este talento não pode ser aprendido';
    if ((step.NeedPlayerGrade || 0) > s.grade) return `Nível de talento ${step.NeedPlayerGrade} necessário`;
    const pre = String(step.PreTemplateId || '').split(',').map(Number).filter(Boolean);
    const ok = pid => owns(pg, pid) || phantom.has(pid) || [...phantom].some(id => {
      const o = SK.get(id) || D.skills.get(id), q = SK.get(pid) || D.skills.get(pid);
      return o && q && Number(o.Index) === Number(q.Index) && Number(o.Grades) >= Number(q.Grades);
    });
    if (!pre.every(ok)) return 'Aprenda o talento necessário primeiro';
    return null;
  };

  // hero.js C_HERO_SKILL_UPGRADE: true when it was a talent (MasterType 9 / 100 / 10×job)
  ctx.talentLearn = (c, id) => {
    const p = c.player, tid = Number(id), t = SK.get(tid) || SK.get(id) || D.skills.get(tid);
    if (!isTalent(p, t)) return false;
    if (p.s.grades < OPEN) { alert(c, `Talentos liberam no nível ${OPEN}`); return true; }
    const s = state(p), pg = page(s);
    const left = s.grade - pg.spent;
    if (left < 1) { alert(c, 'Pontos de talento insuficientes — suba o nível de talento primeiro'); return true; }

    const i = pg.skills.findIndex(sid => Number((SK.get(sid) || D.skills.get(sid) || {}).Index) === Number(t.Index));
    let steps;
    if (i >= 0) {
      const cur = SK.get(pg.skills[i]) || D.skills.get(pg.skills[i]);
      let wantId = Number(t.TemplateId);
      // Stuck tip re-sends the current level → climb one; stepper sends a higher Next* id → climb the chain.
      if (Number(cur.TemplateId) === wantId || Number(cur.Grades) >= Number(t.Grades)) {
        wantId = Number(cur.NextTemplateId);
        if (!wantId) { alert(c, 'Talento no nível máximo'); return true; }
      }
      steps = climb(pg, cur, wantId);
      if (!steps || !steps.length) { alert(c, 'Este não é o próximo nível deste talento'); return true; }
    } else {
      if (Number(t.Grades) !== 1) { alert(c, 'Aprenda o nível 1 deste talento primeiro'); return true; }
      steps = [t];
    }

    // Cap by remaining points (stepper max already does this client-side).
    if (steps.length > left) steps = steps.slice(0, left);
    const phantom = new Set(i >= 0 ? [Number(pg.skills[i])] : []);
    for (const step of steps) {
      const why = canLearnStep(p, s, pg, step, phantom);
      if (why) { alert(c, why); return true; }
      phantom.add(Number(step.TemplateId));
    }
    const target = steps[steps.length - 1];
    if (i >= 0) pg.skills[i] = Number(target.TemplateId);
    else pg.skills.push(Number(target.TemplateId));
    pg.spent += steps.length;
    sendT(c, 60, 'army.UpdatedSkillMsg', { templateId: Number(target.TemplateId), index: Number(target.Index), type: 1 });
    changed(c);
    log(`[#${c.id}] talent learn ${target.TemplateId} (+${steps.length}, grade ${s.grade}, spent ${pg.spent})`);
    return true;
  };
  // hero.js C_HERO_SKILLPOINT_RESET type 1
  ctx.talentReset = c => {
    const p = c.player, s = state(p), pg = page(s);
    if (!pg.spent) { alert(c, 'Nenhum talento para redefinir'); return; }
    const gold = RESET_GOLD * s.grade;
    if (!pay(c, [[-100, gold]])) { alert(c, 'Ouro insuficiente'); return; }
    pg.skills = SEALS.slice(); pg.spent = 0;
    sendT(c, 61, 'army.UpdatedSkillMsg', { type: 1, resetResult: true });
    changed(c);
  };

  // ---- advanced talents (Lv81; client advancedTalent, AdvancedTalentOp 0 grade up, 1 reset, 2 skill up) ----
  // grade: t_s_upgradetemplate Types 38 (TemplateId gold, Data EXP of the current level, PlayerLevel); skills
  // MasterType 30<job> (battle effects: not applied) and 3<job>0 ("ATK+N", "PDEF+N", "MDEF+N", "HP+N": flat
  // stats); reset advancedtalent_reset_gold x grade gold. -> 4434 AdvancedTalentInfoMsg.
  const ADV_UP = table('t_s_upgradetemplate').filter(r => r.Types === 38).sort((a, b) => a.Grades - b.Grades);
  const ADV_RESET = CONF.get('advancedtalent_reset_gold') || 5000;
  const advTree = p => [300 + p.s.job, 300 + 10 * p.s.job];
  const advState = p => (p.s.advTalent = p.s.advTalent || { grade: 0, skills: [], spent: 0 });
  const advMsg = p => { const a = advState(p); return { talentPoint: Math.max(0, a.grade - a.spent), talentGrade: a.grade, talentSkill: a.skills.join(',') }; };
  const ADV_STAT = { ATK: ['attack', 'magicAttack'], PDEF: ['defence'], MDEF: ['magicDefence'], HP: ['live'] };
  function advRecalc(p) {
    const add = {};
    const KEY = { attack: 'Attack', magicAttack: 'MagicAttack', defence: 'Defence', magicDefence: 'MagicDefence', live: 'Live' };
    for (const id of advState(p).skills) {
      const t = SK.get(id); const m = t && /^(ATK|PDEF|MDEF|HP) ?\+ ?(\d+)/.exec(t.Description_en || '');
      if (m) for (const k of ADV_STAT[m[1]]) add[KEY[k]] = (add[KEY[k]] || 0) + Number(m[2]);
    }
    (p.s.adds = p.s.adds || {}).advTalent = add;
  }
  ctx.onLoad.push(c => { if (c.player.s.grades >= 81) { advRecalc(c.player); sendT(c, 4434, 'advancedtalent.AdvancedTalentInfoMsg', advMsg(c.player)); } });

  return {
    C_HERO_ADVANCEDTALENT_REQ(c, body) {
      const m = dec(c, 'C_HERO_ADVANCEDTALENT_REQ', body), p = c.player, a = advState(p);
      const send = () => sendT(c, 4434, 'advancedtalent.AdvancedTalentInfoMsg', advMsg(p));
      if (m.op === 0) {
        let done = 0;
        for (let k = 0; k < Math.max(1, m.upGrade || 1); k++) {
          const next = ADV_UP[a.grade + 1];
          if (!next || p.s.grades < (next.PlayerLevel || 0) || (p.s.gp || 0) < (next.Data || 0) || ctx.balance(p, -100) < (next.TemplateId || 0)) break;
          pay(c, [[-100, next.TemplateId || 0]]); p.s.gp -= next.Data || 0; a.grade++; done++;
        }
        if (!done) alert(c, p.s.grades < 81 ? 'Talento avançado libera no nível 81' : 'EXP ou ouro insuficiente');
      } else if (m.op === 1) {
        if (!a.spent) { alert(c, 'Nenhum talento para redefinir'); return send(); }
        if (!pay(c, [[-100, ADV_RESET * a.grade]])) { alert(c, 'Ouro insuficiente'); return send(); }
        a.skills = []; a.spent = 0;
      } else if (m.op === 2) {
        const t = SK.get(m.skillTempId);
        if (!t || !advTree(p).includes(t.MasterType)) return send();
        if (a.grade - a.spent < 1) { alert(c, 'Pontos de talento insuficientes'); return send(); }
        if ((t.NeedPlayerGrade || 0) > a.grade) { alert(c, `Nível de talento avançado ${t.NeedPlayerGrade} necessário`); return send(); }
        const pre = String(t.PreTemplateId || '').split(',').map(Number).filter(Boolean);
        const has = id => { const q = SK.get(id); return !!q && a.skills.some(x => { const o = SK.get(x); return o && o.Index === q.Index && o.MasterType === q.MasterType && o.Grades >= q.Grades; }); };
        if (!pre.every(has)) { alert(c, 'Aprenda o talento necessário primeiro'); return send(); }
        const i = a.skills.findIndex(id => { const o = SK.get(id); return o && o.Index === t.Index && o.MasterType === t.MasterType; });
        if (i >= 0) { if (Number(SK.get(a.skills[i]).NextTemplateId) !== Number(t.TemplateId)) return send(); a.skills[i] = t.TemplateId; }
        else { if (t.Grades !== 1) return send(); a.skills.push(t.TemplateId); }
        a.spent++;
      }
      advRecalc(p); p.save();
      send(); sendPlayer(c); sendArmy(c);
    },
    // upGrade = how many grades (the window's stepper); stops at the first one that cannot be paid
    // (EXP is the current level's, p.s.gp)
    C_HERO_TALENT_GRADE_UP(c, body) {
      const m = dec(c, 'C_HERO_TALENT_GRADE_UP', body), p = c.player, s = state(p);
      const fail = text => { alert(c, text); sendT(c, 4430, 'army.TalentUpGradeMsg', { upresult: false }); };
      if (p.s.grades < OPEN) return fail(`Talentos liberam no nível ${OPEN}`);
      let done = 0, why = '';
      for (let k = 0; k < Math.max(1, m.upGrade || 1); k++) {
        const next = GRADE_UP[s.grade];
        if (!next) { why = 'Talento no nível máximo'; break; }
        if ((p.s.gp || 0) < (next.Data || 0)) { why = 'EXP insuficiente'; break; }
        if (ctx.balance(p, -100) < (next.TemplateId || 0)) { why = 'Ouro insuficiente'; break; }
        pay(c, [[-100, next.TemplateId || 0]]);
        p.s.gp -= next.Data || 0;
        s.grade++; done++;
      }
      if (!done) return fail(why);
      sendT(c, 4430, 'army.TalentUpGradeMsg', { upresult: true });
      changed(c);
      log(`[#${c.id}] talent grade +${done} = ${s.grade}`);
    },
    C_TELENT_TREE(c, body) {
      const m = dec(c, 'C_TELENT_TREE', body), s = state(c.player);
      if (SEAL_TYPES.includes(m.seal1)) s.branch = m.seal1;
      sendInfo(c);
    },
    C_TELENT_SORT(c, body) {
      const m = dec(c, 'C_TELENT_SORT', body), s = state(c.player), order = [m.seal1, m.seal2, m.seal3];
      if ([...order].sort().join() === SEAL_TYPES.join()) { s.seals = order; c.player.save(); }
      sendInfo(c);
    },
    C_ACTIVE_SECONDTALENT(c, body) {
      const m = dec(c, 'C_ACTIVE_SECONDTALENT', body), p = c.player, s = state(p);
      if (s.second) return sendInfo(c);
      const bound = m.payType === 0 && ctx.balance(p, -500) >= SECOND;
      if (!pay(c, [[bound ? -500 : -400, SECOND]])) { alert(c, 'Diamantes insuficientes'); return; }
      s.second = true; s.pages[1] = { skills: SEALS.slice(), spent: 0 };
      alert(c, 'Segunda página de talentos liberada');
      changed(c);
    },
    C_HERO_TALENT_CHANGE(c, body) {
      const m = dec(c, 'C_HERO_TALENT_CHANGE', body), s = state(c.player), i = m.index === 1 ? 1 : 0;
      if (i === 1 && !s.second) { alert(c, 'Segunda página de talentos está bloqueada'); return; }
      s.index = i;
      changed(c);
    },
  };
};
