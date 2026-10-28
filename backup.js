// Snapshots of the game database (data/wartune.db, store.js): a consistent copy (SQLite VACUUM INTO) goes to
// data/backups/<date_time>/wartune.db at start-up and every BACKUP_HOURS (default 6); the newest BACKUP_KEEP
// (default 14) are kept. BACKUP=0 turns it off. To restore: stop the server, copy a snapshot's wartune.db over
// data/wartune.db (and delete data/wartune.db-wal / -shm).
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const DIR = path.join(DATA, 'backups');
const pad = n => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

function snapshot(log = () => {}, { dir = DIR, keep = Number(process.env.BACKUP_KEEP) || 14 } = {}) {
  const to = path.join(dir, stamp());
  fs.mkdirSync(to, { recursive: true });
  const file = path.join(to, 'wartune.db');
  if (!fs.existsSync(file)) require('./store').copyTo(file);   // two snapshots in one second share the folder
  // drop the oldest beyond `keep` (names sort by time)
  const all = fs.readdirSync(dir).filter(x => /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d$/.test(x)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(dir, old), { recursive: true, force: true });
  log(`backup: database -> ${path.relative(__dirname, to)}`);
  return to;
}

function start(log) {
  if (process.env.BACKUP === '0') return;
  const hours = Number(process.env.BACKUP_HOURS) || 6;
  const run = () => { try { snapshot(log); } catch (e) { log('backup failed', e.message); } };
  run();
  setInterval(run, hours * 3600 * 1000).unref();
}

module.exports = { snapshot, start };
