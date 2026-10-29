// Peri Savaşı (pet campaign; client MH / PetCampaignWnd; t_s_uiplaybase ParentType 1 = Fırtına Tapınağı 100,
// Reese Tapınağı 101, 56 levels each in t_s_uiplaylevel). Client-derived, no capture:
//  C_UIPLAY_CHALLENGE uiplay.UiPlayChallengeMsg {op, playId, levelID}: 0 ENTER_BATTLE (the client wants the pet in
//  war, ConsumeType 0 = ConsumeNum weary), 1 GET_REWARD (first clear reward FristReward of a level reached).
//  4743 U_C_UIPLAY_LIST UserUiPlayListMsg {uiPlayInfoList [UserUiPlayInfoMsg {playId, levelSort = the best level,
//  firstRewardSet [claimed level sorts], uiPlayRewardCount}], uiPlayRewardCount}; 4744 U_C_UIPLAY_INFO one of them.
//  Rewards (Reward drop, mostly pet equipment) for pet_battle_count (10) wins a day (client leftRewardCount).
//  Battle type 40 PET_CAMPAIGN against the level boss (BossId "heroTemplate,pos"); the pet in war rides along.
// Our choices: a level is open when its sort <= best + 1; weary is spent when the fight starts; wins beyond the
// daily count still raise the best level but give nothing; Kayıp Kule (ParentType 2, C_CONFUSION_TOWER) is apart.
const DROPS = require('../drops');

module.exports = (ctx) => {
  const { D, table, dec, sendT, alert, grant, CONF, sysTime, log } = ctx;
  const PLAYS = table('t_s_uiplaybase').filter(r => r.ParentType === 1).map(r => r.UiPlayId);
  const LEVELS = new Map(table('t_s_uiplaylevel').filter(r => PLAYS.includes(r.UiPlayId)).map(r => [r.UiLevelId, r]));
  const DAILY = CONF.get('pet_battle_count') || 10;
  const day = () => sysTime().slice(0, 10);
  function state(p) {
    const s = p.s.petCampaign = p.s.petCampaign || { plays: {} };
    if (s.day !== day()) Object.assign(s, { day: day(), rewards: 0 });
    for (const id of PLAYS) s.plays[id] = s.plays[id] || { best: 0, first: [] };
    return s;
  }
  const info = (s, id, extra = {}) => Object.assign({ playId: id, levelSort: s.plays[id].best, firstRewardSet: s.plays[id].first.slice(), uiPlayRewardCount: s.rewards }, extra);
  const sendList = c => { const s = state(c.player); sendT(c, 4743, 'uiplay.UserUiPlayListMsg', { uiPlayInfoList: PLAYS.map(id => info(s, id)), uiPlayRewardCount: s.rewards }); };
  ctx.onLoad.push(sendList);
  const roll = id => { const got = new Map(); for (const [t, n] of DROPS.roll(id)) got.set(t, (got.get(t) || 0) + n); return [...got]; };

  return {
    C_UIPLAY_CHALLENGE(c, body) {
      const m = dec(c, 'C_UIPLAY_CHALLENGE', body), p = c.player, s = state(p), lv = LEVELS.get(m.levelID);
      if (!lv || lv.UiPlayId !== m.playId) return sendList(c);
      const ps = s.plays[lv.UiPlayId];
      if (m.op === 1) {
        if (lv.UiLevelSort > ps.best || ps.first.includes(lv.UiLevelSort)) { alert(c, 'Esta recompensa não pode ser recebida'); return; }
        if (!grant(c, roll(lv.FristReward))) { alert(c, 'Mochila cheia'); return; }
        ps.first.push(lv.UiLevelSort); p.save();
        return sendT(c, 4744, 'uiplay.UserUiPlayInfoMsg', info(s, lv.UiPlayId));
      }
      if (c.battle) return;
      if (lv.UiLevelSort > ps.best + 1) { alert(c, 'Conclua a fase anterior primeiro'); return; }
      if (p.s.grades < (lv.Grade || 0)) { alert(c, `Lv. ${lv.Grade} necessário`); return; }
      if (!ctx.petBattle || !ctx.petBattle(p)) { alert(c, 'Envie um silfo para a batalha'); return; }
      if (lv.ConsumeType === 0 && lv.ConsumeNum && !ctx.spendWeary(c, lv.ConsumeNum)) return;
      ctx.startBattle(c, { Heros: lv.BossId, Soldiers: '', BattleType: 40, mapTempId: 1, Level: lv.Grade, onEnd: (won) => {
        if (!won) return;
        ps.best = Math.max(ps.best, lv.UiLevelSort);
        let itemAdd = false;
        if (s.rewards < DAILY) { const got = roll(lv.Reward); if (got.length && grant(c, got)) { s.rewards++; itemAdd = true; } }
        p.save();
        ctx.stat(c, 'petCampaign');   // daily activity Type 48
        sendT(c, 4744, 'uiplay.UserUiPlayInfoMsg', info(s, lv.UiPlayId, { itemAdd }));
        log(`[#${c.id}] pet campaign ${lv.UiLevelId} won (best ${ps.best}, rewards ${s.rewards}/${DAILY})`);
      } });
    },
  };
};
