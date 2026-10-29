// Turn-based battle engine. Rules derived from the official capture's 45 fights (tools/analyze_battles.js,
// analysis/battle_hits.json):
//  - turns (curTurn): every living unit acts once per turn; order by castTime (troops 3000 < hero 3500 <
//    enemies 4000) with some randomness (half the recorded turns are not strictly in castTime order)
//  - the server drives the timeline in 40 ms frames; consecutive actions are 12-frame steps apart, longer
//    after hero / boss skills (recorded gaps 12 / 36 / 48 / 60). The exact gap rule is NOT derived: we use
//    12 after a troop's basic attack, 48 after any other action, +24 between turns (approximation)
//  - damage = max((A * P1/100 - D) * 0.5, A * P1/100 * 0.1) + P2, x [0.9, 1.1), occasionally x1.5 (crit);
//    A/D are magic attack / magic defence when the skill's CountWay is magical, else physical
//    (~400 recorded hits fit within the random band; crits ~2.5 % of hits: chance is our estimate)
//  - targets by the skill's AcceptObject (texts of the skill descriptions + recorded positions): grid columns
//    {1,4,7} {2,5,8} {3,6,9}, front = the lowest column that still has a living unit
//  - player hero rage: starts at Initial Rage (AttackType 23 from fashion / sets / …, see fury.js), spMax
//    defaults to 100 (+ AttackType 71). Each action adds the skill's Cost (30711 +20, 30811 -16, 31011 -80),
//    reduced by AttackType 22 / seal "% Rage Consumption". 307xx leave a buffer (AT 6: +rage each action).
//    A chosen skill the rage can't pay for falls back to the normal attack 30000
//  - other units pick a random entry of their 4 skill slots each action (troops [10,10,10,11]: 1 in 4 strong)
//  - skills' buffers (bleeding, damage dealt/taken, crit, heal over time, rage, shields): see addBuff
//  - runes (carried by the player hero, rune.js): usable UseCount times per battle via U_B_HERO_ORDER, costing
//    the hero's action; effects from their t_s_skillbuffertemplate rows: AttackType 33 = ValuePercent of max hp
//    (heal > 0 / damage < 0), 20 = damage dealt +%, 15 = damage taken +% (negative), ValidCount actions.
//    Rage rune: its positive Cost is rage gained. Leader monsters (bosses) ignore single-target rune damage.
//    Not modelled: chaos (38), forget (39), bleeding (305), dispels (18)
//  - the hero's pet (u.pet {stats, skill, skills}, features/pets.js): client AWAKEN_FULL_VALUE = 3000.
//    Ultra: each UseWay-1 skill the hero casts fills +1500 (2 skills → morph). Player orders 700001
//    (PET_MORPH_SKILL); in pet form awaken drains 1500 per action; at 0 (or 700002) it turns back.
//    Awaken goes out through onAwake (4600 AwakeMsg). Guard power (upani, 0..100) fills +50 per hero
//    skill and is pushed with onUpani (4602 AwakeMsg); at 100 the guard spends it on an active skill.
const D = require('./data');
const { table } = require('../templates');

const FRAME_MS = 40;
const FIRST_FRAME = 61;
const CRIT_CHANCE = 0.025, CRIT_MUL = 1.5;
const MAGIC_WAYS = new Set([2, 4, 10, 16, 18]);
const HEAL_WAYS = new Set([7, 16]);
const NORMAL_ATTACK = 30000;
const MORPH = 700001, UNMORPH = 700002;
const AWAKEN_FULL = 3000, AWAKEN_GAIN = 1500, AWAKEN_DRAIN = 1500;
const GUARD_POWER_FULL = 100, GUARD_POWER_GAIN = 50;
const BUFFERS = new Map(table('t_s_skillbuffertemplate').map(r => [r.Id, r]));
const ACTION_FRAMES = new Map(table('t_s_actiontemplate').map(r => [r.ActionId, r.FrameNum]));
const col = pos => (pos - 1) % 3;

class Battle {
  // units: [{ livingId, side, hero, playerHero, tempId, pos, hp, maxHp, castTime, skills: [ids], stats }]
  // stats: { attack, magicAttack, defence, magicDefence }
  constructor({ id, units, maxTurns = 0, rnd = Math.random, send, onEnd, onAwake = () => {}, onUpani = () => {}, now = () => Date.now(), timers = { set: setTimeout, clear: clearTimeout } }) {
    // maxTurns: 0 = until one side falls; else the defender wins after that many turns
    this.onAwake = onAwake; this.onUpani = onUpani;
    this.id = id; this.units = units; this.maxTurns = maxTurns; this.rnd = rnd; this.send = send; this.onEnd = onEnd; this.now = now; this.timers = timers;
    this.turn = 0; this.frame = FIRST_FRAME; this.queue = []; this.timer = null; this.over = false; this.started = false;
    this.chosen = 0; this.auto = false;
    this.bufSeq = 0;
    for (const u of units) {
      u.buffs = [];
      if (u.playerHero || u.autoHero) {
        u.spMax = u.spMax || 100;
        u.sp = u.sp != null ? Math.max(0, Math.min(u.spMax, u.sp)) : 0;
        u.costReducePct = u.costReducePct || 0;
        for (const b of u.passiveRageBuffers || []) {
          const way = b.AttackWay || 1;
          if ((b.AttackType === 6 || b.AttackType === 7) && way === 4) {
            u.sp = Math.max(0, Math.min(u.spMax, u.sp + (b.AttackValue || 0)));
          } else if (b.AttackType === 6 || b.AttackType === 7) {
            u.buffs.push({
              id: ++this.bufSeq, tpl: b, src: u.livingId, left: b.ValidCount ?? -1, stacks: 1, hit: 0,
              good: true, shield: 0,
            });
          } else if (b.AttackType === 22) {
            u.costReducePct += Math.abs(b.ValuePercent || 0);
          }
        }
      }
      if (u.pet) { u.awaken = u.awaken || 0; u.morphed = false; }
      if (u.guard) u.upani = u.upani || 0;
    }
  }
  spCap(u) { return u.spMax || 100; }
  // negative Cost = spend; costReducePct cuts the spend (e.g. 10 → pay 90% of |Cost|)
  skillCost(u, sk) {
    let cost = sk.Cost || 0;
    if (cost < 0 && u.costReducePct) cost = Math.ceil(cost * (1 - Math.min(100, u.costReducePct) / 100));
    return cost;
  }
  get hero() { return this.units.find(u => u.playerHero); }
  alive(side) { return this.units.filter(u => u.hp > 0 && (side == null || u.side === side)); }

  // ---- control ------------------------------------------------------------------------------------
  start() {
    if (this.started) return; this.started = true; this.t0 = this.now();
    this.nextTurn(); this.pump();
  }
  stop() { this.over = true; if (this.timer) this.timers.clear(this.timer); this.timer = null; }
  order(skillId) { this.chosen = skillId; }
  // run everything now (tests / a client that skips the fight)
  finishNow() { while (!this.over && this.queue.length) this.step(); }
  // the player retreats (B_WITHDRAW_BATTLE): a loss at once
  retreat() { if (this.over) return; this.stop(); this.frame += 24; this.onEnd(false, this.frame); }

  nextTurn() {
    this.turn++;
    const order = this.alive().map(u => ({ u, k: u.castTime * (0.85 + 0.3 * this.rnd()) })).sort((a, b) => a.k - b.k).map(x => x.u);
    this.queue = order;
  }
  pump() {
    if (this.over || !this.queue.length) return;
    const due = this.t0 + this.frame * FRAME_MS - this.now();
    this.timer = this.timers.set(() => { this.timer = null; if (this.over) return; this.step(); this.pump(); }, Math.max(0, due));
  }
  step() {
    const u = this.queue.shift();
    if (u && u.hp > 0) this.act(u);
    if (this.over) return;
    const winner = !this.alive(2).length ? 1 : !this.alive(1).length ? 2 : 0;
    if (winner) { this.over = true; this.frame += 48; this.onEnd(winner === 1, this.frame); return; }
    if (!this.queue.length) {
      if (this.maxTurns && this.turn >= this.maxTurns) { this.over = true; this.frame += 48; this.onEnd(false, this.frame); return; }
      this.frame += 24; this.nextTurn();
    }
  }

  // ---- one action -------------------------------------------------------------------------------
  pickSkill(u) {
    // another player's hero (arena defender): its own rage, always on auto
    // (petAttack: a pet fighter's own default attack instead of the hero normal attack, pet arena)
    if (u.forceSkill) {
      const id = u.forceSkill; u.forceSkill = 0;
      if (D.skills.has(id)) {
        if (u.guard && (u.upani || 0) >= GUARD_POWER_FULL) u._drainUpani = true;
        return id;
      }
    }
    if (u.autoHero) { const want = this.bestHeroSkill(u), sk = D.skills.get(want); return sk && u.skills.includes(want) ? want : u.petAttack || NORMAL_ATTACK; }
    if (u.playerHero) {
      if (u.pet) {
        if (this.chosen === MORPH && !u.morphed && u.awaken >= AWAKEN_FULL) return MORPH;
        if (this.chosen === UNMORPH && u.morphed) return UNMORPH;
        if (u.morphed) {
          const list = (u.pet.skills && u.pet.skills.length) ? u.pet.skills : [u.pet.skill];
          if (this.chosen && list.includes(this.chosen)) return this.chosen;
          return list[Math.floor(this.rnd() * list.length)] || u.pet.skill;
        }
      }
      if (this.chosen && u.runes && u.runes[this.chosen] > 0) return this.chosen;
      const want = this.chosen || (this.auto ? this.bestHeroSkill(u) : 0);
      const sk = D.skills.get(want);
      if (sk && this.skillCost(u, sk) + u.sp >= 0 && u.skills.includes(want)) return want;
      return NORMAL_ATTACK;
    }
    if (u.guard) {
      const actives = (u.skills || []).filter(id => (D.skills.get(id) || {}).UseWay === 1);
      const pool = actives.length ? actives : (u.skills || []);
      if ((u.upani || 0) >= GUARD_POWER_FULL && actives.length) { u._drainUpani = true; return actives[0]; }
      return pool[Math.floor(this.rnd() * pool.length)] || pool[0] || NORMAL_ATTACK;
    }
    return u.skills[Math.floor(this.rnd() * u.skills.length)] || u.skills[0];
  }
  bestHeroSkill(u) {
    const act = u.skills.map(id => D.skills.get(id)).filter(s => s && s.UseWay === 1 && this.skillCost(u, s) + u.sp >= 0);
    act.sort((a, b) => this.skillCost(u, a) - this.skillCost(u, b));   // the most expensive affordable first
    return act.length ? act[0].TemplateId : NORMAL_ATTACK;
  }
  targets(u, sk) {
    const foes = this.alive(3 - u.side), friends = this.alive(u.side);
    const pick = l => l[Math.floor(this.rnd() * l.length)];
    const front = l => { const c = Math.min(...l.map(x => col(x.pos))); return l.filter(x => col(x.pos) === c); };
    const back = l => { const c = Math.max(...l.map(x => col(x.pos))); return l.filter(x => col(x.pos) === c); };
    if (!foes.length) return [];
    if (HEAL_WAYS.has(sk.CountWay) || (sk.Parameter1 || 0) < 0) {
      if (sk.AcceptObject === 3) return friends;
      if (sk.AcceptObject === 5) return [friends.slice().sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0]];
      return [u];
    }
    switch (sk.AcceptObject) {
      case 1: case 17: return [pick(foes)];
      case 2: return [pick(foes), pick(foes)];
      case 3: return foes;
      case 5: return [foes.slice().sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0]];
      case 7: return [pick(back(foes))];
      case 8: return front(foes);
      case 10: { const by = {}; for (const f of foes) (by[col(f.pos)] = by[col(f.pos)] || []).push(f); return Object.values(by).sort((a, b) => b.length - a.length)[0]; }
      case 12: { const l = foes.slice().sort(() => this.rnd() - 0.5); return l.slice(0, 2); }
      case 30: return [foes.slice().sort((a, b) => (b.stats.attack + b.stats.magicAttack) - (a.stats.attack + a.stats.magicAttack))[0]];
      default: return [pick(front(foes))];   // 6 and the rest: one unit of the front column
    }
  }
  // ---- buffs (t_s_skillbuffertemplate) -------------------------------------------------------------
  // From the capture's AttackOrderMsg.buffers: {bufferId (instance), templateId, sourceId, targetId, curTurn
  // (left), maxTurn, pressedNum (stacks), seeType none = added / 1 = updated / 2 = removed, exeWay, damage[]}.
  //  TargetType 1 = the skill's targets (self when the skill itself targets the user, AcceptObject 4), 2 = the
  //   user; Random = chance %; ValidCount = how many times it counts (-1 = until the end).
  //  AttackWay (= exeWay): 1 works and counts down on the holder's own action, 2 counts down each time the
  //   holder is hit, 3 counts down on the holder's action, 4 works at once and is gone.
  //  AttackType: 20 damage dealt +ValuePercent %, 15 damage taken +ValuePercent %, 16 crit chance +AttackValue %,
  //   305 bleeding: ValuePercent % of the hit that caused it on each action (capture: 6 of a ~30 bite),
  //   33 hp ±ValuePercent % of max hp, 6/7 rage +AttackValue (damageType 9 with the new rage), 14 healing
  //   received +ValuePercent %, 34 shield absorbing AttackValue, 18 removes one beneficial buff (Dispel 1),
  //   22 rage spend −ValuePercent %, 23 initial rage / 71 max rage (applied at battle start via fury.js).
  //  Other types are shown but have no effect yet (chaos, awakening, custom talent ids …).
  addBuff(src, t, b, out, hit = 0) {
    if (!t || t.hp <= 0) return;
    if ((b.Random ?? 100) < 100 && this.rnd() * 100 >= (b.Random ?? 100)) return;
    const way = b.AttackWay || 1;
    if (b.AttackType === 18) {   // dispel: drop one beneficial buff of the target
      const i = t.buffs.findIndex(x => x.good);
      if (i >= 0) { const [x] = t.buffs.splice(i, 1); out.push(this.bufMsg(x, t, 2)); }
      return;
    }
    if (b.AttackType === 23 || b.AttackType === 71) return;   // battle-start only (fury.js)
    if (b.AttackType === 22 && (t.playerHero || t.autoHero)) {
      t.costReducePct = (t.costReducePct || 0) + Math.abs(b.ValuePercent || 0);
      if (way === 4) {
        out.push({ damage: [], unSkillIds: [], bufferId: ++this.bufSeq, templateId: b.Id, sourceId: src.livingId, targetId: t.livingId, exeWay: 4, pressedNum: 1, maxTurn: 1, maxRound: 1, curRound: -1, level: 1 });
        return;
      }
    }
    if (way === 4) {   // instant
      const dmg = this.buffEffect(t, b, hit);
      out.push({ damage: dmg, unSkillIds: [], bufferId: ++this.bufSeq, templateId: b.Id, sourceId: src.livingId, targetId: t.livingId, exeWay: 4, pressedNum: 1, maxTurn: 1, maxRound: 1, curRound: -1, level: 1 });
      return;
    }
    const same = t.buffs.find(x => x.tpl.Id === b.Id);
    if (same) {   // the same buffer again: refreshed (stacks when Multiple)
      if ((b.ValidCount ?? -1) < 0 && (same.stacks || 1) >= (b.PressCount || 1)) return;   // a lasting one at its cap: nothing changes (capture: no message)
      same.left = b.ValidCount ?? -1;
      if (b.Multiple) same.stacks = Math.min((same.stacks || 1) + 1, b.PressCount || 1);   // PressCount 0: no stacking (capture: 30711 stays at 1)
      if (hit) same.hit = hit;
      out.push(this.bufMsg(same, t, 1));
      return;
    }
    const x = { id: ++this.bufSeq, tpl: b, src: src.livingId, left: b.ValidCount ?? -1, stacks: 1, hit,
      good: (b.AttackType === 20 && b.ValuePercent > 0) || (b.AttackType === 15 && b.ValuePercent < 0) || [16, 6, 7, 34].includes(b.AttackType) || (b.AttackType === 33 && b.ValuePercent > 0),
      shield: b.AttackType === 34 ? Math.max(0, b.AttackValue || 0) : 0 };
    t.buffs.push(x);
    out.push(this.bufMsg(x, t, 0));
  }
  bufMsg(x, t, see, damage = []) {
    const m = { damage, unSkillIds: [], bufferId: x.id, templateId: x.tpl.Id, sourceId: x.src, targetId: t.livingId, exeWay: x.tpl.AttackWay || 1,
      pressedNum: x.stacks || 1, maxTurn: x.tpl.ValidCount ?? -1, curRound: -1, maxRound: -1, level: 1 };
    if (see !== 2) m.curTurn = x.left;
    if (see) m.seeType = see;
    return m;
  }
  // a buff's hp / rage effect on its holder -> damage entries
  buffEffect(t, b, hit, stacks = 1) {
    const dmg = [];
    if (b.AttackType === 305) {
      const v = Math.max(1, Math.floor((hit || 0) * (b.ValuePercent || 0) / 100)) * stacks;
      t.hp = Math.max(0, t.hp - v);
      dmg.push({ livingId: t.livingId, damageType: 6, damageValue: v, leftValue: t.hp, index: 1 });
    } else if (b.AttackType === 33 && b.ValuePercent) {
      let v = Math.max(1, Math.floor(t.maxHp * Math.abs(b.ValuePercent) / 100)) * stacks;
      if (b.ValuePercent > 0) { v = Math.floor(v * this.healMul(t)); t.hp = Math.min(t.maxHp, t.hp + v); }
      else t.hp = Math.max(0, t.hp - v);
      dmg.push({ livingId: t.livingId, damageType: 6, damageValue: b.ValuePercent > 0 ? -v : v, leftValue: t.hp, index: 1 });
    } else if ((b.AttackType === 6 || b.AttackType === 7) && (t.playerHero || t.autoHero)) {
      const add = (b.AttackValue || 0) * stacks;
      t.sp = Math.max(0, Math.min(this.spCap(t), t.sp + add));
      dmg.push({ livingId: t.livingId, damageType: 9, damageValue: add, leftValue: t.sp, index: 1 });
    }
    return dmg;
  }
  sumBuff(u, type, field = 'ValuePercent') { return (u.buffs || []).filter(x => x.tpl.AttackType === type).reduce((n, x) => n + (x.tpl[field] || 0) * (x.stacks || 1), 0); }
  healMul(t) { return Math.max(0, 1 + this.sumBuff(t, 14) / 100); }
  // the holder acts: AttackWay 1 effects, then 1 and 3 count down
  tickOwn(u, out) {
    for (const x of u.buffs.slice()) {
      const way = x.tpl.AttackWay || 1;
      if (way !== 1 && way !== 3) continue;
      const dmg = way === 1 ? this.buffEffect(u, x.tpl, x.hit, x.stacks) : [];
      if (x.left > 0) x.left--;
      const gone = x.left === 0;
      if (gone) u.buffs.splice(u.buffs.indexOf(x), 1);
      if (dmg.length || x.left >= 0) out.push(this.bufMsg(x, u, gone ? 2 : 1, dmg));
      if (u.hp <= 0) return;
    }
  }
  // the holder was hit: AttackWay 2 counts down
  tickHit(t, out) {
    for (const x of t.buffs.slice()) {
      if ((x.tpl.AttackWay || 1) !== 2 || x.left < 0) continue;
      x.left--;
      const gone = x.left <= 0;
      if (gone) t.buffs.splice(t.buffs.indexOf(x), 1);
      out.push(this.bufMsg(x, t, gone ? 2 : 1));
    }
  }

  damage(u, t, sk) {
    const magic = MAGIC_WAYS.has(sk.CountWay);
    const A = magic ? u.stats.magicAttack : u.stats.attack, Dv = magic ? t.stats.magicDefence : t.stats.defence;
    const raw = A * (sk.Parameter1 || 100) / 100;
    let dmg = Math.max((raw - Dv) * 0.5, raw * 0.1) + (sk.Parameter2 || 0);
    dmg *= 0.9 + 0.2 * this.rnd();
    if (this.rnd() < CRIT_CHANCE + this.sumBuff(u, 16, 'AttackValue') / 100) dmg *= CRIT_MUL;
    dmg *= Math.max(0, 1 + this.sumBuff(u, 20) / 100);
    dmg *= Math.max(0, 1 + this.sumBuff(t, 15) / 100);
    dmg = Math.max(1, Math.floor(dmg));
    for (const x of t.buffs) if (x.shield > 0 && dmg > 0) { const a = Math.min(x.shield, dmg); x.shield -= a; dmg -= a; }
    return dmg;
  }
  // a rune: its buffer rows (hp at once, damage dealt / taken buffs for later actions)
  runeEffects(u, skillId, sk, bufs) {
    u.runes[skillId]--; this.chosen = 0;
    const out = [], foes = this.alive(3 - u.side), friends = this.alive(u.side);
    for (const id of String(sk.BufferIds || '').split(',').map(Number).filter(Boolean)) {
      const b = BUFFERS.get(id); if (!b) continue;
      const pct = b.ValuePercent || 0;
      if (b.AttackType === 20 || b.AttackType === 15) this.addBuff(u, u, Object.assign({}, b, { AttackWay: 3, ValidCount: (b.ValidCount || 1) + 1, Random: 100 }), bufs);
      else if (b.AttackType === 33 && pct) {
        let tg = pct > 0 ? (sk.AcceptObject === 3 ? friends : [u]) : (sk.AcceptObject === 3 ? foes : foes.length ? [foes[Math.floor(this.rnd() * foes.length)]] : []);
        if (pct < 0 && sk.AcceptObject !== 3) tg = tg.filter(t => !t.boss);
        for (const t of tg) {
          const v = Math.max(1, Math.floor(t.maxHp * Math.abs(pct) / 100));
          t.hp = pct > 0 ? Math.min(t.maxHp, t.hp + v) : Math.max(0, t.hp - v);
          out.push({ livingId: t.livingId, damageType: 6, damageValue: pct > 0 ? -v : v, leftValue: t.hp, index: out.length + 1, resistType: 12 });
        }
      }
    }
    return out;
  }
  // pet form: 700001 turns the hero into its pet, 700002 back (no damage, just the order the client animates)
  morph(u, on) {
    u.morphed = on; this.chosen = 0;
    if (!on) u.awaken = 0;
    const frame = this.frame;
    this.send({ battleId: this.id, frame, execFrame: frame, frameNum: 49, orderId: on ? MORPH : UNMORPH, livingId: u.livingId, isPassive: false, damages: [], buffers: [], curTurn: this.turn });
    this.onAwake(u);
    this.frame += 48;
  }
  fillCompanionBars(u, skillId) {
    const sk = D.skills.get(skillId);
    if (!sk || sk.UseWay !== 1 || skillId === MORPH || skillId === UNMORPH) return;
    if (u.pet && !u.morphed) {
      u.awaken = Math.min(AWAKEN_FULL, (u.awaken || 0) + AWAKEN_GAIN);
      this.onAwake(u);
    }
    const guard = this.units.find(x => x.guard && x.side === u.side && x.hp > 0);
    if (guard) {
      const before = guard.upani || 0;
      guard.upani = Math.min(GUARD_POWER_FULL, before + GUARD_POWER_GAIN);
      if (guard.upani !== before) this.onUpani(guard);
    }
  }
  act(u) {
    const skillId = this.pickSkill(u);
    if (u.pet && (skillId === MORPH || skillId === UNMORPH)) return this.morph(u, skillId === MORPH);
    const petForm = !!(u.pet && u.morphed), ownStats = u.stats;
    if (petForm) u.stats = u.pet.stats;
    try { this.actInner(u, skillId); } finally { u.stats = ownStats; }
    if (u.guard && u._drainUpani) { u.upani = 0; u._drainUpani = false; this.onUpani(u); }
    if (u.playerHero && u.hp > 0 && !this.over) {
      if (petForm) {
        u.awaken = Math.max(0, (u.awaken || 0) - AWAKEN_DRAIN);
        this.onAwake(u);
        if (u.awaken === 0) return this.morph(u, false);
      } else this.fillCompanionBars(u, skillId);
    }
  }
  actInner(u, skillId) {
    if (skillId == null) skillId = this.pickSkill(u);
    const sk = D.skills.get(skillId) || { Parameter1: 100, Parameter2: 0, AcceptObject: 6, CountWay: 3, Cost: 0 };
    const bufs = [];
    this.tickOwn(u, bufs);
    const rune = !!(u.runes && u.runes[skillId] > 0);
    const tg = u.hp <= 0 || rune ? [] : this.targets(u, sk);
    const heal = HEAL_WAYS.has(sk.CountWay) || (sk.Parameter1 || 0) < 0;
    const hits = new Map();
    const damages = u.hp <= 0 ? [] : rune ? this.runeEffects(u, skillId, sk, bufs) : tg.map((t, i) => {
      let v;
      if (heal) { v = -Math.floor(u.stats.magicAttack * Math.abs(sk.Parameter1 || 0) / 100 * this.healMul(t)); t.hp = Math.min(t.maxHp, t.hp - v); }
      else { v = this.damage(u, t, sk); t.hp = Math.max(0, t.hp - v); hits.set(t, v); this.tickHit(t, bufs); }
      return { livingId: t.livingId, damageType: 6, damageValue: v, leftValue: t.hp, index: i + 1, resistType: 12 };
    });
    // the skill's own buffers
    if (!rune && u.hp > 0) {
      for (const id of String(sk.BufferIds || '').split(',').map(Number).filter(Boolean)) {
        const b = BUFFERS.get(id); if (!b) continue;
        const toSelf = b.TargetType === 2 || sk.AcceptObject === 4 || (b.TargetType === 1 && !tg.length && heal);
        for (const t of toSelf ? [u] : tg) this.addBuff(u, t, b, bufs, hits.get(t) || 0);
      }
    }
    let sp, spAdded;
    if (u.playerHero || u.autoHero) {
      spAdded = this.skillCost(u, sk);
      u.sp = Math.max(0, Math.min(this.spCap(u), u.sp + spAdded));
      sp = u.sp;
    }
    const frame = this.frame;
    this.send({ battleId: this.id, frame, execFrame: frame, frameNum: ACTION_FRAMES.get(sk.ActionId) || 49, orderId: skillId, livingId: u.livingId,
      isPassive: false, sp, spAdded, damages, buffers: bufs, curTurn: this.turn });
    const basic = !u.hero && sk.AcceptObject === 6 && sk.CountWay === 3;
    this.frame += basic ? 12 : 48;
  }

}

// troop squad hp (capture, 15/15 battles): per-soldier hp = floor(Live / 100) / 2; a squad starts at
// count x that and its maximum is the hero's command (captain) x that
function squadHp(live, count, captain) {
  const per = Math.floor((live || 0) / 100) / 2 || 0.5;
  return { init: Math.max(1, Math.round(count * per)), max: Math.max(1, Math.round(Math.max(count, captain) * per)) };
}

module.exports = { Battle, squadHp, FRAME_MS, NORMAL_ATTACK, MORPH, UNMORPH, AWAKEN_FULL, AWAKEN_GAIN, AWAKEN_DRAIN, GUARD_POWER_FULL, GUARD_POWER_GAIN };
