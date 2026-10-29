// Muhafızlar — first stage (client Dh / wh guard controller, GuardMainWnd...; t_s_guardtemplate, guardstar,
// guardquailty, guardequiptemplate, guardequipstrengthen). Client-derived, no capture of the system:
//  C_GUARD_REQ (carnival.GuardReqInfoMsg {op, guardId, equipType, name, isFight, targetId, ...}), ops (client wh):
//   1 activate (ActivateItem, e.g. 50 shards 209101, and the star-0 row's Consume gold), 2 star up (the next star
//   row's Item + Consume; StarLevel 0..5), 3 awaken (next quality row of guardquailty when every equipment is at
//   least the current row's Condition "1,lv" (= that quality's equipment LimitLv) — client counts equips with equipLv >= lv; equipment becomes that quality's
//   InitialEquip, levels kept), 4 equipment level (guardequipstrengthen by the equip's EquipProfile and level:
//   Consume gold + Item; up to the equip's LimitLv), 9 name, 12 to battle (one guard), 15 follow, 13 another
//   player's guard in battle (4937 or "Nenhum guarda entrou em batalha"), 11 challenge formation (-> 4944).
//   Replies: 4919 GuardTotalInfoMsg (all, also on load), 4918 GuardInfoMsg (one).
//  Stats (client guard model getAttrResonanceArr / getAddValue / getEquipArr): for the star row, each AttrResonance
//  "type,v" gives the guard hero-stat x Resonance x v / 1e8 — 6 attack and 8 magic attack from the hero's larger
//  attack, 7 physical defence, 9 magic defence, 10 hp; equipment adds EquipAttr + EquipLvAttr x level per type.
//  In battle the guard in battle is its own unit on the hero's side (157 guards, read by the client as a hero
//  with isGuardFake: templateId = heroId = guard id) using the template's DefaultSkills attack.
// Not here yet: skills (5/6/7/8), talents, handbook (10), resolve (16), draw / expedition / arena / patrol.
// Our choices: the battle unit acts like a hero (cast time 3500), pos next to the hero; fighting capacity =
// attack + magic attack + defences + hp / 5.
const pad = n => String(n).padStart(2, '0');

module.exports = (ctx) => {
  const { D, table, dec, sendT, alert, pay, log, CONF } = ctx;
  const TPL = new Map(table('t_s_guardtemplate').map(r => [r.TemplateId, r]));
  const STAR = table('t_s_guardstar'), QUAL = table('t_s_guardquailty'), EQUIP = new Map(table('t_s_guardequiptemplate').map(r => [r.TemplateId, r]));
  const EQ_UP = table('t_s_guardequipstrengthen');
  // skills (t_s_guardskill): type 1 active — learned (old 0 -> a first-grade id of the template's Skill list) or
  // raised (old -> its NextTemplateId) for Consume gold + Item, guard star >= GuardStarLimit; type 2 passives cost
  // nothing and come with the star (GuardStarLimit). 6 opens a second skill page for guard_skillpoint (200)
  // diamonds (bound first), 7 picks the page (skillIndex), 8 stores its shortcut order (sonTypes -> firstKey /
  // secondKey). In battle the guard also uses its learned active skills.
  const GSK = new Map(table('t_s_guardskill').map(r => [r.SkillId, r]));
  const SECOND_PRICE = Number(CONF.str('guard_skillpoint')) || 200;
  // expertise (uzmanlık, t_s_guardtalent; op 14 activates the next node): 30 nodes a guard (TalentLevel), each
  // Consume gold + Item; every activated node adds its TalentAttr to the guard (client getGuardExpertiseTotalAdd
  // sums them); crux nodes (IfCrux, every 5th) also give their Talentskill.
  const TALENT = table('t_s_guardtalent');
  const talentRow = (id, lv) => TALENT.find(r => r.GuardId === id && r.TalentLevel === lv);
  // handbook (illustration, t_s_guardhandbook; op 10, type = 1 star / 2 quality / 3 expertise): the next TypeLv row
  // opens once the guard's star / quality / expertise level reaches its Condition; the current row of each book
  // gives its ActivateAttr to the hero (our choice: the collection bonus goes to the hero, p.s.adds.guardBook).
  const BOOK = table('t_s_guardhandbook');
  const bookRow = (id, type, lv) => BOOK.find(r => r.GuardId === id && r.Type === type && r.TypeLv === lv);
  const ATTRS = require('../attrs');
  function bookStats(p) {
    const add = {};
    for (const g of Object.values(state(p).list)) for (const type of [1, 2, 3]) {
      const row = bookRow(g.id, type, (g.books || {})[type] || 0); if (row) ATTRS.add(add, ATTRS.parse(row.ActivateAttr));
    }
    (p.s.adds = p.s.adds || {}).guardBook = add;
  }
  ctx.onLogin.push(c => bookStats(c.player));   // before the first PlayerMsg / ArmyMsg
  ctx.onLoad.push(c => bookStats(c.player));
  function passives(g) {
    const ids = String(TPL.get(g.id).Skill || '').split(',').filter(Boolean).map(Number);
    for (const id of ids) { const r = GSK.get(id); if (r && r.SkillType === 2 && (r.GuardStarLimit || 0) <= g.star && !g.skills.includes(id)) g.skills.push(id); }
  }
  const pairs = s => String(s || '').split('|').filter(Boolean).map(x => x.split(',').map(Number));
  const starRow = (id, star) => STAR.find(r => r.GuardId === id && r.StarLevel === star);
  const quals = id => QUAL.filter(r => r.GuardId === id).sort((a, b) => a.Quailty - b.Quailty);
  // Client getGuardQuailtyByGuardIdAndProfile looks up by Profile (0..4), not Quailty (2..6).
  // We store Quailty internally; every wire field named stage/guardStage/growthGrade must be Profile.
  const profileOf = g => { const row = quals(g.id).find(r => r.Quailty === g.stage); return row ? row.Profile : 0; };
  const state = p => (p.s.guards = p.s.guards || { list: {}, fight: 0, follow: 0, pos: '', index: '' });

  function stats(p, g) {
    const t = p.stats().total, row = starRow(g.id, g.star) || {};
    const hero = { 6: Math.max(t.phyAttack, t.magicAttack), 8: Math.max(t.phyAttack, t.magicAttack), 7: t.phyDefence, 9: t.magicDefence, 10: t.live };
    const add = { 6: 0, 7: 0, 8: 0, 9: 0, 10: 0 };
    for (const [type, v] of pairs(row.AttrResonance)) if (type in add) add[type] += Math.floor(hero[type] * (row.Resonance || 0) * v / 1e8);
    for (const e of g.equips) {
      const tp = EQUIP.get(e.id); if (!tp) continue;
      const base = Object.fromEntries(pairs(tp.EquipAttr));
      for (const [type, v] of pairs(tp.EquipLvAttr)) if (type in add) add[type] += v * e.lv + (base[type] || 0);
    }
    for (let lv = 1; lv <= (g.talent || 0); lv++) for (const [type, v] of pairs((talentRow(g.id, lv) || {}).TalentAttr)) if (type in add) add[type] += v;
    const rw = ctx.rareWeaponForGuard ? ctx.rareWeaponForGuard(p, g.id) : null;
    if (rw) {
      add[6] += rw.attack || 0; add[8] += rw.magicAttack || 0;
      add[7] += rw.defence || 0; add[9] += rw.magicDefence || 0; add[10] += rw.hp || 0;
    }
    const s = { attack: add[6], magicAttack: add[8], defence: add[7], magicDefence: add[9], hp: Math.max(1, add[10]) };
    s.fight = Math.ceil(s.attack + s.magicAttack + s.defence + s.magicDefence + s.hp / 5);
    return s;
  }
  // official look/activate payloads fill attackProps (6..13) + resiProps (14..20) with value and Pct
  function props(p, g) {
    const st = stats(p, g), row = starRow(g.id, g.star) || {}, res = row.Resonance || 0;
    const byType = { 6: st.attack, 7: st.defence, 8: st.magicAttack, 9: st.magicDefence, 10: st.hp, 12: 0, 13: 0 };
    const attackProps = [], resiProps = [];
    for (const [type, v] of pairs(row.AttrResonance)) {
      const pct = Math.floor(res * v / 1e6);
      if (type >= 14) resiProps.push({ type, value: byType[type] || 0, Pct: pct });
      else attackProps.push({ type, value: byType[type] || 0, Pct: pct });
    }
    for (const [type, v] of pairs(row.ElementResonance)) resiProps.push({ type, value: 0, Pct: Math.floor(res * v / 1e6) });
    return { attackProps, resiProps };
  }
  function msg(p, g, op) {
    const st = stats(p, g), S = state(p), tp = TPL.get(g.id), pr = props(p, g);
    return { guardId: g.id, guardName: g.name || ctx.nameOf(tp), guardStar: g.star, guardStage: profileOf(g),
      // learned skills only (DefaultSkills UseWay 3 is the basic attack, not a bar slot — Mh.CHANGE_SKILL_NUM = 5)
      skills: (g.skills || []).join(','), firstKey: g.firstKey || '', secondKey: g.secondKey || '',
      equipInfos: g.equips.map(e => ({ equipId: e.id, equipLv: e.lv, equipType: (EQUIP.get(e.id) || {}).EquipType || 0 })), fighting: st.fight,
      isFight: S.fight === g.id, isFollowing: S.follow === g.id, isActiveSecond: !!g.second, skillIndex: g.page || 0, talentLv: g.talent || 0,
      attackProps: pr.attackProps, resiProps: pr.resiProps, ...(op != null ? { op } : {}),
      illustrationStar: (g.books || {})[1] || 0, illustrationStage: (g.books || {})[2] || 0, illustrationTalentLv: (g.books || {})[3] || 0 };
  }
  // accompanying guard on the map (follow, else the one in battle — Ultra: always walk with the character)
  ctx.M.addShow(p => {
    const S = p.s.guards, id = S && (S.follow || S.fight), g = id && S.list[id];
    if (!g) return {};
    return { guardShowInfo: {
      guardTemplateId: g.id, guardStage: profileOf(g), guardLv: g.star || 0, guardStar: g.star || 0,
      guardName: g.name || ctx.nameOf(TPL.get(g.id)) || '', isFollowing: true,
    } };
  });
  const sendAll = c => sendT(c, 4919, 'carnival.GuardTotalInfoMsg', { guard: Object.values(state(c.player).list).map(g => msg(c.player, g)) });
  const sendOne = (c, g, op) => sendT(c, 4918, 'carnival.GuardInfoMsg', msg(c.player, g, op));
  const syncMap = c => {
    if (ctx.sendArmy) ctx.sendArmy(c);
    sendT(c, 140, 'army.MapUpdatedMsg', { updatedType: 3, army: ctx.M.mapArmy(c.player, 0) });
  };
  ctx.refreshGuards = sendAll;   // rareweapon.js after equip/unequip on a guard
  const sendChallenge = c => {
    const S = state(c.player);
    sendT(c, 4944, 'carnival.ChallengeGuardInfoMsg', { userId: c.player.id, chaPos: S.pos || '', fightIndex: S.index || '' });
  };
  ctx.onLoad.push(sendAll);
  ctx.onLoad.push(sendChallenge);   // Guard Arena formation (client GuardChallengeWnd)
  ctx.guardFight = (p, g) => stats(p, g).fight;   // features/guardpatrol.js (task type 5)

  // the guard in battle for logic.js startBattle
  ctx.guardBattle = p => { const S = state(p); return S.list[S.fight] ? combat(p, S.list[S.fight]) : null; };
  // any guard's battle values (also the guard arena, features/guardarena.js) and the arena line-up: formation 11
  // chaPos = 10 entries, entry i = the guard on battle position i (-1 empty)
  ctx.guardCombat = (p, id) => { const g = state(p).list[id]; return g ? combat(p, g) : null; };
  ctx.guardLineup = p => {
    const S = state(p);
    let lu = String(S.pos || '').split(',').map((x, i) => ({ pos: i, id: Number(x) })).filter(x => x.id > 0 && x.pos >= 1 && x.pos <= 9 && S.list[x.id]);
    // no challenge formation yet: fall back to the battle guard in the center slot so the arena can open
    if (!lu.length && S.fight && S.list[S.fight]) lu = [{ pos: 5, id: S.fight }];
    return lu;
  };
  function combat(p, g) {
    const tp = TPL.get(g.id), st = stats(p, g), q = quals(g.id).find(r => r.Quailty === g.stage) || {};
    const active = (g.skills || []).filter(id => (D.skills.get(id) || {}).UseWay === 1);
    return { id: g.id, name: g.name || ctx.nameOf(tp), star: g.star, stage: profileOf(g), headId: Number(q.Avater) || 0, stats: st, skill: Number(String(tp.DefaultSkills).split(',')[0]) || 40081, skills: active };
  }

  return {
    C_GUARD_REQ(c, body) {
      const m = dec(c, 'C_GUARD_REQ', body), p = c.player, S = state(p);
      const tp = TPL.get(m.guardId), g = S.list[m.guardId];
      switch (m.op) {
        case 1: {
          // client checkGuardCanActive: only ActivateItem shards (no star-0 Consume gold)
          if (!tp) { alert(c, 'Guarda não encontrado'); return; }
          if (g) { alert(c, 'Este guarda já está ativo'); return sendOne(c, g, 1); }
          const cost = pairs(tp.ActivateItem).filter(([tid, n]) => tid && n);
          if (!cost.length) { alert(c, 'Este guarda não pode ser ativado'); return; }
          const short = cost.find(([tid, n]) => p.countTemplate(tid) < n);
          if (short) {
            const [tid, n] = short, name = ctx.itemName(tid) || tid;
            alert(c, `Precisa de ${n}x ${name} (tem ${p.countTemplate(tid)})`);
            return;
          }
          if (!pay(c, cost)) { alert(c, 'Fragmentos de guarda insuficientes'); return; }
          const q = quals(tp.TemplateId)[0];
          S.list[tp.TemplateId] = { id: tp.TemplateId, star: 0, stage: q ? q.Quailty : 2, name: '', equips: String(q ? q.InitialEquip : '').split(',').filter(Boolean).map(id => ({ id: Number(id), lv: 0 })), skills: [] };
          passives(S.list[tp.TemplateId]);
          // Ultra: first activated guard goes to battle and follows on the map
          if (!S.fight) S.fight = tp.TemplateId;
          if (!S.follow) S.follow = tp.TemplateId;
          alert(c, `${ctx.nameOf(tp)} ativado!`);
          break;
        }
        case 2: {
          // client checkGuardCanUpdateStar: current star row's Item + Consume (not the next row)
          if (!g) return;
          if (g.star >= 5 || !starRow(g.id, g.star + 1)) { alert(c, 'Já está na estrela máxima'); return; }
          const row = starRow(g.id, g.star);
          if (!row) { alert(c, 'Já está na estrela máxima'); return; }
          const cost = pairs(row.Item); if (row.Consume) cost.push([-100, row.Consume]);
          if (!pay(c, cost)) { alert(c, 'Fragmentos de guarda/ouro insuficientes'); return; }
          g.star++; g.skills = g.skills || []; passives(g);
          break;
        }
        case 3: {
          if (!g) return;
          const list = quals(g.id), i = list.findIndex(r => r.Quailty === g.stage), next = list[i + 1];
          if (!next) { alert(c, 'Já está na qualidade máxima'); return; }
          // the current quality row's Condition "1,lv" (= its equipment LimitLv) is what leaving it needs
          const need = (pairs(list[i].Condition).find(([ty]) => ty === 1) || [1, 0])[1];
          if (g.equips.some(e => e.lv < need)) { alert(c, `Todos os equipamentos devem estar no Lv. ${need}`); return; }
          const ids = String(next.InitialEquip || '').split(',').filter(Boolean).map(Number);
          g.equips = g.equips.map((e, k) => ({ id: ids[k] || e.id, lv: e.lv }));
          g.stage = next.Quailty;
          alert(c, 'Guarda despertou!');
          break;
        }
        case 4: {
          if (!g) return;
          const e = g.equips.find(x => (EQUIP.get(x.id) || {}).EquipType === m.equipType), et = e && EQUIP.get(e.id);
          if (!et) return;
          if (e.lv >= (et.LimitLv || 0)) { alert(c, 'Equipamento no nível máximo desta qualidade'); return; }
          const row = EQ_UP.find(r => r.EquipProfile === et.EquipProfile && r.EquipLv === e.lv);
          if (!row) return;
          const cost = pairs(row.Item); if (row.Consume) cost.push([-100, row.Consume]);
          if (!pay(c, cost)) { alert(c, 'Materiais/ouro insuficientes'); return; }
          e.lv++;
          break;
        }
        case 5: {
          if (!g) return;
          g.skills = g.skills || [];
          const list = String(TPL.get(g.id).Skill || '').split(',').filter(Boolean).map(Number);
          const old = m.oldSkillId || 0, want = m.newSkillId, row = GSK.get(want), sk = D.skills.get(want);
          const ok = row && sk && row.SkillType === 1 && (old ? g.skills.includes(old) && Number((D.skills.get(old) || {}).NextTemplateId) === Number(want) : list.includes(want) && !g.skills.includes(want));
          if (!ok) { alert(c, 'Esta habilidade não pode ser aprendida'); return; }
          if ((row.GuardStarLimit || 0) > g.star) { alert(c, `Guarda precisa ter ${row.GuardStarLimit} estrelas`); return; }
          // Mh.CHANGE_SKILL_NUM = 5 fast slots; Priority 3 = skill E (awaken) and does not consume a slot
          if (!old) {
            const isSuper = (sk.Priority || 0) === 3;
            const fast = g.skills.filter(id => { const s = D.skills.get(id); return s && s.UseWay === 1 && (s.Priority || 0) !== 3; });
            if (!isSuper && fast.length >= 5) { alert(c, 'Espaços de habilidade cheios (máx. 5)'); return; }
          }
          const cost = pairs(row.Item); if (row.Consume) cost.push([-100, row.Consume]);
          if (!pay(c, cost)) { alert(c, 'Materiais/ouro insuficientes'); return; }
          g.skills = old ? g.skills.map(id => id === old ? want : id) : g.skills.concat(want);
          break;
        }
        case 6: {
          if (!g || g.second) return;
          if (!pay(c, [[m.payType !== 1 && ctx.balance(p, -500) >= SECOND_PRICE ? -500 : -400, SECOND_PRICE]])) { alert(c, 'Diamantes insuficientes'); return; }
          g.second = true; break;
        }
        case 7: if (!g || (m.skillIndex === 1 && !g.second)) return; g.page = m.skillIndex ? 1 : 0; break;
        case 8: if (!g) return; if ((g.page || 0) === 1) g.secondKey = String(m.sonTypes || ''); else g.firstKey = String(m.sonTypes || ''); break;
        case 10: {
          if (!g) return;
          const type = m.type || 1, lv = ((g.books = g.books || {})[type] || 0) + 1, row = bookRow(g.id, type, lv);
          if (!row) { alert(c, 'Manual no nível máximo'); return; }
          const have = type === 1 ? g.star : type === 2 ? g.stage : g.talent || 0;
          if (have < (row.Condition || 0)) { alert(c, 'Condição não atendida'); return; }
          g.books[type] = lv; bookStats(p); ctx.sendPlayer(c); if (ctx.sendArmy) ctx.sendArmy(c);
          break;
        }
        case 16: {   // shards -> ChangeItem (client resolve window: equipType = how many times)
          if (!g) return;
          const n = Math.max(1, m.equipType || 1), [bid, bn] = pairs(TPL.get(g.id).BasicItem)[0] || [], [cid, cn] = pairs(TPL.get(g.id).ChangeItem)[0] || [];
          if (!bid || !cid) return;
          if (!pay(c, [[bid, bn * n]])) { alert(c, 'Fragmentos de guarda insuficientes'); return; }
          ctx.grant(c, [[cid, cn * n]]);
          break;
        }
        case 14: {
          if (!g) return;
          const row = talentRow(g.id, (g.talent || 0) + 1);
          if (!row) { alert(c, 'Especialização no nível máximo'); return; }
          const cost = pairs(row.Item); if (row.Consume) cost.push([-100, row.Consume]);
          if (!pay(c, cost)) { alert(c, 'Materiais/ouro insuficientes'); return; }
          g.talent = (g.talent || 0) + 1;
          g.skills = g.skills || [];
          for (const id of String(row.Talentskill || '').split(',').filter(Boolean).map(Number)) if (!g.skills.includes(id)) g.skills.push(id);
          break;
        }
        case 9: {
          if (!g) return;
          const name = String(m.name || '').trim().slice(0, 12); if (!name) return;
          g.name = name; break;
        }
        case 12: {
          if (!g) return;
          S.fight = m.isFight ? g.id : (S.fight === g.id ? 0 : S.fight);
          // Ultra: battle guard also accompanies the character on the map
          if (m.isFight) S.follow = g.id;
          else if (S.follow === g.id) S.follow = S.fight || 0;
          p.save(); sendAll(c); syncMap(c); return;
        }
        case 15: {
          if (!g) return;
          S.follow = S.follow === g.id ? 0 : g.id;
          p.save(); sendAll(c); syncMap(c); return;
        }
        case 11: S.pos = String(m.challengePos || ''); S.index = String(m.fightIndex || ''); p.save();
          return sendT(c, 4944, 'carnival.ChallengeGuardInfoMsg', { userId: p.id, chaPos: S.pos, fightIndex: S.index });
        case 13: {
          const other = ctx.playerById(m.targetId), OS = other && other.s.guards, og = OS && OS.list[OS.fight];
          if (!og) { alert(c, 'Nenhum guarda entrou em batalha'); return; }
          return sendT(c, 4937, 'carnival.GuardInfoMsg', msg(other, og));
        }
        default: log(`[#${c.id}] guard op ${m.op} not implemented`); alert(c, 'Esta ação de guarda ainda não existe'); return;
      }
      p.save();
      if (S.list[m.guardId]) sendOne(c, S.list[m.guardId], m.op);
      if (m.op === 1) { sendAll(c); syncMap(c); }
      else if (ctx.sendArmy) ctx.sendArmy(c);
    },
  };
};
