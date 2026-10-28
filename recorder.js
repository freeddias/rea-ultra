// Records the official browser version's traffic without opening DevTools (the site blocks DevTools):
// a visible Chrome window is driven over CDP by Playwright; every WebSocket frame and every non-asset
// HTTP response is appended to capture/<timestamp>.jsonl. Play normally, then just close the window.
// usage: node recorder.js [url]
//        node recorder.js --attach [url]   attach to a Chrome started by kayit.bat (--remote-debugging-port=9222):
//        that window has no automation flags, so Google sign-in works in it
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const ATTACH = process.argv.includes('--attach');
const URL = process.argv.slice(2).find(a => !a.startsWith('--')) || 'https://wartune.funshinegames.com/game/';
const OUT_DIR = path.join(__dirname, '../capture');
fs.mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl');
const out = fs.createWriteStream(file, { flags: 'a' });
const rec = o => out.write(JSON.stringify(Object.assign({ t: Date.now() }, o)) + '\n');
const ASSET = /\.(png|jpe?g|ktx|mp3|wav|ogg|json|fui|atlas|sk|lh|ls|lm|lmat|swf|zip|woff2?|ttf|css|svg|gif|ico|webp|mp4|js)(\?|$)/i;
let frames = 0;

(async () => {
  let browser = null, ctx;
  if (ATTACH) {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222').catch(e => { console.log('Chrome bulunamadı (önce kayit.bat):', e.message); process.exit(1); });
    ctx = browser.contexts()[0];
  } else ctx = await chromium.launchPersistentContext(path.join(__dirname, 'logs/chrome-rec'), {
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: false, viewport: null, args: ['--start-maximized'],
  });
  const hook = page => {
    page.on('websocket', ws => {
      rec({ ev: 'ws-open', url: ws.url() });
      console.log('WebSocket opened:', ws.url());
      const frame = dir => f => {
        const p = f.payload;
        rec({ ev: 'ws', dir, url: ws.url(), bin: typeof p !== 'string', data: typeof p === 'string' ? p : Buffer.from(p).toString('base64') });
        if (++frames % 200 === 0) console.log(`${frames} frames recorded`);
      };
      ws.on('framesent', frame('out'));
      ws.on('framereceived', frame('in'));
      ws.on('close', () => rec({ ev: 'ws-close', url: ws.url() }));
    });
    page.on('response', async r => {
      const u = r.url();
      if (ASSET.test(u) || u.startsWith('data:')) return;
      let body = null;
      try { const b = await r.body(); if (b.length < 2e6) body = b.toString('base64'); } catch (e) { }
      rec({ ev: 'http', method: r.request().method(), url: u, status: r.status(), post: r.request().postData() || null, body });
    });
  };
  ctx.pages().forEach(hook);
  ctx.on('page', hook);
  // attached: a game tab that is already open keeps its connection, so the login would be missing from the
  // capture (cipher keys) - always load the game fresh
  const page = ATTACH ? await ctx.newPage() : (ctx.pages()[0] || await ctx.newPage());
  if (ATTACH) for (const p of ctx.pages()) if (p !== page && /wartune/i.test(p.url())) await p.close().catch(() => { });
  await page.goto(URL).catch(e => console.log('goto:', e.message));
  console.log('Recording to', file, '- play in the Chrome window, close it when done.');
  await new Promise(res => (browser || ctx).on(browser ? 'disconnected' : 'close', res));
  out.end();
  console.log(`Done: ${frames} WebSocket frames saved to ${file}`);
})();
