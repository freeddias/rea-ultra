// Asker özel yeteneği (client PawnSpecialAbilityWnd; t_s_specialtemplate). Client-derived, no capture:
//  A troop type's pool = the specials whose PawnMasterType = DefaultSpecialTemps / 100 of its template (pawns
//  without DefaultSpecialTemps have none); grades 1..10, TakeRandom = roll weight. The troop starts with its
//  DefaultSpecialTemps special (ArmyPawnInfoMsg specialTempIds).
//  C_COMPREHEND (army.ComprehendMsg {templateId, quick}): Special_Stretgy (100000) gold per roll -> a candidate
//   in comprehednTempIds; each roll adds 1 bless (bar = t_s_upgradetemplate Types 16 at the current grade,
//   Data). quick = up to min(10, bar - bless + 1) rolls (the client's quick price), stopping at a better grade.
//   Our choice: a roll at a full bar is a sure grade + 1 (the bar's purpose) and empties it.
//  C_SAVESPECIAL {templateId}: the candidate replaces the current special (the client warns before a worse one).
//  Reply: 116 army.ArmyPawnInfoMsg (U_C_PAWN_INFO; the client reads specialTempIds / comprehednTempIds /
//  blessNum from it).
//  Not modelled: the special's effect in battle (CurProperty -> TarProperty conversions, battle.js has no place).
module.exports = (ctx) => {
  const { D, table, dec, sendT, alert, pay, M, CONF } = ctx;
  const SPECIALS = table('t_s_specialtemplate');
  const BY_ID = new Map(SPECIALS.map(r => [r.TemplateId, r]));
  const BAR = new Map(table('t_s_upgradetemplate').filter(r => r.Types === 16).map(r => [r.Grades, r.Data]));
  const PRICE = Number(CONF.get('Special_Stretgy')) || 100000;
  const defOf = tid => Number((D.pawns.get(tid) || {}).DefaultSpecialTemps) || 0;
  const pool = tid => SPECIALS.filter(r => r.PawnMasterType === Math.floor(defOf(tid) / 100));
  function roll(list) {
    let x = Math.random() * list.reduce((n, r) => n + (r.TakeRandom || 0), 0);
    for (const r of list) if ((x -= r.TakeRandom || 0) < 0) return r;
    return list[0];
  }
  const entry = (p, tid) => Object.entries(p.s.pawns).find(([, r]) => r.tempId === tid);
  const current = (r) => BY_ID.get(r.special || defOf(r.tempId));

  return {
    C_COMPREHEND(c, body) {
      const m = dec(c, 'C_COMPREHEND', body), p = c.player, e = entry(p, m.templateId);
      if (!e) return alert(c, 'Este tipo de soldado não existe');
      const [son, r] = e, list = pool(r.tempId), cur = current(r);
      if (!list.length || !cur) return alert(c, 'Este soldado não tem habilidade especial');
      const bar = BAR.get(cur.Grades) || 10000;
      const times = m.quick ? Math.max(1, Math.min(10, bar - (r.bless || 0) + 1)) : 1;
      let done = 0, got = null;
      for (let i = 0; i < times; i++) {
        if (!pay(c, [[-100, PRICE]])) { if (!done) alert(c, 'Ouro insuficiente'); break; }
        done++;
        if ((r.bless || 0) >= bar) {
          const up = list.filter(x => x.Grades === Math.min(10, cur.Grades + 1));
          got = up[Math.floor(Math.random() * up.length)] || roll(list); r.bless = 0;
        } else { got = roll(list.filter(x => x.TakeRandom > 0)); r.bless = (r.bless || 0) + 1; }
        r.comprehend = got.TemplateId;
        if (got.Grades > cur.Grades) break;
      }
      if (!done) return;
      p.save();
      sendT(c, 116, 'army.ArmyPawnInfoMsg', M.reservePawn(p, son));
    },
    C_SAVESPECIAL(c, body) {
      const m = dec(c, 'C_SAVESPECIAL', body), p = c.player, e = entry(p, m.templateId);
      if (!e || !e[1].comprehend) return alert(c, 'Nenhuma habilidade para salvar');
      const [son, r] = e;
      r.special = r.comprehend; r.comprehend = 0;
      p.save();
      alert(c, `${ctx.nameOf(BY_ID.get(r.special))} salvo`);
      sendT(c, 116, 'army.ArmyPawnInfoMsg', M.reservePawn(p, son));
    },
  };
};
