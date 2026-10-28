// Static file server for the rebuilt webroot + local stand-ins for 7Road's HTTP endpoints.
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = require('./paths').WEB;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.xml': 'text/xml',
  '.txt': 'text/plain', '.wasm': 'application/wasm', '.ttf': 'font/ttf', 
};

const missing = new Set();
const routes = {};   // pathname -> handler(req, res, body, query)

function route(p, fn) { routes[p] = fn; }

// versioned asset names (name-<10 hex>.ext) never change content -> let the browser cache them for good
const VERSIONED = /-[0-9a-f]{10}\.[a-z0-9]+$/i;
function send(res, code, body, type, reqPath) {
  res.writeHead(code, {
    'Content-Type': type || 'text/plain',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': code === 200 && reqPath && VERSIONED.test(reqPath) && !process.env.DEBUGHOOK ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(body);
}

// The IPA only ships a few avatar sets; default class bodies are downloaded at runtime by the real app.
// Stand-in: render the default look with the bundled "roseswar" fashion set of the same class/sex.
const JOBNUM = { warrior: 1, hunter: 2, wizard: 3 };
const PART = { body: 'fashion_cloth_roseswar', arms: 'fashion_weapon_roseswar', hairup: 'fashion_hat_roseswarup' };
function substitute(p) {
  const m = p.match(/^\/res\/animation\/swf\/avatar\/(warrior|hunter|wizard)_default_(body|arms|hairup)(_mount)?\/(\d)\/[^/]+\.(json|png)$/);
  if (!m) return null;
  const dir = path.join(ROOT, 'res/animation/swf/avatar', PART[m[2]] + (m[3] || ''), `${JOBNUM[m[1]]}_${m[4]}`);
  let files; try { files = fs.readdirSync(dir); } catch (e) { return null; }
  const f = files.find(x => x.endsWith('.' + m[5]));
  return f ? path.join(dir, f) : null;
}

let gate = null;   // (req) -> html to show instead of the game page (web.js: password page)
function setGate(fn) { gate = fn; }

function start(port, log, host) {
  const srv = http.createServer((req, res) => {
    const u = url.parse(req.url, true);
    if (process.env.VERBOSE) log('REQ', req.method, req.url, req.headers.range || '');
    let p = decodeURIComponent(u.pathname);
    if (req.method === 'OPTIONS') return send(res, 204, '');
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const h = Object.keys(routes).find(r => p === r || p.endsWith(r));
      // the password page's body (/auth) is never logged
      if (h) { if (!/imgNetSpeedTest/.test(p)) log('HTTP', req.method, req.url, body.length && !/\/auth$/.test(p) ? body.toString().slice(0, 300) : ''); return routes[h](req, res, body, u.query); }
      if ((p === '/' || p === '/index.html') && gate) { const page = gate(req); if (page) return send(res, 200, page, 'text/html; charset=utf-8'); }
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT)) return send(res, 403, 'no');
      fs.readFile(f, (err, data) => {
        if (err) {
          return require('./cdn').fetchAsset(p, log).then(got => {
            if (got) return fs.readFile(got, (e3, d3) => e3 ? send(res, 404, 'not found') : send(res, 200, d3, MIME[path.extname(got)] || 'application/octet-stream', p));
            notFound();
          });
          function notFound() {
          const sub = substitute(p);
          if (sub) return fs.readFile(sub, (e2, d2) => e2 ? send(res, 404, 'not found') : send(res, 200, d2, MIME[path.extname(sub)] || 'application/octet-stream'));
          if (!missing.has(p)) { missing.add(p); log('404', p); fs.appendFileSync(path.join(__dirname, 'logs/404.txt'), p + '\n'); }
          return send(res, 404, 'not found');
          }
        }
        if (p.startsWith('/js/bundle_release')) {
          let src = data.toString('utf8'), patched = false;
          // Ultra autodirigir: Inimigo → Baú (61/92 EXIST) → Portal (62, EXIST/STATE2) → próximo piso (labirinto) / saída
          // Labirintos (checkMaze/2/3: 8000–8130, 8301–8330) não entram em wF.single; portais CNTowerTransAi nascem em state 16.
          const AUTO_VANILLA = 'walkNextNodeHandler(){var t=b6.Instance.mapModel.getToAttackNode();if(!t){let e=b6.Instance.mapModel;if(e&&wF.single(e.mapId)&&G$.Instance.currentPlayerModel.getAutoWalkFlag()==sH.AUTO_WALK){let e=b6.Instance.mapModel.getCrossMapTransportNode();for(let i=0;i<e.length;i++){let s=e[i];if(s&&ga.isNullOrEmpty(s.nextNodeIds)){t=s;break}}}}if(t||(t=b6.Instance.mapModel.mapNodeEndPoint),t){';
          const AUTO_PREV = 'walkNextNodeHandler(){var t=b6.Instance.mapModel.getToAttackNode();if(!t){let e=b6.Instance.mapModel;if(e&&wF.single(e.mapId)&&G$.Instance.currentPlayerModel.getAutoWalkFlag()==sH.AUTO_WALK){let chest=null,portal=null;for(const k in e._mapNodesData){let n=e._mapNodesData[k];if(!n||!n.info||n.info.state!=1)continue;let ty=n.info.types;if((ty==61||ty==92)&&!chest)chest=n;if(ty==62&&ga.isNullOrEmpty(n.nextNodeIds)&&!portal)portal=n}t=chest||portal}}if(t||(t=b6.Instance.mapModel.mapNodeEndPoint),t){';
          const AUTO_NEW = 'walkNextNodeHandler(){var t=b6.Instance.mapModel.getToAttackNode();if(!t){let e=b6.Instance.mapModel;if(e&&(wF.single(e.mapId)||wF.checkMaze(e.mapId)||wF.checkMaze2(e.mapId)||wF.checkMaze3(e.mapId))&&G$.Instance.currentPlayerModel.getAutoWalkFlag()==sH.AUTO_WALK){let chest=null,portal=null;for(const k in e._mapNodesData){let n=e._mapNodesData[k];if(!n||!n.info)continue;let ty=n.info.types,st=n.info.state;if((ty==61||ty==92)&&st==1&&!chest)chest=n;if(ty==62&&ga.isNullOrEmpty(n.nextNodeIds)&&(st==1||st==16)&&!portal)portal=n}t=chest||portal}}if(t||(t=b6.Instance.mapModel.mapNodeEndPoint),t){';
          if (src.includes(AUTO_NEW)) patched = true;
          else if (src.includes(AUTO_PREV)) { src = src.replace(AUTO_PREV, AUTO_NEW); patched = true; }
          else if (src.includes(AUTO_VANILLA)) { src = src.replace(AUTO_VANILLA, AUTO_NEW); patched = true; }
          // Talent UI: talenChangeHanler crashes on null list slot itemdata after a successful learn,
          // so updateTelentTree never runs and the tree keeps asking for the same level.
          const TALENT_UI_VANILLA = 'for(let i=0;i<3;i++){let s=this.list.getChildAt(i);if(s.itemdata.templateInfo.SonType==e){s.setData(t);break}}';
          const TALENT_UI_NEW = 'for(let i=0;i<3;i++){let s=this.list.getChildAt(i);if(s&&s.itemdata&&s.itemdata.templateInfo&&s.itemdata.templateInfo.SonType==e){s.setData(t);break}}';
          if (src.includes(TALENT_UI_NEW)) patched = true;
          else if (src.includes(TALENT_UI_VANILLA)) { src = src.replace(TALENT_UI_VANILLA, TALENT_UI_NEW); patched = true; }
          if (process.env.DEBUGHOOK) {
            // diagnostics: expose a few internal singletons (same module scope as Hst) as window.__dbg
            src = src.replace('Hst.version="', 'window.__dbg={JF:JF,kF:kF,vj:vj,VH:VH,ih:ih,eh:eh};Hst.version="');
            patched = true;
          }
          data = Buffer.from(src);
          // patched bundle must not be immutable-cached (clients would keep the unpatched copy)
          if (patched) {
            res.writeHead(200, { 'Content-Type': MIME['.js'], 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
            return res.end(data);
          }
        }
        send(res, 200, data, MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', p);
      });
    });
  });
  srv.listen(port, host, () => log('HTTP listening on', host || '*', port));
  return srv;
}

module.exports = { start, route, send, setGate };
