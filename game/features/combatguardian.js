// Savaş Koruması (combat guardian; client kZ BattleGuardView / BattleGuardIntensifyView; t_s_combatguardiantemplate 7
// guardians, t_s_combatguardianupgrade levels 0..300, t_s_combatguardianstar stars 0..5). Client-derived, no capture:
//  C_COMBAT_GUARDIAN_REQ {op, templateId}: 0 all, 1 next level (Consume "tid,n|..."; a row with IsBreak needs every
//  guardian at BreakCondition: client getAllLevel = the lowest guardian level), 2 next star (its Consume)
//  -> 4873 CombatGuardianOpRes {guardians [{templateId, level, star}] (one = an update of it), attributes
//  {attributeId: total}} (14..19 element resists, 20 resist reduction; the client adds them to the resist view).
// Our choices: a star's AllAttribute (x / 100 %) raises its guardian's level attributes; the star rows' own
// Attribute values are added on top. Element resists have no battle effect here (battle.js has no elements).
module.exports = (ctx) => {
  const { table, dec, sendT, alert, pay } = ctx;
  const TPL = table('t_s_combatguardiantemplate');
  const UP = new Map(table('t_s_combatguardianupgrade').map(r => [`${r.GuardianID}:${r.Level}`, r]));
  const STAR = new Map(table('t_s_combatguardianstar').map(r => [`${r.GuardianID}:${r.StarLevel}`, r]));
  const parse = s => String(s || '').split('|').map(x => x.split(',').map(Number)).filter(([t, n]) => t && n);
  const state = p => {
    const s = p.s.combatGuardian = p.s.combatGuardian || {};
    for (const t of TPL) s[t.TemplateId] = s[t.TemplateId] || { level: t.InitialLevel || 0, star: t.InitialStar || 0 };
    return s;
  };
  function attributes(p) {
    const s = state(p), total = {};
    for (const [id, g] of Object.entries(s)) {
      const up = UP.get(`${id}:${g.level}`), st = STAR.get(`${id}:${g.star}`), k = 1 + ((st && st.AllAttribute) || 0) / 10000;
      for (const [a, v] of parse(up && up.Attribute)) total[a] = (total[a] || 0) + Math.floor(v * k);
      for (const [a, v] of parse(st && st.Attribute)) total[a] = (total[a] || 0) + v;
    }
    return total;
  }
  ctx.combatGuardianAttrs = attributes;
  const send = (c, ids) => {
    const s = state(c.player);
    sendT(c, 4873, 'combatguardian.CombatGuardianOpRes', { guardians: (ids || Object.keys(s)).map(id => ({ templateId: Number(id), level: s[id].level, star: s[id].star })), attributes: attributes(c.player) });
  };
  ctx.onLoad.push(c => send(c));

  return {
    C_COMBAT_GUARDIAN_REQ(c, body) {
      const m = dec(c, 'C_COMBAT_GUARDIAN_REQ', body), p = c.player, s = state(p), g = s[m.templateId];
      if (m.op === 0 || !g) return send(c);
      const tpl = TPL.find(t => t.TemplateId === m.templateId);
      if (tpl && p.s.grades < (tpl.UnlockLevel || 0)) { alert(c, `Gereken Lv. ${tpl.UnlockLevel}`); return send(c, [m.templateId]); }
      const row = m.op === 1 ? UP.get(`${m.templateId}:${g.level + 1}`) : m.op === 2 ? STAR.get(`${m.templateId}:${g.star + 1}`) : null;
      if (!row) { alert(c, 'Já está no nível máximo'); return send(c, [m.templateId]); }
      if (m.op === 1 && row.IsBreak && Math.min(...Object.values(s).map(x => x.level)) < (row.BreakCondition || 0)) { alert(c, `Todos os guardiões devem estar no Lv. ${row.BreakCondition}`); return send(c, [m.templateId]); }
      if (!pay(c, parse(row.Consume))) { alert(c, 'Materiais/ouro insuficientes'); return send(c, [m.templateId]); }
      if (m.op === 1) g.level++; else g.star++;
      p.save(); ctx.sendPlayer(c);
      send(c, [m.templateId]);
    },
  };
};
