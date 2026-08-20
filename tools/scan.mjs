// Scroll-scrub verification. Drives the real page in headless Chrome, waits for
// the camera smoothing to settle at each stop, and records camera position, the
// active beat, and fps alongside a screenshot.
//
//   node scan.mjs <url> <outDir> [stops]
//
// The point is to prove three things at once: the camera genuinely moves through
// world space, the scene is still rendering at every stop, and frames keep
// advancing while nothing is scrolling.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

// Other sessions run their own headless Chromes; a fixed debug port collides
// with them and the launch silently fails. Ask the OS for a free one instead.
const freePort = await new Promise((resolve) => {
  const srv = createServer();
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});

const URL_ = process.argv[2];
const OUT = process.argv[3];
const STOPS = Number(process.argv[4] ?? 6);
const PORT = freePort;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'scan-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1440,900', '--no-first-run', '--no-default-browser-check',
  '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function endpoint() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return (await r.json()).webSocketDebuggerUrl;
    } catch { await sleep(250); }
  }
  throw new Error('no CDP endpoint');
}

const ws = new WebSocket(await endpoint());
await new Promise((r) => (ws.onopen = r));
let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const call = (m, p) => send(m, p, sessionId);

await call('Page.enable');
await call('Runtime.enable');

// Emulation overrides the viewport independently of the OS window, which is the
// only way to get a true phone width here: macOS headless Chrome silently floors
// its window at about 500px, so --window-size alone lays out too wide.
if (process.env.MOBILE === '1') {
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  });
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await call('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
      + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
}

const evaluate = async (expression, awaitPromise = false) => {
  const { result, exceptionDetails } = await call('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'eval threw');
  return result.value;
};

console.log(`navigating to ${URL_}`);
await call('Page.navigate', { url: URL_ });

// Wait for the scene to expose its probe hook — that only happens after the
// star system has loaded and the camera driver is wired up.
let ready = false;
for (let i = 0; i < 400; i++) {
  await sleep(500);
  try {
    if (await evaluate(`typeof window.__bg === 'object' && window.__bg !== null`)) { ready = true; break; }
  } catch { /* still navigating */ }
}
if (!ready) {
  console.log(JSON.stringify({ error: 'scene never became ready' }));
  ws.close(); chrome.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
console.log('scene ready');

const rows = [];
for (let s = 0; s < STOPS; s++) {
  const p = STOPS === 1 ? 0 : s / (STOPS - 1);
  await evaluate(`window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) * ${p})`);

  // The camera chases the scroll target with a 0.35s half-life, so give it well
  // past settling time before believing the frame.
  await sleep(3500);

  const info = await evaluate(`JSON.stringify({
    progress: window.__bg.progress(),
    beat: window.__bg.beat(),
    pos: window.__bg.cameraPosition(),
    fps: window.__bg.fps(),
    throttle: window.__bg.throttle(),
    white: window.__bg.whiteout(),
    scrollY: window.scrollY,
    corridor: JSON.parse(window.__bg.corridor()),
    actual: JSON.parse(window.__bg.objects()).map(b => ({ id: b.id, pos: b.pos })),
    near: JSON.parse(window.__bg.objects())
      .map(b => ({ id: b.id, d: b.distance, r: b.radius, deg: 2 * Math.atan(b.radius / b.distance) * 180 / Math.PI }))
      .sort((a, b) => a.d - b.d).slice(0, 3),
  })`);
  const parsed = JSON.parse(info);

  const shot = await call('Page.captureScreenshot', { format: 'png' });
  const file = join(OUT, `stop-${s}-${Math.round(p * 100)}.png`);
  writeFileSync(file, Buffer.from(shot.data, 'base64'));

  rows.push({ ...parsed, file });
  const near = (parsed.near ?? []).map((b) => `${b.id} ${b.d.toExponential(2)}m ${b.deg.toFixed(1)}deg`).join(' | ');
  console.log(`stop ${s} (${Math.round(p*100)}%)  ${parsed.beat}  throttle=${parsed.throttle.toFixed(2)} white=${parsed.white.toFixed(2)}\n     nearest: ${near}`);
}

// Does the universe keep moving when nothing is scrolling? Sample the camera
// twice without touching the scrollbar; the orbital simulation should still be
// advancing the bodies, so a framing that tracks them must drift.
const a = await evaluate(`JSON.stringify(window.__bg.cameraPosition())`);
await sleep(2500);
const b = await evaluate(`JSON.stringify(window.__bg.cameraPosition())`);
const ambient = JSON.parse(a).map((v, i) => Math.abs(v - JSON.parse(b)[i])).reduce((x, y) => x + y, 0);

const dist = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);
const travel = rows.slice(1).map((r, i) => dist(r.pos, rows[i].pos));

writeFileSync(join(OUT, 'scan.json'), JSON.stringify({ rows, travel, ambientDriftMetres: ambient }, null, 2));
console.log('\ntravel between stops (m): ' + travel.map((d) => d.toExponential(2)).join('  '));
console.log('ambient camera drift while idle (m): ' + ambient.toExponential(2));

ws.close(); chrome.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {}
