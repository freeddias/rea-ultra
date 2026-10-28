// Gökyüzü Yolu (天穹之径; client hD / QO, SkyTrialWnd, SkyTrialSearchWnd, SkyTrialSweepWnd, SkyTrialLotteryWnd,
// SkyTrialShopWnd, SkyTrialBagWnd; tables t_s_skytriallayer / portal / event, t_s_skyshop, t_s_skylottery*;
// config skytrial_* / Sky_*). Opened from the town NPC "Clinton, Gökyüzü Yolu" (node dialog case 14 -> getData).
// Client-derived, no capture:
//  C_UPDATE_AREA (skytrial.SkyTrialRequestMsg {op, portalId, payType, buySkillId, layNumId}):
//   1 open -> 4552 SkyTrialInfoMsg op 1 (opens the window): layerList [{layerNum, portalList [{portalId,
//     searchCount, clear, bossCleared}]}], energy, searchPoint, resetCount, hasRewardLayer (bit layer-1 = the
//     layer is passed: every portal's boss beaten), skillCountList [skillId, count, ...], buffList [skillIds]
//   3 search ready (portal) -> 4551 SkyTrialSearchMsg op 3 (opens the search window)
//   2 search: EnergyCost energy -> an event (Rate weights; NeedMinLayer..NeedMaxLayer, NeedGrade, the portal's
//     NatureType) -> 4551 {op 2, eventId, rewardList [type, id, count ...]} (1 item, 3 skill). Event Reward
//     "type,id,n": 1 item, 2 a passive bonus skill (buffList, "Saldırı %2 artar"), 4 search points; every
//     event also gives SearchPoint. A Monster event ("heroId,pos") is a fight (battle type 20 SINGLE_PASS;
//     after it the client re-opens the window itself) whose Reward comes with the win. A SkyShop event offers
//     sky_extraction (3) goods of t_s_skyshop by Prob -> 4888 SkyShopInfoMsg.
//   4 boss (exploration 100 %, EnergyCost): the portal's Boss fight; a win clears the portal (ClearReward,
//     4996 U_C_SKY_TRIAL_BOSS_REWARD) and, once every portal of the layer is cleared, passes it (layer
//     ClearReward, hasRewardLayer bit; the client then shows the layer reward).
//   5 energy: skytrial_item 2125151 gives skytrial_energy (60), up to skytrial_max_energy (500)
//   6 buy skill: skytrial_skill[i] for skytrial_buy_skill_cost[i] search points, up to skytrial_max_skill_count
//     (5) of each; carried into the trial's fights as battle items (B_USE_ITEM)
//   7 leave, 12 reset a portal (skytrialReset_count 3 a day), 13 / 14 buy in / leave the shop, 15 / 16 the bag
//     (goods left in shops, buyable later), 17 sweep a cleared portal: n searches at EnergyCost each ->
//     4553 SkySweepRspMsg {eventId[]} (fights count as won, shops are skipped)
//  C_SKY_LOTTERY_REQ (SkyLotteryReqInfoMsg {op, type}): 4 info -> 4997; 1 draw (type 0 one, 1 ten) for Sky_item
//   2125152 each from the pool t_s_skylotterydrop (DropAward "id,count,weight,maxTimes,rare") -> 4998 items +
//   Sky_Integration (5) points each (bar Sky_length 500); 2 the point rewards of t_s_skylottery (Node);
//   3 refresh the pool (free every Sky_RefreshTime s, else Sky_RefreshPrice diamonds; type 1 = paid): a new
//   group by Sky_Award weights.
// Our choices (not stated anywhere): energy refills to the maximum at the daily reset; the bonus skills
// (buffList) are cleared on skytrial_buff_reset_day (Mon / Wed / Fri); the lottery points reset weekly;
// a shop's prices are Point diamonds (Discount = the original price); 11 portals whose Boss hero is missing
// from the tables fight the layer's strongest monster instead.
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const weekKey = (d = new Date()) => { const m = new Date(d); m.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return dayKey(m); };
const BATTLE_TYPE = 20;   // client TC.SINGLE_PASS

module.exports = (ctx) => {
  const { D, table, dec, sendT, alert, pay, grant, CONF, log } = ctx;
  const num = (k, d) => Number(CONF.get(k)) || d;
  const list = (k, d) => String(CONF.str(k) || d).split(',').map(Number);
  const LAYERS = table('t_s_skytriallayer'), PORTALS = table('t_s_skytrialportal'), EVENTS = table('t_s_skytrialevent');
  const PORTAL = new Map(PORTALS.map(r => [r.PortalId, r])), EVENT = new Map(EVENTS.map(r => [r.EventId, r]));
  const SHOP = table('t_s_skyshop'), LOT = table('t_s_skylottery'), DROPS = new Map(table('t_s_skylotterydrop').map(r => [r.GroupId, r]));
  const MAX_ENERGY = num('skytrial_max_energy', 500), MAX_POINT = num('skytrial_max_search_point', 1000);
  const SKILLS = list('skytrial_skill', '40401000,40401001,40401002'), SKILL_COST = list('skytrial_buy_skill_cost', '100,100,100');
  const MAX_SKILL = num('skytrial_max_skill_count', 5), ENERGY_ITEM = num('skytrial_item', 2125151), ENERGY_PER = num('skytrial_energy', 60);
  const RESETS = num('skytrialReset_count', 3), BUFF_DAYS = list('skytrial_buff_reset_day', '1,3,5'), PICK = num('sky_extraction', 3);
  const LOT_ITEM = num('Sky_item', 2125152), LOT_POINT = num('Sky_Integration', 5), LOT_MAX = num('Sky_length', 500);
  const LOT_REFRESH = num('Sky_RefreshTime', 10800) * 1000, LOT_PRICE = num('Sky_RefreshPrice', 45), LOT_FIRST = num('Sky_FirstAward', 1001);
  const LOT_GROUPS = String(CONF.str('Sky_Award') || '1001,1').split('|').map(x => x.split(',').map(Number));
  const parse = s => String(s || '').split('|').filter(Boolean).map(x => x.split(',').map(Number));
  const weighted = (rows, w) => { let x = Math.random() * rows.reduce((n, r) => n + (w(r) || 0), 0); for (const r of rows) if ((x -= w(r) || 0) < 0) return r; return rows[rows.length - 1]; };

  // a missing boss hero: the strongest monster of the layer's events
  function bossOf(pt) {
    const [tid, pos] = String(pt.Boss || '').split(',').map(Number);
    if (D.heroes.has(tid)) return `${tid},${pos || 5}`;
    const mons = EVENTS.filter(e => e.Monster && e.NeedMinLayer <= pt.LayerNum && pt.LayerNum <= e.NeedMaxLayer).map(e => Number(e.Monster.split(',')[0])).filter(id => D.heroes.has(id));
    const best = mons.sort((a, b) => (D.heroes.get(b).Live || 0) - (D.heroes.get(a).Live || 0))[0];
    return best ? `${best},5` : '';
  }

  function state(p) {
    const s = p.s.skyTrial = p.s.skyTrial || { energy: MAX_ENERGY, searchPoint: 0, resetCount: 0, day: '', passed: 0, portals: {}, skills: {}, buffs: [], buffDay: '', shop: [], bag: [] };
    const today = dayKey();
    if (s.day !== today) { s.day = today; s.resetCount = 0; s.energy = Math.max(s.energy, MAX_ENERGY); }
    // the latest bonus reset day (Mon / Wed / Fri) on or before today
    const d = new Date(); while (!BUFF_DAYS.includes(d.getDay() === 0 ? 7 : d.getDay())) d.setDate(d.getDate() - 1);
    if (s.buffDay !== dayKey(d)) { s.buffDay = dayKey(d); s.buffs = []; }
    return s;
  }
  const portalState = (s, id) => (s.portals[id] = s.portals[id] || { searchCount: 0, clear: false, bossCleared: false });
  const layerPassed = (s, n) => ((s.passed >> (n - 1)) & 1) === 1;
  function infoMsg(p, op = 0) {
    const s = state(p);
    const top = Math.min(LAYERS.length, Math.max(1, ...LAYERS.map(l => l.LayerNum).filter(n => layerPassed(s, n)).map(n => n + 1)));
    const layerList = LAYERS.filter(l => l.LayerNum <= top).map(l => ({ layerNum: l.LayerNum,
      portalList: PORTALS.filter(pt => pt.LayerNum === l.LayerNum).map(pt => Object.assign({ portalId: pt.PortalId }, portalState(s, pt.PortalId))) }));
    return { op, layerList, energy: s.energy, searchPoint: s.searchPoint, resetCount: s.resetCount, hasRewardLayer: s.passed,
      skillCountList: SKILLS.flatMap(id => [id, s.skills[id] || 0]), buffList: s.buffs.slice() };
  }
  const sendInfo = (c, op = 0) => sendT(c, 4552, 'skytrial.SkyTrialInfoMsg', infoMsg(c.player, op));
  const sendSearch = (c, o) => sendT(c, 4551, 'skytrial.SkyTrialSearchMsg', o);

  // an event's rewards: items now, bonus skills into buffList, search points; -> rewardList triples
  function applyReward(c, ev, s) {
    const out = [], items = [];
    for (const [type, id, n] of parse(ev.Reward)) {
      if (type === 1) { items.push([id, n]); out.push(1, id, n); }
      else if (type === 2) { s.buffs.push(id); out.push(3, id, n || 1); }
      else if (type === 4) s.searchPoint = Math.min(MAX_POINT, s.searchPoint + n);
    }
    s.searchPoint = Math.min(MAX_POINT, s.searchPoint + (ev.SearchPoint || 0));
    if (items.length) grant(c, items);
    return out;
  }
  function rollEvent(p, pt, { noShop = false } = {}) {
    const nat = String(pt.NatureType).split(',').map(Number);
    const pool = EVENTS.filter(e => e.NeedMinLayer <= pt.LayerNum && pt.LayerNum <= e.NeedMaxLayer && (e.NeedGrade || 0) <= p.s.grades
      && nat.includes(e.NeedNatureType) && !(noShop && e.SkyShop) && (!e.Monster || D.heroes.has(Number(e.Monster.split(',')[0]))));
    return pool.length ? weighted(pool, e => e.Rate) : null;
  }
  function openShop(c, s, shopId) {
    const goods = SHOP.filter(g => g.ShopId === shopId), picked = [];
    while (picked.length < PICK && goods.length) picked.push(goods.splice(goods.indexOf(weighted(goods, g => g.Prob)), 1)[0]);
    s.shop = picked.map(g => ({ id: g.Id, bought: 0 }));
    sendShop(c, 4888, s.shop);
  }
  const goodMsg = (x, i) => { const g = SHOP.find(r => r.Id === x.id) || {}; return { index: i, itemId: g.ItemId, count: g.Count, price: g.Point, originalPrice: g.Discount, buyTimes: x.bought, opinion: !!g.Opinion }; };
  const sendShop = (c, code, l) => sendT(c, code, 'skytrial.SkyShopInfoMsg', { item: l.map(goodMsg) });
  function buyGood(c, l, index) {
    const x = l[index], g = x && SHOP.find(r => r.Id === x.id);
    if (!g || x.bought) { alert(c, 'Este produto não pode ser comprado'); return false; }
    if (!pay(c, [[-400, g.Point]])) { alert(c, 'Diamantes insuficientes'); return false; }
    grant(c, [[g.ItemId, g.Count]]);
    x.bought = 1;
    return true;
  }

  // a fight of the trial: bonus skills raise the hero, bought skills are battle items (B_USE_ITEM)
  function fight(c, heroes, onWin) {
    const p = c.player, s = state(p);
    const bonus = { Attack: 0, Defence: 0, Live: 0 };
    for (const id of s.buffs) { const sk = D.skills.get(id) || {}; const t = `${sk.TemplateName_pt || ''} ${sk.TemplateName_tr || ''}`; const k = /Ataque|Saldırı|ATQ/.test(t) ? 'Attack' : /Defesa|Defans|DEF/.test(t) ? 'Defence' : /HP|PV/.test(t) ? 'Live' : null; if (k) bonus[k] += 2; }
    const before = Object.assign({}, s.skills);
    ctx.startBattle(c, { Heros: heroes, BattleType: BATTLE_TYPE, mapTempId: 1,
      setup(units, prep) {
        const me = units.find(u => u.playerHero), ph = prep.heros.find(h => h.userId === p.id); if (!me || !ph) return;
        me.stats.attack = Math.floor(me.stats.attack * (1 + bonus.Attack / 100)); me.stats.magicAttack = Math.floor(me.stats.magicAttack * (1 + bonus.Attack / 100));
        me.stats.defence = Math.floor(me.stats.defence * (1 + bonus.Defence / 100)); me.stats.magicDefence = Math.floor(me.stats.magicDefence * (1 + bonus.Defence / 100));
        if (bonus.Live) { const add = Math.floor(me.maxHp * bonus.Live / 100); me.maxHp += add; me.hp += add; me.start += add; ph.maxHp = me.maxHp; ph.hp = ph.initHp = me.hp; }
        me.runes = me.runes || {};
        ph.item = ph.item || [];
        SKILLS.forEach((id, i) => { const n = s.skills[id] || 0; if (n <= 0) return; me.runes[id] = n; ph.item.push({ userId: p.id, uItemId: id, count: n, tempId: id, bagPos: 3 + i, skillTempId: id, sonType: 0 }); });
      },
      onEnd(won, b) {
        const me = b.units.find(u => u.playerHero);
        for (const id of SKILLS) if (before[id]) s.skills[id] = Math.max(0, me && me.runes ? me.runes[id] || 0 : before[id]);
        if (won) onWin();
        p.save();
      } });
  }

  ctx.skyTrial = { state, rollEvent, PORTAL };

  return {
    C_UPDATE_AREA(c, body) {
      const m = dec(c, 'C_UPDATE_AREA', body), p = c.player, s = state(p), pt = PORTAL.get(m.portalId);
      const ps = pt && portalState(s, pt.PortalId);
      const open = pt && (pt.LayerNum === 1 || layerPassed(s, pt.LayerNum - 1));
      switch (m.op) {
        case 1: return sendInfo(c, 1);
        case 3:
          if (!open) { alert(c, 'Conclua o andar anterior primeiro'); return; }
          return sendSearch(c, { op: 3, portalId: pt.PortalId, rewardList: [] });
        case 2: {
          if (!open) return;
          if (s.energy < pt.EnergyCost) { alert(c, 'Energia insuficiente'); return; }
          const ev = rollEvent(p, pt); if (!ev) return;
          s.energy -= pt.EnergyCost; ps.searchCount++;
          if (ev.Monster) {
            sendSearch(c, { op: 2, portalId: pt.PortalId, eventId: ev.EventId, rewardList: [] });
            p.save(); sendInfo(c);
            fight(c, ev.Monster, () => { applyReward(c, ev, s); });   // the window is closed during the fight: items come with their usual notices
            return;
          }
          const rewardList = applyReward(c, ev, s);
          sendSearch(c, { op: 2, portalId: pt.PortalId, eventId: ev.EventId, rewardList });
          if (ev.SkyShop) openShop(c, s, Number(ev.SkyShop));
          p.save(); return sendInfo(c);
        }
        case 4: {
          if (!open || ps.clear) return;
          if (ps.searchCount < pt.TotalSearchCount) { alert(c, 'Conclua a exploração primeiro'); return; }
          if (s.energy < pt.EnergyCost) { alert(c, 'Energia insuficiente'); return; }
          const boss = bossOf(pt); if (!boss) return;
          s.energy -= pt.EnergyCost; p.save();
          fight(c, boss, () => {
            ps.clear = true; ps.bossCleared = true;
            const reward = parse(pt.ClearReward).filter(([t]) => t === 1).map(([, id, n]) => [id, n]);
            grant(c, reward);
            sendT(c, 4996, 'skytrial.SkyTrialSearchMsg', { op: 4, portalId: pt.PortalId, rewardList: reward.flatMap(([id, n]) => [1, id, n]) });
            const layer = PORTALS.filter(x => x.LayerNum === pt.LayerNum);
            if (!layerPassed(s, pt.LayerNum) && layer.every(x => portalState(s, x.PortalId).clear)) {
              s.passed |= 1 << (pt.LayerNum - 1);
              const lr = LAYERS.find(l => l.LayerNum === pt.LayerNum);
              grant(c, parse(lr && lr.ClearReward).filter(([t]) => t === 1).map(([, id, n]) => [id, n]));
              log(`[#${c.id}] sky trial layer ${pt.LayerNum} passed`);
            }
          });
          return;
        }
        case 5: {
          if (s.energy >= MAX_ENERGY) { alert(c, 'Enerji cheia'); return; }
          if (!pay(c, [[ENERGY_ITEM, 1]])) { alert(c, 'Sem item de energia'); return; }
          s.energy = Math.min(MAX_ENERGY, s.energy + ENERGY_PER); p.save(); return sendInfo(c);
        }
        case 6: {
          const i = SKILLS.indexOf(m.buySkillId); if (i < 0) return;
          if ((s.skills[m.buySkillId] || 0) >= MAX_SKILL) { alert(c, 'No máximo ' + MAX_SKILL + ' desta habilidade podem ser carregadas'); return; }
          if (s.searchPoint < SKILL_COST[i]) { alert(c, 'Pontos de exploração insuficientes'); return; }
          s.searchPoint -= SKILL_COST[i]; s.skills[m.buySkillId] = (s.skills[m.buySkillId] || 0) + 1;
          p.save(); return sendInfo(c);
        }
        case 7: return sendInfo(c);
        case 12: {
          if (!ps) return;
          if (s.resetCount >= RESETS) { alert(c, 'Redefinições de hoje acabaram'); return; }
          s.resetCount++; ps.searchCount = 0; ps.clear = false;
          p.save(); return sendInfo(c);
        }
        case 13: if (buyGood(c, s.shop, m.buySkillId)) { p.save(); sendShop(c, 4888, s.shop); } return;
        case 14: s.bag.push(...s.shop.filter(x => !x.bought)); s.shop = []; p.save(); return;
        case 15: return sendShop(c, 4896, s.bag);
        case 16: if (buyGood(c, s.bag, m.buySkillId)) { s.bag = s.bag.filter(x => !x.bought); p.save(); sendShop(c, 4896, s.bag); } return;
        case 17: {
          if (!ps || !ps.bossCleared) return;
          const n = Math.max(1, Math.min(m.layNumId || 1, Math.floor(s.energy / pt.EnergyCost)));
          if (s.energy < pt.EnergyCost) { alert(c, 'Energia insuficiente'); return; }
          const ids = [];
          for (let i = 0; i < n; i++) {
            const ev = rollEvent(p, pt, { noShop: true }); if (!ev) break;
            s.energy -= pt.EnergyCost; ps.searchCount = Math.min(pt.TotalSearchCount, ps.searchCount + 1);
            applyReward(c, ev, s); ids.push(ev.EventId);
          }
          p.save();
          sendT(c, 4553, 'skytrial.SkySweepRspMsg', { eventId: ids });
          return sendInfo(c);
        }
      }
    },

    C_SKY_LOTTERY_REQ(c, body) {
      const m = dec(c, 'C_SKY_LOTTERY_REQ', body), p = c.player;
      const L = p.s.skyLottery = p.s.skyLottery || { group: LOT_FIRST, point: 0, claimed: 0, resetTime: 0, drops: {}, week: '' };
      if (L.week !== weekKey()) { L.week = weekKey(); L.point = 0; L.claimed = 0; }
      const info = () => sendT(c, 4997, 'skytrial.SkyLotteryPlayerInfoMsg', { dropGroupId: L.group, dropPoint: L.point, hasDropPoint: L.claimed, resetTime: L.resetTime,
        hasDrop: Object.entries(L.drops).map(([id, n]) => ({ itemId: Number(id), times: n })) });
      const pool = () => parse((DROPS.get(L.group) || {}).DropAward).map(([id, count, w, max, rare]) => ({ id, count, w, left: max - (L.drops[id] || 0), rare }));
      if (m.op === 1) {
        const times = m.type === 1 ? 10 : 1;
        if (p.countTemplate(LOT_ITEM) < times) { alert(c, 'Itens de sorteio insuficientes'); return info(); }
        const got = [];
        for (let i = 0; i < times; i++) {
          const left = pool().filter(x => x.left > 0); if (!left.length) break;
          const x = weighted(left, r => r.w);
          L.drops[x.id] = (L.drops[x.id] || 0) + 1; got.push([x.id, x.count]);
        }
        if (!got.length) { alert(c, 'Pool de recompensas vazio, atualize'); return info(); }
        pay(c, [[LOT_ITEM, got.length]]);
        grant(c, got, { quiet: true });
        L.point = Math.min(LOT_MAX, L.point + LOT_POINT * got.length);
        sendT(c, 4998, 'skytrial.SkyLotteryItemsInfoMsg', { items: got.map(([itemId, count]) => ({ itemId, count })) });
      } else if (m.op === 2) {
        const row = LOT.filter(r => r.Node > L.claimed && r.Node <= L.point).sort((a, b) => a.Node - b.Node)[0];
        if (!row) return info();
        grant(c, parse(row.Award).map(([id, n]) => [id, n]));
        L.claimed = row.Node;
      } else if (m.op === 3) {
        const free = L.resetTime + LOT_REFRESH <= Date.now();
        if (!free && !pay(c, [[-400, LOT_PRICE]])) { alert(c, 'Diamantes insuficientes'); return info(); }
        L.group = weighted(LOT_GROUPS, g => g[1])[0]; L.drops = {};
        if (free) L.resetTime = Date.now();
      }
      p.save();
      info();
    },
  };
};
