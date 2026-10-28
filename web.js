// Local stand-ins for 7Road's HTTP services.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const http = require('./http');
const cfg = require('./config');

module.exports = (log) => {
  // hostname the browser used to reach us (works for localhost, LAN IP, or HOST override)
  const clientHost = req => String(req.headers.host || '').replace(/:\d+$/, '') || cfg.HOST;

  // rewrite hardcoded 127.0.0.1 in siteConfig so LAN clients hit this machine, not themselves
  const SITE_CFG = path.join(require('./paths').WEB, 'siteConfig.json');
  http.route('/siteConfig.json', (req, res) => {
    const host = clientHost(req);
    let raw = fs.readFileSync(SITE_CFG, 'utf8');
    raw = raw.replace(/127\.0\.0\.1/g, host).replace(/localhost/g, host);
    // PAY opens the local recharge page (order_page.html); trailing ? so client can append &site=&uid=
    const pay = `http://${host}:${cfg.HTTP_PORT}/order?`;
    raw = raw.replace(/"PAY"\s*:\s*""/, `"PAY": ${JSON.stringify(pay)}`);
    http.send(res, 200, raw, 'application/json');
  });

  // server list (POST site=|channelid=|platformid= & username & sign) -> zlib(JSON), parsed by class yo
  http.route('/order/clientsiteinfoservlet', (req, res, body) => {
    const host = clientHost(req);
    const sitesMod = require('./sites');
    const sites = {};
    for (const s of sitesMod.list()) {
      sites['s' + s.siteId] = {
        siteId: s.siteId, showName: s.showName, type: 1, siteName: s.siteName,
        loginUrl: `ws://${host}:${cfg.LOGIN_PORT}/ws`, webUrl: `http://${host}:${cfg.HTTP_PORT}/web`,
        mainSite: s.siteName, isOpen: !!s.isOpen, isRepair: !!s.isRepair, order: s.order || s.siteId,
      };
    }
    const list = {
      isWhiteUser: true, platformId: 1, platformName: 'local', ret: 0, msg: '', curTime: Date.now(),
      groups: { g1: { groupId: 1, groupName: 'Servidores', order: 1, sites } },
    };
    http.send(res, 200, zlib.deflateSync(Buffer.from(JSON.stringify(list))), 'application/octet-stream');
  });

  // character-name availability: XML parsed by client into {Result:{value,message}}
  http.route('/web/nicknamecheck', (req, res, body) => {
    const q = new URLSearchParams(body.toString());
    const name = q.get('nickname') || '';
    const site = q.get('site') || cfg.SITE_NAME;
    const taken = Object.values(require('./db').state.accounts).some(a => a.site === site && a.char && a.char.nickName === name);
    http.send(res, 200, `<?xml version="1.0" encoding="utf-8"?><Result value="${!taken}" message="${taken ? 'login.nicknameExists' : 'ok'}" />`, 'text/xml');
  });

  // bandwidth probe used by the loading screen's KB/s readout (any small image)
  const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  http.route('/imgNetSpeedTest.png', (req, res) => http.send(res, 200, PNG1, 'image/png'));

  // browser-side errors forwarded by index.html
  http.route('/clientlog', (req, res, body) => {
    require('fs').appendFileSync(require('path').join(__dirname, 'logs/client.log'), new Date().toISOString() + ' ' + body.toString() + '\n');
    log('CLIENT', body.toString().slice(0, 300));
    http.send(res, 204, '');
  });

  // dirty-word filter lists (pipe separated); empty = no filtering
  http.route('/web/xml/zip_dirty.txt', (req, res) => http.send(res, 200, ''));
  http.route('/web/xml/proxy_dirty.txt', (req, res) => http.send(res, 200, ''));

  // ---- passwords (auth.js): our own page asks for them before the game loads -------------------------
  const auth = require('./auth');
  const PAGE = require('fs').readFileSync(require('path').join(__dirname, 'login_page.html'));
  if (auth.ENABLED) http.setGate(req => {
    // cookie is per host name: keep whatever host the user typed (localhost or LAN IP)
    // the portal page (login_page.html) first, even with an open session: it shows the account and "Devam et"
    // opens the game as a platform user (?user=..&from=WAN), so the client skips its debug login window
    // (Platform / Hesap / Şifre) and goes straight to the server list (LoginOS)
    const se = auth.session(req.headers.cookie);
    const q = new URLSearchParams(String(req.url).split('?')[1] || '');
    return se && q.get('user') === se.userName && q.get('from') === 'WAN' ? null : PAGE;
  });
  // the portal asks who is logged in
  http.route('/me', (req, res) => {
    const se = auth.ENABLED && auth.session(req.headers.cookie);
    const a = se && Object.values(require('./db').state.accounts).find(x => x.userName === se.userName && x.site === se.site);
    http.send(res, 200, JSON.stringify({ user: se ? se.userName : null, nickName: (a && a.char && a.char.nickName) || null }), 'application/json');
  });
  http.route('/auth', (req, res, body) => {
    let m = {}; try { m = JSON.parse(body.toString()); } catch (e) { }
    const ip = req.socket.remoteAddress;
    const mode = m.mode === 'register' || m.mode === 'login' ? m.mode : undefined;
    const r = auth.login(String(m.user || '').trim(), m.pass, cfg.SITE_NAME, { allowClaim: auth.isLocal(ip), mode });
    log(`auth ${m.user} from ${ip}: ${r.ok ? (r.created ? 'new account' : 'ok') : r.error}`);
    if (!r.ok) return http.send(res, 200, JSON.stringify({ ok: false, error: r.error }), 'application/json');
    res.setHeader('Set-Cookie', `${auth.COOKIE}=${r.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(auth.SESSION_MS / 1000)}`);
    http.send(res, 200, JSON.stringify({ ok: true, created: r.created }), 'application/json');
  });
  http.route('/logout', (req, res) => {
    auth.logout(req.headers.cookie);
    res.setHeader('Set-Cookie', `${auth.COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    http.send(res, 200, '<meta http-equiv="refresh" content="0;url=/">', 'text/html; charset=utf-8');
  });
};
