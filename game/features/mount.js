// Montaria / Canavar Ruhu (Lv25, client ar.MOUNT). Nothing answered; built from the client (MountManager dm,
// Jp mount info, Qp property) and the older official Legend Online TR capture "binek upgrade":
//  4426 MountInfoMsg {mountTempId, power, intellect, physique, agility, powerGp.., mountTotalGp, levelMax}.
//  property grade = t_s_upgradetemplate type 18 by the property's gp; value = mount template's attribute +
//   5 x grade (capture: Şeytan Alpaka Power 10, powerGp 1610 = grade 11 -> 65; 1700 = grade 12 -> 70;
//   intellect 270 = grade 5 -> 35; physique 970 -> 55; agility 1160 -> 60). mountTotalGp = the four gp summed;
//   mount grade = type 19 by mountTotalGp. levelMax 25 at mount grade 1 (capture); 25 x mount grade beyond is
//   an assumption.
//  C_MOUNT_EDIT {propertyType 0 Güç / 1 Zırh (agility) / 2 Zeka / 5 Dayanıklılık (physique), param1 = Canavar
//   Taşı (208017, client n_.MOUNT_FOOD_TEMPID) count}: +9 gp a stone (capture: 10 stones -> +90).
//  C_MOUNT_AVATARLIST -> 4427 MountAvatarMsg (owned mounts; expairDate 2000-01-01 = permanent), C_MOUNT_CHANGE
//   {param1 templateId} rides another owned one, C_ARMYMOUNT_AVATARCHANGE {param1 1 mount / 0 dismount},
//   C_MOUNTAVATAR_ACTIVE {param1 templateId}: unlock with its NeedItemId item.
//  C_MOUNT_INFO_SEND {param1 userId} -> 4459 (viewing someone's mount).
//  Everyone gets mount 1000 "Beyaz Savaş Atı" at Lv25 (the official capture: other players' 4459 showed 1000).
//  Attributes go into the hero's stats (player.js). Star refining: C_MOUNT_UPSTAR. Not built: mount king,
//  double mounts, the advanced train discount.
const pad = n => String(n).padStart(2, '0');
const fmt = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const FOOD = 208017, GP_PER_FOOD = 9, OPEN_LEVEL = 25, DEFAULT_MOUNT = 1000;
const PROPS = { 0: 'power', 1: 'agility', 2: 'intellect', 5: 'physique' };
const TPL_KEY = { power: 'Power', agility: 'Agility', intellect: 'Intellect', physique: 'Physique' };

module.exports = (ctx) => {
  const { D, dec, sendT, table, alert, pay, sendPlayer, sendArmy, playerById, stat, log } = ctx;
  const MOUNTS = new Map(table('t_s_mounttemplate').map(r => [r.TemplateId, r]));
  const levels = type => (D.upgrade.get(type) || []).slice().sort((a, b) => a.Data - b.Data);
  const PROP_LV = levels(18), MOUNT_LV = levels(19), STAR_LV = (D.upgrade.get(37) || []).slice().sort((a, b) => a.Grades - b.Grades);
  const ESSENCE = 208051;
  const BLESS = String((table('t_s_config').find(r => r.ConfigName === 'UpStar_Add_Blessing') || {}).ConfigValue || '1,1').split('|').map(x => x.split(',').map(Number));
  const gradeOf = (list, gp) => { let g = 1; for (const r of list) if (gp >= r.Data) g = r.Grades; return g; };

  function state(p) {
    if (p.s.grades < OPEN_LEVEL && !p.s.mount) return null;
    const m = p.s.mount = p.s.mount || { tid: DEFAULT_MOUNT, riding: false, gp: { power: 0, agility: 0, intellect: 0, physique: 0 }, owned: { [DEFAULT_MOUNT]: fmt() } };
    compute(p, m);
    return m;
  }
  // derived numbers (also stored for player.js stats)
  function compute(p, m) {
    const t = MOUNTS.get(m.tid) || {}, total = Object.values(m.gp).reduce((a, b) => a + b, 0);
    m.grade = gradeOf(MOUNT_LV, total);
    m.levelMax = 25 * m.grade;
    m.add = {};
    // stars (Aydınlatma) add StarPower x stars of every lit mount to each attribute — "kümülatif ve süreklidir" (help
    // text); that it goes to all four attributes is an assumption
    const starAdd = Object.entries(m.stars || {}).reduce((n, [tid, x]) => n + ((MOUNTS.get(Number(tid)) || {}).StarPower || 0) * (x.star || 0), 0);
    for (const k of Object.values(PROPS)) m.add[k] = (t[TPL_KEY[k]] || 0) + 5 * Math.min(gradeOf(PROP_LV, m.gp[k] || 0), m.levelMax) + starAdd;
    m.total = total;
  }
  const infoMsg = m => ({ mountTempId: m.tid, power: m.add.power, intellect: m.add.intellect, physique: m.add.physique, agility: m.add.agility, speed: 0,
    powerGp: m.gp.power, intellectGp: m.gp.intellect, physiqueGp: m.gp.physique, agilityGp: m.gp.agility, mountTotalGp: m.total, levelMax: m.levelMax, discount: 0 });
  const starOf = (m, tid) => (m.stars || {})[tid] || { star: 0, bless: 0 };
  const soulScore = m => Object.keys(m.owned).reduce((n, tid) => { const t = MOUNTS.get(Number(tid)) || {}; return n + (t.SoulScore || 0) + (t.StarSoulScore || 0) * starOf(m, tid).star; }, 0);
  ctx.mountSoul = p => (p.s.mount ? soulScore(p.s.mount) : 0);   // mountking.js bonus
  const avatarInfo = (m, tid) => ({ mountTempId: Number(tid), isExist: true, activeDate: m.owned[tid], expairDate: '2000-01-01 00:00:00', validity: -1, starLevel: starOf(m, tid).star, param1: soulScore(m), param2: 0, blessing: starOf(m, tid).bless });
  const avatarMsg = m => ({ avatarInfo: Object.keys(m.owned).map(tid => avatarInfo(m, tid)), soulScore: soulScore(m) });
  function sendAll(c) {
    const m = state(c.player);
    if (!m) return c.sendPacket(4427, { raw: Buffer.alloc(0) }, c.clientId);   // not open yet: the empty list the login used to get
    sendT(c, 4426, 'campaign.MountInfoMsg', infoMsg(m));
    sendT(c, 4427, 'campaign.MountAvatarMsg', avatarMsg(m));
  }
  ctx.onLogin.push(c => { state(c.player); });   // compute mount.add before the first PlayerMsg / ArmyMsg
  ctx.onLoad.push(sendAll);   // replaces the recorded empty 4427
  const refreshHero = c => { c.player.save(); sendPlayer(c); sendArmy(c); };
  const needOpen = c => { const m = state(c.player); if (!m) alert(c, `Montaria ${OPEN_LEVEL}. libera no nível`); return m; };

  return {
    C_MOUNT_AVATARLIST(c) { if (needOpen(c)) sendAll(c); },
    C_MOUNT_EDIT(c, body) {
      const msg = dec(c, 'C_MOUNT_EDIT', body), m = needOpen(c); if (!m) return;
      const prop = PROPS[msg.propertyType]; if (!prop) return;
      if (gradeOf(PROP_LV, m.gp[prop]) >= m.levelMax) { alert(c, 'Treino atingiu o limite máximo'); return; }
      const n = Math.max(1, Math.min(msg.param1 || 1, c.player.countTemplate(FOOD)));
      if (!c.player.countTemplate(FOOD) || !pay(c, [[FOOD, n]])) { alert(c, 'Pedras de Monstro insuficientes'); return; }
      m.gp[prop] += n * GP_PER_FOOD;
      compute(c.player, m);
      refreshHero(c);
      sendT(c, 4426, 'campaign.MountInfoMsg', infoMsg(m));
      stat(c, 'mountTrain');
    },
    C_ARMYMOUNT_AVATARCHANGE(c, body) {
      const msg = dec(c, 'C_ARMYMOUNT_AVATARCHANGE', body), m = needOpen(c); if (!m) return;
      m.riding = msg.param1 === 1;
      refreshHero(c);
      sendT(c, 140, 'army.MapUpdatedMsg', { updatedType: 3, army: ctx.M.mapArmy(c.player, 0) });
    },
    C_MOUNT_CHANGE(c, body) {
      const msg = dec(c, 'C_MOUNT_CHANGE', body), m = needOpen(c); if (!m) return;
      if (!m.owned[msg.param1]) { alert(c, 'Esta montaria não está ativa'); return; }
      m.tid = msg.param1; compute(c.player, m);
      refreshHero(c);
      sendAll(c);
    },
    C_MOUNTAVATAR_ACTIVE(c, body) {
      const msg = dec(c, 'C_MOUNTAVATAR_ACTIVE', body), m = needOpen(c); if (!m) return;
      const t = MOUNTS.get(msg.param1);
      if (!t) return;
      if (m.owned[t.TemplateId]) { alert(c, 'Esta montaria já está ativa'); return; }
      if (!t.NeedItemId || !pay(c, [[t.NeedItemId, 1]])) { alert(c, `${ctx.itemName(t.NeedItemId) || 'Item necessário'} necessário`); return; }
      m.owned[t.TemplateId] = fmt();
      c.player.save();
      log(`[#${c.id}] mount ${t.TemplateId} unlocked`);
      sendAll(c);
      alert(c, `${ctx.nameOf(t)} ativado`);
    },
    // Aydınlatma (MountRefiningWnd): a lit mount's own card (StarItem) first, else ceil(Power/5) Canavar Özü
    // (208051; client _costTemplateId); blessing +1 x a crit factor from UpStar_Add_Blessing "1,25|2,64|5,10|10,1"
    // (factor,weight); full blessing (t_s_upgradetemplate 37: 2, 4, 8, 16, 32) = one more star, at most 5.
    // -> 4679 AvatarInfoMsg {starLevel, blessing, param1 = soul score}. Normal mounts (MountType 0) can't be lit.
    C_MOUNT_UPSTAR(c, body) {
      const msg = dec(c, 'C_MOUNT_UPSTAR', body), m = needOpen(c); if (!m) return;
      const t = MOUNTS.get(msg.param1);
      if (!t || !m.owned[t.TemplateId]) { alert(c, 'Esta montaria não está ativa'); return; }
      if (!t.MountType || !t.StarItem) { alert(c, 'Esta montaria não pode ser iluminada'); return; }
      m.stars = m.stars || {};
      const st = m.stars[t.TemplateId] = m.stars[t.TemplateId] || { star: 0, bless: 0 };
      if (st.star >= STAR_LV.length) { alert(c, 'Limite atingido'); return; }
      const essence = Math.ceil((t.Power || 0) / 5) || 1;
      const p = c.player;
      if (p.countTemplate(t.StarItem) >= 1) pay(c, [[t.StarItem, 1]]);
      else if (!pay(c, [[ESSENCE, essence]])) { alert(c, 'Item insuficiente, não é possível iluminar'); return; }
      const total = BLESS.reduce((n, [, w]) => n + w, 0);
      let x = Math.random() * total, mul = 1;
      for (const [f, w] of BLESS) { x -= w; if (x < 0) { mul = f; break; } }
      st.bless += mul;
      if (mul > 1) alert(c, `Kritik! Bereket x${mul}`);
      while (st.star < STAR_LV.length && st.bless >= STAR_LV[st.star].Data) { st.bless -= STAR_LV[st.star].Data; st.star++; alert(c, `${ctx.nameOf(t)} alcançou ${st.star} estrela(s)`); }
      if (st.star >= STAR_LV.length) st.bless = 0;
      compute(p, m);
      refreshHero(c);
      sendT(c, 4679, 'campaign.AvatarInfoMsg', avatarInfo(m, t.TemplateId));
      sendT(c, 4426, 'campaign.MountInfoMsg', infoMsg(m));
    },
    C_MOUNT_INFO_SEND(c, body) {
      const msg = dec(c, 'C_MOUNT_INFO_SEND', body);
      const p = playerById(msg.param1 || c.player.id), m = p && state(p);
      if (!m) return c.sendPacket(4459, { raw: Buffer.alloc(0) }, c.clientId);   // no mount: the official empty answer
      sendT(c, 4459, 'campaign.MountInfoMsg', infoMsg(m));
    },
  };
};
