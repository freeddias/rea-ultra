// GM commands for testing: a chat message starting with "!" from a connection made from
// localhost / private LAN (or an account listed in GM_USERS) runs a command instead of being
// sent to the channel. GM=0 turns them off. The reply comes back as a system chat line only to the sender.
// The same tools live on one admin page (admin_page.html), reachable from the LAN:
// http://<host>:8899/admin — economy, events, commands, mail/catalogue.
//  !yardim                       the list
//  !seviye N                     levels up to N (as EXP: level boxes, opened systems, quests follow)
//  !altin N / !diamantes N / !kilitli N   gold / diamonds / bound diamonds
//  !esya ID [ADET]               an item (template id) into the bag
//  !beden                        weary back to full
//  !labirent N                   Yeraltı Labirenti record floor N (sweep, market)
//  !vip N                        N VIP EXP (as a -5500 reward: grade and packs follow)
//  !onur N                       N onur puanı (geste: honour ranks)
//  !missoes                      finishes one-shot quests the player can accept now (level, prerequisites, date, guild)
//  !classe                       job change: lifts the cap to 160 and sets level to 81 (client needs >80)
const fs = require('fs');
const path = require('path');
const auth = require('../../auth');

module.exports = (ctx) => {
  const { D, grant, giveExp, sendPlayer, sendCastle, chat, log, completeAllQuests } = ctx;
  const enabled = process.env.GM !== '0';
  const users = new Set(String(process.env.GM_USERS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
  const allowed = c => enabled && (auth.isPrivate(c.ip) || users.has(String((c.account && c.account.userName) || '').toLowerCase()));
  const num = x => Math.max(0, Math.floor(Number(x) || 0));
  const reply = (c, text) => { chat(c, `[GM] ${text}`); if (c.gmOut) c.gmOut.push(text); };
  // catalogue / mail / chat: prefer Portuguese names from the client tables
  const itemName = it => {
    const row = typeof it === 'number' ? D.items.get(it) : it;
    if (!row) return String(it);
    return String(row.TemplateName_pt || row.TemplateName_tr || row.TemplateName_en || row.TemplateName || row.TemplateId || '').trim();
  };

  const CMDS = {
    yardim(c) { reply(c, '!nivel N, !ouro N, !diamantes N, !vinculado N, !item ID [QTD], !energia, !labirinto N, !vip N, !honra N, !missoes, !classe, !cg [abrir|fechar|auto], !passe [guerreiro|temporada|mensal|lorde|fundo|todos]'); },
    cg(c, [mode]) {
      const m = String(mode || 'abrir').toLowerCase();
      if (m === 'fechar' || m === 'off' || m === 'close') {
        if (!ctx.closeWarField) return reply(c, 'Campo de Batalha indisponível.');
        ctx.closeWarField();
        return reply(c, 'Campo de Batalha (CG) forçado FECHADO.');
      }
      if (m === 'auto' || m === 'calendario' || m === 'calendar') {
        if (!ctx.events) return reply(c, 'Sistema de eventos indisponível.');
        ctx.events.setForce('warField', null);
        if (ctx.openWarField) ctx.openWarField(false);
        return reply(c, 'Campo de Batalha (CG) voltou ao calendário.');
      }
      if (!ctx.openWarField) return reply(c, 'Campo de Batalha indisponível.');
      const cur = ctx.openWarField(true);
      reply(c, cur ? `Campo de Batalha (CG) ABERTO agora (campanha ${cur.CampaignId}).` : 'Campo de Batalha forçado, mas sem campanha na tabela.');
    },
    campo(c, a) { return CMDS.cg(c, a); },
    warfield(c, a) { return CMDS.cg(c, a); },
    passe(c, [kind]) {
      const k = String(kind || 'todos').toLowerCase();
      const out = [];
      const run = (label, fn) => { if (!fn) return out.push(`${label}: indisponível`); out.push(fn(c)); };
      if (k === 'todos' || k === 'guerreiro' || k === 'warrior' || k === 'pass') run('Guerreiro', ctx.grantWarriorPass);
      if (k === 'todos' || k === 'temporada' || k === 'season') run('Temporada', ctx.grantSeasonPass);
      if (k === 'todos' || k === 'mensal' || k === 'month') {
        run('Mensal básico', c2 => ctx.grantMonthCard && ctx.grantMonthCard(c2, 1, 30));
        run('Mensal premium', c2 => ctx.grantMonthCard && ctx.grantMonthCard(c2, 2, 30));
      }
      if (k === 'todos' || k === 'lorde' || k === 'lord') run('Lorde', ctx.grantLordPrivilege);
      if (k === 'todos' || k === 'fundo' || k === 'growth') run('Fundo', ctx.grantGrowthFund);
      if (k === 'todos' || k === 'retorno' || k === 'return') {
        c.player.s.returnPass = { premium: true, exp: (c.player.s.returnPass && c.player.s.returnPass.exp) || 0 };
        c.player.save(); out.push('Passe de Retorno ativado');
      }
      if (k === 'todos' || k === 'guarda' || k === 'guard') {
        c.player.s.guardRecruitPass = true; c.player.save(); out.push('Ordem de Recrutamento Avançada ativada');
      }
      if (!out.length) return reply(c, 'Use: !passe guerreiro|temporada|mensal|lorde|fundo|retorno|guarda|todos');
      reply(c, out.join(' · '));
    },
    passes(c, a) { return CMDS.passe(c, a); },
    pass(c, a) { return CMDS.passe(c, a); },
    seviye(c, [n]) {
      const p = c.player, to = Math.min(num(n), p.maxLevel());
      if (to <= p.s.grades) return reply(c, `Nível já é ${p.s.grades}`);
      let exp = (D.levelExp.get(p.s.grades + 1) || 0) - (p.s.gp || 0);
      for (let lv = p.s.grades + 2; lv <= to; lv++) exp += D.levelExp.get(lv) || 0;
      giveExp(c, Math.max(1, exp));
      sendPlayer(c);
      reply(c, `Nível ${p.s.grades}`);
    },
    nivel(c, a) { return CMDS.seviye(c, a); },
    altin(c, [n]) { grant(c, [[-100, num(n)]], { quiet: true }); sendCastle(c); reply(c, `+${num(n)} ouro`); },
    ouro(c, a) { return CMDS.altin(c, a); },
    diamantes(c, [n]) { grant(c, [[-400, num(n)]], { quiet: true }); reply(c, `+${num(n)} diamantes`); },
    kilitli(c, [n]) { grant(c, [[-500, num(n)]], { quiet: true }); reply(c, `+${num(n)} diamantes vinculados`); },
    vinculado(c, a) { return CMDS.kilitli(c, a); },
    esya(c, [id, n]) {
      const tid = num(id), cnt = Math.max(1, num(n) || 1);
      if (!D.items.has(tid)) return reply(c, `Item ${tid} não existe`);
      if (!grant(c, [[tid, cnt]], { quiet: true })) return reply(c, 'Mochila cheia');
      reply(c, `+${itemName(tid)} x${cnt}`);
    },
    item(c, a) { return CMDS.esya(c, a); },
    onur(c, [n]) { c.player.s.geste = (c.player.s.geste || 0) + num(n); c.player.save(); sendPlayer(c); reply(c, `Pontos de honra ${c.player.s.geste}`); },
    honra(c, a) { return CMDS.onur(c, a); },
    vip(c, [n]) { grant(c, [[-5500, num(n)]], { quiet: true }); reply(c, `+${num(n)} VIP EXP, VIP ${c.player.s.vip || 0}`); },
    beden(c) { c.player.s.weary = Math.max(c.player.s.weary || 0, 200); c.player.save(); sendPlayer(c); reply(c, 'Energia cheia'); },
    energia(c, a) { return CMDS.beden(c, a); },
    labirent(c, [n]) {
      const p = c.player, s = ((p.s.maze = p.s.maze || {})[0] = (p.s.maze || {})[0] || { towerIndex: 0, maxIndex: 0, totalGp: 0, items: {}, enterCount: 0, day: '' });
      s.maxIndex = Math.min(100, num(n)); p.save();
      reply(c, `Recorde das Catacumbas Esquecidas ${s.maxIndex}`);
    },
    labirinto(c, a) { return CMDS.labirent(c, a); },
    missoes(c) {
      const r = completeAllQuests(c);
      const fmt = n => Math.floor(n).toLocaleString('pt-BR');
      if (!r.n) return reply(c, 'Não há missões únicas disponíveis para este jogador. As de nível mais alto e as diárias repetíveis continuam em aberto.');
      let text = `Missões concluídas: ${r.n}. Ouro +${fmt(r.gold)}, EXP +${fmt(r.xp)}, itens ${r.items}.`;
      if (r.missed) text += ` ${r.missed} itens não couberam na mochila.`;
      text += ' Só entraram as missões que este nível já pode aceitar. As demais e as diárias repetíveis continuam em aberto.';
      reply(c, text);
    },
    classe(c) {
      if (!ctx.forceJobChange) return reply(c, 'Sistema de avanço de classe indisponível.');
      reply(c, ctx.forceJobChange(c).msg);
    },
  };

  // chat.js asks this first; true = it was a command (not sent to the channel)
  ctx.gmCommand = (c, text) => {
    if (!text.startsWith('!')) return false;
    if (!allowed(c)) return false;
    const [name, ...args] = text.slice(1).trim().split(/\s+/);
    const fn = CMDS[String(name || '').toLowerCase()];
    if (!fn) { reply(c, `Comando desconhecido: ${name}. !yardim`); return true; }
    log(`[#${c.id}] GM ${c.player.id} ${text.slice(0, 80)}`);
    fn(c, args);
    return true;
  };

  // ---- admin / GM page (loopback + private LAN) ----
  const http = require('../../http');
  const store = require('../../store');
  const local = req => enabled && auth.isPrivate(req.socket.remoteAddress);
  const json = (res, o) => http.send(res, 200, JSON.stringify(o), 'application/json');
  const guard = (req, res) => { if (local(req)) return true; http.send(res, 403, 'Apenas na rede local'); return false; };
  const serveAdmin = (req, res) => {
    if (!guard(req, res)) return;
    http.send(res, 200, fs.readFileSync(ADMIN_FILE), 'text/html; charset=utf-8');
  };
  const body = b => { try { return JSON.parse(b.toString()); } catch (e) { return {}; } };
  const inGame = () => [...ctx.online.values()].filter(c => c.player).map(c => ({ id: c.player.id, nickName: c.player.s.nickName, grades: c.player.s.grades,
    gold: Math.floor(c.player.s.gold || 0), point: c.player.s.point || 0, giftToken: c.player.s.giftToken || 0, vip: c.player.s.vip || 0 }));
  http.route('/gm/online', (req, res) => { if (guard(req, res)) json(res, inGame()); });
  // every character (mail reaches offline players too), the online ones marked
  http.route('/gm/players', (req, res) => {
    if (!guard(req, res)) return;
    const on = new Set(inGame().map(x => x.id));
    json(res, store.listPlayers().map(x => Object.assign(x, { online: on.has(x.id) })));
  });
  http.route('/gm/items', (req, res) => { if (guard(req, res)) json(res, catalogue()); });
  // {id, items: [[templateId, count], ...], title, text} -> mails of 5 attachments each (mail.js takes 5)
  http.route('/gm/mail', (req, res, b) => {
    if (!guard(req, res)) return;
    const m = body(b), p = ctx.playerById(Number(m.id));
    if (!p) return json(res, { ok: false, out: ['Jogador não encontrado'] });
    const items = (Array.isArray(m.items) ? m.items : []).map(([tid, n]) => [num(tid), Math.min(MAIL_MAX, Math.max(1, num(n)))])
      .filter(([tid]) => D.items.has(tid));
    if (!items.length) return json(res, { ok: false, out: ['Nenhum item para enviar'] });
    const title = String(m.title || 'Presente GM').slice(0, 40), text = String(m.text || '').slice(0, 300);
    let mails = 0;
    for (let i = 0; i < items.length; i += 5) {
      const part = items.slice(i, i + 5);
      const contents = text || part.map(([t, n]) => `${itemName(t)} x${n}`).join(', ');
      if (ctx.sendMail(p.id, { title, contents, annex: part })) mails++;
    }
    log(`[GM page] mail to ${p.id}: ${items.map(([t, n]) => `${t}x${n}`).join(' ')}`);
    json(res, { ok: mails > 0, out: [`${p.s.nickName}: ${items.length} tipos de item, ${mails} correio(s) enviado(s)`] });
  });
  // ---- admin page: set or add gold, diamonds and XP (offline players are saved; online ones are pushed) ----
  const JOB_PT = JOBS;
  const MONEY_MAX = 2147483647;
  const clampMoney = n => Math.max(0, Math.min(MONEY_MAX, Math.floor(n)));
  const snap = p => {
    const need = D.levelExp.get((p.s.grades || 0) + 1) || 0;
    return {
      id: p.id, nickName: p.s.nickName || '', job: p.s.job || 0, jobName: JOB_PT[p.s.job] || '—',
      grades: p.s.grades || 1, gold: Math.floor(p.s.gold || 0), point: Math.floor(p.s.point || 0),
      gp: Math.floor(p.s.gp || 0), totalGp: Math.floor(p.s.totalGp || 0), nextGp: need,
      maxLevel: p.maxLevel(), online: ctx.online.has(p.id),
    };
  };
  const walletLine = (p, c, kind, spec) => {
    const op = spec && spec.op === 'add' ? 'add' : 'set';
    const n = Math.floor(Number(spec && spec.value));
    if (!Number.isFinite(n)) return 'Valor inválido';
    if (kind === 'gold' || kind === 'point') {
      const label = kind === 'gold' ? 'Ouro' : 'Diamantes';
      const cur = Math.floor(p.s[kind] || 0);
      p.s[kind] = clampMoney(op === 'add' ? cur + n : n);
      if (kind === 'gold') p.s.goldTick = Date.now();
      return `${label}: ${cur.toLocaleString('pt-BR')} → ${Math.floor(p.s[kind]).toLocaleString('pt-BR')}`;
    }
    if (op === 'add') {
      if (!n) return 'XP sem alteração';
      if (n > 0 && c) {
        const before = p.s.grades;
        giveExp(c, n);
        return `XP +${n.toLocaleString('pt-BR')}: nível ${before} → ${p.s.grades}, barra ${Math.floor(p.s.gp).toLocaleString('pt-BR')}`;
      }
      if (n > 0) {
        const before = p.s.grades;
        p.addExp(n);
        return `XP +${n.toLocaleString('pt-BR')} (offline): nível ${before} → ${p.s.grades}, barra ${Math.floor(p.s.gp).toLocaleString('pt-BR')}`;
      }
      const cut = Math.min(Math.floor(p.s.gp || 0), -n);
      p.s.gp -= cut;
      p.s.totalGp = Math.max(0, (p.s.totalGp || 0) - cut);
      return `XP −${cut.toLocaleString('pt-BR')} (não desce de nível): barra ${Math.floor(p.s.gp).toLocaleString('pt-BR')}`;
    }
    const need = D.levelExp.get(p.s.grades + 1) || 0;
    const cap = need > 0 ? need - 1 : 0;
    const before = Math.floor(p.s.gp || 0);
    const next = Math.max(0, Math.min(cap, n));
    p.s.totalGp = Math.max(0, (p.s.totalGp || 0) + (next - before));
    p.s.gp = next;
    return `Barra de XP: ${before.toLocaleString('pt-BR')} → ${next.toLocaleString('pt-BR')}` + (need ? ` (teto ${cap.toLocaleString('pt-BR')} neste nível)` : ' (nível máximo)');
  };
  http.route('/admin/players', (req, res) => {
    if (!guard(req, res)) return;
    json(res, store.listPlayers().map(x => ctx.playerById(x.id)).filter(Boolean).map(snap));
  });
  http.route('/admin/apply', (req, res, b) => {
    if (!guard(req, res)) return;
    const m = body(b), p = ctx.playerById(Number(m.id));
    if (!p) return json(res, { ok: false, out: ['Jogador não encontrado'] });
    const c = ctx.online.get(p.id) || null;
    const beforeLv = p.s.grades;
    const out = [];
    for (const kind of ['gold', 'point', 'xp']) if (m[kind] && m[kind].value != null && m[kind].value !== '') out.push(walletLine(p, c, kind, m[kind]));
    if (!out.length) return json(res, { ok: false, out: ['Nada para alterar'] });
    if (c) {
      if (m.gold) sendCastle(c);
      sendPlayer(c);
      if (p.s.grades !== beforeLv && ctx.sendArmy) ctx.sendArmy(c);
    }
    p.save();
    log(`[admin] ${p.id} ${p.s.nickName}: ${out.join(' | ')}`);
    json(res, { ok: true, out, player: snap(p) });
  });
  http.route('/admin', serveAdmin);
  // seasonal / limited events: force open | calendar | force closed (store meta "events")
  http.route('/admin/events', (req, res, b) => {
    if (!guard(req, res)) return;
    const ev = ctx.events;
    if (!ev) return json(res, { ok: false, out: ['Sistema de eventos indisponível'] });
    if (req.method === 'GET') return json(res, { ok: true, events: ev.status() });
    const m = body(b);
    if (m && typeof m === 'object' && m.all === 'calendar') {
      ev.setAll({});
      log('[admin] events: all → calendar');
      return json(res, { ok: true, events: ev.status(), out: ['Todos os eventos voltaram ao calendário'] });
    }
    const key = String(m.key || '');
    let force = m.force;
    if (force === 'true' || force === 1) force = true;
    else if (force === 'false' || force === 0) force = false;
    else if (force === 'null' || force === '' || force == null) force = null;
    if (!ev.setForce(key, force)) return json(res, { ok: false, out: ['Evento desconhecido: ' + key] });
    if (key === 'warField') {
      if (force === true && ctx.openWarField) ctx.openWarField(true);
      else if (force === false && ctx.closeWarField) ctx.closeWarField();
      else if (ctx.openWarField) ctx.openWarField(false);
    }
    const label = (ev.CATALOG.find(e => e.key === key) || {}).label || key;
    const mode = force === true ? 'FORÇADO ABERTO' : force === false ? 'FORÇADO FECHADO' : 'calendário';
    log(`[admin] events: ${key} → ${mode}`);
    json(res, { ok: true, events: ev.status(), out: [`${label}: ${mode}`] });
  });

  // multi-server list (LoginOS): create / rename / open / close — persisted in meta "sites"
  const sitesMod = require('../../sites');
  http.route('/admin/sites', (req, res, b) => {
    if (!guard(req, res)) return;
    if (req.method === 'GET') return json(res, { ok: true, sites: sitesMod.list() });
    const m = body(b);
    const act = String(m.action || m.op || '').toLowerCase();
    let r;
    if (act === 'create' || act === 'add') r = sitesMod.create(m.name || m.showName);
    else if (act === 'rename') r = sitesMod.rename(m.id || m.siteId, m.name || m.showName);
    else if (act === 'close') r = sitesMod.setOpen(m.id || m.siteId, false);
    else if (act === 'reopen' || act === 'open') r = sitesMod.setOpen(m.id || m.siteId, true);
    else return json(res, { ok: false, out: ['Ação inválida (create|rename|close|reopen)'], sites: sitesMod.list() });
    if (r.ok) log(`[admin] sites ${act}: ${r.site.showName} (${r.site.siteName})`);
    json(res, { ok: r.ok, out: [r.ok ? `${act}: ${r.site.showName}` : r.error], sites: r.list || sitesMod.list(), site: r.site || null });
  });

  http.route('/gm', (req, res, b) => {
    if (!guard(req, res)) return;
    if (req.method !== 'POST') return serveAdmin(req, res);
    const m = body(b);
    const c = [...ctx.online.values()].find(x => x.player && x.player.id === Number(m.id));
    if (!c) return json(res, { ok: false, out: ['Jogador não está no jogo'] });
    c.gmOut = [];
    const text = '!' + String(m.cmd || '').replace(/^!/, '');
    const [name, ...args] = text.slice(1).trim().split(/\s+/);
    const fn = CMDS[String(name || '').toLowerCase()];
    if (fn) { log(`[GM page] ${c.player.id} ${text.slice(0, 80)}`); try { fn(c, args); } catch (e) { c.gmOut.push('Erro: ' + e.message); } }
    else c.gmOut.push(`Comando desconhecido: ${name}`);
    const out = c.gmOut; c.gmOut = null;
    json(res, { ok: !!fn, out });
  });

  // the item catalogue {groups: [name], items: [[templateId, name, group, quality (Profile), level, icon url]]};
  // the icons are the client's own (webroot_web/res/animation/icon, the file names carry a content hash)
  let CATALOGUE = null;
  function catalogue() {
    if (CATALOGUE) return CATALOGUE;
    const icons = new Map();
    (function walk(d) {
      let list = []; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { }
      for (const f of list) {
        const full = path.join(d, f.name);
        if (f.isDirectory()) { walk(full); continue; }
        const m = f.name.match(/^(.*)-[0-9a-f]{10}(\.\w+)$/);
        if (m) icons.set(path.relative(ICON_ROOT, path.join(d, m[1] + m[2])).split(path.sep).join('/'), '/' + path.relative(WEBROOT, full).split(path.sep).join('/'));
      }
    })(ICON_ROOT);
    const items = [];
    for (const it of D.items.values()) {
      const name = itemName(it);
      if (!name) continue;
      items.push([it.TemplateId, name, groupOf(it), it.Profile || 0, it.NeedGrades || 0,
        icons.get(String(it.Icon || '').replace(/^\//, '')) || '', jobMask(it)]);
    }
    items.sort((a, b) => a[2] - b[2] || a[4] - b[4] || a[6] - b[6] || a[3] - b[3] || a[0] - b[0]);
    return (CATALOGUE = { groups: GROUPS.map(g => g[0]), jobs: JOBS, items, sets: sets() });
  }
  // equipment sets: the pieces with a SuiteId of one class, level and quality (weapon, helmet, armour, soul,
  // rings, emblems), named after what the weapon and the helmet share
  function sets() {
    const by = new Map();
    for (const it of D.items.values()) {
      if (it.MasterType !== 1 || !it.SuiteId || !itemName(it) || !SET_SLOTS.includes(it.SonType)) continue;
      const key = `${jobMask(it)}|${it.NeedGrades}|${it.Profile}`;
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(it);
    }
    const out = [];
    for (const list of by.values()) {
      if (list.length < 4) continue;
      list.sort((a, b) => SET_SLOTS.indexOf(a.SonType) - SET_SLOTS.indexOf(b.SonType) || a.TemplateId - b.TemplateId);
      const clean = s => s.replace(/【.*?】/g, '').trim();
      const w = clean(itemName(list.find(i => i.SonType === 101) || list[0])), h = clean(itemName(list.find(i => i.SonType === 103) || list[1]));
      let n = 0; while (n < w.length && w[n] === h[n]) n++;
      const common = w.slice(0, n).replace(/\s+\S*$/, '').trim();
      out.push({ name: common.length >= 3 ? common : w, job: jobMask(list[0]), lv: list[0].NeedGrades || 0, q: list[0].Profile || 0, ids: list.map(i => i.TemplateId) });
    }
    return out.sort((a, b) => b.lv - a.lv || b.q - a.q || a.job - b.job);
  }
  return {};
};

const ADMIN_FILE = path.join(__dirname, '../../admin_page.html');
const WEBROOT = path.join(__dirname, '../../../webroot_web');
const ICON_ROOT = path.join(WEBROOT, 'res/animation/icon');
const MAIL_MAX = 99999;
// the classes (hero Job): an item's Job list -> a bit mask (1 << job), 0 = every class
const JOBS = { 1: 'Guerreiro', 2: 'Arqueiro', 3: 'Mago' };
const jobMask = it => (Array.isArray(it.Job) ? it.Job : [it.Job]).reduce((m, j) => (j > 0 ? m | (1 << j) : m), 0);
const SET_SLOTS = [101, 103, 104, 106, 107, 108];   // weapon, helmet, armour, soul / necklace, ring, emblem
// [name, MasterType/SonType of its items]: the catalogue's tabs; anything else is "Outros"
const GROUPS = [
  ['Arma', ['1/101']], ['Capacete', ['1/103']], ['Armadura', ['1/104']], ['Colar', ['1/106']], ['Anel', ['1/107']], ['Emblema', ['1/108']],
  ['Asas', ['1/109']], ['Moda / Aparência', ['1/110', '1/111', '1/112', '1/120', '2/228']], ['Equipamento de Alma', ['1/117', '1/118']],
  ['Joias (C–S)', ['5/501', '5/502', '5/503', '5/504', '5/505', '5/506']], ['Medalha', ['1/1301', '1/1302', '3/301']],
  ['Gema', ['2/205']], ['Pedra da Sorte / Refino', ['2/204', '2/214', '2/215']], ['Cristal da Vontade', ['2/312']],
  ['Carta', ['2/218']], ['Fragmento de Carta', ['2/212']], ['Tesouro / Baú', ['2/206', '2/207', '2/416']], ['Pacote', ['2/298']],
  ['Material', ['2/210', '2/227', '2/310']], ['Item Especial / Pontos', ['2/208', '2/200']], ['Livro de Habilidade', ['2/303', '2/226']],
  ['Livro / Transformação', ['2/201']], ['Semente / Fazenda', ['2/216', '2/1500', '2/1501']], ['Silfo', ['4/306', '4/304', '2/305', '2/313']],
  ['Símbolo', ['2/411', '2/412', '2/413', '2/414', '2/415', '2/421', '2/422', '2/423', '2/424', '2/425', '2/400', '2/401', '2/402', '2/605']],
  ['Pedra Rúnica', ['2/302']], ['Título', ['2/221', '2/224']], ['Mobília', ['2/241']], ['Guardião', ['2/1101', '2/1102', '2/1103', '2/318', '2/606']],
  ['Arma Lendária', ['2/625', '2/901', '2/902']], ['Outros', []],
];
const GROUP_OF = new Map(GROUPS.flatMap(([, keys], i) => keys.map(k => [k, i])));
const groupOf = it => GROUP_OF.get(`${it.MasterType}/${it.SonType}`) ?? GROUPS.length - 1;
