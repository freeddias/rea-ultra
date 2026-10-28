// Peri ekipmanı item data (MasterType 5, SonType 501..506 = parts 0..5; t_s_petequipattr / quality / strengthen /
// suit). Client-derived (PetEquipTipView, PetEuipTrainWnd, PetEquipSuccinctWnd), no capture:
//  The item's attribute pools are drop lists: Property1 = the main attribute, Property2 = the sub attributes,
//  Property3 = the equipment effect (suitId); each drop ItemId is a t_s_petequipattr / t_s_petequipsuit row.
//  ItemInfoMsg masterAttr / sonAttr = "AttributeId:value:next;" (the client shows value and value + next).
//  Main value = rolled in BaseValue [lo, hi] + StrengthenGrow x strengthen level. Sub value = lo + hi x ups
//  ("(Lv ups)" in the tip: (value - lo) / hi); every PETEQUIP_SONATTR_RANDOM_UP (10) levels a random sub attribute
//  gets one up (quality SonAttrStreng). Sub slots: the quality's SonAttrOpen entries <= strengthen level (0 = open).
//  Max strengthen = quality StrengMax. Sets: items with the same suitId and strengthen >= that row's StrengthenGrow,
//  every Amount of them = one activation of AttributeId + ValueParam (client checkActiveSuit).
//  EX entries (t_s_petequipadd, group = the item's Property4): AddType ids > 1000 = percent (/ 10000); the pet
//  window applies 1006..1010 to (attack, magic attack, defence, magic defence, hp) + the equipment part.
// Our choices: an item whose Property3 is empty gets one of the stat sets 1..5; equipment effect skills
// (SuitSkill) have no battle effect.
const T = require('../templates');
const D = require('./data');
const PET_BAG = 27, PET_EQUIP_BAG = 28, SON_UP = 10;
const ATTR = new Map(T.table('t_s_petequipattr').map(r => [r.TemplateId, r]));
const QUAL = new Map(T.table('t_s_petequipquality').map(r => [r.Profile, r]));
const STR = new Map(T.table('t_s_petequipstrengthen').map(r => [r.TemplateId, r]));
const ENTRY = new Map(T.table('t_s_petequipadd').map(r => [r.TemplateId, r]));   // entries (EX promotion): AddType "id,value|..."
const SUIT = new Map(); for (const r of T.table('t_s_petequipsuit')) if (!SUIT.has(r.SuitId)) SUIT.set(r.SuitId, r);
const POOL = new Map(); for (const r of T.table('t_s_dropitem')) { if (!POOL.has(r.DropId)) POOL.set(r.DropId, []); POOL.get(r.DropId).push(r.ItemId); }
const cfg = n => (T.table('t_s_config').find(r => r.ConfigName === n) || {}).ConfigValue;
const BAG_BASE = Number(String(cfg('pet_bag') || '100,300').split(',')[0]) || 100;
const BAG_MAX = Number(String(cfg('pet_bag') || '100,300').split(',')[1]) || 300;

const isPetEquip = tp => !!tp && tp.MasterType === 5 && tp.SonType >= 501 && tp.SonType <= 506;
const range = row => String(row.BaseValue || '0,0').split(',').map(Number);
const pick = a => a[Math.floor(Math.random() * a.length)];
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pool = id => (POOL.get(id) || []).filter(x => ATTR.has(x));
const qual = tp => QUAL.get(tp.Profile) || QUAL.get(1);
const slots = (tp, sg) => String(qual(tp).SonAttrOpen || '').split(',').filter(x => x !== '' && Number(x) <= sg).length;

function newSon(tp, have) {
  const used = new Set(have.map(([id]) => ATTR.get(id).AttributeId));
  const free = pool(tp.Property2).filter(id => !used.has(ATTR.get(id).AttributeId));
  return free.length ? [pick(free), 0] : null;
}
function rollMain(tp) { const id = pick(pool(tp.Property1)); if (!id) return null; const [lo, hi] = range(ATTR.get(id)); return [id, rnd(lo, Math.max(lo, hi))]; }
function rollSuit(tp) { const s = (POOL.get(tp.Property3) || []).filter(x => SUIT.has(x)); return s.length ? pick(s) : rnd(1, 5); }
function fillSons(tp, pe, sg) { while (pe.s.length < slots(tp, sg)) { const x = newSon(tp, pe.s); if (!x) break; pe.s.push(x); } }

// it.pe = { m: [attr row, rolled base], s: [[attr row, ups], ...], suit }
function init(it) {
  const tp = D.items.get(it.templateId);
  if (!isPetEquip(tp) || it.pe) return false;
  it.pe = { m: rollMain(tp), s: [], suit: rollSuit(tp) };
  fillSons(tp, it.pe, it.strengthenGrade || 0);
  return true;
}
// succinct: a new main roll, new sub attribute kinds (same count and ups), a new effect
function reroll(it) {
  const tp = D.items.get(it.templateId), pe = { m: rollMain(tp), s: [], suit: rollSuit(tp) };
  for (const [, ups] of it.pe.s) { const x = newSon(tp, pe.s); if (x) pe.s.push([x[0], ups]); }
  return pe;
}
const mainVal = (pe, sg) => { if (!pe.m) return 0; const r = ATTR.get(pe.m[0]); return pe.m[1] + (r.StrengthenGrow || 0) * sg; };
const sonVal = ([id, ups]) => { const [lo, hi] = range(ATTR.get(id)); return lo + hi * ups; };
function attrStrings(pe, sg) {
  const m = pe.m ? `${ATTR.get(pe.m[0]).AttributeId}:${mainVal(pe, sg)}:${ATTR.get(pe.m[0]).StrengthenGrow || 0};` : '';
  const s = pe.s.map(x => `${ATTR.get(x[0]).AttributeId}:${sonVal(x)}:${range(ATTR.get(x[0]))[1]};`).join('');
  return { masterAttr: m, sonAttr: s };
}
// ItemInfoMsg fields
function fields(it) {
  if (!it.pe) return {};
  return Object.assign(attrStrings(it.pe, it.strengthenGrade || 0), { suitId: it.pe.suit || 0, entryId: it.pe.entry || 0 });
}
// one strengthen level done: subs open / grow
function leveled(it) {
  const tp = D.items.get(it.templateId), sg = it.strengthenGrade || 0;
  fillSons(tp, it.pe, sg);
  if (sg % SON_UP === 0 && it.pe.s.length) pick(it.pe.s)[1]++;
}
const maxLevel = tp => qual(tp).StrengMax || 0;

// what the worn equipment of a pet adds: attribute id -> amount (sets included)
function petAdds(p, petId) {
  const worn = p.s.bag.filter(i => i.bagType === PET_EQUIP_BAG && i.objectId === petId && i.pe && i.pos <= 5);
  const add = {}, plus = (k, v) => { add[k] = (add[k] || 0) + v; };
  const suits = {};
  for (const it of worn) {
    const sg = it.strengthenGrade || 0;
    if (it.pe.m) plus(ATTR.get(it.pe.m[0]).AttributeId, mainVal(it.pe, sg));
    for (const x of it.pe.s) plus(ATTR.get(x[0]).AttributeId, sonVal(x));
    const s = SUIT.get(it.pe.suit);
    if (s && sg >= (s.StrengthenGrow || 0)) suits[s.SuitId] = (suits[s.SuitId] || 0) + 1;
  }
  // entries: ids > 1000 are percentages (value / 10000) of attribute id - 1000 (client calAttr / calAttrEntry)
  for (const it of worn) { const e = ENTRY.get(it.pe.entry); if (e) for (const x of String(e.AddType || '').split('|')) { const [k, v] = x.split(',').map(Number); if (k) plus(k, v || 0); } }
  for (const [id, n] of Object.entries(suits)) { const s = SUIT.get(Number(id)); if (s.AttributeId > 0 && s.ValueParam > 0) plus(s.AttributeId, s.ValueParam * Math.floor(n / (s.Amount || 1))); }
  return add;
}

const entries = group => [...ENTRY.values()].filter(r => r.AddGroup === group);
module.exports = { PET_BAG, PET_EQUIP_BAG, BAG_BASE, BAG_MAX, ATTR, QUAL, STR, SUIT, ENTRY, entries, isPetEquip, init, reroll, fields, attrStrings, leveled, maxLevel, petAdds };
