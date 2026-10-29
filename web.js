// Local stand-ins for 7Road's HTTP services.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const http = require('./http');
const cfg = require('./config');
const netconfig = require('./netconfig');
const env = require('./env');

module.exports = (log) => {
  const clientHost = req => String(req.headers.host || '').replace(/:\d+$/, '') || cfg.HOST;
  const isHttps = req => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || !!req.socket.encrypted;

  const SITE_CFG = path.join(require('./paths').WEB, 'siteConfig.json');
  http.route('/siteConfig.json', (req, res) => {
    const host = clientHost(req);
    const httpBase = netconfig.httpBase(host);
    let raw = fs.readFileSync(SITE_CFG, 'utf8');
    if (netconfig.active()) {
      raw = raw
        .replace(/https?:\/\/127\.0\.0\.1:\d+/g, httpBase)
        .replace(/https?:\/\/localhost:\d+/g, httpBase)
        .replace(/127\.0\.0\.1/g, httpBase.replace(/^https?:\/\//i, ''))
        .replace(/localhost/g, httpBase.replace(/^https?:\/\//i, ''));
    } else {
      raw = raw.replace(/127\.0\.0\.1/g, host).replace(/localhost/g, host);
    }
    const pay = `${httpBase}/order?`;
    raw = raw.replace(/"PAY"\s*:\s*""/, `"PAY": ${JSON.stringify(pay)}`);
    raw = raw.replace(/"(siteOrder|ORDER_PATH)"\s*:\s*"[^"]*"/g, (_, k) => `"${k}": ${JSON.stringify(httpBase + '/order/')}`);
    http.send(res, 200, raw, 'application/json');
  });

  http.route('/order/clientsiteinfoservlet', (req, res, body) => {
    const host = clientHost(req);
    const authMod = require('./auth');
    // Embed session token in loginUrl — CF tunnels often omit Cookie on WebSocket handshake.
    const rawTok = authMod.cookies(req.headers.cookie)[authMod.COOKIE];
    let loginUrl = netconfig.loginWsUrl(host);
    if (rawTok) {
      try {
        const u = new URL(loginUrl);
        u.searchParams.set('wt', rawTok);
        loginUrl = u.toString();
      } catch (e) {
        loginUrl += (loginUrl.includes('?') ? '&' : '?') + 'wt=' + encodeURIComponent(rawTok);
      }
    }
    const sitesMod = require('./sites');
    const sites = {};
    for (const s of sitesMod.list()) {
      sites['s' + s.siteId] = {
        siteId: s.siteId, showName: s.showName, type: 1, siteName: s.siteName,
        loginUrl, webUrl: `${netconfig.httpBase(host)}/web`,
        mainSite: s.siteName, isOpen: !!s.isOpen, isRepair: !!s.isRepair, order: s.order || s.siteId,
      };
    }
    const list = {
      isWhiteUser: true, platformId: 1, platformName: 'local', ret: 0, msg: '', curTime: Date.now(),
      groups: { g1: { groupId: 1, groupName: 'Servidores', order: 1, sites } },
    };
    http.send(res, 200, zlib.deflateSync(Buffer.from(JSON.stringify(list))), 'application/octet-stream');
  });

  // Client sends only nickname (+rnd/type); never site. Scope uniqueness per server only —
  // resolve site from query, else the WS createLogin stamp on the auth session. If still
  // unknown, allow (registerRole enforces the same rule with the real site).
  http.route('/web/nicknamecheck', (req, res, body) => {
    const q = new URLSearchParams(body.toString());
    const name = q.get('nickname') || '';
    const se = require('./auth').session(req.headers.cookie);
    const site = q.get('site') || (se && se.pendingSite) || null;
    const taken = !!site && Object.values(require('./db').state.accounts)
      .some(a => a.site === site && a.char && a.char.nickName === name);
    http.send(res, 200, `<?xml version="1.0" encoding="utf-8"?><Result value="${!taken}" message="${taken ? 'login.nicknameExists' : 'ok'}" />`, 'text/xml');
  });

  const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  http.route('/imgNetSpeedTest.png', (req, res) => http.send(res, 200, PNG1, 'image/png'));

  http.route('/clientlog', (req, res, body) => {
    require('fs').appendFileSync(require('path').join(__dirname, 'logs/client.log'), new Date().toISOString() + ' ' + body.toString() + '\n');
    log('CLIENT', body.toString().slice(0, 300));
    http.send(res, 204, '');
  });

  http.route('/web/xml/zip_dirty.txt', (req, res) => http.send(res, 200, ''));
  http.route('/web/xml/proxy_dirty.txt', (req, res) => http.send(res, 200, ''));

  const auth = require('./auth');
  const PAGE = require('fs').readFileSync(require('path').join(__dirname, 'login_page.html'));
  if (auth.ENABLED) http.setGate(req => {
    const se = auth.session(req.headers.cookie);
    const q = new URLSearchParams(String(req.url).split('?')[1] || '');
    return se && q.get('user') === se.userName && q.get('from') === 'WAN' ? null : PAGE;
  });

  http.route('/me', (req, res) => {
    const se = auth.ENABLED && auth.session(req.headers.cookie);
    const a = se && Object.values(require('./db').state.accounts).find(x => x.userName === se.userName && x.site === se.site);
    const isAdmin = !!(se && env.isAdminUser(se.userName));
    http.send(res, 200, JSON.stringify({
      user: se ? se.userName : null,
      nickName: (a && a.char && a.char.nickName) || null,
      isAdmin,
    }), 'application/json');
  });

  http.route('/auth', (req, res, body) => {
    let m = {}; try { m = JSON.parse(body.toString()); } catch (e) { }
    const ip = req.socket.remoteAddress;
    const mode = m.mode === 'register' || m.mode === 'login' ? m.mode : undefined;
    const r = auth.login(String(m.user || '').trim(), m.pass, cfg.SITE_NAME, { allowClaim: auth.isLocal(ip), mode });
    log(`auth ${m.user} from ${ip}: ${r.ok ? (r.created ? 'new account' : 'ok') : r.error}`);
    if (!r.ok) return http.send(res, 200, JSON.stringify({ ok: false, error: r.error }), 'application/json');
    const flags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(auth.SESSION_MS / 1000)}${isHttps(req) ? '; Secure' : ''}`;
    res.setHeader('Set-Cookie', `${auth.COOKIE}=${r.token}; ${flags}`);
    http.send(res, 200, JSON.stringify({ ok: true, created: r.created, isAdmin: env.isAdminUser(m.user) }), 'application/json');
  });

  http.route('/logout', (req, res) => {
    auth.logout(req.headers.cookie);
    res.setHeader('Set-Cookie', `${auth.COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? '; Secure' : ''}`);
    http.send(res, 200, '<meta http-equiv="refresh" content="0;url=/">', 'text/html; charset=utf-8');
  });
};
