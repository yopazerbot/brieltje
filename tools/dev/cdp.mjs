// A small headless Chromium driver over the DevTools protocol, for checks on this PC (no Playwright library:
// only the Chromium that Playwright installed under %LOCALAPPDATA%\ms-playwright). Node 22+ (built-in WebSocket).
//
//   import { launch, startGame } from './cdp.mjs';
//   const b = await launch({ port: 9340 });
//   await startGame(b, 'http://localhost:5200/');           // through the start screen, until window.briel
//   console.log(await b.evaluate('briel.bench(60)'));
//   await b.screenshot('view.png');
//   b.close();                                              // stops Chromium and deletes its profile
//
// Each agent picks its own debugging port (--port), as for the dev server (AGENTS.md, "One PC, shared").
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The newest Playwright Chromium on this PC. */
export function chromePath() {
  const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  const dirs = existsSync(root) ? readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) : [];
  for (const d of dirs) {
    const exe = join(root, d, 'chrome-win64', 'chrome.exe');
    if (existsSync(exe)) return exe;
  }
  throw new Error(`no Playwright Chromium under ${root}`);
}

/**
 * Start a headless Chromium and connect to its first page.
 * `swiftshader`: software rendering (Apple-like half-float overflow, see AGENTS.md); otherwise the real graphics chip.
 * `downloads`: a folder where the page's downloads land.
 */
export async function launch({ port = 9340, width = 1600, height = 900, swiftshader = false, extra = [], downloads } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'briel-cdp-'));
  const gpu = swiftshader ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
  const args = [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...gpu,
    '--no-first-run', '--no-default-browser-check', `--window-size=${width},${height}`, ...extra, 'about:blank',
  ];
  const proc = spawn(chromePath(), args, { stdio: 'ignore' });
  let ws;
  for (let i = 0; i < 80 && !ws; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch {
      // not up yet
    }
    if (!ws) await new Promise((r) => setTimeout(r, 250));
  }
  if (!ws) {
    proc.kill();
    throw new Error(`Chromium did not answer on port ${port}`);
  }
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const waiting = new Map();
  const listeners = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) for (const l of listeners) l(msg);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send('Page.enable');
  await send('Runtime.enable');
  if (downloads) await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  /** Console lines and uncaught errors, newest last. */
  const logs = [];
  listeners.push((m) => {
    if (m.method === 'Runtime.consoleAPICalled') logs.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    if (m.method === 'Runtime.exceptionThrown') logs.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Run an expression in the page; promises are awaited; the value comes back as JSON. */
  const evaluate = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, timeout: 600000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  /** Wait until an expression is truthy in the page. */
  const waitFor = async (expression, ms = 120000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await evaluate(expression, false).catch(() => false)) return;
      await sleep(500);
    }
    throw new Error(`timed out waiting for ${expression}`);
  };
  const screenshot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
  };
  const close = () => {
    try {
      ws.close();
    } catch {
      // gone already
    }
    proc.kill();
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 1500).unref?.();
  };
  return { send, evaluate, waitFor, sleep, screenshot, close, logs, listeners, pid: proc.pid };
}

/**
 * Open the game and click through the start screen (a name, then keyboard and mouse, or touch with
 * `phone`), then wait for `window.briel` (dev server only). `village`: also wait until the village is in.
 */
export async function startGame(b, url, { phone = false, village = false } = {}) {
  if (phone) {
    await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await b.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  }
  await b.send('Page.navigate', { url });
  const button = phone ? '#choose-touch' : '#choose-kbm';
  await b.waitFor(`!!document.querySelector('${button}')`);
  await b.sleep(6000); // the dev build attaches the start screen's handlers late
  await b.evaluate("(() => { const n = document.querySelector('#nick'); if (n && !n.value) { n.value = 'Check'; n.dispatchEvent(new Event('input', { bubbles: true })); } })()", false);
  await b.evaluate(`document.querySelector('${button}').click()`, false);
  await b.waitFor('!!window.briel', 180000);
  // Play has begun once the start panel is gone (loading and the graphics test happen behind it).
  await b.waitFor("(() => { const p = document.getElementById('start-panel'); if (!p || p.offsetParent === null) return true; const s = getComputedStyle(p); return s.visibility === 'hidden' || Number(s.opacity) < 0.05; })()", 240000);
  if (village) await b.waitFor("briel.village() === 'ready'", 240000);
}

/** Read `--name value` and `--flag` options from process.argv. */
export function options(defaults) {
  const out = { ...defaults, _: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) out._.push(a);
    else if (typeof defaults[a.slice(2)] === 'boolean') out[a.slice(2)] = true;
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}
