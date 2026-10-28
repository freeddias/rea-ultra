// Ejderha Ruhu (dragon soul; client Xet view, upgrade template type 101, material Ejderha Ruhu Parçası 2125150).
// From the 2026-10-23 live capture + client:
//  C_DRAGON_SOUL_REQ {op, type 101}: 0 info, 1 feed one piece (+1 exp, client _minExp), 2 feed up to the next grade ->
//  555 DragonSoulInfoMsg {grade, exp, type} (capture: grade 4, exp 1068 — exp counts toward the next grade:
//  type 101 Data of grade + 1, 60 / 180 / 460 / 1300 / 2500, then a second tier 460 .. 8500). A grade needs its
//  PlayerLevel (20, 30, .. 150). Grade g's effect = skill ActiveObject (7101 ..): only the second tier skills
//  (7201 ..) have texts ("20000 HP artar", "Saldırı +2%, .."); they go to s.adds / s.addsPct.dragonSoul.
// Our choices: the first tier skills (7101..7105, no text) give nothing; extra exp at the level cap is kept.
const PIECE = 2125150, TYPE = 101;
// Description_pt tokens (ATQ/ATQM/DEF/DEFM/PV) + ASCII HP alias
const FLAT = { PV: 'Live', HP: 'Live', ATQ: 'Attack', Ataque: 'Attack', ATQM: 'MagicAttack', DEF: 'Defence', DEFM: 'MagicDefence' };
const PCT = { PV: 'live', HP: 'live', ATQ: 'attack', Ataque: 'attack', ATQM: 'magicAttack', DEF: 'defence', DEFM: 'magicDefence' };

module.exports = (ctx) => {
  const { dec, sendT, alert, pay, table } = ctx;
  const ROWS = table('t_s_upgradetemplate').filter(r => r.Types === TYPE && r.Grades > 0).sort((a, b) => a.Grades - b.Grades);
  const SKILLS = new Map(table('t_s_skilltemplate').map(r => [r.TemplateId, r]));
  const TOP = ROWS.length ? ROWS[ROWS.length - 1].Grades : 0;
  const row = g => ROWS.find(r => r.Grades === g);
  const state = p => p.s.dragonSoul = p.s.dragonSoul || { grade: 0, exp: 0 };
  function apply(p) {
    const s = state(p), add = {}, pct = {}, sk = s.grade && SKILLS.get((row(s.grade) || {}).ActiveObject);
    const desc = (sk && (sk.Description_pt || sk.Description_tr)) || '';
    for (const part of String(desc).split(/,|<br>/)) {
      let m = part.trim().match(/^(.+?)\s*\+\s*(\d+)\s*%$/);
      if (m && PCT[m[1].trim()]) { pct[PCT[m[1].trim()]] = (pct[PCT[m[1].trim()]] || 0) + Number(m[2]); continue; }
      m = part.trim().match(/^(.+?)\s*\+\s*(\d+)$/);
      if (m && FLAT[m[1].trim()]) { add[FLAT[m[1].trim()]] = (add[FLAT[m[1].trim()]] || 0) + Number(m[2]); continue; }
      m = part.trim().match(/^(\d+)\s+(\S+)\s+artar/);
      if (m && FLAT[m[2]]) add[FLAT[m[2]]] = (add[FLAT[m[2]]] || 0) + Number(m[1]);
    }
    p.s.adds = p.s.adds || {}; p.s.adds.dragonSoul = add;
    p.s.addsPct = p.s.addsPct || {}; p.s.addsPct.dragonSoul = pct;
  }
  const send = c => { const s = state(c.player); sendT(c, 555, 'dragonsoul.DragonSoulOpRes', { grade: s.grade, exp: s.exp, type: TYPE }); };
  // grade-ups the exp allows (and the level allows)
  function settle(p) {
    const s = state(p);
    let up = false, next;
    while (s.grade < TOP && (next = row(s.grade + 1)) && p.s.grades >= next.PlayerLevel && s.exp >= next.Data) { s.exp -= next.Data; s.grade++; up = true; }
    return up;
  }
  ctx.onLoad.push(c => { apply(c.player); });

  return {
    C_DRAGON_SOUL_REQ(c, body) {
      const m = dec(c, 'C_DRAGON_SOUL_REQ', body), p = c.player, s = state(p);
      if (m.op === 1 || m.op === 2) {
        const next = row(s.grade + 1);
        if (!next) { alert(c, 'Alma de Dragão no nível máximo'); return send(c); }
        if (p.s.grades < next.PlayerLevel) { alert(c, `Personagem Lv. ${next.PlayerLevel} necessário`); return send(c); }
        const want = m.op === 1 ? 1 : Math.max(1, next.Data - s.exp);
        const n = Math.min(want, p.countTemplate(PIECE));
        if (n <= 0 || !pay(c, [[PIECE, n]])) { alert(c, 'Fragmentos de Alma de Dragão insuficientes'); return send(c); }
        s.exp += n;
        if (settle(p)) { apply(p); ctx.sendPlayer(c); if (ctx.sendArmy) ctx.sendArmy(c); }
        p.save();
      }
      send(c);
    },
  };
};
