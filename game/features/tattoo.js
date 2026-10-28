// Ejderha Dövmesi / Tatuagem de Dragão (client dq / mq; Lv.55+). Login sends 274 so the bag red-point
// timer does not throw. Ops: 1 info, 2 refresh (208052), 3 replace pending, 4 core up, 5 clear hole,
// 6 advance refresh (208053), 7 baptize (re-roll props for Tattoo_refresh_price diamonds).
// Properties 1..5 → Power / Agility / Intellect / Physique / Captain (client PROPERTY_NAME).
// Ultra: reduce side ("poder inferior") rolls with Tattoo_Reduce_Property_Random and grows on refresh.
const HOLES = 8;
const PROP_KEYS = { 1: 'Power', 2: 'Agility', 3: 'Intellect', 4: 'Physique', 5: 'Captain' };

module.exports = (ctx) => {
  const { dec, sendT, alert, pay, balance, CONF, sendPlayer } = ctx;
  const cfg = n => String(CONF.str(n) || '');
  const consume = () => { const [tid, n] = cfg('Tattoo_consume').split(',').map(Number); return { tid: tid || 208052, n: n || 10 }; };
  const ADV = 208053, BAPTIZE = Number(cfg('Tattoo_refresh_price')) || 75, LOCK_PRICE = Number(cfg('Tattoo_refresh_lock_price')) || 75;
  const IDENTICAL = Number(cfg('Identical_tattoo')) || 4;
  const MAX_BY_STEP = cfg('Tattoo_Class_Proterty_Value_Max').split(',').map(Number).filter(n => n > 0);
  const GRADE_BY_STEP = cfg('Tattoo_Upgrade_Grade').split(',').map(Number);
  const MULT = (Number(cfg('Tattoo_Hight_MultiplicativeBasis')) || 20) / 100;
  const parseW = s => String(s || '').split('|').map(x => x.split(',').map(Number)).filter(([id, w]) => id && w > 0);
  const ADD_W = () => parseW(cfg('Tattoo_Property_Random') || '1,100|2,100|3,100|4,100|5,100');
  const RED_W = () => parseW(cfg('Tattoo_Reduce_Property_Random') || '1,100|2,100|3,100|5,100');
  const maxFor = step => MAX_BY_STEP[Math.max(0, Math.min(MAX_BY_STEP.length - 1, (step || 1) - 1))] || 50;
  const gradeFor = step => GRADE_BY_STEP[Math.max(0, Math.min(GRADE_BY_STEP.length - 1, (step || 1) - 1))] || 55;
  const pick = rows => { let x = Math.random() * rows.reduce((n, [, w]) => n + w, 0); for (const [id, w] of rows) if ((x -= w) < 0) return id; return rows[0][0]; };
  const emptyHole = hole => ({ hole, addProp: -1, addVal: 0, redProp: -1, redVal: 0, stage: 1, pend: null });

  function state(p) {
    let s = p.s.tattoo;
    if (!s || !Array.isArray(s.holes) || s.holes.length !== HOLES) {
      s = p.s.tattoo = { coreStep: 1, holes: Array.from({ length: HOLES }, (_, hole) => emptyHole(hole)) };
    }
    if (!s.coreStep) s.coreStep = 1;
    return s;
  }
  function holeMsg(h) {
    const pend = h.pend;
    return {
      hole: h.hole,
      OldAddProperty: h.addProp, OldAddingValue: h.addVal, OldReduceProperty: h.redProp, OldReduceValue: h.redVal, OldStage: h.stage,
      NewAddProperty: pend ? pend.addProp : -1, NewAddingValue: pend ? pend.addVal : 0,
      NewReduceProperty: pend ? pend.redProp : -1, NewReduceValue: pend ? pend.redVal : 0, NewStage: pend ? pend.stage : h.stage,
    };
  }
  function applyStats(p) {
    const s = state(p), add = { Power: 0, Agility: 0, Intellect: 0, Physique: 0, Captain: 0 };
    for (const h of s.holes) {
      if (h.addProp > 0 && PROP_KEYS[h.addProp]) add[PROP_KEYS[h.addProp]] += h.addVal || 0;
      if (h.redProp > 0 && PROP_KEYS[h.redProp]) add[PROP_KEYS[h.redProp]] += h.redVal || 0;   // redVal is negative
    }
    (p.s.adds = p.s.adds || {}).tattoo = add;
  }
  function send(c, opType) {
    const s = state(c.player);
    sendT(c, 274, 'player.TattooHoleRspMsg', { opType, param1: s.coreStep, holeInfo: s.holes.map(holeMsg) });
  }
  function countProp(s, prop) {
    return s.holes.filter(h => h.addProp === prop).length;
  }
  function rollPair(preferAdd, avoidRed) {
    let addRows = ADD_W(), redRows = RED_W();
    if (preferAdd) addRows = addRows.filter(([id]) => id === preferAdd).concat(addRows);
    let addProp = pick(addRows);
    redRows = redRows.filter(([id]) => id !== addProp && id !== avoidRed);
    if (!redRows.length) redRows = RED_W().filter(([id]) => id !== addProp);
    const redProp = redRows.length ? pick(redRows) : -1;
    return { addProp, redProp };
  }
  function rollValues(stage, advance) {
    const max = maxFor(stage);
    const addVal = Math.max(1, Math.floor(max * (0.15 + Math.random() * 0.35)));
    const redVal = -Math.max(1, Math.floor(addVal * (0.2 + Math.random() * 0.3)));
    const bump = advance ? Math.max(1, Math.ceil((max - addVal) * MULT * (0.5 + Math.random()))) : 0;
    return { addVal: Math.min(max, addVal + bump), redVal };
  }
  function refreshHole(h, { advance = false, lockAdd = false, lockMinus = false } = {}) {
    const max = maxFor(h.stage);
    const empty = h.addProp <= 0;
    const pair = rollPair(lockAdd ? h.addProp : 0, lockMinus ? h.redProp : 0);
    const addProp = lockAdd && h.addProp > 0 ? h.addProp : pair.addProp;
    const redProp = lockMinus && h.redProp > 0 ? h.redProp : pair.redProp;
    let addVal, redVal, stage = h.stage;
    if (empty) {
      ({ addVal, redVal } = rollValues(stage, false));
    } else {
      const gain = Math.max(1, Math.ceil((max - h.addVal) * MULT * (0.4 + Math.random() * (advance ? 1.2 : 0.8))));
      addVal = Math.min(max, h.addVal + gain);
      // "poder inferior" (reduce): grows toward a soft floor as the positive side rises
      const floor = -Math.max(1, Math.floor(addVal * 0.45));
      redVal = Math.max(floor, (h.redVal || -1) - Math.max(1, Math.floor(gain * (0.25 + Math.random() * 0.35))));
      if (addVal >= max && stage < MAX_BY_STEP.length) stage = Math.min(MAX_BY_STEP.length, stage + 1);
    }
    return { addProp, addVal, redProp, redVal, stage };
  }

  // prefer bound diamonds (-500) when the client asked for bound and the wallet has enough
  const diamCost = (p, preferBound, price) => [[preferBound && balance(p, -500) >= price ? -500 : -400, price]];

  ctx.onLogin.push(c => applyStats(c.player));
  ctx.onLoad.push(c => setImmediate(() => {
    if (!c.player) return;
    applyStats(c.player);
    send(c, 1);
  }));

  return {
    C_TATTOO_REQ(c, body) {
      const m = dec(c, 'C_TATTOO_REQ', body), p = c.player, s = state(p);
      const hole = Math.max(0, Math.min(HOLES - 1, m.param2 | 0));
      const h = s.holes[hole];
      const locked = (() => { const need = 55 + 5 * (hole + 1 - 3); return (p.s.grades || 1) < need; })();

      switch (m.opType) {
        case 1:
          applyStats(p); return send(c, 1);

        case 2:
        case 6: {   // refresh / advance refresh — also raises "poder inferior" (reduce value)
          if (locked) { alert(c, 'Este buraco ainda está trancado'); return send(c, m.opType); }
          if ((p.s.grades || 1) < 55) { alert(c, 'Tatuagem de Dragão abre no Nv. 55'); return send(c, m.opType); }
          const { tid, n } = consume();
          const useTid = m.opType === 6 ? ADV : tid;
          let cost = [[useTid, n]];
          if (m.refreshLockAdd || m.refreshLockMinus) cost.push(...diamCost(p, m.lockPayType === 0, LOCK_PRICE));
          if (!pay(c, cost)) { alert(c, m.opType === 6 ? 'Vidro de Dragão Avançado insuficiente' : 'Vidro de Dragão insuficiente'); return send(c, m.opType); }
          const rolled = refreshHole(h, { advance: m.opType === 6, lockAdd: !!m.refreshLockAdd, lockMinus: !!m.refreshLockMinus });
          if (rolled.addProp > 0 && countProp(s, rolled.addProp) >= IDENTICAL && h.addProp !== rolled.addProp) {
            const again = refreshHole(h, { advance: m.opType === 6, lockAdd: !!m.refreshLockAdd, lockMinus: !!m.refreshLockMinus });
            Object.assign(rolled, again);
          }
          // OP_REFRESH: client maps New* → displayed current, Old* → last
          const prev = { addProp: h.addProp, addVal: h.addVal, redProp: h.redProp, redVal: h.redVal, stage: h.stage };
          Object.assign(h, { addProp: rolled.addProp, addVal: rolled.addVal, redProp: rolled.redProp, redVal: rolled.redVal, stage: rolled.stage, pend: null });
          applyStats(p); p.save(); sendPlayer(c);
          sendT(c, 274, 'player.TattooHoleRspMsg', {
            opType: m.opType, param1: s.coreStep,
            holeInfo: s.holes.map(x => {
              if (x !== h) return holeMsg(x);
              return {
                hole: x.hole,
                OldAddProperty: prev.addProp, OldAddingValue: prev.addVal, OldReduceProperty: prev.redProp, OldReduceValue: prev.redVal, OldStage: prev.stage,
                NewAddProperty: h.addProp, NewAddingValue: h.addVal, NewReduceProperty: h.redProp, NewReduceValue: h.redVal, NewStage: h.stage,
              };
            }),
          });
          return;
        }

        case 7: {   // baptize: re-roll types, keep values; pending until replace
          if (locked || h.addProp <= 0) { alert(c, 'Refine o buraco antes de batizar'); return send(c, 7); }
          if (!pay(c, diamCost(p, m.materialPayType === 0, BAPTIZE))) { alert(c, 'Diamantes insuficientes'); return send(c, 7); }
          const pair = rollPair(0, 0);
          h.pend = { addProp: pair.addProp, addVal: h.addVal, redProp: pair.redProp, redVal: h.redVal, stage: h.stage };
          p.save(); return send(c, 7);
        }

        case 3: {   // replace: accept pending baptize
          if (!h.pend) { alert(c, 'Nenhuma tatuagem nova para substituir'); return send(c, 3); }
          Object.assign(h, { addProp: h.pend.addProp, addVal: h.pend.addVal, redProp: h.pend.redProp, redVal: h.pend.redVal, stage: h.pend.stage, pend: null });
          applyStats(p); p.save(); sendPlayer(c); return send(c, 3);
        }

        case 5: {   // delete / clear hole
          if (locked) return send(c, 5);
          Object.assign(h, emptyHole(hole));
          applyStats(p); p.save(); sendPlayer(c); return send(c, 5);
        }

        case 4: {   // core step up
          const needGrade = gradeFor(s.coreStep);
          if ((p.s.grades || 1) < needGrade) { alert(c, `Alcance Nv. ${needGrade} para subir o núcleo`); return send(c, 4); }
          const needOpen = Math.max(1, Math.floor((needGrade - 55) / 5) + 3);
          const atCap = s.holes.filter(x => x.addVal >= maxFor(s.coreStep)).length;
          if (atCap < needOpen) { alert(c, 'Refine mais buracos até o limite do núcleo atual'); return send(c, 4); }
          if (s.coreStep >= MAX_BY_STEP.length) { alert(c, 'O nível máximo do núcleo da Tatuagem de Dragão foi atingido'); return send(c, 4); }
          s.coreStep++; p.save(); return send(c, 4);
        }

        default:
          return send(c, m.opType || 1);
      }
    },
  };
};
