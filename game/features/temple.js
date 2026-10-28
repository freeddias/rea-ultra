// Tapınak "Beden" saatleri (client DM, t_s_config temple_open "12:00-14:00,40|17:00-19:00,40|21:00-23:00,40"):
// in each window the player can take that much Beden (weary) once a day. C_TEMPLE_INFO -> 4709 TempleInfoRsp
// {status: "s1,s2,s3"}; C_TEMPLE_RECEIVE {pos 1..3}. States as the window shows them (selectedIndex = state - 1;
// 2 and 5 can be taken, client canReceiveHook): 1 not yet, 2 open now, 3 taken, 4 missed (our reading of the
// four; 5 = a missed one bought back is not offered). The client asks again when a window starts or ends.
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const WAIT = 1, OPEN = 2, TAKEN = 3, MISSED = 4, WEARY_LIMIT = 5000;

module.exports = (ctx) => {
  const { dec, sendT, sendPlayer, alert, table, log } = ctx;
  const WINDOWS = String((table('t_s_config').find(r => r.ConfigName === 'temple_open') || {}).ConfigValue || '').split('|').filter(Boolean).map(s => {
    const [time, v] = s.split(','), [a, b] = time.split('-').map(x => x.split(':').map(Number));
    return { from: a[0] * 60 + a[1], to: b[0] * 60 + b[1], value: Number(v) || 0 };
  });
  const taken = p => { const t = p.s.temple; return t && t.day === dayKey() ? t.got : []; };
  function states(p, now = new Date()) {
    const min = now.getHours() * 60 + now.getMinutes(), got = taken(p);
    return WINDOWS.map((w, i) => got.includes(i + 1) ? TAKEN : min < w.from ? WAIT : min < w.to ? OPEN : MISSED);
  }
  const send = c => sendT(c, 4709, 'temple.TempleInfoRsp', { status: states(c.player).join(',') });
  ctx.templeStates = states;   // tests

  return {
    C_TEMPLE_INFO: send,
    C_TEMPLE_RECEIVE(c, body) {
      const m = dec(c, 'C_TEMPLE_RECEIVE', body), p = c.player, w = WINDOWS[m.pos - 1];
      if (!w) return;
      if (states(p)[m.pos - 1] !== OPEN) { alert(c, 'Não pode ser coletado neste horário'); return send(c); }
      if ((p.s.weary || 0) >= WEARY_LIMIT) { alert(c, 'Energia no limite'); return send(c); }
      p.s.weary = Math.min(WEARY_LIMIT, (p.s.weary || 0) + w.value);
      p.s.temple = { day: dayKey(), got: [...taken(p), m.pos] };
      p.save(); sendPlayer(c); send(c);
      alert(c, `Parabéns, obtido: Energia ${w.value}`);
      log(`[#${c.id}] temple ${m.pos} +${w.value} weary`);
    },
  };
};
