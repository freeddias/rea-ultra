// Anket (client bp questionnaire, QuestionnaireFrame; t_s_question holds the questions on the client side).
// Client-derived, no capture: at Questionnaire_level (15) a running questionnaire is announced with 4428
// U_C_QUESTIONNARIE_LIST questionnarie.QuestionnarieInfoMsg {id, title, content, starTime, endTime (ms)} — the top
// bar shows its button while id is set and endTime is ahead. C_QUESTIONNARIE_ANSWER
// (QuestionDataRspMsg {isFirst: 1 save / 2 finish, id, infolist [{questId, answer}]}) -> 4429 (the same message,
// the client hides the button); finishing gives Questionnaire_reward ("id,n|...") once.
// Our choice: one questionnaire (id 1) open for 30 days from each announcement; answers are kept on the player.
module.exports = (ctx) => {
  const { dec, sendT, grant, CONF, log } = ctx;
  const LEVEL = Number(CONF.get('Questionnaire_level')) || 15;
  const REWARD = String(CONF.str('Questionnaire_reward') || '').split('|').filter(Boolean).map(x => x.split(',').map(Number));
  const ID = 1;
  const announce = c => {
    const p = c.player, q = p.s.questionnaire || {};
    if (q.done || p.s.grades < LEVEL) return;
    const now = Date.now();
    sendT(c, 4428, 'questionnarie.QuestionnarieInfoMsg', { id: ID, title: 'Pesquisa do Jogador', content: 'Sua opinião é importante. Preencha a pesquisa e receba a recompensa!', starTime: now, endTime: now + 30 * 86400000 });
  };
  ctx.onLoad.push(announce);

  return {
    C_QUESTIONNARIE_ANSWER(c, body) {
      const m = dec(c, 'C_QUESTIONNARIE_ANSWER', body), p = c.player;
      const q = p.s.questionnaire = p.s.questionnaire || { done: false, answers: {} };
      for (const a of m.infolist || []) q.answers[a.questId] = String(a.answer || '').slice(0, 500);
      if (m.isFirst === 2 && !q.done && p.s.grades >= LEVEL) {
        q.done = true;
        grant(c, REWARD);
        log(`[#${c.id}] questionnaire finished (${Object.keys(q.answers).length} answers)`);
      }
      p.save();
      sendT(c, 4429, 'questionnarie.QuestionDataRspMsg', { isFirst: m.isFirst || 0, id: ID, infolist: Object.entries(q.answers).map(([questId, answer]) => ({ questId: Number(questId), answer })) });
    },
  };
};
