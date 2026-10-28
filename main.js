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

require('./backup').start(log);   // data/backups/ snapshots (BACKUP=0 off)
require('./web')(log);
httpSrv.start(cfg.HTTP_PORT, log, cfg.BIND);
net.listen(cfg.LOGIN_PORT, require('./login')(log), log, cfg.BIND);
const gate = require('./game/logic')(log);
if (!gate.onUnhandled) gate.onUnhandled = (c, name, h, body) => {
  const t = require('./codemap.json').c2s[name]; let d = '';
  if (t && body.length) { try { d = JSON.stringify(c.decode(t.type, body)).slice(0, 160); } catch (e) { } }
  log(`[#${c.id}] <- ${name}(${h.code}) unhandled ${d}`);
};
net.listen(cfg.GATE_PORT, gate, log, cfg.BIND);
log(`listening on ${cfg.BIND} (HOST ${cfg.HOST}), passwords ${require('./auth').ENABLED ? 'on' : 'OFF (AUTH=0)'}`);
log(`game  http://${cfg.HOST}:${cfg.HTTP_PORT}/`);
log(`admin http://${cfg.HOST}:${cfg.HTTP_PORT}/admin  (LAN ok)`);
