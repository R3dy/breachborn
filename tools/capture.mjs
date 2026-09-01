// Spawns headless Chrome itself, drives it via CDP, screenshots, kills it. Self-contained (no background detach needed).
// Usage: node tools/capture.mjs <url> <out.png> [waitFrames] [action-js]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const url = process.argv[2] || 'http://localhost:5174';
const out = process.argv[3] || '/tmp/opencode/brn-proto.png';
const waitFrames = parseInt(process.argv[4] || '60', 10);
const action = process.argv[5] || ''; // optional JS executed via Runtime.evaluate before capture
const PORT = 9224;

const chrome = spawn('google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/opencode/brn-chrome-${Date.now()}`,
  '--no-first-run', '--no-default-browser-check', '--disable-crash-reporter', '--disable-breakpad',
  '--window-size=1600,900', 'about:blank',
], { stdio: 'ignore' });
const kill = () => { try { chrome.kill('SIGKILL'); } catch {} };

// wait for devtools
let page = null;
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    page = list.find(t => t.type === 'page');
    if (page) break;
  } catch {}
  await new Promise(r => setTimeout(r, 250));
}
if (!page) { console.error('NO PAGE TARGET'); kill(); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
});
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
await new Promise(res => ws.onopen = res);
await send('Page.enable');
await send('Page.navigate', { url });

let frames = 0;
for (let i = 0; i < 100; i++) {
  try { const r = await send('Runtime.evaluate', { expression: 'window.__frames || 0', returnByValue: true }); frames = r.result?.value || 0; if (frames >= waitFrames) break; } catch {}
  await new Promise(r => setTimeout(r, 400));
}
console.log('frames rendered:', frames);
if (action) {
  await send('Runtime.evaluate', { expression: action });
  await new Promise(r => setTimeout(r, 800));
}
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('saved', out);
kill(); process.exit(0);
