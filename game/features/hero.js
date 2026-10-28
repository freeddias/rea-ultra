// Hero skills: learn / upgrade with skill points, reset.
// t_s_skilltemplate: SonType = skill line, Grades = level, NextTemplateId = next level, PreTemplateId = required
// skills, NeedPlayerGrade = hero level, Index = slot in the client's skill tree (allSkillList[index]).
// Points: Player.skillPointsTotal() (capture-derived) + Santo Graal extras (s.extraSkillPoint), spent in s.skillSpent.
// Two skill sets: C_ACTIVE_SECONDSKILL {payType 0 bound first / 1} opens the second for Second_SkillPoint (600)
// diamonds (starting from the hero template's skills); C_CHANGE_SKILL {index} swaps skills, spent points and
// fast keys (HeroMsg skillIndex / isActiveSecond, client switchSkillIndex). Each set has the full points.
// Santo Graal (208055, SonType 222): +1 extra skill point up to grail_level_point by hero level; over the cap
// each cup becomes 100,000,000 EXP (item Description_zhcn / client TEMP_ID_CUP tip).
module.exports = (ctx) => {
  const { D, dec, sendT, sendPlayer, sendArmy, alert, log, CONF, giveExp } = ctx;
  const UPDATED = 60, RESET = 61;
  const GRAIL_SON = 222, GRAIL_EXP = 100000000;
  const sonOf = id => (D.skills.get(id) || {}).SonType;
  const grailCap = grades => {
    const rows = String(CONF.str('grail_level_point') || '30,10|40,15|50,20|60,25|70,30|80,35|90,40|100,45|110,50')
      .split('|').map(x => x.split(',').map(Number)).filter(([lv]) => lv);
    let cap = 0;
    for (const [lv, n] of rows) if (grades >= lv) cap = n;
    return cap;
  };

  // bag use: Santo Graal (SonType 222 / TemplateId 208055)
  const useGrail = (c, it, tp, count) => {
    const p = c.player, n = Math.max(1, Math.min(count || 1, it.count));
    if (p.s.grades < (tp.NeedGrades || 30)) { alert(c, `Nível ${tp.NeedGrades || 30} necessário`); return; }
    const cap = grailCap(p.s.grades);
    let used = p.s.extraSkillPoint || 0, points = 0, exp = 0, took = 0;
    for (let i = 0; i < n; i++) {
      if (used < cap) { used++; points++; }
      else exp += GRAIL_EXP;
      took++;
    }
    p.removeItem(it, took);
    ctx.sendItems(c, [ctx.M.movedEntry(p, it, it.count <= 0)]);
    p.s.extraSkillPoint = used;
    if (exp && giveExp) giveExp(c, exp);
    p.save();
    sendPlayer(c); sendArmy(c);
    const parts = [];
    if (points) parts.push(`Pontos de Habilidade +${points} (${used}/${cap})`);
    if (exp) parts.push(`EXP +${exp.toLocaleString('en-US')}`);
    alert(c, parts.join(' · ') || 'Santo Graal usado');
    log(`[#${c.id}] Santo Graal x${took}: +${points} skill pts, +${exp} exp (extra ${used}/${cap})`);
  };
  ctx.useItem[GRAIL_SON] = useGrail;
  ctx.useItem[208055] = useGrail;   // also by TemplateId if a caller keys that way

  // a required skill counts as learned when the hero has that skill line at its level or higher
  function hasSkill(p, id) {
    const t = D.skills.get(id); if (!t) return false;
    return p.s.skills.some(x => { const o = D.skills.get(x); return o && o.SonType === t.SonType && o.Grades >= t.Grades; });
  }

  return {
    // type 0 = job skill (sendAddTalentpoint also omits type → 0);
    // type 1 = talent tree — client always sends sendAddSkillpoint(id, 1) from the talent panel;
    // type 2 = extra-job (not implemented)
    C_HERO_SKILL_UPGRADE(c, body) {
      const m = dec(c, 'C_HERO_SKILL_UPGRADE', body), p = c.player, t = D.skills.get(m.skillTempId);
      const type = Number(m.type) || 0, skillId = Number(m.skillTempId) || m.skillTempId;
      log(`[#${c.id}] skill upgrade id=${skillId} type=${type} sub=${m.subType || 0}`);
      // type 1 = talent panel (sendAddSkillpoint(id,1)); also try talentLearn for type 0
      if (type === 1) {
        if (!ctx.talentLearn) { alert(c, 'Sistema de talentos indisponível'); return; }
        if (!ctx.talentLearn(c, skillId)) alert(c, 'Este talento não pode ser aprendido');
        return;
      }
      if (ctx.talentLearn && ctx.talentLearn(c, skillId)) return;
      if (type !== 0) { log(`[#${c.id}] skill upgrade type ${type} not implemented`); return; }
      const skill = D.skills.get(skillId) || t;
      if (!skill || (skill.MasterType && skill.MasterType !== p.s.job)) return;
      if (p.skillPointsLeft() < 1) { alert(c, 'Pontos de habilidade insuficientes'); return; }
      if ((skill.NeedPlayerGrade || 0) > p.s.grades) { alert(c, `Nível ${skill.NeedPlayerGrade} necessário`); return; }
      const pre = String(skill.PreTemplateId || '').split(',').map(Number).filter(Boolean);
      if (!pre.every(id => hasSkill(p, id))) { alert(c, 'Aprenda a habilidade necessária primeiro'); return; }
      const i = p.s.skills.findIndex(id => sonOf(id) === skill.SonType);
      if (i >= 0) {
        // NextTemplateId is often a string on post-job-change rows (NeedPlayerGrade >= 81)
        if (Number((D.skills.get(p.s.skills[i]) || {}).NextTemplateId) !== Number(skill.TemplateId)) return;
        p.s.skills[i] = skill.TemplateId;
      } else {
        if (skill.Grades !== 1) return;
        p.s.skills.push(skill.TemplateId);
      }
      p.s.skillSpent = (p.s.skillSpent || 0) + 1;
      p.save();
      sendPlayer(c); sendArmy(c);
      sendT(c, UPDATED, 'army.UpdatedSkillMsg', { templateId: skill.TemplateId, index: skill.Index, type: 0 });
    },
    // fight skill editor (FightSkillEdit, per job: rage percent, normal / special skill order, pet): op 1 save,
    // 2 reset that job, 3 info, 4 isOpen -> 4740 SkillEditResMsg. Kept only: battle.js auto mode still picks
    // the strongest skill (not the edited order)
    C_SKILL_EDIT(c, body) {
      const m = dec(c, 'C_SKILL_EDIT', body), p = c.player, e = p.s.skillEdit = p.s.skillEdit || { isOpen: false, jobs: {} };
      if (m.op === 1 && m.job) e.jobs[m.job] = { percent: m.percent || 0, normalSkill: m.normalSkill || '', specialSkill: m.specialSkill || '', petId: m.petId || 0 };
      else if (m.op === 2 && m.job) delete e.jobs[m.job];
      if (m.op === 1 || m.op === 4) e.isOpen = !!m.isOpen;
      if (m.op !== 3) p.save();
      sendT(c, 4740, 'skilledit.SkillEditResMsg', { isOpen: e.isOpen, skillInfo: Object.entries(e.jobs).map(([job, x]) => Object.assign({ job: Number(job), defaultSkill: '' }, x)) });
    },
    C_ACTIVE_SECONDSKILL(c, body) {
      const m = dec(c, 'C_ACTIVE_SECONDSKILL', body), p = c.player, sp = p.s.skillPages = p.s.skillPages || { index: 0, second: false, other: null };
      if (sp.second) return sendArmy(c);
      const price = ctx.CONF.get('Second_SkillPoint') || 600, bound = m.payType === 0 && ctx.balance(p, -500) >= price;
      if (!ctx.pay(c, [[bound ? -500 : -400, price]])) { alert(c, 'Diamantes insuficientes'); return; }
      sp.second = true; sp.other = { skills: (p.heroTpl.SkillScript || []).slice(), spent: 0, fastKey: p.s.fastKey.map(() => -1) };
      p.save(); sendPlayer(c); sendArmy(c);
      alert(c, 'Segundo conjunto de habilidades liberado');
    },
    C_CHANGE_SKILL(c, body) {
      const m = dec(c, 'C_CHANGE_SKILL', body), p = c.player, sp = p.s.skillPages;
      if (!sp || !sp.second) { alert(c, 'Segundo conjunto de habilidades bloqueado'); return; }
      const want = m.index === 1 ? 1 : 0;
      if (want === sp.index) return sendArmy(c);
      const cur = { skills: p.s.skills, spent: p.s.skillSpent || 0, fastKey: p.s.fastKey };
      p.s.skills = sp.other.skills; p.s.skillSpent = sp.other.spent; p.s.fastKey = sp.other.fastKey;
      sp.other = cur; sp.index = want;
      p.save(); sendPlayer(c); sendArmy(c);
    },
    // back to the hero template's starting skills, every point refunded
    // (the official price is unknown: free for now)
    C_HERO_SKILLPOINT_RESET(c, body) {
      const m = dec(c, 'C_HERO_SKILLPOINT_RESET', body);
      if (m.type === 1) { if (ctx.talentReset) ctx.talentReset(c); return; }   // talents: features/talent.js
      const p = c.player, tpl = p.heroTpl;
      p.s.skills = (tpl.SkillScript || []).slice();
      p.s.skillSpent = 0;
      const lines = new Set(p.s.skills.map(sonOf));
      p.s.fastKey = p.s.fastKey.map(k => (k === -1 || lines.has(k)) ? k : -1);
      p.save();
      sendT(c, RESET, 'army.UpdatedSkillMsg', { type: 0, resetResult: true });
      sendPlayer(c); sendArmy(c);
    },
  };
};
