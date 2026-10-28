// Lonca görevleri (ConsortiaTaskWnd; client Ug senders, ConsortiaModel.initTaskInfo). Client-derived:
//  a task = a t_s_consortiatask row (NeedGrade player level, NeedTaskLevel <= guild level, Weight) with a star
//  1..5 (ConsortiaTask_Random weights 30/50/50/30/10); hand in CountStar<star> of NeedItemId (items or
//  currencies: -5800 Lonca Katkısı = own guild offer, -1000 Fragmento de Símbolo ...). Types 1..3 have their own
//  wording in the client; all are hand-ins here.
//  rewards (t_s_consortiataskreward, RewardNumStar<star>): fixId = the Site 0 rows (-6100 Lonca Tedariği to
//  the guild wealth, -6300 task score to the guild's weekly score), rewardId = one weighted row of each
//  Site 1..5 whose NeedTaskLevel <= guild level (-6200 Gelişim Puanı, gold, items ...) to the player.
//  C_CONSORTIA_TASK_INFO -> 454 AllTaskInfoMsg {oneTask, recoredInfo, score, finishNum, rewardStatus, update}
//  C_CONSORTIA_TASK_REFRESH {payType}: ConsortiaTask_RefreshNum (3) free a day, then ConsortiaTask_PaidRefreshNum
//   (5) for ConsortiaTask_PaidRefreshPrice (10) diamonds; C_CONSORTIA_TASK_UPGRADESTAR: +1 star for
//   ConsortiaTask_StarPrice[star-1] (40/60/100/200) diamonds (bound first, client USEBINDPOINT_ALERT)
//  C_CONSORTIA_TASK_REWARD {op 1 hand in, op 2 index}: weekly score boxes at ConsortiaTask_TotalScore
//   (1000..5000), rewards Site 10 + index, once a week per member (rewardStatus "1,0,0,0,0").
//  Week = Monday 05:00 (as the ring tasks). Our choices: the score is the guild's, no daily hand-in limit.
const pad = n => String(n).padStart(2, '0');
function weekKey(d = new Date()) {
  const m = new Date(d.getTime() - 5 * 3600 * 1000);
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())}`;
}
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const SUPPLY = -6100, SCORE = -6300, OFFER = -5800;

module.exports = (ctx) => {
  const { dec, sendT, alert, pay, grant, table, CONF, sysTime, log } = ctx;
  const G = require('../guilds');
  const cfg = n => String((table('t_s_config').find(r => r.ConfigName === n) || {}).ConfigValue || '');
  const nums = n => cfg(n).split(',').map(Number).filter(x => !isNaN(x));
  const TASKS = table('t_s_consortiatask'), REWARDS = table('t_s_consortiataskreward');
  const STAR_W = nums('ConsortiaTask_Random'), STAR_PRICE = nums('ConsortiaTask_StarPrice'), WEEK = nums('ConsortiaTask_TotalScore');
  const FREE = CONF.get('ConsortiaTask_RefreshNum') || 3, PAID = CONF.get('ConsortiaTask_PaidRefreshNum') || 5, PAID_PRICE = CONF.get('ConsortiaTask_PaidRefreshPrice') || 10;
  const weighted = (list, w) => { let x = Math.random() * list.reduce((n, e) => n + w(e), 0); for (const e of list) { x -= w(e); if (x < 0) return e; } return list[list.length - 1]; };
  const guild = p => p.s.guild && G.get(p.s.guild.id);
  const glevel = g => (g && g.levels[1]) || 1;

  function gstate(g) {
    const t = g.task = g.task || {};
    if (t.week !== weekKey()) Object.assign(t, { week: weekKey(), score: 0, records: [] });
    return t;
  }
  function roll(p, g) {
    const pool = TASKS.filter(t => p.s.grades >= (t.NeedGrade || 0) && glevel(g) >= (t.NeedTaskLevel || 0));
    const t = weighted(pool, x => x.Weight || 1);
    const star = 1 + STAR_W.indexOf(weighted(STAR_W, w => w));
    const self = [1, 2, 3, 4, 5].map(site => REWARDS.filter(r => r.Site === site && (r.Weight || 0) > 0 && glevel(g) >= (r.NeedTaskLevel || 0))).filter(l => l.length).map(l => weighted(l, r => r.Weight).Id);
    return { id: t.Id, star: Math.max(1, star), self };
  }
  function state(p, g) {
    let s = p.s.gtask;
    if (!s || s.week !== weekKey()) s = p.s.gtask = { week: weekKey(), claimed: [0, 0, 0, 0, 0], finished: 0, day: '', free: 0, paid: 0, task: null };
    if (s.day !== dayKey()) { s.day = dayKey(); s.free = 0; s.paid = 0; }
    if (!s.task && g) s.task = roll(p, g);
    return s;
  }
  const fixIds = () => REWARDS.filter(r => r.Site === 0).map(r => r.Id);
  const need = s => { const t = TASKS.find(x => x.Id === s.task.id); return [t.NeedItemId, t['CountStar' + s.task.star] || 0]; };
  const have = (p, tid) => tid === OFFER ? ((p.s.guild && p.s.guild.offer) || 0) : ctx.balance(p, tid);
  function send(c, update = 1) {
    const p = c.player, g = guild(p); if (!g) return;
    const s = state(p, g), gt = gstate(g), [tid, n] = need(s);
    sendT(c, 454, 'consortia.AllTaskInfoMsg', { update, score: gt.score, finishNum: s.finished, rewardStatus: s.claimed.join(','),
      oneTask: { taskId: s.task.id, starNum: s.task.star, refreshNum: s.free, payRefreshNum: s.paid, refreshTime: sysTime(), status: have(p, tid) >= n ? 1 : 0,
        process: Math.min(have(p, tid), n), rewardId: s.task.self.join(','), fixId: fixIds().join(',') },
      recoredInfo: gt.records.slice(-20) });
  }

  return {
    C_CONSORTIA_TASK_INFO(c) {
      if (!guild(c.player)) return sendT(c, 454, 'consortia.AllTaskInfoMsg', { recoredInfo: [], score: 0, finishNum: 0, rewardStatus: '0,0,0,0,0' });
      send(c);
    },
    C_CONSORTIA_TASK_REFRESH(c, body) {
      const m = dec(c, 'C_CONSORTIA_TASK_REFRESH', body), p = c.player, g = guild(p); if (!g) return;
      const s = state(p, g);
      if (s.free < FREE) s.free++;
      else if (s.paid < PAID) {
        const bound = m.payType === 0 && ctx.balance(p, -500) >= PAID_PRICE;
        if (!pay(c, [[bound ? -500 : -400, PAID_PRICE]])) { alert(c, 'Diamantes insuficientes'); return send(c); }
        s.paid++;
      } else { alert(c, 'Atualizações de hoje acabaram'); return send(c); }
      s.task = roll(p, g); p.save();
      send(c);
    },
    C_CONSORTIA_TASK_UPGRADESTAR(c, body) {
      const p = c.player, g = guild(p); if (!g) return;
      const s = state(p, g), price = STAR_PRICE[s.task.star - 1];
      if (s.task.star >= 5 || !price) { alert(c, 'Missão na estrela máxima'); return send(c); }
      const bound = ctx.balance(p, -500) >= price;   // the request has no body (client sends payType unattached): bound first
      if (!pay(c, [[bound ? -500 : -400, price]])) { alert(c, 'Diamantes insuficientes'); return send(c); }
      s.task.star++; p.save();
      send(c);
    },
    C_CONSORTIA_TASK_REWARD(c, body) {
      const m = dec(c, 'C_CONSORTIA_TASK_REWARD', body), p = c.player, g = guild(p); if (!g) return;
      const s = state(p, g), gt = gstate(g);
      if (m.op === 2) {
        const i = (m.index || 0) - 1;
        if (i < 0 || i >= WEEK.length || s.claimed[i]) return send(c, 2);
        if (gt.score < WEEK[i]) { alert(c, 'Pontuação semanal insuficiente'); return send(c, 2); }
        const r = REWARDS.filter(x => x.Site === 11 + i).map(x => [x.RewardItemId, x.RewardNumStar1]);
        if (!grant(c, r)) { alert(c, 'Mochila cheia'); return; }
        s.claimed[i] = 1; p.save();
        return send(c, 2);
      }
      const [tid, n] = need(s), star = s.task.star;
      if (have(p, tid) < n) { alert(c, 'Condições da missão não concluídas'); return send(c); }
      const self = s.task.self.map(id => REWARDS.find(r => r.Id === id)).filter(Boolean).map(r => [r.RewardItemId, r['RewardNumStar' + star] || 0]);
      if (tid === OFFER) p.s.guild.offer -= n; else if (!pay(c, [[tid, n]])) return send(c);
      let score = 0;
      for (const r of REWARDS.filter(x => x.Site === 0)) {
        const v = r['RewardNumStar' + star] || 0;
        if (r.RewardItemId === SUPPLY) g.offer = Math.min(G.wealthCap(g), g.offer + v);
        else if (r.RewardItemId === SCORE) score += v;
      }
      gt.score += score;
      gt.records.push({ nickName: p.s.nickName, starNum: star, score, time: Date.now() });
      if (gt.records.length > 50) gt.records.splice(0, gt.records.length - 50);
      G.save();
      grant(c, self);
      s.finished++; s.task = roll(p, g); p.save();
      ctx.stat(c, 'guildTask');
      log(`[#${c.id}] guild task done star ${star}, score +${score}`);
      send(c, 1);
    },
  };
};
