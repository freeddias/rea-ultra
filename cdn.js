// On-demand mirror of assets the IPA didn't ship (the real app downloads them at runtime from its CDN).
// Fetched once into webroot/, so everything seen once keeps working offline. The CDN is the iOS build:
// textures exist only as ASTC .ktx, so a .png/.jpg request is fetched as .ktx and transcoded.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

// official browser build (png/jpg textures); the iOS app build at https://sqh5hw-cdn.wan.com/7road/app only has ASTC .ktx
const BASE = 'https://sqh5bmdim-cdn.funshinegames.com/7road';
const TRANSCODE = false;
const ROOT = require('./paths').WEB;
const KTX2PNG = path.join(__dirname, '../tools/ktx2png.py');
const pending = new Map();
const failed = new Set();
let enabled = process.env.OFFLINE !== '1';

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 20000 }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

function transcode(ktx) {
  return new Promise((resolve, reject) => execFile('python', [KTX2PNG, ktx], err => err ? reject(err) : resolve()));
}

// p: request pathname like /res/... ; resolves to the local file path or null
async function fetchAsset(p, log) {
  if (!enabled || !/^\/(res|libs|js|appupdate)\//.test(p) || failed.has(p)) return null;
  if (pending.has(p)) return pending.get(p);
  const job = (async () => {
    const local = path.join(ROOT, p);
    const ext = path.extname(p).toLowerCase();
    try {
      if (TRANSCODE && (ext === '.png' || ext === '.jpg')) {
        const ktxRel = p.slice(0, -ext.length) + '.ktx';
        const ktx = path.join(ROOT, ktxRel);
        if (!fs.existsSync(ktx)) {
          let data;
          try { data = await get(BASE + ktxRel); }
          catch (e) { data = await get(BASE + p); fs.mkdirSync(path.dirname(local), { recursive: true }); fs.writeFileSync(local, data); log('CDN', p, data.length); return local; }
          fs.mkdirSync(path.dirname(ktx), { recursive: true }); fs.writeFileSync(ktx, data);
        }
        await transcode(ktx);
        const png = ktx.slice(0, -4) + '.png';
        if (ext === '.jpg') fs.copyFileSync(png, local);
        log('CDN', ktxRel, '-> png');
        return local;
      }
      const data = await get(BASE + p);
      fs.mkdirSync(path.dirname(local), { recursive: true }); fs.writeFileSync(local, data);
      log('CDN', p, data.length);
      return local;
    } catch (e) {
      failed.add(p); log('CDN miss', p, e.message); return null;
    } finally { pending.delete(p); }
  })();
  pending.set(p, job);
  return job;
}

module.exports = { fetchAsset, BASE };
