// The start screen end to end, headless (tools/dev/cdp.mjs): every way from opening the page to playing, through the
// three steps (who, alone or together, the game), with the keyboard and mouse, a controller (a fake one in the page)
// or touch, then "Play again as before" after a reload. After each start it watches the first seconds of play:
// the mode and the place, no parachute in Zombies, no weapon in Explore, the game bar, and no console errors.
//
//   ADMIN_PASSWORD=... node tools/dev/startFlowCheck.mjs --url http://localhost:5580/ --api http://localhost:8810
//          [--only zombies-house,explore-church] [--shots <folder>] [--port 10240] [--list]
//
// --url is a dev server (window.briel) whose /api goes to --api (Vite with API_PORT=<its port>): a throwaway game
// server on this computer only, as the check makes accounts, logs in as the admin and opens rooms. The accounts it
// makes are deleted at the end. --shots saves a picture a few seconds into each case. --list prints the cases.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ARENAS } from '../../web/shared/arenas.mjs';
import { PORTALS } from '../../web/shared/portals.mjs';
import { launch, localOnly, options } from './cdp.mjs';

const o = options({ url: 'http://localhost:5580/', api: 'http://localhost:8810', port: '10240', only: '', shots: '', list: false });
localOnly(o.api);
localOnly(o.url, '--url');
const ADMIN = process.env.ADMIN_PASSWORD ?? '';
if (o.shots) mkdirSync(o.shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port = Number(o.port);

// ---- Accounts for the cases that log in (made on the server directly, deleted at the end).
const call = async (method, path, body, cookie = '') => {
  const r = await fetch(o.api + path, { method, headers: { 'Content-Type': 'application/json', Origin: o.api, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  return { r, data: await r.json().catch(() => null) };
};
const tag = Math.random().toString(36).slice(2, 6);
const accounts = [];
async function account(prefix) {
  const username = `${prefix}${tag}${accounts.length}`;
  const password = `pw-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const { r, data } = await call('POST', '/api/account/register', { username, email: `${username}@example.invalid`, password, age: true });
  if (!r.ok) throw new Error(`register ${username}: ${r.status} ${JSON.stringify(data)}`);
  accounts.push({ username, password });
  return { username, password };
}

// ---- What a case expects, worked out from the shared data.
/** Where Zombies alone starts at `place`: its portal's way out, or round the main house. */
function zombiesStart(place) {
  const a = ARENAS.find((x) => x.id === place);
  if (!a || a.id === 'house') return { x: 4.5, z: 18, r: 40 };
  const p = PORTALS.find((q) => q.id === place);
  return { x: p.out[0], z: p.out[1], r: 25 };
}
function portalOut(place) {
  const p = PORTALS.find((q) => q.id === place);
  return p ? { x: p.out[0], z: p.out[1] } : null;
}

// ---- Driving the page.
const FAKE_PAD = `(() => {
  const b = () => ({ pressed: false, touched: false, value: 0 });
  const pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard', timestamp: 1, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, b), vibrationActuator: null };
  window.__pad = pad;
  window.__padOn = false;
  navigator.getGamepads = () => [window.__padOn ? pad : null, null, null, null];
})();`;
/** A button on the fake controller, pressed for a few frames. 0 cross, 1 circle, 12-15 the D-pad up, down, left, right. */
async function padPress(b, i) {
  await b.evaluate(`(() => { window.__padOn = true; const k = window.__pad.buttons[${i}]; k.pressed = true; k.value = 1; window.__pad.timestamp++; })()`, false);
  await sleep(140);
  await b.evaluate(`(() => { const k = window.__pad.buttons[${i}]; k.pressed = false; k.value = 0; window.__pad.timestamp++; })()`, false);
  await sleep(160);
}
const active = (b) => b.evaluate("(() => { const e = document.activeElement; return e ? (e.id || e.dataset.mp || e.dataset.play || e.dataset.startMode || e.tagName) : null; })()", false);

async function open(b, url, phone) {
  if (phone) {
    await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await b.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  }
  await b.send('Page.navigate', { url });
  await b.waitFor("!!document.querySelector('#choose-kbm') && !document.getElementById('overlay').classList.contains('hidden')");
  await sleep(5000); // the dev build attaches the start screen's handlers late; /api/me answers
}
const step = (b) => b.evaluate("Number(document.getElementById('start-panel').dataset.step)", false);
const js = (b, code) => b.evaluate(`(() => { ${code} })()`, false);
const setValue = (b, id, value) => js(b, `const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));`);
const click = (b, sel) => js(b, `const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no ' + ${JSON.stringify(sel)}); e.click();`);
async function waitStep(b, n, ms = 15000) {
  await b.waitFor(`Number(document.getElementById('start-panel').dataset.step) === ${n}`, ms);
}

/** Step 1 to 3 with the mouse (or taps), as the case says. */
async function walkSteps(b, c) {
  if (c.lang) await click(b, `[data-lang=${c.lang}]`);
  // Step 1: who.
  if (c.who === 'guest') {
    await setValue(b, 'nick', c.nick ?? `Check${tag}`);
    await click(b, '#guest-go');
  } else if (c.who === 'login' || c.who === 'admin') {
    const acct = c.who === 'admin' ? { username: 'admin', password: ADMIN } : c.account;
    await setValue(b, 'login-name', acct.username);
    await setValue(b, 'login-pass', acct.password);
    await js(b, "document.getElementById('login-card').requestSubmit()");
  } else if (c.who === 'cookie' || c.who === 'returning') {
    await b.waitFor("!document.getElementById('welcome-card').classList.contains('hidden')", 10000);
    await click(b, '#welcome-go');
  }
  await waitStep(b, 2);
  // Step 2: alone or together.
  if (c.mp === 'multi' && c.who === 'guest') await js(b, "const a = document.getElementById('mp-age'); a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true }));");
  await click(b, `#mp-choice [data-mp=${c.mp}]`);
  await waitStep(b, 3);
  // Step 3: the game, and where.
  if (c.mode === 'zombies') {
    await click(b, '#mode-start [data-start-mode=zombies]');
    if (c.mp === 'solo') await setValue(b, 'z-place', c.place);
    else if (c.room === 'open') {
      await setValue(b, 'z-open-place', c.place);
      await click(b, '#z-open [data-room=new]');
    } else {
      await b.waitFor("!!document.querySelector('#z-room-list button[data-room]:not([disabled])')", 15000);
      await click(b, '#z-room-list button[data-room]:not([disabled])');
    }
  } else {
    await click(b, `#mode-start [data-play=${c.mode}]`);
    if (c.place) await setValue(b, 'spawn', c.place);
  }
}

/** The same with only the controller: ✕ on each step's likely choice (the ready guest name, Zombies, Controller). */
async function walkStepsPad(b) {
  await padPress(b, 1); // the press that brings the controller in only shows where the focus is
  for (let i = 0; i < 2; i++) {
    const before = await step(b);
    await padPress(b, 0);
    await b.waitFor(`Number(document.getElementById('start-panel').dataset.step) > ${before}`, 15000);
  }
}

/** Press start (the input's button), then wait until play has begun. */
async function start(b, c) {
  if (c.input === 'pad') {
    const f = await active(b);
    if (f !== 'choose-pad') throw new Error(`step 3's focus is on ${f}, not the Controller button`);
    await padPress(b, 0);
  } else await click(b, `#choose-${c.input}`);
  await b.waitFor('!!window.briel', 180000);
  await b.waitFor("(() => { const p = document.getElementById('start-panel'); if (!p || p.offsetParent === null) return true; const s = getComputedStyle(p); return s.visibility === 'hidden' || Number(s.opacity) < 0.05; })()", 240000);
}

/** The first seconds of play, sampled: what the case should see. */
async function watch(b, c, seconds = 9) {
  const samples = [];
  for (let t = 0; t < seconds * 4; t++) {
    samples.push(await b.evaluate(`(() => {
      const p = briel.player, s = briel.zombiesSolo.state();
      const g = briel.world.groundAt(p.x, p.z, p.feet + 0.3, 0).y;
      const bar = document.getElementById('modebar');
      return { x: p.x, z: p.z, air: p.feet - g, chute: p.chute, solo: s ? s.arena.id : null, armed: briel.weapon.enabled, w: briel.weapon.current,
        kind: briel.games.view.kind, bar: !!bar && !bar.classList.contains('hidden') && bar.offsetParent !== null, barText: bar ? bar.textContent.trim().slice(0, 60) : '',
        net: briel.net().rtt !== undefined && briel.net().rtt !== null, lang: document.documentElement.lang, play: localStorage.getItem('briel.playMode') };
    })()`, false));
    await sleep(250);
  }
  return samples;
}

/** What went wrong in a case's samples, or none. */
function judge(c, s) {
  const bad = [];
  const last = s.at(-1);
  const anyChute = s.some((x) => x.chute !== null);
  const highest = Math.max(...s.map((x) => x.air));
  if (c.mode === 'zombies') {
    if (anyChute) bad.push('a parachute in Zombies');
    if (highest > 3) bad.push(`in the air (${highest.toFixed(1)} m)`);
    if (c.mp === 'solo') {
      if (last.solo !== c.place) bad.push(`solo Zombies at ${last.solo ?? 'none'}, not ${c.place}`);
      const at = zombiesStart(c.place);
      const d = Math.hypot(last.x - at.x, last.z - at.z);
      if (d > at.r) bad.push(`${d.toFixed(0)} m from the place's start`);
      if (!last.bar) bad.push('no game bar');
    } else {
      if (last.solo) bad.push('a solo game together');
      const at = zombiesStart(c.place);
      const d = Math.hypot(last.x - at.x, last.z - at.z);
      if (d > at.r) bad.push(`${d.toFixed(0)} m from the room's place`);
    }
    if (!last.armed) bad.push('Zombies without a weapon');
  } else {
    if (last.solo) bad.push('a Zombies game outside Zombies');
    if (last.kind === 'zombies') bad.push('the Zombies bar outside Zombies');
    if (c.mode === 'explore' && last.armed) bad.push('a weapon in Explore');
    if (c.mode !== 'explore' && !last.armed) bad.push(`no weapon in ${c.mode}`);
    if (c.mode === 'paintball' && !/^paint|paint/.test(String(last.w))) bad.push(`not the paint gun (${last.w})`);
    if (c.mode === 'action' && /paint/.test(String(last.w))) bad.push(`a paint gun in Action (${last.w})`);
    if (c.place) {
      // Free play drops by parachute (the admin's rule): onto the place, or already there.
      const at = c.place === 'house' ? { x: 1, z: 30 } : portalOut(c.place);
      const target = s.find((x) => x.chute === null && x.air < 1) ?? last;
      const d = Math.hypot(target.x - at.x, target.z - at.z);
      if (!anyChute && d > 40) bad.push(`${d.toFixed(0)} m from ${c.place}`);
    }
  }
  if (c.lang && last.lang !== c.lang) bad.push(`page in ${last.lang}, not ${c.lang}`);
  return bad;
}

const errorsOf = (b) => b.logs.filter((l) => /^(error|exception)/.test(l) && !/Failed to load resource: the server responded with a status of 40[134]/.test(l));

/** One case: a fresh browser through the steps, then (unless `again: false`) a reload and "Play again as before". */
async function run(c) {
  const b = await launch({ port: port++, width: 1280, height: 720 });
  const result = { name: c.name, first: '', again: '', notes: [] };
  try {
    if (c.input === 'pad') await b.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_PAD });
    if (c.cookie) await b.send('Network.setCookie', { ...c.cookie });
    await open(b, o.url, c.input === 'touch');
    if (c.before) await c.before(b);
    if (c.input === 'pad') await walkStepsPad(b);
    else await walkSteps(b, c);
    if (c.input === 'pad' && c.padSteps) await c.padSteps(b);
    await start(b, c);
    const s = await watch(b, c);
    if (o.shots) await b.screenshot(join(o.shots, `${c.name}.png`));
    const bad = [...judge(c, s), ...errorsOf(b).map((e) => `console: ${e.slice(0, 160)}`)];
    if (c.after) bad.push(...((await c.after(b, s)) ?? []));
    result.first = bad.length ? bad.join('; ') : 'ok';
    result.sample = s.at(-1);
    if (c.again !== false) {
      b.logs.length = 0;
      if (c.input === 'pad') await b.evaluate('window.__padOn = false', false);
      await open(b, o.url, c.input === 'touch');
      if (c.input === 'pad') await padPress(b, 1);
      const shown = await b.evaluate("(() => { const a = document.getElementById('again'); return a.classList.contains('hidden') ? null : document.getElementById('again-sub').textContent; })()", false);
      if (!shown) result.again = 'no "Play again as before"';
      else {
        result.notes.push(`again: ${shown}`);
        if (c.input === 'pad') {
          const f = await active(b);
          if (f !== 'again') result.notes.push(`again: focus on ${f}`);
          await padPress(b, 0);
        } else await click(b, '#again');
        await b.waitFor('!!window.briel', 180000);
        await b.waitFor("(() => { const p = document.getElementById('start-panel'); if (!p || p.offsetParent === null) return true; const s = getComputedStyle(p); return s.visibility === 'hidden' || Number(s.opacity) < 0.05; })()", 240000);
        const s2 = await watch(b, c, 7);
        const bad2 = [...judge(c, s2), ...errorsOf(b).map((e) => `console: ${e.slice(0, 160)}`)];
        result.again = bad2.length ? bad2.join('; ') : 'ok';
      }
    }
  } catch (e) {
    result.first ||= `failed: ${String(e.message ?? e).slice(0, 200)}`;
    result.again ||= '-';
    try {
      if (o.shots) await b.screenshot(join(o.shots, `${c.name}-failed.png`));
    } catch {}
  } finally {
    b.close();
  }
  return result;
}

// ---- The cases.
const PLACES = ['house', 'bungalow', 'church', 'molenhoek', 'molenhoek_mid', 'molenhoek_end', 'sparrenhof'];
const cases = [
  ...PLACES.map((place) => ({ name: `zombies-${place}`, who: 'guest', mp: 'solo', mode: 'zombies', place, input: 'kbm', again: place === 'house' || place === 'church' })),
  { name: 'explore-church', who: 'guest', mp: 'solo', mode: 'explore', place: 'church', input: 'kbm' },
  { name: 'explore-football', who: 'guest', mp: 'solo', mode: 'explore', place: 'football', input: 'kbm', again: false },
  { name: 'paintball-house', who: 'guest', mp: 'solo', mode: 'paintball', place: 'house', input: 'kbm' },
  { name: 'action-school', who: 'guest', mp: 'solo', mode: 'action', place: 'school', input: 'kbm' },
  { name: 'zombies-church-nl', who: 'guest', mp: 'solo', mode: 'zombies', place: 'church', input: 'kbm', lang: 'nl', again: false },
  { name: 'touch-zombies-house', who: 'guest', mp: 'solo', mode: 'zombies', place: 'house', input: 'touch' },
  { name: 'pad-zombies-house', who: 'guest', mp: 'solo', mode: 'zombies', place: 'house', input: 'pad' },
  { name: 'login-zombies-solo', who: 'login', mp: 'solo', mode: 'zombies', place: 'molenhoek', input: 'kbm', needs: 'account' },
  { name: 'admin-zombies-solo', who: 'admin', mp: 'solo', mode: 'zombies', place: 'bungalow', input: 'kbm', needs: 'admin' },
  { name: 'login-room-open', who: 'login', mp: 'multi', mode: 'zombies', room: 'open', place: 'church', input: 'kbm', needs: 'account' },
  { name: 'login-room-house', who: 'login', mp: 'multi', mode: 'zombies', room: 'open', place: 'house', input: 'kbm', needs: 'account' },
  { name: 'login-together-action', who: 'login', mp: 'multi', mode: 'action', place: 'church', input: 'kbm', needs: 'account' },
];
if (o.list) {
  for (const c of cases) console.log(c.name);
  process.exit(0);
}
const only = o.only ? new Set(o.only.split(',')) : null;
const results = [];
try {
  for (const c of cases) {
    if (only && !only.has(c.name)) continue;
    if (c.needs === 'admin' && !ADMIN) {
      results.push({ name: c.name, first: 'skipped (no ADMIN_PASSWORD)', again: '-', notes: [] });
      continue;
    }
    if (c.needs === 'account') c.account = await account('sfc');
    const r = await run(c);
    results.push(r);
    console.log(`${r.first === 'ok' && (r.again === 'ok' || r.again === '') ? 'ok  ' : 'FAIL'} ${r.name}: ${r.first}${r.again ? ` | again: ${r.again}` : ''}${r.notes.length ? ` (${r.notes.join('; ')})` : ''}`);
  }
} finally {
  // The accounts made here go again.
  for (const a of accounts) {
    const login = await call('POST', '/api/account/login', { username: a.username, password: a.password });
    const cookie = login.r.headers.getSetCookie().map((x) => x.split(';')[0]).join('; ');
    await call('POST', '/api/account/delete', { password: a.password }, cookie);
  }
}
const failed = results.filter((r) => r.first !== 'ok' || (r.again && r.again !== 'ok' && r.again !== '-' ));
console.log(`\n| Case | First start | Play again as before |\n|---|---|---|`);
for (const r of results) console.log(`| ${r.name} | ${r.first} | ${r.again || 'not tried'} |`);
process.exit(failed.length ? 1 : 0);
