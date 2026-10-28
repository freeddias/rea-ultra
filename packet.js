// Wire format (from client classes Uh/Gh/Hh in bundle_release):
//   20-byte big-endian header: magic(29099) u16, len u16, checksum u16, code u16, clientId i32, extend1 i32, extend2 i32
//   + protobuf body. checksum = (119 + sum(bytes[6:])) & 0x7F7F.
//   Every byte goes through a chained XOR/add stream cipher whose 8-byte key state persists across packets.
const MAGIC = 29099;
const HEADER = 20;
const DEFAULT_KEY = [174, 191, 86, 120, 171, 205, 239, 241];

function checksum(buf) {
  let t = 119;
  for (let i = 6; i < buf.length; i++) t += buf[i];
  return t & 0x7f7f;
}

function build(code, body, clientId = 0, extend1 = 0, extend2 = 0) {
  body = body || Buffer.alloc(0);
  const b = Buffer.alloc(HEADER + body.length);
  b.writeUInt16BE(MAGIC, 0);
  b.writeUInt16BE(b.length, 2);
  b.writeUInt16BE(code, 6);
  b.writeInt32BE(clientId | 0, 8);
  b.writeInt32BE(extend1 | 0, 12);
  b.writeInt32BE(extend2 | 0, 16);
  Buffer.from(body).copy(b, HEADER);
  b.writeUInt16BE(checksum(b), 4);
  return b;
}

class Cipher {
  constructor(key = DEFAULT_KEY) { this.set(key); }
  set(key) { this.k = Uint8Array.from(key); }
  clone() { const c = new Cipher(); c.k = Uint8Array.from(this.k); return c; }
  encrypt(p) {
    const c = Buffer.alloc(p.length), k = this.k;
    for (let t = 0; t < p.length; t++) {
      if (t > 0) { k[t % 8] = (k[t % 8] + c[t - 1]) ^ t; c[t] = ((p[t] ^ k[t % 8]) + c[t - 1]) & 0xff; }
      else c[0] = p[0] ^ k[0];
    }
    return c;
  }
  decrypt(c) {
    const p = Buffer.alloc(c.length), k = this.k;
    for (let n = 0; n < c.length; n++) {
      if (n > 0) { k[n % 8] = (k[n % 8] + c[n - 1]) ^ n; p[n] = ((c[n] - c[n - 1]) ^ k[n % 8]) & 0xff; }
      else p[0] = c[0] ^ k[0];
    }
    return p;
  }
}

function parseHeader(p) {
  return {
    magic: p.readUInt16BE(0), len: p.readUInt16BE(2), checksum: p.readUInt16BE(4), code: p.readUInt16BE(6),
    clientId: p.readInt32BE(8), extend1: p.readInt32BE(12), extend2: p.readInt32BE(16),
  };
}

module.exports = { MAGIC, HEADER, DEFAULT_KEY, Cipher, build, checksum, parseHeader };
