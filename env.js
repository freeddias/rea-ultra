// Load server/.env into process.env (does not override vars already set in the shell).
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '.env');

function load(file = FILE) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, file, keys: [] }; }
  const keys = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === '') process.env[k] = v;
    keys.push(k);
  }
  return { ok: true, file, keys };
}

/** Usernames allowed to open /admin (comma/space separated). Empty = nobody. */
function adminUsers() {
  const raw = String(process.env.ADMIN_USERS || process.env.ADMIN_USER || '').trim();
  if (!raw) return [];
  return raw.split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
}

function isAdminUser(userName) {
  const u = String(userName || '').trim().toLowerCase();
  if (!u) return false;
  return adminUsers().includes(u);
}

load();

module.exports = { FILE, load, adminUsers, isAdminUser };
