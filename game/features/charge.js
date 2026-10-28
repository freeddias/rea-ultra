// Real-money / local top-up: in-game shop Recharge_Shop sends C_CHARGE_ORDER (or C_TOKEN_CHARGE with
// star coins 2200004). Officially channel.pay then bills; here we credit immediately and also expose
// http://HOST:8899/order for the PAY window (debug / navigateToRechargePage).
// Packs: t_s_recharge. ProductType 1 gems (Para2 diamonds + VIPEx), 2 monthly pass, 3 growth fund,
// 5 warrior pass, 100 star coins (item 2200004).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const STAR_COIN = 2200004;
const PAGE = path.join(__dirname, '../../order_page.html');

module.exports = (ctx) => {
  const { table, dec, sendT, grant, pay, alert, log, online } = ctx;
  const PACKS = table('t_s_recharge');
  const byId = id => PACKS.find(r => r.ProductId === id);
  // main diamond SKUs only (skip .plus / regional duplicates on the local page)
  const gemPacks = () => PACKS.filter(r => Number(r.ProductType) === 1 && /^wartuneh5\.gem\.pay[\d.]+$/.test(r.ProductId))
    .sort((a, b) => Number(a.MoneyNum) - Number(b.MoneyNum));

  function packLabel(r) {
    const raw = r.ProductName_pt || r.ProductName_en || r.ProductName || r.ProductId;
    return String(raw).replace(/\bBalens\b/gi, 'Diamantes');
  }

  // credit a pack to an online connection; returns { ok, out: string[] }
  function fulfill(c, productId, { orderId, count = 1, viaStar = false } = {}) {
    const r = byId(productId);
    if (!r) return { ok: false, out: ['Produto desconhecido: ' + productId] };
    const n = Math.max(1, Math.min(99, count | 0));
    const out = [];
    const type = Number(r.ProductType) || 0;
    const diamonds = Number(r.Para2) || 0;
    const vip = Number(r.VIPEx) || 0;
    const free = Number(r.FreePoint) || 0;

    for (let i = 0; i < n; i++) {
      if (type === 1 || type === 100) {
        const rewards = [];
        if (type === 1 && diamonds > 0) rewards.push([-400, diamonds]);
        if (free > 0) rewards.push([-500, free]);
        if (vip > 0) rewards.push([-5500, vip]);
        if (type === 100) {
          const coins = Number(r.Para2) || Number(r.CostItem) || 0;
          if (coins > 0) rewards.push([STAR_COIN, coins]);
        }
        if (!rewards.length) return { ok: false, out: ['Pacote sem recompensa'] };
        if (!grant(c, rewards, { quiet: true })) return { ok: false, out: ['Mochila/saldo não pôde receber a recarga'] };
        out.push(...rewards.map(([t, v]) => t === -400 ? `+${v} diamantes` : t === -500 ? `+${v} diamantes vinculados`
          : t === -5500 ? `+${v} EXP VIP` : t === STAR_COIN ? `+${v} moedas estrela` : `+${v}`));
      } else if (type === 2) {
        const rewards = [];
        if (diamonds > 0) rewards.push([-400, diamonds]);
        if (vip > 0) rewards.push([-5500, vip]);
        if (rewards.length) grant(c, rewards, { quiet: true });
        const cardType = Number(r.Para1) === 2 ? 2 : 1;
        const days = Number(r.Para4) || 30;
        if (ctx.grantMonthCard) out.push(ctx.grantMonthCard(c, cardType, days));
        else out.push('Passe mensal');
        if (diamonds) out.push(`+${diamonds} diamantes`);
        if (vip) out.push(`+${vip} EXP VIP`);
      } else if (type === 3) {
        if (vip > 0) grant(c, [[-5500, vip]], { quiet: true });
        out.push(ctx.grantGrowthFund ? ctx.grantGrowthFund(c) : 'Fundo de crescimento');
        if (vip) out.push(`+${vip} EXP VIP`);
      } else if (type === 5) {
        if (vip > 0) grant(c, [[-5500, vip]], { quiet: true });
        out.push(ctx.grantWarriorPass ? ctx.grantWarriorPass(c) : 'Passe de Guerreiro');
        if (vip) out.push(`+${vip} EXP VIP`);
      } else {
        // gift / daily packs without item table: VIP EXP only when present
        if (vip > 0) {
          grant(c, [[-5500, vip]], { quiet: true });
          out.push(`+${vip} EXP VIP (${packLabel(r)})`);
        } else {
          out.push(`Pacote ${packLabel(r)} registrado (sem itens configurados nesta versão)`);
        }
      }
    }

    const oid = orderId || crypto.randomBytes(8).toString('hex');
    try {
      sendT(c, 4746, 'charge.ChargeOrderArrive', {
        productId, orderId: oid, point: diamonds * n,
        moneyFen: Math.round(Number(r.MoneyNum) * 100) * n || 0,
      });
    } catch (e) { /* schema optional */ }
    const total = (c.player.s.chargeTotal = (c.player.s.chargeTotal || 0) + Math.round(Number(r.MoneyNum) * 100) * n);
    try { sendT(c, 4747, 'charge.ChargeData', { totalMoney: total }); } catch (e) { }
    c.player.save();
    alert(c, `Recarga: ${packLabel(r)} — ${out.join(' · ')}`);
    log(`[#${c.id}] charge ${productId} x${n}${viaStar ? ' (star)' : ''} → ${out.join(', ')}`);
    return { ok: true, out, orderId: oid };
  }

  function order(c, productId, count, { viaStar = false } = {}) {
    const r = byId(productId);
    if (!r) {
      sendT(c, 4710, 'mall.ChargeOrderRsp', { result: 0, orderId: '', productId: productId || '' });
      alert(c, 'Produto de recarga desconhecido');
      return;
    }
    if (viaStar) {
      const need = (Number(r.CostItem) || 0) * Math.max(1, count || 1);
      if (need > 0 && !pay(c, [[STAR_COIN, need]])) {
        sendT(c, 4710, 'mall.ChargeOrderRsp', { result: 0, orderId: '', productId });
        alert(c, 'Moedas estrela insuficientes');
        return;
      }
    }
    const orderId = crypto.randomBytes(12).toString('hex');
    sendT(c, 4710, 'mall.ChargeOrderRsp', { result: 1, orderId, productId });
    // private server: no external billing — credit as soon as the order is accepted
    fulfill(c, productId, { orderId, count: count || 1, viaStar });
  }

  // ---- HTTP /order page (PAY URL) -----------------------------------------------------------------
  const http = require('../../http');
  const auth = require('../../auth');
  const html = () => fs.readFileSync(PAGE);
  const json = (res, o) => http.send(res, 200, JSON.stringify(o), 'application/json');
  const packsPublic = () => gemPacks().map(r => ({
    id: r.ProductId,
    name: packLabel(r),
    desc: r.ProductDesc || '',
    money: Number(r.MoneyNum) || 0,
    currency: r.MoneyType || 'USD',
    diamonds: Number(r.Para2) || 0,
    show: Number(r.Para3) || Number(r.Para2) || 0,
    vip: Number(r.VIPEx) || 0,
    img: r.ProductImg || '',
  })).concat(
    PACKS.filter(r => [2, 3, 5].includes(Number(r.ProductType))).map(r => ({
      id: r.ProductId,
      name: packLabel(r),
      desc: r.ProductDesc || '',
      money: Number(r.MoneyNum) || 0,
      currency: r.MoneyType || 'USD',
      diamonds: Number(r.Para2) || 0,
      show: Number(r.Para3) || 0,
      vip: Number(r.VIPEx) || 0,
      img: r.ProductImg || '',
      kind: Number(r.ProductType),
    }))
  );

  function accountOf(req) {
    const se = auth.ENABLED && auth.session(req.headers.cookie);
    if (!se) return null;
    return Object.values(require('../../db').state.accounts).find(x => x.userName === se.userName && x.site === se.site) || null;
  }

  http.route('/order', (req, res) => {
    if (req.method === 'GET' || !req.method) http.send(res, 200, html(), 'text/html; charset=utf-8');
    else http.send(res, 405, 'use GET');
  });
  // some clients hit /order/
  http.route('/order/', (req, res) => http.send(res, 200, html(), 'text/html; charset=utf-8'));

  http.route('/order/packs', (req, res) => {
    const a = accountOf(req);
    const onlineP = a && a.char && [...online.values()].find(c => c.player && c.player.id === a.userId);
    const p = onlineP && onlineP.player;
    json(res, {
      ok: true,
      user: a ? a.userName : null,
      nickName: (a && a.char && a.char.nickName) || null,
      online: !!p,
      point: p ? Math.floor(p.s.point || 0) : (a && a.char && null),
      packs: packsPublic(),
    });
  });

  http.route('/order/buy', (req, res, body) => {
    let m = {}; try { m = JSON.parse(body.toString() || '{}'); } catch (e) { }
    const a = accountOf(req);
    if (!a || !a.char) return json(res, { ok: false, error: 'Faça login no portal do jogo primeiro' });
    const c = [...online.values()].find(x => x.player && x.player.id === a.userId);
    if (!c) return json(res, { ok: false, error: 'Entre no jogo (personagem online) para receber a recarga' });
    const productId = String(m.productId || '');
    const r = byId(productId);
    if (!r) return json(res, { ok: false, error: 'Produto inválido' });
    const result = fulfill(c, productId, { count: 1 });
    json(res, { ok: result.ok, out: result.out, point: Math.floor(c.player.s.point || 0) });
  });

  // so siteConfig PAY points here
  ctx.chargePayPath = '/order?';

  return {
    C_CHARGE_ORDER(c, body) {
      const m = dec(c, 'C_CHARGE_ORDER', body);
      order(c, m.productId, m.count || 1, { viaStar: false });
    },
    C_TOKEN_CHARGE(c, body) {
      const m = dec(c, 'C_TOKEN_CHARGE', body);
      order(c, m.productId, m.count || 1, { viaStar: true });
    },
  };
};
