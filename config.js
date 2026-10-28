const os = require('os');

// Prefer a real LAN IPv4 so phones/PCs on the same network can open the game without setting HOST.
// Skip common virtual adapters (VirtualBox, VMware, Hyper-V, Docker, WSL) when a physical one exists.
const SKIP = /virtualbox|vmware|hyper-v|vethernet|docker|wsl|loopback|bluetooth|isatap|teredo/i;
function lanIp() {
  const nets = os.networkInterfaces();
  const scored = [];
  for (const [name, list] of Object.entries(nets)) {
    for (const n of list || []) {
      const fam = n.family === 4 || n.family === 'IPv4';
      if (!fam || n.internal) continue;
      let score = 0;
      if (/^192\.168\./.test(n.address)) score += 3;
      else if (/^10\./.test(n.address)) score += 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(n.address)) score += 1;
      if (/^192\.168\.56\./.test(n.address)) score -= 4; // VirtualBox host-only default
      if (SKIP.test(name)) score -= 5;
      if (/wi-?fi|wlan|ethernet|en\d|eth/i.test(name) && !SKIP.test(name)) score += 4;
      scored.push({ address: n.address, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return (scored[0] && scored[0].address) || '127.0.0.1';
}

module.exports = {
  HOST: process.env.HOST || lanIp(),     // address advertised in logs / fallback URLs
  // listen on every interface by default so the game + admin work from the LAN
  BIND: process.env.BIND || '0.0.0.0',
  HTTP_PORT: +process.env.HTTP_PORT || 8899,
  LOGIN_PORT: +process.env.LOGIN_PORT || 8900,
  GATE_PORT: +process.env.GATE_PORT || 8901,
  SITE_NAME: 'local_1',
  SITE_ID: 1,
  SERVER_NAME: 'Local',
};
