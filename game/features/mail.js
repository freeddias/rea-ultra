// Mail: list, read, attachments (one / all), delete, player-to-player mail, system mail for other features.
// Client: Pf (requests) / Nf (handlers) in the bundle; mail types Tf: 1 normal, 2 system, 3 battle report, 4 star, 5 pet.
// Attachments: annexN = annexNName = templateId (negative = currency), isAnnexN = already taken.
// Welcome pack (first login) is editable from the admin page and stored in meta "welcomeMail".
const store = require('../../store');
const UNREAD = '2999-01-01 00:00:00';
const VALID_DAYS = 30;
const TYPE = { NORMAL: 1, SYSTEM: 2, BATTLE: 3, STAR: 4, PET: 5 };
const CURRENCIES = new Set([-100, -400, -500, -600, -700, -5500]);
const DEFAULT_WELCOME = {
  title: 'Bem-vindo ao Wartune',
  contents: 'Olá {nick}, boa sorte na sua aventura! Segue um pequeno presente de boas-vindas.',
  annex: [[-100, 5000], [-500, 50]],
};
const pad = n => String(n).padStart(2, '0');
const fmt = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

module.exports = (ctx) => {
  const { sendT, log, grant, dec, online, playerById, D } = ctx;
  const mails = p => (p.s.mails = p.s.mails || []);
  const daysLeft = m => Math.max(0, VALID_DAYS - Math.floor((Date.now() - m.sent) / 86400000));
  const expired = m => daysLeft(m) <= 0 && !m.annex.some(a => !a.taken);

  function info(p, m) {
    const o = {
      id: m.id, mailType: m.type, sendId: m.from || 0, sendNickName: m.fromName, receiveId: p.id, receiveNickName: p.s.nickName,
      sendDate: fmt(new Date(m.sent)), readDate: m.read ? fmt(new Date(m.read)) : UNREAD, title: m.title, contents: m.contents,
      removeDate: UNREAD, validityDate: daysLeft(m), sendType: m.sendType || 0,
    };
    m.annex.forEach((a, i) => Object.assign(o, { [`annex${i + 1}`]: a.tid, [`annex${i + 1}Name`]: a.tid, [`annex${i + 1}Count`]: a.count, [`isAnnex${i + 1}`]: !!a.taken }));
    return o;
  }
  const pushUpdate = (c, list) => list.length && sendT(c, 4131, 'mail.ReceiveMailMsg', { mailInfos: list.map(m => info(c.player, m)) });

  // deliver a mail to any player (online or not). annex: [[templateId, count], ...] (max 5)
  function sendMail(playerId, { title, contents = '', annex = [], type = TYPE.SYSTEM, from = 0, fromName = 'Sistem', sendType = 0 }) {
    const p = playerById(playerId); if (!p) return null;
    p.s.nextMailId = p.s.nextMailId || p.id * 1000 + 1;
    const m = { id: p.s.nextMailId++, type, from, fromName, title, contents, sendType, sent: Date.now(), read: 0,
      annex: annex.slice(0, 5).map(([tid, count]) => ({ tid, count, taken: false })) };
    mails(p).push(m); p.save();
    const c = online.get(playerId);
    if (c) pushUpdate(c, [m]);
    return m;
  }
  ctx.sendMail = sendMail;
  ctx.MAIL_TYPE = TYPE;

  // annex from admin / welcome: [[templateId, count], ...] — allows currency ids (negative)
  function parseAnnex(list, maxPer = 99999) {
    return (Array.isArray(list) ? list : [])
      .map(row => {
        const tid = Math.floor(Number(Array.isArray(row) ? row[0] : row && row.tid));
        const count = Math.min(maxPer, Math.max(1, Math.floor(Number(Array.isArray(row) ? row[1] : row && row.count) || 0)));
        return [tid, count];
      })
      .filter(([tid]) => Number.isFinite(tid) && tid !== 0 && (tid < 0 ? (CURRENCIES.has(tid) || tid <= -100) : !!(D && D.items && D.items.has(tid))));
  }
  function getWelcomePack() {
    const w = store.getMeta('welcomeMail', null);
    const title = String((w && w.title) || DEFAULT_WELCOME.title).slice(0, 40);
    const contents = String(w && w.contents != null ? w.contents : DEFAULT_WELCOME.contents).slice(0, 500);
    const annex = parseAnnex(w && w.annex);
    return { title, contents, annex: annex.length ? annex : DEFAULT_WELCOME.annex.map(a => a.slice()) };
  }
  function setWelcomePack({ title, contents, annex }) {
    const pack = {
      title: String(title || DEFAULT_WELCOME.title).slice(0, 40),
      contents: String(contents != null ? contents : DEFAULT_WELCOME.contents).slice(0, 500),
      annex: parseAnnex(annex),
    };
    if (!pack.annex.length) return { ok: false, error: 'Informe ao menos um anexo válido' };
    store.setMeta('welcomeMail', pack);
    return { ok: true, welcome: pack };
  }
  ctx.parseMailAnnex = parseAnnex;
  ctx.getWelcomePack = getWelcomePack;
  ctx.setWelcomePack = setWelcomePack;
  ctx.WELCOME_DEFAULT = DEFAULT_WELCOME;

  function take(c, m) {
    const open = m.annex.filter(a => !a.taken);
    if (!open.length) return true;
    if (!grant(c, open.map(a => [a.tid, a.count]))) return false;
    for (const a of open) a.taken = true;
    return true;
  }
  function markRead(c, list) {
    const now = Date.now(), fresh = list.filter(m => !m.read);
    for (const m of fresh) m.read = now;
    if (fresh.length) sendT(c, 4854, 'mail.MailReadRspMsg', { mailId: fresh.map(m => m.id), readDate: fmt(new Date(now)), validityDate: VALID_DAYS });
  }

  // first login: welcome mail from admin-configurable pack ({nick} → character name)
  // (login hooks run before the connection counts as online, so nothing is pushed before the client asks)
  ctx.onLogin.push(c => {
    const p = c.player;
    if (p.s.welcomeMail) return;
    p.s.welcomeMail = true;
    const w = getWelcomePack();
    const contents = w.contents.replace(/\{nick\}/gi, p.s.nickName || '');
    sendMail(p.id, { title: w.title, contents, annex: w.annex });
  });

  return {
    C_MAIL_LIST(c) {
      const p = c.player;
      p.s.mails = mails(p).filter(m => !expired(m));
      sendT(c, 4853, 'mail.MailListRspMsg', { mailInfos: p.s.mails.map(m => info(p, m)), curPage: 1, maxPage: 1 });
    },
    // reqType 1 = read, 0 = take attachments of given mail ids, 3 = take all of given mail types
    // (client Pf.getAttachAll(mailTypeList): mailsIdArray = types NORMAL/SYSTEM/STAR/PET/BATTLE, not ids)
    U_C_MAILITEM_MOVE(c, body) {
      const r = dec(c, 'U_C_MAILITEM_MOVE', body), p = c.player;
      const arr = (r.mailsIdArray || []).map(Number).concat(r.mailId ? [Number(r.mailId)] : []);
      const list = r.reqType === 3
        ? mails(p).filter(m => arr.includes(m.type))
        : arr.map(id => mails(p).find(m => m.id === id)).filter(Boolean);
      markRead(c, list);
      if (r.reqType === 1) return;
      const results = []; let full = false;
      for (const m of list) {
        const ok = !full && take(c, m);
        if (!ok) full = true;
        results.push({ mailId: m.id, result: ok });
      }
      p.save();
      sendT(c, 114, 'mail.MailPickupRspMsg', { pickupResult: results, isfull: full });
      pushUpdate(c, list);
      if (full) ctx.alert(c, 'Mochila cheia');
    },
    // reqType 0: delList = mail ids; 1: delList = mail types (only read mails without open attachments)
    U_C_MAIL_DEL(c, body) {
      const r = dec(c, 'U_C_MAIL_DEL', body), p = c.player, del = new Set(r.delList || []);
      const gone = mails(p).filter(m => r.reqType === 1 ? (del.has(m.type) && m.read && !m.annex.some(a => !a.taken)) : del.has(m.id));
      p.s.mails = mails(p).filter(m => !gone.includes(m));
      p.save();
      sendT(c, 4132, 'mail.MailDelReqMsg', { delList: gone.map(m => m.id), reqType: r.reqType || 0 });
    },
    U_C_MAIL_SEND(c, body) {
      const r = dec(c, 'U_C_MAIL_SEND', body), p = c.player;
      let n = 0;
      for (const to of r.receiverUserId || []) {
        if (sendMail(to, { type: TYPE.NORMAL, from: p.id, fromName: p.s.nickName, title: r.title, contents: r.contents, sendType: r.sendType })) n++;
        else log(`[#${c.id}] mail to unknown player ${to}`);
      }
      ctx.alert(c, n ? 'Mensagem enviada' : 'Destinatário não encontrado');
    },
  };
};
