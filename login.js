// Login server: createLogin -> getPlayerList -> prepareLogin (-> registerRole) -> hand off to gateway.
// With passwords on (auth.js), the account is the one of the browser's session cookie: the name typed into
// the game's own login window (it has no password field) is ignored, so typing someone else's name does
// nothing. No session -> VERIFY_ERROR (the client shows its "verification failed" text).
const db = require('./db');
const cfg = require('./config');
const auth = require('./auth');
const sites = require('./sites');
const { sysTime } = require('./util');

const NO_ROLE = 'Login Succeed No Visualize';   // SH.SUCCEED_NOVISUALIZE -> client opens character creation
const VERIFY_ERROR = 7;                          // client rZ.VERIFY_ERROR

// LAN: Host + GATE_PORT. Cloudflare: full wss://… (or …/gate) from netconfig.
function gateInfo(c) {
  const host = String((c && c.host) || cfg.HOST).replace(/^\[|\]$/g, '');
  return require('./netconfig').gateInfo(host || cfg.HOST);
}

module.exports = (log) => {
  // the account name this connection may use: the session's, or (passwords off) what the client sent
  function name(c, typed) {
    if (!auth.ENABLED) return typed;
    const s = auth.session(c.cookie);
    return s ? s.userName : null;
  }
  return {
    L_CREATE_LOGIN(c, body) {
      const m = c.decode('login.createLoginReq', body);
      const site = m.site || cfg.SITE_NAME, userName = name(c, m.userName);
      log(`[#${c.id}] createLogin`, { typed: m.userName, userName, site, from: m.from, platId: m.platId, ip: c.ip });
      if (!userName) {
        log(`[#${c.id}] refused: no password session (open the page again and log in)`);
        return c.send('U_L_CREATE_LOGIN_RSP', { userName: m.userName, site, result: VERIFY_ERROR });
      }
      const info = sites.find(site);
      if (!info || !info.isOpen) {
        log(`[#${c.id}] refused: site ${site} missing or closed`);
        return c.send('U_L_CREATE_LOGIN_RSP', { userName, site, result: VERIFY_ERROR });
      }
      c.session.userName = userName; c.session.site = site;
      // Remember selected server for HTTP nicknamecheck (client never sends site there).
      const se = auth.session(c.cookie);
      if (se) { se.pendingSite = site; db.save(); }
      db.account(userName, site);
      c.send('U_L_CREATE_LOGIN_RSP', { userName, site, result: 0 });
    },
    L_GET_PLAYER_LIST(c, body) {
      const m = c.decode('login.GetPlayerListReq', body);
      const userName = c.session.userName || name(c, m.userName); if (!userName) return;
      const a = db.account(userName, m.site || c.session.site);
      const infoList = a.char ? [{ userId: a.userId, nickName: a.char.nickName }] : [];
      c.send('U_L_GET_PLAYER_LIST', { infoList, userName: a.userName, site: a.site, loginState: 0 });
    },
    L_PREPARE_LOGIN(c, body) {
      const m = c.decode('login.playerLoginReq', body);
      const userName = c.session.userName || name(c, m.userName); if (!userName) return;
      const a = db.account(userName, m.site || c.session.site);
      a.password = m.password;   // the client's per-login value; the gateway key is md5(it) (logic.js checks)
      db.save();
      c.send('U_L_PREPARE_LOGIN', {
        userName: a.userName, site: a.site, result: true, userId: a.userId,
        message: a.char ? 'Login Succeed' : NO_ROLE, todayFirstLogin: false, ...gateInfo(c),
      });
    },
    L_REGISTER_ROLE(c, body) {
      const m = c.decode('login.registerRoleReq', body);
      log(`[#${c.id}] registerRole`, m);
      const userName = c.session.userName || name(c, m.userName); if (!userName) return;
      const site = m.site || c.session.site;
      const a = db.account(userName, site);
      if (a.char) {
        log(`[#${c.id}] registerRole already has char ${a.char.nickName} — sending gate again`);
        return c.send('U_L_REGISTER_ROLE_RSP', { userName: a.userName, site: a.site, value: true, type: 0, message: 'ok', userId: a.userId, ...gateInfo(c) });
      }
      // Nick unique only within this server; same nick on another site is fine.
      const nick = m.nickName;
      const taken = Object.values(db.state.accounts).some(x =>
        x.site === site && x.char && x.char.nickName === nick && x.userId !== a.userId);
      if (taken) {
        log(`[#${c.id}] registerRole nick taken on ${site}: ${nick}`);
        return c.send('U_L_REGISTER_ROLE_RSP', {
          userName: a.userName, site: a.site, value: false, type: 0,
          message: 'login.nicknameExists', userId: a.userId,
        });
      }
      // RegisterSWnd icons: 1..3 male, 4..6 female; job = (icon-1)%3+1 (1 warrior, 2 archer, 3 mage)
      a.char = { nickName: nick, sex: m.sex, camp: m.camp, icon: m.icon, job: ((m.icon - 1) % 3) + 1, created: Date.now() };
      db.save();
      c.send('U_L_REGISTER_ROLE_RSP', { userName: a.userName, site: a.site, value: true, type: 0, message: 'ok', userId: a.userId, ...gateInfo(c) });
    },
    L_SYNC_TIME(c) {
      c.quiet = c.quiet || new Set(['U_C_SYNCHRONIZED_TIME']);
      c.send('U_C_SYNCHRONIZED_TIME', { sysCurtime: sysTime() });
    },
  };
};
