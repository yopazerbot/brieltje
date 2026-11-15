// Logging out from the game's menu (src/ui/menuLogout.ts, src/start.ts), headless (tools/dev/cdp.mjs): the button in the
// Together tab under who you play as, two presses, and the start screen at step 1 after. One Chromium with two pages in browser
// contexts of their own (two players, each with its own cookies).
//
//   ADMIN_PASSWORD=... node tools/dev/menuLogoutCheck.mjs --url http://localhost:5744/ --api http://localhost:8744
//          [--only account,guest,room,offline,home,home-together,ended,pad,touch] [--shots <folder>] [--port 9844]
//
// --url is a dev server (window.briel) whose /api goes to --api (API_PORT=<its port> npx vite --port <n>): a throwaway
// game server on this computer only, as the check makes accounts and logs in as the admin (the home case). The accounts
// and guests it makes are logged out or deleted at the end.
//
// The cases:
// - account: an account together drives a car, logs out from the menu; one press alone does nothing after four seconds;
//   two presses: the start screen at step 1, the server refuses the old cookie, the other player saw the leave and the
//   car stop, the gun pick and the settings kept, a reload stays logged out, logging in again works.
// - guest: a guest together logs out; the name can be joined with again at once.
// - room: in a Zombies room game the owner logs out; the game goes on for the other player.
// - offline: the logout can't reach the server: the page still goes to the start screen, the pending flag stays, the
//   server still knows the session; the next visit with the server in reach ends it.
// - home: an account that opened the main house alone logs out; played alone after, the house is sealed again. The
//   browser's storage (localStorage, sessionStorage, IndexedDB, the Cache API) holds nothing of the inside while it is
//   open, nor after; an old stored inside from before the fix is removed at load (src/world/furnitureStore.ts).
// - home-together: the same with the house opened together, an old value planted as an older tab would write it.
// - ended: the house open, the session is ended from elsewhere (logged out on every device): the storage is cleaned.
// - pad: a fake controller opens the menu, R1 to Together, the D-pad down to the button, ✕ twice.
// - touch: touch emulation at 844x390 and 667x375 on Low, the Together tab and the asking state in English and Dutch.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homeAt } from '../../web/shared/homes.mjs';
import { launch, localOnly, options } from './cdp.mjs';

const o = options({ url: 'http://localhost:5744/', api: 'http://localhost:8744', port: '9844', only: '', shots: '' });
localOnly(o.api);
localOnly(o.url, '--url');
const ADMIN = process.env.ADMIN_PASSWORD ?? '';
if (o.shots) mkdirSync(o.shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const only = o.only ? o.only.split(',') : null;
const results = [];
const ok = (name, pass, extra = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
};

// ---- The server, from here (accounts made and deleted, the old cookie asked about).
const call = async (method, path, body, cookie = '') => {
  const r = await fetch(o.api + path, { method, headers: { 'Content-Type': 'application/json', Origin: o.api, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  return { r, data: await r.json().catch(() => null) };
};
const cookieOf = (r) => r.headers.getSetCookie().map((x) => x.split(';')[0]).join('; ');
const tag = Math.random().toString(36).slice(2, 6);
const accounts = [];
const guestCookies = [];
async function account(prefix) {
  const username = `${prefix}${tag}${accounts.length}`;
  const password = `pw-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const { r, data } = await call('POST', '/api/account/register', { username, email: `${username}@example.invalid`, password, age: true });
  if (!r.ok) throw new Error(`register ${username}: ${r.status} ${JSON.stringify(data)}`);
  await call('POST', '/api/logout', {}, cookieOf(r)); // the register's own session: not needed
  accounts.push({ username, password });
  return { username, password };
}
/** The status /api/me answers with this cookie header (200: the server knows the session). */
const meWith = async (cookie) => (await call('GET', '/api/me', undefined, cookie)).r.status;

// ---- A second page in a browser context of its own (its own cookies), in the same Chromium.
async function connect(wsUrl, page = true) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  let id = 0;
  const waiting = new Map();
  const listeners = [];
  const logs = [];
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
  const evaluate = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, timeout: 600000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, ms = 120000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await evaluate(expression, false).catch(() => false)) return;
      await sleep(500);
    }
    throw new Error(`timed out waiting for ${expression}`);
  };
  const screenshot = async (file) => {
    const { writeFileSync } = await import('node:fs');
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
  };
  listeners.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') logs.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
  });
  if (page) {
    await send('Page.enable');
    await send('Runtime.enable');
  }
  return { send, evaluate, waitFor, screenshot, listeners, logs, close: () => ws.close() };
}
async function secondPage(chrome) {
  const version = await (await fetch(`http://127.0.0.1:${o.port}/json/version`)).json();
  const browser = await connect(version.webSocketDebuggerUrl, false);
  const { browserContextId } = await browser.send('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const page = await connect(`ws://127.0.0.1:${o.port}/devtools/page/${targetId}`);
  page.closeAll = async () => {
    await browser.send('Target.closeTarget', { targetId }).catch(() => {});
    await browser.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    page.close();
    browser.close();
  };
  return page;
}

// ---- Driving a page.
const js = (p, code) => p.evaluate(`(() => { ${code} })()`, false);
const click = (p, sel) => js(p, `const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no ' + ${JSON.stringify(sel)}); e.click();`);
const setValue = (p, id, value) => js(p, `const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));`);
const step = (p) => p.evaluate("Number(document.getElementById('start-panel').dataset.step)", false);
const waitStep = (p, n, ms = 20000) => p.waitFor(`Number(document.getElementById('start-panel').dataset.step) === ${n}`, ms);
const cookies = async (p) => (await p.send('Network.getCookies', { urls: [o.url] })).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
const startShows = "(() => { const o = document.getElementById('overlay'); const p = document.getElementById('start-panel'); return !!o && !o.classList.contains('hidden') && !!p && p.offsetParent !== null && getComputedStyle(p).visibility !== 'hidden' && Number(getComputedStyle(p).opacity) > 0.5; })()";
const playing = "(() => { const p = document.getElementById('start-panel'); if (!p || p.offsetParent === null) return true; const s = getComputedStyle(p); return s.visibility === 'hidden' || Number(s.opacity) < 0.05; })()";
const FAKE_PAD = `(() => {
  const b = () => ({ pressed: false, touched: false, value: 0 });
  const pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard', timestamp: 1, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, b), vibrationActuator: null };
  window.__pad = pad;
  window.__padOn = false;
  navigator.getGamepads = () => [window.__padOn ? pad : null, null, null, null];
})();`;
async function padPress(p, i) {
  await p.evaluate(`(() => { window.__padOn = true; const k = window.__pad.buttons[${i}]; k.pressed = true; k.value = 1; window.__pad.timestamp++; })()`, false);
  await sleep(140);
  await p.evaluate(`(() => { const k = window.__pad.buttons[${i}]; k.pressed = false; k.value = 0; window.__pad.timestamp++; })()`, false);
  await sleep(200);
}
async function key(p, code, keyName, vk, holdMs = 60) {
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: keyName, windowsVirtualKeyCode: vk });
  await sleep(holdMs);
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyName, windowsVirtualKeyCode: vk });
}
async function tap(p, sel) {
  const r = await js(p, `const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no ' + ${JSON.stringify(sel)}); e.scrollIntoView({ block: 'nearest' }); const q = e.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 };`);
  await sleep(200);
  await p.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
  await p.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(250);
}

async function open(p, { phone = null, pad = false, low = false } = {}) {
  await p.send('Network.enable');
  if (phone) {
    await p.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await p.send('Emulation.setDeviceMetricsOverride', { width: phone[0], height: phone[1], deviceScaleFactor: 1, mobile: true });
  }
  if (pad) await p.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_PAD });
  await p.send('Page.navigate', { url: o.url });
  await p.waitFor("!!document.querySelector('#choose-kbm') && !document.getElementById('overlay').classList.contains('hidden')");
  if (low) {
    await p.evaluate("localStorage.setItem('briel.graphics', 'low')", false);
    await reload(p);
  }
  await sleep(4000); // the dev build attaches the start screen's handlers late; /api/me answers
}
async function reload(p) {
  await p.send('Page.reload', { ignoreCache: false });
  await sleep(1000);
  await p.waitFor("!!document.querySelector('#choose-kbm') && !document.getElementById('overlay').classList.contains('hidden')");
  await sleep(3000);
}
/** Logged in on the server before the start screen asks: the welcome card, then on. */
async function loginFirst(p, acct) {
  const status = await p.evaluate(`fetch('/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify({ username: acct.username, password: acct.password }))} }).then((r) => r.status)`);
  if (status !== 200) throw new Error(`login: ${status}`);
  await reload(p);
  await p.waitFor("!document.getElementById('welcome-card').classList.contains('hidden')", 10000);
  await click(p, '#welcome-go');
  await waitStep(p, 2);
}
async function guestFirst(p, nick) {
  await setValue(p, 'nick', nick);
  await click(p, '#guest-go');
  await waitStep(p, 2);
  await js(p, "const a = document.getElementById('mp-age'); a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true }));");
}
/** Step 2 and 3, then a start button: `mp` solo or multi; `game` explore, or { room: 'open' | id, place }. */
async function play(p, mp, game = 'explore', control = 'kbm') {
  await click(p, `#mp-choice [data-mp=${mp}]`);
  await waitStep(p, 3);
  if (game === 'explore') await click(p, '#mode-start [data-play=explore]');
  else {
    await click(p, '#mode-start [data-start-mode=zombies]');
    if (game.room === 'open') {
      await setValue(p, 'z-open-place', game.place);
      await click(p, '#z-open [data-room=new]');
    } else {
      const sel = `#z-room-list button[data-room="${game.room}"]:not([disabled])`;
      await p.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, 15000);
      await click(p, sel);
    }
  }
  if (control === 'touch') await tap(p, '#choose-touch');
  else await click(p, `#choose-${control}`);
  await p.waitFor('!!window.briel', 180000);
  await p.waitFor(playing, 240000);
  if (mp === 'multi') await p.waitFor('briel.net().rtt !== null && briel.net().rtt !== undefined', 30000);
  await sleep(1500);
}
async function menuTogether(p) {
  await key(p, 'Escape', 'Escape', 27);
  await p.waitFor("!document.getElementById('pause-panel').classList.contains('hidden')", 5000);
  await click(p, '#tab-together');
  await sleep(300);
}
const button = (p) => p.evaluate("(() => { const b = document.getElementById('menu-logout'); const r = b.getBoundingClientRect(); return { text: b.textContent, shown: !b.classList.contains('hidden') && r.width > 0, sure: b.classList.contains('sure') }; })()", false);
/** After the second press: the page loads again and shows the start screen at step 1, without the world. */
async function backAtStart(p, ms = 15000) {
  await p.waitFor(`!window.briel && ${startShows} && Number(document.getElementById('start-panel').dataset.step) === 1`, ms);
  await sleep(3000); // /api/me answers, the pending flag is dealt with
}
const startState = (p) =>
  p.evaluate(
    "({ step: Number(document.getElementById('start-panel').dataset.step), welcome: !document.getElementById('welcome-card').classList.contains('hidden'), who: !document.getElementById('who-cards').classList.contains('hidden'), pending: localStorage.getItem('briel.logoutPending'), world: !!window.briel, me: null })",
    false,
  );
const meInPage = (p) => p.evaluate("fetch('/api/me').then((r) => r.status)");
const kept = (p) => p.evaluate("({ loadout: localStorage.getItem('briel.loadout'), settings: localStorage.getItem('briel.settings'), graphics: localStorage.getItem('briel.graphics'), lang: localStorage.getItem('briel.lang') })", false);
const shot = async (p, name) => o.shots && p.screenshot(join(o.shots, `${name}.png`));
/** The frames this page's game connection receives (Network.webSocketFrameReceived), parsed. */
function frames(p) {
  const got = [];
  p.listeners.push((m) => {
    if (m.method !== 'Network.webSocketFrameReceived') return;
    try {
      got.push({ at: Date.now(), m: JSON.parse(m.params.response.payloadData) });
    } catch {
      // not JSON
    }
  });
  return got;
}

// ---- The cases.
async function caseAccount(a, b) {
  const acct = await account('lo');
  const guest = `Seen${tag}`;
  await open(a);
  await open(b);
  const seenFrames = frames(b);
  // This browser's own choices, which a logout keeps: a gun pick, the graphics, the language, a setting.
  await a.evaluate("localStorage.setItem('briel.loadout', JSON.stringify(['shotgun'])); localStorage.setItem('briel.graphics', 'medium'); localStorage.setItem('briel.lang', 'en'); localStorage.setItem('briel.settings', JSON.stringify({ volume: 0.6 }))", false);
  await loginFirst(a, acct);
  await play(a, 'multi');
  await guestFirst(b, guest);
  await play(b, 'multi');
  await b.waitFor(`document.getElementById('tog-players').textContent.toLowerCase().includes(${JSON.stringify(acct.username)})`, 15000);
  // A walks to the nearest car (at a pace the server takes: it holds everyone to the real one) and drives it a little.
  const target = await a.evaluate("(() => { const p = briel.player; const c = briel.cars.reduce((m, q) => (Math.hypot(q.x - p.x, q.z - p.z) < Math.hypot(m.x - p.x, m.z - p.z) ? q : m)); return { id: c.id, x: c.x + 2.8, z: c.z, y: c.y, d: Math.hypot(c.x - p.x, c.z - p.z) }; })()", false);
  for (let i = 0; i < 200; i++) {
    const left = await a.evaluate(`(() => { const p = briel.player; const dx = ${target.x} - p.x, dz = ${target.z} - p.z, d = Math.hypot(dx, dz); const s = Math.min(1, 1.2 / Math.max(d, 0.001)); const x = p.x + dx * s, z = p.z + dz * s; briel.teleport(x, z, briel.world.groundAt(x, z, p.feet + 1.5, 0).y); return d; })()`, false);
    if (left < 0.3) break;
    await sleep(350);
  }
  await sleep(1500);
  const placed = await a.evaluate('briel.currentCar().id', false);
  console.log(`     the car ${placed}, ${Math.round(target.d)} m from the start`);
  await a.evaluate('briel.getIn()', false);
  await a.waitFor('briel.driving()', 10000).catch(() => {});
  const drove = await a.evaluate('briel.driving()', false);
  ok('account: got in a car', drove, placed);
  if (drove) await key(a, 'KeyW', 'w', 87, 1500);
  const before = await kept(a);
  const oldCookie = await cookies(a);
  ok('account: the server knows the session before', (await meWith(oldCookie)) === 200);
  await menuTogether(a);
  let s = await button(a);
  ok('account: the button shows in the Together tab', s.shown && s.text === 'Log out', s.text);
  await shot(a, 'account-together');
  // One press alone: asks, and after four seconds is back, nothing happened.
  await click(a, '#menu-logout');
  s = await button(a);
  ok('account: one press asks', s.text === 'Log out? Press again' && s.sure, s.text);
  await shot(a, 'account-asking');
  await sleep(4400);
  s = await button(a);
  ok('account: back to "Log out" after four seconds', s.text === 'Log out' && !s.sure, s.text);
  ok('account: one press did not log out', (await meWith(oldCookie)) === 200 && (await a.evaluate(playing, false)) && !!(await a.evaluate('!!window.briel', false)));
  // A double click is one press.
  await js(a, "const e = document.getElementById('menu-logout'); e.click(); e.click();");
  await sleep(300);
  s = await button(a);
  ok('account: a double click only asks', s.text === 'Log out? Press again' && !!(await a.evaluate('!!window.briel', false)), s.text);
  // The second press, a moment later.
  const leaveAt = Date.now();
  await sleep(600);
  await click(a, '#menu-logout');
  await backAtStart(a);
  const st = await startState(a);
  ok('account: the start screen at step 1, no world', st.step === 1 && !st.world && st.who && !st.welcome, JSON.stringify(st));
  ok('account: no pending flag', st.pending === null);
  ok('account: the server refuses the old cookie', (await meWith(oldCookie)) === 401);
  ok('account: the page has no session', (await meInPage(a)) === 401);
  const after = await kept(a);
  ok('account: the gun pick and the settings kept', !!after.loadout && !!after.settings && JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after).slice(0, 160));
  const keys = await a.evaluate("Object.keys(localStorage).sort().join(', ')", false);
  console.log(`     kept in localStorage: ${keys}`);
  // The other player saw us go, and the car stop.
  await sleep(2000);
  const left = seenFrames.find((f) => f.m.t === 'leave' && f.m.name === acct.username && f.at >= leaveAt);
  ok('account: the other player saw the leave', !!left, left ? `${left.at - leaveAt} ms after the press` : '');
  const carMsgs = seenFrames.filter((f) => f.m.t === 'car' && f.m.car?.id === placed);
  const drivenSeen = carMsgs.some((f) => f.m.car.driver === acct.username);
  const lastCar = carMsgs.at(-1)?.m.car;
  ok('account: the other player saw the car driven, then stopped and free', drivenSeen && lastCar && lastCar.driver === null && lastCar.s === 0, lastCar ? `driver ${lastCar.driver}, speed ${lastCar.s}` : 'no car message');
  ok('account: gone from the other player\'s list', !(await b.evaluate(`document.getElementById('tog-players').textContent.toLowerCase().includes(${JSON.stringify(acct.username)})`, false)));
  await shot(a, 'account-start-after');
  // A reload stays logged out.
  await reload(a);
  const again = await startState(a);
  ok('account: a reload stays logged out', again.step === 1 && !again.welcome && (await meInPage(a)) === 401, JSON.stringify(again));
  // Logging in again works.
  await setValue(a, 'login-name', acct.username);
  await setValue(a, 'login-pass', acct.password);
  await js(a, "document.getElementById('login-card').requestSubmit()");
  await waitStep(a, 2).catch(() => {});
  ok('account: logging in again works', (await step(a)) === 2 && (await meInPage(a)) === 200);
  await a.evaluate("fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })");
  return { b, guest };
}

async function caseGuest(b, guest) {
  // b plays together as the guest from the account case (or a new one).
  const oldCookie = await cookies(b);
  ok('guest: the server knows the session before', (await meWith(oldCookie)) === 200);
  await menuTogether(b);
  const s = await button(b);
  ok('guest: the button shows for a guest', s.shown && s.text === 'Log out', s.text);
  await click(b, '#menu-logout');
  await sleep(600);
  await click(b, '#menu-logout');
  await backAtStart(b);
  const st = await startState(b);
  ok('guest: the start screen at step 1', st.step === 1 && !st.world && !st.welcome, JSON.stringify(st));
  ok('guest: the server refuses the old cookie', (await meWith(oldCookie)) === 401);
  const nick = await b.evaluate("document.getElementById('nick').value", false);
  console.log(`     the start screen's name field after: ${nick ? 'the name typed before' : 'empty'}`);
  const rejoin = await call('POST', '/api/join', { name: guest, age: true });
  ok('guest: the name can be joined with again at once', rejoin.r.status === 200, `${rejoin.r.status} ${rejoin.data?.code ?? ''}`);
  if (rejoin.r.ok) guestCookies.push(cookieOf(rejoin.r));
}

async function caseRoom(a, b) {
  const owner = await account('lr');
  await open(a);
  await open(b);
  await loginFirst(a, owner);
  await play(a, 'multi', { room: 'open', place: 'house' });
  const roomId = await a.evaluate("fetch('/api/rooms').then((r) => r.json()).then((d) => d.rooms.find((r) => r.mine)?.id)");
  await guestFirst(b, `Room${tag}`);
  await play(b, 'multi', { room: roomId, place: 'house' });
  await a.evaluate("document.getElementById('room-start').click()", false);
  await a.waitFor("briel.games.view.kind === 'zombies'", 15000);
  await b.waitFor("briel.games.view.kind === 'zombies'", 15000);
  await sleep(3000);
  const waveBefore = await b.evaluate('briel.games.view.zombies?.wave ?? null', false);
  await menuTogether(a);
  await click(a, '#menu-logout');
  await sleep(600);
  await click(a, '#menu-logout');
  await backAtStart(a);
  await sleep(6000);
  const view = await b.evaluate("({ kind: briel.games.view.kind, wave: briel.games.view.zombies?.wave ?? null, rtt: briel.net().rtt, players: document.getElementById('tog-players').textContent })", false);
  ok('room: the game goes on for the other player', view.kind === 'zombies' && view.rtt !== null, `${view.kind}, wave ${waveBefore} then ${view.wave}`);
  ok('room: the owner is gone from the other player\'s list', !view.players.toLowerCase().includes(owner.username));
  await shot(b, 'room-other-player');
  const rooms = await call('GET', '/api/rooms', undefined, await cookies(b));
  ok('room: the room is still open', !!rooms.data?.rooms?.some((r) => r.id === roomId), roomId);
  guestCookies.push(await cookies(b));
}

async function caseOffline(a) {
  const acct = await account('lf');
  await open(a);
  await loginFirst(a, acct);
  await play(a, 'solo');
  const oldCookie = await cookies(a);
  // The logout can't reach the server.
  await a.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/logout*' }] });
  let blocked = 0;
  a.listeners.push((m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    blocked++;
    void a.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'ConnectionRefused' });
  });
  await menuTogether(a);
  ok('offline: the button shows playing alone with an account', (await button(a)).shown);
  const t0 = Date.now();
  await click(a, '#menu-logout');
  await sleep(600);
  await click(a, '#menu-logout');
  await backAtStart(a);
  const st = await startState(a);
  ok('offline: the start screen at step 1 all the same', st.step === 1 && !st.world && !st.welcome, `${JSON.stringify(st)}, ${Date.now() - t0} ms`);
  ok('offline: the pending flag stays', st.pending === '1');
  ok('offline: the logout was tried again on the new page', blocked >= 2, `${blocked} tries`);
  ok('offline: the server still knows the session (it never heard)', (await meWith(oldCookie)) === 200);
  // The next visit, with the server in reach: the flag finishes it before anything else.
  await a.send('Fetch.disable');
  await reload(a);
  const next = await startState(a);
  ok('offline: the next visit ends it on the server', (await meWith(oldCookie)) === 401 && next.pending === null && !next.welcome, JSON.stringify(next));
}

// ---- What the browser stores, and whether it holds anything of a home's inside.
/** Everything the page could keep: localStorage (keys and values), sessionStorage, IndexedDB and the Cache API. */
const storage = (p) =>
  p.evaluate(
    "(async () => ({ local: Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])), session: sessionStorage.length, idb: indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : [], caches: typeof caches === 'undefined' ? [] : await caches.keys() }))()",
  );
/** A piece in the shape the furniture is stored in, read from any stored value that is a list. */
const piecesIn = (value) => {
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) ? v.filter((p) => p && typeof p === 'object' && Number.isFinite(p.x) && Number.isFinite(p.z)) : [];
  } catch {
    return [];
  }
};
/**
 * The storage holds nothing of a home's inside: no piece inside a home, none of `layout` (the starting pieces the inside
 * brought, kept here in memory only and never printed), no old furniture keys, and nothing in the other stores.
 */
function storageClean(name, st, layout) {
  const keys = Object.keys(st.local);
  const pieces = keys.flatMap((k) => piecesIn(st.local[k]));
  const inside = pieces.filter((p) => homeAt(p.x, p.z, p.y ?? 0) !== null).length;
  const fromLayout = pieces.filter((p) => layout.some(([item, x, , z]) => p.item === item && Math.abs(p.x - x) < 1e-6 && Math.abs(p.z - z) < 1e-6)).length;
  const old = keys.filter((k) => k === 'briel.furniture' || k.startsWith('briel.furnitureRestore'));
  ok(
    `${name}: storage holds nothing of the inside`,
    !inside && !fromLayout && !old.length && !st.session && !st.idb.length && !st.caches.length,
    `${inside} pieces inside, ${fromLayout} starting pieces, old keys [${old.join(', ')}], sessionStorage ${st.session}, IndexedDB [${st.idb.join(', ')}], caches [${st.caches.join(', ')}]`,
  );
}
/** An old value as the page wrote it before the fix (or an older tab would): a piece inside the main house, its restore number. */
const plantOld = (p) => p.evaluate("localStorage.setItem('briel.furniture', JSON.stringify([{ id: -1, item: 'chair', x: 4, y: 1, z: 5, yaw: 0 }, { id: -2, item: 'chair', x: 100, y: 0, z: 100, yaw: 0 }])); localStorage.setItem('briel.furnitureRestore.house', '1')", false);
/** Open the main house with its code from the page; the starting pieces it brought (kept in memory, never printed). */
async function openHouse(a, code, name) {
  const msg = await a.evaluate(`briel.homeLocks.unlock('house', ${JSON.stringify(code)})`);
  await a.waitFor("briel.insides.packs.has('house')", 20000).catch(() => {});
  ok(`${name}: the main house opened with the code`, msg === '' && (await a.evaluate("briel.insides.packs.has('house')", false)), String(msg));
  await sleep(1500);
  return a.evaluate("briel.insides.layout().flatMap((l) => l.pieces)", false);
}
async function homeCode() {
  const admin = await call('POST', '/api/login', { username: 'admin', password: ADMIN });
  const cookie = cookieOf(admin.r);
  const code = (await call('POST', '/api/admin/homes/house/code', {}, cookie)).data?.code;
  return { code, done: async () => {
    await call('DELETE', '/api/admin/homes/house/code', undefined, cookie); // the throwaway code goes too
    await call('POST', '/api/logout', {}, cookie);
  } };
}
async function logOutFromMenu(a) {
  await menuTogether(a);
  await click(a, '#menu-logout');
  await sleep(600);
  await click(a, '#menu-logout');
  await backAtStart(a);
}

async function caseHome(a) {
  if (!ADMIN) return ok('home: skipped (no ADMIN_PASSWORD)', false);
  const acct = await account('lh');
  const h = await homeCode();
  ok('home: a code for the main house', !!h.code);
  await open(a);
  // A value from before the fix: gone at the next load.
  await plantOld(a);
  await loginFirst(a, acct);
  const atLoad = await storage(a);
  ok('home: an old stored inside is removed at load', !('briel.furniture' in atLoad.local) && !Object.keys(atLoad.local).some((k) => k.startsWith('briel.furnitureRestore')), Object.keys(atLoad.local).join(', '));
  await play(a, 'solo');
  // Alone: the inside's furniture is there to see, but not in storage.
  const layout = await openHouse(a, h.code, 'home alone');
  const shown = await a.evaluate('briel.furnishing.pieces.size', false);
  ok('home alone: the starting furniture is in the house', layout.length > 0 && shown >= layout.length, `${layout.length} starting pieces, ${shown} pieces in all`);
  storageClean('home alone, open', await storage(a), layout);
  // A piece put outside the homes is kept.
  await a.evaluate("briel.command('/chair')", false).catch(() => {});
  await sleep(500);
  const stored = await a.evaluate("localStorage.getItem('briel.furnitureAlone')", false);
  console.log(`     after /chair alone: briel.furnitureAlone holds ${piecesIn(stored).length} pieces`);
  await logOutFromMenu(a);
  storageClean('home alone, after the logout', await storage(a), layout);
  console.log(`     kept after the logout: ${Object.keys((await storage(a)).local).sort().join(', ')}`);
  // Alone after, under a name (no session): the house shut, its inside not on the page.
  await setValue(a, 'nick', `Alone${tag}`);
  await click(a, '#guest-go');
  await waitStep(a, 2);
  await play(a, 'solo');
  await sleep(3000);
  const sealed = await a.evaluate("({ packs: briel.insides.packs.size, open: briel.homeLocks.isOpen('house'), me: null })", false);
  ok('home: sealed again after the logout', sealed.packs === 0 && sealed.open === false, JSON.stringify(sealed));
  storageClean('home: played alone after', await storage(a), layout);
  await shot(a, 'home-sealed-after');
  await h.done();
}

async function caseHomeTogether(a) {
  if (!ADMIN) return ok('home together: skipped (no ADMIN_PASSWORD)', false);
  const acct = await account('lt');
  const h = await homeCode();
  await open(a);
  await loginFirst(a, acct);
  await play(a, 'multi');
  const layout = await openHouse(a, h.code, 'home together');
  storageClean('home together, open', await storage(a), layout);
  await plantOld(a); // as an older tab would write it
  await logOutFromMenu(a);
  storageClean('home together, after the logout', await storage(a), layout);
  await h.done();
}

/** The session ends elsewhere (every device logged out from another one) while the house is open: the storage is cleaned at once. */
async function caseEnded(a) {
  if (!ADMIN) return ok('ended: skipped (no ADMIN_PASSWORD)', false);
  const acct = await account('le');
  const h = await homeCode();
  await open(a);
  await loginFirst(a, acct);
  await play(a, 'solo');
  const layout = await openHouse(a, h.code, 'ended');
  // Together under the account, then the old value as an older tab would write it.
  await menuTogether(a);
  await click(a, '#mp-join-acct');
  await a.waitFor('briel.net().rtt !== null && briel.net().rtt !== undefined', 30000);
  await key(a, 'Escape', 'Escape', 27);
  await plantOld(a);
  const other = await call('POST', '/api/account/login', { username: acct.username, password: acct.password });
  const all = await call('POST', '/api/account/logout-all', {}, cookieOf(other.r));
  ok('ended: every session of the account ended from elsewhere', all.r.ok, String(all.r.status));
  await a.waitFor("localStorage.getItem('briel.furniture') === null", 10000).catch(() => {});
  const st = await storage(a);
  ok('ended: the page knows the session ended', (await meInPage(a)) === 401);
  storageClean('ended, after the session ended elsewhere', st, layout);
  await h.done();
}

async function casePad(a) {
  await open(a, { pad: true });
  await guestFirst(a, `Pad${tag}`);
  await play(a, 'multi');
  const oldCookie = await cookies(a);
  await padPress(a, 9); // Options: the menu
  await a.waitFor("!document.getElementById('pause-panel').classList.contains('hidden')", 5000);
  for (let i = 0; i < 6 && (await a.evaluate("document.getElementById('tab-together').getAttribute('aria-selected')", false)) !== 'true'; i++) await padPress(a, 5);
  ok('pad: R1 reaches the Together tab', (await a.evaluate("document.getElementById('tab-together').getAttribute('aria-selected')", false)) === 'true');
  let f = '';
  const order = [];
  for (let i = 0; i < 30 && f !== 'menu-logout'; i++) {
    await padPress(a, 13);
    f = await a.evaluate('(() => { const e = document.activeElement; return e ? e.id || e.textContent.trim().slice(0, 24) : ""; })()', false);
    order.push(f);
  }
  ok('pad: the D-pad reaches the button', f === 'menu-logout', `down ${order.length}x: ${order.join(' > ')}`);
  // On down past it: the rest of the page follows, and up comes back to it.
  await padPress(a, 13);
  const next = await a.evaluate('(() => { const e = document.activeElement; return e ? e.id || e.textContent.trim().slice(0, 24) : ""; })()', false);
  await padPress(a, 12);
  const back = await a.evaluate('document.activeElement?.id ?? ""', false);
  ok('pad: down goes on past it, up comes back to it', next !== 'menu-logout' && back === 'menu-logout', `next ${next}, back ${back}`);
  await shot(a, 'pad-focus');
  await padPress(a, 0);
  const s = await button(a);
  ok('pad: ✕ asks', s.text === 'Log out? Press again', s.text);
  await sleep(500);
  await padPress(a, 0);
  await backAtStart(a);
  const st = await startState(a);
  ok('pad: ✕ again logs out, the start screen at step 1', st.step === 1 && !st.world && (await meWith(oldCookie)) === 401, JSON.stringify(st));
}

async function caseTouch(a, size) {
  await open(a, { phone: size, low: true });
  await guestFirst(a, `Tap${tag}${size[1]}`);
  await play(a, 'multi', 'explore', 'touch');
  const oldCookie = await cookies(a);
  ok(`touch ${size.join('x')}: the Low preset`, (await a.evaluate("localStorage.getItem('briel.graphics')", false)) === 'low');
  await tap(a, '#touch .t-menu');
  await a.waitFor("!document.getElementById('pause-panel').classList.contains('hidden')", 5000);
  await tap(a, '#tab-together');
  for (const lang of ['en', 'nl']) {
    await js(a, `document.querySelector('#pause-panel [data-lang=${lang}], [data-lang=${lang}]').click()`);
    await sleep(300);
    await tap(a, '#tab-together');
    await sleep(300);
    const box = await js(a, "const e = document.getElementById('menu-logout'); e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); const page = e.closest('.page').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, inPage: r.bottom <= page.bottom + 1 && r.right <= page.right + 1, itself: top === e, text: e.textContent };");
    ok(`touch ${size.join('x')} ${lang}: the button is in view and nothing covers it`, box.inView && box.inPage && box.itself, JSON.stringify(box));
    await shot(a, `touch-${size.join('x')}-${lang}`);
    await tap(a, '#menu-logout');
    const s = await button(a);
    ok(`touch ${size.join('x')} ${lang}: a tap asks`, s.sure && s.text === (lang === 'nl' ? 'Afmelden? Druk nog eens' : 'Log out? Press again'), s.text);
    const box2 = await js(a, "const e = document.getElementById('menu-logout'); const r = e.getBoundingClientRect(); return { w: Math.round(r.width), inView: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };");
    ok(`touch ${size.join('x')} ${lang}: the asking text fits`, box2.inView, JSON.stringify(box2));
    await shot(a, `touch-${size.join('x')}-${lang}-asking`);
    if (lang === 'en') {
      await sleep(4400); // back to "Log out" before the other language
    }
  }
  // The header at this size, for the placement (the button is not there).
  await sleep(500);
  await tap(a, '#menu-logout');
  await backAtStart(a);
  const st = await startState(a);
  ok(`touch ${size.join('x')}: the second tap logs out, the start screen at step 1`, st.step === 1 && !st.world && (await meWith(oldCookie)) === 401, JSON.stringify(st));
  await shot(a, `touch-${size.join('x')}-start-after`);
  await js(a, "document.querySelector('[data-lang=en]').click()");
}

// ---- Run.
const want = (name) => !only || only.includes(name);
const chrome = await launch({ port: Number(o.port), width: 1280, height: 720, extra: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
console.log(`chromium pid ${chrome.pid}`);
process.on('uncaughtException', (e) => {
  console.error(e);
  chrome.close();
  process.exit(1);
});
let other = null;
const run = async (name, fn) => {
  if (!want(name)) return;
  try {
    await fn();
  } catch (e) {
    ok(`${name}: ran through`, false, String(e.message ?? e).slice(0, 300));
    await shot(chrome, `${name}-failed`).catch(() => {});
  }
};
try {
  let carried = null;
  if (want('account') || want('guest')) {
    other = await secondPage(chrome);
    await run('account', async () => {
      carried = await caseAccount(chrome, other);
    });
    await run('guest', async () => {
      if (!carried) {
        await open(other);
        carried = { b: other, guest: `Solo${tag}` };
        await guestFirst(other, carried.guest);
        await play(other, 'multi');
      }
      await caseGuest(other, carried.guest);
    });
    await other.closeAll();
    other = null;
  }
  if (want('room')) {
    other = await secondPage(chrome);
    await run('room', () => caseRoom(chrome, other));
    await other.closeAll();
    other = null;
  }
  await run('offline', () => caseOffline(chrome));
  await run('home', () => caseHome(chrome));
  await run('home-together', () => caseHomeTogether(chrome));
  await run('ended', () => caseEnded(chrome));
  await run('pad', async () => {
    // A page of its own: the fake controller is put in before the page's scripts.
    const p = await secondPage(chrome);
    try {
      await casePad(p);
    } finally {
      await p.closeAll();
    }
  });
  for (const size of [[844, 390], [667, 375]]) {
    await run('touch', async () => {
      const p = await secondPage(chrome);
      try {
        await caseTouch(p, size);
      } finally {
        await p.closeAll();
      }
    });
  }
  const errors = chrome.logs.filter((l) => l.startsWith('exception') || l.startsWith('error'));
  if (errors.length) console.log(`console errors on the first page: ${errors.slice(0, 5).join(' | ').slice(0, 600)}`);
} finally {
  if (other) await other.closeAll().catch(() => {});
  chrome.close();
  // The accounts made here go again; the guests' sessions end.
  for (const a of accounts) {
    const login = await call('POST', '/api/account/login', { username: a.username, password: a.password });
    await call('POST', '/api/account/delete', { password: a.password }, cookieOf(login.r));
  }
  for (const c of guestCookies) await call('POST', '/api/logout', {}, c);
}
const failed = results.filter((r) => !r.pass).length;
console.log(`${results.length - failed} of ${results.length} passed`);
process.exit(failed ? 1 : 0);
