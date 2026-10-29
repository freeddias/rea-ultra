// Moda kitabı + gardırop (client Im fashion controller, r_ model, FashionSwitchItem). Capture: C_FASHION_INFO ->
// 301 simple.FashionInfoMsg {grades, gp, status} + 4542 fashion.FashionMsg {info: [], fashionIds: 1093 ids = every
// fashion template}. Client-derived, no other capture:
//  Book: info = fashion.FashionBook {tempId, isSwitch (false = "new" + unlock telemetry), appraisalSkill}.
//   Our choice: a fashion (SonType 109 wing, 110 hat, 111 weapon, 112 clothes) enters the book once owned
//   (bag / worn); isSwitch false only in the first book after it came.
//  C_FASHION_APPLRAISAL {templateId} (Lv27, INDENTITY_OPEN_GRADE): first appraisal 200000 x (6 - Property2) gold
//   -> skill (MasterType 10 x SonType, SonType Property2, Grades 1); again: Moda Ruhu 208020 x (6 - Property2)
//   -> next grade (max 5) at [0,20,30,40,50,60][TransformId] % (getSuccessRateForIdentityBook). The skill's
//   t_s_skillpropertytemplate Power / Agility / Intellect / Physique add to the hero (getIdentityedProperties).
//   Reply: 4542 + 301 (the client takes the identify state from them).
//  C_FASHION_EXCHANGE (simple.FashionInfoMsg): flag 1 = wear hatAvata / clothAvata / armAvata / wingAvata (from
//   the book), flag 0 = status "hat,cloth,arm,wing" (1 shown, 0 hidden). Reply 301; the army look
//   (ArmyMsg hat / wing / fashionArm / fashionCloth Avata) follows.
//  C_FASHION_COMPOSE (store.StoreReqMsg {count}): swallow item in Hide (bag 0 pos 0) for fashion GP
//   (Fashion_Wing / Fashion_Other x 2^(skillGrade-1), or Fashion_Soul / Fashion_Lucky x count) -> level via
//   t_s_upgradetemplate Types 113; reply 4487 StoreRspMsg + 301. Grade bonuses = TemplateName "40801N,40802N"
//   (pct / flat ATK·DEF·HP). C_FASHION_SWITCH {templateId}: mark book entry seen (isSwitch).
const SONS = { 110: 'hat', 112: 'cloth', 111: 'arm', 109: 'wing' };
const SOUL = 208020, LUCKY = 208021, OPEN_LV = 27, RATE = [0, 20, 30, 40, 50, 60], HIDE = 0, COMPOSE_RSP = 4487;

module.exports = (ctx) => {
  const { D, table, dec, sendT, alert, pay, CONF, sendItems, M } = ctx;
  const SKILLS = table('t_s_skilltemplate').filter(r => r.MasterType >= 1090 && r.MasterType <= 1120);
  const PROPS = new Map(table('t_s_skillpropertytemplate').map(r => [r.TemplateId, r]));
  const GRADE = new Map(table('t_s_upgradetemplate').filter(r => r.Types === 113).map(r => [r.Grades, r]));
  const ALL = [...D.items.values()].filter(t => SONS[t.SonType] && t.MasterType === 1).map(t => t.TemplateId).sort((a, b) => b - a);
  const skillOf = (tp, grade) => SKILLS.find(r => r.MasterType === 10 * tp.SonType && r.SonType === tp.Property2 && r.Grades === grade);
  const cfg = (k, d) => Number(CONF.str(k)) || d;

  function state(p) {
    const f = p.s.fashion = p.s.fashion || { book: {}, hat: 0, cloth: 0, arm: 0, wing: 0, status: '1,1,1,1', gp: 0, grades: 1 };
    for (const it of [...p.s.bag, ...Object.values(p.s.equip)]) {
      const tp = D.items.get(it.templateId);
      if (tp && SONS[tp.SonType] && tp.MasterType === 1 && !f.book[tp.TemplateId]) f.book[tp.TemplateId] = { skill: 0, seen: false };
    }
    return f;
  }
  // identified fashions + devour-grade TemplateName skills -> s.adds.fashion / s.addsPct.fashion.
  // Initial Rage on the grade's 40801xxx buffer (AttackType 23) is applied in battle via fury.js, not here.
  function restat(p) {
    const f = state(p), flat = { Power: 0, Agility: 0, Intellect: 0, Physique: 0, Attack: 0, MagicAttack: 0, Defence: 0, MagicDefence: 0, Live: 0, Conat: 0 };
    const pct = {};
    for (const b of Object.values(f.book)) {
      const r = PROPS.get(b.skill); if (!r) continue;
      for (const k of ['Power', 'Agility', 'Intellect', 'Physique']) flat[k] += r[k] || 0;
    }
    const row = GRADE.get(f.grades || 1);
    for (const id of String((row && row.TemplateName) || '').split(',').map(Number).filter(Boolean)) {
      const r = PROPS.get(id); if (!r) continue;
      if (r.AddType === 0) {
        if (r.Attack) pct.attack = (pct.attack || 0) + r.Attack;
        if (r.MagicAttack) pct.magicAttack = (pct.magicAttack || 0) + r.MagicAttack;
        if (r.Defence) pct.defence = (pct.defence || 0) + r.Defence;
        if (r.MagicDefence) pct.magicDefence = (pct.magicDefence || 0) + r.MagicDefence;
        if (r.Live) pct.live = (pct.live || 0) + r.Live;
      } else {
        for (const k of ['Attack', 'MagicAttack', 'Defence', 'MagicDefence', 'Live', 'Conat', 'Power', 'Agility', 'Intellect', 'Physique']) flat[k] += r[k] || 0;
      }
    }
    p.s.adds = p.s.adds || {}; p.s.adds.fashion = flat;
    p.s.addsPct = p.s.addsPct || {}; p.s.addsPct.fashion = pct;
  }
  const info = (p) => {
    const f = state(p);
    return { gp: f.gp, grades: f.grades, status: f.status, hatAvata: f.hat, clothAvata: f.cloth, armAvata: f.arm, wingAvata: f.wing };
  };
  function send(c) {
    const p = c.player, f = state(p);
    sendT(c, 301, 'simple.FashionInfoMsg', info(p));
    sendT(c, 4542, 'fashion.FashionMsg', { fashionIds: ALL, info: Object.entries(f.book).map(([id, b]) => ({ tempId: Number(id), isSwitch: !!b.seen, appraisalSkill: b.skill || 0 })) });
    let dirty = false;
    for (const b of Object.values(f.book)) if (!b.seen) { b.seen = true; dirty = true; }
    if (dirty) p.save();
  }
  // client calcGp: fashion base x 2^(skillGrade-1); souls / lucky charms x count
  function composeGp(it, count) {
    const tid = it.templateId;
    if (tid === SOUL) return cfg('Fashion_Soul', 200) * count;
    if (tid === LUCKY) return cfg('Fashion_Lucky', 200) * count;
    const tp = D.items.get(tid); if (!tp || !SONS[tp.SonType]) return 0;
    let grade = 1;
    for (let i = 1; i <= 5; i++) {
      const sk = D.skills.get(it['randomSkill' + i] || it['randomSkill_' + i] || 0);
      if (sk) { grade = Math.max(1, Math.min(12, sk.Grades || 1)); break; }
    }
    const base = tp.SonType === 109 ? cfg('Fashion_Wing', 1600) : cfg('Fashion_Other', 300);
    return base * Math.pow(2, grade - 1);
  }
  function addGp(p, gain) {
    const f = state(p);
    f.gp = (f.gp || 0) + gain;
    while (true) {
      const next = GRADE.get((f.grades || 1) + 1);
      if (!next || f.gp < (next.Data || 0)) break;
      f.gp -= next.Data || 0;
      f.grades = (f.grades || 1) + 1;
    }
  }
  ctx.onLoad.push(c => restat(c.player));

  return {
    C_FASHION_INFO: send,
    C_FASHION_APPLRAISAL(c, body) {
      const m = dec(c, 'C_FASHION_APPLRAISAL', body), p = c.player, f = state(p);
      const tp = D.items.get(m.templateId), b = tp && f.book[tp.TemplateId];
      if (!b) { alert(c, 'Não está neste livro de moda'); return send(c); }
      if (p.s.grades < OPEN_LV) { alert(c, `Personagem Lv. ${OPEN_LV} necessário`); return send(c); }
      const q = Math.max(1, Math.min(5, tp.Property2 || 1)), cur = SKILLS.find(r => r.TemplateId === b.skill);
      if (!cur) {
        const sk = skillOf(tp, 1);
        if (!sk) { alert(c, 'Esta moda não pode ser identificada'); return send(c); }
        if (!pay(c, [[-100, 200000 * (6 - q)]])) { alert(c, 'Ouro insuficiente'); return send(c); }
        b.skill = sk.TemplateId;
        alert(c, 'Moda identificada');
      } else {
        if (cur.Grades >= 5) { alert(c, 'Identificação no nível máximo'); return send(c); }
        const next = skillOf(tp, cur.Grades + 1);
        if (!next) return send(c);
        if (!pay(c, [[SOUL, 6 - q]])) { alert(c, 'Alma de Moda insuficiente'); return send(c); }
        if (Math.random() * 100 < (RATE[tp.TransformId] ?? 20)) { b.skill = next.TemplateId; alert(c, 'Identificação evoluiu'); }
        else alert(c, 'Identificação falhou');
      }
      restat(p); p.save();
      send(c);
      ctx.sendArmy(c); ctx.sendPlayer(c);
    },
    C_FASHION_EXCHANGE(c, body) {
      const m = dec(c, 'C_FASHION_EXCHANGE', body), p = c.player, f = state(p);
      const has = Object.prototype.hasOwnProperty;
      if (m.flag === 1) {
        for (const [key, field] of [['hat', 'hatAvata'], ['cloth', 'clothAvata'], ['arm', 'armAvata'], ['wing', 'wingAvata']]) {
          if (!has.call(m, field)) continue;
          const tid = m[field] || 0, tp = tid && D.items.get(tid);
          if (!tid) f[key] = 0;
          else if (tp && f.book[tid] && SONS[tp.SonType] === key) f[key] = tid;
        }
      } else if (/^[01](,[01]){3}$/.test(m.status || '')) f.status = m.status;
      p.save();
      sendT(c, 301, 'simple.FashionInfoMsg', info(p));
      ctx.sendArmy(c);
    },
    // swallow Hide-bag item for fashion GP / grade (client fashcompose_com)
    C_FASHION_COMPOSE(c, body) {
      const m = dec(c, 'C_FASHION_COMPOSE', body), p = c.player;
      const it = p.itemAt(0, HIDE);
      const fail = (msg) => { if (msg) alert(c, msg); sendT(c, COMPOSE_RSP, 'store.StoreRspMsg', { composeResult: false }); };
      if (!it) return fail('Coloque uma moda ou Alma de Moda primeiro');
      const tp = D.items.get(it.templateId);
      const isMat = it.templateId === SOUL || it.templateId === LUCKY;
      const isFashion = tp && SONS[tp.SonType] && tp.MasterType === 1;
      if (!isMat && !isFashion) return fail('Este item não pode ser absorvido');
      const n = Math.max(1, Math.min(it.count, m.count || 1));
      const gain = composeGp(it, n);
      if (!gain) return fail('Este item não pode ser absorvido');
      const entries = [];
      p.removeItem(it, n);
      entries.push(M.movedEntry(p, it, it.count <= 0));
      addGp(p, gain);
      restat(p); p.save();
      sendItems(c, entries);
      sendT(c, COMPOSE_RSP, 'store.StoreRspMsg', {
        composeResult: true, pos: it.count > 0 ? it.pos : 0, objectId: it.objectId || 0, bagType: HIDE,
        composeTemplateId: it.templateId,
      });
      sendT(c, 301, 'simple.FashionInfoMsg', info(p));
      ctx.sendPlayer(c); ctx.sendArmy(c);
      alert(c, `Moda +${gain} EXP (Nv. ${p.s.fashion.grades})`);
    },
    // mark a book entry as seen (client saveBook)
    C_FASHION_SWITCH(c, body) {
      const m = dec(c, 'C_FASHION_SWITCH', body), p = c.player, f = state(p);
      const tid = m.templateId;
      if (tid && f.book[tid]) { f.book[tid].seen = true; p.save(); }
    },
  };
};
