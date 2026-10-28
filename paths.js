// Location of the game client files: webroot/ (preferred) or webroot_web/ (the mirrored official web build)
const fs = require('fs');
const path = require('path');
const WEB = ['webroot', 'webroot_web'].map(d => path.join(__dirname, '..', d)).find(d => fs.existsSync(path.join(d, 'gameindex.js')) || fs.existsSync(path.join(d, 'index.js')))
  || path.join(__dirname, '../webroot');
module.exports = { WEB };
