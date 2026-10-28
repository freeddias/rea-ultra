// Hero runes (t_s_runetemplate): battle skills learned from a rune stone, levelled with rune EXP, up to three
// carried into battle. Not in the official capture (the system opens at Lv35); everything here follows the
// client (bundle: Gr.sendStudyRune / sendUpgradeRune / sendTakeRune, __runeOperateHandler, MB runeCate,
// RuneUpgradeView, initRuneKeyList) and the tables:
//  - learning (opType 1 RUNE_STUDY {runeId, learnRunePos}): a bag item of SonType 302 whose Property1 is the
//    rune's RuneType is used up; the rune starts at grade 1
//  - EXP: the rune template's NeedGp is the total EXP needed for that grade (0, 1000, 2000, 5000 ... 100000);
//    "Rune Taşı" 3020010 gives its Property2 (50) per stone (opType 2 {runeId, count}); count 0 pays
//    UpRune_Price (2, client default) x (diamondIndex + 1) diamonds instead (escalating per day, the reply's
//    count). EXP from a diamond upgrade is not stated anywhere: we give one stone's worth.
//    A grade whose NeedGrade the character has not reached holds the EXP at that grade's NeedGp (client tip).
//  - carrying (opType 3 RUNE_TAKE {runeKey "id,id,id"}): slot n (0..2) opens at Lv35 + 5n, one rune per type
//  - in battle a carried rune is a BattleItemMsg on the hero (count = UseCount uses per battle)
const D = require('./data');
const T = require('../templates');

const RUNES = new Map(T.table('t_s_runetemplate').map(r => [r.TemplateId, r]));
const STONE = 3020010, BOOK_SONTYPE = 302, MAX_GRADE = 10, OPEN = 35;
const STONE_EXP = (T.items[STONE] || {}).Property2 || 50;

const jobOk = (r, job) => { const j = [].concat(r.Job || [0]).map(Number); return j.includes(0) || j.includes(job); };
const byTypeGrade = new Map([...RUNES.values()].map(r => [r.RuneType + '|' + r.RuneGrade, r]));
const first = (type, job) => [...RUNES.values()].find(r => r.RuneType === type && r.RuneGrade === 1 && jobOk(r, job));

const state = p => (p.s.runes = p.s.runes || {});
const studied = p => Object.values(state(p));
const keyList = p => String(p.s.runeKey || '-1,-1,-1').split(',').map(Number);
const slotsOpen = p => [0, 1, 2].filter(i => p.s.grades >= OPEN + 5 * i).length;

// grade from total EXP, held at the first grade the character's level does not allow
function settle(p, r) {
  let t = RUNES.get(r.id);
  for (;;) {
    const next = t && t.NextRuneId && RUNES.get(t.NextRuneId);
    if (!next || t.RuneGrade >= MAX_GRADE) { r.gp = Math.min(r.gp, t ? t.NeedGp : r.gp); break; }   // max grade: EXP stops there
    if (r.gp < next.NeedGp) break;
    if (p.s.grades < next.NeedGrade) { r.gp = next.NeedGp; break; }
    t = next; r.id = t.TemplateId;
  }
  // a carried rune keeps its slot after levelling
  const keys = keyList(p).map(k => { const kt = RUNES.get(k); return kt && kt.RuneType === t.RuneType ? t.TemplateId : k; });
  p.s.runeKey = keys.join(',');
}

function info(p) {
  return { userId: p.id, runeKey: p.s.runeKey || '-1,-1,-1',
    runeinfo: studied(p).map(r => ({ runeId: r.id, runeGp: r.gp, swallowCount: r.swallow || 0 })) };
}
// carried runes as battle items (HeroMsg.item)
function battleItems(p) {
  return keyList(p).slice(0, slotsOpen(p)).map((id, pos) => ({ id, pos })).filter(x => RUNES.has(x.id)).map(({ id, pos }) => {
    const t = RUNES.get(id);
    return { userId: p.id, uItemId: id, count: t.UseCount || 1, tempId: id, bagPos: pos, skillTempId: t.SkillTemplateId, sonType: t.SonType };
  });
}

module.exports = { RUNES, STONE, STONE_EXP, BOOK_SONTYPE, MAX_GRADE, OPEN, first, state, studied, keyList, slotsOpen, settle, info, battleItems, byTypeGrade, jobOk };
