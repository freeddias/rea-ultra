// Uzak Peri seferi (英灵远征; client ED / pD RemotePetModel, RemotePetWnd, RemoteMopupWnd; t_s_remotepet 90 floors,
// skills = t_s_skilltemplate MasterType 200; config Remotepet_Weary 30). Client-derived, no capture:
//  C_REMOTE_PET_OP remotepet.RemotePetOpMsg {op}: 1 info, 2 save the line-up {pos (8 entries), pets [PetSiteMsg
//  {petId, site, skills}], isFirst}, 5 upgrade a remote skill, 6 fight floor {index}, 7 sweep {sweepIndex = the last
//  floor}, 9 / 10 sweep state -> 4964 U_C_REMOTE_PET_MSG RemotePetMsg {nowIndex (cleared this cycle; the client
//  offers nowIndex + 1), MaxIndex (best), pos, pets "site,petId|..." (sites 4..6 are not pets), skillStatus
//  "skillId,uses|..." (the battle skill bar), sweepIndex, isFirst ...}. Sweep rewards: 4967 RemoteItemMsg {type 2,
//  count = floor, items "tid|n,..."}. A floor: Heros "templateId,pos" (the boss), DropItems / FirstDropItems
//  "tid|n,...", Skill = the remote skill it gives, Sweep = floors that can be swept once it is the best.
//  Fight: battle type 3844 REMOTE_PET_BATLE (pets in pets, the boss in heros); in battle B_REMOTE_PET_ORDER
//  battle.UseSkillMsg {battleId, skillId} casts a remote skill (one use).
// 2026-10-23 live capture: a won floor -> "Expedição N. seção concluída, obtido:&nbsp;Ouro x 50000" + 4964 whose items
// lists the day's collected rewards "tid,n|tid,n"; op 7 {sweepIndex} only starts a sweep (4964 sweepIndex + sweepTime
// ~2 s ahead), op 10 collects it (the floors up to sweepIndex: "Ganho: <name> x n,.." alert, 4967 {type 2, count,
// items "tid,n|..|"}, nowIndex = sweepIndex), op 9 clears the sweep fields (sweepTime 2000-01-01).
// Our choices: each fight / swept floor costs Remotepet_Weary; pets keep their hp between floors (dead ones stay
// out) until the daily reset (nowIndex 0, full hp, skill uses back to 1 per owned skill); a floor's Skill gives
// one more use; sweeping is instant (floors nowIndex + 1 .. min(sweepIndex, MaxIndex)); skills have one grade so
// op 5 has nothing to upgrade; a friend's pet (site 7, CH_REMOTE_FRIEND_PET) fights with its owner's current values;
// the ranking (order) is not built.
const POS = [2, 5, 8, 3, 6, 9];

module.exports = (ctx) => {
  const { D, table, dec, sendT, alert, grant, CONF, sysTime, log } = ctx;
  const FLOORS = new Map(table('t_s_remotepet').map(r => [r.Count, r]));
  const TOP = Math.max(...FLOORS.keys());
  const WEARY = CONF.get('Remotepet_Weary') || 30;
  const items = s => String(s || '').split(',').map(x => x.split('|').map(Number)).filter(([t, n]) => t && n);
  const day = () => sysTime().slice(0, 10);
  const pets = p => ((p.s.pets || {}).list || []);

  function state(p) {
    const r = p.s.remotePet = p.s.remotePet || { now: 0, max: 0, pos: '-1,-1,-1,-1,-1,-1,-1,-1', sites: {}, skills: {}, hp: {}, first: false };
    if (r.day !== day()) {
      Object.assign(r, { day: day(), now: 0, hp: {}, got: {}, sweep: null });
      for (const id of Object.keys(r.skills)) r.skills[id] = Math.max(1, r.skills[id]);
    }
    for (const [site, id] of Object.entries(r.sites)) if (!pets(p).some(x => x.id === id)) delete r.sites[site];
    return r;
  }
  const fighters = p => {
    const r = state(p), own = Object.entries(r.sites).filter(([site]) => !['4', '5', '6', '7'].includes(site)).map(([site, id]) => ({ site: Number(site), pet: pets(p).find(x => x.id === id), owner: p })).filter(x => x.pet);
    const fo = r.friend && ctx.playerById(r.friend.userId), fp = fo && pets(fo).find(x => x.id === r.friend.petId);
    return fp ? [...own, { site: 7, pet: fp, owner: fo, friend: true }] : own;
  };
  const friendIds = p => Object.entries(p.s.relations || {}).filter(([, v]) => v && v.relation === 1).map(([id]) => Number(id));
  function msg(p) {
    const r = state(p), fight = fighters(p).reduce((n, x) => { const cb = ctx.petCombat(x.owner, x.pet); return n + Math.ceil(700 + cb.stats.attack + cb.stats.magicAttack + cb.stats.defence + cb.stats.magicDefence + cb.hp / 5); }, 0);
    return { userId: p.id, nowIndex: r.now, MaxIndex: r.max, pos: r.pos, pets: Object.entries(r.sites).map(([s, id]) => `${s},${id}`).concat(r.friend ? [`7,${r.friend.petId}`] : []).join('|'),
      skills: Object.keys(r.skills).join(','), skillStatus: Object.entries(r.skills).map(([id, n]) => `${id},${n}`).join('|'),
      items: Object.entries(r.got || {}).map(([t, n]) => `${t},${n}`).join('|'), sweepIndex: r.sweep ? r.sweep.to : 0, sweepTime: r.sweep ? r.sweep.time : '2000-01-01 00:00:00',
      isFirst: !!r.first, fight, order: 0, lastOrder: 0, isGet: false, resetTime: 0, specialIndex: 0 };
  }
  const send = c => sendT(c, 4964, 'remotepet.RemotePetMsg', msg(c.player));
  ctx.onLoad.push(c => { if (pets(c.player).length) send(c); });

  // the remote skill bar: B_REMOTE_PET_ORDER casts through the first living pet (one use)
  function castSkill(c, skillId) {
    const b = c.battle, r = state(c.player);
    if (!b || b.type !== 3844 || !(r.skills[skillId] > 0)) return;
    const u = b.units.find(x => x.side === 1 && x.hp > 0 && x.petId); if (!u) return;
    r.skills[skillId]--; u.forceSkill = skillId;
    c.player.save();
    send(c);
  }
  function win(c, f, first) {
    const p = c.player, r = state(p), list = [...items(f.DropItems), ...(first ? items(f.FirstDropItems) : [])];
    if (f.Skill && D.skills.has(f.Skill)) r.skills[f.Skill] = (r.skills[f.Skill] || 0) + 1;
    r.now = Math.max(r.now, f.Count); r.max = Math.max(r.max, f.Count);
    r.got = r.got || {}; for (const [t, n] of list) r.got[t] = (r.got[t] || 0) + n;
    grant(c, list, { quiet: true });
    return list;
  }

  return {
    C_REMOTE_PET_OP(c, body) {
      const m = dec(c, 'C_REMOTE_PET_OP', body), p = c.player, r = state(p);
      switch (m.op) {
        case 2: {
          r.sites = {}; const pick = r.friendPick; r.friend = null;
          for (const x of m.pets || []) {
            if (x.site === 7 && pick && pick.petId === x.petId) { r.friend = pick; continue; }   // a friend's pet (CH_REMOTE_FRIEND_PET op 2)
            const pet = pets(p).find(y => y.id === x.petId); if (!pet || x.site < 0 || x.site > 7 || Object.values(r.sites).includes(pet.id)) continue;
            r.sites[x.site] = pet.id;
            if (x.skills != null) pet.remoteSkills = String(x.skills);
          }
          if (m.pos) r.pos = String(m.pos);
          if (m.isFirst) r.first = true;
          p.save(); break;
        }
        case 5: alert(c, 'Esta habilidade está no nível máximo'); break;
        case 6: {
          const f = FLOORS.get(m.index);
          if (!f || c.battle) break;
          if (m.index > r.now + 1) { alert(c, 'Conclua os andares anteriores primeiro'); break; }
          const key = x => (x.friend ? 'f' : '') + x.pet.id;   // hp memory: a friend's pet apart from ours
          const mine = fighters(p).filter(x => r.hp[key(x)] !== 0);
          if (!mine.length) { alert(c, 'Coloque um silfo na expedição'); break; }
          if (!ctx.spendWeary(c, WEARY)) break;
          const bosses = String(f.Heros || '').split('|').filter(Boolean).map(x => { const [tempId, pos] = x.split(',').map(Number); return { tempId, pos: pos || 5 }; }).filter(x => D.heroes.has(x.tempId));
          const first = f.Count > r.max;
          ctx.startPetPvp(c, [{ userId: p.id, nickName: p.s.nickName, pets: mine.slice(0, 6).map((x, k) => ({ pos: POS[k], combat: ctx.petCombat(x.owner, x.pet), hp: r.hp[key(x)], key: key(x) })) }, { pets: [] }], {
            battleType: 3844, mapTempId: 992, scene: 19, bosses,
            onEnd(won, units) {
              for (const u of units) if (u.side === 1 && u.petId) r.hp[u.petId] = Math.max(0, u.hp);
              if (won) { const got = win(c, f, first); alert(c, `Expedição ${f.Count}. seção concluída, obtido:&nbsp;${got.map(([t, n]) => `${ctx.rewardName(t)} x ${n}`).join(',')}`); }
              p.save(); send(c);
              log(`[#${c.id}] remote pet floor ${f.Count}: ${won ? 'won' : 'lost'}`);
            },
          });
          return;
        }
        case 7: {   // start a sweep of floors already beaten before
          const to = Math.min(m.sweepIndex || 0, r.max, TOP);
          if (to <= r.now) { alert(c, 'Nenhum andar para varrer'); break; }
          const d = new Date(Date.now() + 2000), pad = n => String(n).padStart(2, '0');
          r.sweep = { to, time: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` };
          p.save(); break;
        }
        case 10: {   // collect the sweep
          if (!r.sweep) break;
          const total = new Map(); let floors = 0;
          for (let k = r.now + 1; k <= r.sweep.to; k++) {
            const f = FLOORS.get(k); if (!f) break;
            if (!ctx.spendWeary(c, WEARY)) break;
            for (const [t, n] of win(c, f, false)) total.set(t, (total.get(t) || 0) + n);
            floors++;
          }
          if (floors) {
            alert(c, 'Ganho: ' + [...total].map(([t, n]) => `${ctx.rewardName(t)} x ${n}`).join(','));
            sendT(c, 4967, 'remotepet.RemoteItemMsg', { type: 2, count: floors, items: [...total].map(([t, n]) => `${t},${n}|`).join('') });
          }
          p.save(); break;
        }
        case 9: if (r.sweep && r.now >= r.sweep.to) { r.sweep = null; p.save(); } break;   // clears a collected sweep
        default: break;   // 1 info
      }
      send(c);
    },
    // friends' pets for site 7: op 1 the list -> 4965 RemoteFriendPetMsg {pets [FriendPetMsg]}, op 2 one of them -> 4966 PetInfoMsg
    CH_REMOTE_FRIEND_PET(c, body) {
      const m = dec(c, 'CH_REMOTE_FRIEND_PET', body), p = c.player;
      if (m.op === 2) {
        const f = friendIds(p).includes(m.friendId) && ctx.playerById(m.friendId), info = f && ctx.petInfos(f).find(x => x.petId === m.petId);
        if (!info) { alert(c, 'Silfo não encontrado'); return; }
        state(p).friendPick = { userId: f.id, petId: m.petId }; p.save();
        return sendT(c, 4966, 'pet.PetInfoMsg', info);
      }
      const list = [];
      for (const id of friendIds(p)) {
        const f = ctx.playerById(id); if (!f) continue;
        for (const info of ctx.petInfos(f)) {
          const tp = ctx.petTemplate(info.templateId) || {};
          list.push({ friendId: id, friendName: f.s.nickName, petId: info.petId, petName: info.petName, petTempId: info.templateId, petFight: info.fightingCapacity, petQuality: info.quality, petType: tp.PetType || 0 });
        }
      }
      sendT(c, 4965, 'remotepet.RemoteFriendPetMsg', { pets: list });
    },
    B_REMOTE_PET_ORDER(c, body) { const m = dec(c, 'B_REMOTE_PET_ORDER', body); castSkill(c, m.skillId); },
  };
};
