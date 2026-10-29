// Native game server: every reply is computed from the player's state and the game tables.
// The official-server capture (data/official_script.json) is only used for (a) server-wide static data
// (shop, events, switches ...), (b) scripted campaign events (events.js) and (c) recorded battle
// compositions / outcomes (data/knowledge.json, tools/build_knowledge.js).
const fs = require('fs');
const path = require('path');
const db = require('../db');
const cfg = require('../config');
const sites = require('../sites');
const { sysTime } = require('../util');
// Must match PlayerMsg.serverName — client only sets battle selfHero when hero.serverName == player.serviceName.
const playerServerName = p => sites.showNameOf(p && p.s && p.s.site) || cfg.SERVER_NAME;
const codemap = require('../codemap.json');
const { type: protoType } = require('../proto');
const { Rewriter, OFFICIAL_REF, OFFICIAL_TIME } = require('../rewrite');
const { table } = require('../templates');
// wire packet length is a uint16 (packet.js): header 20 + body must stay <= 65535
const PACKET_MAX = 65535, PACKET_HEADER = 20, ITEMS_BODY_MAX = PACKET_MAX - PACKET_HEADER - 64;
let K = { battles: {}, itemUse: {}, nodeIds: {} };
try { K = require('../data/knowledge.json'); } catch (e) { }
// campaign -> its maps in order (t_s_map.Index)
const CAMPAIGN_MAPS = new Map();
for (const m of table('t_s_map')) if (m.CampaignId) { if (!CAMPAIGN_MAPS.has(m.CampaignId)) CAMPAIGN_MAPS.set(m.CampaignId, []); CAMPAIGN_MAPS.get(m.CampaignId).push(m); }
for (const l of CAMPAIGN_MAPS.values()) l.sort((a, b) => a.Index - b.Index);
const MAP_BY_ID = new Map(table('t_s_map').map(m => [m.Id, m]));
const D = require('./data');
const DROPS = require('./drops');
const { Battle, squadHp } = require('./battle');
const FURY = require('./fury');
const M = require('./msg');
const E = require('./events');
const L = require('./locale');
const { Player, isRuneGem, RUNE_BAG_TYPE, bagTypeOf } = require('./player');
const RUNE = require('./rune');
const S = E.OFFICIAL;

// ---- static server data: recorded packets that don't depend on the player ---------------------------
// (index ranges in the official capture; player-specific codes inside them are built natively)
const NATIVE = new Set([4475, 4476, 4463, 4706, 4529, 4721, 508, 807, 828, 4142, 822, 4743, 197, 4428, 4919, 4948, 789, 771, 553, 4556, 4410, 512, 4614, 4615, 4616, 4617, 362, 4145, 4177, 4198, 3, 150, 5, 100, 112, 52, 115, 4153, 4154, 4155, 109, 4130, 4245, 1, 6, 11, 4598, 4234, 301, 4160,
  125, 140, 21, 127, 130, 131, 143, 128, 157, 156, 153, 154, 75, 4103, 4382, 83, 111, 26, 134, 137, 20, 116, 93, 92, 104, 151, 4187, 4242, 102, 4156,
  117, 164, 454, 4133, 4134, 4135, 4137, 4138, 4139, 4140, 4466, 162, 163,   // guild (features/guild.js)
  4379, 4377, 4439, 4440, 4441, 4451, 4457, 4458, 4460, 4462, 4424,   // guild war / GvG (features/guildwar.js)
  515, 516, 517, 518, 519, 520, 521, 528, 530,   // consortia battle icon/board (features/guildwar.js)
  4169, 4176, 4243,   // arena (features/arena.js)
  4373, 4205, 4207, 4419, 4175,   // maze (features/maze.js)
  4180, 4178, 4179, 4479, 4953, 4261,   // astrology (features/star.js)
  537, 536,   // opened systems (logic.js sendSystemsOpen)
  4742,   // rune gem lottery info (features/runegem.js)
  436, 437, 438, 439,   // outer city gold mines (features/mine.js)
  4938,   // field boss list (features/fieldmonster.js)
  4426, 4427, 4459, 4679,   // mount (features/mount.js)
  554,   // Kaynak Geri Al (features/recover.js)
  4884, 4885, 4886, 4887, 4889, 4890, 4891,   // guild scene (features/guildpve.js)
  4150, 4152,   // daily activity (features/leed.js)
  4971, 4868,   // gift packages, account reward (features/giftpack.js)
  533, 544, 4608, 4459, 451,
  4157, 4386, 4387, 146, 147, 4158, 4189, 4146, 4190,   // farm (features/farm.js)
  801, 804, 805, 810, 811,   // home / fogueira (features/home.js)
  12, 13, 15, 16, 17, 24, 25, 28, 32, 120, 121, 4161, 4186, 4370]);   // group scene rooms (features/grouproom.js)   // guide, viewing other players (features/guide.js, viewother.js)
const srv = (a, b) => { const r = []; for (let i = a; i <= b && i < S.length; i++) if (!S[i].client && !NATIVE.has(S[i].code)) r.push(i); return r; };
const STATIC_LOGIN = srv(1, 39);      // after gateway login (+ C_SYNCHRONIZED_TIME burst)
const STATIC_LOAD = srv(49, 86);      // replies to the full C_LONIG_LOAD_REQ batch
const STATIC_QUEST = srv(119, 192);   // replies to C_LONIG_LOAD_REQ {user} / {quest, shop, ...} and the login pushes after them
// any other request: what the official server answered to its n-th occurrence (n counted per connection,
// the last recorded one repeats) — packets named like the request (C_X -> U_C_X) within 1.5 s, plus the
// immediate reply run (before the next request, within 400 ms). Replaying by occurrence keeps request/
// reply chains intact (e.g. C_SUMACTIVE_GATE: templates first, then the data).
const USED = new Set([...STATIC_LOGIN, ...STATIC_LOAD, ...STATIC_QUEST]);
const S2C_CODE = require('../codes.json').s2c;
const S2C_NAME = Object.fromEntries(Object.entries(require('../codes.json').s2c).map(([k, v]) => [v, k]));
const C2S_NAME = Object.fromEntries(Object.entries(require('../codes.json').c2s).map(([k, v]) => [v, k]));
const stem = n => String(n || '').replace(/^(U_)?(C_|CH_|B_|G_)?/, '');
const REPLY = new Map();   // client code -> [ [server step index] per occurrence ]
for (let i = 0; i < S.length; i++) {
  if (!S[i].client) continue;
  const runs = REPLY.get(S[i].code) || [];
  if (runs.length >= 3) continue;   // later occurrences are usually purchases with other payloads
  const ok = j => !NATIVE.has(S[j].code) && !E.SCRIPTED.has(S[j].code) && !USED.has(j);
  const r = new Set(), want = stem(C2S_NAME[S[i].code]);
  for (let j = i + 1; j < S.length && !S[j].client && S[j].t - S[i].t < 400; j++) if (ok(j)) r.add(j);
  for (let j = i + 1; j < S.length && S[j].t - S[i].t < 1500; j++) if (!S[j].client && ok(j) && stem(S2C_NAME[S[j].code]) === want) r.add(j);
  runs.push([...r].sort((a, b) => a - b));
  REPLY.set(S[i].code, runs);
}
for (const [k, runs] of REPLY) if (!runs.some(r => r.length)) REPLY.delete(k);
// recorded per-campaign data: system army preview (U_C_CAMPAIGN_SYSTEM_ARMY), end report, reward card
const SYSARMY = new Map(), REPORT = new Map(), CARD = new Map();
{
  let camp = 0;
  for (let i = 0; i < S.length; i++) {
    const s = S[i];
    if (s.client && s.code === 5039 && s.obj) camp = s.obj.paraInt2;
    if (s.client && s.code === 5038 && s.obj) for (let j = i + 1; j < S.length && j < i + 12; j++) if (!S[j].client && S[j].code === 20 && S[j].obj) { SYSARMY.set(s.obj.paraInt1, S[j].obj); break; }
    if (!s.client && s.code === 137 && s.raw && camp) REPORT.set(camp, s.raw);
    if (!s.client && s.code === 26 && s.obj && camp && !CARD.has(camp)) CARD.set(camp, s.obj);
  }
}
const TUTORIAL_CAMPAIGN = 10001;

// fashion: wing 109→8, hat 110→9, clothes 112→10, weapon 111→11 (client Ket.POS_*_FASHION)
const EQUIP_POS = { 101: [0], 103: [1], 104: [2], 106: [3], 107: [4, 5], 108: [6, 7], 109: [8], 110: [9], 112: [10], 111: [11], 117: [12], 118: [13], 1301: [14], 1302: [14] };   // 117/118 heraldry+relic; 1301/1302 medals (features/medal.js)
const ITEM_HERO_BAG = 4;
const FORGE_BAG = 0;
const USER_STORAGE = 7;   // personal storage (client hr.userStorage)
const dec = (c, name, body) => c.decode(codemap.c2s[name].type, body);
const nameOf = L.nameOf;
const itemName = tid => L.itemName(D, tid);
const pawnName = tid => nameOf(D.pawns.get(tid), 'PawnName');

const FEATURES = path.join(__dirname, 'features');

module.exports = (log) => {
  const players = new Map();          // id -> Player (cached)
  const online = new Map();           // player id -> gateway connection
  function playerFor(a) {
    let p = players.get(a.userId) || Player.load(a.userId);
    if (!p) p = Player.create(a);
    if (a.site && p.s.site !== a.site) { p.s.site = a.site; p.save(); }
    players.set(a.userId, p);
    return p;
  }

  // ---- send helpers ----------------------------------------------------------------------------------
  function rw(c) {
    const p = c.player, s = p.s;
    if (!c.rw) c.rw = new Rewriter({ playerId: p.id, nickName: s.nickName, sex: s.sex, icon: s.icon, job: s.job, camp: s.camp, serverName: require('../sites').showNameOf(s.site) || cfg.SERVER_NAME },
      s.created - OFFICIAL_TIME.getTime(), OFFICIAL_REF);
    return c.rw;
  }
  function sendStatic(c, idx) {
    for (const i of idx) {
      const st = S[i];
      const pk = rw(c).packet(st);
      if (pk) c.sendPacket(st.code, pk, c.clientId, st.extend1, st.extend2);
    }
  }
  const sendT = (c, code, type, obj) => c.sendPacket(code, { type, obj }, c.clientId);
  const sendRaw = (c, code, hex = '') => c.sendPacket(code, { raw: Buffer.from(hex, 'hex') }, c.clientId);
  function sendPlayer(c) { sendT(c, 3, 'player.PlayerMsg', M.playerMsg(c.player)); }
  // the official server always follows U_C_SERIAL_ARMY with an empty code 5
  function sendArmy(c, state = 0) { sendT(c, 150, 'army.ArmyMsg', M.armyMsg(c.player, state)); sendRaw(c, 5); }
  function sendReserve(c, sons) { if (Object.keys(c.player.s.pawns).length) sendT(c, 100, 'army.ArmyPawnUpdatedMsg', M.reservePawns(c.player, sons)); }
  function sendQuests(c, ids) { sendT(c, 112, 'quest.QuestUpdatedRspMsg', M.questUpdate(c.player, ids || Object.keys(c.player.s.quests.active).map(Number))); }
  // a full bag (~470 cells) encodes past the uint16 packet length; split into several 115s so login /
  // tidy / sell stay under the wire limit (capture errors: C_LONIG_LOAD_REQ / C_BAG_ARRANGE at ~66–68 KB)
  function sendItems(c, entries) {
    if (!entries.length) return;
    const T = protoType('item.ItemMovedListMsg');
    const bytes = list => Buffer.from(T.encode({ moved: list }).finish()).length;
    let i = 0;
    while (i < entries.length) {
      let lo = 1, hi = entries.length - i;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (bytes(entries.slice(i, i + mid)) <= ITEMS_BODY_MAX) lo = mid; else hi = mid - 1;
      }
      const n = Math.max(1, lo);
      sendT(c, 115, 'item.ItemMovedListMsg', { moved: entries.slice(i, i + n) });
      i += n;
    }
  }
  // bag (1) and personal storage (7, client hr.userStorage; Player_WarehouseCount cells): a move onto an
  // item of the same stackable template merges, otherwise the two swap. endPos < 0: the first stack with
  // room, else the first free cell. Returns false when the target has no room.
  const cellsOf = (p, bt) => bt === USER_STORAGE ? (CONF.get('Player_WarehouseCount') || 200) : p.sizeOf(bt);
  function freeIn(p, bt) {
    const used = new Set(p.s.bag.filter(i => (i.bagType ?? 1) === bt).map(i => i.pos));
    for (let i = 0; i < cellsOf(p, bt); i++) if (!used.has(i)) return i;
    return -1;
  }
  function storeMove(c, from, bpos, to, epos, send = true) {
    const p = c.player, a = p.itemAt(bpos, from); if (!a) return false;
    const max = (D.items.get(a.templateId) || {}).MaxCount || 1;
    if (epos < 0 || epos === undefined) {
      const st = max > 1 && p.s.bag.find(i => i !== a && (i.bagType ?? 1) === to && i.templateId === a.templateId && i.count < max);
      epos = st ? st.pos : freeIn(p, to);
    }
    if (epos < 0 || epos >= cellsOf(p, to) || (from === to && bpos === epos)) return false;
    const b = p.itemAt(epos, to), entries = [];
    if (b && b.templateId === a.templateId && max > 1 && b.count < max) {
      const k = Math.min(max - b.count, a.count);
      b.count += k; p.removeItem(a, k);
      entries.push(M.movedEntry(p, b), a.count > 0 ? M.movedEntry(p, a) : { changeType: from, changeObjId: 0, changePos: bpos });
    } else {
      if (b) { b.bagType = from; b.pos = bpos; }
      a.bagType = to; a.pos = epos;
      entries.push(M.movedEntry(p, a), b ? M.movedEntry(p, b) : { changeType: from, changeObjId: 0, changePos: bpos });
    }
    if (send) { sendItems(c, entries); p.save(); }
    return entries;
  }
  // castle gold accrues continuously at goldYield per hour (capture: 15000/h -> +17 in 3.7 s) and stops at the
  // warehouse cap; settled lazily whenever the castle is reported (the client polls U_C_CASTLE_UPDATE), also
  // for the time offline. Nothing is produced before the castle exists (tutorial).
  function produceGold(p, now = Date.now()) {
    if (!p.s.buildings.length) { p.s.goldTick = now; return; }
    if (!p.s.goldTick) { p.s.goldTick = now; return; }
    const max = M.goldMax(p), dt = Math.max(0, now - p.s.goldTick) / 3600000;
    if (p.s.gold < max) p.s.gold = Math.min(max, p.s.gold + M.goldYield(p) * dt);
    p.s.goldTick = now;
  }
  function sendCastle(c) { produceGold(c.player); sendT(c, 109, 'castle.CastleYieldMsg', M.castleYield(c.player)); }
  function sendBuildings(c) { sendT(c, 4130, 'building.BuildingInfoListMsg', M.buildingList(c.player)); }
  function chat(c, text) { sendT(c, 83, 'chat.ChatChannelMsg', { channel: 3, encodeMsg: text, curTime: Date.now() }); }
  function alert(c, text) { sendT(c, 111, 'chat.ChatChannelMsg', { channel: 7, encodeMsg: text }); }

  // ---- progression -------------------------------------------------------------------------------------
  function giveExp(c, n) {
    const p = c.player, before = p.s.grades;
    const ups = p.addExp(n);
    chat(c, `${n.toLocaleString('en-US')} EXP obtido`);
    for (const fn of ctx.onExp) fn(c, n);   // e.g. the pet in war gets the same EXP (features/pets.js)
    if (ups) {
      log(`[#${c.id}] level up ${before} -> ${p.s.grades}`);
      grantLevelBoxes(c);
      checkSystemsOpen(c);
    }
    return ups;
  }
  // opened systems (main-bar icons, windows): t_s_systemopen rows whose ShowGrades the player reached (and
  // QuestId done, guards only). Capture: 537 SystemOpenHashOpenList at gateway login, then 536 per new system
  // at the level-up (Lv5: 101 Çanta, 10101, 10102, 1010101; Lv6: 129 Expedição, 135, 136 ...). The recorded 537 was
  // the new official character's [163, 183, 155]: every later login lost the bag icon and the rest.
  const SYSOPEN = table('t_s_systemopen');
  // Guard (158) / Guard Recruitment (160) are the only rows with QuestId; on a private server the
  // matching quests are often never started, so level alone unlocks them (client still needs 537).
  // The client's bottom-bar icon ALSO checks IsTaskFinish(964) (and 963 for recruitment), so the
  // questSite bit must be set or the Guarda button vanishes even with 158 in the open list.
  const GUARD_UNLOCK_QUESTS = [963, 964, 965];
  function ensureGuardUnlock(p) {
    if ((p.s.grades || 1) < 70) return false;
    p.s.quests = p.s.quests || { active: {}, done: [] };
    let changed = false;
    for (const id of GUARD_UNLOCK_QUESTS) {
      if (p.s.quests.done.includes(id)) continue;
      delete p.s.quests.active[id];
      p.s.quests.done.push(id);
      changed = true;
    }
    return changed;
  }
  const openSystems = p => SYSOPEN.filter(r => p.s.grades >= (r.ShowGrades || r.Grades || 1) &&
    (!r.QuestId || r.SystemID === 158 || r.SystemID === 160 || p.s.quests.done.includes(Number(r.QuestId)))).map(r => r.SystemID);
  function sendSystemsOpen(c) {
    if (ensureGuardUnlock(c.player)) { c.player.save(); sendPlayer(c); sendQuests(c, []); }
    const list = openSystems(c.player);
    c.player.s.sysOpen = list;
    sendT(c, 537, 'systemopen.SystemOpenHashOpenList', { sysId: list });
  }
  function checkSystemsOpen(c) {
    if (ensureGuardUnlock(c.player)) { c.player.save(); sendPlayer(c); sendQuests(c, []); }
    const p = c.player, had = new Set(p.s.sysOpen || []);
    for (const id of openSystems(p)) if (!had.has(id)) { had.add(id); sendT(c, 536, 'systemopen.SystemOpenNewOpenSys', { sysId: id }); }
    p.s.sysOpen = [...had];
  }
  // rewards: [[templateId, count], ...]; negative ids are currencies (client constants TEMP_ID_*)
  // the client's fields are int32: more than this arrives negative ("Diamante insuficiente" with 4 billion)
  const MONEY_MAX = 2147483647;
  const CURRENCY = { [-100]: 'gold', [-400]: 'point', [-500]: 'giftToken', [-600]: 'crystals' };
  const CURRENCY_NAME = { [-100]: 'Ouro', [-400]: 'Diamante', [-500]: 'Diamante Vinculado', [-600]: 'Cristal', [-700]: 'EXP', [-5500]: 'EXP VIP' };
  const rewardName = tid => CURRENCY_NAME[tid] || itemName(tid) || String(tid);
  // returns false (nothing granted) when the bag can't hold the items
  function grant(c, rewards, { quiet = false } = {}) {
    const p = c.player, entries = [], texts = [];
    const items = rewards.filter(([tid]) => tid > 0 && D.items.has(tid));
    // room per bag: rune gems go to the rune bag (player.js addItem)
    for (const bt of [1, RUNE_BAG_TYPE, 27]) {   // 27: pet equipment
      const slots = items.filter(([tid]) => bagTypeOf(D.items.get(tid)) === bt).reduce((n, [tid, cnt]) => n + Math.ceil(cnt / ((D.items.get(tid) || {}).MaxCount || 1)), 0);
      if (slots && p.s.bag.filter(i => (i.bagType ?? 1) === bt).length + slots > p.sizeOf(bt)) return false;
    }
    let exp = 0, money = false;
    for (const [tid, cnt] of rewards) {
      if (!cnt) continue;
      if (CURRENCY[tid]) { p.s[CURRENCY[tid]] = Math.min(MONEY_MAX, (p.s[CURRENCY[tid]] || 0) + cnt); money = true; }
      else if (tid === -700) exp += cnt;
      else if (tid < 0) { (p.s.currency = p.s.currency || {})[tid] = ((p.s.currency || {})[tid] || 0) + cnt; }
      else if (D.items.has(tid)) for (const it of p.addItem(tid, cnt)) entries.push(M.movedEntry(p, it));
      else { log(`[#${c.id}] grant: unknown template ${tid}`); continue; }
      texts.push(`${rewardName(tid)} x${cnt}`);
    }
    sendItems(c, entries);
    if (exp) giveExp(c, exp);
    if (money) sendCastle(c);
    sendPlayer(c);
    p.save();
    // official wording: "Obtido:Lv. 3 Şans Taşı x1 Lv. 2 Büyülü Cristal x1"
    if (!quiet && texts.length) alert(c, `Obtido:${texts.join(' ')}`);
    if (rewards.some(([tid]) => tid === -5500) && ctx.vipRefresh) ctx.vipRefresh(c);   // VIP EXP (features/vip.js)
    return true;
  }

  // weary ("Beden" / energia): t_s_config Player_weary 200 (natural max the fill dialog tops up to),
  // Weary_Limit 5000 (lifetime potion quota tracked as PlayerMsg.wearyLimit; potions may push weary itself
  // past 200 up to that same cap). Client BatchUseWnd: count = min(bag, max(1, floor(min(WEARY_MAX-weary,
  // WEARY_GET_MAX-wearyLimit) / Property2))). Daily refill restores weary to at least Player_weary.
  const CONF = new Map(table('t_s_config').map(r => [r.ConfigName, Number(r.ConfigValue)]));
  // CONF.get is numeric ("1,2" -> NaN); CONF.str gives the raw text for list / reward settings
  const CONF_RAW = new Map(table('t_s_config').map(r => [r.ConfigName, r.ConfigValue == null ? '' : String(r.ConfigValue)]));
  CONF.str = k => CONF_RAW.get(k);
  const WEARY_MAX = CONF.get('Player_weary') || 200, WEARY_LIMIT = CONF.get('Weary_Limit') || 5000, CAMPAIGN_WEARY = CONF.get('SingleCampaign_Weary') || 20;
  function refillWeary(p) {
    const day = sysTime().slice(0, 10);
    if (p.s.wearyDay !== day) { p.s.wearyDay = day; p.s.weary = Math.max(p.s.weary || 0, WEARY_MAX); }
  }
  function spendWeary(c, n) {
    const p = c.player; refillWeary(p);
    if (p.s.weary < n) { alert(c, 'Energia insuficiente'); return false; }
    p.s.weary -= n; p.save(); sendPlayer(c);
    stat(c, 'weary', n);
    return true;
  }
  // potion use (Property1 5): raise weary and the potion quota (wearyLimit) together, Wartune-style
  function addWeary(p, amount) {
    refillWeary(p);
    const got = p.s.wearyLimit || 0, room = Math.max(0, WEARY_LIMIT - got);
    const add = Math.min(Math.max(0, amount | 0), room);
    if (!add) return 0;
    p.s.wearyLimit = got + add;
    p.s.weary = Math.min(WEARY_LIMIT, (p.s.weary || 0) + add);
    return add;
  }
  // lifetime counters (s.stats) for goals that count actions: recruited, strengthen, ...; listeners re-evaluate
  const statHooks = [];
  function stat(c, key, n = 1) {
    const s = c.player.s.stats = c.player.s.stats || {};
    s[key] = (s[key] || 0) + n;
    for (const fn of statHooks) fn(c, key, n);
    const qc = STAT_QUEST[key];
    if (qc) bump(c, qc[0], qc[1], n, qc[2]);
  }
  // costs: [[templateId, count], ...] (same ids as grant). All or nothing; returns false if anything is short.
  const balance = (p, tid) => CURRENCY[tid] ? (p.s[CURRENCY[tid]] || 0) : tid < 0 ? ((p.s.currency || {})[tid] || 0) : p.countTemplate(tid);
  function pay(c, costs) {
    const p = c.player, need = new Map();
    for (const [tid, n] of costs) if (n > 0) need.set(tid, (need.get(tid) || 0) + n);
    for (const [tid, n] of need) if (balance(p, tid) < n) return false;
    const entries = [];
    for (const [tid, n] of need) {
      if (CURRENCY[tid]) p.s[CURRENCY[tid]] -= n;
      else if (tid < 0) p.s.currency[tid] -= n;
      else { for (const it of p.takeTemplate(tid, n)) entries.push(M.movedEntry(p, it, it.count <= 0)); for (const fn of statHooks) fn(c, `use:${tid}`, n); }   // items used, told to listeners only (Etkinlikler 516), not kept in s.stats
    }
    sendItems(c, entries);
    if ([...need.keys()].some(t => CURRENCY[t])) { sendCastle(c); sendPlayer(c); }
    p.save();
    if (need.has(-400) || need.has(-500)) stat(c, 'spendPoint');   // daily activity "Gastar Diamantes"
    return true;
  }

  // newbie packages appear at their level
  function grantLevelBoxes(c) {
    const p = c.player;
    const tid = Number(`206${String(p.s.job).padStart(2, '0')}01`);
    // only the Lv5 package is granted directly; later ones come out of the previous package
    if (p.s.grades >= 5 && !(p.s.boxesGiven || []).includes(tid) && D.items.has(tid)) {
      (p.s.boxesGiven = p.s.boxesGiven || []).push(tid);
      sendItems(c, p.addItem(tid).map(it => M.movedEntry(p, it)));
      alert(c, `Obtido:${itemName(tid)} x1`);
    }
  }

  // ---- quests ------------------------------------------------------------------------------------------
  // condition types (t_s_questcondiction.CondictionType) that are evaluated from the player's state;
  // all others are counters advanced by events (bump)
  const pawnGrade = (p, son) => { const r = p.s.pawns[son]; return r ? ((D.pawns.get(r.tempId) || {}).Level || 1) : 0; };
  const STATE_COND = {
    1: (p, cd) => p.s.grades,                                                                   // reach level Para2
    2: (p, cd) => { const b = p.s.buildings.find(b => b.sonType === Number(cd.Para1)); return b ? b.grade : 0; },   // building grade
    // "Better equipment": wear an item of NeedGrades >= Para1 (capture: quest 944 completes on equipping a Lv10 staff)
    4: (p, cd) => Object.values(p.s.equip).some(i => ((D.items.get(i.templateId) || {}).NeedGrades || 0) >= Number(cd.Para1)) ? 1 : 0,
    10: (p, cd) => pawnGrade(p, 100 + Number(cd.Para1)),                                        // troop type level
    14: (p, cd) => p.s.cleared.includes(Number(cd.Para1)) ? 1 : 0,                               // campaign cleared
    17: (p, cd) => [...p.s.bag, ...Object.values(p.s.equip)].some(i => (i.strengthenGrade || 0) >= Number(cd.Para1)) ? 1 : 0,   // any equipment strengthened to +Para1
    23: (p, cd) => Math.max(p.s.noviceProcess, p.s.newNoviceProcess || 0) >= Number(cd.Para1) ? 1 : 0,   // tutorial step reached
    21: (p) => Object.values(p.s.relations || {}).filter(r => r.relation === 1).length,        // "Adicionar Amigo": friends
    22: (p) => p.s.guild && require('./guilds').get(p.s.guild.id) ? 1 : 0,                      // "Criar ou Entrar na Guilda"
    51: (p, cd) => { const g = p.s.guild && require('./guilds').get(p.s.guild.id); return g ? g.levels[Number(cd.Para1)] || 0 : 0; },   // guild building (Para1 1 guild, 2 shop) level
  };
  const questTarget = cd => [4, 14, 17, 22, 23].includes(cd.CondictionType) ? 1 : (Number(cd.Para2) || 1);
  // feature events (stat keys) that are quest counters: [condition type, key, Para1 must equal the key]
  // 54 "Ödüllü Görev Tamamla", 36 "Astrologia" (Para1 1), 60 farm (Para1 0 own harvest, 1 a friend's farm),
  // 53 "Bloquear Estrela da Sorte", 38 "Atacar Catacumbas" (Para1 8001), 46 "Desmontar Equipamento", 71 "Treinar Montaria"
  const STAT_QUEST = { bounty: [54, 0], astrology: [36, 1], farmHarvest: [60, 0, true], farmHelp: [60, 1, true], starLock: [53, 0], mazeFight: [38, 8001], resolve: [46, 0], mountTrain: [71, 0] };
  function questConditions(p, id) {
    const q = p.s.quests.active[id];
    return (D.questConds.get(id) || []).map((cd, i) => STATE_COND[cd.CondictionType] ? STATE_COND[cd.CondictionType](p, cd) : ((q && q.c[i]) || 0));
  }
  // event counter: every active quest condition of this type whose Para1 list contains key (or is 0/empty)
  function bump(c, type, key, n = 1, exact = false) {
    const p = c.player; let hit = false;
    for (const [id, q] of Object.entries(p.s.quests.active)) {
      (D.questConds.get(Number(id)) || []).forEach((cd, i) => {
        if (cd.CondictionType !== type) return;
        const keys = String(cd.Para1 ?? '').split(',').map(Number).filter(Boolean);
        if (exact ? Number(cd.Para1 || 0) !== key : (keys.length && !keys.includes(key))) return;
        q.c[i] = Math.min(questTarget(cd), (q.c[i] || 0) + n); hit = true;
      });
    }
    if (hit) { p.save(); refreshQuests(c); }
  }
  // auto quests whose prerequisites are done (PreQuestId) and level fits are accepted by the server, so a
  // missed client-side accept (e.g. after a reconnect mid-tutorial) can't stall the quest chain
  function autoAccept(c) {
    const p = c.player, added = [];
    for (const q of D.quests.values()) {
      if (q.IsAuto !== 1 || q.IsRepeat || q.TemplateType !== 0) continue;
      const id = q.TemplateId;
      if (p.s.quests.active[id] || p.s.quests.done.includes(id)) continue;
      const pre = String(q.PreQuestId || '').split(',').map(Number).filter(Boolean);
      if (!pre.length || !pre.every(x => p.s.quests.done.includes(x))) continue;
      if (p.s.grades < (q.NeedMinLevel || 1) || p.s.grades > (q.NeedMaxLevel || 999)) continue;
      p.s.quests.active[id] = { c: [0, 0, 0, 0], complete: false, addDate: sysTime() }; added.push(id);
    }
    if (added.length) { p.save(); log(`[#${c.id}] auto-accepted quests ${added}`); sendQuests(c); refreshQuests(c); }
  }
  function refreshQuests(c, only) {
    const p = c.player, changed = [];
    for (const [id, q] of Object.entries(p.s.quests.active)) {
      if (only && !only.includes(Number(id))) continue;
      const conds = D.questConds.get(Number(id)) || [];
      const vals = questConditions(p, Number(id));
      const complete = conds.every((cd, i) => vals[i] >= questTarget(cd));
      if (complete !== q.complete || JSON.stringify(vals) !== JSON.stringify(q.c)) { q.c = vals; q.complete = complete; changed.push(Number(id)); }
    }
    if (changed.length) { p.save(); sendQuests(c, changed); }
  }
  // GM: one-shot quests the player can take right now are finished the same way as U_C_QUEST_FINISH.
  // Availability matches the client (isAvailableTask): level window, start/end date, guild-only quests,
  // and the prerequisite chain — finishing one unlocks the next only when that next one is also in reach.
  // Quests above the current level, expired templates and repeatable dailies stay open.
  function questStamp(s) {
    const t = Date.parse(String(s || '').trim().replace(' ', 'T'));
    return Number.isFinite(t) ? t : NaN;
  }
  function questOffered(p, t, done) {
    if (Number(t.IsRepeat)) return false;
    const id = Number(t.TemplateId);
    if (done.has(id)) return false;
    if (p.s.quests.active[id]) return true;
    const now = Date.now();
    const start = questStamp(t.StartDate), end = questStamp(t.EndDate);
    if (Number.isFinite(start) && now < start) return false;
    if (Number.isFinite(end) && now > end) return false;
    const lv = p.s.grades || 1;
    if (lv < (Number(t.NeedMinLevel) || 0)) return false;
    const max = Number(t.NeedMaxLevel);
    if (Number.isFinite(max) && lv > max) return false;
    if (Number(t.IsLeague) && !(p.s.guild && p.s.guild.id)) return false;
    const pre = String(t.PreQuestId || '').split(',').map(Number).filter(Boolean);
    return pre.every(x => done.has(x));
  }
  function grantQuestItem(p, tid, count, entries) {
    if (!count || !D.items.has(tid)) return count || 0;
    const before = new Map();
    for (const it of p.s.bag) if (it.templateId === tid) before.set(it.id, it.count);
    const got = p.addItem(tid, count);
    let added = 0;
    for (const it of got) { added += it.count - (before.get(it.id) || 0); entries.push(M.movedEntry(p, it)); }
    return Math.max(0, count - added);
  }
  function completeAllQuests(c) {
    const p = c.player;
    p.s.quests = p.s.quests || { active: {}, done: [] };
    const done = new Set(p.s.quests.done.map(Number));
    const finishing = new Set(done);
    const pick = [];
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of D.quests.values()) {
        if (!questOffered(p, t, finishing)) continue;
        finishing.add(Number(t.TemplateId));
        pick.push(t);
        grew = true;
      }
    }
    const wasActive = [];
    const entries = [];
    let gold = 0, xp = 0, n = 0, missed = 0;
    for (const t of pick) {
      const id = t.TemplateId;
      if (p.s.quests.active[id]) { wasActive.push(id); delete p.s.quests.active[id]; }
      p.s.quests.done.push(id); done.add(id); n++;
      for (const g of D.questGoods.get(id) || []) {
        if (Number(g.ToJob) && Number(g.ToJob) !== p.s.job) continue;
        missed += grantQuestItem(p, g.RewardItemID, g.RewardItemCount || 0, entries);
      }
      if (t.RewardGold) gold += Number(t.RewardGold) || 0;
      if (t.RewardPlayGP) xp += Number(t.RewardPlayGP) || 0;
    }
    if (!n) return { n: 0, gold: 0, xp: 0, items: 0, missed: 0 };
    const goldBefore = p.s.gold || 0;
    if (gold) p.s.gold = Math.min(MONEY_MAX, goldBefore + gold);
    const goldGot = Math.floor((p.s.gold || 0) - goldBefore);
    p.save();
    if (goldGot) sendCastle(c);
    sendItems(c, entries);
    if (xp) giveExp(c, xp);
    sendPlayer(c); sendArmy(c);
    sendQuests(c);
    for (const id of wasActive) sendT(c, 52, 'quest.QuestFinishedRspMsg', { templateId: id });
    for (const id of Object.keys(QUEST_BUILDINGS).map(Number)) if (done.has(id)) questBuildings(c, id);
    ensureOrders(c);
    checkSystemsOpen(c);
    autoAccept(c);
    p.save();
    return { n, gold: goldGot, xp, items: entries.length, missed };
  }

  // ---- campaign --------------------------------------------------------------------------------------
  // node instance ids as the real server assigned them in the capture (scripted events refer to them);
  // nodes never seen there get a stable synthetic id
  const REC_NODE = new Map(), REC_NODE_REV = new Map();
  for (const st of S) if (!st.client && st.code === 127 && st.obj) for (const n of st.obj.node || []) { REC_NODE.set(n.campDataId, n.nodeId); REC_NODE_REV.set(n.nodeId, n.campDataId); }
  for (const [cdId, nid] of Object.entries(K.nodeIds || {})) { const id = Number(cdId); if (!REC_NODE.has(id)) { REC_NODE.set(id, nid); REC_NODE_REV.set(nid, id); } }
  function nodeInstanceId(cd) { return REC_NODE.get(cd.Id) || (cd.Id % 1000000 + 20000); }
  // nodes whose clearing ended a campaign on the official server (the last 128 state-8 before 134 / 137)
  // treasure boxes' loot: t_s_dropcondition type 22, Para2 = the box nodes (campDataId) -> DropId
  const BOX_DROP = new Map();
  for (const r of DROPS.condition(22)) for (const id of [].concat(r.Para2)) BOX_DROP.set(id, r.DropId);
  const FINAL_NODES = new Set();
  for (let i = 0; i < S.length; i++) {
    if (S[i].client || (S[i].code !== 134 && S[i].code !== 137)) continue;
    for (let j = i - 1; j > 0 && j > i - 400; j--) {
      const s = S[j];
      if (!s.client && s.code === 128 && s.obj && s.obj.nodeState === 8 && s.obj.sonType) { const id = REC_NODE_REV.get(s.obj.nodeId); if (id) FINAL_NODES.add(id); break; }
    }
  }
  const campaignOf = mapId => (MAP_BY_ID.get(mapId) || {}).CampaignId || mapId;
  // a node's state on this character's map: what we sent last, else what the official server's map
  // scripts made of it (start state, and the changes a won fight caused — so characters stuck from before
  // get them too), else the table
  function derivedStates(st) {
    const out = {};
    for (const [id, state] of Object.entries(st.nodes || {})) {
      if (state !== 8) continue;
      const cd = D.campNodes.get(Number(id)); if (!cd) continue;
      for (const ev of E.afterWin(st.campaignId, nodeInstanceId(cd)) || []) { const nid = REC_NODE_REV.get(ev.obj.nodeId); if (nid) out[nid] = ev.obj.nodeState; }
    }
    return out;
  }
  function stateOf(p, cd) {
    const st = p.s.campaign; if (!st) return cd.NodeState ?? 1;
    if (st.nodes[cd.Id] !== undefined) return st.nodes[cd.Id];
    const d = derivedStates(st)[cd.Id];
    return d ?? E.initState(st.campaignId, cd.Id) ?? cd.NodeState ?? 1;
  }
  function campaignNodes(p) {
    const st = p.s.campaign;
    return (D.campNodesByCampaign.get(st.campaignId) || []).map(cd => ({
      nodeId: nodeInstanceId(cd), campDataId: cd.Id, nodeName: nameOf(cd, 'NodeName'), masterType: cd.MasterType, sonType: cd.SonType,
      preNodeIds: String(cd.PreNodeIds || '0'), nextNodeIds: String(cd.NextNodeIds || ''), state: stateOf(p, cd),
      refreshSpeed: cd.RefreshSpeed || 1, posX: cd.Property1, posY: cd.Property2, curX: cd.Property1, curY: cd.Property2,
      level: cd.Level || 0, styleType: cd.StyleType || 0, attackTypes: cd.AttackTypes || 0, nameColor: cd.NameColor || 0,
      sizeType: cd.SizeType || 0, toward: cd.Toward || 0, resource: cd.Resource || 1, resetX: cd.Property3 || 0, resetY: cd.Property4 || 0,
      fixX: cd.FixX, fixY: cd.FixY, heroTempId: cd.Heros ? Number(String(cd.Heros).split(',')[0]) : -1, handlerRange: cd.HandlerRange || 0,
      fightCapaity: 0, param1: cd.Param1 || 0, param2: cd.Param2 || 0, param3: cd.Param3 || '', param4: cd.Param4 || '', param5: cd.Param5 || '',
    }));
  }
  function enterCampaign(c, mapId, pos, createdType = 1, opts = {}) {
    const p = c.player;
    const prev = p.s.campaign;
    p.s.campaign = (prev && prev.campaignId === mapId) ? prev : { campaignId: mapId, nodes: {}, triggers: {}, posX: 0, posY: 0 };
    const st = p.s.campaign;
    // new map → reset battle bars; same map revisit keeps them
    if (!prev || prev.campaignId !== mapId) { delete st.battleSp; delete st.battleAwaken; }
    if (pos) { st.posX = pos[0]; st.posY = pos[1]; }
    if (!st.posX) {   // spawn: BornPoints or the first node
      const first = (D.campNodesByCampaign.get(mapId) || [])[0];
      const born = String((MAP_BY_ID.get(mapId) || D.campaigns.get(mapId) || {}).BornPoints || '').split('|')[0].split(',').map(Number);
      st.posX = born[0] || (first ? first.Property1 : 20); st.posY = born[1] || (first ? first.Property2 : 20);
    }
    p.save();
    // opts.room merges into RoomMsg (house/bonfire need masterId / roomId / name for the client UI)
    sendT(c, 125, 'room.RoomCreatedMsg', {
      createdType, isCross: !!opts.isCross,
      room: Object.assign({ campaignId: mapId }, opts.room || {}),
    });
    sendT(c, 140, 'army.MapUpdatedMsg', { updatedType: 3, army: M.mapArmy(p, 0) });
    const enter = M.clone(M.REF[21]);
    Object.assign(enter.player[0], {
      heroId: p.heroId, playerId: p.id, grades: p.s.grades, nickName: p.s.nickName, templateId: p.s.icon, armyId: p.armyId,
      fightingCapacity: p.fightingCapacity(), curPosX: st.posX, curPosY: st.posY, campaignId: mapId, serverName: playerServerName(p),
      teamId: opts.teamId || 0, playerState: opts.playerState != null ? opts.playerState : (enter.player[0].playerState || 0),
    }, (() => { const a = M.mapArmy(p); return { arm: a.arm, cloth: a.cloth }; })());
    sendT(c, 21, 'room.RoomEnterMsg', enter);
    for (const fn of ctx.onEnterMap) fn(c, mapId, st);   // features may set node states first (e.g. the dragon nest floors)
    sendT(c, 127, 'campaign.CampaignNodeListMsg', { node: campaignNodes(p) });
    sendT(c, 130, 'campaign.CampaignFogMsg', fogMsg(p, mapId));
  }
  // fog of war per map, kept across visits: grid ceil(Width/110) columns (client TU.fogViewUnitWidth) x
  // ceil(Height/84) rows (inferred: the capture has 18 rows for height 1500, 24 for 2000); index = row*cols+col
  function fogDims(mapId) {
    const m = MAP_BY_ID.get(mapId) || { Width: 2000, Height: 1500 };
    return { cols: Math.ceil(m.Width / 110), rows: Math.ceil(m.Height / 84) };
  }
  function fogMsg(p, mapId) {
    const { cols, rows } = fogDims(mapId), seen = ((p.s.fog || {})[mapId]) || {};
    const forArray = [];
    for (let r = 0; r < rows; r++) {
      const b = Buffer.alloc(cols);
      for (let k = 0; k < cols; k++) b[k] = seen[r * cols + k] || 0;
      forArray.push(b.toString('base64'));   // the sandboxed protobufjs takes base64 for bytes
    }
    return { row: rows, col: cols, forArray, mapTempId: mapId };
  }
  function nodeUpdate(c, cd, state, extra = {}) {
    c.player.s.campaign.nodes[cd.Id] = state;
    sendT(c, 128, 'campaign.CampaignNodeUpdateMsg', Object.assign({ nodeId: nodeInstanceId(cd), nodeState: state, userId: c.player.id, param1: 0 }, extra));
  }
  function startNodeBattle(c, cd) {
    const map = c.player.s.campaign ? c.player.s.campaign.campaignId : 0;
    const tpl = K.battles[map + '|' + cd.Id];
    if (tpl) startBattle(c, cd, rw(c).packet({ code: 157, type: 'battle.BattlePrepareMsg', obj: tpl }).obj);
    else startBattle(c, cd);
  }
  // 42 = monster, 41 = boss (CNBossAi; in the Flash-era data 41 was the exit)
  function fightable(cd) { return !!(cd.Soldiers || cd.Heros) && (cd.MasterType === 42 || cd.MasterType === 41) && cd.SonType !== 2122; }
  function replayEvents(c, evs) {
    const camp = c.player.s.campaign;
    for (const st of evs) {
      const pk = rw(c).packet(st); if (!pk) continue;
      if (st.code === 128 && pk.obj && camp) { const id = REC_NODE_REV.get(pk.obj.nodeId); if (id) camp.nodes[id] = pk.obj.nodeState; }
      c.sendPacket(st.code, pk, c.clientId, st.extend1, st.extend2);
    }
    c.player.save();
  }
  function trigger(c, key) {
    const st = c.player.s.campaign;
    const n = (st.triggers[key] = (st.triggers[key] || 0) + 1) - 1;
    return E.lookup(st.campaignId, key, n);
  }
  // a campaign run from its first map (normal campaigns, group dungeons)
  function startCampaign(c, campaignId, extra = {}) {
    const maps = CAMPAIGN_MAPS.get(campaignId);
    c.player.s.campaign = null;
    const born = String(maps[0].BornPoints || '').split('|')[0].split(',').map(Number);
    enterCampaign(c, maps[0].Id, born.length === 2 && born[0] ? born : null);
    Object.assign(c.player.s.campaign, extra);
    c.player.save();
  }
  // the run is over when the official server ended it there (recorded), else — for campaigns never recorded,
  // e.g. the group dungeons — when the boss (MasterType 41) of the campaign's last map falls
  const RECORDED_CAMPAIGNS = new Set([...FINAL_NODES].map(id => campaignOf((D.campNodes.get(id) || {}).CampaignId)));
  function isFinal(cd) {
    if (FINAL_NODES.has(cd.Id)) return true;
    const camp = campaignOf(cd.CampaignId), maps = CAMPAIGN_MAPS.get(camp);
    return !RECORDED_CAMPAIGNS.has(camp) && cd.MasterType === 41 && !!maps && maps[maps.length - 1].Id === cd.CampaignId;
  }
  // the campaign's last fight is won: tutorial -> straight back to the castle; others -> report + reward card
  function campaignCleared(c, cd) {
    const p = c.player, st = p.s.campaign, camp = campaignOf(st.campaignId);
    if (!p.s.cleared.includes(camp)) p.s.cleared.push(camp);
    log(`[#${c.id}] campaign ${camp} cleared`);
    if (camp === TUTORIAL_CAMPAIGN || st.campaignId === 10002) {
      p.s.tutorialDone = true; p.s.campaign = null; p.save();
      sendRaw(c, 134);
      sendT(c, 6, 'player.LoginStateMsg', { playerId: p.id });
      refreshQuests(c);
      return;
    }
    st.finished = true; p.save();
    const t = D.campaigns.get(camp) || {};
    // group dungeons: rewards only on the day's rewarded run (MultiCampaign_MaxCount, features/grouproom.js)
    if (t.BaseGp && st.income !== false) { giveExp(c, t.BaseGp); sendPlayer(c); }
    for (const fn of ctx.onCampaignCleared) fn(c, camp, st);
    if (REPORT.has(camp)) sendRaw(c, 137, REPORT.get(camp));
    sendT(c, 4151, 'campaign.RankListRspMsg', { rankInfo: [{ userId: p.id, campaignId: camp, rank: 5 }] });
    refreshQuests(c);
  }

  // ---- battle (server-driven, frame based) ------------------------------------------------------------
  let battleSeq = 1;
  function nativeHero(p, base) {
    const t = p.stats().total, a = M.mapArmy(p);
    return Object.assign(M.clone(base || M.REF[157].heros[0]), {
      heroId: p.heroId, userId: p.id, userPics: p.s.icon, tempId: p.s.icon, nickName: p.s.nickName, grade: p.s.grades, job: p.s.job,
      maxHp: t.live, initHp: t.live, hp: t.live, skillId: p.s.skills.slice(), serverName: playerServerName(p),
      fightCapacity: p.fightingCapacity(), slotAvata: a.arm, clothAvate: a.cloth, type: 1, side: 1,
      multiLanNickName: [{ lan: 6, param: p.s.nickName }],
      item: RUNE.battleItems(p),   // carried runes
    });
  }
  // the hero's troops: two squads (pos 3 and 9), each with the whole army's hp (capture: squadHp)
  function ownSquads(p, firstLiving, positions = [3, 9], side = 1) {
    const a = p.s.army; if (!a.tempId || !a.count) return [];
    const t = D.pawns.get(a.tempId) || { Live: 300, DefaultSkill: 10, HighSkill: 11 };
    const { init, max } = squadHp(t.Live, a.count, p.stats().total.captain);
    const skill = [t.DefaultSkill, t.DefaultSkill, t.DefaultSkill, Number(t.HighSkill) || t.DefaultSkill];
    return positions.map((pos, i) => ({ skillId: skill, livingId: firstLiving + i, tempId: a.tempId, type: 1, side, pos, initHp: init, hp: init, maxHp: max, castTime: 3000 }));
  }
  // troop special ability (features/pawnspecial.js; t_s_specialtemplate): the hero gains ChangeRandom % of its
  // own troop's stat. CurProperty = the troop's stat, MasterType = the hero's (descriptions: "%5 asker HP'si
  // kadar kahramanın HP'si artar"): 0 attack, 1 defence, 2 magic attack, 3 magic defence, 4 hp; MasterType
  // 1 attack, 2 magic attack, 3 defence, 4 magic defence, 5 hp. Troop hp = one squad's starting hp (a squad
  // carries the whole army's hp, squadHp). Battle only (not in the fighting capacity).
  const SPECIALS = new Map(table('t_s_specialtemplate').map(r => [r.TemplateId, r]));
  const SRC = ['attack', 'defence', 'magicAttack', 'magicDefence', 'hp'], DST = [null, 'attack', 'magicAttack', 'defence', 'magicDefence', 'hp'];
  function applySpecial(owner, units, side, prepHeros) {
    const a = owner.s.army; if (!a || !a.tempId) return;
    const hero = units.find(u => u.hero && u.side === side), squad = units.find(u => !u.hero && u.side === side && u.tempId === a.tempId);
    if (!hero || !squad) return;
    const rec = Object.values(owner.s.pawns || {}).find(r => r.tempId === a.tempId);
    const sp = SPECIALS.get((rec && rec.special) || Number((D.pawns.get(a.tempId) || {}).DefaultSpecialTemps) || 0);
    if (!sp || !sp.ChangeRandom) return;
    const from = SRC[sp.CurProperty], to = DST[sp.MasterType]; if (!from || !to) return;
    const v = Math.floor((from === 'hp' ? squad.start : squad.stats[from] || 0) * sp.ChangeRandom / 100);
    if (v <= 0) return;
    if (to === 'hp') {
      hero.maxHp += v; hero.hp += v; hero.start += v;
      const ph = (prepHeros || []).find(h => h.livingId === hero.livingId);   // the client draws the bar from 157
      if (ph) { ph.maxHp = hero.maxHp; ph.hp = hero.hp; ph.initHp = hero.hp; }
    } else hero.stats[to] += v;
    hero.special = { id: sp.TemplateId, stat: to, value: v };
  }
  // combat stats of a unit: our hero from Player.stats(), everyone else from its template
  function unitStats(u, isHero, p) {
    const owner = isHero && (u.userId === p.id ? p : u.owner);
    if (owner) { const t = owner.stats().total; return { attack: t.phyAttack, magicAttack: t.magicAttack, defence: t.phyDefence, magicDefence: t.magicDefence }; }
    const t = (isHero ? D.heroes.get(u.tempId) : D.pawns.get(u.tempId)) || {};
    return { attack: t.Attack || 0, magicAttack: t.MagicAttack || 0, defence: t.Defence || 0, magicDefence: t.MagicDefence || 0 };
  }
  // cd: campaign node (rewards/state); prepTpl: optional recorded BattlePrepareMsg used as composition template
  function startBattle(c, cd, prepTpl) {
    const p = c.player;
    let prep;
    if (prepTpl) {
      prep = M.clone(prepTpl);
      const i = prep.heros.findIndex(h => h.type === 1 && h.side === 1);
      const me = nativeHero(p, prep.heros[i]); me.livingId = prep.heros[i].livingId; me.pos = prep.heros[i].pos;
      prep.heros[i] = me;
      prep.soldiers = prep.soldiers.filter(s => s.side !== 1);
    } else {
      prep = M.clone(M.REF[157]);
      const soldiers = [];
      let living = 10;
      for (const part of String(cd.Soldiers || '').split('|').filter(Boolean)) {
        const [tid, pos] = part.split(',').map(Number);
        const pawn = D.pawns.get(tid) || { Live: 400, DefaultSkill: 40081 };
        const hp = Math.max(1, pawn.Live || 1);   // capture: enemy troops start at their template Live (76/76 campaign fights)
        soldiers.push({ livingId: living++, tempId: tid, type: 1, side: 2, pos, initHp: hp, hp, maxHp: hp, castTime: 4000, skillId: [pawn.DefaultSkill || 40081] });
      }
      // the node's boss heroes ("templateId,pos|..."): template values as the official BattlePrepareMsg carries them
      const bosses = [];
      for (const part of String(cd.Heros || '').split('|').filter(Boolean)) {
        const [tid, pos] = part.split(',').map(Number), t = D.heroes.get(tid); if (!t) continue;
        const sk = t.DefaultSkill || 40081;
        bosses.push({ heroId: 1300000000 + bosses.length, livingId: living++, tempId: tid, type: t.HeroType || 3, grade: t.Grades || cd.Level || 1, side: 2, pos: pos || 5,
          maxHp: t.Live, initHp: cd.bossHp || t.Live, hp: cd.bossHp || t.Live, captain: t.Captain || 1, res: t.ResPath || '', castTime: 4000, job: t.Job || 10, spMax: 100,
          skillId: [sk, sk, sk, sk], multiLanNickName: [{ lan: 6, param: nameOf(t) }] });
      }
      if (!soldiers.length && !bosses.length) soldiers.push({ livingId: 10, tempId: 2001, type: 1, side: 2, pos: 5, initHp: 10, hp: 10, maxHp: 10, castTime: 4000, skillId: [40081] });
      const me = nativeHero(p); me.livingId = 1; me.pos = 5;
      Object.assign(prep, { battleType: cd.BattleType || 6, mapTempId: cd.mapTempId || (p.s.campaign ? p.s.campaign.campaignId : 1), heros: [me, ...bosses], soldiers });
    }
    const maxLiving = Math.max(0, ...[...prep.soldiers, ...prep.heros].map(u => u.livingId));
    prep.soldiers.unshift(...ownSquads(p, maxLiving + 1));
    prep.battleId = `local-${p.id}-${battleSeq++}`;
    prep.coolDown = p.s.skills.map(id => ({ templatedId: id, coolType: 1 }));
    const units = [...prep.soldiers, ...prep.heros].map(u => {
      const hero = prep.heros.includes(u);
      return { livingId: u.livingId, side: u.side, hero, playerHero: hero && u.userId === p.id, tempId: u.tempId, pos: u.pos,
        hp: u.hp ?? u.initHp ?? u.maxHp, maxHp: u.maxHp || u.initHp || u.hp, start: u.hp ?? u.initHp ?? u.maxHp, castTime: u.castTime || (hero ? 3500 : 4000),
        skills: (u.skillId && u.skillId.length ? u.skillId : [40081]).slice(), stats: unitStats(u, hero, p), own: u.side === 1 && !hero,
        boss: hero && u.side === 2, runes: hero && u.userId === p.id ? Object.fromEntries((u.item || []).map(x => [x.skillTempId, x.count])) : null };
    });
    applySpecial(p, units, 1, prep.heros);
    // group scene campaign buffer (grouproom.js teamBuff): our units' attack, magic attack and hp +x %
    const tb = p.s.campaign && p.s.campaign.teamBuff;
    if (tb) for (const u of units.filter(x => x.side === 1)) {
      u.stats.attack = Math.floor(u.stats.attack * (1 + tb / 100)); u.stats.magicAttack = Math.floor(u.stats.magicAttack * (1 + tb / 100));
      const add = Math.floor(u.maxHp * tb / 100); u.maxHp += add; u.hp += add; u.start += add;
      const e = [...prep.heros, ...prep.soldiers].find(x => x.livingId === u.livingId); if (e) { e.maxHp = u.maxHp; e.hp = e.initHp = u.hp; }
    }
    // the pet in war rides along (features/pets.js): a pets entry tied to the hero by livingId2, hp2 = its hp;
    // the engine lets the hero turn into it with full awaken (battle.js morph)
    // within the same campaign map, keep fury (sp) and pet gauge (awaken) across battles
    const campSt = p.s.campaign;
    const fury = FURY.of(p, { angry: campSt && campSt.angry });
    const savedAwaken = campSt && campSt.battleAwaken != null ? Math.max(0, campSt.battleAwaken) : 0;
    const startSp = campSt && campSt.battleSp != null
      ? Math.max(0, Math.min(fury.spMax, campSt.battleSp))
      : fury.initial;
    const petB = ctx.petBattle && ctx.petBattle(p);
    if (petB) {
      const meU = units.find(u => u.playerHero), meP = prep.heros.find(h => h.userId === p.id);
      if (meU && meP) {
        const petLiving = Math.max(0, ...units.map(u => u.livingId)) + 1;
        // changeSkillId (int[]): client SkillItemListController → petSkillIds; fastKey slots via enterWarPet
        Object.assign(meP, { livingId2: petLiving, initHp2: petB.hp, hp2: petB.hp, petQuality: petB.quality, awake: savedAwaken, isChange: false,
          changeSkillId: petB.changeSkillId || petB.skills || [], followSkills: petB.followSkills, sp: startSp, spMax: fury.spMax });
        prep.pets = [Object.assign(M.clone(meP), { heroId: petB.id, livingId: petLiving, livingId2: meP.livingId, tempId: petB.templateId, nickName: petB.name, type: 1,
          grade: petB.grade, maxHp: petB.hp, initHp: petB.hp, hp: petB.hp, petQuality: petB.quality, skillId: [petB.skill], item: [],
          multiLanNickName: [{ lan: 6, param: petB.name }], phyAttack: petB.stats.attack, magAttack: petB.stats.magicAttack, phyDefence: petB.stats.defence, magDefence: petB.stats.magicDefence })];
        meU.pet = { stats: petB.stats, skill: petB.skill, skills: petB.skills || [petB.skill] };
      }
    }
    {
      const meP = prep.heros.find(h => h.userId === p.id);
      const meU = units.find(u => u.playerHero);
      if (meP) Object.assign(meP, FURY.prepFields({ initial: startSp, spMax: fury.spMax }));
      if (meU) FURY.applyToUnit(meU, { ...fury, sp: startSp });
    }
    // the guard in battle (features/guards.js): its own unit next to the hero, 157 guards (client isGuardFake).
    // Official capture: no type/tempId; growthGrade = Profile (0..4). type:3 breaks sprite (monster path).
    const guardB = ctx.guardBattle && ctx.guardBattle(p);
    if (guardB) {
      const meP = prep.heros.find(h => h.userId === p.id);
      if (meP) {
        const living = Math.max(0, ...units.map(u => u.livingId), ...(prep.pets || []).map(x => x.livingId)) + 1;
        const pos = meP.pos === 5 ? 8 : 5, gs = guardB.stats;
        const gMsg = Object.assign(M.clone(meP), { heroId: guardB.id, livingId: living, livingId2: meP.livingId, headId: guardB.headId, nickName: guardB.name,
          multiLanNickName: [{ lan: 6, param: guardB.name }], pos, maxHp: gs.hp, initHp: gs.hp, hp: gs.hp, initHp2: 0, hp2: 0, item: [],
          skillId: [guardB.skill, ...(guardB.skills || [])], castTime: 3500,
          phyAttack: gs.attack, magAttack: gs.magicAttack, phyDefence: gs.defence, magDefence: gs.magicDefence, growthGrade: guardB.stage, upaniValue: 0, awake: 0 });
        delete gMsg.type; delete gMsg.tempId; delete gMsg.isChange; delete gMsg.petQuality; delete gMsg.changeSkills; delete gMsg.changeSkillId; delete gMsg.followSkills;
        prep.guards = [gMsg];
        units.push({ livingId: living, side: 1, hero: true, guard: true, tempId: guardB.id, pos, hp: gs.hp, maxHp: gs.hp, start: gs.hp, castTime: 3500, upani: 0,
          skills: [guardB.skill, ...(guardB.skills || [])], stats: { attack: gs.attack, magicAttack: gs.magicAttack, defence: gs.defence, magicDefence: gs.magicDefence }, own: false, boss: false, runes: null });
      }
    }
    // feature fights may adjust the units / prepare message before it is sent (e.g. Gökyüzü Yolu bonuses and skills)
    if (cd && typeof cd.setup === 'function') cd.setup(units, prep);
    if (c.battle && c.battle.engine) c.battle.engine.stop();
    const engine = new Battle({
      id: prep.battleId, units, maxTurns: cd.maxTurns,
      onAwake: u => sendT(c, 4600, 'battle.AwakeMsg', { awake: [{ livingId: u.livingId, awake: u.awaken || 0 }] }),
      onUpani: u => sendT(c, 4602, 'battle.AwakeMsg', { awake: [{ livingId: u.livingId, awake: u.upani || 0 }] }),
      send: msg => sendT(c, 153, 'battle.AttackOrderMsg', Object.assign(msg, { attackMillis: sysTime() })),
      onEnd: (won, frame) => { if (c.battle && c.battle.engine === engine) endBattle(c, won, frame); },
    });
    // Battle() keeps unit.sp / spMax from applyToUnit; re-apply pet awaken across campaign fights
    {
      const meU = engine.hero;
      if (meU && meU.pet) meU.awaken = savedAwaken;
    }
    const b = c.battle = { id: prep.battleId, cd: cd || {}, units, engine, type: prep.battleType, prepHero: prep.heros.find(h => h.userId === p.id) };
    log(`[#${c.id}] battle ${b.id} type ${prep.battleType} (${units.filter(u => u.side === 2).length} enemies, ${units.filter(u => u.own).length} squads)`);
    sendT(c, 140, 'army.MapUpdatedMsg', { updatedType: 3, army: M.mapArmy(p, 2) });
    if (p.s.campaign && cd && cd.Id) {
      const st = p.s.campaign;
      sendT(c, 131, 'army.ArmyMsg', { armyId: p.armyId, playerId: p.id, curPosX: st.posX, curPosY: st.posY, state: 2 });
      nodeUpdate(c, cd, 4);
    }
    sendT(c, 157, 'battle.BattlePrepareMsg', prep);
  }
  // the client re-sends the selected skill about every 200 ms; the official server confirms each one and the
  // hero uses the latest choice on its turn (capture)
  // player vs player (arena): the opponent's hero and troops from its own state, the hero on auto.
  // Layout and type from the capture's arena fights: battleType 16, map 992, our hero pos 6 + troops 2 / 8,
  // the opponent's hero pos 5 + troops 3 / 9 (side 2). opts.onEnd(won) runs after the report.
  function startPvp(c, opp, opts = {}) {
    const p = c.player;
    const prep = M.clone(M.REF[157]);
    const me = nativeHero(p); me.livingId = 3; me.pos = 6;
    const foe = nativeHero(opp); Object.assign(foe, { livingId: 6, pos: 5, side: 2, item: [] });
    const soldiers = [...ownSquads(p, 1, [2, 8], 1), ...ownSquads(opp, 4, [3, 9], 2)];
    Object.assign(prep, { battleType: opts.battleType || 16, mapTempId: opts.mapTempId || 992, heros: [me, foe], soldiers, soldierTemplated: [], pets: [], guards: [], watchHeros: [] });
    prep.battleId = `local-${p.id}-${battleSeq++}`;
    prep.coolDown = p.s.skills.map(id => ({ templatedId: id, coolType: 1 }));
    const units = [...prep.soldiers, ...prep.heros].map(u => {
      const hero = prep.heros.includes(u), mine = u.side === 1;
      const owner = hero ? (mine ? p : opp) : null;
      return { livingId: u.livingId, side: u.side, hero, playerHero: hero && mine, autoHero: hero && !mine, tempId: u.tempId, pos: u.pos,
        hp: u.hp, maxHp: u.maxHp, start: u.hp, castTime: u.castTime || (hero ? 3500 : 3000), skills: (u.skillId && u.skillId.length ? u.skillId : [40081]).slice(),
        stats: unitStats(Object.assign({}, u, { owner }), hero, p), own: false, boss: false,
        runes: hero && mine ? Object.fromEntries((u.item || []).map(x => [x.skillTempId, x.count])) : null };
    });
    // troop stats: the pawn template, as for campaign troops; both heroes get their troop special
    applySpecial(p, units, 1, prep.heros); applySpecial(opp, units, 2, prep.heros);
    const furyMe = FURY.of(p), furyOpp = FURY.of(opp);
    const meP = prep.heros.find(h => h.userId === p.id), foeP = prep.heros.find(h => h.userId === opp.id);
    if (meP) Object.assign(meP, FURY.prepFields(furyMe));
    if (foeP) Object.assign(foeP, FURY.prepFields(furyOpp));
    FURY.applyToUnit(units.find(u => u.playerHero), furyMe);
    FURY.applyToUnit(units.find(u => u.autoHero), furyOpp);
    if (c.battle && c.battle.engine) c.battle.engine.stop();
    const engine = new Battle({ id: prep.battleId, units, send: msg => sendT(c, 153, 'battle.AttackOrderMsg', Object.assign(msg, { attackMillis: sysTime() })),
      onEnd: (won, frame) => { if (c.battle && c.battle.engine === engine) endBattle(c, won, frame); } });
    c.battle = { id: prep.battleId, cd: {}, units, engine, type: prep.battleType, pvp: opts };
    log(`[#${c.id}] pvp ${prep.battleId} vs ${opp.id}`);
    sendT(c, 140, 'army.MapUpdatedMsg', { updatedType: 3, army: M.mapArmy(p, 2) });
    sendT(c, 157, 'battle.BattlePrepareMsg', prep);
    return c.battle;
  }
  // pets only (pet arena, battle type 35 PET_PK; client createPetRoleInfo: with isAllPetPKBattle the heros list is
  // ignored and every pets entry is a fighter, read as a hero role + petRoleInfo; the fight is watch-only).
  // Guard arena (3896) uses the same path with guards[] (client isGuardFake → never becomes selfHero).
  // Client createLookBattleHeroRoleInfo needs watchHeros[0] with livingId 0 + matching userId/serverName for selfHero.
  // sides: [{ userId, nickName, serverName?, pets: [{ pos, combat }] , guards? }, ...] for side 1 and side 2.
  function startPetPvp(c, sides, opts = {}) {
    const p = c.player, prep = M.clone(M.REF[157]), base = nativeHero(p), pets = [], units = [];
    const sideName = (sd, k) => sd.serverName || (k === 0 ? playerServerName(p) : (sd.nickName ? String(sd.nickName) : playerServerName(p)));
    let living = 1;
    sides.forEach((sd, k) => {
      const srv = sideName(sd, k);
      for (const { pos, combat: cb, hp: startHp, key } of sd.pets || []) {
        const hp0 = startHp == null ? cb.hp : Math.max(1, Math.min(cb.hp, startHp));   // remote pets keep their hp between floors
        const skills = [...(cb.arenaSkills || []), cb.skill].filter((x, i, a) => a.indexOf(x) === i);
        const e = Object.assign(M.clone(base), { userId: sd.userId, heroId: cb.id, livingId: living, livingId2: 0, tempId: cb.templateId, nickName: cb.name, type: 1, side: k + 1, pos,
          grade: cb.grade, maxHp: cb.hp, initHp: hp0, hp: hp0, initHp2: 0, hp2: 0, petQuality: cb.quality, awake: 0, isChange: true, skillId: skills, item: [], serverName: srv,
          multiLanNickName: [{ lan: 6, param: cb.name }], phyAttack: cb.stats.attack, magAttack: cb.stats.magicAttack, phyDefence: cb.stats.defence, magDefence: cb.stats.magicDefence,
          changeSkills: cb.changeSkills, followSkills: cb.followSkills });
        pets.push(e);
        units.push({ livingId: living, side: k + 1, hero: true, autoHero: true, petId: key ?? cb.id, tempId: cb.templateId, pos, hp: hp0, maxHp: cb.hp, start: hp0, castTime: 3500,
          skills, petAttack: cb.skill, stats: cb.stats, own: false, boss: false, runes: null });
        living++;
      }
    });
    // sides[k].guards [{pos, combat (guards.js guardCombat)}]: guard fighters (guard arena, 157 guards as in startBattle)
    const guards = [];
    sides.forEach((sd, k) => {
      const srv = sideName(sd, k);
      for (const { pos, combat: gb } of sd.guards || []) {
        const gs = gb.stats, id = living++, skills = [gb.skill, ...(gb.skills || [])];
        const gMsg = Object.assign(M.clone(base), { userId: sd.userId, heroId: gb.id, livingId: id, livingId2: 0, headId: gb.headId, nickName: gb.name, side: k + 1, pos, serverName: srv,
          multiLanNickName: [{ lan: 6, param: gb.name }], maxHp: gs.hp, initHp: gs.hp, hp: gs.hp, initHp2: 0, hp2: 0, item: [], skillId: skills, castTime: 3500,
          phyAttack: gs.attack, magAttack: gs.magicAttack, phyDefence: gs.defence, magDefence: gs.magicDefence, growthGrade: gb.stage, upaniValue: 0, awake: 0 });
        delete gMsg.type; delete gMsg.tempId; delete gMsg.isChange; delete gMsg.petQuality; delete gMsg.changeSkills; delete gMsg.followSkills;
        guards.push(gMsg);
        units.push({ livingId: id, side: k + 1, hero: true, autoHero: true, guard: true, tempId: gb.id, pos, hp: gs.hp, maxHp: gs.hp, start: gs.hp, castTime: 3500,
          skills, stats: { attack: gs.attack, magicAttack: gs.magicAttack, defence: gs.defence, magicDefence: gs.magicDefence }, own: false, boss: false, runes: null });
      }
    });
    // opts.bosses [{tempId, pos}]: template heroes on side 2 (remote pet floors), as campaign node bosses
    const heros = (opts.bosses || []).map(({ tempId, pos }, i) => {
      const t = D.heroes.get(tempId) || {}, sk = t.DefaultSkill || 40081, id = living++;
      units.push({ livingId: id, side: 2, hero: true, tempId, pos, hp: t.Live, maxHp: t.Live, start: t.Live, castTime: 4000, skills: [sk], boss: true, own: false, runes: null,
        stats: { attack: t.Attack || 0, magicAttack: t.MagicAttack || 0, defence: t.Defence || 0, magicDefence: t.MagicDefence || 0 } });
      return { heroId: 1300000000 + i, livingId: id, tempId, type: t.HeroType || 3, grade: t.Grades || 1, side: 2, pos, maxHp: t.Live, initHp: t.Live, hp: t.Live,
        captain: t.Captain || 1, res: t.ResPath || '', castTime: 4000, job: t.Job || 10, spMax: 100, skillId: [sk, sk, sk, sk], multiLanNickName: [{ lan: 6, param: nameOf(t) }] };
    });
    // look / selfHero: livingId 0 on our side (PET_PK + GUARD_CHALLENGE); guards alone never become selfHero (isGuardFake).
    // PET_PK watch heroes are read as pets; reuse our first pet shape when present, else the player hero (guard arena).
    const lookPet = pets.find(e => e.side === 1);
    const look = lookPet
      ? Object.assign(M.clone(lookPet), { livingId: 0, livingId2: 0, pos: 0 })
      : Object.assign(nativeHero(p), { livingId: 0, livingId2: 0, pos: 0, side: 1, initHp2: 0, hp2: 0, item: [] });
    Object.assign(prep, { battleType: opts.battleType || 35, mapTempId: opts.mapTempId || 992, side: 1, heros, soldiers: [], soldierTemplated: [], pets, guards, watchHeros: [look] });
    prep.battleId = `local-${p.id}-${battleSeq++}`;
    prep.coolDown = [];
    if (c.battle && c.battle.engine) c.battle.engine.stop();
    const engine = new Battle({ id: prep.battleId, units, send: msg => sendT(c, 153, 'battle.AttackOrderMsg', Object.assign(msg, { attackMillis: sysTime() })),
      onEnd: (won, frame) => { if (c.battle && c.battle.engine === engine) endBattle(c, won, frame); } });
    c.battle = { id: prep.battleId, cd: {}, units, engine, type: prep.battleType, pvp: opts };
    log(`[#${c.id}] pet pvp ${prep.battleId} (${units.filter(u => u.side === 1).length} vs ${units.filter(u => u.side === 2).length})`);
    sendT(c, 157, 'battle.BattlePrepareMsg', prep);
    return c.battle;
  }
  function heroOrder(c, skillId, heroIndexId, targetIndexs = []) {
    const b = c.battle; if (!b) return;
    const me = b.units.find(u => u.playerHero);
    const u = (heroIndexId != null && b.units.find(x => x.livingId === heroIndexId)) || me;
    if (!u) return;
    if (u.guard || (u.petId != null && !u.playerHero)) {
      if ((u.skills || []).includes(skillId) || skillId === u.petAttack) u.forceSkill = skillId;
    } else {
      b.engine.order(skillId);
    }
    sendT(c, 75, 'battle.HeroOrderMsg', { battleId: b.id, heroIndexId: u.livingId, skillId, targetIndexs: targetIndexs || [], castTime: u.castTime || 3500 });
  }
  function endBattle(c, won, frame) {
    const b = c.battle, p = c.player, cd = b.cd || {};
    c.battle = null;
    b.engine.stop();
    const meEnd = b.units.find(u => u.playerHero);
    // keep fury + pet fill for the next fight on this map (cleared on map change / campaign exit)
    if (p.s.campaign && meEnd && !b.pvp) {
      p.s.campaign.battleSp = Math.max(0, Math.min(meEnd.spMax || FURY.BASE_SP_MAX, meEnd.sp || 0));
      p.s.campaign.battleAwaken = meEnd.pet ? Math.max(0, meEnd.awaken || 0) : 0;
    }
    const winners = b.units.filter(u => u.side === (won ? 1 : 2) && u.hp > 0);
    sendT(c, 154, 'battle.PrepareOverMsg', { frame: (frame || 0) + 10, prepareOverLivings: winners.map(u => ({ calcType: 3, livingId: u.livingId, sp: u.playerHero ? u.sp : 0 })) });
    if (b.pvp) {   // arena: no troop losses, no EXP; report scene 7 (capture)
      sendT(c, 4103, 'battle.BattleReportMsg', { battleResult: won ? 1 : 2, battleScene: b.pvp.scene || 7, battleId: b.id });
      sendArmy(c, 0);
      sendT(c, 140, 'army.MapUpdatedMsg', { updatedType: 3, army: M.mapArmy(p, 0) });
      if (b.pvp.onEnd) b.pvp.onEnd(won, b.units);
      p.save();
      return;
    }
    // troop losses follow the squads' lost hp (fraction of the hp they started with)
    const squads = b.units.filter(u => u.own);
    if (squads.length && p.s.army.count) {
      const left = squads.reduce((n, u) => n + u.hp, 0) / squads.reduce((n, u) => n + u.start, 0);
      p.s.army.count = Math.max(0, Math.round(p.s.army.count * Math.min(1, left)));
    }
    const gp = won ? Math.floor((cd.HeroGP || 0) * (1 + (ctx.vipPriv ? ctx.vipPriv(p, 4) : 0) / 100)) : 0;   // VIP privilege 4: campaign EXP +%
    if (gp) giveExp(c, gp);
    sendPlayer(c);
    sendT(c, 4103, 'battle.BattleReportMsg', { battleResult: won ? 1 : 2, gpBonus: gp, battleScene: cd.battleScene || (p.s.campaign && p.s.campaign.battleScene) || (p.s.campaign ? 3 : 1), battleId: b.id });   // the client returns by scene (2026-10-23 capture: maze 10, secret 34, outer city 5, tower 55)
    sendArmy(c, 0); sendReserve(c);
    sendT(c, 140, 'army.MapUpdatedMsg', { updatedType: 3, army: M.mapArmy(p, 0) });
    if (p.s.campaign && cd.Id) {
      const st = p.s.campaign;
      sendT(c, 131, 'army.ArmyMsg', { armyId: p.armyId, playerId: p.id, curPosX: st.posX, curPosY: st.posY });
      nodeUpdate(c, cd, won ? 8 : (cd.NodeState || 1), won ? { sonType: cd.SonType } : {});
      // what this win changed on the official map (e.g. 10001: the bear opens the portal to 10002)
      const eff = won && E.afterWin(st.campaignId, nodeInstanceId(cd));
      if (eff) replayEvents(c, eff);
    }
    p.save();
    if (won) {
      // kill quests: enemy soldier templates (25) and the node's boss hero (26)
      const kills = {};
      for (const u of b.units) if (u.side === 2 && !u.hero && u.tempId) kills[u.tempId] = (kills[u.tempId] || 0) + 1;
      for (const [tid, n] of Object.entries(kills)) bump(c, 25, Number(tid), n);
      stat(c, 'kills', Object.values(kills).reduce((a, b) => a + b, 0));
      const boss = cd.Heros ? Number(String(cd.Heros).split(',')[0]) : 0;
      if (boss) bump(c, 26, boss);
      sendT(c, 4382, 'simple.FightOverMoiveMsg', { gp });
      if (p.s.campaign && isFinal(cd)) campaignCleared(c, cd);
    }
    if (p.s.campaign && cd.Id) for (const fn of ctx.onBattleEnd) fn(c, cd, won);
    if (typeof cd.onEnd === 'function') cd.onEnd(won, b);   // feature fights outside campaigns (e.g. gold mines)
    refreshQuests(c);
  }

  // ---- items -------------------------------------------------------------------------------------------
  // consumables (MasterType 2 / SonType 203): Property1 = effect, Property2 = amount per item. Only effects whose
  // meaning is certain (item names + capture texts) are applied; the recorded-outcome replay this replaces gave
  // a wrong 31-item list for the EXP book (capture window artefact).
  function useConsumable(c, it, tp, n) {
    const p = c.player, k = (tp.Property2 || 0) * n;
    let text;
    if (tp.Property1 === 1) { p.s.gold += k; text = `Ouro ${k.toLocaleString('en-US')}`; sendCastle(c); }
    else if (tp.Property1 === 4 && /Diamante Vinculado|Kilitli Elmas/.test(`${tp.TemplateName_pt || ''} ${tp.TemplateName_tr || ''}`)) { p.s.giftToken += k; text = `Diamante Vinculado ${k}`; }
    else if (tp.Property1 === 5) {
      const got = addWeary(p, k);
      if (!got) { alert(c, 'Energia no limite'); return; }
      text = `Energia ${got}`;
    }
    else if (tp.Property1 === 7) { giveExp(c, k); text = `Lord EXP ${k.toLocaleString('en-US')}`; }
    // pass / card activations (Ultra: usable from bag or GM mail)
    else if (tp.Property1 === 19) { text = ctx.grantMonthCard ? ctx.grantMonthCard(c, 1, 30) : 'Passe Mensal'; }
    else if (tp.Property1 === 20) { text = ctx.grantMonthCard ? ctx.grantMonthCard(c, 2, 30) : 'Passe Mensal Premium'; }
    else if (tp.Property1 === 21) { text = ctx.grantGrowthFund ? ctx.grantGrowthFund(c) : 'Fundo de Crescimento'; }
    else if (tp.Property1 === 22) { text = ctx.grantWarriorPass ? ctx.grantWarriorPass(c) : 'Passe de Guerreiro'; }
    else if (tp.Property1 === 26) { text = ctx.grantLordPrivilege ? ctx.grantLordPrivilege(c) : 'Privilégio do Lorde'; }
    else if (tp.Property1 === 29) {
      // Guard recruit advanced order — mark paid flag for guard draw UI
      p.s.guardRecruitPass = true; text = 'Ordem de Recrutamento Avançada';
    }
    else if (tp.Property1 === 35) {
      p.s.returnPass = { premium: true }; text = 'Passe de Retorno';
    }
    else if (tp.Property1 === 34) {
      // return pass EXP card
      const rp = p.s.returnPass = p.s.returnPass || {};
      rp.exp = (rp.exp || 0) + (tp.Property2 || 100) * n; text = `EXP Passe de Retorno +${(tp.Property2 || 100) * n}`;
    }
    else { log(`[#${c.id}] use item ${it.templateId} (${tp.TemplateName_tr}, effect ${tp.Property1}) not implemented`); alert(c, 'Este item ainda não pode ser usado'); return; }
    p.removeItem(it, n);
    sendItems(c, [M.movedEntry(p, it, it.count <= 0)]);
    sendPlayer(c); p.save();
    alert(c, `Parabéns, obtido: ${text}`);   // official wording (capture)
  }
  // boxes with a drop table (item Property1 = DropId): n rolls, merged
  function openDropBox(c, it, tp, n) {
    const p = c.player;
    if (tp.NeedGrades && p.s.grades < tp.NeedGrades) { alert(c, `Nível ${tp.NeedGrades} necessário`); return; }
    const got = new Map();
    for (let i = 0; i < n; i++) for (const [tid, cnt] of DROPS.roll(tp.Property1)) got.set(tid, (got.get(tid) || 0) + cnt);
    const rewards = [...got];
    // check room first: grant() refuses as a whole when the bag is full
    p.removeItem(it, n);
    if (!grant(c, rewards, { quiet: n > 1 })) { it.count += n; if (!p.s.bag.includes(it)) p.s.bag.push(it); alert(c, 'Mochila cheia'); return; }
    if (n > 1) alert(c, `${nameOf(tp)} x${n} usado em lote, obtido:${rewards.map(([t, k]) => `${rewardName(t)} x${k}`).join(', ')}`);
    sendItems(c, [M.movedEntry(p, it, it.count <= 0)]);
    log(`[#${c.id}] opened ${tp.TemplateName_tr} x${n}: ${rewards.map(([t, k]) => t + 'x' + k).join(' ')}`);
    p.save();
  }
  function openBox(c, it) {
    const p = c.player, tp = D.items.get(it.templateId), lv = tp.NeedGrades || 1;
    const got = [];
    // newbie package chain: Lv5 -> 10 -> 15 -> 20 -> 25 -> 30
    const chain = ['01', '02', '06', '03', '04', '05'];
    const suf = String(it.templateId).slice(-2), idx = chain.indexOf(suf);
    if (String(it.templateId).startsWith('206') && idx >= 0 && idx < chain.length - 1)
      got.push(Number(String(it.templateId).slice(0, -2) + chain[idx + 1]));
    // equipment for this job at the package level: one per slot type not yet owned
    const owned = new Set([...p.s.bag, ...Object.values(p.s.equip)].map(i => D.items.get(i.templateId)).filter(Boolean).map(t => t.SonType));
    for (const son of [101, 103, 104, 106, 107, 108]) {
      if (owned.has(son)) continue;
      const cand = [...D.items.values()].filter(t => t.SonType === son && t.NeedGrades <= lv && t.NeedGrades >= lv - 4 && (t.Job === p.s.job || t.Job === 0));
      if (cand.length) { got.push(cand[0].TemplateId); if (got.length >= 3) break; }
    }
    p.removeItem(it);
    const entries = [M.movedEntry(p, it, it.count <= 0)];
    for (const tid of got) for (const x of p.addItem(tid)) entries.push(M.movedEntry(p, x));
    sendItems(c, entries);
    for (const tid of got) alert(c, `Obtido:${itemName(tid)} x1`);
    p.s.gold += 1000 * Math.max(1, lv / 5); sendCastle(c);
    p.save();
  }
  function equip(c, it) {
    const p = c.player, tp = D.items.get(it.templateId);
    const slots = EQUIP_POS[tp.SonType]; if (!slots) return false;
    const pos = slots.find(s => !p.s.equip[s]) ?? slots[0];
    const old = p.s.equip[pos];
    const entries = [];
    p.s.bag = p.s.bag.filter(x => x !== it);
    entries.push({ changeType: 1, changeObjId: 0, changePos: it.pos });
    if (old) { old.bagType = 1; old.pos = it.pos; p.s.bag.push(old); entries.push(M.movedEntry(p, old)); }
    it.bagType = ITEM_HERO_BAG; it.pos = pos; it.isNew = false; p.s.equip[pos] = it;
    entries.push(M.movedEntry(p, it));
    sendPlayer(c); sendArmy(c); sendItems(c, entries);
    refreshQuests(c);
    p.save();
    return true;
  }
  function unequip(c, pos, toPos) {
    const p = c.player, it = p.s.equip[pos]; if (!it) return;
    delete p.s.equip[pos];
    it.bagType = 1; it.pos = toPos >= 0 && !p.itemAt(toPos) ? toPos : p.freePos(); p.s.bag.push(it);
    sendPlayer(c); sendArmy(c);
    sendItems(c, [{ changeType: 4, changeObjId: p.heroId, changePos: pos }, M.movedEntry(p, it)]);
    p.save();
  }

  // ---- buildings ---------------------------------------------------------------------------------------
  // the castle the tutorial hands over: council (901), barracks (402), house (1201)
  function initBuildings(p) {
    if (p.s.buildings.length) return;
    let id = p.id * 10;
    for (const tid of [90101, 40201, 120101]) {
      const t = D.buildings.get(tid); if (!t) continue;
      p.s.buildings.push({ id: id++, templateId: tid, sonType: t.SonType, grade: t.BuildingGrade, p1: tid === 120101 ? t.Property2 : 0, p2: tid === 90101 ? 5 : 0 });
    }
    unlockPawns(p);
  }
  // buildings the official server handed out when a quest was finished (capture: quest 120 -> warehouse at
  // Lv8; quest 280 -> academy + its technologies at Lv17). Other buildings' unlock rules are not in the capture.
  const QUEST_BUILDINGS = {
    120: [30101],
    280: [50101, 130400, 142000, 142100, 142200, 142300, 142400, 144100, 144200, 144300, 144400, 144500, 144600],
  };
  function questBuildings(c, questId, silent = false) {
    const p = c.player, added = [];
    for (const tid of QUEST_BUILDINGS[questId] || []) {
      const t = D.buildings.get(tid);
      if (!t || p.s.buildings.some(b => b.sonType === t.SonType)) continue;
      p.s.nextBuildingId = p.s.nextBuildingId || p.id * 100 + 50;   // initBuildings used p.id*10 .. +2
      const b = { id: p.s.nextBuildingId++, templateId: tid, sonType: t.SonType, grade: t.BuildingGrade, p1: 0, p2: 0 };
      p.s.buildings.push(b); added.push(b);
    }
    if (!added.length) return;
    p.save();
    if (silent) return;
    sendT(c, 4130, 'building.BuildingInfoListMsg', { result: true, building: added.map(b => ({ userId: p.id, buildingId: b.id, templateId: b.templateId, sonType: b.sonType })) });
    sendCastle(c);
    log(`[#${c.id}] quest ${questId} unlocked buildings ${added.map(b => b.templateId)}`);
  }
  // ---- build orders (queues) ---------------------------------------------------------------------------
  // capture: order 1 (type 1 building) with the castle, order 2 (type 3 levy) when quest 240 is finished,
  // order 3 (type 2 technology) when quest 280 is. An upgrade happens at once; its UpgradeTime (0 below grade
  // 21, 300+ from 21) keeps the order busy (Meclis 20 -> 21: ORDER_INFO {orderId 1, remainTime 300}).
  const ORDER_BUILD = 1, ORDER_TECH = 2, ORDER_LEVY = 3;
  const QUEST_ORDERS = { 240: ORDER_LEVY, 280: ORDER_TECH };
  const remainOf = o => Math.max(0, Math.ceil(((o.end || 0) - Date.now()) / 1000));
  function orderMsg(p, o) {
    const r = remainOf(o), m = { orderId: o.id, orderType: o.type, userId: p.id, beginTime: sysTime(new Date(o.begin || p.s.created || Date.now())) };
    if (r) { m.remainTime = r; m.needTime = o.need; }
    return m;
  }
  function addOrder(c, type, silent = false) {
    const p = c.player, list = p.s.orders = p.s.orders || [];
    const o = { id: list.reduce((n, x) => Math.max(n, x.id), 0) + 1, type, begin: Date.now(), end: 0, need: 0 };
    list.push(o); p.save();
    if (!silent) sendT(c, 104, 'building.OrderInfoMsg', { orderId: o.id, orderType: type });
    return o;
  }
  // characters made before queues existed get the orders their progress earned
  function ensureOrders(c) {
    const p = c.player, has = t => (p.s.orders || []).some(o => o.type === t);
    if (p.s.buildings.length && !has(ORDER_BUILD)) addOrder(c, ORDER_BUILD, true);
    for (const [q, t] of Object.entries(QUEST_ORDERS)) if (p.s.quests.done.includes(Number(q)) && !has(t)) addOrder(c, t, true);
  }
  const ordersOf = (p, type) => (p.s.orders || []).filter(o => o.type === type);
  function useOrder(c, o, secs) {
    const now = Date.now();
    o.begin = now; o.need = secs || 0; o.end = now + (secs || 0) * 1000;
    const m = { orderId: o.id, orderType: o.type }; if (secs) m.remainTime = secs;
    sendT(c, 151, 'building.OrderInfoMsg', m);
  }
  const orderTypeOf = t => (t.MasterType === 13 || t.MasterType === 14) ? ORDER_TECH : ORDER_BUILD;   // academy technologies

  // a troop type becomes recruitable once its NeedBuilding (barracks grade) exists
  function unlockPawns(p) {
    const added = [];
    for (const t of D.pawns.values()) {
      if (t.Level !== 1 || !t.NeedBuilding || (t.Camp && t.Camp !== p.s.camp) || p.s.pawns[t.SonType]) continue;
      const need = D.buildings.get(t.NeedBuilding); if (!need) continue;
      if (p.s.buildings.some(b => b.sonType === need.SonType && b.grade >= need.BuildingGrade)) { p.s.pawns[t.SonType] = { tempId: t.TemplateId, count: 0 }; added.push(t.SonType); }
    }
    return added;
  }
  function upgradeBuilding(c, buildingId) {
    const p = c.player, b = p.s.buildings.find(x => x.id === buildingId); if (!b) return;
    const next = D.buildingBySon.get(b.sonType + '|' + (b.grade + 1)); if (!next) return;
    // prerequisites, in the official order and wording (capture: 304 upgrades never above the character level;
    // refusals "Karakter Lv. N necessário" x48, "Meclis Lv. N necessário" x5, "Akademi Lv. N necessário" x1)
    const needLv = Math.max(next.BuildingGrade, next.PlayerGrades || 0);
    if (needLv > p.s.grades) { alert(c, `Personagem Lv. ${needLv} necessário`); return; }
    for (const pre of String(next.PreTemplateId || '').split(',').map(Number).filter(Boolean)) {
      const t = D.buildings.get(pre);
      if (t && !p.s.buildings.some(x => x.sonType === t.SonType && x.grade >= t.BuildingGrade)) { alert(c, `${nameOf(t, 'BuildingName')} Lv. ${t.BuildingGrade} necessário`); return; }
    }
    if (p.s.gold < (next.GoldConsume || 0)) { alert(c, 'Ouro insuficiente'); return; }
    ensureOrders(c);
    const kind = orderTypeOf(next), queue = ordersOf(p, kind), order = queue.find(o => !remainOf(o));
    if (queue.length && !order) { alert(c, kind === ORDER_TECH ? 'Fila de pesquisa cheia' : 'Fila de construção cheia'); return; }
    p.s.gold -= next.GoldConsume || 0;
    const from = b.grade;
    b.templateId = next.TemplateId; b.grade = next.BuildingGrade;
    if (b.sonType === 1201) b.p1 = next.Property2;
    const unlocked = unlockPawns(p);
    p.save();
    sendCastle(c);
    // VIP privileges 29 / 30 (client BUILD_COOLDOWN / TECHNOLOGY_COOLDOWN): the wait shortened by para1 seconds
    const cut = ctx.vipPriv ? ctx.vipPriv(p, kind === ORDER_TECH ? 30 : 29) : 0;
    if (order) useOrder(c, order, Math.max(0, (next.UpgradeTime || 0) - cut));
    p.save();
    const text = `${nameOf(next, 'BuildingName')} evoluiu do nível ${from} para ${b.grade}`;
    alert(c, text);
    sendBuildings(c);
    chat(c, text);
    if (unlocked.length) sendReserve(c, unlocked);
    // academy / building grades that feed hero or troop stats: refresh the army sheet
    if (kind === ORDER_TECH || [901, 402, 1201, 301].includes(b.sonType)) { sendPlayer(c); sendArmy(c); }
    refreshQuests(c);
    log(`[#${c.id}] building ${b.sonType} ${from} -> ${b.grade}`);
  }

  // ---- troops ------------------------------------------------------------------------------------------
  function reserveOf(p, tid) { const son = (D.pawns.get(tid) || {}).SonType; return son && p.s.pawns[son] ? [son, p.s.pawns[son]] : [son, null]; }
  function recruit(c, tid, n) {
    const p = c.player, [son, r] = reserveOf(p, tid); if (!r || n <= 0) return;
    const t = D.pawns.get(r.tempId);
    const max = M.castleYield(p).maxPopulation;
    n = Math.min(n, max - p.population());
    const cost = n * (t.GoldConsume || 0);
    if (n <= 0 || p.s.gold < cost) { alert(c, n <= 0 ? 'População cheia' : 'Ouro insuficiente'); return; }
    p.s.gold -= cost; r.count += n; p.save();
    sendCastle(c);
    stat(c, 'recruited', n);
    bump(c, 3, son - 100, n);
    sendArmy(c);
    sendReserve(c, [son]);
    alert(c, `${n} ${pawnName(r.tempId)} recrutado(s)`);
  }
  // put n troops of this type into the hero's army (the rest stays in the castle)
  function editArmy(c, tid, n) {
    const p = c.player, [son, r] = reserveOf(p, tid); if (!r) return;
    const a = p.s.army;
    if (a.tempId && a.count && (D.pawns.get(a.tempId) || {}).SonType !== son) {   // other type goes back home
      const [, back] = reserveOf(p, a.tempId); if (back) back.count += a.count;
      a.count = 0;
    }
    const total = r.count + (a.tempId && (D.pawns.get(a.tempId) || {}).SonType === son ? a.count : 0);
    a.tempId = r.tempId; a.count = Math.max(0, Math.min(n, total)); r.count = total - a.count;
    p.save();
    sendArmy(c);
    sendT(c, 93, 'army.ArmyEditRspMsg', { armyPawn: M.armyPawns(p) });
    sendReserve(c);
    bump(c, 34, 0);
  }
  function upgradePawn(c, tid) {
    const p = c.player, [son, r] = reserveOf(p, tid); if (!r) return;
    const t = D.pawns.get(r.tempId), next = D.pawns.get(t.NextLevelTemplateId); if (!next) return;
    const barracks = p.s.buildings.find(b => b.sonType === 402);
    if (!barracks || barracks.grade < next.Level) { alert(c, 'Nível do quartel insuficiente'); return; }
    const cost = ((D.upgrade.get(1) || []).find(u => u.TemplateId === next.TemplateId) || {}).Data || 0;
    if (p.s.gold < cost) { alert(c, 'Ouro insuficiente'); return; }
    p.s.gold -= cost; r.tempId = next.TemplateId;
    if (p.s.army.tempId && (D.pawns.get(p.s.army.tempId) || {}).SonType === son) p.s.army.tempId = next.TemplateId;
    p.save();
    sendCastle(c);
    sendT(c, 116, 'army.ArmyPawnInfoMsg', M.reservePawn(p, son));
    sendArmy(c);
    chat(c, `${pawnName(next.TemplateId)} do nível ${next.Level} evoluiu para o nível`);
    refreshQuests(c);
  }
  function demob(c, tid, n) {
    const p = c.player, [son, r] = reserveOf(p, tid); if (!r) return;
    n = Math.min(n, r.count); if (n <= 0) return;
    const gold = Math.floor(n * ((D.pawns.get(r.tempId) || {}).GoldConsume || 0) / 10);
    r.count -= n; p.s.gold += gold; p.save();
    sendCastle(c);
    alert(c, `Dispensado com sucesso, você ganhou ${gold} ouro`);
    sendReserve(c, [son]);
  }

  // ===================================================================================================
  const H = {
    G_LOGIN_GATEWAY(c, body) {
      const m = c.decode('player.LoginReqMsg', body);
      c.recvKey.set(m.ekeys); c.sendKey.set(m.ekeys);
      const a = db.byUserId(m.playerId);
      if (!a || !a.char) { log(`[#${c.id}] unknown player ${m.playerId}`); c.ws.close(); return; }
      // key = md5(per-login password set by L_PREPARE_LOGIN). Cookie proves the browser session when present;
      // some browsers omit cookies on WS to a different port (LAN IP), so a matching key alone is enough
      // after a successful login-server handoff. A cookie for a *different* account is still rejected.
      const AUTH = require('../auth');
      if (AUTH.ENABLED) {
        const sess = AUTH.session(c.cookie);
        const keyOk = !!(a.password && m.key === AUTH.md5(a.password));
        const sessOk = !sess || sess.userName === a.userName;
        if (!keyOk || !sessOk) {
          log(`[#${c.id}] gateway refused for player ${m.playerId} from ${c.ip}` +
            ` (key=${keyOk ? 'ok' : 'bad'} cookie=${c.cookie ? (sess ? sess.userName : 'unknown') : 'none'} want=${a.userName})`);
          c.ws.close(); return;
        }
      }
      c.account = a; c.clientId = a.userId; c.player = playerFor(a);
      // the same account already in game: the old session gets 3842 U_G_LOGIN_OTHER (the client shows the
      // message with a logout button) and is closed; its later requests are ignored (net.js) and its close
      // does not run the leave hooks, the player stays online through this session
      const old = online.get(c.player.id);
      if (old && old !== c) {
        old.replaced = true;
        if (old.battle && old.battle.engine) old.battle.engine.stop();
        old.battle = null;
        try { sendT(old, 3842, 'gateway.GatewayMsg', { notifyMsg: 'Sua conta foi acessada de outro lugar.' }); } catch (e) { }
        const ws = old.ws; setTimeout(() => { try { ws && ws.close(); } catch (e) { } }, 2000);
        log(`[#${c.id}] ${a.char.nickName} logged in again: session #${old.id} replaced`);
      }
      for (const fn of ctx.onLogin) fn(c);
      online.set(c.player.id, c);
      c.quiet = new Set(['U_C_SYNCHRONIZED_TIME']);
      log(`[#${c.id}] gateway login ${a.char.nickName} lv${c.player.s.grades} novice ${c.player.s.newNoviceProcess} tutorialDone ${c.player.s.tutorialDone}`);
      c.sendPacket(3841, { raw: Buffer.alloc(0) }, c.clientId);
      sendPlayer(c);
      sendSystemsOpen(c);
      sendStatic(c, STATIC_LOGIN);
      sendArmy(c);
      sendReserve(c);
    },
    C_LONIG_LOAD_REQ(c, body) {
      const m = c.decode('player.PlayerDataMsg', body), p = c.player;
      if (m.castle || m.build) {                       // the big initial load
        sendCastle(c);
        sendStatic(c, STATIC_LOAD);
        // the server's own zone (the recorded one was America/New_York): the client converts event times with
        // formatTimeZone(t, offset) = t + browserOffset + offset, so a foreign offset shifts every countdown
        sendT(c, 362, 'player.TimeZoneMsg', { castleZoneId: Intl.DateTimeFormat().resolvedOptions().timeZone, castleOffset: -new Date().getTimezoneOffset() * 60000 });
        for (const fn of ctx.onLoad) fn(c);
        sendT(c, 4245, 'simple.SNSInfoMsg', Object.assign({ headId: p.s.icon }, p.s.sns || {}, { userId: p.id, nickname: p.s.nickName, sex: p.s.sex, job: p.s.job }));   // profile (playerops.js CH_SNS_UPDATE)
        sendT(c, 4160, 'player.SystemPropertyMsg', { sysCurtime: sysTime(), sysStarTime: sysTime(new Date(p.s.created)) });
        sendT(c, 4154, 'building.BuildingInfoListMsg', p.s.tutorialDone ? M.buildingList(p) : { result: true, building: [] });
        if (p.s.tutorialDone) ensureOrders(c);
        sendT(c, 4155, 'building.BuildOrderList', { buildOrder: (p.s.orders || []).map(o => orderMsg(p, o)) });
        sendT(c, 4153, 'army.BaseCastleMsg', M.castleMsg(p));
        sendArmy(c);
        sendReserve(c);
        if (p.s.bag.length || Object.keys(p.s.equip).length)
          sendItems(c, [...p.s.bag, ...Object.values(p.s.equip)].map(it => M.movedEntry(p, it)));
      }
      // state 2 = the castle (as the official login): with no state, from Lv. 15 (ENTER_SPACE) the client picks no scene -> black screen
      if (m.user) sendT(c, 6, 'player.LoginStateMsg', { playerId: p.id, state: 2 });
      if (m.quest) {
        sendStatic(c, STATIC_QUEST);
        if (!p.s.tutorialDone) sendT(c, 4598, 'simple.PropertyMsg', { param1: 10000 });   // sends a fresh character into the tutorial
        // after onLoad (pet follow %, guard handbook, artifacts, …) refresh both FC and attribute details
        sendPlayer(c); sendArmy(c); sendQuests(c); autoAccept(c);
      }
    },
    C_SYNCHRONIZED_TIME(c) { sendT(c, 4234, 'player.SynchronizedTimeMsg', { sysCurtime: sysTime(), sysMillisecond: Date.now() }); },
    // C_FASHION_INFO: features/fashion.js (301 + 4542 moda kitabı)
    U_C_PLAYER_NOVICE(c, body) {
      const m = c.decode('novice.NoviceReqMsgMsg', body), p = c.player;
      if (m.noviceProcess > p.s.noviceProcess) p.s.noviceProcess = m.noviceProcess;
      if (m.sonNoviceProcess) p.s.sonNoviceProcess = m.sonNoviceProcess;
      if (m.newNoviceProcess) {
        p.s.newNoviceProcess = Math.max(p.s.newNoviceProcess || 0, m.newNoviceProcess);
        p.s.noviceNodes = p.s.noviceNodes || [];
        if (!p.s.noviceNodes.includes(m.newNoviceProcess)) p.s.noviceNodes.push(m.newNoviceProcess);   // the finished guide nodes (msg.js noviceNodes)
      }
      p.save();
      c.sendPacket(1, { raw: Buffer.alloc(0) }, c.clientId);
      refreshQuests(c);
    },
    U_C_QUEST_ADD(c, body) {
      const m = dec(c, 'U_C_QUEST_ADD', body), p = c.player;
      for (const id of m.questId || []) {
        if (!D.quests.has(id) || p.s.quests.active[id] || p.s.quests.done.includes(id)) continue;
        p.s.quests.active[id] = { c: [0, 0, 0, 0], complete: false, addDate: sysTime() };
      }
      p.save();
      sendQuests(c, Object.keys(p.s.quests.active).map(Number));
      refreshQuests(c);
    },
    U_C_QUEST_FINISH(c, body) {
      const m = dec(c, 'U_C_QUEST_FINISH', body), p = c.player, id = m.templateId, q = p.s.quests.active[id];
      if (!q) return;
      refreshQuests(c, [id]);
      if (!q.complete) return;
      const t = D.quests.get(id);
      delete p.s.quests.active[id]; p.s.quests.done.push(id);
      const entries = [];
      for (const g of D.questGoods.get(id) || []) if (!g.ToJob || g.ToJob === p.s.job) for (const it of p.addItem(g.RewardItemID, g.RewardItemCount)) entries.push(M.movedEntry(p, it));
      if (t.RewardGold) { p.s.gold += t.RewardGold; sendCastle(c); }
      sendItems(c, entries);
      if (t.RewardPlayGP) giveExp(c, t.RewardPlayGP);
      p.save();
      sendPlayer(c); sendArmy(c);
      // summary as the official server words it: "Ganho: Ouro 10,000, EXP 6,000, Tapınak Rahibi Asası x1"
      const got = [];
      if (t.RewardGold) got.push(`Ouro ${t.RewardGold.toLocaleString('en-US')}`);
      if (t.RewardPlayGP) got.push(`EXP ${t.RewardPlayGP.toLocaleString('en-US')}`);
      for (const g of D.questGoods.get(id) || []) if (!g.ToJob || g.ToJob === p.s.job) got.push(`${itemName(g.RewardItemID) || g.RewardItemID} x${g.RewardItemCount}`);
      if (got.length) alert(c, 'Ganho: ' + got.join(', '));
      sendT(c, 52, 'quest.QuestFinishedRspMsg', { templateId: id });
      sendQuests(c, []);
      questBuildings(c, id);
      if (QUEST_ORDERS[id] && !ordersOf(p, QUEST_ORDERS[id]).length) addOrder(c, QUEST_ORDERS[id]);
      autoAccept(c);
    },
    // ---- campaign ----
    C_CAMPAIGN_START(c, body) {
      const m = c.decode('campaign.CampaignReqMsg', body);
      // same code as U_C_CAMPAIGN_ENTER (5039): the group scene's start goes through here too (grouproom.js)
      if (ctx.groupStart && ctx.groupStart(c, m)) return;
      if (!CAMPAIGN_MAPS.get(m.paraInt2)) { log(`[#${c.id}] unknown campaign ${m.paraInt2}`); return; }
      if (!spendWeary(c, CAMPAIGN_WEARY)) return;
      startCampaign(c, m.paraInt2);
    },
    U_C_CAMPAIGN_TRAINING(c) {
      const p = c.player;
      if (p.s.tutorialDone) return;                   // sent again when the tutorial ends; the castle follows
      enterCampaign(c, (p.s.campaign && E.TUTORIAL_MAPS.has(p.s.campaign.campaignId)) ? p.s.campaign.campaignId : TUTORIAL_CAMPAIGN);
      if (M.REF[143]) sendRaw(c, 143, M.REF[143].raw);
      sendQuests(c);
    },
    U_C_CAMPAIGN_SYSTEM_ARMY(c, body) {
      const m = dec(c, 'U_C_CAMPAIGN_SYSTEM_ARMY', body);
      let o = SYSARMY.get(m.paraInt1);
      if (!o) {   // the enemies of the campaign's maps: boss heroes and soldier types
        const heroes = new Set(), soldiers = new Set();
        for (const mp of CAMPAIGN_MAPS.get(campaignOf(m.paraInt1)) || [{ Id: m.paraInt1 }])
          for (const cd of D.campNodesByCampaign.get(mp.Id) || []) {
            if (!fightable(cd)) continue;
            if (cd.Heros) heroes.add(Number(String(cd.Heros).split(',')[0]));
            for (const part of String(cd.Soldiers || '').split('|').filter(Boolean)) soldiers.add(Number(part.split(',')[0]));
          }
        o = { heroTemplated: [...heroes], soldierTemplated: [...soldiers] };
      }
      sendT(c, 20, 'campaign.SystemArmyMsg', o);
    },
    U_C_CAMPAIGN_TAKE_CARD(c) {
      const p = c.player, st = p.s.campaign; if (!st || !st.finished || st.cardTaken) return;
      const camp = campaignOf(st.campaignId), rec = CARD.get(camp);
      const card = rec ? M.clone(rec) : { templateId: -100, count: ((D.campaigns.get(camp) || {}).BaseGp || 500) * 4, bind: true };
      Object.assign(card, { playerId: p.id, name: p.s.nickName });
      st.cardTaken = true;
      if (card.templateId === -100) p.s.gold += card.count;
      else sendItems(c, p.addItem(card.templateId, card.count || 1).map(it => M.movedEntry(p, it)));
      p.save();
      sendCastle(c);
      sendT(c, 26, 'campaign.CampaignTakeCardsMsg', card);
      chat(c, card.templateId === -100 ? `Ganho: Ouro ${card.count.toLocaleString('en-US')}` : `Ganho: ${itemName(card.templateId)} x${card.count || 1}`);
    },
    U_C_CAMPAIGN_FINISH(c) {
      const p = c.player;
      p.s.campaign = null; p.save();
      sendRaw(c, 134);
      sendT(c, 6, 'player.LoginStateMsg', { playerId: p.id, state: 2 });
    },
    U_PLAYER_CLIENT_STATE() {},
    U_C_CAMPAIGN_SYNCPOS(c, body) {
      const m = dec(c, 'U_C_CAMPAIGN_SYNCPOS', body), st = c.player.s.campaign;
      const last = (m.routes || [])[m.routes.length - 1];
      if (st && last) { st.posX = Math.round(last.x / 20); st.posY = Math.round(last.y / 20); }
    },
    U_C_CAMPAIGN_FOG_UPDATE(c, body) {
      const m = dec(c, 'U_C_CAMPAIGN_FOG_UPDATE', body), p = c.player, st = p.s.campaign;
      if (!st) return;
      const seen = ((p.s.fog = p.s.fog || {})[st.campaignId] = p.s.fog[st.campaignId] || {});
      const list = (m.dataList || []).filter(d => d.index >= 0);
      for (const d of list) seen[d.index] = Math.max(seen[d.index] || 0, d.fogByte);
      p.save();
      sendT(c, 19, 'campaign.CampaignFogUpdateMsg', { fogUpdate: list.map(d => ({ index: d.index, fogByte: d.fogByte })) });
    },
    C_NODE_LOCKSTATE(c, body) {
      const m = dec(c, 'C_NODE_LOCKSTATE', body);
      if (!c.player.s.campaign || !m.lock) return;
      const ev = trigger(c, 'lock:' + m.nodeId);
      if (ev) replayEvents(c, ev.events);
    },
    U_C_CAMPAIGN_ARRIVE(c, body) {
      const m = dec(c, 'U_C_CAMPAIGN_ARRIVE', body), p = c.player, st = p.s.campaign;
      const cd = D.campNodes.get(m.paraInt1); if (!cd || !st) return;
      for (const fn of ctx.onArrive) if (fn(c, cd)) return;   // a feature took this node (e.g. maze portals)
      const state = stateOf(p, cd);
      if (cd.MasterType === 62 && (cd.MoveToNodeIds || []).length) {          // portal to the next map
        const target = D.campNodes.get(cd.MoveToNodeIds[0]);
        const ev = trigger(c, 'arrive:' + cd.Id); if (ev) replayEvents(c, ev.events);
        if (target) enterCampaign(c, target.CampaignId, [target.Property1, target.Property2], 3);
        return;
      }
      if (state === 8) return;                                                 // already cleared
      if (/CNItemAi/.test(cd.AI || '')) {                                      // pick-up node: item per job (Param3)
        const list = String(cd.Param3 || '').split('|').map(Number).filter(Boolean);
        const tid = list[(p.s.job - 1) % list.length];
        const ev = trigger(c, 'arrive:' + cd.Id); if (ev) replayEvents(c, ev.events);
        if (tid && D.items.has(tid)) { sendItems(c, p.addItem(tid).map(it => M.movedEntry(p, it))); alert(c, `Obtido: ${itemName(tid)}`); }
        nodeUpdate(c, cd, 8); p.save();
        return;
      }
      if (cd.MasterType === 41 && !fightable(cd)) {                            // exit: campaign finished, back to the world
        H.U_C_CAMPAIGN_FINISH(c);
        sendArmy(c); sendT(c, 140, 'army.MapUpdatedMsg', { updatedType: 3, army: M.mapArmy(p, 0) });
        return;
      }
      const ev = trigger(c, 'arrive:' + cd.Id);
      if (ev) replayEvents(c, ev.events);
      const plotFirst = /Plot/.test(cd.AI || '') && !(st.plotShown || {})[cd.Id];
      if (plotFirst && ev && ev.events.some(e => e.code === 138)) { (st.plotShown = st.plotShown || {})[cd.Id] = true; return; }
      if (fightable(cd) && (!ev || ev.battle || !/Plot/.test(cd.AI || '') || (st.plotShown || {})[cd.Id])) startNodeBattle(c, cd);
    },
    U_C_CAMPAIGN_CALLBACK(c, body) {
      const m = dec(c, 'U_C_CAMPAIGN_CALLBACK', body), st = c.player.s.campaign; if (!st) return;
      const ev = trigger(c, 'callback:' + m.nodeId + ':' + m.cmd);
      if (ev) replayEvents(c, ev.events);
      const cd = D.campNodes.get(m.nodeId);
      // plot bosses: once their dialogue closes the fight starts (this client doesn't re-send ARRIVE)
      const plotDone = cd && /Plot/.test(cd.AI || '') && (st.plotShown || {})[cd.Id];
      if (cd && fightable(cd) && stateOf(c.player, cd) !== 8 && ((ev && ev.battle) || plotDone)) startNodeBattle(c, cd);
    },
    // map objects the client asks to confirm (U_C_CAMPAIGN_CONFIRM {paraInt2: campDataId, paraBool1: yes}):
    //  CNTreasureBoxAi "Gizemli Hazine": costs one key (Param2, İskelet Chave 208005), node -> 8 with
    //   param1 = Param1 (-300), loot = the drop t_s_dropcondition type 22 gives that node (capture: Lv. 1
    //   Büyülü Cristal + Lv. 6/7 Şans Taşı, as drop 22001 rolls)
    //  CNTombStoneAi (graves): Param5 "tid,_,count,weight|..." one weighted entry once per character
    //   (capture: "Obtido: 5,000 Ouro" as 126 U_C_MSG + chat; the node stays, the visitor is listed)
    // The recorded replies used before replayed the official character's key count and loot.
    U_C_CAMPAIGN_CONFIRM(c, body) {
      const m = dec(c, 'U_C_CAMPAIGN_CONFIRM', body), p = c.player, st = p.s.campaign;
      const cd = D.campNodes.get(m.paraInt2);
      if (!st || !cd || !m.paraBool1) return;
      if (stateOf(p, cd) === 8) { alert(c, 'Já foi aberto'); return; }
      const ai = String(cd.AI || '');
      if (/CNTreasureBoxAi/.test(ai)) {
        const key = cd.Param2;
        if (key && p.countTemplate(key) < 1) { alert(c, `${itemName(key) || 'Chave'} necessário`); return; }
        const drop = (BOX_DROP.get(cd.Id) || 0);
        const loot = drop ? DROPS.roll(drop) : [];
        if (loot.length && !grant(c, loot, { quiet: true })) { alert(c, 'Mochila cheia'); return; }
        if (key) sendItems(c, p.takeTemplate(key, 1).map(x => M.movedEntry(p, x, x.count <= 0)));
        nodeUpdate(c, cd, 8, { param1: cd.Param1 || 0 });
        p.save();
        if (loot.length) { const text = 'Obtido:' + loot.map(([t, n]) => `${rewardName(t)} x${n}`).join(', '); alert(c, text); chat(c, text); }
        log(`[#${c.id}] treasure ${cd.Id}: ${JSON.stringify(loot)}`);
        return;
      }
      if (/CNTombStoneAi/.test(ai)) {
        const seen = st.visited = st.visited || {};
        if (seen[cd.Id]) { alert(c, 'Já foi visitado'); return; }
        const opts = String(cd.Param5 || '').split('|').map(x => x.split(',').map(Number)).filter(x => x.length >= 4);
        const total = opts.reduce((n, o) => n + o[3], 0);
        let r = Math.random() * total, pick = opts[0];
        for (const o of opts) { r -= o[3]; if (r < 0) { pick = o; break; } }
        seen[cd.Id] = true;
        if (pick && pick[2] > 0) {
          grant(c, [[pick[0], pick[2]]], { quiet: true });
          const text = `Obtido: ${pick[2].toLocaleString('en-US')} ${pick[0] === -100 ? 'Ouro' : rewardName(pick[0])}`;
          sendT(c, 126, 'campaign.CampaignNotifyMsg', { id: 2, scene: 'CAMPAIGN_MAP_SCENE', mapId: 1, body: text });
          chat(c, text);
        }
        nodeUpdate(c, cd, 1, { visitUserIds: [p.id], sonType: cd.SonType });
        p.save();
        return;
      }
      log(`[#${c.id}] confirm on ${cd.Id} (${ai.split('.').pop() || 'no AI'}) not implemented`);
    },
    // "skip battle": the rest of the fight is decided at once and its end sent (no remaining actions)
    B_BATTLE_OVER(c) {
      const b = c.battle; if (!b || !b.engine) return;
      b.engine.send = () => {};
      if (!b.engine.started) { b.engine.started = true; b.engine.t0 = Date.now(); b.engine.nextTurn(); }
      if (b.engine.timer) { b.engine.timers.clear(b.engine.timer); b.engine.timer = null; }
      b.engine.finishNow();
    },
    // the client finished loading the fight: start the server-driven timeline
    U_B_USER_LOADOVER(c) { if (!c.battle) return; sendT(c, 156, 'battle.BattleStartMsg', { mainType: c.battle.type || 6 }); c.battle.engine.start(); },
    U_B_HERO_ORDER(c, body) { const m = dec(c, 'U_B_HERO_ORDER', body); heroOrder(c, m.skillId, m.heroIndexId, m.targetIndexs); },
    // a carried rune from the battle skill bar (client sendUseItemInBattle, the Uy rune skill): the same order as
    // U_B_HERO_ORDER, answered with 158 ItemUseResultMsg {result 0 ok, livingId, tempId = the rune's
    // BattleItemMsg tempId, count = uses left after this one} (client __useBattleItemServerBack)
    B_USE_ITEM(c, body) {
      const m = dec(c, 'B_USE_ITEM', body), b = c.battle; if (!b) return;
      const me = b.units.find(u => u.playerHero), left = me && me.runes ? me.runes[m.skillTempId] || 0 : 0;
      const me0 = b.prepHero, item = ((me0 && me0.item) || RUNE.battleItems(c.player)).find(x => x.skillTempId === m.skillTempId);
      if (!me || left <= 0 || me.hp <= 0) { sendT(c, 158, 'battle.ItemUseResultMsg', { result: 1, livingId: me ? me.livingId : 0, tempId: item ? item.tempId : 0, count: 0 }); return; }
      b.engine.order(m.skillTempId);
      sendT(c, 158, 'battle.ItemUseResultMsg', { result: 0, livingId: me.livingId, tempId: item ? item.tempId : 0, uItemId: item ? item.uItemId : 0, count: left - 1, type: 0 });
    },
    // AttackModeMsg.mode: 0 manual, otherwise auto (the server then picks the hero's skills)
    B_SET_ATUO_ATTACK(c, body) { if (!c.battle) return; const m = dec(c, 'B_SET_ATUO_ATTACK', body); c.battle.engine.auto = (m.mode || 0) !== 0; },
    B_PAUSE_FINISHED() {},
    U_B_USR_STOP_CMD(c) { c.sendPacket(69, { raw: Buffer.alloc(0) }, c.clientId); },
    C_FIGHT_SPECIAL_BOSS(c) {
      const tpl = S.find(st => !st.client && st.code === 157 && st.obj && st.obj.battleType === 15);
      if (tpl) startBattle(c, null, rw(c).packet(tpl).obj);
    },
    // ---- castle / buildings ----
    C_ENTER_CASTLE(c) { initBuildings(c.player); c.player.save(); },
    C_BUILDING_INIT(c) {
      const p = c.player; initBuildings(p); p.save();
      // characters that finished the unlocking quests before this rule existed get those buildings now
      for (const q of Object.keys(QUEST_BUILDINGS).map(Number)) if (p.s.quests.done.includes(q)) questBuildings(c, q, true);
      sendCastle(c);
      sendReserve(c);
      sendBuildings(c);
      const first = !ordersOf(p, ORDER_BUILD).length;
      ensureOrders(c);
      if (first) sendT(c, 104, 'building.OrderInfoMsg', { orderId: ordersOf(p, ORDER_BUILD)[0].id, orderType: ORDER_BUILD });
    },
    C_LOAD_BUILD_ORDER(c) { ensureOrders(c); sendT(c, 4187, 'building.BuildOrderList', { buildOrder: (c.player.s.orders || []).map(o => orderMsg(c.player, o)) }); },
    C_BUILDING_UPGRADE(c, body) { const m = dec(c, 'C_BUILDING_UPGRADE', body); upgradeBuilding(c, m.buildingId); },
    U_C_CASTLE_UPDATE(c) { sendCastle(c); },
    // ---- troops ----
    U_C_ARMY_RECRUITED(c, body) { const m = dec(c, 'U_C_ARMY_RECRUITED', body); recruit(c, m.tempateId, m.ownPawns); },
    U_C_ARMY_EDIT(c, body) { const m = dec(c, 'U_C_ARMY_EDIT', body); editArmy(c, m.tempateId, m.ownPawns); },
    U_C_ARMY_UPGRADEPAWN(c, body) { const m = dec(c, 'U_C_ARMY_UPGRADEPAWN', body); upgradePawn(c, m.tempateId); },
    U_C_ARMY_DEMOBPAWN(c, body) { const m = dec(c, 'U_C_ARMY_DEMOBPAWN', body); demob(c, m.tempateId, m.ownPawns); },
    // troop conversion (client PawnChangeWnd): every reserve troop of the first type becomes the second type
    // (an unlocked one, at its own level); PawnChange_NeedPoint (200) diamonds (payType 1, 3 = bound first) or
    // PawnChange_NeedStrategy (500,000) gold (payType 0; client checks gold.count). Our reading: counts move.
    C_PAWN_CHANGE(c, body) {
      const m = dec(c, 'C_PAWN_CHANGE', body), p = c.player, [, from] = reserveOf(p, m.curPawnTempId), [sonTo, to] = reserveOf(p, m.tarPawnTempId);
      if (!from || !to || from === to) { alert(c, 'Soldado inválido'); return; }
      if (!from.count) { alert(c, 'Nenhum soldado para converter'); return; }
      const cost = m.payType === 0 ? [[-100, CONF.get('PawnChange_NeedStrategy') || 500000]]
        : [[m.payType === 3 && balance(p, -500) >= (CONF.get('PawnChange_NeedPoint') || 200) ? -500 : -400, CONF.get('PawnChange_NeedPoint') || 200]];
      if (!pay(c, cost)) { alert(c, m.payType === 0 ? 'Ouro insuficiente' : 'Diamantes insuficientes'); return; }
      const n = from.count; to.count += n; from.count = 0;
      const [sonFrom] = reserveOf(p, m.curPawnTempId);
      p.save();
      sendT(c, 100, 'army.ArmyPawnUpdatedMsg', M.reservePawns(p, [sonFrom, sonTo]));
      sendArmy(c); sendCastle(c);
      alert(c, `${n} asker ${pawnName(to.tempId)} ficou`);
    },
    C_ARMYPOS_EDIT(c) { bump(c, 34, 0); },
    // ---- bag ----
    U_C_BAG_USEITEM(c, body) {
      const m = dec(c, 'U_C_BAG_USEITEM', body), p = c.player;
      const bt = m.bagType == null ? 1 : m.bagType;
      let it = p.itemAt(m.pos, bt);
      // client sometimes omits bagType; also try the main bag if the keyed slot is empty
      if (!it && bt !== 1) it = p.itemAt(m.pos, 1);
      if (!it) { log(`[#${c.id}] use item: empty pos=${m.pos} bagType=${bt}`); return; }
      const tp = D.items.get(it.templateId);
      if (!tp) { log(`[#${c.id}] use item: unknown template ${it.templateId}`); return; }
      const nUse = Math.min(m.count || 1, it.count);
      if (ctx.useItem[tp.SonType]) { ctx.useItem[tp.SonType](c, it, tp, nUse); return; }   // features (by SonType)
      if (ctx.useItem[it.templateId]) { ctx.useItem[it.templateId](c, it, tp, nUse); return; }   // features (by TemplateId, e.g. Santo Graal)
      if (tp.MasterType === 2 && DROPS.has(tp.Property1)) { openDropBox(c, it, tp, nUse); return; }
      // pet EXP book (Property1 15 → the pet in war; client SONTYPE_PET_EXP_BOOK, data often SonType 208)
      if (tp.Property1 === 15 && ctx.usePetExpBook) { ctx.usePetExpBook(c, it, tp, nUse); return; }
      if (tp.MasterType === 2 && tp.SonType === 203) { useConsumable(c, it, tp, nUse); return; }
      if (tp.MasterType === 2 && [298, 206].includes(tp.SonType)) openBox(c, it);
      else if (EQUIP_POS[tp.SonType]) equip(c, it);
      else log(`[#${c.id}] use item ${it.templateId} (${tp.TemplateName_pt || tp.TemplateName_tr || tp.TemplateName_en}) son=${tp.SonType} not implemented`);
    },
    // bag types (client hr.*): 0 forge slot (Hide; pos 0 = equipment, 1 = luck stone), 1 bag, 4 hero equipment
    U_C_BAG_MOVE(c, body) {
      const m = dec(c, 'U_C_BAG_MOVE', body), p = c.player;
      const from = m.beginBagType, to = m.endBagType;
      if (from === 1 && to === ITEM_HERO_BAG) { const it = p.itemAt(m.beginPos); if (it) equip(c, it); return; }
      if (from === ITEM_HERO_BAG && to === 1) { unequip(c, m.beginPos, m.endPos); return; }
      if (((from === 1 || from === USER_STORAGE) && (to === 1 || to === USER_STORAGE)) || (from === RUNE_BAG_TYPE && to === RUNE_BAG_TYPE)) { storeMove(c, from, m.beginPos, to, m.endPos); return; }
      if (ctx.bagMove.some(f => f(c, m))) return;   // features (pet equipment bag 28: features/petartifact.js)
      if (from !== FORGE_BAG && to !== FORGE_BAG) { log(`[#${c.id}] bag move ${from}->${to} not implemented`); return; }
      const it = from === ITEM_HERO_BAG ? p.s.equip[m.beginPos] : p.itemAt(m.beginPos, from);
      if (!it) return;
      const entries = [];
      if (to === ITEM_HERO_BAG) {                        // forge slot -> straight onto the hero
        entries.push({ changeType: FORGE_BAG, changeObjId: 0, changePos: it.pos });
        it.bagType = 1; it.pos = p.freePos();
        sendItems(c, entries); equip(c, it); return;
      }
      // leaving: hero slot or bag slot becomes empty
      if (from === ITEM_HERO_BAG) { delete p.s.equip[m.beginPos]; p.s.bag.push(it); entries.push({ changeType: 4, changeObjId: p.heroId, changePos: m.beginPos }); }
      else entries.push({ changeType: from, changeObjId: 0, changePos: it.pos });
      let pos = m.endPos;
      if (to === FORGE_BAG) {                            // an item already in that forge slot goes back to the bag
        const old = p.itemAt(pos, FORGE_BAG);
        if (old && old !== it) { old.bagType = 1; old.pos = p.freePos(); entries.push(M.movedEntry(p, old)); }
      } else if (to === 1 && (pos < 0 || p.itemAt(pos))) pos = p.freePos();
      it.bagType = to; it.pos = pos;
      if (from === ITEM_HERO_BAG) { sendPlayer(c); sendArmy(c); }
      entries.push(M.movedEntry(p, it));
      sendItems(c, entries);
      p.save();
    },
    C_BAG_ARRANGE(c, body) {   // sort the bag by template, close the gaps (or apply the client's map)
      const m = body && body.length ? dec(c, 'C_BAG_ARRANGE', body) : {}, p = c.player;
      const bt = m.bagType || 1;
      const bag = p.s.bag.filter(i => (i.bagType ?? 1) === bt);
      const before = bag.map(i => i.pos);
      if (m.arrangeInfo && m.arrangeInfo.length) {
        const byPos = new Map(bag.map(i => [i.pos, i]));
        const planned = m.arrangeInfo.map(a => ({ it: byPos.get(a.oldplace), to: a.newplace })).filter(x => x.it);
        for (const { it } of planned) it.pos = -1 - it.pos;   // free source cells so swaps don't collide
        for (const { it, to } of planned) it.pos = to;
      } else {
        bag.sort((a, b) => a.templateId - b.templateId).forEach((it, i) => { it.pos = i; });
      }
      const used = new Set(bag.map(i => i.pos));
      // save first: a throw mid-send used to leave the in-memory bag rearranged while the client kept the old map
      p.save();
      sendItems(c, [...new Set(before)].filter(x => !used.has(x)).map(pos => ({ changeType: bt, changeObjId: 0, changePos: pos })).concat(bag.map(it => M.movedEntry(p, it))));
    },
    U_C_HERO_SETFASTKEY(c, body) {
      const m = dec(c, 'U_C_HERO_SETFASTKEY', body);
      c.player.s.fastKey = String(m.fastKey).split(',').filter(x => x !== '').map(Number); c.player.save();
      sendT(c, 64, 'army.HeroFastKeyMsg', { fastKey: m.fastKey, setResult: true });   // the official server confirms (capture)
    },
    // requests without native logic: the reply the official server gave the first time (static data)
    onUnhandled(c, name, h, body) {
      const runs = c.player && REPLY.get(h.code);
      if (runs) {
        c.replyN = c.replyN || {};
        const n = c.replyN[h.code] = (c.replyN[h.code] || 0) + 1;
        const r = runs[Math.min(n, runs.length) - 1];
        sendStatic(c, r); log(`[#${c.id}] <- ${name}(${h.code}) recorded reply #${n} x${r.length}`); return;
      }
      log(`[#${c.id}] <- ${name}(${h.code}) unhandled`);
    },
    onClose(c) {
      if (c.battle && c.battle.engine) c.battle.engine.stop();
      if (c.replaced) return;   // a newer session of the same account is in game
      if (c.player && online.get(c.player.id) === c) online.delete(c.player.id);
      for (const fn of closeHooks) fn(c);
    },
  };

  // ---- feature modules: server/game/features/*.js export (ctx) => ({ REQUEST_NAME(c, body) {...} }) ----
  // A request handled above keeps its native handler; a feature handler replaces the recorded reply.
  const closeHooks = [];
  const beforeHooks = new Map();
  const ctx = {
    before: (name, fn) => { if (!beforeHooks.has(name)) beforeHooks.set(name, []); beforeHooks.get(name).push(fn); },
    log, cfg, db, D, M, DROPS, table, sysTime, online, players, dec,
    sendT, sendRaw, sendItems, sendPlayer, sendCastle, sendArmy, sendQuests, chat, alert, storeMove, freeIn,
    nameOf, itemName,
    giveExp, bump, refreshQuests, completeAllQuests, sendSystemsOpen, checkSystemsOpen, startBattle, startPvp, startPetPvp, startCampaign, hasCampaignMaps: id => CAMPAIGN_MAPS.has(id), grant, pay, balance, rewardName, stat,
    onStat: fn => statHooks.push(fn),
    useItem: {},             // SonType -> fn(c, item, template, count): bag item use handled by a feature
    spendWeary, CAMPAIGN_WEARY, produceGold, CONF,
    orders: { remainOf, orderMsg, addOrder, ensureOrders, ordersOf, useOrder, BUILD: ORDER_BUILD, TECH: ORDER_TECH, LEVY: ORDER_LEVY },
    CAMPAIGN_MAPS, campaignCard: camp => CARD.get(camp),
    // send by S2C name: code from codes.json, proto type from codemap (no hand-typed codes)
    // (type: for codes codemap couldn't map, taken from the client handler's readBody)
    sendN: (c, name, obj, type) => {
      const code = S2C_CODE[name], t = type ? { type } : codemap.s2c[name] || codemap.s2c[name.replace(/^U_/, '')];
      if (code === undefined || !t) throw new Error('unknown S2C ' + name);
      sendT(c, code, t.type, obj);
    },
    // "tid,count|tid,count" (table reward strings) -> [[tid, count], ...]
    parseRewards: s => String(s || '').split('|').map(x => x.split(',').map(Number)).filter(([t, n]) => t && n),
    // a player's state whether online or not (offline players are loaded from disk)
    playerById: id => {
      let p = players.get(id); if (p) return p;
      if ((p = Player.load(id))) players.set(id, p);
      return p;
    },
    onClose: fn => closeHooks.push(fn),
    onExp: [],   // fn(c, n) after the hero gained n EXP
    bagMove: [],             // fn(c, ItemReqMsg) -> true when the feature handled a bag move
    onLogin: [],             // fn(c) after gateway login, before the connection is listed in online
    onLoad: [],
    events: require('./eventflags'),
    onCampaignCleared: [],   // fn(c, campaignId, campaignState) when a run is finished
    onBattleEnd: [],         // fn(c, node, won) after a campaign map fight
    onArrive: [],            // fn(c, node) -> true when the feature handled the arrival
    onEnterMap: [],          // fn(c, mapId, campaignState) when a campaign map is entered, before its node list
    enterMap: (c, mapId, pos, createdType, opts) => enterCampaign(c, mapId, pos, createdType, opts || {}),
    finishCampaign: c => H.U_C_CAMPAIGN_FINISH(c),
    nodeUpdate: (c, cd, state, extra) => nodeUpdate(c, cd, state, extra),
    nodeUpdate: (c, cd, state, extra) => nodeUpdate(c, cd, state, extra), stateOf: (p, cd) => stateOf(p, cd),
    startCampaign: (...a) => startCampaign(...a), CAMPAIGN_OF: id => campaignOf(id),              // fn(c) with the big initial C_LONIG_LOAD_REQ (client models are set up)
  };
  for (const f of fs.readdirSync(FEATURES).filter(f => f.endsWith('.js')).sort()) {
    for (const [k, fn] of Object.entries(require(path.join(FEATURES, f))(ctx))) {
      // native handlers win; a prior feature may be replaced by a later one that owns the request
      if (H[k] && !H[k].__feature) { log(`feature ${f}: ${k} is already handled natively, skipped`); continue; }
      fn.__feature = f;
      H[k] = fn;
    }
  }
  // ctx.before(name, fn): features run fn(c, body) before an existing handler (e.g. leave the town square
  // when a campaign starts)
  for (const [name, fns] of beforeHooks) {
    const orig = H[name] || ((c, body, h) => H.onUnhandled(c, name, h, body));
    H[name] = (c, body, h) => { for (const fn of fns) { try { fn(c, body); } catch (e) { log(`[#${c.id}] before ${name} threw`, e.stack); } } return orig(c, body, h); };
  }
  return H;
};
