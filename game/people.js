// Other players as the client shows them: SimplePlayerInfoMsg (profiles, friend list) and FriendInfoMsg
// (friend add / update). Online state 7 as on every captured online friend, 0 offline.
const cfg = require('../config');
const sites = require('../sites');
const ONLINE = 7, OFFLINE = 0;

function playerInfo(p, isOnline) {
  const s = p.s;
  return { userId: p.id, nickName: s.nickName, sexs: s.sex, pics: s.icon, camp: s.camp, state: isOnline ? ONLINE : OFFLINE, grades: s.grades, gp: s.totalGp,
    fightingCapacity: p.fightingCapacity(), job: s.job, headId: s.icon, serverName: sites.showNameOf(s.site) || cfg.SERVER_NAME, parameter1: -1, right: 1 };
}
const snsInfo = p => ({ userId: p.id, nickname: p.s.nickName, headId: p.s.icon });
function friendInfo(p, isOnline, rel = {}) {
  return { userId: p.id, nickName: p.s.nickName, sex: p.s.sex, pic: p.s.icon, grades: p.s.grades, job: p.s.job, fightCapacity: p.fightingCapacity(),
    onlineState: isOnline ? ONLINE : OFFLINE, chatState: isOnline ? (p.s.chatState || ONLINE) : OFFLINE, snsInfo: snsInfo(p),
    relation: rel.relation || 0, groupId: rel.groupId ?? -1, tarRelation: rel.tarRelation || 0, result: true };
}
module.exports = { playerInfo, snsInfo, friendInfo, ONLINE, OFFLINE };
