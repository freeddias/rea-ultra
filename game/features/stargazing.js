// Yıldız Gözlemi (stargazing; client OU manager / wU zodiac sign, t_s_starmap, t_s_starformation, drop condition 132).
// From the 2026-10-23 live capture (275 at op 0) + client:
//  C_STARGAZING_OP {op, index, usePoint, count, nodeID, digNum}: 0 open, 1 wish (count x Yıldız Dilek Kuponu 2125149;
//  usePoint = star_number 180 diamonds per missing coupon) -> 275 {op 1, dropItemIds}, 2 Yıldız Gücü of sign index,
//  3 light the next map point of sign index, 4 / 5 the outer-city stargazing (not built).
//  275 StargazingResponseMsg {op, dropItemIds, infoMsg {zodiacSign [12 x {index, mapRank, mapStarGrade, mapFragments,
//  mapProerty, formationPoints, formationRank, formationStarGrade, formationProperty, formationLuck}], totalProperty}}.
//  A sign's map / formation value is the AttributeValue of its current row (Type = sign, Rank, StarGrade, Cell) —
//  cumulative (capture: sign 1 map rank 3 star 1 cell 2 = "6,366|8,366|7,366|9,366|10,3769" exactly);
//  attribute 6 attack, 7 defence, 8 magic attack, 9 magic defence, 10 hp. The current row's Expend (item, n) +
//  Consume gold pay for the next step: cells 0..9, then the next star (0..5), then the next rank.
//  Yıldız Gücü succeeds with the row's Probably %; a miss gives 1 luck, full luck = a sure success, success resets it.
// Our choices: full luck = 10; the wish draws from drop 132010 (the one the client shows), one roll per coupon.
const COUPON = 2125149, LUCK_MAX = 10, SIGNS = 12;
const ATTR = { 6: 'attack', 7: 'defence', 8: 'magicattack', 9: 'magicdefence', 10: 'live' };
const ADD = { attack: 'Attack', defence: 'Defence', magicattack: 'MagicAttack', magicdefence: 'MagicDefence', live: 'Live' };

module.exports = (ctx) => {
  const { dec, sendT, alert, pay, grant, table, CONF, log } = ctx;
  const key = (t, r, g, c) => `${t}/${r}/${g}/${c}`;
  const MAP = new Map(table('t_s_starmap').map(r => [key(r.Type, r.Rank, r.StarGrade, r.Cell), r]));
  const FORM = new Map(table('t_s_starformation').map(r => [key(r.Type, r.Rank, r.StarGrade, r.Cell), r]));
  const DIAMONDS = Number(CONF.str('star_number')) || 180;
  const WISH_DROP = ((ctx.DROPS.condition(132) || []).find(r => (r.Para1 || [])[0] === 2) || {}).DropId || 132010;
  const prop = row => { const o = { attack: 0, defence: 0, magicattack: 0, magicdefence: 0, live: 0 };
    for (const part of String((row && row.AttributeValue) || '').split('|')) { const [id, v] = part.split(',').map(Number); if (ATTR[id]) o[ATTR[id]] += v || 0; }
    return o; };
  function state(p) {
    const s = p.s.stargazing = p.s.stargazing || { signs: {} };
    for (let i = 1; i <= SIGNS; i++) s.signs[i] = s.signs[i] || { mr: 1, mg: 0, mc: 0, fr: 1, fg: 0, fc: 0, luck: 0 };
    return s;
  }
  // the step after (rank, star, cell), or null at the top
  const next = (T, t, r, g, c) => [[r, g, c + 1], [r, g + 1, 0], [r + 1, 0, 0]].find(([a, b, d]) => T.has(key(t, a, b, d))) || null;
  function info(p) {
    const s = state(p), total = { attack: 0, defence: 0, magicattack: 0, magicdefence: 0, live: 0 }, zodiacSign = [];
    for (let i = 1; i <= SIGNS; i++) {
      const z = s.signs[i], mp = prop(MAP.get(key(i, z.mr, z.mg, z.mc))), fp = prop(FORM.get(key(i, z.fr, z.fg, z.fc)));
      for (const k of Object.keys(total)) total[k] += mp[k] + fp[k];
      zodiacSign.push({ index: i, mapRank: z.mr, mapStarGrade: z.mg, mapFragments: z.mc, mapProerty: mp, formationPoints: z.fc, formationRank: z.fr, formationStarGrade: z.fg, formationProperty: fp, formationLuck: z.luck });
    }
    return { zodiacSign, totalProperty: total };
  }
  function apply(p) {
    const t = info(p).totalProperty, add = {};
    for (const [k, v] of Object.entries(t)) add[ADD[k]] = v;
    p.s.adds = p.s.adds || {}; p.s.adds.stargazing = add;
  }
  const send = (c, op, extra = {}) => sendT(c, 275, 'stargazing.StargazingResponseMsg', Object.assign({ op, dropItemIds: [], infoMsg: info(c.player) }, extra));
  const cost = row => { const [tid, n] = String(row.Expend || '').split(',').map(Number); const l = []; if (tid && n) l.push([tid, n]); if (row.Consume) l.push([-100, row.Consume]); return l; };
  ctx.onLoad.push(c => apply(c.player));

  return {
    C_STARGAZING_OP(c, body) {
      const m = dec(c, 'C_STARGAZING_OP', body), p = c.player, s = state(p);
      if (m.op === 1) {   // wish
        const n = Math.max(1, Math.min(m.count || 1, 50)), have = p.countTemplate(COUPON), miss = Math.max(0, n - have);
        if (miss && !m.usePoint) { alert(c, 'Cupons de Desejo Estelar insuficientes'); return; }
        const costs = [[COUPON, n - miss]]; if (miss) costs.push([-400, miss * DIAMONDS]);
        if (!pay(c, costs)) { alert(c, 'Diamantes insuficientes'); return; }
        const got = []; for (let i = 0; i < n; i++) got.push(...ctx.DROPS.roll(WISH_DROP).filter(([, k]) => k > 0));
        if (got.length && !grant(c, got)) alert(c, 'Mochila cheia');
        p.save();
        return sendT(c, 275, 'stargazing.StargazingResponseMsg', { op: 1, dropItemIds: got.map(([t]) => t) });
      }
      if (m.op === 2 || m.op === 3) {
        const z = s.signs[m.index]; if (!z) return send(c, 0);
        const map = m.op === 3, T = map ? MAP : FORM;
        const r = map ? z.mr : z.fr, g = map ? z.mg : z.fg, cl = map ? z.mc : z.fc, row = T.get(key(m.index, r, g, cl)), nx = next(T, m.index, r, g, cl);
        if (!row || !nx) { alert(c, 'Já está no nível máximo'); return send(c, m.op); }
        if (!pay(c, cost(row))) { alert(c, map ? 'Fragmentos de constelação ou ouro insuficientes' : 'Fogo Estelar ou ouro insuficiente'); return; }
        // the chance is the current row's Probably (what the client shows; cell 0 = 100)
        const ok = map || z.luck >= LUCK_MAX || Math.random() * 100 < (row.Probably ?? 100);
        if (ok) { if (map) [z.mr, z.mg, z.mc] = nx; else { [z.fr, z.fg, z.fc] = nx; z.luck = 0; } }
        else { z.luck = Math.min(LUCK_MAX, z.luck + 1); alert(c, 'Aprimoramento falhou, Ponto de Sorte +1'); }
        apply(p); p.save();
        if (ok) { ctx.sendPlayer(c); if (ctx.sendArmy) ctx.sendArmy(c); }
        log(`[#${c.id}] stargazing ${map ? 'map' : 'formation'} sign ${m.index} -> ${ok ? 'up' : 'miss'}`);
        return send(c, m.op);
      }
      send(c, m.op || 0);
    },
  };
};
