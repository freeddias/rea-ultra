// Smithy: compose (t_s_compose), gem inlay / removal, socket opening, refining random properties.
// The equipment being worked on sits in the forge slot (bag type 0 "Hide", pos 0), as for strengthening.
// Capture (official server):
//  compose  U_C_ITEM_COMPOSE {composeId, composeNum, autoBuy, payType}: Material1..4 x Count1..4 x num and
//           NeedGold x num taken, NewMaterial x Counts x num given, always succeeds; then 109 castle,
//           111 "Obtido:Lv. 2 HP Mücevheri x1", 89 (empty result, the client reads no body).
//           Gold checked: 356 x1 -50, 367 x2 -100, 201 x1 -100000.
//  inlay    U_C_ITEM_INLAY {bagType, bagPos, mountPos}: the gem leaves the bag, join_<mountPos> = gem,
//           111 "Başarıyla işlendi!". Client rules: one gem per kind (Property1) on an item, only open
//           sockets (join 0).
//  sockets  U_C_ITEM_INLAYJOIN {holePos, operate}: operate true opens socket holePos with an "Diamante Delici"
//           (208004); operate false takes the gem out of holePos (-1 = all) back into the bag. Not in the
//           capture; formats from the client (ForgeCtrl.openHole / sendPunch).
//  refine   C_ITEM_REFRESHFORRANDOM {lock[5], bindType, payType}: one refining stone (the item's Refresh
//           template) per refine, each lock one "Arıtma Kilidi" (208027) or RefreshLock_Price (15) diamonds;
//           answers 111 "Başarıyla arıtma yapıldı", 4258 {randomSkill: new 5}, 4368 {randomSkill, lockPos,
//           result 1}; the item keeps its old properties until C_ITEM_REFRESHFORREPLACE accepts them.
//           C_ITEM_REFRESHPROPERTY {itemId} asks for the pending result (empty 4368 when there is none).
const E = require('../equip');
const FORGE = 0, PUNCH = 208004, LOCK_ITEM = 208027, GEM = 205;
const R_COMPOSE = 89, R_FRESH = 4258, R_PROPERTY = 4368;

module.exports = (ctx) => {
  const { D, table, dec, sendT, sendItems, sendCastle, sendPlayer, sendArmy, alert, chat, pay, M, CONF, refreshQuests, bump } = ctx;
  const COMPOSE = new Map(table('t_s_compose').map(r => [r.Id, r]));
  const SHOP = new Map();   // item -> cheapest diamond price, for compose autoBuy
  for (const g of table('t_s_shop')) if (g.Point > 0 && (!SHOP.has(g.ItemId) || SHOP.get(g.ItemId) > g.Point)) SHOP.set(g.ItemId, g.Point);
  const LOCK_PRICE = CONF.get('RefreshLock_Price') || 15;
  const itemName = tid => ctx.itemName(tid) || String(tid);
  const forgeItem = p => p.itemAt(0, FORGE);
  const done = (c, text) => { alert(c, text); chat(c, text); };
  // gems / random properties changed the hero's totals
  const statsChanged = (c, it) => { if ((it.bagType ?? 1) === 4) { sendArmy(c); sendPlayer(c); } };

  function materials(r) {
    const out = [];
    for (let i = 1; i <= 4; i++) if (r['Material' + i] && r['Count' + i]) out.push([r['Material' + i], r['Count' + i]]);
    return out;
  }

  // gem transform (store switch view, t_s_transformtemplate): count of one gem into another gem of the same
  // row (same TransformId level) for CostGold x count gold. Client field names are crossed: desItemid is the
  // owned gem, srcItemid the wanted one (iz.sendSwitch(target, current, count)). No reply body: bag + alert.
  const TRANSFORM = table('t_s_transformtemplate');
  const rowOf = tid => TRANSFORM.find(r => [1, 2, 3, 4, 5, 6, 7, 8].some(i => r['Material' + i] === tid));
  // Tanrısal döküm / Fundição divina (client cast view, iz.sendItemMould(), no body): the forge-slot
  // equipment (StrengthenMax > 0, Profile >= 5, NeedGrades >= 50) takes Vulkan'ın Çekici 2120100 x5 +
  // Vulkan'ın Ocağı 2120101 x15 (relic / heraldry: 10 / 30) and 500 x (8 + e)^3 gold, e = the next star
  // (grade % 10 + 1); rate = 50 - 10(e - 1) for e <= 5, else 5, plus blessValue (cap 100).
  // Cap: Divinecast_Upperlimit (hard max, tipicamente 160) limitado ao nível do jogador — não mais
  // travado em 80 para equipamentos sem Property6.
  // Our choice (no capture): a failure adds 10 bless (MOULD_MAX_BLESS 100), a success clears it.
  // -> 4558 store.StoreRspMsg {strengResult, strengthenGrade = new mouldGrade, pos, objectId, bagType}
  const MOULD_CAP = String(CONF.str('Divinecast_Upperlimit') || '160,160').split(',').map(Number);
  const RELIC = new Set([117, 118]);   // client SONTYPE_HERALDRY, SONTYPE_RELIC
  function mould(c) {
    const p = c.player, it = forgeItem(p), tp = it && D.items.get(it.templateId);
    const reply = ok => sendT(c, 4558, 'store.StoreRspMsg', { strengResult: ok, strengthenGrade: it ? it.mouldGrade || 0 : 0, pos: it ? it.pos : 0, objectId: it ? it.objectId || 0 : 0, bagType: FORGE });
    if (!tp) { alert(c, 'Coloque um equipamento primeiro'); return reply(false); }
    if (!tp.StrengthenMax || (tp.Profile || 0) < 5 || (tp.NeedGrades || 0) < 50) { alert(c, 'Este equipamento não pode ser fundido'); return reply(false); }
    const hard = Math.max(MOULD_CAP[0] || 160, MOULD_CAP[1] || 160);
    const cap = Math.min(hard, Math.max(1, p.s.grades | 0));
    const g = it.mouldGrade || 0;
    if (g >= cap) {
      alert(c, g >= hard ? 'Nível máximo de fundição' : `Fundição limitada ao seu nível (${cap})`);
      return reply(false);
    }
    const e = g % 10 + 1, relic = RELIC.has(tp.SonType);
    const cost = [[2120100, relic ? 10 : 5], [2120101, relic ? 30 : 15], [-100, 500 * (8 + e) ** 3]];
    if (!pay(c, cost)) { alert(c, 'Material ou ouro insuficiente'); return reply(false); }
    const rate = Math.min(100, (e <= 5 ? 50 - 10 * (e - 1) : 5) + (it.blessValue || 0));
    const ok = Math.random() * 100 < rate;
    if (ok) { it.mouldGrade = g + 1; it.blessValue = 0; } else it.blessValue = Math.min(100, (it.blessValue || 0) + 10);
    p.save();
    sendItems(c, [M.movedEntry(p, it)]);
    reply(ok);
    if (ok) done(c, `${itemName(it.templateId)} chegou ao nível de fundição ${it.mouldGrade}`);
    else alert(c, 'Fundição falhou, bênção +10');
  }
  return {
    C_MOULD_ITEM: mould,
    C_ITEM_TRANSFORM(c, body) {
      const m = dec(c, 'C_ITEM_TRANSFORM', body), p = c.player, from = m.desItemid, to = m.srcItemid, n = Math.max(1, m.count || 1);
      const row = rowOf(from);
      if (!row || row !== rowOf(to) || from === to) { alert(c, 'Estas duas joias não podem ser convertidas'); return; }
      if (p.countTemplate(from) < n) { alert(c, 'Joias insuficientes'); return; }
      const off = ctx.vipPriv ? ctx.vipPriv(p, 14) : 0;   // VIP privilege 14 (client DISCOUNT): the gold cost -para1 % (client: floor(CostGold x count x (1 - para1 / 100)))
      if (!pay(c, [[-100, Math.floor((row.CostGold || 0) * n * (1 - off / 100))], [from, n]])) { alert(c, 'Ouro insuficiente'); return; }
      ctx.grant(c, [[to, n]], { quiet: true });
      alert(c, `${itemName(to)} x${n} convertido(s)`);
    },
    U_C_ITEM_COMPOSE(c, body) {
      const m = dec(c, 'U_C_ITEM_COMPOSE', body), p = c.player, r = COMPOSE.get(m.composeId);
      const n = Math.max(1, m.composeNum || 1);
      if (!r || !D.items.has(r.NewMaterial)) { alert(c, 'Combinação desconhecida'); return; }
      if (r.NeedMinLevel && p.s.grades < r.NeedMinLevel) { alert(c, `Personagem Lv. ${r.NeedMinLevel} necessário`); return; }
      const need = materials(r).map(([tid, k]) => [tid, k * n]);
      // missing materials bought with (bound) diamonds when autoBuy is ticked (payType 0 bound, client sendCompose)
      const buy = [];
      for (const [tid, k] of need) {
        const miss = k - p.countTemplate(tid);
        if (miss <= 0) continue;
        if (!m.autoBuy || !SHOP.has(tid)) { alert(c, `${itemName(tid)} insuficiente`); return; }
        buy.push([tid, miss]);
      }
      const points = buy.reduce((s, [tid, k]) => s + SHOP.get(tid) * k, 0);
      const gold = (r.NeedGold || 0) * n;
      if (p.s.gold < gold) { alert(c, 'Ouro insuficiente'); return; }
      if (points && !pay(c, [[m.payType === 0 ? -500 : -400, points]])) { alert(c, m.payType === 0 ? 'Diamantes vinculados insuficientes' : 'Diamantes insuficientes'); return; }
      const entries = [];
      for (const [tid, k] of need) {
        const have = Math.min(k, p.countTemplate(tid));
        for (const it of p.takeTemplate(tid, have)) entries.push(M.movedEntry(p, it, it.count <= 0));
      }
      p.s.gold -= gold;
      const made = (r.Counts || 1) * n;
      const got = p.addItem(r.NewMaterial, made);
      sendItems(c, entries);
      sendCastle(c);
      sendItems(c, got.map(it => M.movedEntry(p, it)));
      if (points) sendPlayer(c);
      ctx.stat(c, 'compose', n);
      bump(c, 19, r.NewMaterial, made);   // quest condition 19 "... Combinar" (Para1 = product)
      p.save();
      done(c, `Obtido:${itemName(r.NewMaterial)} x${made}`);
      sendT(c, R_COMPOSE, 'farm.FarmInfoRspMsg', {});
      refreshQuests(c);
    },

    U_C_ITEM_INLAY(c, body) {
      const m = dec(c, 'U_C_ITEM_INLAY', body), p = c.player, it = forgeItem(p), gem = p.itemAt(m.bagPos, m.bagType ?? 1);
      if (!it || !E.isEquip(D.items.get(it.templateId))) { alert(c, 'Coloque um equipamento primeiro'); return; }
      const gt = gem && D.items.get(gem.templateId);
      if (!gt || gt.SonType !== GEM) { alert(c, 'Isto não é uma joia'); return; }
      E.init(it);
      const i = (m.mountPos || 0) - 1;
      if (i < 0 || i >= E.SOCKETS || it.joins[i] !== 0) { alert(c, 'Este espaço não está aberto'); return; }
      if (it.joins.some(g => g > 0 && (D.items.get(g) || {}).Property1 === gt.Property1)) { alert(c, 'Uma joia do mesmo tipo já foi inserida'); return; }
      p.removeItem(gem, 1);
      it.joins[i] = gem.templateId;
      ctx.stat(c, 'inlay');
      p.save();
      sendItems(c, [M.movedEntry(p, gem, gem.count <= 0)]);
      sendItems(c, [M.movedEntry(p, it)]);
      bump(c, 18, 1);   // quest condition 18 "Incrustar Joia" (Para1 1)
      refreshQuests(c);
      done(c, 'Incrustado com sucesso!');
    },

    U_C_ITEM_INLAYJOIN(c, body) {
      const m = dec(c, 'U_C_ITEM_INLAYJOIN', body), p = c.player, it = forgeItem(p);
      if (!it || !E.isEquip(D.items.get(it.templateId))) { alert(c, 'Coloque um equipamento primeiro'); return; }
      E.init(it);
      if (m.operate) {   // open a socket
        const i = (m.holePos || 0) - 1;
        if (i < 0 || i >= E.SOCKETS || it.joins[i] !== -1) { alert(c, 'Este espaço já está aberto'); return; }
        if (p.countTemplate(PUNCH) < 1) { alert(c, `${itemName(PUNCH)} insuficiente`); return; }
        const touched = p.takeTemplate(PUNCH, 1);
        it.joins[i] = 0;
        p.save();
        sendItems(c, touched.map(x => M.movedEntry(p, x, x.count <= 0)));
        sendItems(c, [M.movedEntry(p, it)]);
        done(c, 'Espaço aberto');
        return;
      }
      // take gems out (holePos -1: all)
      const idx = m.holePos === -1 ? it.joins.map((_, i) => i) : [(m.holePos || 0) - 1];
      const gems = idx.filter(i => it.joins[i] > 0);
      if (!gems.length) { alert(c, 'Não há joia neste espaço'); return; }
      if (p.s.bag.filter(x => (x.bagType ?? 1) === 1).length + gems.length > p.bagSize) { alert(c, 'Mochila cheia'); return; }
      const entries = [];
      for (const i of gems) { for (const x of p.addItem(it.joins[i], 1)) entries.push(M.movedEntry(p, x)); it.joins[i] = 0; }
      p.save();
      sendItems(c, entries);
      sendItems(c, [M.movedEntry(p, it)]);
      done(c, 'Removido com sucesso');
    },

    C_ITEM_REFRESHPROPERTY(c, body) {
      const m = dec(c, 'C_ITEM_REFRESHPROPERTY', body), p = c.player, f = p.s.refine;
      if (!f || f.itemId !== m.itemId) { sendT(c, R_PROPERTY, 'store.RefreshPropertyRepMsg', {}); return; }
      sendT(c, R_PROPERTY, 'store.RefreshPropertyRepMsg', { randomSkill: f.skills, lockPos: f.locks, result: 1 });
    },

    C_ITEM_REFRESHFORRANDOM(c, body) {
      const m = dec(c, 'C_ITEM_REFRESHFORRANDOM', body), p = c.player, it = forgeItem(p), tp = it && D.items.get(it.templateId);
      if (!E.isEquip(tp) || !(tp.RandomSkillCount > 0)) { alert(c, 'Este item não pode ser refinado'); return; }
      E.init(it);
      const stone = tp.Refresh;
      if (!stone || p.countTemplate(stone) < 1) { alert(c, `${itemName(stone)} insuficiente`); return; }
      const locks = Array.from({ length: E.MAX_RANDOM }, (_, i) => !!(m.lock || [])[i] && !!it.rnd[i]);
      const nLock = locks.filter(Boolean).length;
      if (nLock >= it.rnd.length) { alert(c, 'Todos os atributos estão bloqueados'); return; }
      // locks: Arıtma Kilidi items first, the rest in diamonds (payType 0 bound, 1 diamonds: client sendRefreshforRandom)
      const lockItems = Math.min(nLock, p.countTemplate(LOCK_ITEM)), lockPoints = (nLock - lockItems) * LOCK_PRICE;
      if (lockPoints && !pay(c, [[m.payType === 0 ? -500 : -400, lockPoints]])) { alert(c, m.payType === 0 ? 'Diamantes vinculados insuficientes' : 'Diamantes insuficientes'); return; }
      const entries = [];
      for (const x of p.takeTemplate(stone, 1)) entries.push(M.movedEntry(p, x, x.count <= 0));
      if (lockItems) for (const x of p.takeTemplate(LOCK_ITEM, lockItems)) entries.push(M.movedEntry(p, x, x.count <= 0));
      const fresh = E.roll(tp, it.rnd, locks);
      const skills = Array.from({ length: E.MAX_RANDOM }, (_, i) => fresh[i] || 0);
      p.s.refine = { itemId: it.id, skills, locks };
      ctx.stat(c, 'refine');
      p.save();
      sendItems(c, entries);
      if (lockPoints) sendPlayer(c);
      bump(c, 47, 0);   // quest condition 47 "Refinar"
      refreshQuests(c);
      done(c, 'Refinamento concluído com sucesso');
      sendT(c, R_FRESH, 'store.SmithFreshRspMsg', { randomSkill: skills });
      sendT(c, R_PROPERTY, 'store.RefreshPropertyRepMsg', { randomSkill: skills, lockPos: locks, result: 1 });
    },

    C_ITEM_REFRESHFORREPLACE(c) {
      const p = c.player, f = p.s.refine, it = f && [...p.s.bag, ...Object.values(p.s.equip)].find(x => x.id === f.itemId);
      if (!it) { alert(c, 'Refine primeiro'); return; }
      it.rnd = f.skills.filter(Boolean);
      p.s.refine = null;
      p.save();
      sendItems(c, [M.movedEntry(p, it)]);
      statsChanged(c, it);
      sendT(c, R_PROPERTY, 'store.RefreshPropertyRepMsg', { randomSkill: [], lockPos: [], result: 1 });
      done(c, 'Atributos alterados');
    },
  };
};
