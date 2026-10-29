// Códigos de ativação / resgate (cliente Welfare → ActivityItem → POST ORDER_PATH+"activecheck").
// Admin: /admin/giftcodes — cria pacotes (itens) e vincula códigos com validade e limite de usos.
// Resposta HTTP (UTF-8): "...|10" = sucesso (command07); "0|1" código inválido; "0|2" esgotado;
// "0|6" já resgatado por este jogador; "-1|1" expirado.
const crypto = require('crypto');
const store = require('../../store');
const http = require('../../http');
const auth = require('../../auth');

const META = 'giftCodes';

module.exports = (ctx) => {
  const { log, online, playerById, sendT } = ctx;

  const load = () => {
    const d = store.getMeta(META, null) || { packs: [], codes: [] };
    if (!Array.isArray(d.packs)) d.packs = [];
    if (!Array.isArray(d.codes)) d.codes = [];
    return d;
  };
  const save = d => store.setMeta(META, d);

  const nowMs = () => Date.now();
  const parseWhen = s => {
    if (!s) return null;
    const t = Date.parse(String(s).replace(' ', 'T'));
    return Number.isFinite(t) ? t : null;
  };
  const expired = when => {
    const t = parseWhen(when);
    return t != null && nowMs() > t;
  };
  const normCode = s => String(s || '').trim().toUpperCase().replace(/\s+/g, '');
  const genCode = (prefix = 'ULTRA') => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `${String(prefix || 'ULTRA').replace(/[^A-Z0-9]/gi, '').slice(0, 12) || 'ULTRA'}-${raw.slice(0, 4)}-${raw.slice(4)}`;
  };
  const annexOf = list => (Array.isArray(list) ? list : [])
    .map(x => Array.isArray(x) ? [Math.floor(Number(x[0])), Math.floor(Number(x[1]) || 0)] : [Math.floor(Number(x.tid || x.id || x.templateId)), Math.floor(Number(x.count || x.n || 0))])
    .filter(([t, n]) => Number.isFinite(t) && t !== 0 && n > 0 && n <= 999999 && (t < 0 || !!(ctx.D && ctx.D.items && ctx.D.items.has(t))));

  const packById = (d, id) => d.packs.find(p => p.id === id);
  const codeByValue = (d, code) => d.codes.find(c => c.code === code);

  const uid = () => `p_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;

  function createPack({ name, title, text, items, maxPerPlayer }) {
    const annex = annexOf(items);
    if (!annex.length) return { ok: false, error: 'Pacote sem itens válidos' };
    const d = load();
    const pack = {
      id: uid(),
      name: String(name || 'Pacote').slice(0, 60),
      title: String(title || 'Código de ativação').slice(0, 40),
      text: String(text || '').slice(0, 300),
      items: annex,
      maxPerPlayer: Math.max(1, Math.min(99, Math.floor(Number(maxPerPlayer) || 1))),
      createdAt: new Date().toISOString(),
    };
    d.packs.unshift(pack);
    save(d);
    return { ok: true, pack };
  }

  function deletePack(id) {
    const d = load();
    const before = d.packs.length;
    d.packs = d.packs.filter(p => p.id !== id);
    d.codes = d.codes.filter(c => c.packId !== id);
    if (d.packs.length === before) return { ok: false, error: 'Pacote não encontrado' };
    save(d);
    return { ok: true };
  }

  function createCodes({ packId, code, codes, count, expiresAt, maxUses, prefix }) {
    const d = load();
    const pack = packById(d, packId);
    if (!pack) return { ok: false, error: 'Pacote não encontrado' };
    const exp = expiresAt ? String(expiresAt).slice(0, 19) : null;
    if (exp && parseWhen(exp) == null) return { ok: false, error: 'Data de validade inválida' };
    const uses = Math.max(0, Math.floor(Number(maxUses)));
    // 0 = ilimitado; padrão 1 (código único)
    const max = Number.isFinite(Number(maxUses)) ? uses : 1;
    const list = [];
    if (Array.isArray(codes) && codes.length) {
      for (const raw of codes) {
        const c = normCode(raw);
        if (!c || c.length < 3) continue;
        if (codeByValue(d, c) || list.some(x => x.code === c)) continue;
        list.push({
          code: c, packId, expiresAt: exp, maxUses: max, usedBy: [], enabled: true,
          createdAt: new Date().toISOString(),
        });
      }
    } else if (code) {
      const c = normCode(code);
      if (!c || c.length < 3) return { ok: false, error: 'Código muito curto' };
      if (codeByValue(d, c)) return { ok: false, error: 'Código já existe' };
      list.push({
        code: c, packId, expiresAt: exp, maxUses: max, usedBy: [], enabled: true,
        createdAt: new Date().toISOString(),
      });
    } else {
      const n = Math.max(1, Math.min(200, Math.floor(Number(count) || 1)));
      for (let i = 0; i < n; i++) {
        let c, guard = 0;
        do { c = genCode(prefix); guard++; } while ((codeByValue(d, c) || list.some(x => x.code === c)) && guard < 50);
        list.push({
          code: c, packId, expiresAt: exp, maxUses: max, usedBy: [], enabled: true,
          createdAt: new Date().toISOString(),
        });
      }
    }
    if (!list.length) return { ok: false, error: 'Nenhum código gerado' };
    d.codes.unshift(...list);
    save(d);
    return { ok: true, codes: list, pack };
  }

  function setCodeEnabled(code, enabled) {
    const d = load();
    const row = codeByValue(d, normCode(code));
    if (!row) return { ok: false, error: 'Código não encontrado' };
    row.enabled = !!enabled;
    save(d);
    return { ok: true, code: row };
  }

  function deleteCode(code) {
    const d = load();
    const c = normCode(code);
    const before = d.codes.length;
    d.codes = d.codes.filter(x => x.code !== c);
    if (d.codes.length === before) return { ok: false, error: 'Código não encontrado' };
    save(d);
    return { ok: true };
  }

  function findPlayer(userId) {
    const id = Number(userId);
    if (!id) return null;
    for (const c of online.values()) {
      if (!c.player) continue;
      if (c.player.id === id) return c.player;
      if (c.account && Number(c.account.userId) === id) return c.player;
    }
    return playerById(id) || null;
  }

  function deliver(p, pack) {
    if (!ctx.sendMail) return false;
    const title = pack.title || pack.name || 'Código de ativação';
    const text = pack.text || `Você resgatou: ${pack.name}`;
    let ok = false;
    for (let i = 0; i < pack.items.length; i += 5) {
      const part = pack.items.slice(i, i + 5);
      if (ctx.sendMail(p.id, { title, contents: text, annex: part, sendType: 4 })) ok = true;
    }
    // aviso amigável no cliente (popup oficial do código)
    const c = [...online.values()].find(x => x.player && x.player.id === p.id);
    if (c) {
      try {
        sendT(c, 4911, 'item.UseConvertCodeMsg', {
          ActiveId: pack.id || '0',
          Title: title,
          Description: text,
        });
      } catch (e) { /* optional */ }
    }
    return ok;
  }

  // HTTP activecheck result helpers (last field drives the client toast)
  const R = {
    ok: (name) => `1|${String(name || 'OK').replace(/\|/g, '/')}|10`,
    bad: () => '0|1',
    usedUp: () => '0|2',
    already: () => '0|6',
    expired: () => '-1|1',
    closed: () => '-1|5',
    fail: () => '-1|0',
  };

  function redeem(userId, number) {
    const code = normCode(number);
    if (!code) return R.bad();
    const d = load();
    const row = codeByValue(d, code);
    if (!row || row.enabled === false) return R.bad();
    if (expired(row.expiresAt)) return R.expired();
    const pack = packById(d, row.packId);
    if (!pack) return R.bad();
    const p = findPlayer(userId);
    if (!p) return R.fail();

    const claimed = p.s.giftCodes = p.s.giftCodes || { codes: [], packs: {} };
    claimed.codes = claimed.codes || [];
    claimed.packs = claimed.packs || {};

    if (claimed.codes.includes(row.code)) return R.already();
    const packCount = claimed.packs[pack.id] || 0;
    if (packCount >= (pack.maxPerPlayer || 1)) return R.already();

    const used = row.usedBy || [];
    if (row.maxUses > 0 && used.length >= row.maxUses) return R.usedUp();

    if (!deliver(p, pack)) return R.fail();

    used.push({ playerId: p.id, nick: p.s.nickName || '', at: new Date().toISOString() });
    row.usedBy = used;
    claimed.codes.push(row.code);
    claimed.packs[pack.id] = packCount + 1;
    p.save();
    save(d);
    log(`[giftcode] ${p.id} ${p.s.nickName} redeemed ${row.code} → ${pack.name}`);
    return R.ok(pack.name);
  }

  function snapshot() {
    const d = load();
    return {
      packs: d.packs.map(p => ({
        ...p,
        itemLabels: (p.items || []).map(([t, n]) => `${(ctx.rewardName && ctx.rewardName(t)) || t} x${n}`),
        codeCount: d.codes.filter(c => c.packId === p.id).length,
      })),
      codes: d.codes.map(c => {
        const pack = packById(d, c.packId);
        const uses = (c.usedBy || []).length;
        const max = c.maxUses || 0;
        return {
          code: c.code,
          packId: c.packId,
          packName: pack ? pack.name : '(pacote removido)',
          expiresAt: c.expiresAt || null,
          maxUses: max,
          used: uses,
          left: max > 0 ? Math.max(0, max - uses) : null,
          enabled: c.enabled !== false,
          expired: expired(c.expiresAt),
          createdAt: c.createdAt,
          usedBy: c.usedBy || [],
        };
      }),
    };
  }

  ctx.giftCodes = { createPack, deletePack, createCodes, setCodeEnabled, deleteCode, redeem, snapshot, load };

  // ---- HTTP: resgate in-game + admin CRUD ----
  const utf = (res, text) => http.send(res, 200, Buffer.from(String(text), 'utf8'), 'application/octet-stream');
  const json = (res, o) => http.send(res, 200, JSON.stringify(o), 'application/json');
  const local = req => auth.isPrivate(req.socket.remoteAddress);
  const guard = (req, res) => { if (local(req)) return true; http.send(res, 403, 'Apenas na rede local'); return false; };
  const bodyJson = b => { try { return JSON.parse(b.toString() || '{}'); } catch (e) { return {}; } };
  const form = b => Object.fromEntries(new URLSearchParams(b.toString()));

  const activecheck = (req, res, b, q) => {
    const f = Object.assign({}, q || {}, form(b || Buffer.alloc(0)));
    const userId = f.userId || f.userid || f.uid;
    const number = f.number || f.code || f.activeCode;
    try {
      const out = redeem(userId, number);
      log(`HTTP activecheck user=${userId} code=${normCode(number)} → ${out}`);
      utf(res, out);
    } catch (e) {
      log('activecheck error: ' + e.message);
      utf(res, R.fail());
    }
  };
  http.route('/order/activecheck', activecheck);
  http.route('/activecheck', activecheck);

  http.route('/admin/giftcodes', (req, res, b) => {
    if (!guard(req, res)) return;
    if (req.method === 'GET') return json(res, { ok: true, ...snapshot() });
    const m = bodyJson(b);
    const action = String(m.action || '');
    let r;
    switch (action) {
      case 'createPack':
        r = createPack(m);
        break;
      case 'deletePack':
        r = deletePack(m.id || m.packId);
        break;
      case 'createCodes':
        r = createCodes(m);
        break;
      case 'enable':
        r = setCodeEnabled(m.code, true);
        break;
      case 'disable':
        r = setCodeEnabled(m.code, false);
        break;
      case 'deleteCode':
        r = deleteCode(m.code);
        break;
      default:
        return json(res, { ok: false, out: ['Ação desconhecida'] });
    }
    if (!r.ok) return json(res, { ok: false, out: [r.error || 'Falha'], ...snapshot() });
    const out = [];
    if (action === 'createPack') out.push(`Pacote criado: ${r.pack.name} (${r.pack.items.length} itens)`);
    if (action === 'deletePack') out.push('Pacote e códigos vinculados removidos');
    if (action === 'createCodes') out.push(`${r.codes.length} código(s) gerado(s) para “${r.pack.name}”`);
    if (action === 'enable') out.push(`Código ${r.code.code} reativado`);
    if (action === 'disable') out.push(`Código ${r.code.code} desativado`);
    if (action === 'deleteCode') out.push('Código removido');
    log(`[admin] giftcodes ${action}: ${(out[0] || '').slice(0, 120)}`);
    json(res, { ok: true, out, ...snapshot(), created: r.codes || null, pack: r.pack || null });
  });

  return {};
};
