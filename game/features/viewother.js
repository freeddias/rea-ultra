// Looking at another player's pets, mount, guards and specialization (the view-player window). These were
// recorded copies, so every player looked like the official "insanejoe67" (Amazon Kraliçesi Lv47 ...).
// Pets, mounts, guards and specializations do not exist on this server yet, so the answer for any of our
// players is "none", in the official server's own form for a player without them:
//  pets      4608 PetDetailMsg {item: [], petmsg: {petInfo: []}}
//  mount     4459 with an empty body (capture: the recorded character asking about itself, no mount)
//  guards    op 13: "Nenhum guarda entrou em batalha" (capture)
//  extrajob  451 {activeList: [], equipList: [], targetUserid} (capture: already empty for that player)
module.exports = (ctx) => {
  const { dec, sendT, alert } = ctx;
  return {
    C_GET_PLAYER_PET_INFO(c, body) {
      const m = dec(c, 'C_GET_PLAYER_PET_INFO', body);
      const other = ctx.playerById(m.targetUserid), infos = other && ctx.petInfos ? ctx.petInfos(other) : [];   // features/pets.js
      const item = other ? other.s.bag.filter(i => i.bagType === 28).map(i => ctx.M.itemMsg(other, i)) : [];   // worn artifacts (features/petartifact.js)
      sendT(c, 4608, 'pet.PetDetailMsg', { item, petmsg: { userId: m.targetUserid, nickName: other ? other.s.nickName : '', petInfo: infos } });
    },
    // C_MOUNT_INFO_SEND: features/mount.js
    // C_GUARD_REQ: features/guards.js (op 13 = another player's guard in battle)
    C_USER_EXTRAJOB_REQ(c, body) {
      const m = dec(c, 'C_USER_EXTRAJOB_REQ', body);
      const other = ctx.playerById(m.targetUserid), view = other && ctx.masteryView ? ctx.masteryView(other) : { activeList: [], equipList: [] };   // features/mastery.js
      sendT(c, 451, 'extrajob.UserExtraJobMsg', Object.assign({ targetUserid: m.targetUserid }, view));
    },
  };
};
