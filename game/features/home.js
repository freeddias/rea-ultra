// Residência (mapa 5601) + Fogueira (mapa 5602).
// Entrar: CH_HOUSE_REQ / C_HOUSE_BONFIRE_REQ → info (801/810) + enterMap (U_C_CAMPAIGN_CREATE 125).
// O cliente só abre HouseUIWnd / BonFireUIWnd depois de carregar esses mapas
// (wF.checkInHouse(5601) / checkInBoneFire(5602)).
// Desbloqueio no cliente: fazenda ≥ 15 (ar.HOUSE).
const HOUSE_MAP = 5601, BONFIRE_MAP = 5602, HOUSE_TYPE = 50, FARM_UNLOCK = 15;

module.exports = (ctx) => {
  const { dec, sendT, alert, playerById, table, log, cfg } = ctx;
  const HOUSE_UP = table('t_s_upgradetemplate').filter(r => r.Types === HOUSE_TYPE).sort((a, b) => a.Grades - b.Grades);
  // Cliente: getUpgradeInfo() = template Types50 com Grades == houseLv+1.
  // Grades vai até MAX; houseLv nunca pode ser MAX, senão houseLv+1 não existe → crash em TemplateName.
  const MAX_HOUSE_GRADE = HOUSE_UP.length ? Math.max(...HOUSE_UP.map(r => r.Grades)) : 80;
  const MAX_HOUSE = Math.max(1, MAX_HOUSE_GRADE - 1);
  const BASE_WALL = 101001, BASE_FLOOR = 202001; // wall/floor padrão (cliente cita 101002, mas o data pack só tem 101001)
  const expForLevel = target => {
    let exp = 0;
    for (const row of HOUSE_UP) {
      if (row.Grades <= 1) continue;
      if (row.Grades > target) break;
      exp += row.Data || 0;
    }
    return exp;
  };

  function ensureFurniture(h) {
    if (!Array.isArray(h.furniture)) h.furniture = [];
    const has = tid => h.furniture.some(f => f && f.templateId === tid);
    let nextId = h.furniture.reduce((m, f) => Math.max(m, parseInt(f.furnitureId, 10) || 0), 0) + 1;
    if (!has(BASE_WALL)) h.furniture.push({ furnitureId: String(nextId++), templateId: BASE_WALL, posX: 0, posY: 0, rotation: 0 });
    if (!has(BASE_FLOOR)) h.furniture.push({ furnitureId: String(nextId++), templateId: BASE_FLOOR, posX: 0, posY: 0, rotation: 0 });
    return h.furniture;
  }
  function home(p) {
    const h = p.s.home = p.s.home || { level: 1, exp: 0, likes: 0, furniture: [] };
    let dirty = false;
    if ((h.level || 1) > MAX_HOUSE) { h.level = MAX_HOUSE; h.exp = expForLevel(MAX_HOUSE); dirty = true; }
    const before = h.furniture && h.furniture.length;
    ensureFurniture(h);
    if ((h.furniture.length !== before) || dirty) p.save();
    return h;
  }
  // farm grade (same curve as features/farm.js) — used for the unlock tip
  function farmGrade(p) {
    const f = p.s.farm; if (!f) return 1;
    const up = table('t_s_upgradetemplate').filter(r => r.Types === 17).sort((a, b) => a.Grades - b.Grades);
    let lv = 1, left = f.gp || 0;
    for (const row of up) {
      if (row.Grades <= 1) continue;
      if (left < (row.Data || 0)) break;
      left -= row.Data || 0;
      lv = row.Grades;
    }
    return lv;
  }
  const houseMsg = (owner) => {
    const h = home(owner);
    return {
      owner: owner.id, ownerName: owner.s.nickName || '',
      houseLevel: h.level || 1, houseExp: h.exp || 0, totalLike: h.likes || 0,
      furniture: h.furniture || [], furnitureList: [],
    };
  };
  const sendHouse = (c, owner) => sendT(c, 801, 'home.HomeHouseResp', houseMsg(owner));
  const sendBonfire = (c, owner, extra = {}) => {
    const h = home(owner);
    sendT(c, 810, 'home.BonFireCampaignStateMsg', Object.assign({
      state: 0, ownerId: owner.id, houseLv: h.level || 1,
      startTime: 0, endTime: 0, isHold: 0, addExpTotal: 0, todayJoinTimes: 0,
    }, extra));
  };
  // enter the house / bonfire map (client __createCampaignHandler → CAMPAIGN_MAP_SCENE → HouseUIWnd / BonFireUIWnd)
  function enterHomeMap(c, mapId, owner) {
    if (!ctx.enterMap) { alert(c, 'Entrada no mapa indisponível'); return; }
    const p = c.player, roomId = 5600000 + (owner.id % 100000);
    ctx.enterMap(c, mapId, null, 1, {
      room: {
        roomId, masterId: owner.id, name: owner.s.nickName || '',
        count: 1, capacity: mapId === BONFIRE_MAP ? 20 : 1, roomState: 1, roomType: 0,
        masterServerName: (cfg && cfg.SERVER_NAME) || '',
        roomPlayer: [{ playerId: p.id, grades: p.s.grades, nickName: p.s.nickName, job: p.s.job, tarIds: [] }],
      },
    });
    log(`[#${c.id}] home enter map ${mapId} (owner ${owner.id})`);
  }

  // GM / admin: Residência (e portanto a fogueira) no nível máximo
  ctx.gmMaxHouse = c => {
    const h = home(c.player);
    h.level = MAX_HOUSE;
    h.exp = expForLevel(MAX_HOUSE);
    c.player.save();
    sendHouse(c, c.player);
    sendBonfire(c, c.player);
    return `Residência / Fogueira Nv.${h.level}`;
  };

  return {
    CH_HOUSE_REQ(c, body) {
      const m = dec(c, 'CH_HOUSE_REQ', body), p = c.player;
      const op = m.op || 0;
      if (op === 5) {
        sendT(c, 805, 'home.HomeHouseFriendStateResp', { friendIds: {}, likeRecords: {} });
        return;
      }
      // 2 fix-up furniture, 4 admire, 6 buy — acknowledge with current house info for now
      if (op === 2 || op === 4 || op === 6) {
        if (op === 2 && Array.isArray(m.furniture)) {
          const h = home(p);
          h.furniture = m.furniture.map((f, i) => ({
            furnitureId: String(f.furnitureId || (i + 1)), templateId: f.templateId || 0,
            posX: f.posX || 0, posY: f.posY || 0, rotation: f.rotation || 0,
          }));
          ensureFurniture(h);
          p.save();
        }
        sendHouse(c, p);
        return;
      }
      // 1 enter own house, 3 visit friend
      const owner = m.friendId && m.friendId !== p.id ? playerById(m.friendId) : p;
      if (!owner) { alert(c, 'Jogador não encontrado'); return; }
      if (owner === p && farmGrade(p) < FARM_UNLOCK) {
        alert(c, `Fazenda Nv. ${FARM_UNLOCK} necessário`);
        return;
      }
      sendHouse(c, owner);
      enterHomeMap(c, HOUSE_MAP, owner);
    },
    C_HOUSE_BONFIRE_REQ(c, body) {
      const m = dec(c, 'C_HOUSE_BONFIRE_REQ', body), p = c.player;
      const op = m.op || 0;
      if (op === 6) {
        sendT(c, 811, 'home.BonFireFriendsStateResp', { friendsState: {} });
        return;
      }
      if (op === 3 || op === 4) {
        sendT(c, 804, 'home.BonFireInviteResp', { inviteList: [], todayJoinTimes: 0 });
        return;
      }
      if (op === 7) {
        // return from bonfire — client also calls sendReturnCampaignRoom; just refresh state
        sendBonfire(c, p);
        return;
      }
      const owner = m.friendId && m.friendId !== p.id ? playerById(m.friendId) : p;
      if (!owner) { alert(c, 'Jogador não encontrado'); return; }
      if (owner === p && farmGrade(p) < FARM_UNLOCK) {
        alert(c, `Fazenda Nv. ${FARM_UNLOCK} necessário`);
        return;
      }
      // 2 = start party
      if (op === 2) {
        sendBonfire(c, owner, { state: 1, isHold: 1, startTime: Date.now(), endTime: Date.now() + 30 * 60 * 1000 });
        return;
      }
      // 1 = enter bonfire map
      sendBonfire(c, owner);
      enterHomeMap(c, BONFIRE_MAP, owner);
    },
  };
};
