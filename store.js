// The game's database: one SQLite file (data/wartune.db; SQLITE_FILE overrides it, tests use a throw-away one),
// opened with Node's built-in node:sqlite (synchronous, no install). Any SQLite tool (Navicat, DB Browser for
// SQLite) can open it; stop the server first to edit, it keeps the file open.
//  accounts  one row per (site, user_name): user_id, nick_name, created_at, has_password + the whole record (json)
//  players   one row per character: the columns worth a glance (name, job, level, VIP, money, guild, last save)
//            + the whole player state (json) the game loads
//  meta      shared state documents by key (json): 'db' (id counter, sessions, server-wide counters), 'guilds',
//            'market', 'mines'
// The old JSON files (data/db.json, data/players/*.json, guilds / market / mines) are read once by migrate()
// when the database is empty and left where they are.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA = path.join(__dirname, 'data');
const FILE = process.env.SQLITE_FILE || path.join(DATA, 'wartune.db');
fs.mkdirSync(path.dirname(FILE), { recursive: true });
const db = new DatabaseSync(FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
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
`);
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const iso = ms => ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : null;

const q = {
  metaGet: db.prepare('SELECT json FROM meta WHERE key = ?'),
  metaSet: db.prepare('INSERT INTO meta (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at'),
  accAll: db.prepare('SELECT json FROM accounts'),
  accSet: db.prepare(`INSERT INTO accounts (user_id, site, user_name, nick_name, created_at, has_password, json) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET site = excluded.site, user_name = excluded.user_name, nick_name = excluded.nick_name,
    created_at = excluded.created_at, has_password = excluded.has_password, json = excluded.json`),
  plGet: db.prepare('SELECT json FROM players WHERE id = ?'),
  plSet: db.prepare(`INSERT INTO players (id, nick_name, job, grades, vip, gold, point, gift_token, guild_id, updated_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET nick_name = excluded.nick_name, job = excluded.job, grades = excluded.grades, vip = excluded.vip, gold = excluded.gold,
    point = excluded.point, gift_token = excluded.gift_token, guild_id = excluded.guild_id, updated_at = excluded.updated_at, json = excluded.json`),
  plCount: db.prepare('SELECT COUNT(*) AS n FROM players'),
  accCount: db.prepare('SELECT COUNT(*) AS n FROM accounts'),
  plList: db.prepare('SELECT id, nick_name, job, grades, vip, updated_at FROM players ORDER BY updated_at DESC'),
};

function getMeta(key, fallback) { const r = q.metaGet.get(key); return r ? JSON.parse(r.json) : fallback; }
function setMeta(key, obj) { q.metaSet.run(key, JSON.stringify(obj), now()); }
function loadAccounts() { const out = {}; for (const r of q.accAll.all()) { const a = JSON.parse(r.json); out[a.site + '|' + a.userName] = a; } return out; }
function saveAccount(a) { q.accSet.run(a.userId, a.site, a.userName, (a.char && a.char.nickName) || null, iso(a.created), a.pwHash ? 1 : 0, JSON.stringify(a)); }
function saveAccounts(all) { db.exec('BEGIN'); try { for (const a of Object.values(all)) saveAccount(a); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
function loadPlayer(id) { const r = q.plGet.get(id); return r ? JSON.parse(r.json) : null; }
function savePlayer(s) {
  q.plSet.run(s.id, s.nickName || null, s.job ?? null, s.grades ?? null, s.vip ?? 0, s.gold ?? 0, s.point ?? 0, s.giftToken ?? 0,
    (s.guild && s.guild.id) || null, now(), JSON.stringify(s));
}
// every character, the columns only (the GM page lists them)
function listPlayers() { return q.plList.all().map(r => ({ id: r.id, nickName: r.nick_name, job: r.job, grades: r.grades, vip: r.vip, updatedAt: r.updated_at })); }
// a consistent copy of the whole database (backup.js)
function copyTo(file) { db.exec(`VACUUM INTO '${String(file).replace(/'/g, "''")}'`); }

// first start on the database: bring in the JSON files of the older versions
function migrate(log = () => {}) {
  if (q.accCount.get().n || q.plCount.get().n) return false;
  const read = f => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (e) { return null; } };
  const old = read('db.json');
  let accounts = 0, players = 0;
  db.exec('BEGIN');
  try {
    if (old) {
      const { accounts: acc = {}, ...rest } = old;
      for (const a of Object.values(acc)) { saveAccount(a); accounts++; }
      setMeta('db', rest);
    }
    const dir = path.join(DATA, 'players');
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter(x => /^\d+\.json$/.test(x))) {
      try { savePlayer(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); players++; } catch (e) { log(`migrate: ${f} skipped (${e.message})`); }
    }
    for (const [key, f] of [['guilds', 'guilds.json'], ['market', 'market.json'], ['mines', 'mines.json']]) { const v = read(f); if (v) setMeta(key, v); }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  log(`database: imported ${accounts} accounts and ${players} players from the JSON files into ${path.relative(__dirname, FILE)}`);
  return true;
}

module.exports = { FILE, getMeta, setMeta, loadAccounts, saveAccount, saveAccounts, loadPlayer, savePlayer, listPlayers, copyTo, migrate, close: () => db.close() };
