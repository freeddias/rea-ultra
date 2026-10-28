// Attribute ids of t_s_attribute (used by rare weapons, guards, pet equipment ...: "6,950|10,19000") -> the
// stat keys player.js adds. 11 troop count, 14..19 element resists, 20+ (resist reduction, armour piercing,
// crit resist, block piercing ...) have no effect in battle.js and are skipped.
const KEY = { 1: 'Power', 2: 'Agility', 3: 'Intellect', 4: 'Physique', 5: 'Captain', 6: 'Attack', 7: 'Defence', 8: 'MagicAttack', 9: 'MagicDefence', 10: 'Live', 12: 'ForceHit', 13: 'Parry' };
// "id,value|id,value" -> [[id, value], ...]
const parse = s => String(s || '').split('|').map(x => x.split(',').map(Number)).filter(([id, v]) => id && !isNaN(v));
// adds [[id, value]] (times pct / 100) into a { Power, Attack, ... } object
function add(into, list, pct = 100) {
  for (const [id, v] of list) { const k = KEY[id]; if (k) into[k] = (into[k] || 0) + Math.floor(v * pct / 100); }
  return into;
}
module.exports = { KEY, parse, add };
