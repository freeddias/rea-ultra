// Peri ekipmanı (client PetEquipBag, PetEuipTrainWnd, PetEquipSuccinctWnd; item data in game/petequip.js).
// Client-derived, no capture:
//  The equipment lives in its own bag (PET_BAG 27; config pet_bag "100,300" = cells at start, at most; U_C_BAG_BUY
//  type 2 buys pet_bag_buy "5,40" = 5 cells for 5 x 40 diamonds, bound first when payType 0 -> PlayerMsg
//  petBagCount). Worn: PET_EQUIP_BAG 28, objectId = the pet, pos = SonType - 501 (0..5; 6..9 are artifacts).
//  U_C_BAG_MOVE {beginBagType 27, beginObjId = pet, endBagType 28, endPos part} / back 28 -> 27.
//  C_PET_EQUIP_STRENTH pet.PetEquipReqMsg {petId, bagType, pos}: next t_s_petequipstrengthen row: StrengthenConsume
//  Peri Ruh Cristali (-910, PlayerMsg petEquipStrengNum) + StrengthenGold gold, Probability / 10000 -> 86
//  U_C_ITEM_STRENGTHEN store.StoreRspMsg {strengResult, strengthenGrade, masterAttr, sonAttr}.
//  C_PET_EQUIP_RESOLVE {pos "a,b,..."} (bag 27): each gives its Refresh (-910) x (Property5 + the strengthen
//  consumption x Resolveadd % of every level it had; client getRefreshArr).
//  C_PET_EQUIP_SUCCINCT {op}: 2 = the pending result (asked when the window opens), 0 = refine for Property6 x
//  (5 + 1 x floor(strengthen / 5)) (config pet_equip_refresh "5,1"): main, sub kinds and effect re-rolled, kept
//  aside; 1 = take it -> 4501 pet.PetEquipRefreshRspMsg {op, masterAttr, sonAttr, petSuitId}.
//  3 = promotion SSS -> EX (t_s_compose row with Material1 = the item: strengthen >= NeedMinLevel, NeedGold, Material2..4
//  x Count2..4; type 1 = missing special stones replaced by PetEquipChangeCost; attrPos = the entry chosen from the
//  new item's Property4 group; strengthen level and refine attributes stay); 4 = change the entry
//  (PetEquipChangeEntryCost "2127299,1").
// Our choices: isContinue (the second strengthen button) strengthens until a level fails or the means run out;
// Profile 6 resolving does not return compose materials.
const PE = require('../petequip');
const { PET_BAG, PET_EQUIP_BAG } = PE;

module.exports = (ctx) => {
  const { D, dec, sendT, alert, pay, grant, CONF, M } = ctx;
  const BUY = String(CONF.str('pet_bag_buy') || '5,40').split(',').map(Number);
  const REFRESH = String(CONF.str('pet_equip_refresh') || '5,1').split(',').map(Number);
  const COMPOSE = ctx.table('t_s_compose').filter(r => PE.isPetEquip(D.items.get(r.Material1)));
  const GENERAL = Number(CONF.str('PetEquipChangeCost')) || 2127200;   // Genel EX Seviye Terfi Taşı
  const ENTRY_COST = String(CONF.str('PetEquipChangeEntryCost') || '2127299,1').split(',').map(Number);   // EX Yeniden Oluşturma Taşı
  const part = tp => tp.SonType - 501;
  const itemOf = (p, bagType, pos, petId) => bagType === PET_EQUIP_BAG
    ? p.s.bag.find(i => i.bagType === PET_EQUIP_BAG && i.objectId === petId && i.pos === pos)
    : p.itemAt(pos, bagType);
  const petEquip = it => !!it && !!it.pe && PE.isPetEquip(D.items.get(it.templateId));
  const refreshPet = (c, ids) => { const pets = ctx.petList(c.player).filter(x => ids.includes(x.id)); if (pets.length) ctx.petSend(c, pets); };

  // pet equipment from before its own bag existed (granted into bag 1) moves there
  ctx.onLoad.push(c => {
    const p = c.player;
    for (const it of p.s.bag.filter(i => (i.bagType ?? 1) === 1 && PE.isPetEquip(D.items.get(i.templateId)))) {
      const pos = p.freePos(PET_BAG); if (pos < 0) break;
      it.bagType = PET_BAG; it.pos = pos; PE.init(it);
    }
  });

  ctx.bagMove.push((c, m) => {
    const p = c.player;
    if (m.beginBagType === PET_BAG && m.endBagType === PET_EQUIP_BAG) {
      const it = p.itemAt(m.beginPos, PET_BAG), petId = m.beginObjId || m.objectId;
      if (!petEquip(it)) return true;
      const tp = D.items.get(it.templateId), pet = ctx.petList(p).find(x => x.id === petId);
      if (!pet) { alert(c, 'Silfo não obtido'); return true; }
      if (tp.NeedGrades > pet.grade) { alert(c, `Silfo Lv. ${tp.NeedGrades} necessário`); return true; }
      const pos = part(tp), entries = [{ changeType: PET_BAG, changeObjId: 0, changePos: it.pos }];
      const old = itemOf(p, PET_EQUIP_BAG, pos, pet.id);
      if (old) { entries.push({ changeType: PET_EQUIP_BAG, changeObjId: pet.id, changePos: pos }); old.bagType = PET_BAG; old.objectId = 0; old.pos = it.pos; entries.push(M.movedEntry(p, old)); }
      it.bagType = PET_EQUIP_BAG; it.objectId = pet.id; it.pos = pos;
      entries.push(M.movedEntry(p, it));
      ctx.sendItems(c, entries); p.save(); refreshPet(c, [pet.id]); return true;
    }
    if (m.beginBagType === PET_EQUIP_BAG && m.endBagType === PET_BAG) {
      const it = itemOf(p, PET_EQUIP_BAG, m.beginPos, m.beginObjId || m.objectId);
      if (!petEquip(it)) return false;
      let pos = m.endPos; if (pos < 0 || pos >= p.sizeOf(PET_BAG) || p.itemAt(pos, PET_BAG)) pos = p.freePos(PET_BAG);
      if (pos < 0) { alert(c, 'Mochila de equipamento de silfo cheia'); return true; }
      const petId = it.objectId, entries = [{ changeType: PET_EQUIP_BAG, changeObjId: petId, changePos: it.pos }];
      it.bagType = PET_BAG; it.objectId = 0; it.pos = pos;
      entries.push(M.movedEntry(p, it));
      ctx.sendItems(c, entries); p.save(); refreshPet(c, [petId]); return true;
    }
    if (m.beginBagType === PET_BAG && m.endBagType === PET_BAG) {   // rearranging inside the pet bag
      const it = p.itemAt(m.beginPos, PET_BAG); if (!it || m.endPos < 0 || m.endPos >= p.sizeOf(PET_BAG)) return true;
      const other = p.itemAt(m.endPos, PET_BAG), entries = [];
      if (other) { other.pos = it.pos; entries.push(M.movedEntry(p, other)); } else entries.push({ changeType: PET_BAG, changeObjId: 0, changePos: it.pos });
      it.pos = m.endPos; entries.push(M.movedEntry(p, it));
      ctx.sendItems(c, entries); p.save(); return true;
    }
    return false;
  });

  ctx.buyPetBag = (c, m) => {
    const p = c.player, [cells, price] = BUY, have = p.s.petBagBought || 0, rows = Math.max(1, m.property1 || 1);
    if (PE.BAG_BASE + have + cells * rows > PE.BAG_MAX) { alert(c, 'Limite atingido, não é possível comprar'); return; }
    const cost = cells * price * rows, bound = m.payType === 0 && ctx.balance(p, -500) >= cost;
    if (!pay(c, [[bound ? -500 : -400, cost]])) { alert(c, 'Diamantes insuficientes'); return; }
    p.s.petBagBought = have + cells * rows; p.save();
    ctx.sendPlayer(c);
    alert(c, `Limite da mochila expandido com sucesso em ${cells * rows} espaços`);
  };

  const strenReply = (c, it, ok) => sendT(c, 86, 'store.StoreRspMsg', Object.assign({ strengResult: ok, strengthenGrade: it.strengthenGrade || 0, pos: it.pos, objectId: it.objectId || 0, bagType: it.bagType }, PE.attrStrings(it.pe, it.strengthenGrade || 0)));
  const succinctMsg = (op, it, pe) => Object.assign({ op, result: true, bagType: it.bagType, pos: it.pos, objectId: it.objectId || 0 },
    pe ? Object.assign(PE.attrStrings(pe, it.strengthenGrade || 0), { petSuitId: pe.suit || 0 }) : {});

  return {
    C_PET_EQUIP_STRENTH(c, body) {
      const m = dec(c, 'C_PET_EQUIP_STRENTH', body), p = c.player, it = itemOf(p, m.bagType, m.pos, m.petId);
      if (!petEquip(it)) return;
      const tp = D.items.get(it.templateId);
      let ok = false, done = 0;
      do {
        const sg = it.strengthenGrade || 0, row = PE.STR.get(sg + 1);
        if (!row || sg >= PE.maxLevel(tp)) { if (!done) alert(c, 'Aprimoramento no nível máximo'); break; }
        if (!pay(c, [[-910, row.StrengthenConsume || 0], [-100, row.StrengthenGold || 0]])) { if (!done) alert(c, 'Cristal de Alma do Silfo ou ouro insuficiente'); break; }
        ok = Math.random() * 10000 < (row.Probability ?? 10000);
        if (!ok) break;
        it.strengthenGrade = sg + 1; PE.leveled(it); done++;
      } while (m.isContinue);
      strenReply(c, it, ok || done > 0);
      ctx.sendItems(c, [M.movedEntry(p, it)]);
      p.save(); ctx.sendPlayer(c);
      if (it.bagType === PET_EQUIP_BAG) refreshPet(c, [it.objectId]);
    },
    C_PET_EQUIP_RESOLVE(c, body) {
      const m = dec(c, 'C_PET_EQUIP_RESOLVE', body), p = c.player;
      const items = [...new Set(String(m.pos || '').split(',').filter(x => x !== '').map(Number))].map(pos => p.itemAt(pos, PET_BAG)).filter(petEquip);
      if (!items.length) { alert(c, 'Selecione o equipamento para decompor'); return; }
      const got = {}, entries = [];
      for (const it of items) {
        const tp = D.items.get(it.templateId);
        let n = tp.Property5 || 0;
        for (let l = 1; l <= (it.strengthenGrade || 0); l++) { const r = PE.STR.get(l); if (r) n += (r.StrengthenConsume || 0) * (r.Resolveadd || 0) / 100; }
        const tid = tp.Refresh || -910; got[tid] = (got[tid] || 0) + Math.floor(n);
        entries.push(M.movedEntry(p, it, true)); p.s.bag = p.s.bag.filter(x => x !== it);
      }
      ctx.sendItems(c, entries);
      grant(c, Object.entries(got).map(([t, n]) => [Number(t), n]).filter(([, n]) => n > 0));
      ctx.stat(c, 'petEquipResolve', items.length);   // daily activity Type 44
      p.save(); ctx.sendPlayer(c);
    },
    C_PET_EQUIP_SUCCINCT(c, body) {
      const m = dec(c, 'C_PET_EQUIP_SUCCINCT', body), p = c.player, it = itemOf(p, m.bagType, m.pos, m.petId);
      if (!petEquip(it)) return;
      const tp = D.items.get(it.templateId);
      if (m.op === 2) return sendT(c, 4501, 'pet.PetEquipRefreshRspMsg', succinctMsg(2, it, it.pending));
      if (m.op === 0) {
        if (!tp.Property6) { alert(c, 'Este equipamento não pode ser refinado'); return; }
        const n = (REFRESH[0] || 5) + (REFRESH[1] || 1) * Math.floor((it.strengthenGrade || 0) / 5);
        if (!pay(c, [[tp.Property6, n]])) { alert(c, 'Pedra de refinamento insuficiente'); return sendT(c, 4501, 'pet.PetEquipRefreshRspMsg', { op: 0, result: false }); }
        it.pending = PE.reroll(it); p.save();
        return sendT(c, 4501, 'pet.PetEquipRefreshRspMsg', succinctMsg(0, it, it.pending));
      }
      if (m.op === 1) {
        if (!it.pending) return;
        it.pe = Object.assign(it.pending, { entry: it.pe.entry }); delete it.pending;
        sendT(c, 4501, 'pet.PetEquipRefreshRspMsg', succinctMsg(1, it, it.pe));
        ctx.sendItems(c, [M.movedEntry(p, it)]); p.save();
        if (it.bagType === PET_EQUIP_BAG) refreshPet(c, [it.objectId]);
        return;
      }
      if (m.op === 3) {   // promotion SSS -> EX (client PetEquipPromotionWnd): attrPos = the chosen entry, type 1 = general stones for the missing special ones
        const row = COMPOSE.find(r => r.Material1 === it.templateId), nt = row && D.items.get(row.NewMaterial);
        if (!nt) { alert(c, 'Este ekipman terfi edemez'); return; }
        if ((it.strengthenGrade || 0) < (row.NeedMinLevel || 0)) { alert(c, `Aprimoramento +${row.NeedMinLevel} necessário`); return; }
        const group = PE.entries(nt.Property4);
        if (group.length && !group.some(r => r.TemplateId === m.attrPos)) { alert(c, 'Atributo não selecionado'); return; }
        const cost = [[-100, row.NeedGold || 0]];
        for (let k = 2; k <= 4; k++) if (row['Material' + k]) cost.push([row['Material' + k], row['Count' + k] || 0]);
        const sp = cost.find(([t]) => t > 0);
        if (sp && m.type === 1) { const have = ctx.balance(p, sp[0]); if (have < sp[1]) { cost.push([GENERAL, sp[1] - have]); sp[1] = have; } }
        if (!pay(c, cost)) { alert(c, 'Malzeme insuficiente'); return; }
        it.templateId = nt.TemplateId; it.pe.entry = group.length ? m.attrPos : 0;   // strengthen level and refine attributes stay (help text)
        sendT(c, 4501, 'pet.PetEquipRefreshRspMsg', Object.assign(succinctMsg(3, it, it.pe), { petEntryId: it.pe.entry }));
      } else if (m.op === 4) {   // another entry of the same group (client PetEquipEntryWnd): PetEquipChangeEntryCost
        const group = PE.entries(tp.Property4);
        if (!it.pe.entry || !group.some(r => r.TemplateId === m.attrPos)) return;
        if (!pay(c, [[ENTRY_COST[0], ENTRY_COST[1] || 1]])) { alert(c, 'Malzeme insuficiente'); return; }
        it.pe.entry = m.attrPos;
        sendT(c, 4501, 'pet.PetEquipRefreshRspMsg', Object.assign(succinctMsg(4, it, it.pe), { petEntryId: it.pe.entry }));
      } else return;
      ctx.sendItems(c, [M.movedEntry(p, it)]); p.save();
      if (it.bagType === PET_EQUIP_BAG) refreshPet(c, [it.objectId]);
    },
  };
};
