// GM-selectable database backend: local SQLite file (data/wartune.db) or Turso cloud (libSQL).
// Persisted in data/dbconfig.json — URL + auth token are only used when mode === 'turso'.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'dbconfig.json');
const DEFAULT = {
  mode: 'local',           // 'local' | 'turso'
  tursoUrl: '',            // libsql://… or https://…
  tursoAuthToken: '',
  syncMinutes: 5,          // periodic push/pull when turso
};

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      mode: raw.mode === 'turso' ? 'turso' : 'local',
      tursoUrl: String(raw.tursoUrl || '').trim(),
      tursoAuthToken: String(raw.tursoAuthToken || '').trim(),
      syncMinutes: Math.max(1, Math.min(1440, Number(raw.syncMinutes) || DEFAULT.syncMinutes)),
    };
  } catch (e) {
    return { ...DEFAULT };
  }
}

function save(partial = {}) {
  const cur = load();
  // empty string = "keep current" (the admin form often re-sends blank URL/token after Test)
  const urlIn = partial.tursoUrl != null ? String(partial.tursoUrl).trim() : '';
  const tokIn = partial.tursoAuthToken != null ? String(partial.tursoAuthToken).trim() : '';
  const next = {
    mode: partial.mode === 'turso' ? 'turso' : partial.mode === 'local' ? 'local' : cur.mode,
    tursoUrl: urlIn || cur.tursoUrl,
    tursoAuthToken: tokIn || cur.tursoAuthToken,
    syncMinutes: partial.syncMinutes != null
      ? Math.max(1, Math.min(1440, Number(partial.syncMinutes) || DEFAULT.syncMinutes))
      : cur.syncMinutes,
  };
  if (next.mode === 'turso' && (!next.tursoUrl || !next.tursoAuthToken)) {
    return {
      ok: false,
      error: !next.tursoUrl
        ? 'Informe a URL do banco Turso (libsql://…)'
        : 'Informe o Auth Token do Turso',
      config: publicView(cur),
    };
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return { ok: true, config: publicView(next) };
}

// never echo the full token back to the admin UI — only whether it is set + a short hint
function publicView(c = load()) {
  const tok = c.tursoAuthToken || '';
  return {
    mode: c.mode,
    tursoUrl: c.tursoUrl || '',
    hasToken: !!tok,
    tokenHint: tok ? `${tok.slice(0, 6)}…${tok.slice(-4)}` : '',
    syncMinutes: c.syncMinutes,
  };
}

function ready(c = load()) {
  return c.mode === 'turso' && !!c.tursoUrl && !!c.tursoAuthToken;
}

module.exports = { FILE, DEFAULT, load, save, publicView, ready };
