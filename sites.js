// Game server list shown on the client's LoginOS / server picker.
// One process hosts every site; characters stay isolated via db.account(userName, site).
const store = require('./store');
const cfg = require('./config');

const KEY = 'sites';
const NAME_MAX = 32;

function defaults() {
  return {
    nextId: Math.max(2, (cfg.SITE_ID || 1) + 1),
    list: [{
      siteId: cfg.SITE_ID || 1,
      siteName: cfg.SITE_NAME || 'local_1',
      showName: cfg.SERVER_NAME || 'Local',
      isOpen: true,
      isRepair: false,
      order: 1,
      created: Date.now(),
    }],
  };
}

function load() {
  let d = store.getMeta(KEY, null);
  if (!d || !Array.isArray(d.list) || !d.list.length) {
    d = defaults();
    store.setMeta(KEY, d);
  }
  if (!d.nextId || d.nextId < 2) {
    d.nextId = Math.max(2, ...d.list.map(s => s.siteId || 0)) + 1;
    store.setMeta(KEY, d);
  }
  return d;
}

function save(d) { store.setMeta(KEY, d); }

function list() {
  return load().list.slice().sort((a, b) => (a.order || 0) - (b.order || 0) || a.siteId - b.siteId);
}

function find(siteName) {
  return load().list.find(s => s.siteName === siteName) || null;
}

function findById(siteId) {
  return load().list.find(s => s.siteId === Number(siteId)) || null;
}

function showNameOf(siteName) {
  const s = siteName && find(siteName);
  return (s && s.showName) || cfg.SERVER_NAME || 'Local';
}

function create(showName) {
  const name = String(showName || '').trim().slice(0, NAME_MAX);
  if (!name) return { ok: false, error: 'Informe um nome para o servidor' };
  const d = load();
  const siteId = d.nextId++;
  const siteName = `local_${siteId}`;
  const order = (d.list.reduce((m, s) => Math.max(m, s.order || 0), 0) || 0) + 1;
  const site = {
    siteId, siteName, showName: name,
    isOpen: true, isRepair: false, order, created: Date.now(),
  };
  d.list.push(site);
  save(d);
  return { ok: true, site, list: list() };
}

function rename(siteId, showName) {
  const name = String(showName || '').trim().slice(0, NAME_MAX);
  if (!name) return { ok: false, error: 'Informe um nome' };
  const d = load();
  const s = d.list.find(x => x.siteId === Number(siteId));
  if (!s) return { ok: false, error: 'Servidor não encontrado' };
  s.showName = name;
  save(d);
  return { ok: true, site: s, list: list() };
}

function setOpen(siteId, isOpen) {
  const d = load();
  const s = d.list.find(x => x.siteId === Number(siteId));
  if (!s) return { ok: false, error: 'Servidor não encontrado' };
  if (!isOpen && s.isOpen && d.list.filter(x => x.isOpen).length <= 1) {
    return { ok: false, error: 'Deixe ao menos um servidor aberto' };
  }
  s.isOpen = !!isOpen;
  s.isRepair = !s.isOpen;
  save(d);
  return { ok: true, site: s, list: list() };
}

module.exports = { list, find, findById, showNameOf, create, rename, setOpen, load };
