// Battle rage (fúria / SP): Initial Rage (AttackType 23), Max Rage (71), per-action restore (6 / 7),
// consumption reduction (22 + talent seals). Sources: fashion engulf grade, equipment set PropertyK
// battle buffers, fighting-guard UseWay-2 passives, talent seal / job buffers with those AttackTypes,
// and campaign buffer Angry when provided.
const D = require('./data');
const T = require('../templates');

const BASE_SP_MAX = 100;
const BUFFERS = new Map(T.table('t_s_skillbuffertemplate').map(r => [r.Id, r]));
const SUITS = new Map(T.table('t_s_suitetemplate').map(r => [r.TemplateId, r]));
const FASHION_GRADE = new Map(T.table('t_s_upgradetemplate').filter(r => r.Types === 113).map(r => [r.Grades, r]));
const RAGE_ATS = new Set([6, 7, 22, 23, 71]);

function pushIds(out, raw) {
  for (const id of String(raw || '').split(',').map(Number).filter(Boolean)) out.push(id);
}

function suitBufferIds(items) {
  const count = {}, ids = [];
  for (const it of items) {
    const tp = D.items.get(it.templateId);
    if (tp && tp.SuiteId >= 1) count[tp.SuiteId] = (count[tp.SuiteId] || 0) + 1;
  }
  for (const [sid, n] of Object.entries(count)) {
    const s = SUITS.get(Number(sid)); if (!s) continue;
    for (let k = 1; k <= Math.min(8, n); k++) {
      const pid = Number(s['Property' + k]); if (!pid) continue;
      const sk = D.skills.get(pid);
      if (sk && sk.BufferIds) pushIds(ids, sk.BufferIds);
      else pushIds(ids, pid);
    }
  }
  return ids;
}

function fashionBufferIds(p) {
  const f = p.s.fashion; if (!f) return [];
  const row = FASHION_GRADE.get(f.grades || 1);
  const ids = [];
  pushIds(ids, row && row.TemplateName);
  return ids;
}

function talentBufferIds(p) {
  const t = p.s.talent; if (!t || !t.pages) return [];
  const pg = t.pages[t.index] || t.pages[0]; if (!pg) return [];
  const ids = [];
  for (const sid of pg.skills || []) {
    const sk = D.skills.get(sid); if (sk) pushIds(ids, sk.BufferIds);
  }
  return ids;
}

function guardBufferIds(p) {
  const G = p.s.guards; if (!G || !G.fight) return [];
  const g = G.list[G.fight]; if (!g) return [];
  const ids = [];
  for (const sid of g.skills || []) {
    const sk = D.skills.get(sid);
    if (sk && sk.UseWay === 2) pushIds(ids, sk.BufferIds);
  }
  return ids;
}

// "Rage Consumption -10%" on seal buffers whose AttackType is the template id itself
function sealCostReduce(b) {
  const name = b.BufferName_en || b.BufferName_pt || b.BufferName || '';
  const m = /Rage Consumption\s*-?\s*(\d+)\s*%/i.exec(name) || /Consumo de [Ff]úria\s*-?\s*(\d+)\s*%/.exec(name);
  return m ? Number(m[1]) : 0;
}

function of(p, opts = {}) {
  const ids = [
    ...fashionBufferIds(p),
    ...suitBufferIds(Object.values(p.s.equip || {})),
    ...talentBufferIds(p),
    ...guardBufferIds(p),
  ];
  let initial = 0, spMax = BASE_SP_MAX, costReducePct = 0;
  const lasting = [];
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) continue; seen.add(id);
    const b = BUFFERS.get(id); if (!b) continue;
    const at = b.AttackType;
    if (at === 23) initial += b.AttackValue || 0;
    else if (at === 71) spMax += b.AttackValue || 0;
    else if (at === 6 || at === 7) lasting.push(b);
    else if (at === 22) costReducePct += Math.abs(b.ValuePercent || 0);
    else if (!RAGE_ATS.has(at)) costReducePct += sealCostReduce(b);
  }
  if (opts.angry) initial += Number(opts.angry) || 0;
  spMax = Math.max(BASE_SP_MAX, spMax);
  initial = Math.max(0, Math.min(spMax, initial));
  return { initial, spMax, costReducePct, lasting, baseMax: BASE_SP_MAX };
}

function applyToUnit(u, fury) {
  if (!u || !fury) return;
  u.spMax = fury.spMax;
  u.sp = Math.max(0, Math.min(fury.spMax, fury.sp != null ? fury.sp : fury.initial));
  u.costReducePct = (u.costReducePct || 0) + (fury.costReducePct || 0);
  u.passiveRageBuffers = (u.passiveRageBuffers || []).concat(fury.lasting || []);
}

function prepFields(fury) {
  return { sp: fury.initial, spMax: fury.spMax };
}

module.exports = { of, applyToUnit, prepFields, BASE_SP_MAX, BUFFERS };
