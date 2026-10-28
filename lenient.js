// Schema-driven, *tolerant* protobuf decoder over this client's schema (schema.json):
// fields whose number is unknown or whose wire type disagrees with the schema are dropped
// instead of throwing. Used to import packets recorded from the older Flash client.
const schema = require('./schema.json');

const VARINT = new Set(['int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'bool', 'enum']);
const WIRE = k => VARINT.has(k) ? 0 : (k === 'float' || k === 'fixed32' || k === 'sfixed32') ? 5 : (k === 'double' || k === 'fixed64' || k === 'sfixed64') ? 1 : 2;

function varint(b, p) {
  let r = 0n, s = 0n;
  for (;;) {
    if (p >= b.length) throw new Error('truncated varint');
    const x = b[p++]; r |= BigInt(x & 0x7f) << s; s += 7n;
    if (x < 0x80) return [r, p];
  }
}
function scalar(kind, v) {
  if (kind === 'bool') return v !== 0n;
  if (kind === 'sint32' || kind === 'sint64') return Number((v >> 1n) ^ -(v & 1n));
  if (kind === 'uint32') return Number(v & 0xffffffffn);
  if (kind === 'int32' || kind === 'enum') return Number(BigInt.asIntN(32, v));
  return Number(BigInt.asIntN(64, v));
}

function decode(buf, typeName, stats) {
  const s = schema[typeName];
  if (!s) throw new Error('unknown type ' + typeName);
  const byId = {};
  for (const [name, f] of Object.entries(s.fields)) if (f.id) byId[f.id] = [name, f];
  const out = {};
  let p = 0;
  while (p < buf.length) {
    let tag; [tag, p] = varint(buf, p); tag = Number(tag);
    const num = tag >>> 3, wire = tag & 7;
    let raw, v;
    if (wire === 0) [v, p] = varint(buf, p);
    else if (wire === 2) { let n; [n, p] = varint(buf, p); n = Number(n); raw = buf.subarray(p, p + n); if (raw.length !== n) throw new Error('truncated'); p += n; }
    else if (wire === 5) { raw = buf.subarray(p, p + 4); p += 4; }
    else if (wire === 1) { raw = buf.subarray(p, p + 8); p += 8; }
    else throw new Error('bad wire ' + wire + ' in ' + typeName);
    const e = byId[num];
    if (!e) { if (stats) stats.dropped.push(`${typeName}#${num}`); continue; }
    const [name, f] = e;
    const kind = f.kind === 'message' ? 'message' : f.kind;
    let val;
    if (wire === 2 && WIRE(kind) === 0 && f.repeated) {          // packed repeated varints
      const vals = []; let q = 0;
      while (q < raw.length) { let x; [x, q] = varint(raw, q); vals.push(scalar(kind, x)); }
      out[name] = (out[name] || []).concat(vals); continue;
    }
    if (kind === 'unknown' || WIRE(kind) !== wire) { if (stats) stats.dropped.push(`${typeName}.${name} wire ${wire}/${kind}`); continue; }
    if (wire === 0) val = scalar(kind, v);
    else if (kind === 'string') val = Buffer.from(raw).toString('utf8');
    else if (kind === 'bytes') val = Buffer.from(raw).toString('base64');
    else if (kind === 'float') val = Buffer.from(raw).readFloatLE(0);
    else if (kind === 'double') val = Buffer.from(raw).readDoubleLE(0);
    else if (kind === 'message') {
      try { val = decode(raw, f.type, stats); } catch (err) { if (stats) stats.dropped.push(`${typeName}.${name}: ${err.message}`); continue; }
    } else { if (stats) stats.dropped.push(`${typeName}.${name} kind ${kind}`); continue; }
    if (f.repeated) (out[name] = out[name] || []).push(val); else out[name] = val;
  }
  return out;
}

module.exports = { decode };
