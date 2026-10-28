// Peri eserleri (artifacts; client ArtifactTips / ArtifactResetWnd / UIArtifact "Bereket Özellikleri";
// t_s_petartifactproperty, keyed by the item's TemplateId). Client-derived, no capture:
//  An artifact is an equipment item (MasterType 1, SonType 120, levels 1..9) from the "Eser Hazinesi" boxes.
//  Appraisal: C_ARTIFACT_APPLRAISAL store.StoreReqMsg {bagPos} for the row's ActiveGold (the client checks the gold
//  and warns it can't be traded afterwards) -> each blessing rolled in [Min, Max]: randomSkill_1..5 = attack, magic
//  attack, defence, magic defence, hp blessing (client getAddTxt; appraised = any of them > 0).
//  Wearing: U_C_BAG_MOVE bag 1 -> PET_EQUIP_BAG 28 {beginObjId = pet, endPos 6..9} (client getPos: the first free of
//  6..9), back with 28 -> 1 to any free bag slot.
//  Recast: C_ARTIFACT_RECAST {holePos + srcItemid, bagPos + desItemid} = (pos, objectId) of the two artifacts
//  (objectId = the pet wearing it, 0 = in the bag); levels at most 1 apart; equal levels: UpgradeRandom1 % to get
//  level + 1, otherwise the same level; different: the higher's UpgradeRandom2 % for its level + 1, otherwise its
//  level; costs the (higher) row's ReforgeDiamond diamonds; the result is unappraised -> 4869 store.StoreRspMsg
//  {composeResult, composeTemplateId} (the client shows it in the wish-pool result window).
//  Another player's artifacts: C_GET_PET_ARTIFACT_LIST {targetUserid} -> 4623 pet.PetDetailMsgList {petList: per pet
//  {petmsg {userId, petInfo [the pet]}, item [its bag-28 items]}}; PetInfoMsg atk/mat/def/mdf/hpbeneAtr = the sums.
// Our choices: the result template of a level is picked by ReforgeObtainWeight; level 9 is the top (no level 10
// rows); the blessings of every worn artifact add flat stats to the hero (the UIArtifact panel shows the total of
// all pets); a released pet's artifacts go back to the bag.
const { bagTypeOf } = require('../player');
const SONTYPE = 120, PET_BAG = 28, SLOTS = [6, 7, 8, 9];
const KEYS = [['MinAtk', 'MaxAtk', 'Attack', 'atkbeneAtr'], ['MinMat', 'MaxMat', 'MagicAttack', 'matbeneAtr'], ['MinDef', 'MaxDef', 'Defence', 'defbeneAtr'],
  ['MinMdf', 'MaxMdf', 'MagicDefence', 'mdfbeneAtr'], ['MinHp', 'MaxHp', 'Live', 'hpbeneAtr']];

module.exports = (ctx) => {
  const { D, table, dec, sendT, alert, pay, M } = ctx;
  const ROWS = table('t_s_petartifactproperty'), ROW = new Map(ROWS.map(r => [r.ItemId, r]));
  const TOP = Math.max(...ROWS.map(r => r.Level));
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const isArt = it => !!it && (D.items.get(it.templateId) || {}).SonType === SONTYPE && ROW.has(it.templateId);
  const worn = (p, petId) => p.s.bag.filter(i => i.bagType === PET_BAG && i.objectId === petId && SLOTS.includes(i.pos));
  const art = (p, pos, objectId) => objectId > 0 ? worn(p, objectId).find(i => i.pos === pos) : p.itemAt(pos, 1);

  function bene(p, petId) {
    const o = {}; for (const k of KEYS) o[k[3]] = 0;
    for (const it of worn(p, petId)) KEYS.forEach((k, j) => { o[k[3]] += (it.art || [])[j] || 0; });
    return o;
  }
  ctx.petBene = bene;
  function restat(p) {
    const add = {};
    for (const pet of ctx.petList(p)) { const b = bene(p, pet.id); for (const k of KEYS) if (b[k[3]]) add[k[2]] = (add[k[2]] || 0) + b[k[3]]; }
    (p.s.adds = p.s.adds || {}).artifact = add;
  }
  const refresh = (c, petIds) => {
    const p = c.player; restat(p); p.save();
    const pets = ctx.petList(p).filter(x => petIds.includes(x.id));
    if (pets.length) ctx.petSend(c, pets);
    ctx.sendPlayer(c); ctx.sendArmy(c);
  };
  // items left on a pet that no longer exists (released, older saves) go back to their bag
  function orphans(p) {
    const ids = new Set(ctx.petList(p).map(x => x.id)), out = [];
    for (const it of p.s.bag.filter(i => i.bagType === PET_BAG && !ids.has(i.objectId))) {
      const bt = bagTypeOf(D.items.get(it.templateId) || {}), pos = p.freePos(bt); if (pos < 0) continue;   // artifacts -> bag, pet equipment -> pet bag 27
      out.push({ changeType: PET_BAG, changeObjId: it.objectId, changePos: it.pos });
      it.bagType = bt; it.objectId = 0; it.pos = pos; out.push(M.movedEntry(p, it));
    }
    return out;
  }
  ctx.petGone = (c, petId) => { const e = orphans(c.player); if (e.length) ctx.sendItems(c, e); restat(c.player); ctx.sendPlayer(c); ctx.sendArmy(c); };
  ctx.onLogin.push(c => { orphans(c.player); restat(c.player); });   // before the first PlayerMsg / ArmyMsg
  ctx.onLoad.push(c => { orphans(c.player); restat(c.player); });

  ctx.bagMove.push((c, m) => {
    const p = c.player;
    if (m.beginBagType === 1 && m.endBagType === PET_BAG) {
      const it = p.itemAt(m.beginPos, 1);
      if (!it || !isArt(it)) return false;   // pet equipment (pos 0..5) is not here
      const petId = Number(m.beginObjId || m.objectId || m.endObjId) || 0;
      const pet = ctx.petList(p).find(x => x.id === petId);   // the client sends the pet as beginObjId
      if (!pet) { alert(c, 'Selecione um silfo para aplicar o artefato'); return true; }
      if (!SLOTS.includes(m.endPos)) { alert(c, 'Espaço de artefato inválido'); return true; }
      if (!(it.art || []).some(x => x > 0)) { alert(c, 'Identifique o artefato antes de aplicar'); return true; }
      const entries = [{ changeType: 1, changeObjId: 0, changePos: it.pos }];
      const old = worn(p, pet.id).find(i => i.pos === m.endPos);
      if (old) { old.bagType = 1; old.objectId = 0; old.pos = it.pos; entries.push(M.movedEntry(p, old)); }
      it.bagType = PET_BAG; it.objectId = pet.id; it.pos = m.endPos; it.bind = true;
      entries.push(M.movedEntry(p, it));
      ctx.sendItems(c, entries); refresh(c, [pet.id]); return true;
    }
    if (m.beginBagType === PET_BAG && m.endBagType === 1) {
      const it = worn(p, m.beginObjId).find(i => i.pos === m.beginPos);
      if (!it) return false;
      let pos = m.endPos; if (pos < 0 || p.itemAt(pos, 1)) pos = p.freePos();
      if (pos < 0) { alert(c, 'Mochila cheia, não é possível remover'); return true; }
      const entries = [{ changeType: PET_BAG, changeObjId: it.objectId, changePos: it.pos }];
      const petId = it.objectId; it.bagType = 1; it.objectId = 0; it.pos = pos;
      entries.push(M.movedEntry(p, it));
      ctx.sendItems(c, entries); refresh(c, [petId]); return true;
    }
    return false;
  });

  return {
    C_ARTIFACT_APPLRAISAL(c, body) {
      const m = dec(c, 'C_ARTIFACT_APPLRAISAL', body), p = c.player, it = p.itemAt(m.bagPos, 1), row = it && ROW.get(it.templateId);
      if (!row || !isArt(it)) return;
      if ((it.art || []).some(x => x > 0)) { alert(c, 'Este artefato já foi avaliado'); return; }
      if (!pay(c, [[-100, row.ActiveGold || 0]])) { alert(c, 'Ouro insuficiente'); return; }
      it.art = KEYS.map(([lo, hi]) => (row[hi] > 0 ? rnd(row[lo] || 0, row[hi]) : 0));
      it.bind = true;
      ctx.sendItems(c, [M.movedEntry(p, it)]);
      p.save();
    },
    C_ARTIFACT_RECAST(c, body) {
      const m = dec(c, 'C_ARTIFACT_RECAST', body), p = c.player;
      const a = art(p, m.holePos, m.srcItemid), b = art(p, m.bagPos, m.desItemid);
      const fail = () => sendT(c, 4869, 'store.StoreRspMsg', { composeResult: false });
      if (!a || !b || a === b || !isArt(a) || !isArt(b)) return fail();
      const ra = ROW.get(a.templateId), rb = ROW.get(b.templateId);
      if (Math.abs(ra.Level - rb.Level) > 1) { alert(c, 'A diferença de nível entre artefatos recriados não pode passar de 1'); return fail(); }
      const hi = ra.Level >= rb.Level ? ra : rb, chance = ra.Level === rb.Level ? ra.UpgradeRandom1 : hi.UpgradeRandom2;
      if (p.freePos() < 0 && !(a.bagType === 1 || b.bagType === 1)) { alert(c, 'Mochila cheia'); return fail(); }
      if (!pay(c, [[-400, hi.ReforgeDiamond || 0]])) { alert(c, 'Diamantes insuficientes'); return fail(); }
      const level = Math.min(TOP, Math.random() * 100 < (chance || 0) ? hi.Level + 1 : hi.Level);
      const pool = ROWS.filter(r => r.Level === level && D.items.has(r.ItemId));
      let w = Math.random() * pool.reduce((n, r) => n + (r.ReforgeObtainWeight || 1), 0), pick = pool[pool.length - 1];
      for (const r of pool) { w -= r.ReforgeObtainWeight || 1; if (w < 0) { pick = r; break; } }
      const pets = [a.objectId, b.objectId].filter(x => x > 0), entries = [];
      for (const it of [a, b]) { entries.push(M.movedEntry(p, it, true)); p.s.bag = p.s.bag.filter(x => x !== it); }
      for (const x of p.addItem(pick.ItemId, 1)) entries.push(M.movedEntry(p, x));
      ctx.sendItems(c, entries);
      if (pets.length) refresh(c, pets); else p.save();
      sendT(c, 4869, 'store.StoreRspMsg', { composeResult: true, composeTemplateId: pick.ItemId });
    },
    C_GET_PET_ARTIFACT_LIST(c, body) {
      const m = dec(c, 'C_GET_PET_ARTIFACT_LIST', body), other = ctx.playerById(m.targetUserid || c.player.id);
      const petList = other ? ctx.petList(other).map(pet => ({ petmsg: { userId: other.id, petInfo: ctx.petInfos(other).filter(x => x.petId === pet.id) },
        item: other.s.bag.filter(i => i.bagType === PET_BAG && i.objectId === pet.id).map(i => M.itemMsg(other, i)) })) : [];
      sendT(c, 4623, 'pet.PetDetailMsgList', { petList });
    },
  };
};
