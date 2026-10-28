// Kader Koruması (fate guard; client U$ fate skill, FateGuard window; upgrade template type 26 = UPGRADE_TYPE_FATE_GUARD).
// From the 2026-10-23 live capture + client:
//  4544 FateListMsg {fateInfo [{templateId, fateTypes, totalGp, grades}], fateSkills "2008,2108,"} at login and after
//  training. Two guards: fateTypes 2000 (skills 2000..2040: Saldırı + Maks HP) and 3000 (2100..2140: Defans + Sihirli
//  Defans + Maks HP); templateId = base + grade. U_C_FATE_TRAIN {skillSonType, useItemCount} feeds Kader Taşı (208024,
//  SonType 307): 1 stone = 1 gp (capture: 154 stones, 1885 -> 2039 gp, grade 7 -> 8). Grade g needs the sum of the
//  type 26 Data of levels 1..g (58, 116, 175, 233, 291, 350, 408, ..). C_FATE_HIDE {hide} only hides the effect.
// Our choices: open from Lv. 40 (the client has no open level for it); the guards' stats come from their skill
// descriptions (no numeric fields in t_s_skilltemplate) into s.adds.fate; stones beyond the top grade are refused.
const STONE = 208024, OPEN = 40;
const TYPES = { 2000: 2000, 3000: 2100 };   // fateTypes -> skill template base
const STAT = {
  Ataque: 'Attack', ATQ: 'Attack',
  DEF: 'Defence', Defesa: 'Defence',
  DEFM: 'MagicDefence',
  'PV Máx.': 'Live', 'PV Máx': 'Live',
  ATQM: 'MagicAttack',
};

module.exports = (ctx) => {
  const { D, dec, sendT, alert, pay, table, log } = ctx;
  const STEPS = table('t_s_upgradetemplate').filter(r => r.Types === 26).sort((a, b) => a.Grades - b.Grades).filter(r => r.Grades > 0).map(r => r.Data);
  const SKILLS = new Map(table('t_s_skilltemplate').filter(r => TYPES[r.SonType] !== undefined).map(r => [r.TemplateId, r]));
  const TOP = Math.min(STEPS.length, ...Object.values(TYPES).map(b => Math.max(...[...SKILLS.keys()].filter(id => id >= b && id < b + 100)) - b));
  const gradeOf = gp => { let g = 0, need = 0; while (g < TOP && gp >= need + STEPS[g]) { need += STEPS[g]; g++; } return g; };
  const maxGp = STEPS.slice(0, TOP).reduce((a, b) => a + b, 0);
  function state(p) { return p.s.fate = p.s.fate || { gp: { 2000: 0, 3000: 0 }, hide: 0 }; }
  function apply(p) {
    const s = state(p), add = {};
    for (const [t, base] of Object.entries(TYPES)) {
      const sk = SKILLS.get(base + gradeOf(s.gp[t] || 0)); if (!sk) continue;
      for (const part of String(sk.Description_pt || sk.Description_tr || '').split('<br>')) {
        const m = part.trim().match(/^(.+?)\s*\+(\d+)$/); const key = m && STAT[m[1].trim()];
        if (key) add[key] = (add[key] || 0) + Number(m[2]);
      }
    }
    p.s.adds = p.s.adds || {}; p.s.adds.fate = add;
  }
  const skillIds = p => Object.entries(TYPES).map(([t, base]) => base + gradeOf(state(p).gp[t] || 0));
  const send = c => { const s = state(c.player);
    sendT(c, 4544, 'fate.FateListMsg', { fateInfo: Object.entries(TYPES).map(([t, base]) => ({ templateId: base + gradeOf(s.gp[t] || 0), fateTypes: Number(t), totalGp: s.gp[t] || 0, grades: gradeOf(s.gp[t] || 0) })),
      fateSkills: skillIds(c.player).join(',') + ',' }); };
  ctx.onLoad.push(c => { if (c.player.s.grades >= OPEN) { apply(c.player); send(c); } });
  ctx.M.addShow(p => p.s.fate ? { fateSkills: skillIds(p).join(',') + ',' } : {});   // shown on maps (capture 140 / 4595)

  return {
    C_FATE_REQUEST(c) { if (c.player.s.grades >= OPEN) send(c); },
    C_FATE_HIDE(c, body) { const m = dec(c, 'C_FATE_HIDE', body); state(c.player).hide = m.hide ? 1 : 0; c.player.save(); },
    U_C_FATE_TRAIN(c, body) {
      const m = dec(c, 'U_C_FATE_TRAIN', body), p = c.player, s = state(p), t = m.skillSonType;
      if (p.s.grades < OPEN) { alert(c, `Lv. ${OPEN} necessário`); return; }
      if (TYPES[t] === undefined) return;
      const n = Math.min(m.useItemCount || 0, maxGp - (s.gp[t] || 0));
      if (n <= 0) { alert(c, 'Proteção no nível máximo'); return; }
      if (!pay(c, [[STONE, n]])) { alert(c, 'Pedras do Destino insuficientes'); return; }
      const before = gradeOf(s.gp[t] || 0);
      s.gp[t] = (s.gp[t] || 0) + n;
      const after = gradeOf(s.gp[t]);
      apply(p); p.save();
      if (after > before) { alert(c, `Proteção evoluiu do nível ${before} para ${after}`); ctx.sendPlayer(c); if (ctx.sendArmy) ctx.sendArmy(c); }
      send(c);
      log(`[#${c.id}] fate ${t} +${n} gp -> grade ${after}`);
    },
  };
};
