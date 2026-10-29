require('./env'); // load .env before AUTH / ADMIN_USERS are read
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const httpSrv = require('./http');
const net = require('./net');

fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
const LOG = path.join(__dirname, 'logs/server.log');
function log(...a) {
  const line = new Date().toISOString().slice(11, 23) + ' ' + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
}

require('./web')(log);
const httpServer = httpSrv.start(cfg.HTTP_PORT, log, cfg.BIND);
const login = require('./login')(log);
net.listen(cfg.LOGIN_PORT, login, log, cfg.BIND);
const gate = require('./game/logic')(log);
if (!gate.onUnhandled) gate.onUnhandled = (c, name, h, body) => {
  const t = require('./codemap.json').c2s[name]; let d = '';
  if (t && body.length) { try { d = JSON.stringify(c.decode(t.type, body)).slice(0, 160); } catch (e) { } }
  log(`[#${c.id}] <- ${name}(${h.code}) unhandled ${d}`);
};
net.listen(cfg.GATE_PORT, gate, log, cfg.BIND);
// Single Cloudflare tunnel on :8899: /gate → game, anything else → login
net.attach(httpServer, gate, log, { name: 'gate@http', test: p => /^\/gate(\/|$)/i.test(p) });
net.attach(httpServer, login, log, { name: 'login@http', test: p => !/^\/gate(\/|$)/i.test(p) });
require('./turso').startPeriodic(log);
setTimeout(() => { try { require('./backup').start(log); } catch (e) { log('backup start failed', e.message); } }, 2500);
const admins = require('./env').adminUsers();
log(`listening on ${cfg.BIND} (HOST ${cfg.HOST}), passwords ${require('./auth').ENABLED ? 'on' : 'OFF (AUTH=0)'}`);
log(`game  http://${cfg.HOST}:${cfg.HTTP_PORT}/`);
log(`admin http://${cfg.HOST}:${cfg.HTTP_PORT}/admin  (ADMIN_USERS: ${admins.length ? admins.join(', ') : 'nenhum — defina no .env'})`);
