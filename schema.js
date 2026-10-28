// Reflect the static protobufjs classes: parse each Type.encode source to recover
// field -> {tag, kind, nested type, repeated}. Used to build fully-populated default messages.
const { proto } = require('./proto');

const schema = {};          // 'pkg.Msg' -> { fields: {name: {id, kind, type?, repeated}} }
function walk(ns, prefix) {
  for (const k of Object.keys(ns)) {
    const v = ns[k];
    if (typeof v === 'function' && v.encode && v.decode) {
      schema[prefix + k] = parse(v);
      walk(v, prefix + k + '.');            // nested types live on the class
    } else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, prefix + k + '.');
  }
}
function parse(T) {
  const src = T.encode.toString();
  const fields = {};
  // nested message:  $root.com.road.yishi.proto.a.B.encode(e.field[r]?, t.uint32(TAG).fork())
  for (const m of src.matchAll(/\$root\.com\.road\.yishi\.proto\.([\w.]+)\.encode\(e\.(\w+)(\[\w+\])?,\s*t\.uint32\((\d+)\)/g))
    fields[m[2]] = { id: +m[4] >> 3, kind: 'message', type: m[1], repeated: !!m[3] };
  // scalar:  t.uint32(TAG).int32(e.field[r]?)   (packed repeated: t.uint32(TAG).fork(); ... t.int32(e.f[r]))
  for (const m of src.matchAll(/t\.uint32\((\d+)\)\.(\w+)\(e\.(\w+)(\[\w+\])?\)/g))
    if (!fields[m[3]]) fields[m[3]] = { id: +m[1] >> 3, kind: m[2], repeated: !!m[4] };
  // packed repeated; only the first loop of a function declares its counter (`for(var r=0;` then `for(r=0;`)
  for (const m of src.matchAll(/t\.uint32\((\d+)\)\.fork\(\);\s*for\s*\((?:var )?\w+\s*=\s*0;\s*\w+\s*<\s*e\.(\w+)\.length;\s*\+\+\w+\)\s*t\.(\w+)\(/g))
    if (!fields[m[2]]) fields[m[2]] = { id: +m[1] >> 3, kind: m[3], repeated: true };
  // map<K,V>:  for(var r=Object.keys(e.f),o=0;...)t.uint32(TAG).fork().uint32(8).K(r[o]) then .uint32(16).V(e.f[r[o]])
  //            or a message value $root....encode(e.f[r[o]], t.uint32(18).fork())
  for (const m of src.matchAll(/Object\.keys\(e\.(\w+)\)[^;]*;[^;]*;\+\+\w+\)\s*t\.uint32\((\d+)\)\.fork\(\)\.uint32\((?:8|10)\)\.(\w+)\(\w+\[\w+\]\)(?:\.uint32\(16\)\.(\w+)\(|[,;]\s*\$root\.com\.road\.yishi\.proto\.([\w.]+)\.encode)?/g))
    if (!fields[m[1]]) fields[m[1]] = { id: +m[2] >> 3, kind: 'map', keyKind: m[3], valueKind: m[4] || 'message', type: m[5], repeated: false };
  // anything left on the prototype (maps etc.) — record as unknown so we can see it
  for (const k of Object.getOwnPropertyNames(T.prototype))
    if (k !== 'constructor' && k !== 'toJSON' && !fields[k] && !k.startsWith('_')) fields[k] = { kind: 'unknown', repeated: Array.isArray(T.prototype[k]) };
  // `_x` on the prototype are proto3-optional oneof virtuals, not fields
  return { fields };
}
walk(proto, '');

// Build an object where every singular nested-message field is present (recursively), so client
// code that does `e.order.x` after Bh.parse() never hits null. Repeated fields stay empty.
function filled(typeName, obj = {}, depth = 0) {
  const s = schema[typeName];
  if (!s || depth > 6) return obj;
  for (const [name, f] of Object.entries(s.fields)) {
    if (f.kind !== 'message') continue;
    if (f.repeated) { if (obj[name]) obj[name] = obj[name].map(x => filled(f.type, x, depth + 1)); continue; }
    obj[name] = filled(f.type, obj[name] || {}, depth + 1);
  }
  return obj;
}

module.exports = { schema, filled };
