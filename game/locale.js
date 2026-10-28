function firstText(row, keys) {
  if (!row) return '';
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function nameOf(row, ...keys) {
  if (!row) return '';
  const bases = keys.length ? keys : ['TemplateName', 'BuildingName', 'Name', 'PawnName', 'NodeName'];
  const groups = [
    bases.map(k => `${k}_pt`),
    bases.map(k => `${k}_tr`),
    bases.map(k => `${k}_en`),
    bases,
  ];
  return firstText(row, groups.flat()) || String(row.TemplateId ?? row.Id ?? row.id ?? '');
}

function itemName(D, tid) {
  return nameOf(D.items.get(tid));
}

module.exports = { nameOf, itemName };
