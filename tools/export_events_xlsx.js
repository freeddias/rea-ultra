// Exporta para Excel todos os eventos mapeados no Wartune Ultra.
// Uso: node tools/export_events_xlsx.js [caminho-saida.xlsx]
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = path.join(__dirname, '..');
const outPath = process.argv[2]
  || path.join(ROOT, '..', 'docs', 'Eventos_Wartune_Ultra.xlsx');

const lang = (s, prefer = 'pt') => {
  const raw = String(s || '');
  const m = raw.match(new RegExp(`<${prefer}>([\\s\\S]*?)</${prefer}>`, 'i'))
    || raw.match(/<en>([\s\S]*?)<\/en>/i)
    || raw.match(/<tr>([\s\S]*?)<\/tr>/i);
  return (m ? m[1] : raw.replace(/<\/?[a-z]+>/gi, '')).replace(/\s+/g, ' ').trim();
};

const forceLabel = (f) => (f === true ? 'Forçado ABERTO' : f === false ? 'Forçado FECHADO' : 'Calendário');
const openLabel = (o) => (o === true ? 'Aberto' : o === false ? 'Fechado' : 'Indefinido / sem probe');

// ---- sheet 1: catálogo admin (eventflags) --------------------------------------------------------
const flags = require('../game/eventflags');
// carrega features para registrar probes de calendário (precisa de um ctx mínimo)
function loadProbes() {
  const table = require('../templates').table;
  const CONF = {
    get: (n) => Number((table('t_s_config').find(r => r.ConfigName === n) || {}).ConfigValue) || 0,
    str: (n) => String((table('t_s_config').find(r => r.ConfigName === n) || {}).ConfigValue || ''),
  };
  const { sysTime } = require('../util');
  const ctx = {
    events: flags, table, CONF, sysTime,
    dec() {}, sendT() {}, alert() {}, pay() {}, grant() {},
    onLoad: { push() {} }, onClose() {}, onStat() {}, onLogin: { push() {} },
    M: { addShow() {} },
  };
  const FEATURES = path.join(ROOT, 'game', 'features');
  for (const f of ['season.js', 'pass.js', 'carnival.js', 'goldenroad.js', 'memorycard.js',
    'sumactive.js', 'guarddraw.js', 'guildmaze.js', 'worldboss.js', 'dragonnest.js',
    'warfield.js', 'treasuremine.js', 'starmoonruins.js']) {
    try { require(path.join(FEATURES, f))(ctx); } catch (e) { /* probe opcional */ }
  }
}
loadProbes();
const catalogStatus = flags.status();
const sheetCatalog = catalogStatus.map((e, i) => ({
  '#': i + 1,
  Chave: e.key,
  Nome: e.label,
  Grupo: e.group,
  Descrição: e.hint,
  'Modo atual': forceLabel(e.force),
  'Calendário agora': e.calendarOpen == null ? '—' : (e.calendarOpen ? 'Aberto' : 'Fechado'),
  'Estado efetivo': openLabel(e.open),
  'Arquivo feature': featureFile(e.key),
  'Controle admin': 'Sim (/admin/events)',
}));

function featureFile(key) {
  const map = {
    season: 'features/season.js',
    seasonPass: 'features/season.js',
    seasonShop: 'features/season.js',
    dragonNest: 'features/dragonnest.js',
    warriorPass: 'features/pass.js',
    carnival: 'features/carnival.js',
    goldenRoad: 'features/goldenroad.js',
    memoryCard: 'features/memorycard.js',
    sumActive: 'features/sumactive.js',
    guardDraw: 'features/guarddraw.js',
    guildMaze: 'features/guildmaze.js',
    worldBoss: 'features/worldboss.js',
    warField: 'features/warfield.js',
    treasureMine: 'features/treasuremine.js',
    starMoonRuins: 'features/starmoonruins.js',
  };
  return map[key] || '';
}

// ---- sheet 2: SumActive -------------------------------------------------------------------------
const SUM = require('../data/sumactive.json');
const COND = {
  11: 'Troca de itens', 13: 'Pontos de atividade do dia', 14: 'Dias de login', 23: 'Missões de recompensa',
  26: 'Lutas de arena', 45: 'Compensação (grátis)', 47: 'Treino de pet', 48: 'Treino de pet (alt)',
  105: 'Torre de reis / trial', 110: 'Arena de silfos', 131: 'Dias de login', 166: 'Dias de recarga',
  18: 'Treino de montaria', 505: 'Consumo de energia', 516: 'Uso de item', 518: 'Torre / trial',
  522: 'Expedição de guardas',
};
const sheetSum = SUM.actives.map((a, i) => {
  const c = ((a.packages[0] || {}).conditions || [])[0] || {};
  return {
    '#': i + 1,
    activeId: a.activeId,
    Título: lang(a.title),
    'Título (EN)': lang(a.title, 'en'),
    mainType: a.mainType === 3 ? 'Wonderland (3)' : 'Eventos (0)',
    activeType: a.activeType,
    getway: a.getway === 3 ? 'Diário (3)' : a.getway,
    beginDate: a.beginDate,
    endDate: a.endDate,
    startTime: a.startTime,
    stopTime: a.stopTime,
    'Pacotes': (a.packages || []).length,
    'Condição ID': c.conditionId || '',
    'Condição': COND[c.conditionId] || (c.conditionId ? `Tipo ${c.conditionId}` : ''),
    'Valor alvo': c.conditionValue || '',
    'Fonte dados': 'data/sumactive.json',
  };
});

// ---- sheet 3: Temporada (t_s_season) -------------------------------------------------------------
const table = require('../templates').table;
const TYPE_NAME = {
  1: 'Principal (season)', 2: 'Hall', 3: 'Passe (seasonPass)', 4: 'Guardian',
  5: 'Loja / mercado (seasonShop)', 6: 'Top arena', 7: 'Ninho do Dragão (dragonNest)',
};
const seasons = table('t_s_season') || [];
const now = require('../util').sysTime();
const sheetSeason = seasons.map((r, i) => {
  const open = String(r.OpenTime) <= now && now <= String(r.CloseTime);
  return {
    '#': i + 1,
    TemplateId: r.TemplateId,
    SeasonId: r.SeasonId,
    Type: r.Type,
    'Tipo': TYPE_NAME[r.Type] || `Type ${r.Type}`,
    Nome: lang(r.Name || r.Title || r.ActivityName || r.Desc || ''),
    OpenTime: r.OpenTime,
    CloseTime: r.CloseTime,
    'Aberto agora': open ? 'Sim' : 'Não',
    'Mapeado no servidor': [1, 3, 5, 7].includes(r.Type) ? 'Sim' : 'Não (não implementado)',
    'Chave eventflags': ({ 1: 'season', 3: 'seasonPass', 5: 'seasonShop', 7: 'dragonNest' })[r.Type] || '',
  };
});

// ---- sheet 4: Chamada de guardas (gacha) --------------------------------------------------------
const pools = table('t_s_gachacontrol') || [];
const sheetGacha = pools.map((r, i) => {
  const [from, to] = String(r.OpenTime || '').split('|');
  const nowMs = Date.now();
  const a = from ? new Date(String(from).trim().replace(' ', 'T')).getTime() : NaN;
  const b = to ? new Date(String(to).trim().replace(' ', 'T')).getTime() : NaN;
  const cal = r.Open && !isNaN(a) && !isNaN(b) && nowMs >= a && nowMs <= b;
  return {
    '#': i + 1,
    TemplateId: r.TemplateId,
    Nome: lang(r.Name || r.Title || r.PoolName || ''),
    Open: r.Open ? 'Sim' : 'Não',
    OpenTime_de: from || '',
    OpenTime_ate: to || '',
    Cost: r.Cost || '',
    FreeReset: r.FreeReset || 0,
    PityCounter: r.PityCounter || '',
    'Calendário agora': cal ? 'Aberto' : 'Fechado',
    'Chave eventflags': 'guardDraw',
  };
});

// ---- sheet 5: outros eventos / sistemas com janela ---------------------------------------------
const passIdx = table('t_s_passindex') || [];
const sheetPass = passIdx.map((r, i) => ({
  '#': i + 1,
  Sistema: 'Passe de Guerreiro (warriorPass)',
  TemplateId: r.TemplateId || r.Id || i + 1,
  Nome: lang(r.Name || r.Title || r.PassName || ''),
  OpenTime: r.OpenTime || r.BeginTime || '',
  CloseTime: r.CloseTime || r.EndTime || '',
  'Chave eventflags': 'warriorPass',
  Arquivo: 'features/pass.js',
}));

const sheetOther = [
  {
    Sistema: 'Chefe Global / CG (worldBoss)',
    Janela: '11:30–12:30 (campanha 5001) e 21:00–22:00 (campanha 5002)',
    'Padrão calendário': 'Horários acima (ou WORLDBOSS_OPEN)',
    'Chave eventflags': 'worldBoss',
    Arquivo: 'features/worldboss.js',
    Notas: 'Mapas 5001–5008; HP por nível (NewWorldBoss_MaxHp)',
  },
  {
    Sistema: 'Labirinto da Guilda (guildMaze)',
    Janela: 'Dias 6–12 e 20–26 de cada mês (t_s_Guildmaze_time)',
    'Padrão calendário': 'Dias do mês (ou GUILDMAZE_OPEN)',
    'Chave eventflags': 'guildMaze',
    Arquivo: 'features/guildmaze.js',
    Notas: 'Requer guilda; andares t_s_guildmaze',
  },
  {
    Sistema: 'Carnaval (carnival)',
    Janela: 'Sempre aberto (exceto CARNIVAL=0 ou force fechado)',
    'Padrão calendário': 'Aberto',
    'Chave eventflags': 'carnival',
    Arquivo: 'features/carnival.js',
    Notas: 'Desafios diários, sorteios, minigames, presentes',
  },
  {
    Sistema: 'Estrada Dourada (goldenRoad)',
    Janela: 'Semanal (sempre aberto no probe)',
    'Padrão calendário': 'Aberto',
    'Chave eventflags': 'goldenRoad',
    Arquivo: 'features/goldenroad.js',
    Notas: 'PropertyMsg param1=2',
  },
  {
    Sistema: 'Cartas da Memória (memoryCard)',
    Janela: 'Janela renovável de 30 dias (sempre aberto no probe)',
    'Padrão calendário': 'Aberto',
    'Chave eventflags': 'memoryCard',
    Arquivo: 'features/memorycard.js',
    Notas: 'NewMemoryCardState',
  },
  {
    Sistema: 'Ruínas da Estrela da Lua (starMoonRuins)',
    Janela: 'Sem calendário oficial neste build — abrir via admin',
    'Padrão calendário': 'Fechado',
    'Chave eventflags': 'starMoonRuins',
    Arquivo: 'features/starmoonruins.js',
    Notas: 'cccactive 134; Bússola 2100037 / Fragmento 2100038 / Baú 2100039; data/starmoonruins.json',
  },
  {
    Sistema: 'Metas de 7 dias (seven)',
    Janela: '7 dias a partir da criação do personagem',
    'Padrão calendário': 'Por personagem',
    'Chave eventflags': '— (não está no catálogo admin)',
    Arquivo: 'features/seven.js',
    Notas: 't_s_seventarget / seventreasure / sevensignin',
  },
  {
    Sistema: 'Presentes limitados (limitedgift)',
    Janela: 'Por condição da tabela t_s_limitedtimegift',
    'Padrão calendário': 'Tabela',
    'Chave eventflags': '—',
    Arquivo: 'features/limitedgift.js',
    Notas: 'Condition === 3 filtrado no servidor',
  },
  {
    Sistema: 'Pacotes de presente (giftpack)',
    Janela: 't_s_giftpackage',
    'Padrão calendário': 'Tabela',
    'Chave eventflags': '—',
    Arquivo: 'features/giftpack.js',
    Notas: 'Login envia 4971',
  },
  {
    Sistema: 'Atividade diária / LEED',
    Janela: 'Diário (pontos de atividade)',
    'Padrão calendário': 'Sempre',
    'Chave eventflags': '—',
    Arquivo: 'features/leed.js',
    Notas: 'Códigos 4150/4152; alimenta SumActive condição 13',
  },
];

// ---- sheet 6: índice / resumo -------------------------------------------------------------------
const sheetIndex = [
  { Aba: '1_Catalogo_Admin', Conteúdo: 'Eventos do painel /admin/events (eventflags.js)', Linhas: sheetCatalog.length },
  { Aba: '2_SumActive', Conteúdo: 'Atividades do calendário SumActive / Etkinlikler', Linhas: sheetSum.length },
  { Aba: '3_Temporada', Conteúdo: 'Linhas t_s_season (módulos da temporada)', Linhas: sheetSeason.length },
  { Aba: '4_Chamada_Guardas', Conteúdo: 'Pools de gacha t_s_gachacontrol', Linhas: sheetGacha.length },
  { Aba: '5_Passe_Guerreiro', Conteúdo: 'Índices t_s_passindex', Linhas: sheetPass.length },
  { Aba: '6_Outros_Sistemas', Conteúdo: 'Eventos com janela fora do catálogo ou auxiliares', Linhas: sheetOther.length },
  { Aba: '—', Conteúdo: `Gerado em ${new Date().toISOString()}`, Linhas: '' },
  { Aba: '—', Conteúdo: 'Fonte: server/game/eventflags.js + features/* + templates + data/sumactive.json', Linhas: '' },
];

const wb = XLSX.utils.book_new();
const add = (name, rows) => {
  const ws = XLSX.utils.json_to_sheet(rows);
  // larguras aproximadas
  const keys = rows[0] ? Object.keys(rows[0]) : [];
  ws['!cols'] = keys.map(k => ({ wch: Math.min(48, Math.max(10, String(k).length + 2, ...rows.slice(0, 30).map(r => String(r[k] ?? '').length))) }));
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
};

add('0_Indice', sheetIndex);
add('1_Catalogo_Admin', sheetCatalog);
add('2_SumActive', sheetSum);
add('3_Temporada', sheetSeason);
add('4_Chamada_Guardas', sheetGacha);
if (sheetPass.length) add('5_Passe_Guerreiro', sheetPass);
add('6_Outros_Sistemas', sheetOther);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
XLSX.writeFile(wb, outPath);
console.log(`Excel gerado: ${outPath}`);
console.log(`  Catálogo admin: ${sheetCatalog.length}`);
console.log(`  SumActive: ${sheetSum.length}`);
console.log(`  Temporada: ${sheetSeason.length}`);
console.log(`  Gacha: ${sheetGacha.length}`);
console.log(`  Passe: ${sheetPass.length}`);
console.log(`  Outros: ${sheetOther.length}`);
