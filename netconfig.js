// Cloudflare / public endpoints. Empty = LAN (Host + local ports).
// Persisted in data/netconfig.json. With a single tunnel on :8899, only httpPublic is required:
//   login → wss://host   |   gate → wss://host/gate  (HTTP upgrade)
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const FILE = path.join(__dirname, 'data', 'netconfig.json');
const DEFAULT = {
  enabled: false,
  httpPublic: '',
  loginPublic: '',
  gatePublic: '',
  notes: '',
};

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const httpPublic = String(raw.httpPublic || '').trim();
    // Respect explicit enabled=false (keep URLs for later). Only auto-enable when the
    // flag is missing from old files that already have a public URL.
    const enabled = Object.prototype.hasOwnProperty.call(raw, 'enabled')
      ? !!raw.enabled
      : !!httpPublic;
    return {
      enabled,
      httpPublic,
      loginPublic: String(raw.loginPublic || '').trim(),
      gatePublic: String(raw.gatePublic || '').trim(),
      notes: String(raw.notes || '').trim(),
    };
  } catch (e) {
    return { ...DEFAULT };
  }
}

function save(partial = {}) {
  const cur = load();
  const next = {
    enabled: partial.enabled != null ? !!partial.enabled : cur.enabled,
    httpPublic: partial.httpPublic != null ? String(partial.httpPublic).trim() : cur.httpPublic,
    loginPublic: partial.loginPublic != null ? String(partial.loginPublic).trim() : cur.loginPublic,
    gatePublic: partial.gatePublic != null ? String(partial.gatePublic).trim() : cur.gatePublic,
    notes: partial.notes != null ? String(partial.notes).trim() : cur.notes,
  };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return { ok: true, config: publicView(next) };
}

function normalizeHttpBase(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s) && !/^wss?:\/\//i.test(s)) s = 'https://' + s;
  if (/^wss:\/\//i.test(s)) s = 'https://' + s.slice(6);
  else if (/^ws:\/\//i.test(s)) s = 'http://' + s.slice(5);
  return s.replace(/\/+$/, '');
}

function normalizeWsUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (/^https:\/\//i.test(s)) s = 'wss://' + s.slice(8);
  else if (/^http:\/\//i.test(s)) s = 'ws://' + s.slice(7);
  else if (!/^wss?:\/\//i.test(s)) s = 'wss://' + s;
  return s.replace(/\/+$/, '');
}

function active(c = load()) {
  return !!(c.enabled && c.httpPublic);
}

function httpBase(fallbackHost) {
  const c = load();
  if (active(c)) return normalizeHttpBase(c.httpPublic);
  const host = String(fallbackHost || cfg.HOST).replace(/^\[|\]$/g, '');
  return `http://${host}:${cfg.HTTP_PORT}`;
}

function loginWsUrl(fallbackHost) {
  const c = load();
  if (active(c)) {
    const pub = normalizeWsUrl(c.loginPublic || c.httpPublic);
    if (pub) return pub;
  }
  const host = String(fallbackHost || cfg.HOST).replace(/^\[|\]$/g, '');
  return `ws://${host}:${cfg.LOGIN_PORT}/ws`;
}

function gateWsUrl() {
  const c = load();
  if (!active(c)) return '';
  if (c.gatePublic) return normalizeWsUrl(c.gatePublic);
  const http = normalizeHttpBase(c.httpPublic);
  return http ? normalizeWsUrl(http) + '/gate' : '';
}

function gateInfo(fallbackHost) {
  const pub = gateWsUrl();
  if (pub) return { gateIp: pub, port: 0 };
  const host = String(fallbackHost || cfg.HOST).replace(/^\[|\]$/g, '');
  return { gateIp: host || cfg.HOST, port: cfg.GATE_PORT };
}

function derived(c = load()) {
  const on = active(c);
  const http = on ? normalizeHttpBase(c.httpPublic) : '';
  return {
    enabled: on,
    http: http || null,
    login: on ? loginWsUrl() : null,
    gate: on ? gateWsUrl() : null,
    cloudflaredCmd: `cloudflared tunnel --url http://127.0.0.1:${cfg.HTTP_PORT}`,
  };
}

function publicView(c = load()) {
  return {
    enabled: !!c.enabled,
    httpPublic: c.httpPublic || '',
    loginPublic: c.loginPublic || '',
    gatePublic: c.gatePublic || '',
    notes: c.notes || '',
    ports: { http: cfg.HTTP_PORT, login: cfg.LOGIN_PORT, gate: cfg.GATE_PORT },
    derived: derived(c),
  };
}

function usingPublic() {
  return active();
}

module.exports = {
  FILE, DEFAULT, load, save, publicView, derived, active,
  normalizeHttpBase, normalizeWsUrl,
  httpBase, loginWsUrl, gateWsUrl, gateInfo, usingPublic,
};
