// Meslek gelişimi / aktarım (client Kc / Uc JobChange window; t_s_transfer, t_s_transferattribute). Client-derived:
//  A hero stops at Lv80 (t_s_transfer AddGrade 80, client JOB_CHANGE_GRADES 80); the job change lifts the cap to the
//  level table's 160 (Player.maxLevel), the client then shows "grades - 80". Each level above 80 gives the class
//  attributes of t_s_transferattribute (WarriorAttr / ArcherAttr / MageAttr "attr,value|..." of that Level row).
//  C_TRANSFER_REQ (recover.TransferOpReq {op, type}): 2 enters the trial campaign (Ejderha Kralı Uçurumu, 4401;
//  quest condition 106), 1 changes the job -> 4974 U_C_TRANSFER_INFO TransferInfoRes {type = job changes done}
//  (also on load). The client's button does not check anything itself.
//  Conditions (quest 967's sub-quests 968..972): dragon soul 3 (no tables here), 4 Lv80 epic items worn,
//  Element Ormanı (9213) and Tara Tapınağı (5902) cleared (no map nodes here), Ejderha Kralı Uçurumu (4401) cleared.
// Our choice: only the checkable ones are required — Lv80, 4 worn items with NeedGrades >= 80 and Profile >= 4,
// campaign 4401 cleared.
module.exports = (ctx) => {
  const { D, table, dec, sendT, alert, log } = ctx;
  const ATTR = new Map(table('t_s_transferattribute').map(r => [r.Level, r]));
  const ATTRS = require('../attrs');
  const TRIAL = 4401;
  const col = job => job === 1 ? 'WarriorAttr' : job === 2 ? 'ArcherAttr' : 'MageAttr';
  // the attributes of every level above 80 add up (each row holds that level's step)
  function restat(p) {
    const add = {};
    if (p.s.jobChange) for (let lv = 81; lv <= p.s.grades; lv++) { const r = ATTR.get(lv); if (r) ATTRS.add(add, ATTRS.parse(r[col(p.s.job)])); }
    (p.s.adds = p.s.adds || {}).transfer = add;
  }
  const info = c => sendT(c, 4974, 'recover.TransferInfoRes', { type: c.player.s.jobChange ? 1 : 0 });
  ctx.onLoad.push(c => { restat(c.player); info(c); });
  ctx.onExp.push(c => { if (c.player.s.jobChange) restat(c.player); });

  // Client Uc.isJobChange(grades) is grades > 80: staying at 80 after the flag leaves the job-change
  // UI/options off (displayed level becomes 0). GM button therefore lifts the cap and jumps to Lv81.
  function toLevel(c, to) {
    const p = c.player;
    if (p.s.grades >= to) return;
    let exp = Math.max(0, (D.levelExp.get(p.s.grades + 1) || 0) - (p.s.gp || 0));
    for (let lv = p.s.grades + 2; lv <= to; lv++) exp += D.levelExp.get(lv) || 0;
    if (exp > 0) ctx.giveExp(c, Math.max(1, exp));
    if (p.s.grades < to) { p.s.grades = to; p.s.gp = 0; }
  }
  // GM / tests: apply the job change without the Lv80 / epic / trial checks
  ctx.forceJobChange = (c) => {
    const p = c.player;
    if (p.s.jobChange && p.s.grades > 80) return { ok: false, msg: 'A classe já está avançada (limite Nv. 160).' };
    const had = !!p.s.jobChange;
    p.s.jobChange = 1;           // unlocks maxLevel 160 so EXP can pass 80
    toLevel(c, 81);
    restat(p); p.save();
    log(`[#${c.id}] GM job change -> lv${p.s.grades}`);
    info(c); ctx.sendPlayer(c); ctx.sendArmy(c);
    if (ctx.sendSystemsOpen) ctx.sendSystemsOpen(c);
    else if (ctx.checkSystemsOpen) ctx.checkSystemsOpen(c);
    return { ok: true, msg: had ? `Classe já avançada; nível ajustado para ${p.s.grades}.` : `Classe avançada! Nível ${p.s.grades}, limite 160.` };
  };

  return {
    C_TRANSFER_REQ(c, body) {
      const m = dec(c, 'C_TRANSFER_REQ', body), p = c.player;
      if (m.op === 2) {
        if (p.s.grades < 80) { alert(c, 'Personagem deve estar no Lv. 80'); return; }
        if (!ctx.hasCampaignMaps(TRIAL)) { alert(c, 'Expedição de teste não encontrada'); return; }
        return ctx.startCampaign(c, TRIAL);
      }
      if (m.op !== 1) return info(c);
      if (p.s.jobChange) return info(c);
      const worn = Object.values(p.s.equip).map(i => D.items.get(i.templateId)).filter(t => t && t.NeedGrades >= 80 && t.Profile >= 4);
      const missing = [];
      if (p.s.grades < 80) missing.push('Lv. 80');
      if (worn.length < 4) missing.push(`4 equipamentos épicos Lv80 (${worn.length}/4)`);
      if (!(p.s.cleared || []).includes(TRIAL)) missing.push('Abismo do Rei Dragão');
      if (missing.length) { alert(c, 'Requisitos de evolução: ' + missing.join(', ')); return info(c); }
      p.s.jobChange = 1;
      toLevel(c, 81);
      restat(p); p.save();
      log(`[#${c.id}] job change done -> lv${p.s.grades}`);
      alert(c, `Evolução de classe concluída! Nível ${p.s.grades}, limite 160.`);
      info(c); ctx.sendPlayer(c); ctx.sendArmy(c);
    },
  };
};
