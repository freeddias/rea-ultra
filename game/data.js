// Indexed access to the client's game tables (webroot/res/release/config/t_s_*.json).
const { table } = require('../templates');

const by = (rows, key) => { const m = new Map(); for (const r of rows) m.set(r[key], r); return m; };
const groupBy = (rows, key) => { const m = new Map(); for (const r of rows) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); } return m; };

const D = {
  items: by(table('t_s_itemtemplate'), 'TemplateId'),
  heroes: by(table('t_s_herotemplate'), 'TemplateId'),
  skills: by(table('t_s_skilltemplate'), 'TemplateId'),
  pawns: by(table('t_s_pawntemplate'), 'TemplateId'),
  quests: by(table('t_s_questtemplate'), 'TemplateId'),
  questConds: groupBy(table('t_s_questcondiction'), 'TemplateId'),
  questGoods: groupBy(table('t_s_questgood'), 'TemplateId'),
  drops: groupBy(table('t_s_dropitem'), 'DropId'),
  dropConds: groupBy(table('t_s_dropcondition'), 'DropId'),
  buildings: by(table('t_s_buildingtemplate'), 'TemplateId'),
  campaigns: by(table('t_s_campaign'), 'CampaignId'),
  campNodes: by(table('t_s_campaigndata'), 'Id'),
  campNodesByCampaign: groupBy(table('t_s_campaigndata'), 'CampaignId'),
  upgrade: groupBy(table('t_s_upgradetemplate'), 'Types'),
  stars: by(table('t_s_startemplate'), 'TemplateId'),
};

// player level -> exp needed to reach it: upgrade type 3 (client UPGRADE_TYPE_PLAYER, levels 1..160; the same as
// type 25 up to Lv23, the capture's range). Type 25 is the pets' table (client Fy.UPGRAD_TYPE), 1..80.
// Heroes stop at Lv80 until the job change (features/transfer.js, t_s_transfer AddGrade 80) -> Player.maxLevel().
D.levelExp = new Map((D.upgrade.get(3) || D.upgrade.get(25)).map(r => [r.Grades, r.Data]));
D.petLevelExp = new Map((D.upgrade.get(25) || D.upgrade.get(3)).map(r => [r.Grades, r.Data]));
D.maxLevel = Math.max(...D.levelExp.keys());
D.baseMaxLevel = 80;

// buildings: (sonType, grade) -> template
D.buildingBySon = new Map();
for (const b of D.buildings.values()) D.buildingBySon.set(b.SonType + '|' + b.BuildingGrade, b);

module.exports = D;
