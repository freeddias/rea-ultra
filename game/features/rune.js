// Hero runes: learn / level / carry (U_C_HERO_RUNE_OP -> U_C_RUNE_OP 4495 HeroRuneOpMsg). Rules: rune.js.
// Rune holes / rune gems (C_RUNE_HOLE_*, C_LOTTERY_RUNE, opType 4-6) are a separate, later system.
const R = require('../rune');
const STUDY = 1, UPGRADE = 2, TAKE = 3;

module.exports = (ctx) => {
  const { D, dec, sendN, sendItems, sendPlayer, sendArmy, alert, pay, M, CONF, sysTime } = ctx;
  const PRICE = CONF.get('UpRune_Price') || 2;
  const day = () => sysTime().slice(0, 10);
  function diamondIndex(p) { if (p.s.runeDiamondDay !== day()) { p.s.runeDiamondDay = day(); p.s.runeDiamondIndex = 0; } return p.s.runeDiamondIndex; }

  const reply = (c, opType, ok, extra = {}) => sendN(c, 'U_C_RUNE_OP', Object.assign({ opType, opResult: ok, userId: c.player.id, runeInfo: R.info(c.player), count: diamondIndex(c.player) }, extra));
  function changed(c, opType) { const p = c.player; p.save(); reply(c, opType, true); sendArmy(c); }

  return {
    U_C_HERO_RUNE_OP(c, body) {
      const m = dec(c, 'U_C_HERO_RUNE_OP', body), p = c.player, runes = R.state(p);
      if (p.s.grades < R.OPEN) { alert(c, `Karakter Lv. ${R.OPEN} necessário`); return reply(c, m.opType, false); }
      const tpl = R.RUNES.get(m.runeId);

      if (m.opType === STUDY) {
        if (!tpl || !R.jobOk(tpl, p.s.job)) return reply(c, STUDY, false);
        if (runes[tpl.RuneType]) { alert(c, 'Esta runa já foi aprendida'); return reply(c, STUDY, false); }
        const first = R.first(tpl.RuneType, p.s.job);
        if (!first || p.s.grades < first.NeedGrade) { alert(c, `Karakter Lv. ${first ? first.NeedGrade : R.OPEN} necessário`); return reply(c, STUDY, false); }
        const book = p.itemAt(m.learnRunePos, 1);
        const bt = book && D.items.get(book.templateId);
        if (!bt || bt.SonType !== R.BOOK_SONTYPE || bt.Property1 !== tpl.RuneType) { alert(c, 'Pedra de runa necessária ausente'); return reply(c, STUDY, false); }
        p.removeItem(book, 1);
        sendItems(c, [M.movedEntry(p, book, book.count <= 0)]);
        runes[tpl.RuneType] = { id: first.TemplateId, gp: 0, swallow: 0 };
        ctx.stat(c, 'runeStudy');
        return changed(c, STUDY);
      }

      if (m.opType === UPGRADE) {
        const r = tpl && runes[tpl.RuneType];
        if (!r) { alert(c, 'Aprenda a runa primeiro'); return reply(c, UPGRADE, false); }
        const cur = R.RUNES.get(r.id), next = cur && R.RUNES.get(cur.NextRuneId);
        if (!next || cur.RuneGrade >= R.MAX_GRADE) { alert(c, 'Runa no nível máximo'); return reply(c, UPGRADE, false); }
        if (p.s.grades < next.NeedGrade && r.gp >= next.NeedGp) { alert(c, `Karakter Lv. ${next.NeedGrade} necessário`); return reply(c, UPGRADE, false); }
        let exp;
        if (m.count > 0) {
          // only as many stones as still count (EXP above the last grade / the level cap is not wasted)
          const room = Math.ceil((expCap(p, cur) - r.gp) / R.STONE_EXP);
          const n = Math.min(m.count, p.countTemplate(R.STONE), Math.max(1, room));
          if (n <= 0) { alert(c, 'Pedras de Runa insuficientes'); return reply(c, UPGRADE, false); }
          sendItems(c, p.takeTemplate(R.STONE, n).map(x => M.movedEntry(p, x, x.count <= 0)));
          exp = n * R.STONE_EXP;
        } else {
          const cost = PRICE * (diamondIndex(p) + 1);
          if (!pay(c, [[-400, cost]])) { alert(c, 'Diamantes insuficientes'); return reply(c, UPGRADE, false); }
          p.s.runeDiamondIndex++;
          sendPlayer(c);
          exp = R.STONE_EXP;
        }
        r.gp += exp;
        R.settle(p, r);
        return changed(c, UPGRADE);
      }

      if (m.opType === TAKE) {
        const want = String(m.runeKey || '').split(',').map(Number).slice(0, 3);
        while (want.length < 3) want.push(-1);
        const open = R.slotsOpen(p), types = new Set();
        for (let i = 0; i < 3; i++) {
          const id = want[i];
          if (id <= 0) { want[i] = -1; continue; }
          const t = R.RUNES.get(id), r = t && runes[t.RuneType];
          if (i >= open || !r || r.id !== id || types.has(t.RuneType)) { alert(c, 'Esta runa não pode ser equipada'); return reply(c, TAKE, false); }
          types.add(t.RuneType);
        }
        p.s.runeKey = want.join(',');
        return changed(c, TAKE);
      }
      reply(c, m.opType, false);
    },
  };

  // total EXP that still counts: up to the first grade the character's level does not allow (held there,
  // as rune.settle does), or the last grade
  function expCap(p, cur) {
    let t = cur;
    for (;;) {
      const n = R.RUNES.get(t.NextRuneId);
      if (!n || t.RuneGrade >= R.MAX_GRADE) return t.NeedGp;
      if (p.s.grades < n.NeedGrade) return n.NeedGp;
      t = n;
    }
  }
};
