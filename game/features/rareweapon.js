// Nadir silahlar / efsanevi silahlar (client lK / uo; t_s_rareweapontemplate, t_s_rareweaponupgrade,
// t_s_rareweaponresonance). Client-derived, the capture only had an empty 553 at login:
//  four weapons (Type 4 Gae Bolg, 5, 6, 10), each a template chain (Call 1 = the first, NextTemplateId = next
//  star, Levelmax). C_RARE_WEAPON_MAIN_REQ {op, type, pos}:
//   1 activate (the first template's CostItem, fragments SonType 901) or advance a star (the next template's
//     CostItem + Gold), 2 upgrade a level (t_s_rareweaponupgrade Type = weapon type, Level + 1: UpItem x
//     UpItemNum + UpGold, up to the template's Levelmax), 3 equip pos (0 = the hero, -1 = take off, a guard
//     templateId), 4 hole pos (= 10 x the host weapon's type + slot, -1 = out): a holed weapon gives its host
//     AttrPercent % (t_s_rareweaponresonance, 25) of its attributes, 8 another player's (no answer).
//  -> 553 RareWeaponMainInfo {info: [{tempId, level (-1 = not activated), index (-1 / 0 / guard), type,
//     holePos}]} (client updateRareWeaponInfo).
//  The hero's weapon adds its attributes (current level's ProId + the template's Starpro, client
//  calculateSelfPropertyMap) and its holed weapons' share (calculateTotalPropertyMap); attribute ids are
//  t_s_attribute (game/attrs.js). A weapon on a guard (index = guardId) feeds guards.js stats via
//  ctx.rareWeaponForGuard. The weapon's SkillId (a battle skill) is not used by battle.js.
//  Forging (C_RARE_WEAPON_MAIN_DRAW_REQ) has no pool data here: answered with a message.
const A = require('../attrs');

module.exports = (ctx) => {
  const { dec, sendT, sendPlayer, sendArmy, alert, pay, table, parseRewards, log } = ctx;
  const TPL = new Map(table('t_s_rareweapontemplate').map(r => [r.TemplateId, r]));
  const FIRST = new Map([...TPL.values()].filter(r => r.Call === 1).map(r => [r.Type, r]));
  const UP = new Map(table('t_s_rareweaponupgrade').map(r => [`${r.Type}_${r.Level}`, r]));
  const RES = table('t_s_rareweaponresonance');
  const state = p => (p.s.rareWeapons = p.s.rareWeapons || {});
  const weapon = (p, type) => state(p)[type] || { tempId: (FIRST.get(type) || {}).TemplateId, level: -1, index: -1, holePos: -1 };
  const info = p => [...FIRST.keys()].map(type => Object.assign({ type }, weapon(p, type)));
  const send = c => sendT(c, 553, 'rareweapon.RareWeaponMainInfo', { info: info(c.player) });
  function self(w) {
    const t = TPL.get(w.tempId), u = UP.get(`${t.Type}_${w.level}`);
    return [...A.parse(u && u.ProId), ...A.parse(t.Starpro)];
  }
  // total rare-weapon attrs on a host index (0 = hero, guardId = that guard)
  function totalOn(p, index) {
    const add = {}, all = info(p).filter(w => w.level >= 0);
    for (const host of all.filter(w => w.index === index)) {
      A.add(add, self(host));
      for (const h of all.filter(w => w.holePos >= 0 && Math.floor(w.holePos / 10) === host.type)) {
        const r = RES.find(x => x.Number === h.holePos % 10) || RES[0];
        A.add(add, self(h), r ? r.AttrPercent : 0);
      }
    }
    return add;
  }
  function recalc(p) {
    (p.s.adds = p.s.adds || {}).rareWeapon = totalOn(p, 0);
  }
  // guards.js: flat combat stats from the weapon equipped on this guard
  ctx.rareWeaponForGuard = (p, guardId) => {
    const a = totalOn(p, guardId);
    return {
      attack: a.Attack || 0, magicAttack: a.MagicAttack || 0,
      defence: a.Defence || 0, magicDefence: a.MagicDefence || 0, hp: a.Live || 0,
    };
  };
  ctx.onLoad.push(c => { recalc(c.player); send(c); });
  const cost = r => [...parseRewards(r.CostItem), [-100, r.Gold || 0]];

  return {
    C_RARE_WEAPON_MAIN_REQ(c, body) {
      const m = dec(c, 'C_RARE_WEAPON_MAIN_REQ', body), p = c.player;
      if (m.op === 8) { alert(c, 'Não é possível mostrar armas raras de outros jogadores'); return; }
      if (!FIRST.has(m.type)) return send(c);
      const w = Object.assign({}, weapon(p, m.type)), t = TPL.get(w.tempId);
      if (m.op === 1) {
        if (w.level < 0) {
          if (!pay(c, parseRewards(t.CostItem))) { alert(c, 'Fragmentos insuficientes'); return send(c); }
          w.level = 0;
        } else {
          const next = TPL.get(t.NextTemplateId);
          if (!next) { alert(c, 'Já está na estrela máxima'); return send(c); }
          if (!pay(c, cost(next))) { alert(c, 'Material ou ouro insuficiente'); return send(c); }
          w.tempId = next.TemplateId;
        }
      } else if (m.op === 2) {
        const u = UP.get(`${m.type}_${w.level + 1}`);
        if (w.level < 0) { alert(c, 'Ative primeiro'); return send(c); }
        if (!u || w.level >= (t.Levelmax || 0)) { alert(c, 'Nível máximo nesta estrela'); return send(c); }
        if (!pay(c, [[u.UpItem, u.UpItemNum || 0], [-100, u.UpGold || 0]])) { alert(c, 'Material ou ouro insuficiente'); return send(c); }
        w.level++;
      } else if (m.op === 3) {
        if (w.level < 0) return send(c);
        const pos = m.pos;
        if (pos !== 0 && pos !== -1) {
          const g = ((p.s.guards || {}).list || {})[pos];
          if (!g) { alert(c, 'Guarda não encontrado'); return send(c); }
        }
        // one rare weapon per host (hero index 0 or a guard templateId)
        if (pos === 0 || pos > 0) for (const o of Object.values(state(p))) if (o.index === pos) o.index = -1;
        w.index = pos;
        if (pos === 0 || pos > 0) w.holePos = -1;
      } else if (m.op === 4) {
        if (w.level < 0) return send(c);
        const host = Math.floor((m.pos || 0) / 10);
        if (m.pos >= 0 && (host === m.type || !FIRST.has(host) || weapon(p, host).level < 0)) { alert(c, 'Não pode ser equipado neste espaço'); return send(c); }
        if (m.pos >= 0) for (const o of Object.values(state(p))) if (o.holePos === m.pos) o.holePos = -1;   // one per slot
        w.holePos = m.pos; if (m.pos >= 0) w.index = -1;
      } else return send(c);
      state(p)[m.type] = w;
      recalc(p); p.save();
      send(c); sendPlayer(c); sendArmy(c);
      if (ctx.refreshGuards) ctx.refreshGuards(c);
      log(`[#${c.id}] rare weapon ${m.type} op ${m.op}: tpl ${w.tempId} lv ${w.level} idx ${w.index} hole ${w.holePos}`);
    },
    C_RARE_WEAPON_MAIN_DRAW_REQ(c) { alert(c, 'Forja de armas ainda não disponível neste servidor'); },
  };
};
