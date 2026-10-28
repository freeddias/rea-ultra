// Account passwords and browser sessions. The game client has no password field (its login window only
// takes a user name; the "password" it sends is a fixed "123456" / random per-login values), so the
// password is asked by our own page before the game loads (web.js /auth) and proven to the WebSocket servers
// by a session cookie: cookies are per host, not per port, so the cookie set by the HTTP server (8899)
// reaches the login server (8900) with the WebSocket handshake.
//  - login server: the session's user name must be the one typed into the game (login.js)
//  - gateway: the key must be md5(the per-login value the login server saw for that account) (logic.js)
// Accounts made before passwords existed get the first password used for them ("claim");
// tools/set_password.js sets one from the console.
const crypto = require('crypto');
const db = require('./db');

const COOKIE = 'wtsession';
const SESSION_MS = 30 * 24 * 3600 * 1000;
// sessions survive restarts: db.state.sessions[sha256(token)] = { userName, site, exp }
const sessions = () => (db.state.sessions = db.state.sessions || {});
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const ENABLED = process.env.AUTH !== '0';

const hash = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
function setPassword(a, pw) { a.pwSalt = crypto.randomBytes(16).toString('hex'); a.pwHash = hash(pw, a.pwSalt); db.save(); }
function checkPassword(a, pw) {
  if (!a.pwHash) return false;
  const h = Buffer.from(hash(pw, a.pwSalt), 'hex'), want = Buffer.from(a.pwHash, 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}
const validName = n => typeof n === 'string' && /^[A-Za-z0-9_.-]{3,20}$/.test(n);

// -> { ok, token?, created?, error? }. allowClaim: an existing account without a password may take this one
// (only from the server's own machine: someone else on the network can't claim another's old account).
// mode 'login': the account must exist; 'register': the name must be free; none: either (older callers)
function login(userName, password, site, { allowClaim = false, mode } = {}) {
  if (!validName(userName)) return { ok: false, error: 'Kullanıcı adı 3-20 harf, rakam, _ . - olmalı' };
  if (typeof password !== 'string' || password.length < 4 || password.length > 64) return { ok: false, error: 'Parola 4-64 karakter olmalı' };
  const existing = Object.values(db.state.accounts).find(x => x.userName === userName && x.site === site);
  if (mode === 'login' && !existing) return { ok: false, error: 'Hesap bulunamadı; önce hesap oluştur' };
  if (mode === 'register' && existing && (existing.pwHash || existing.char)) return { ok: false, error: 'Bu kullanıcı adı alınmış' };
  const a = existing || db.account(userName, site);
  let created = false;
  if (!a.pwHash) {
    if (existing && existing.char && !allowClaim) return { ok: false, error: 'Bu hesabın parolası yok; sunucunun çalıştığı bilgisayardan giriş yapın ya da tools/set_password.js ile parola koyun' };
    setPassword(a, password); created = !existing;
  }
  else if (!checkPassword(a, password)) return { ok: false, error: 'Kullanıcı adı ya da parola yanlış' };
  const token = crypto.randomBytes(24).toString('hex');
  const all = sessions(), now = Date.now();
  for (const [k, v] of Object.entries(all)) if (v.exp < now) delete all[k];
  all[sha(token)] = { userName, site, exp: now + SESSION_MS };
  db.save();
  return { ok: true, token, created };
}
function cookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
function session(cookieHeader) {
  const t = cookies(cookieHeader)[COOKIE], s = t && sessions()[sha(t)];
  if (!s || Date.now() > s.exp) return null;
  return s;
}
function logout(cookieHeader) { const t = cookies(cookieHeader)[COOKIE]; if (t && sessions()[sha(t)]) { delete sessions()[sha(t)]; db.save(); } }
function normalizeIp(ip) {
  ip = String(ip || '');
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}
const isLocal = ip => {
  const a = normalizeIp(ip);
  return a === '127.0.0.1' || a === '::1' || ip === '::1' || ip === '::ffff:127.0.0.1';
};
// loopback + RFC1918 private ranges (LAN phones/PCs reaching the admin/GM panel)
const isPrivate = ip => {
  const a = normalizeIp(ip);
  if (isLocal(ip) || a === '127.0.0.1') return true;
  if (/^10\./.test(a)) return true;
  if (/^192\.168\./.test(a)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  return false;
};
const md5 = s => crypto.createHash('md5').update(String(s)).digest('hex');

module.exports = { ENABLED, COOKIE, SESSION_MS, login, session, logout, setPassword, checkPassword, cookies, md5, validName, sessions, isLocal, isPrivate, normalizeIp };
