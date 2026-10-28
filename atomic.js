// Write a file through a temp file + rename. On Windows the rename can fail with EPERM/EBUSY for a moment
// while an antivirus or the indexer holds the target (seen in tests); retry briefly, then write directly.
const fs = require('fs');

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      const until = Date.now() + 15 * (i + 1); while (Date.now() < until) { /* short synchronous back-off */ }
    }
  }
  fs.writeFileSync(file, text);
  try { fs.unlinkSync(tmp); } catch (e) { }
}

module.exports = { writeAtomic };
