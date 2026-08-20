// Loads the page in headless Chrome, waits for the scene, then runs an
// expression from argv and prints the JSON result.
//
//   node eval.mjs <url> '<expression returning a JSON string>'

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
const EXPR = process.argv[3];
const PORT = freePort;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const profile = mkdtempSync(join(tmpdir(), 'ev-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1440,900', '--no-first-run', '--no-default-browser-check',
  '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--mute-audio',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function endpoint() {
  for (let i = 0; i < 80; i++) {
    try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await sleep(250); }
  }
  throw new Error('no CDP');
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
  new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, sessionId })); });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const call = (m, p) => send(m, p, sessionId);
await call('Page.enable'); await call('Runtime.enable');

// awaitPromise only works on expressions that actually return a promise, so try
// it and fall back — otherwise every plain expression errors and the caller
// silently spins until its timeout.
const evaluate = async (expression) => {
  for (const awaitPromise of [true, false]) {
    try {
      const { result, exceptionDetails } = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
      if (exceptionDetails) throw new Error(exceptionDetails.text ?? JSON.stringify(exceptionDetails));
      return result.value;
    } catch (err) {
      if (!awaitPromise) throw err;
    }
  }
};

await call('Page.navigate', { url: URL_ });
for (let i = 0; i < 400; i++) {
  await sleep(500);
  try { if (await evaluate(`typeof window.__bg === 'object' && window.__bg !== null`)) break; } catch {}
}
await sleep(1500);
try {
  console.log(await evaluate(EXPR));
} catch (err) {
  console.log('EVAL FAILED:', err.message);
}

ws.close(); chrome.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {}
