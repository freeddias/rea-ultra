// Turso (libSQL cloud) sync for the game SQLite store. Runtime stays on the local file (store.js);
// when dbconfig.mode === 'turso', this module mirrors meta / accounts / players to the remote DB.
const { createClient } = require('@libsql/client');
const dbconfig = require('./dbconfig');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS accounts (
    user_id INTEGER PRIMARY KEY, site TEXT NOT NULL, user_name TEXT NOT NULL, nick_name TEXT,
    created_at TEXT, has_password INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL,
    UNIQUE (site, user_name));
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY, nick_name TEXT, job INTEGER, grades INTEGER, vip INTEGER, gold INTEGER, point INTEGER,
    gift_token INTEGER, guild_id INTEGER, updated_at TEXT NOT NULL, json TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS players_nick ON players (nick_name);
`;

let timer = null;
let lastSync = null;
let lastError = null;
let syncing = false;

function clientOf(cfg) {
  return createClient({ url: cfg.tursoUrl, authToken: cfg.tursoAuthToken });
}

async function ensureSchema(remote) {
  for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
    await remote.execute(stmt);
  }
}

async function testConnection(cfg = dbconfig.load()) {
  if (!cfg.tursoUrl || !cfg.tursoAuthToken) {
    return { ok: false, error: 'Informe a URL e o Auth Token do Turso' };
  }
  try {
    const remote = clientOf(cfg);
    await ensureSchema(remote);
    await remote.execute('SELECT 1 AS ok');
    remote.close();
    return { ok: true, out: ['Conexão Turso OK', `URL: ${cfg.tursoUrl}`] };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function asObj(row, keys) {
  if (!row) return null;
  if (!Array.isArray(row)) return row;
  const o = {};
  keys.forEach((k, i) => { o[k] = row[i]; });
  return o;
}

async function remoteCounts(remote) {
  const num = async (sql) => {
    const r = await remote.execute(sql);
    const row = r.rows[0];
    return Number((row && (row.n ?? row[0])) || 0);
  };
  return {
    accounts: await num('SELECT COUNT(*) AS n FROM accounts'),
    players: await num('SELECT COUNT(*) AS n FROM players'),
    meta: await num('SELECT COUNT(*) AS n FROM meta'),
  };
}

async function pushAll(remote, store) {
  const snap = store.exportSnapshot();
  await remote.execute('DELETE FROM meta');
  await remote.execute('DELETE FROM accounts');
  await remote.execute('DELETE FROM players');
  for (const r of snap.meta) {
    await remote.execute({
      sql: 'INSERT INTO meta (key, json, updated_at) VALUES (?, ?, ?)',
      args: [r.key, r.json, r.updated_at],
    });
  }
  for (const r of snap.accounts) {
    await remote.execute({
      sql: `INSERT INTO accounts (user_id, site, user_name, nick_name, created_at, has_password, json)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [r.user_id, r.site, r.user_name, r.nick_name, r.created_at, r.has_password, r.json],
    });
  }
  for (const r of snap.players) {
    await remote.execute({
      sql: `INSERT INTO players (id, nick_name, job, grades, vip, gold, point, gift_token, guild_id, updated_at, json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [r.id, r.nick_name, r.job, r.grades, r.vip, r.gold, r.point, r.gift_token, r.guild_id, r.updated_at, r.json],
    });
  }
  return { pushed: { meta: snap.meta.length, accounts: snap.accounts.length, players: snap.players.length } };
}

async function pullAll(remote, store) {
  const metaKeys = ['key', 'json', 'updated_at'];
  const accKeys = ['user_id', 'site', 'user_name', 'nick_name', 'created_at', 'has_password', 'json'];
  const plKeys = ['id', 'nick_name', 'job', 'grades', 'vip', 'gold', 'point', 'gift_token', 'guild_id', 'updated_at', 'json'];
  const metas = (await remote.execute('SELECT key, json, updated_at FROM meta')).rows.map(r => asObj(r, metaKeys));
  const accs = (await remote.execute(
    'SELECT user_id, site, user_name, nick_name, created_at, has_password, json FROM accounts')).rows.map(r => asObj(r, accKeys));
  const pls = (await remote.execute(
    'SELECT id, nick_name, job, grades, vip, gold, point, gift_token, guild_id, updated_at, json FROM players')).rows.map(r => asObj(r, plKeys));
  store.importSnapshot({ meta: metas, accounts: accs, players: pls });
  try {
    const db = require('./db');
    const fresh = Object.assign({ nextUserId: 100001 }, store.getMeta('db', {}), { accounts: store.loadAccounts() });
    for (const k of Object.keys(db.state)) delete db.state[k];
    Object.assign(db.state, fresh);
  } catch (e) { /* db not loaded yet */ }
  return { pulled: { meta: metas.length, accounts: accs.length, players: pls.length } };
}

async function sync(opts = {}) {
  const cfg = dbconfig.load();
  if (!dbconfig.ready(cfg)) {
    return { ok: false, error: 'Turso não está configurado (modo Turso + URL + token)' };
  }
  if (syncing) return { ok: false, error: 'Sincronização já em andamento' };
  syncing = true;
  const store = require('./store');
  const log = opts.log || (() => {});
  let remote;
  try {
    remote = clientOf(cfg);
    await ensureSchema(remote);
    const remoteN = await remoteCounts(remote);
    const localN = store.counts();
    const direction = opts.direction
      || (remoteN.players > 0 && localN.players === 0 ? 'pull'
        : localN.players > 0 && remoteN.players === 0 ? 'push'
        : opts.prefer || 'push');

    let result;
    if (direction === 'pull') {
      result = await pullAll(remote, store);
      log(`turso: pull meta=${result.pulled.meta} accounts=${result.pulled.accounts} players=${result.pulled.players}`);
    } else {
      result = await pushAll(remote, store);
      log(`turso: push meta=${result.pushed.meta} accounts=${result.pushed.accounts} players=${result.pushed.players}`);
    }
    lastSync = new Date().toISOString();
    lastError = null;
    return {
      ok: true,
      direction,
      local: localN,
      remote: remoteN,
      ...result,
      lastSync,
      out: [
        direction === 'pull' ? 'Dados baixados do Turso → banco local' : 'Dados enviados do local → Turso',
        `Local: ${localN.players} personagem(ns) · Remoto: ${remoteN.players} personagem(ns)`,
      ],
    };
  } catch (e) {
    lastError = e.message || String(e);
    log(`turso: sync failed — ${lastError}`);
    return { ok: false, error: lastError };
  } finally {
    syncing = false;
    try { if (remote) remote.close(); } catch (e) { }
  }
}

function status() {
  const cfg = dbconfig.load();
  return {
    mode: cfg.mode,
    ready: dbconfig.ready(cfg),
    lastSync,
    lastError,
    syncing,
    syncMinutes: cfg.syncMinutes,
  };
}

function stopPeriodic() {
  if (timer) { clearInterval(timer); timer = null; }
}

function startPeriodic(log = () => {}) {
  stopPeriodic();
  const cfg = dbconfig.load();
  if (!dbconfig.ready(cfg)) {
    log('banco: modo local (SQLite em data/wartune.db)');
    return;
  }
  log(`banco: Turso ativo — sync a cada ${cfg.syncMinutes} min → ${cfg.tursoUrl}`);
  sync({ log, prefer: 'push' }).catch(() => {});
  timer = setInterval(() => {
    if (!dbconfig.ready()) return;
    sync({ log, prefer: 'push' }).catch(() => {});
  }, Math.max(1, cfg.syncMinutes) * 60 * 1000);
  if (timer.unref) timer.unref();
}

async function applyConfig(log = () => {}) {
  stopPeriodic();
  const cfg = dbconfig.load();
  if (!dbconfig.ready(cfg)) {
    log('banco: voltou ao SQLite local');
    return { ok: true, out: ['Banco local ativo. Sync Turso desligado.'] };
  }
  const test = await testConnection(cfg);
  if (!test.ok) return { ok: false, error: test.error, out: [test.error] };
  startPeriodic(log);
  const s = await sync({ log, prefer: 'push' });
  return s.ok
    ? { ok: true, out: ['Turso ativo.', ...(s.out || [])], sync: s }
    : { ok: false, error: s.error, out: [s.error || 'Falha ao sincronizar'] };
}

module.exports = {
  testConnection, sync, status, startPeriodic, stopPeriodic, applyConfig, ensureSchema,
};
