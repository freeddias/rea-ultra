// Scripted campaign events. Campaign maps are driven server-side by Java AI classes we don't have
// (CNPlotAi, CNTransNodeAi, ...); their visible effects (dialogue, movies, camera, NPC moves/escort,
// node state flips) are taken from the official-server capture (capture/*.jsonl ->
// data/official_script.json), per trigger. Everything else is computed natively.
const { SCRIPT: OFFICIAL, OFFICIAL_REF } = require('../rewrite');

const SCRIPTED = new Set([143, 138, 142, 4162, 4124, 4122, 4105, 128, 4208, 4100, 6007, 141]);
const BATTLE_START = 157;
const TUTORIAL_MAPS = new Set([10001, 10002]);

function keyOf(code, obj) {
  if (!obj) return null;
  if (code === 5125) return 'arrive:' + obj.paraInt1;          // U_C_CAMPAIGN_ARRIVE (campDataId)
  if (code === 5032) return 'callback:' + obj.nodeId + ':' + obj.cmd;
  if (code === 8196) return obj.lock ? 'lock:' + obj.nodeId : null;
  return null;
}

// "<map>|<key>" -> [ {events: [step], battle: bool, ref} ] in recorded order (one entry per occurrence)
const TABLE = new Map();
let map = 0;
for (let i = 0; i < OFFICIAL.length; i++) {
  const st = OFFICIAL[i];
  if (!st.client && st.code === 125 && st.obj && st.obj.room) map = st.obj.room.campaignId;
  if (!st.client && st.code === 21 && st.obj && st.obj.player && st.obj.player[0]) map = st.obj.player[0].campaignId || map;
  if (!st.client) continue;
  const k = keyOf(st.code, st.obj);
  if (!k) continue;
  const events = [];
  let battle = false;
  for (let e = i + 1; e < OFFICIAL.length && !OFFICIAL[e].client; e++) {
    const s = OFFICIAL[e];
    if (s.code === BATTLE_START) battle = true;
    if (SCRIPTED.has(s.code)) events.push(s);
  }
  const full = map + '|' + k;
  if (!TABLE.has(full)) TABLE.set(full, []);
  TABLE.get(full).push({ events, battle, ref: OFFICIAL_REF });
}

// Node states the official server started each map with (its first 127 node list per campaign): the AI
// classes override t_s_campaigndata NodeState, e.g. on 10001 Tina (1000107) is 2 "friendly" and the portal
// (1000108) 16 until the bear is beaten; with the table's 1 the client walks to Tina as an enemy.
// "<map>|<campDataId>" -> state
const INIT_STATE = new Map();
{
  const seen = new Set();
  for (const st of OFFICIAL) {
    if (st.client || st.code !== 127 || !st.obj || !st.obj.node || !st.obj.node.length) continue;
    const camp = Math.floor(st.obj.node[0].campDataId / 100);   // campDataId = map * 100 + n
    if (seen.has(camp)) continue;
    seen.add(camp);
    for (const n of st.obj.node) INIT_STATE.set(camp + '|' + n.campDataId, n.state);
  }
}
// What a won node fight changed on the map: the 128 node updates after the battle report (4103) up to the
// next arrival (they can follow the client's novice steps, e.g. the portal opening after "novice 90").
// "<map>|<node instance id of the beaten node>" -> [step]; the beaten node itself (state 8) is left out.
const AFTER_WIN = new Map();
{
  let m = 0;
  for (let i = 0; i < OFFICIAL.length; i++) {
    const st = OFFICIAL[i];
    if (!st.client && st.code === 125 && st.obj && st.obj.room) m = st.obj.room.campaignId;
    if (!st.client && st.code === 21 && st.obj && st.obj.player && st.obj.player[0]) m = st.obj.player[0].campaignId || m;
    if (st.client || st.code !== 4103 || !st.obj || st.obj.battleResult !== 1) continue;
    let beaten = 0;
    const effects = [];
    for (let e = i + 1; e < OFFICIAL.length; e++) {
      const s = OFFICIAL[e];
      if (s.client && (s.code === 5125 || s.code === 5032)) break;   // next arrival / callback: a new step
      if (s.client || s.code !== 128 || !s.obj) continue;
      if (!beaten && s.obj.nodeState === 8) { beaten = s.obj.nodeId; continue; }
      effects.push(s);
    }
    if (beaten && effects.length && !AFTER_WIN.has(m + '|' + beaten)) AFTER_WIN.set(m + '|' + beaten, effects);
  }
}
const initState = (map, campDataId) => INIT_STATE.get(map + '|' + campDataId);
const afterWin = (map, nodeInstanceId) => AFTER_WIN.get(map + '|' + nodeInstanceId) || null;

function lookup(map, key, n) {
  const l = TABLE.get(map + '|' + key);
  if (!l || !l.length) return null;
  return l[Math.min(n, l.length - 1)];
}

module.exports = { lookup, keyOf, TABLE, SCRIPTED, TUTORIAL_MAPS, OFFICIAL, initState, afterWin, INIT_STATE, AFTER_WIN };
