// WebSocket connection wrapper: framing, cipher state, proto encode/decode, dispatch by code.
const { WebSocketServer } = require('ws');
const { URL } = require('url');
const P = require('./packet');
const { type, u8 } = require('./proto');
const codes = require('./codes.json');
const codemap = require('./codemap.json');
const { filled } = require('./schema');

const S2C = codes.s2c, C2S = codes.c2s;
const C2S_NAME = Object.fromEntries(Object.entries(C2S).map(([k, v]) => [v, k]));
const C2S_ALIASES = {};   // code -> all enum names (ih has duplicates, e.g. G_LOGIN_GATEWAY / U_G_LOGIN_GATEWAY = 20001)
for (const [k, v] of Object.entries(C2S)) (C2S_ALIASES[v] = C2S_ALIASES[v] || []).push(k);
const S2C_NAME = Object.fromEntries(Object.entries(S2C).map(([k, v]) => [v, k]));
// codes on which the client resets both of its cipher keys to the default before sending
const RESET_CODES = new Set(['L_GET_PLAYER_LIST', 'L_PREPARE_LOGIN', 'L_REGISTER_ROLE', 'G_LOGIN_GATEWAY', 'L_CREATE_LOGIN'].map(n => C2S[n]).concat([S2C.L_SYNC_TIME]));

let log = console.log;
const QUIET_IN = new Set(['U_C_CAMPAIGN_SYNCPOS', 'C_SYNCHRONIZED_TIME', 'U_C_CASTLE_UPDATE', 'L_SYNC_TIME', 'U_PLAYER_CLIENT_STATE', 'C_CHECK_ACCELERATOR']);
let nextConnId = 1;

class Conn {
  constructor(ws, handlers) {
    this.id = nextConnId++;
    this.ws = ws;
    this.handlers = handlers;
    this.recvKey = new P.Cipher();
    this.sendKey = new P.Cipher();
    this.buf = Buffer.alloc(0);
    this.clientId = 0;
    this.session = {};
    ws.on('message', d => this.onData(Buffer.from(d)));
    ws.on('close', () => { log(`[#${this.id}] closed`); handlers.onClose && handlers.onClose(this); });
    ws.on('error', e => log(`[#${this.id}] ws error`, String(e)));
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      // peek header with a copy of the key; if the magic doesn't match, the client reset its keys
      let peek = this.recvKey.clone().decrypt(this.buf.subarray(0, 4));
      if (peek.readUInt16BE(0) !== P.MAGIC) {
        const fresh = new P.Cipher();
        peek = fresh.clone().decrypt(this.buf.subarray(0, 4));
        if (peek.readUInt16BE(0) !== P.MAGIC) { log(`[#${this.id}] bad magic, dropping buffer`, this.buf.subarray(0, 8)); this.buf = Buffer.alloc(0); return; }
        this.recvKey = fresh; this.sendKey = new P.Cipher();
      }
      const len = peek.readUInt16BE(2);
      if (this.buf.length < len) return;
      const plain = this.recvKey.decrypt(this.buf.subarray(0, len));
      this.buf = this.buf.subarray(len);
      const h = P.parseHeader(plain);
      if (RESET_CODES.has(h.code)) this.sendKey = new P.Cipher();
      if (P.checksum(plain) !== h.checksum) log(`[#${this.id}] checksum mismatch code ${h.code}`);
      this.dispatch(h, plain.subarray(P.HEADER));
    }
  }

  dispatch(h, body) {
    if (this.replaced) return;   // the account logged in again elsewhere (logic.js G_LOGIN_GATEWAY): this session is done
    const name = C2S_NAME[h.code] || S2C_NAME[h.code] || ('0x' + h.code.toString(16));  // a few C2S codes live in the eh enum (e.g. L_SYNC_TIME)
    const alias = (C2S_ALIASES[h.code] || []).find(n => this.handlers[n]);
    const fn = this.handlers[alias || name];
    if (!fn) { log(`[#${this.id}] <- ${name}(${h.code}) len=${body.length} UNHANDLED`); this.handlers.onUnhandled && this.handlers.onUnhandled(this, name, h, body); return; }
    if (!QUIET_IN.has(alias || name)) {
      const t = codemap.c2s[alias || name]; let d = '';
      if (t && body.length) { try { d = JSON.stringify(this.decode(t.type, body)).slice(0, 160); } catch (e) { } }
      log(`[#${this.id}] <- ${alias || name} ${d}`);
    }
    try { fn(this, body, h); } catch (e) { log(`[#${this.id}] handler ${name} threw`, e.stack); }
  }

  decode(typeName, body) {
    const o = type(typeName).decode(u8(body));
    return JSON.parse(JSON.stringify(o));
  }

  // raw/explicit send used by the tutorial replay: p = {type, obj} | {raw: Buffer}
  sendPacket(code, p, clientId, extend1 = 0, extend2 = 0) {
    let body = p.raw || Buffer.alloc(0);
    if (p.obj) { const T = type(p.type); body = Buffer.from(T.encode(p.obj).finish()); }   // recorded data: absent sub-messages stay absent
    const pk = P.build(code, body, clientId, extend1, extend2);
    if (this.ws.readyState === 1) this.ws.send(this.sendKey.encrypt(pk));
    const nm = S2C_NAME[code] || code;
    if (!this.quiet || !this.quiet.has(nm)) log(`[#${this.id}] -> ${nm}(${code}) ${body.length}b *`);
  }

  // send(name|code, obj?, typeName?) — typeName defaults to codemap's type for that S2C code
  send(name, obj, typeName, ext = {}) {
    const code = typeof name === 'number' ? name : S2C[name];
    if (code === undefined) throw new Error('unknown s2c ' + name);
    const nm = S2C_NAME[code] || name;
    let body = Buffer.alloc(0);
    if (obj) {
      const tn = typeName || (codemap.s2c[nm] && codemap.s2c[nm].type);
      if (!tn) throw new Error('no proto type known for ' + nm);
      const T = type(tn);
      obj = filled(tn, obj);
      const err = T.verify ? T.verify(obj) : null;
      if (err) log(`[#${this.id}] verify ${tn}: ${err}`);
      body = Buffer.from(T.encode(obj).finish());
    }
    const pk = P.build(code, body, ext.clientId !== undefined ? ext.clientId : this.clientId, ext.extend1 || 0, ext.extend2 || 0);
    if (this.ws.readyState === 1) this.ws.send(this.sendKey.encrypt(pk));
    if (!this.quiet || !this.quiet.has(nm)) log(`[#${this.id}] -> ${nm}(${code}) ${body.length}b`);
  }
}

function wireConn(wss, handlers, label) {
  wss.on('connection', (ws, req) => {
    const c = new Conn(ws, handlers);
    // Cloudflare Quick Tunnel often strips Cookie on WS upgrade; fall back to ?wt= from loginUrl.
    let cookie = req.headers.cookie || '';
    try {
      const u = new URL(req.url || '/', 'http://x');
      const wt = u.searchParams.get('wt') || u.searchParams.get('wtsession');
      if (wt && !/(?:^|;\s*)wtsession=/.test(cookie)) {
        cookie = (cookie ? cookie + '; ' : '') + 'wtsession=' + decodeURIComponent(wt);
      }
    } catch (e) { }
    c.cookie = cookie;
    c.ip = req.socket.remoteAddress;
    c.host = String(req.headers.host || '').replace(/:\d+$/, '');
    log(`[#${c.id}] connect ${req.socket.remoteAddress} ${label}` + (c.cookie ? '' : ' (no cookie)'));
    handlers.onOpen && handlers.onOpen(c);
  });
}

function listen(port, handlers, logger, host) {
  log = logger || log;
  // no path filter: LAN uses /ws; Cloudflare single-tunnel uses / and /gate on the HTTP server
  const wss = new WebSocketServer({ port, host });
  wireConn(wss, handlers, `port ${port}`);
  log('WS listening on', port);
  return wss;
}

/** Attach WS to an existing HTTP server (upgrade). One Cloudflare tunnel on :8899 can carry login + gate. */
function attach(server, handlers, logger, { name = 'ws', test } = {}) {
  log = logger || log;
  const wss = new WebSocketServer({ noServer: true });
  wireConn(wss, handlers, name);
  const ok = typeof test === 'function' ? test : () => true;
  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try { pathname = new URL(req.url || '/', 'http://x').pathname || '/'; } catch (e) { }
    if (!ok(pathname)) return;
    // keep req.url (incl. ?wt=) on the connection event
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  log('WS attached on HTTP upgrade:', name);
  return wss;
}

module.exports = { listen, attach, Conn, S2C, C2S };
