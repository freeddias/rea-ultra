// Loads the client's own protobufjs runtime + generated static message classes
// (com.road.yishi.proto.*) so the server encodes/decodes byte-identically.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = require('./paths').WEB;
const LIB = path.join(WEB, 'libs/min/release');
// protobuf runtime + generated bundle names change per client version: read them from the boot script
function protoLibs() {
  for (const f of ['gameindex.js', 'index.js']) {
    try {
      const m = fs.readFileSync(path.join(WEB, f), 'utf8').match(/libs\/min\/release\/(protobuf-library-[0-9a-f]+\.min\.js)", "libs\/min\/release\/(protobuf-bundles-[0-9a-f]+\.min\.js)/);
      if (m) return [m[1], m[2]];
    } catch (e) { }
  }
  throw new Error('protobuf libs not found in gameindex.js/index.js');
}
const sandbox = { console, setTimeout, clearTimeout };
sandbox.window = sandbox;
sandbox.global = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of protoLibs()) {
  vm.runInContext(fs.readFileSync(path.join(LIB, f), 'utf8'), sandbox, { filename: f });
}

const proto = sandbox.com.road.yishi.proto;

// Resolve "login.LoginReqMsg"-style names
// ("pb.minigame.SudokuGameMsg": the few classes under com.road.yishi.pb instead of .proto)
function type(name) {
  let t = name.startsWith('pb.') ? sandbox.com.road.yishi : proto;
  for (const p of name.split('.')) { t = t[p]; if (!t) throw new Error('no proto type ' + name); }
  return t;
}

// protobufjs inside the sandbox only accepts the sandbox realm's Uint8Array
const SandboxU8 = vm.runInContext('Uint8Array', sandbox);
function u8(buf) { const a = new SandboxU8(buf.length); a.set(buf); return a; }

module.exports = { proto, type, u8, protobuf: sandbox.protobuf, root: sandbox.com };
