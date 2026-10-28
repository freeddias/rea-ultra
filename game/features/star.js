// Astrologia (Lv25): luck stars ("şans yıldızı"). Client: StarManager (Qm), StarModel (xm), Qc helpers.
//  rolling: C_STAR_RAND {site 0..4 | -1 = one-key} at one of 5 crystal balls (Elf, Melek, Kutsal, Ay, Evren).
//   Cost StarPickGold0..4 (4000..10000 gold), +StarPoint0..4 astrology points. The star comes from the server's
//   own drop table: t_s_dropcondition type 19, Para1 = ball -> DropId 19001..19005 (ball 0: 30% grey "bad luck"
//   stars, 70% green; ball 4: 33% blue, 61% purple, 6% orange). Ball 0 is always lit plus at most one higher
//   "current" ball; a roll at the current ball moves it up, keeps it, or drops back to ball 0. The chances are
//   in no table: NEXT below is estimated from 30 official rolls (older Legend Online TR capture "kader
//   sistemi", same protocol): ball 0 up 4/13; ball 1 up 3, stay 7, back 2 of 12; ball 2 up 2, back 1 of 3;
//   ball 3 back 2 of 2. Rolled stars wait in the temp list (16 places) -> 4180 StarRandRspMsg
//   {starRand: [{starInfo, dropSite}], site: lit balls}. One free roll a day (PlayerMsg startFree).
//  temp list: C_STAR_PICK {dropsite, way 1 pick / 2 sell; -2 = pick all, -1 = sell all up to quality `way`}
//   -> 4179 (removed places; that capture: sold ones bagType -1, picked ones with their new bag place) +
//   4178 StarMoveRspMsg for the bag. Grey stars can't be picked, only sold. A merge that raises a level says
//   so in chat (capture: "Kader Tiran lv 2'a evoluiu.").
//  bags: 1 = star bag (8 + bought cells, rows of 4 for (n/4+1) x Star_BagPrice), 2 = hero slots
//   (4, +1 every 5 levels after 25, max 8). C_STAR_MOVE moves/swaps, or with eat merges the first star into
//   the second: EXP = levels' Data up to its grade + gp + SellGp (Qc.getStarTotalExp); levels from
//   t_s_upgradetemplate 9..13/22 by quality. Equip: no grey or energy stars, job (Job), one per type
//   (cell.view.starbag.StarBagCell.command01/02). C_STAR_COMPOSE {pos, bagType}: the one-key merge into one star.
//   C_STAR_BATCH_OP way 1 sell / 2 merge; C_STAR_LOCK; C_STAR_ARRANGE; C_STARSHOP_BUY "Puan Takası"
//   (templates with StarPoint: purple 2000, orange 7000 points).
//  stats: equipped star attribute x level (player.js stats). Skill stars' battle effects are not applied.
// Not built: auto astrology (VIP), sublimation (way 3), star data reset.
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TEMP = 0, BAG = 1, HERO = 2;
const TEMP_MAX = 16, BAG_BASE = 8, BAG_MAX = 16, OPEN_LEVEL = 25;
// roll at ball i -> [chance to move up, chance to stay] (the rest: back to ball 0), estimated (see above)
const NEXT = [[0.3, 0.7], [0.25, 0.55], [0.35, 0.3], [0.2, 0.3], [0, 0.3]];
const UPGRADE_TYPE = { 2: 9, 3: 10, 4: 11, 5: 12, 6: 13, 7: 22 };

module.exports = (ctx) => {
  const { D, dec, sendT, alert, pay, balance, stat, CONF, DROPS, sendPlayer, sendCastle } = ctx;
  const COST = [0, 1, 2, 3, 4].map(i => CONF.get('StarPickGold' + i) || [4000, 5000, 6000, 8000, 10000][i]);
  const POINT = [0, 1, 2, 3, 4].map(i => CONF.get('StarPoint' + i) || i + 1);
  const BAG_PRICE = CONF.get('Star_BagPrice') || 200;
  const levels = profile => (D.upgrade.get(UPGRADE_TYPE[profile]) || []).slice().sort((a, b) => a.Grades - b.Grades);
  const maxGrade = profile => Math.max(1, ...levels(profile).map(r => r.Grades));
  const tpl = s => D.stars.get(s.tid) || {};

  function state(p) {
    const s = p.s.star = p.s.star || { temp: [], bag: {}, equip: {}, sites: [1, 0, 0, 0, 0], point: 0, bagAdd: 0, free: 1, freeDay: dayKey(), nextId: 1 };
    if (s.freeDay !== dayKey()) { s.freeDay = dayKey(); s.free = 1; }
    while (s.temp.length < TEMP_MAX) s.temp.push(null);
    return s;
  }
  const bagSize = p => Math.min(BAG_MAX, BAG_BASE + (state(p).bagAdd || 0));
  const heroSlots = p => Math.min(8, 4 + Math.max(0, Math.floor((p.s.grades - OPEN_LEVEL) / 5)));
  const box = (p, type) => type === BAG ? state(p).bag : type === HERO ? state(p).equip : null;
  const newStar = (p, tid) => ({ id: state(p).nextId++, tid, grade: 1, gp: 0, lock: false });
  const info = (p, st, bagType, pos) => ({ id: st.id, templateId: st.tid, userId: p.id, objectId: 0, pos, exist: true, bagType, grade: st.grade, gp: st.gp, isLock: !!st.lock });
  const moveEntry = (p, type, pos, st) => st ? { star_Info: info(p, st, type, pos), changeType: type, changePos: pos } : { changeType: type, changePos: pos };
  const sendMoves = (c, list) => { if (list.length) sendT(c, 4178, 'star.StarMoveRspMsg', { move: list }); };
  const tempEntry = (p, i) => ({ starInfo: info(p, state(p).temp[i], TEMP, i), dropSite: i });
  const freeBagPos = p => { const b = state(p).bag; for (let i = 0; i < bagSize(p); i++) if (!b[i]) return i; return -1; };

  function totalExp(st) {
    const t = tpl(st);
    return levels(t.Profile).filter(r => r.Grades <= st.grade).reduce((n, r) => n + r.Data, 0) + (st.gp || 0) + (t.SellGp || 0);
  }
  function addExp(st, n) {
    const ls = levels(tpl(st).Profile);
    st.gp = (st.gp || 0) + n;
    for (;;) {
      const next = ls.find(r => r.Grades === st.grade + 1);
      if (!next) { st.gp = 0; break; }
      if (st.gp < next.Data) break;
      st.gp -= next.Data; st.grade++;
    }
  }
  const canGrow = st => !!UPGRADE_TYPE[tpl(st).Profile] && tpl(st).MasterType !== 100 && st.grade < maxGrade(tpl(st).Profile);
  // why this star can't sit in hero slot `pos` (null = it can)
  function equipError(p, st, pos, skip = [pos]) {
    const t = tpl(st);
    if ((t.Profile || 0) <= 1 || t.MasterType === 100) return 'Esta Estrela da Sorte não pode ser equipada.';
    if (!(t.Job || [0]).includes(0) && !(t.Job || []).includes(p.s.job)) return 'Esta Estrela da Sorte não pode ser equipada.';
    for (const [k, o] of Object.entries(state(p).equip)) if (!skip.includes(Number(k)) && o && tpl(o).MasterType === t.MasterType) return 'Não é possível equipar mais de uma Estrela da Sorte com o mesmo atributo';
    if (pos >= heroSlots(p)) return 'Bolsa de equipamento de Estrela da Sorte cheia, não pode equipar';
    return null;
  }
  const heroChanged = c => { sendPlayer(c); if (ctx.sendArmy) ctx.sendArmy(c); };

  const randMsg = (p, idx) => ({ starRand: idx.map(i => tempEntry(p, i)), site: state(p).sites.slice() });
  ctx.onLoad.push(c => {
    const p = c.player, s = state(p);
    sendT(c, 4180, 'star.StarRandRspMsg', randMsg(p, s.temp.map((x, i) => x ? i : -1).filter(i => i >= 0)));
    const moves = [];
    for (const [k, st] of Object.entries(s.bag)) if (st) moves.push(moveEntry(p, BAG, Number(k), st));
    for (const [k, st] of Object.entries(s.equip)) if (st) moves.push(moveEntry(p, HERO, Number(k), st));
    sendMoves(c, moves);
  });

  // one roll at ball i -> temp place, or null (no gold / full)
  function roll(c, i) {
    const p = c.player, s = state(p);
    const place = s.temp.findIndex(x => !x);
    if (place < 0) return null;
    if (s.free > 0) s.free--;
    else { if ((p.s.gold || 0) < COST[i]) return null; p.s.gold -= COST[i]; }
    const [[tid] = []] = DROPS.roll(19001 + i);
    if (!tid || !D.stars.has(tid)) return null;
    s.temp[place] = newStar(p, tid);
    s.point += POINT[i];
    const [up, stay] = NEXT[i], r = Math.random();
    const next = r < up ? i + 1 : r < up + stay ? i : 0;
    s.sites = [1, 0, 0, 0, 0];
    if (next > 0) s.sites[next] = 1;
    stat(c, 'astrology');
    return place;
  }

  // removes temp places; picked ones go to the bag
  function takeTemp(c, places, sell) {
    const p = c.player, s = state(p), removed = [], moves = [];
    let gold = 0;
    for (const i of places) {
      const st = s.temp[i]; if (!st) continue;
      if (sell) gold += tpl(st).SellGold || 0;
      else {
        const pos = freeBagPos(p); if (pos < 0) { alert(c, 'Bolsa de estrelas cheia, não é possível coletar'); break; }
        s.bag[pos] = st; moves.push(moveEntry(p, BAG, pos, st));
      }
      // capture: a sold star comes back with bagType -1, a picked one with its new bag place
      removed.push({ starInfo: sell ? info(p, st, -1, i) : info(p, st, BAG, moves[moves.length - 1].changePos), dropSite: i });
      s.temp[i] = null;
    }
    if (gold) { p.s.gold = (p.s.gold || 0) + gold; sendCastle(c); alert(c, `${gold} de ouro obtidos`); }
    p.save();
    if (removed.length) sendT(c, 4179, 'star.StarRandRspMsg', { starRand: removed, site: s.sites.slice() });
    sendMoves(c, moves);
  }

  // merge `eaten` stars ([type, pos]) into the star at [type, pos]
  function merge(c, type, pos, eaten) {
    const p = c.player, s = state(p);
    const get = (t, i) => t === TEMP ? s.temp[i] : (box(p, t) || {})[i];
    const target = get(type, pos);
    if (!target) return false;
    if (!canGrow(target)) { alert(c, 'Estrela da Sorte atingiu o nível máximo e não pode ser combinada novamente'); return false; }
    const moves = [], tempGone = [];
    let exp = 0;
    for (const [t, i] of eaten) {
      const st = get(t, i);
      if (!st || st === target || st.lock) continue;
      exp += totalExp(st);
      if (t === TEMP) { tempGone.push({ starInfo: info(p, st, TEMP, i), dropSite: i }); s.temp[i] = null; }
      else { delete box(p, t)[i]; moves.push(moveEntry(p, t, i)); }
    }
    if (!moves.length && !tempGone.length) return false;
    const before = target.grade;
    addExp(target, exp);
    p.save();
    if (target.grade > before) ctx.chat(c, `Estrela da Sorte ${ctx.nameOf(tpl(target))} evoluiu para o nível ${target.grade}.`);
    if (tempGone.length) sendT(c, 4179, 'star.StarRandRspMsg', { starRand: tempGone, site: s.sites.slice() });
    if (type === TEMP) sendT(c, 4180, 'star.StarRandRspMsg', randMsg(p, [pos]));
    else moves.push(moveEntry(p, type, pos, target));
    sendMoves(c, moves);
    if (type === HERO || eaten.some(([t]) => t === HERO)) heroChanged(c);
    return true;
  }

  const opened = c => { if (c.player.s.grades >= OPEN_LEVEL) return true; alert(c, `Astrologia ${OPEN_LEVEL}. libera no nível`); return false; };

  return {
    C_STAR_RAND(c, body) {
      const m = dec(c, 'C_STAR_RAND', body), p = c.player;
      if (!opened(c)) return;
      const s = state(p), got = [];
      const rolls = m.site === -1 ? TEMP_MAX : 1;
      for (let n = 0; n < rolls; n++) {
        const i = m.site === -1 ? s.sites.lastIndexOf(1) : m.site;
        if (!(i >= 0 && i <= 4) || !s.sites[i]) break;
        const place = roll(c, i);
        if (place === null) { if (!got.length) alert(c, s.temp.some(x => !x) ? 'Ouro insuficiente!' : 'Sua mochila está cheia; colete as estrelas ou venda as desnecessárias'); break; }
        got.push(place);
      }
      p.save();
      sendT(c, 4180, 'star.StarRandRspMsg', randMsg(p, got));
      if (got.length) { sendCastle(c); sendPlayer(c); }
    },
    C_STAR_PICK(c, body) {
      const m = dec(c, 'C_STAR_PICK', body), p = c.player, s = state(p);
      const all = s.temp.map((x, i) => x ? i : -1).filter(i => i >= 0);
      if (m.dropsite === -2) return takeTemp(c, all.filter(i => (tpl(s.temp[i]).Profile || 0) > 1), false);
      if (m.dropsite === -1) return takeTemp(c, all.filter(i => { const st = s.temp[i]; return !st.lock && (tpl(st).Profile || 0) <= (m.way || 1) && st.grade === 1 && !st.gp; }), true);
      const st = s.temp[m.dropsite]; if (!st) return;
      if (m.way === 2) { if (st.lock) return alert(c, 'Estrela da Sorte bloqueada não pode ser vendida'); return takeTemp(c, [m.dropsite], true); }
      if ((tpl(st).Profile || 0) <= 1) return alert(c, 'Nenhuma Estrela da Sorte para coletar');
      takeTemp(c, [m.dropsite], false);
    },
    C_STAR_MOVE(c, body) {
      const m = dec(c, 'C_STAR_MOVE', body), p = c.player, s = state(p);
      const from = m.beginStarType === TEMP ? null : box(p, m.beginStarType), to = box(p, m.endStarType);
      if (m.eat) return void merge(c, m.endStarType, m.endPos, [[m.beginStarType, m.beginPos]]);
      if (!from || !to) return;
      const a = from[m.beginPos], b = to[m.endPos];
      if (!a || (from === to && m.beginPos === m.endPos)) return;
      const cap = t => t === BAG ? bagSize(p) : heroSlots(p);
      if (m.endPos < 0 || m.endPos >= cap(m.endStarType)) return alert(c, m.endStarType === HERO ? 'Bolsa de equipamento de Estrela da Sorte cheia, não pode equipar' : 'Bolsa de Estrela da Sorte cheia, não pode equipar.');
      if (m.endStarType === HERO) { const e = equipError(p, a, m.endPos, m.beginStarType === HERO ? [m.endPos, m.beginPos] : [m.endPos]); if (e) return alert(c, e); }
      if (b && m.beginStarType === HERO && from !== to) { const e = equipError(p, b, m.beginPos, [m.beginPos]); if (e) return alert(c, e); }
      delete from[m.beginPos];
      to[m.endPos] = a;
      if (b) from[m.beginPos] = b;
      p.save();
      sendMoves(c, [moveEntry(p, m.beginStarType, m.beginPos, b), moveEntry(p, m.endStarType, m.endPos, a)]);
      if (m.beginStarType === HERO || m.endStarType === HERO) heroChanged(c);
    },
    C_STAR_COMPOSE(c, body) {
      const m = dec(c, 'C_STAR_COMPOSE', body), p = c.player, s = state(p);
      const type = m.bagType === BAG ? BAG : TEMP;
      const eaten = type === TEMP
        ? s.temp.map((x, i) => x && i !== m.pos && (tpl(x).Profile || 0) > 1 && !x.lock ? [TEMP, i] : null).filter(Boolean)
        : Object.entries(s.bag).filter(([k, x]) => x && Number(k) !== m.pos && x.grade < 10 && !x.lock).map(([k]) => [BAG, Number(k)]);
      if (!merge(c, type, m.pos, eaten)) alert(c, 'Nenhuma Estrela da Sorte para combinar');
    },
    C_STAR_BATCH_OP(c, body) {
      const m = dec(c, 'C_STAR_BATCH_OP', body), p = c.player, s = state(p);
      const positions = (m.itemInfo || []).map(x => x.pos || 0);
      if (m.way === 1) {   // sell from the star bag (not merged, not locked)
        let gold = 0; const moves = [];
        for (const i of positions) {
          const st = s.bag[i]; if (!st || st.lock || st.grade > 1 || st.gp) continue;
          gold += tpl(st).SellGold || 0; delete s.bag[i]; moves.push(moveEntry(p, BAG, i));
        }
        if (gold) { p.s.gold = (p.s.gold || 0) + gold; sendCastle(c); }
        p.save(); sendMoves(c, moves);
        if (gold) alert(c, `${gold} de ouro obtidos`);
        return;
      }
      if (m.way === 2) return void merge(c, m.endType || BAG, m.mergePos, positions.map(i => [m.beginType || BAG, i]));
      alert(c, 'Ascensão de estrela ainda não disponível');
    },
    C_STAR_LOCK(c, body) {
      const m = dec(c, 'C_STAR_LOCK', body), p = c.player, s = state(p);
      const st = m.starType === TEMP ? s.temp[m.pos] : (box(p, m.starType) || {})[m.pos];
      if (!st) return;
      st.lock = !st.lock; p.save();
      if (st.lock) stat(c, 'starLock');   // quest condition 53 "Bloquear Estrela da Sorte"
      if (m.starType === TEMP) sendT(c, 4180, 'star.StarRandRspMsg', randMsg(p, [m.pos]));
      else sendT(c, 4953, 'star.StarInfoMsg', info(p, st, m.starType, m.pos));
    },
    C_STAR_BUY(c, body) {
      const m = dec(c, 'C_STAR_BUY', body), p = c.player, s = state(p);
      if (bagSize(p) >= BAG_MAX) return alert(c, 'Bolsa de estrelas no tamanho máximo');
      const price = ((s.bagAdd || 0) / 4 + 1) * BAG_PRICE;
      const cur = m.payType === 0 && balance(p, -500) >= price ? -500 : -400;
      if (!pay(c, [[cur, price]])) return alert(c, 'Diamantes insuficientes');
      s.bagAdd = (s.bagAdd || 0) + 4; p.save();
      sendPlayer(c);
    },
    C_STAR_ARRANGE(c) {
      const p = c.player, s = state(p), old = { ...s.bag };
      const list = Object.values(s.bag).filter(Boolean)
        .sort((a, b) => (tpl(b).Profile || 0) - (tpl(a).Profile || 0) || b.grade - a.grade || a.tid - b.tid);
      s.bag = {}; list.forEach((st, i) => { s.bag[i] = st; });
      p.save();
      const moves = [];
      for (let i = 0; i < bagSize(p); i++) if (old[i] !== s.bag[i]) moves.push(moveEntry(p, BAG, i, s.bag[i]));
      sendMoves(c, moves);
    },
    C_STARSHOP_BUY(c, body) {
      const m = dec(c, 'C_STARSHOP_BUY', body), p = c.player, s = state(p);
      const t = D.stars.get(m.goodId), num = Math.max(1, m.num || 1);
      const fail = text => { alert(c, text); sendT(c, 4261, 'star.StarShopMsg', { goodId: m.goodId, result: 0, num }); };
      if (!t || !t.StarPoint) return fail('Troca falhou!');
      if (s.point < t.StarPoint * num) return fail('Pontos de astrologia insuficientes');
      const free = []; for (let i = 0; i < bagSize(p) && free.length < num; i++) if (!s.bag[i]) free.push(i);
      if (free.length < num) return fail('Bolsa de estrelas cheia');
      s.point -= t.StarPoint * num;
      const moves = free.map(i => { s.bag[i] = newStar(p, t.TemplateId); return moveEntry(p, BAG, i, s.bag[i]); });
      p.save();
      sendMoves(c, moves);
      sendPlayer(c);
      sendT(c, 4261, 'star.StarShopMsg', { goodId: m.goodId, result: 1, num });
      alert(c, 'Troca realizada com sucesso!');
    },
    C_STAR_SPECIAL(c) { alert(c, 'Astrologia automática ainda não disponível'); },
  };
};
