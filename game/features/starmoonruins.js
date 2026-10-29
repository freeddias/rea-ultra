// Ruínas da Estrela da Lua (client StarMoonRuins / cccactive.StarMoonRemains*; activeType lh.STAR_MOON_REMAINS=134).
// Protocol (bundle Qu + Hu):
//  Login / force-open pushes 4986 template. C2S 9645 U_C_STAR_MOON_RUINS_REQUEST {op,type,count} with extend1=134:
//   1 open main → template + player + shop + records
//   2 seek (type=1|10 draws, count=starId; type null/0 = free on star 7) → 4991 rewardOrder, pending until op 5
//   3 open treasure shop → shop info
//   4 exchange store order (type=order, count=qty) paying Fragmentos 2100038
//   5 claim pending draw rewards
//   6 enter current star (inStar) or restart after star-7 Exit
// Items: Bússola 2100037, Fragmento 2100038, Baú 2100039. rewardType 0 Normal / 2 Box / 3 Exit.
// Admin: eventflags key starMoonRuins (forçado aberto / fechado / calendário). Sem calendário oficial → fechado
// por padrão; “Forçado aberto” liga o evento.
const DATA = require('../../data/starmoonruins.json');
const ACTIVE = 134;
const COMPASS = 2100037, FRAGMENT = 2100038, BOX = 2100039;
const STAR_MAX = 7, DUBHE = 7;
const RT = { NORMAL: 0, LIGHT: 1, BOX: 2, EXIT: 3 };
const LIMIT = { NONE: 0, DAILY: 1, ACTIVITY: 2 };

module.exports = (ctx) => {
  const { dec, sendT, alert, pay, grant, online, log, sysTime } = ctx;
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const window = () => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 14); end.setHours(23, 59, 59, 0);
    const store = new Date(end); store.setDate(store.getDate() + 3);
    return { openTime: fmt(start), endTime: fmt(end), storeEndTime: fmt(store) };
  };

  if (ctx.events) ctx.events.register('starMoonRuins', () => false);
  const isOpen = () => {
    const f = ctx.events && ctx.events.force('starMoonRuins');
    if (f === false) return false;
    if (f === true) return true;
    return false; // no official calendar on this build — admin must force-open
  };

  const starOf = id => DATA.stars.find(s => s.starId === id) || DATA.stars[0];
  const totalWeight = star => (star.drawRewards || []).reduce((n, r) => n + (r.clientWeight || 0), 0);
  const roll = star => {
    let x = Math.random() * (totalWeight(star) || 1);
    for (const r of star.drawRewards) { x -= r.clientWeight || 0; if (x < 0) return r; }
    return star.drawRewards[star.drawRewards.length - 1];
  };

  function state(p) {
    const s = p.s.starMoon = p.s.starMoon || {};
    if (!s.seeded) {
      s.seeded = true;
      s.starId = 1; s.lotteryTimes = 0; s.drawProcess = 0; s.process = 0;
      s.inStar = false; s.totalStarCnt = 0; s.shop = {}; s.pending = null;
      s.starProcessClaimed = []; s.globalProcessClaimed = [];
      s.records = [];
      // starter kit so private-server players can explore immediately
      s.starter = true;
    }
    if (!Array.isArray(s.starProcessClaimed)) s.starProcessClaimed = [];
    if (!Array.isArray(s.globalProcessClaimed)) s.globalProcessClaimed = [];
    return s;
  }

  function giveStarter(c) {
    const s = state(c.player);
    if (!s.starter) return;
    s.starter = false;
    grant(c, [[COMPASS, 20], [FRAGMENT, 10]], { quiet: true });
  }

  function playerMsg(p) {
    const s = state(p);
    return {
      starId: s.starId || 1,
      lotteryTimes: s.lotteryTimes || 0,
      drawProcess: s.drawProcess || 0,
      process: s.process || 0,
      inStar: !!s.inStar,
      activeType: ACTIVE,
      totalStarCnt: s.totalStarCnt || 0,
    };
  }

  function templateMsg() {
    const w = window();
    return {
      openTime: w.openTime,
      endTime: w.endTime,
      storeEndTime: w.storeEndTime,
      price: DATA.price || 20,
      minTimes: DATA.minTimes || 1,
      desc: DATA.desc || '',
      activeType: ACTIVE,
      boxRewards: DATA.boxRewards || [],
      processRewards: (DATA.processRewards || []).map(r => ({
        order: r.order, process: r.process, itemList: r.itemList || [],
      })),
      storeTemps: DATA.storeTemps || [],
      starInfos: DATA.stars.map(st => ({
        starId: st.starId,
        maxLimit: st.maxLimit,
        totalWeight: totalWeight(st),
        drawRewards: (st.drawRewards || []).map(r => ({
          order: r.order, itemId: r.itemId || 0, amount: r.amount || 0,
          rewardType: r.rewardType || 0, clientWeight: r.clientWeight || 0,
        })),
        processRewards: (st.processRewards || []).map(r => ({
          order: r.order, process: r.process, itemList: r.itemList || [],
        })),
      })),
    };
  }

  function closedTemplate() {
    return { openTime: '', endTime: '', storeEndTime: '', price: DATA.price || 20, minTimes: 1, desc: '', activeType: ACTIVE,
      boxRewards: [], processRewards: [], storeTemps: [], starInfos: [] };
  }

  const shopMsg = p => ({
    activeType: ACTIVE,
    info: (DATA.storeTemps || []).map(t => ({ order: t.order, buyTimes: (state(p).shop[t.order] || 0) })),
  });

  const recordsMsg = p => ({
    activeType: ACTIVE,
    info: (state(p).records || []).slice(-30).reverse(),
  });

  function sendAll(c) {
    if (!isOpen()) {
      sendT(c, 4986, 'cccactive.StarMoonRemainsTotalTempInfo', closedTemplate());
      return;
    }
    giveStarter(c);
    sendT(c, 4986, 'cccactive.StarMoonRemainsTotalTempInfo', templateMsg());
    sendT(c, 4988, 'cccactive.StarMoonRemainsPlayerInfo', playerMsg(c.player));
    sendT(c, 4990, 'cccactive.StarMoonRemainsShopInfos', shopMsg(c.player));
    sendT(c, 4989, 'cccactive.StarMoonRemainsLotteryRecordInfos', recordsMsg(c.player));
  }

  function pushOpenOnline() {
    for (const c of online.values()) if (c.player) sendAll(c);
  }

  ctx.onLoad.push(c => { if (c.player) sendAll(c); });
  ctx.refreshStarMoonRuins = pushOpenOnline;

  function claimThresholds(s, list, claimedKey, progress) {
    const claimed = Array.isArray(s[claimedKey]) ? s[claimedKey] : (s[claimedKey] = []);
    const got = [];
    for (const r of list || []) {
      if (progress < r.process) continue;
      if (claimed.includes(r.order)) continue;
      claimed.push(r.order);
      for (const it of r.itemList || []) if (it.itemId && it.amount) got.push([it.itemId, it.amount]);
    }
    return got;
  }

  function finishStar(s, hitExit) {
    s.inStar = false;
    s.lotteryTimes = 0;
    s.drawProcess = 0;
    s.starProcessClaimed = [];
    s.totalStarCnt = (s.totalStarCnt || 0) + 1;
    if (s.starId >= STAR_MAX || hitExit) {
      s.starId = 1; // cycle resets after the 7th star / Exit on Dubhe
    } else {
      s.starId = Math.min(STAR_MAX, (s.starId || 1) + 1);
    }
  }

  function doSeek(c, times, starId) {
    const p = c.player, s = state(p);
    if (!s.inStar || starId !== s.starId) { alert(c, 'Entre na estrela antes de explorar'); return; }
    const star = starOf(s.starId);
    const left = Math.max(0, (star.maxLimit || 1) - (s.lotteryTimes || 0));
    if (left <= 0) { alert(c, 'Esta ruína já foi explorada por completo'); return; }
    const n = Math.max(1, Math.min(times || 1, left));
    const free = s.starId === DUBHE;
    if (!free) {
      const have = p.countTemplate(COMPASS);
      const miss = Math.max(0, n - have);
      const costs = [];
      if (n - miss > 0) costs.push([COMPASS, n - miss]);
      if (miss) costs.push([-400, miss * (DATA.price || 20)]);
      if (costs.length && !pay(c, costs)) { alert(c, miss ? 'Diamantes insuficientes' : 'Bússolas insuficientes'); return; }
      if (miss || n - miss) ctx.sendPlayer(c);
    }
    const orders = [], annex = [];
    let hitExit = false;
    for (let i = 0; i < n; i++) {
      const r = roll(star);
      orders.push(r.order);
      if (r.rewardType === RT.EXIT) { hitExit = true; break; }
      if (r.itemId && r.amount) annex.push([r.itemId, r.amount]);
      // opening a Box also grants the configured boxRewards preview loot
      if (r.rewardType === RT.BOX) for (const b of DATA.boxRewards || []) if (b.itemId && b.amount) annex.push([b.itemId, b.amount]);
    }
    s.lotteryTimes = (s.lotteryTimes || 0) + orders.length;
    s.drawProcess = (s.drawProcess || 0) + orders.length;
    s.process = (s.process || 0) + orders.length;
    const bonus = [
      ...claimThresholds(s, star.processRewards, 'starProcessClaimed', s.drawProcess),
      ...claimThresholds(s, DATA.processRewards, 'globalProcessClaimed', s.process),
    ];
    s.pending = { orders, annex: annex.concat(bonus), starId: s.starId, hitExit, done: s.lotteryTimes >= (star.maxLimit || 1) || hitExit };
    s.records = s.records || [];
    s.records.push({
      starId: s.starId, userId: p.id, type: hitExit ? 1 : (annex.some(([t]) => t === BOX) ? 0 : 0),
      createTime: sysTime(), boxRewards: annex.filter(([t]) => t === BOX).map(([itemId, amount]) => ({ itemId, amount })),
    });
    if (s.records.length > 50) s.records = s.records.slice(-50);
    p.save();
    sendT(c, 4991, 'cccactive.StarMoonRemainsLotteryItemsInfoMsg', { activeType: ACTIVE, rewardOrder: orders });
    sendT(c, 4988, 'cccactive.StarMoonRemainsPlayerInfo', playerMsg(p));
  }

  function claimPending(c) {
    const p = c.player, s = state(p), pd = s.pending;
    if (!pd) return;
    s.pending = null;
    if (pd.annex && pd.annex.length) {
      const merged = new Map();
      for (const [t, n] of pd.annex) if (t && n) merged.set(t, (merged.get(t) || 0) + n);
      const list = [...merged];
      if (list.length && !grant(c, list)) {
        if (ctx.sendMail) ctx.sendMail(p.id, { title: 'Ruínas da Estrela da Lua', contents: 'Mochila cheia. Recompensas da exploração:', annex: list, sendType: 4 });
        else alert(c, 'Mochila cheia');
      }
    }
    if (pd.done) finishStar(s, pd.hitExit);
    p.save();
    sendT(c, 4988, 'cccactive.StarMoonRemainsPlayerInfo', playerMsg(p));
  }

  function enterStar(c) {
    const p = c.player, s = state(p);
    if (s.inStar) { alert(c, 'Você já está explorando uma ruína'); return sendT(c, 4988, 'cccactive.StarMoonRemainsPlayerInfo', playerMsg(p)); }
    s.inStar = true;
    s.lotteryTimes = 0;
    s.drawProcess = 0;
    s.starProcessClaimed = [];
    p.save();
    sendT(c, 4988, 'cccactive.StarMoonRemainsPlayerInfo', playerMsg(p));
    log(`[#${c.id}] star-moon enter star ${s.starId}`);
  }

  function exchange(c, order, count) {
    const p = c.player, s = state(p);
    const row = (DATA.storeTemps || []).find(t => t.order === order);
    if (!row) return;
    const n = Math.max(1, Math.min(count || 1, 99));
    const bought = s.shop[order] || 0;
    if (row.limitType !== LIMIT.NONE && row.limitNum > 0 && bought + n > row.limitNum) {
      alert(c, 'Limite de troca atingido'); return;
    }
    if (row.limitStarCnt > 0 && (s.totalStarCnt || 0) < row.limitStarCnt) {
      alert(c, 'Abra mais estrelas para desbloquear este item'); return;
    }
    const cost = (row.cost || 0) * n;
    if (cost && !pay(c, [[FRAGMENT, cost]])) { alert(c, 'Fragmentos Estrela-Lua insuficientes'); return; }
    s.shop[order] = bought + n;
    const got = [[row.itemId, (row.amount || 1) * n]];
    if (!grant(c, got)) {
      if (ctx.sendMail) ctx.sendMail(p.id, { title: 'Tesouro Estrela-Lua', contents: 'Mochila cheia. Item trocado:', annex: got, sendType: 4 });
    }
    p.save(); ctx.sendPlayer(c);
    sendT(c, 4990, 'cccactive.StarMoonRemainsShopInfos', shopMsg(p));
  }

  return {
    U_C_STAR_MOON_RUINS_REQUEST(c, body, h) {
      // shared code 9645 — only handle Star-Moon (extend1=134); ignore other CCC actives
      const ext = h && h.extend1;
      if (ext && ext !== ACTIVE) return;
      if (!isOpen()) { alert(c, 'As Ruínas da Estrela da Lua não estão abertas'); return sendAll(c); }
      const m = dec(c, 'U_C_STAR_MOON_RUINS_REQUEST', body) || {};
      const op = m.op | 0;
      giveStarter(c);
      switch (op) {
        case 1:
          sendAll(c);
          break;
        case 2: {
          const times = m.type > 0 ? m.type : 1;
          const starId = m.count > 0 ? m.count : state(c.player).starId;
          doSeek(c, times, starId);
          break;
        }
        case 3:
          sendT(c, 4990, 'cccactive.StarMoonRemainsShopInfos', shopMsg(c.player));
          sendT(c, 4988, 'cccactive.StarMoonRemainsPlayerInfo', playerMsg(c.player));
          break;
        case 4:
          exchange(c, m.type | 0, m.count | 0);
          break;
        case 5:
          claimPending(c);
          break;
        case 6:
          enterStar(c);
          break;
        default:
          sendAll(c);
          break;
      }
    },
  };
};
