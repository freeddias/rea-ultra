// Server-wide seasonal / limited event toggles (persisted in store meta "events").
// force(key): true = force open, false = force closed, null = follow calendar / default.
const store = require('../store');

const CATALOG = [
  { key: 'season', label: 'Temporada (principal)', group: 'Temporada', hint: 'Módulo principal da temporada (Type 1)' },
  { key: 'seasonPass', label: 'Passe de Temporada', group: 'Temporada', hint: 'Passe premium mensal da temporada (Type 3)' },
  { key: 'seasonShop', label: 'Loja de Temporada', group: 'Temporada', hint: 'Mercado / emblemas da temporada (Type 5)' },
  { key: 'dragonNest', label: 'Ninho do Dragão', group: 'Temporada', hint: 'PvE sazonal — Ninho do Dragão Demoníaco (Type 7)' },
  { key: 'warriorPass', label: 'Passe de Guerreiro', group: 'Passes', hint: 'Battle pass / passport (t_s_passindex)' },
  { key: 'carnival', label: 'Carnaval', group: 'Eventos', hint: 'Painel Carnaval (padrão: sempre aberto)' },
  { key: 'goldenRoad', label: 'Estrada Dourada', group: 'Eventos', hint: 'Golden Road semanal' },
  { key: 'memoryCard', label: 'Cartas da Memória', group: 'Eventos', hint: 'Novo memory card (padrão: sempre aberto)' },
  { key: 'sumActive', label: 'Painel de Atividades', group: 'Eventos', hint: 'Calendário SumActive / Etkinlikler' },
  { key: 'guardDraw', label: 'Chamada de Guardas', group: 'Eventos', hint: 'Gacha de guardas (janelas OpenTime)' },
  { key: 'guildMaze', label: 'Labirinto da Guilda', group: 'Eventos', hint: 'Dias 6–12 e 20–26 do mês' },
  { key: 'worldBoss', label: 'Chefe Mundial', group: 'Eventos', hint: 'Janelas 11:30–12:30 e 21:00–22:00' },
  { key: 'warField', label: 'Campo de Batalha (CG)', group: 'Eventos', hint: 'Horários 13:00–23:20 (20 min por hora); GM pode forçar' },
  { key: 'treasureMine', label: 'Mina de Tesouro (MP)', group: 'Eventos', hint: 'Janelas de guerra 10:00–11:59 e 19:00–20:59' },
];

const probes = Object.create(null);

function get() { return store.getMeta('events', {}) || {}; }
function setAll(obj) { store.setMeta('events', obj || {}); }
function force(key) {
  const v = get()[key];
  if (v === true || v === false) return v;
  return null;
}
function setForce(key, value) {
  if (!CATALOG.some(e => e.key === key)) return false;
  const cur = get();
  if (value === true || value === false) cur[key] = value;
  else delete cur[key];
  setAll(cur);
  return true;
}
function register(key, probeFn) { probes[key] = probeFn; }
function calendarOpen(key) {
  const fn = probes[key];
  if (!fn) return null;
  try { return !!fn(); } catch (e) { return null; }
}
function isOpen(key, fallback = false) {
  const f = force(key);
  if (f === true) return true;
  if (f === false) return false;
  const cal = calendarOpen(key);
  if (cal != null) return cal;
  return fallback;
}
function status() {
  return CATALOG.map(e => {
    const f = force(e.key);
    const cal = calendarOpen(e.key);
    return {
      key: e.key, label: e.label, group: e.group, hint: e.hint,
      force: f, calendarOpen: cal,
      open: f === true ? true : f === false ? false : (cal == null ? null : cal),
    };
  });
}

module.exports = { CATALOG, get, setAll, force, setForce, register, isOpen, calendarOpen, status };
