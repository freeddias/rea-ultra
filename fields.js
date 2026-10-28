// node fields.js player.PlayerMsg [depth]  -> print schema of a proto type
const s = require('./schema.json');
function show(t, ind = '', d = +process.argv[3] || 0) {
  const m = s[t]; if (!m) return console.log(ind + '?? ' + t);
  for (const [k, f] of Object.entries(m.fields).sort((a, b) => (a[1].id || 999) - (b[1].id || 999))) {
    console.log(`${ind}${f.id} ${k}: ${f.repeated ? 'repeated ' : ''}${f.type || f.kind}`);
    if (f.type && d > 0) show(f.type, ind + '    ', d - 1);
  }
}
for (const a of process.argv.slice(2).filter(x => isNaN(x))) {
  const cm = require('./codemap.json').s2c[a];
  const t = cm ? cm.type : a;
  console.log('== ' + a + (cm ? ` (code ${cm.code}) ` + t : ''));
  show(t);
}
