// Onur ekipmanı / askerî rütbe (client HonorEquip window; t_s_honorequip). Client-derived, the capture only had
// an empty 4556 at login:
//  UpgradeType 0 = equipment levels 0..600, UpgradeType 1 = ranks (Sivil, Özel Asker ...). The row of a level
//  holds that level's total attributes and the price of the next step (ConsumeGold gold, ConsumeItem items,
//  e.g. Madalya 208001); LevelLimit = character level needed. A level row's Honor needs the rank of the first
//  rank row whose Honor >= it (client geHonorLevelByHonor + "honorEquip.levelLack").
//  C_HONOR_EQUIP_LEVELUP {param1: 1 level up, 2 rank up} -> 4556 HonorEquipInfoMsg {level, stage}.
//  A rank needs onur puanı (PlayerMsg.geste, p.s.geste) of its Honor — earned in war fields, which this server
//  does not have yet: ranks stay at the start until geste comes from somewhere.
//  Stats: the level row + the rank row, flat (p.s.honor.add, player.js stats).
const KEYS = ['Power', 'Agility', 'Intellect', 'Physique', 'Captain', 'Attack', 'MagicAttack', 'Defence', 'MagicDefence', 'Live', 'ForceHit', 'Parry'];

module.exports = (ctx) => {
  const { dec, sendT, sendPlayer, sendArmy, alert, pay, table, parseRewards, log } = ctx;
  const ROWS = table('t_s_honorequip');
  const LEVEL = new Map(ROWS.filter(r => r.UpgradeType === 0).map(r => [r.Level, r]));
  const RANK = ROWS.filter(r => r.UpgradeType === 1).sort((a, b) => a.Level - b.Level);
  const rankRow = n => RANK.find(r => r.Level === n);
  const needRank = honor => { const r = RANK.find(x => x.Honor >= honor); return r ? r.Level : 0; };
  const state = p => (p.s.honor = p.s.honor || { level: 0, stage: 0 });
  function recalc(p) {
    const s = state(p), add = Object.fromEntries(KEYS.map(k => [k, 0]));
    for (const r of [LEVEL.get(s.level), rankRow(s.stage)]) if (r) for (const k of KEYS) add[k] += r[k] || 0;
    s.add = add;
  }
  const send = c => sendT(c, 4556, 'simple.HonorEquipInfoMsg', { level: state(c.player).level, stage: state(c.player).stage });
  ctx.onLoad.push(c => { recalc(c.player); send(c); });
  function cost(r) { return [[-100, r.ConsumeGold || 0], ...parseRewards(r.ConsumeItem)]; }

  return {
    C_HONOR_EQUIP_LEVELUP(c, body) {
      const m = dec(c, 'C_HONOR_EQUIP_LEVELUP', body), p = c.player, s = state(p);
      if (m.param1 === 2) {
        const cur = rankRow(s.stage), next = rankRow(s.stage + 1);
        if (!next) { alert(c, 'Você já está na patente máxima'); return send(c); }
        if ((p.s.geste || 0) < (next.Honor || 0)) { alert(c, `Pontos de honra insuficientes (${next.Honor} necessário)`); return send(c); }
        if (cur && !pay(c, cost(cur))) { alert(c, ' kaynak não há'); return send(c); }
        s.stage++;
      } else {
        const cur = LEVEL.get(s.level), next = LEVEL.get(s.level + 1);
        if (!cur || !next) { alert(c, 'Já está no nível máximo'); return send(c); }
        if (p.s.grades < (next.LevelLimit || 0)) { alert(c, `Personagem Lv. ${next.LevelLimit} necessário`); return send(c); }
        if (next.Honor && s.stage < needRank(next.Honor)) { const r = rankRow(needRank(next.Honor)); alert(c, `${ctx.nameOf(r, 'Honorequipname') || 'Patente mais alta'} necessário`); return send(c); }
        if (!pay(c, cost(cur))) { alert(c, 'Ouro ou medalha insuficientes'); return send(c); }
        s.level++;
      }
      recalc(p); p.save();
      send(c); sendPlayer(c); sendArmy(c);
      log(`[#${c.id}] honor equip level ${s.level} stage ${s.stage}`);
    },
  };
};
