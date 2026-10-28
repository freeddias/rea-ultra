// Kayıp Kule (confusion tower; client zY / YY ConfusedTowerWnd; t_s_uiplaybase 211 "İlahi Yükseliş Merdiveni",
// 300 floors in t_s_uiplaylevel, shop t_s_uiplayshop; config Messtower_times "1,10", Messtower_count
// "1,10,150|11,40,100|41,100,50|101,500,20|501,999999,10"). Client-derived (help text ConfusedTowerWnd.HelpContent):
//  Uyanıklık: Messtower_times[1] (10) a day; a won challenge spends 1 (ConsumeNum), a lost one nothing.
//  Remaining points become raid points (op 4, one each; ConfusionTowerInfoRes surplusTimes = raidNum); a raid
//  fight (op 3) spends all of them for a base stat bonus: per Messtower_count row [from, to, x/100 %] every point in
//  the range adds x/100 % (client currentAddAttrRate).
//  C_CONFUSION_TOWER uiplay.ConfusionTowerOpReq {op, shopId, buyNum, flag}: 0 info, 1 challenge the next floor
//  (the first UiLevelId above levelId), 2 shop buy (GiftToken = bound diamonds, Point = diamonds (flag: bound
//  first); Limit per item; MessTower = the floor needed), 3 raid, 4 one point -> raid point.
//  -> 4975 U_C_CONFUSION_INFO {chapter, levelId (last cleared floor), challengeTimes (used), surplusTimes, buyRecord}.
//  Fights: battle type 3898 CONFUSION_TOWER_BATTLE against the floor boss (BossId); a win gives the Reward drop.
// Our choice: the daily refill is at the day change (the help says 05:00).
const DROPS = require('../drops');

module.exports = (ctx) => {
  const { table, dec, sendT, alert, pay, grant, CONF, sysTime, log } = ctx;
  const FLOORS = table('t_s_uiplaylevel').filter(r => r.UiPlayId === 211 && r.UiLevelSort > 0).sort((a, b) => a.UiLevelId - b.UiLevelId);
  const SHOP = new Map(table('t_s_uiplayshop').map(r => [r.Id, r]));
  const TIMES = Number(String(CONF.str('Messtower_times') || '1,10').split(',')[1]) || 10;
  const TIERS = String(CONF.str('Messtower_count') || '1,10,150|11,40,100|41,100,50|101,500,20|501,999999,10').split('|').map(x => x.split(',').map(Number));
  const day = () => sysTime().slice(0, 10);
  function state(p) {
    const s = p.s.confTower = p.s.confTower || { level: 0, raid: 0, bought: {} };
    if (s.day !== day()) Object.assign(s, { day: day(), used: 0 });
    return s;
  }
  // client currentAddAttrRate
  const rate = n => { let r = 0; for (const [a, b, x] of TIERS) { if (n < a) break; r += (Math.min(n, b) - a + 1) * x / 100; if (n <= b) break; } return r; };
  const next = s => FLOORS.find(r => r.UiLevelId > s.level);
  const info = c => { const s = state(c.player); sendT(c, 4975, 'uiplay.ConfusionTowerInfoRes', { chapter: 211, levelId: s.level,   // capture: chapter 211 (the uiplay id), levelId 2110021
    challengeTimes: s.used, surplusTimes: s.raid, buyRecord: Object.assign({}, s.bought) }); };
  ctx.onLoad.push(info);
  const roll = id => { const got = new Map(); for (const [t, n] of DROPS.roll(id)) got.set(t, (got.get(t) || 0) + n); return [...got]; };

  function fight(c, f, bonus) {
    const p = c.player, s = state(p);
    ctx.startBattle(c, { Heros: f.BossId, Soldiers: '', BattleType: 3898, battleScene: 55, mapTempId: 5, Level: f.Grade,
      setup(units, prep) {
        if (!bonus) return;
        const me = units.find(u => u.playerHero), ph = prep.heros.find(h => h.userId === p.id); if (!me || !ph) return;
        const k = 1 + bonus / 100;
        for (const st of ['attack', 'magicAttack', 'defence', 'magicDefence']) me.stats[st] = Math.floor(me.stats[st] * k);
        const add = Math.floor(me.maxHp * bonus / 100); me.maxHp += add; me.hp += add; me.start += add; ph.maxHp = me.maxHp; ph.hp = ph.initHp = me.hp;
      },
      onEnd(won) {
        if (won) {
          s.level = Math.max(s.level, f.UiLevelId);
          if (!bonus) s.used += f.ConsumeNum || 1;
          grant(c, roll(f.Reward));
        }
        p.save(); info(c);
        log(`[#${c.id}] confusion tower ${f.UiLevelSort}${bonus ? ` raid +${bonus}%` : ''}: ${won ? 'won' : 'lost'}`);
      } });
  }

  return {
    C_CONFUSION_TOWER(c, body) {
      const m = dec(c, 'C_CONFUSION_TOWER', body), p = c.player, s = state(p);
      switch (m.op) {
        case 1: case 3: {
          if (c.battle) return;
          const f = next(s);
          if (!f) { alert(c, 'Todos os andares foram concluídos'); break; }
          if (m.op === 1 && s.used + (f.ConsumeNum || 1) > TIMES) { alert(c, 'Toda a vigilância de hoje foi usada, volte amanhã.'); break; }
          if (m.op === 3 && s.raid <= 0) { alert(c, 'Pontos de incursão insuficientes'); break; }
          let bonus = 0;
          if (m.op === 3) { bonus = rate(s.raid); s.raid = 0; p.save(); }
          return fight(c, f, bonus);
        }
        case 4:
          if (s.used >= TIMES) { alert(c, 'Vigilância insuficiente'); break; }
          s.used++; s.raid++; p.save(); break;
        case 2: {
          const r = SHOP.get(m.shopId), n = Math.max(1, m.buyNum || 1);
          if (!r) break;
          if (s.level < r.MessTower) { alert(c, 'Andar da torre insuficiente para este item'); break; }
          if (r.Limit && (s.bought[r.Id] || 0) + n > r.Limit) { alert(c, 'Limite de compra atingido'); break; }
          const cost = r.GiftToken ? [[-500, r.GiftToken * n]] : [[m.flag && ctx.balance(p, -500) >= r.Point * n ? -500 : -400, r.Point * n]];
          if (!pay(c, cost)) { alert(c, 'Diamantes insuficientes'); break; }
          if (!grant(c, [[r.ItemId, r.ItemNum * n]])) { alert(c, 'Mochila cheia'); break; }
          s.bought[r.Id] = (s.bought[r.Id] || 0) + n; p.save(); ctx.sendPlayer(c);
          break;
        }
        default: break;
      }
      info(c);
    },
  };
};
