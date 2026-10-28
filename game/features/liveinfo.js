// Small requests whose official answer is an info message (or nothing), from the 2026-10-23 live capture, for systems
// this server does not run (cross-server war field, guild city war, mate lords, warlords, voice chat, payment):
//  C_OUT_CITY_WAR_All_NODE -> 440 OutCityWarStateMsg {castleStateMsg [{nodeId, state, leftTime, guildMsg [..]}]}:
//    here no city war is fought, so the list is empty.
//  C_OUT_CITY_VEHICLE_INFO, C_CHARGE_LOTTERY_V2_ACTIVE_REQ, C_ALL_CHANGE_OP, C_USER_BIND_QUERY, C_DISCOUNT_MALL_OP,
//    C_NEW_YEAR_BOX_ACTIVE: no reply in the capture (the recorded copies they had were other requests' packets).
//  C_CHECK_WARFIELD_COUNT: features/warfield.js
//  C_MATE_MAININFO -> 4799 MateLordsListMsg {info, isOpen, openTime, maxTurnCount 10, currentTurn, warIndex}: closed here.
//  C_FETCH_TOKEN {userId} -> 4721 FetchTokenRsp {token} (a voice chat token; ours is random, there is no voice server).
//  C_LOAD_LORDS_MAINBORAD -> 4529 LordsOrderListMsg {lordsInfo}: the cross-server warlords board; empty here.
//  C_DRAGON_CRYSTAL_MINING {op 0} -> 807 DragonCrystalRoomRes {mineList, roomId} + 828 records (capture's first call:
//    mineList empty); the mines are taken by other servers' players there, none here.
//  C_GROWTH_FUND_INFO -> 4706 GrowthFundDataInfoRsp {fundMsg, isPay, isOpen}: the real-money growth fund, not bought
//    (capture: isPay 4, isOpen 1).
//  C_NEW_ACTIVE_OP {activeId 10001} -> 508 LordPrivilegePlayerInfoRes {betweenDay} (capture 23): days since the
//    character was made.
//  C_REBATE_DATA {op 1} -> 4463 UserRebateMsg {packagestates}: recharge rebates; none (no recharge here).
//  U_C_CONSORTIA_ALTERINFO -> 4142 ConsortiaAltarInfoMsg x2 (the guild altar's prize lists; data/altar.json from the
//    older capture, the altar spin itself is not built).
const ALTAR = require('../../data/altar.json');

module.exports = (ctx) => {
  const { dec, sendT, alert } = ctx;
  const none = () => {};
  // Ultra / GM: Lord Privilege Card (state 1 = purchased / isRecharge)
  ctx.grantLordPrivilege = c => {
    const p = c.player;
    p.s.lordPriv = { active: true, receiveDay: p.s.lordPriv && p.s.lordPriv.receiveDay || 0, since: p.s.lordPriv && p.s.lordPriv.since || Date.now() };
    p.save();
    const days = Math.max(1, Math.ceil((Date.now() - (p.s.created || Date.now())) / 864e5));
    sendT(c, 508, 'active.LordPrivilegePlayerInfoRes', { state: 1, receiveDay: p.s.lordPriv.receiveDay || 0, betweenDay: days });
    return 'Cartão de Privilégio do Lorde ativado';
  };
  // Growth fund bought: client hasBuyGrowthFund = (isPay !== 1)
  ctx.grantGrowthFund = c => {
    c.player.s.growthFund = { bought: true, recNum: (c.player.s.growthFund && c.player.s.growthFund.recNum) || 0 };
    c.player.save();
    sendT(c, 4706, 'fund.GrowthFundDataInfoRsp', { fundMsg: [], isPay: 0, recNum: c.player.s.growthFund.recNum || 0, isOpen: 1 });
    return 'Fundo de Crescimento ativado';
  };
  return {
    C_OUT_CITY_WAR_All_NODE(c) { sendT(c, 440, 'outcitywar.OutCityWarStateMsg', { castleStateMsg: [] }); },
    C_OUT_CITY_VEHICLE_INFO: none,
    // C_CHARGE_ORDER / C_TOKEN_CHARGE: features/charge.js
    C_CHARGE_LOTTERY_V2_ACTIVE_REQ: none,
    C_ALL_CHANGE_OP: none,
    C_USER_BIND_QUERY: none,
    C_DISCOUNT_MALL_OP: none,
    C_NEW_YEAR_BOX_ACTIVE: none,
    C_MATE_MAININFO(c) { sendT(c, 4799, 'matelords.MateLordsListMsg', { info: [], isOpen: false, maxTurnCount: 10, currentTurn: 0, warIndex: 0 }); },
    C_FETCH_TOKEN(c) { sendT(c, 4721, 'voice.FetchTokenRsp', { token: require('crypto').randomBytes(16).toString('hex').toUpperCase() }); },
    C_LOAD_LORDS_MAINBORAD(c) { sendT(c, 4529, 'lucky.LordsOrderListMsg', { lordsInfo: [] }); },
    C_DRAGON_CRYSTAL_MINING(c, body) {
      const m = dec(c, 'C_DRAGON_CRYSTAL_MINING', body);
      if (m.op) { alert(c, 'Mina de Cristal do Dragão não está aberta neste servidor'); return; }
      sendT(c, 807, 'dragoncrystal.DragonCrystalRoomRes', { mineList: [], roomId: 1 });
      sendT(c, 828, 'dragoncrystal.DragonCrystalRecordPB', {});
    },
    C_GROWTH_FUND_INFO(c) {
      const g = c.player.s.growthFund || {};
      sendT(c, 4706, 'fund.GrowthFundDataInfoRsp', { fundMsg: [], isPay: g.bought ? 0 : 1, recNum: g.recNum || 0, isOpen: 1 });
    },
    C_NEW_ACTIVE_OP(c, body) {
      const m = dec(c, 'C_NEW_ACTIVE_OP', body);
      if (m.activeId !== 10001) return;
      const p = c.player, days = Math.max(1, Math.ceil((Date.now() - (p.s.created || Date.now())) / 864e5));
      const lp = p.s.lordPriv || {};
      sendT(c, 508, 'active.LordPrivilegePlayerInfoRes', { state: lp.active ? 1 : 0, receiveDay: lp.receiveDay || 0, betweenDay: days });
    },
    C_REBATE_DATA(c) { sendT(c, 4463, 'rebate.UserRebateMsg', { packagestates: [] }); },
    U_C_CONSORTIA_ALTERINFO(c) { for (const l of ALTAR.lists) sendT(c, 4142, 'consortia.ConsortiaAltarInfoMsg', l); },
  };
};
