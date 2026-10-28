// Mini Savaş (whack-a-mole; client _R / GameMiniWarWnd; t_s_minicampaign 3 stages, t_s_minicampaignpoints; config
// minicampaign_Maxmum 9, minicampaign_Price 300, minicampaign_OpenDay). Client-derived (help text GameMiniWarWnd.help):
//  9 doors (3 x 3, x / y 0..2); Tauren (1) +1, İskelet (2) +2, İblis (3) +3, Gloria (4, the partner) -2 (client
//  getScoreByNpcType). Plays reset to 2 every day; one more for minicampaign_Price diamonds (flag: bound first), at most
//  minicampaign_Maxmum. The day's treasure progress (point rows Type 2: 150 .. 1500) resets every day too.
//  C_MOLE_GAME_OP gamebox.MoleGameOpReq {op, x, y, round, awardId, flag}: 0 info -> 538 MoleGameInfoRes {score (today),
//  laveTimes, record "ids taken", lastRecord [npc types hit last game]}; 1 start -> 539 MoleGameStartInfoRes {total,
//  startTime, endTime, allRound [{round, startTime, endTime, grids [{x, y, monster}]}]} (the client plays the rounds
//  on its own clock); 2 hit x / y in round -> 540 MoleGameMessage {total, gridInfo}; 3 take a treasure awardId; 4 buy a
//  play; 5 stop -> 552 MoleGameStopRes {items} + 538.
//  Rounds: each stage lasts Interval ms, a round Refresh ms; its Npc "type,count" are spread over its rounds.
// 2026-10-23 live capture: every round lists all 9 doors (an empty door has no monster field); a hit answers 540 with
// the whole round, the hit door emptied, total += the monster's points; op 1 sends 538 (one play less) before 539.
// Our choices: the game's reward is the highest Type 1 row (40 / 80 / 120 / 160 points in one game) it reached; hits
// are not checked against the round's time.
module.exports = (ctx) => {
  const { table, dec, sendT, alert, pay, grant, CONF, sysTime } = ctx;
  const STAGES = table('t_s_minicampaign').sort((a, b) => a.Stage - b.Stage);
  const POINTS = table('t_s_minicampaignpoints');
  const MAX = Number(CONF.str('minicampaign_Maxmum')) || 9, PRICE = Number(CONF.str('minicampaign_Price')) || 300, DAILY = 2;
  const parse = s => String(s || '').split('|').map(x => x.split(',').map(Number)).filter(([t, n]) => t && n);
  const score = m => (m === 4 ? -2 : m >= 1 && m <= 3 ? m : 0);
  const z = n => String(n).padStart(2, '0');
  const fmt = ms => { const d = new Date(ms); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`; };
  const day = () => sysTime().slice(0, 10);
  function state(p) {
    const s = p.s.miniWar = p.s.miniWar || { last: [] };
    if (s.day !== day()) Object.assign(s, { day: day(), plays: DAILY, score: 0, taken: [] });
    return s;
  }
  const info = c => { const s = state(c.player); sendT(c, 538, 'gamebox.MoleGameInfoRes', { score: s.score, laveTimes: s.plays, record: s.taken.join(','), lastRecord: s.last.length ? s.last : [-1] }); };
  // the rounds of one game: every stage's npcs spread over its rounds, one door each
  function rounds(t0) {
    const out = []; let t = t0, round = 1;
    for (const st of STAGES) {
      const n = Math.max(1, Math.floor(Number(st.Interval) / Number(st.Refresh))), npcs = [];
      for (const [type, cnt] of parse(st.Npc)) for (let k = 0; k < cnt; k++) npcs.push(type);
      npcs.sort(() => Math.random() - 0.5);
      for (let r = 0; r < n; r++) {
        const here = npcs.filter((_, i) => i % n === r).slice(0, 9), doors = [...Array(9).keys()].sort(() => Math.random() - 0.5);
        const grids = [...Array(9).keys()].map(i => ({ x: Math.floor(i / 3), y: i % 3, monster: 0 }));   // capture order: x 0 (y 0..2), x 1, x 2
        here.forEach((monster, i) => { grids[doors[i]].monster = monster; });
        out.push({ round: round++, startTime: fmt(t), endTime: fmt(t + Number(st.Refresh)), grids });
        t += Number(st.Refresh);
      }
    }
    return out;
  }

  return {
    C_MOLE_GAME_OP(c, body) {
      const m = dec(c, 'C_MOLE_GAME_OP', body), p = c.player, s = state(p);
      switch (m.op) {
        case 1: {
          if (s.plays <= 0) { alert(c, 'Sem tentativas de jogo restantes'); return info(c); }
          s.plays--; ctx.stat(c, 'miniWar');   // season pass task 71
          const t0 = Date.now(), all = rounds(t0);
          c.miniWar = { all, total: 0, hits: [] };
          p.save(); info(c);
          return sendT(c, 539, 'gamebox.MoleGameStartInfoRes', { total: 0, startTime: fmt(t0), endTime: all.length ? all[all.length - 1].endTime : fmt(t0), allRound: all });
        }
        case 2: {
          const g = c.miniWar; if (!g) return;
          const r = g.all.find(x => x.round === m.round); if (!r) return;
          const cell = r.grids.find(x => x.x === (m.x || 0) && x.y === (m.y || 0));
          if (cell && cell.monster) { g.total += score(cell.monster); g.hits.push(cell.monster); cell.monster = 0; }
          return sendT(c, 540, 'gamebox.MoleGameMessage', { total: g.total, gridInfo: { round: r.round, startTime: r.startTime, endTime: r.endTime, grids: r.grids.map(x => ({ x: x.x, y: x.y, monster: x.monster })) } });
        }
        case 5: {
          const g = c.miniWar; c.miniWar = null;
          if (!g) return info(c);
          const tier = POINTS.filter(x => x.Type === 1 && g.total >= x.Goal).sort((a, b) => b.Goal - a.Goal)[0];
          const items = tier ? parse(tier.Item) : [];
          if (items.length) grant(c, items, { quiet: true });
          s.score += Math.max(0, g.total); s.last = g.hits.slice(-30);
          p.save();
          sendT(c, 552, 'gamebox.MoleGameStopRes', { items: items.map(([templateId, count]) => ({ templateId, count })) });
          return info(c);
        }
        case 3: {
          const row = POINTS.find(x => x.Id === m.awardId && x.Type === 2);
          if (!row || s.score < row.Goal || s.taken.includes(row.Id)) { alert(c, 'Este tesouro não pode ser recebido'); return info(c); }
          if (!grant(c, parse(row.Item))) { alert(c, 'Mochila cheia'); return; }
          s.taken.push(row.Id); p.save(); return info(c);
        }
        case 4: {
          if (s.plays >= MAX) { alert(c, 'Número atingiu o limite'); return info(c); }
          const bound = m.flag === 0 && ctx.balance(p, -500) >= PRICE;
          if (!pay(c, [[bound ? -500 : -400, PRICE]])) { alert(c, 'Diamantes insuficientes'); return info(c); }
          s.plays++; p.save(); ctx.sendPlayer(c); return info(c);
        }
        default: return info(c);
      }
    },
  };
};
