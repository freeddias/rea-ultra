// Game template tables shipped with the client (res/release/config/t_s_*.json).
const fs = require('fs');
const path = require('path');
const DIR = path.join(require('./paths').WEB, 'res/release/config');

const cache = {};
function table(name) {
  if (cache[name]) return cache[name];
  const f = fs.readdirSync(DIR).find(x => x.startsWith(name + '-') && x.endsWith('.json'));
  if (!f) return (cache[name] = []);
  const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  return (cache[name] = j[Object.keys(j)[0]] || []);
}

const heroes = Object.fromEntries(table('t_s_herotemplate').map(r => [r.TemplateId, r]));
const items = Object.fromEntries(table('t_s_itemtemplate').map(r => [r.TemplateId, r]));
const skillIds = new Set(table('t_s_skilltemplate').map(r => r.TemplateId));

// job-specific item equivalents: same SonType + NeedGrades, matched by rank within each job
const itemVariant = new Map();
const groups = {};
for (const it of Object.values(items)) {
  const job = Number(it.Job);
  if (![1, 2, 3].includes(job)) continue;
  const g = groups[it.SonType + '|' + it.NeedGrades] = groups[it.SonType + '|' + it.NeedGrades] || {};
  (g[job] = g[job] || []).push(it.TemplateId);
}
for (const g of Object.values(groups)) {
  for (const l of Object.values(g)) l.sort((a, b) => a - b);
  for (const [job, l] of Object.entries(g))
    l.forEach((tid, rank) => { for (const [o, ol] of Object.entries(g)) if (rank < ol.length) itemVariant.set(tid + '|' + o, ol[rank]); });
}

module.exports = { table, heroes, items, skillIds, itemVariant };
