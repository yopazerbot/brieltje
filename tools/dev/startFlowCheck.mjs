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
      // The room named (other rooms may be open too), or the first one open.
      const sel = c.roomId ? `#z-room-list button[data-room="${c.roomId}"]:not([disabled])` : '#z-room-list button[data-room]:not([disabled])';
      await b.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, 15000);
      await click(b, sel);
    }
  } else {
    await click(b, `#mode-start [data-play=${c.mode}]`);
    if (c.place) await setValue(b, 'spawn', c.place);
  }
}

/** A session cookie in this browser before the start screen asks /api/me: a guest who joined, or a login. */
async function sessionFirst(b, c) {
  const acct = c.first ?? c.account;
  const req = c.who === 'returning'
    ? ['/api/join', { name: `Back${tag}${port}`, age: true }]
    : ['/api/account/login', { username: acct.username, password: acct.password }];
  const status = await b.evaluate(`fetch(${JSON.stringify(req[0])}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(req[1]))} }).then((r) => r.status)`);
  if (status !== 200) throw new Error(`${req[0]}: ${status}`);
  await open(b, o.url, c.input === 'touch');
}

/** Logging in on the start screen with the phone, by controller: L1 to the login card, ✕ on the phone button, the phone says yes. */
async function phoneLogin(b, acct) {
  await padPress(b, 4); // L1: the login card, the focus on "Log in with your phone"
  const f = await active(b);
  if (f !== 'login-phone') throw new Error(`L1's focus is on ${f}, not the phone login`);
  await padPress(b, 0);
  await b.waitFor("(document.getElementById('login-pair-code').textContent || '').replace(/[^A-Z0-9]/g, '').length >= 8", 15000);
  const shown = await b.evaluate("({ code: document.getElementById('login-pair-code').textContent, check: document.getElementById('login-pair-check').textContent })", false);
  // The phone: logged in to the account, it types the 2-digit number and says yes.
  const login = await call('POST', '/api/account/login', { username: acct.username, password: acct.password });
  const cookie = login.r.headers.getSetCookie().map((x) => x.split(';')[0]).join('; ');
  const yes = await call('POST', '/api/pair/approve', { code: shown.code, check: shown.check.replace(/\D/g, '') }, cookie);
  if (!yes.r.ok) throw new Error(`approve: ${yes.r.status} ${JSON.stringify(yes.data)}`);
  await waitStep(b, 2, 20000);
}

/** The same with only the controller: ✕ on each step's likely choice (the ready guest name, Zombies, Controller). */
async function walkStepsPad(b, c) {
  await padPress(b, 1); // the press that brings the controller in only shows where the focus is
  if (c.who === 'phone') {
    await phoneLogin(b, c.account);
    await padPress(b, 0); // step 2: Alone
    await waitStep(b, 3);
    return;
  }
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
        net: briel.net().rtt !== undefined && briel.net().rtt !== null, lang: document.documentElement.lang, play: localStorage.getItem('briel.playMode'),
        paint: document.body.classList.contains('paintball'),
        adminTab: !document.getElementById('tab-admin').classList.contains('hidden'),
        acct: [...document.querySelectorAll('.acct-manage')].some((e) => !e.classList.contains('hidden')) };
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
    if (c.mode === 'paintball' && !last.paint) bad.push('not with paint');
    if (c.mode === 'action' && last.paint) bad.push('paint in Action');
    if (c.place) {
      // Free play drops by parachute (the admin's rule): onto the place, or already there.
      const at = c.place === 'house' ? { x: 1, z: 30 } : portalOut(c.place);
      const target = s.find((x) => x.chute === null && x.air < 1) ?? last;
      const d = Math.hypot(target.x - at.x, target.z - at.z);
      if (!anyChute && d > 40) bad.push(`${d.toFixed(0)} m from ${c.place}`);
    }
  }
  if (c.lang && last.lang !== c.lang) bad.push(`page in ${last.lang}, not ${c.lang}`);
  // A guest never gets an account's or the admin's options; an account its own, the admin the admin's tab.
  const role = c.who === 'admin' ? 'admin' : ['login', 'cookie', 'phone'].includes(c.who) ? 'player' : 'guest';
  if (last.adminTab !== (role === 'admin')) bad.push(`the admin tab ${last.adminTab ? 'shows' : 'is missing'} for a ${role}`);
  if (last.acct !== (role === 'player')) bad.push(`"Your account" ${last.acct ? 'shows' : 'is missing'} for a ${role}`);
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
    if (c.who === 'returning' || c.who === 'cookie' || c.first) await sessionFirst(b, c);
    if (c.before) await c.before(b, c);
    if (c.input === 'pad') await walkStepsPad(b, c);
    else await walkSteps(b, c);
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

/**
 * After a solo Zombies start at home: /parachute is refused; a strongman's stomps end the game (no drop back in);
 * the end puts you at the start on the ground; Zombies again from the Play tab, stopped from it, then Explore.
 */
async function soloAfterwards(b) {
  const bad = [];
  const state = () => b.evaluate("(() => { const p = briel.player, s = briel.zombiesSolo.state(); return { chute: p.chute, air: p.feet - briel.world.groundAt(p.x, p.z, p.feet + 0.3, 0).y, x: p.x, z: p.z, solo: s ? s.arena.id : null, alive: briel.combat.alive, armed: briel.weapon.enabled, kind: briel.games.view.kind }; })()", false);
  const noDrop = async (what, ms) => {
    for (let t = 0; t < ms; t += 250) {
      const s = await state();
      if (s.chute !== null || s.air > 3) return bad.push(`${what}: in the air (chute ${s.chute}, ${s.air.toFixed(1)} m)`);
      await sleep(250);
    }
  };
  await b.evaluate("briel.command('/parachute')", false);
  await noDrop('/parachute in Zombies', 1000);
  // A strongman stomps where you stand until you are down (alone it is the page that hurts you).
  await b.evaluate(`(() => { const p = briel.player; for (let i = 0; i < 20 && briel.combat.alive; i++) briel.clowns.onLand(briel.three.sun.position.clone().set(p.x, p.feet, p.z), 'stomp'); })()`, false);
  if ((await state()).alive) bad.push('a strongman could not hurt you (check the stomp)');
  await noDrop('down in Zombies', 5000);
  // The game is over once you are down (after the first wave has come), and its end screen 15 s later.
  await b.waitFor('!briel.zombiesSolo.state()', 40000).catch(() => bad.push('the game did not end after you went down'));
  const end = await state();
  const home = zombiesStart('house');
  if (!end.alive) bad.push('still down after the end');
  if (Math.hypot(end.x - home.x, end.z - home.z) > home.r) bad.push('not back at the start after the end');
  await noDrop('after the end', 2000);
  // Zombies again from the Play tab, then stopped from it: where you stand, on your feet.
  await b.evaluate("document.getElementById('zombies-place').value = 'house'; document.getElementById('zombies-btn').click()", false);
  await b.waitFor("briel.zombiesSolo.state()?.arena.id === 'house'", 20000).catch(() => bad.push('the Play tab did not start Zombies'));
  await noDrop('Zombies from the Play tab', 2000);
  await b.evaluate("document.getElementById('zombies-btn').click()", false);
  await sleep(500);
  const stopped = await state();
  if (stopped.solo) bad.push('the Play tab did not stop Zombies');
  if (stopped.kind === 'zombies') bad.push('the Zombies bar stayed after stopping');
  await noDrop('after stopping', 1500);
  // Explore from the Play tab: no weapon.
  await b.evaluate("document.querySelector('#pause-panel [data-play=explore], [data-play=explore]').click()", false);
  await sleep(300);
  if ((await state()).armed) bad.push('a weapon in Explore from the Play tab');
  return bad;
}

/** The welcome card's "Other account" (`#welcome-switch`) or "Log out" (`#mp-logout`): the session ends, the who cards are back. */
const leaveWelcome = (button) => async (b) => {
  await b.waitFor("!document.getElementById('welcome-card').classList.contains('hidden')", 10000);
  await click(b, button);
  await b.waitFor("document.getElementById('welcome-card').classList.contains('hidden') && !document.getElementById('who-cards').classList.contains('hidden')", 10000);
  await sleep(1000); // the logout reaches the server
  const me = await b.evaluate("fetch('/api/me').then((r) => r.status)");
  if (me === 200) throw new Error(`${button}: still logged in on the server`);
};

/**
 * Together in one room: an account opens it at `place` from the start screen, a guest joins it from theirs, the
 * account starts the game (the Together tab's Start), and a second guest joins while it runs. Nobody drops in.
 */
async function roomTogether(place) {
  const owner = await account('sfo');
  const players = [
    { name: `room-owner-${place}`, who: 'login', account: owner, mp: 'multi', mode: 'zombies', room: 'open', place, input: 'kbm' },
    { name: `room-guest-${place}`, who: 'guest', nick: `Gast${tag}${place.slice(0, 3)}a`, mp: 'multi', mode: 'zombies', place, input: 'kbm' },
    { name: `room-late-${place}`, who: 'guest', nick: `Gast${tag}${place.slice(0, 3)}b`, mp: 'multi', mode: 'zombies', place, input: 'touch' },
  ];
  const browsers = [];
  const out = [];
  try {
    for (const [i, c] of players.entries()) {
      const b = await launch({ port: port++, width: 1280, height: 720 });
      browsers.push(b);
      await open(b, o.url, c.input === 'touch');
      // The guests join the owner's room: its id from the owner's list (marked as theirs).
      if (i > 0) c.roomId = await browsers[0].evaluate("fetch('/api/rooms').then((r) => r.json()).then((d) => d.rooms.find((r) => r.mine)?.id)");
      await walkSteps(b, c);
      await start(b, c);
      if (i === 1) {
        // Both in: the owner starts the game from the Together tab, as its hint says.
        await browsers[0].evaluate("document.getElementById('room-start').click()", false);
        await browsers[0].waitFor("briel.games.view.kind === 'zombies'", 15000);
      }
      const s = await watch(b, c, 8);
      if (o.shots) await b.screenshot(join(o.shots, `${c.name}.png`));
      const bad = [...judge(c, s), ...errorsOf(b).map((e) => `console: ${e.slice(0, 160)}`)];
      if (i > 0 && s.at(-1).kind !== 'zombies') bad.push(`the game bar shows ${s.at(-1).kind}, not the room's Zombies`);
      if (!s.at(-1).net) bad.push('not connected');
      out.push({ name: c.name, first: bad.length ? bad.join('; ') : 'ok', again: '-', notes: [] });
    }
  } catch (e) {
    const b = browsers.at(-1);
    const said = b ? await b.evaluate("document.getElementById('mp-msg').textContent", false).catch(() => '') : '';
    out.push({ name: `room-${place}`, first: `failed: ${String(e.message ?? e).slice(0, 200)}${said ? ` (the page says: ${said})` : ''}`, again: '-', notes: [] });
    if (b && o.shots) await b.screenshot(join(o.shots, `room-${place}-failed.png`)).catch(() => {});
  } finally {
    for (const b of browsers) b.close();
  }
  return out;
}

// ---- The cases.
const PLACES = ['house', 'bungalow', 'church', 'molenhoek', 'molenhoek_mid', 'molenhoek_end', 'sparrenhof'];
const cases = [
  ...PLACES.map((place) => ({ name: `zombies-${place}`, who: 'guest', mp: 'solo', mode: 'zombies', place, input: 'kbm', again: place === 'house' || place === 'church' })),
  { name: 'zombies-house-afterwards', who: 'guest', mp: 'solo', mode: 'zombies', place: 'house', input: 'kbm', again: false, after: soloAfterwards },
  { name: 'explore-church', who: 'guest', mp: 'solo', mode: 'explore', place: 'church', input: 'kbm' },
  { name: 'explore-football', who: 'guest', mp: 'solo', mode: 'explore', place: 'football', input: 'kbm', again: false },
  { name: 'paintball-house', who: 'guest', mp: 'solo', mode: 'paintball', place: 'house', input: 'kbm' },
  { name: 'action-school', who: 'guest', mp: 'solo', mode: 'action', place: 'school', input: 'kbm' },
  { name: 'zombies-church-nl', who: 'guest', mp: 'solo', mode: 'zombies', place: 'church', input: 'kbm', lang: 'nl', again: false },
  { name: 'touch-zombies-house', who: 'guest', mp: 'solo', mode: 'zombies', place: 'house', input: 'touch' },
  { name: 'pad-zombies-house', who: 'guest', mp: 'solo', mode: 'zombies', place: 'house', input: 'pad' },
  { name: 'login-zombies-solo', who: 'login', mp: 'solo', mode: 'zombies', place: 'molenhoek', input: 'kbm', needs: 'account' },
  { name: 'admin-zombies-solo', who: 'admin', mp: 'solo', mode: 'zombies', place: 'bungalow', input: 'kbm', needs: 'admin' },
  { name: 'returning-guest-zombies', who: 'returning', mp: 'solo', mode: 'zombies', place: 'sparrenhof', input: 'kbm', again: false },
  { name: 'cookie-account-explore', who: 'cookie', mp: 'solo', mode: 'explore', place: 'molenhoek', input: 'kbm', needs: 'account' },
  { name: 'other-account', who: 'login', first: true, mp: 'solo', mode: 'action', place: 'church', input: 'kbm', needs: 'account', again: false, before: leaveWelcome('#welcome-switch') },
  { name: 'logout-then-guest', who: 'guest', first: true, mp: 'solo', mode: 'zombies', place: 'house', input: 'kbm', needs: 'account', again: false, before: leaveWelcome('#mp-logout') },
  { name: 'pad-phone-login', who: 'phone', mp: 'solo', mode: 'zombies', place: 'house', input: 'pad', needs: 'account' },
  { name: 'login-room-open', who: 'login', mp: 'multi', mode: 'zombies', room: 'open', place: 'church', input: 'kbm', needs: 'account' },
  { name: 'login-room-house', who: 'login', mp: 'multi', mode: 'zombies', room: 'open', place: 'house', input: 'kbm', needs: 'account' },
  { name: 'login-together-action', who: 'login', mp: 'multi', mode: 'action', place: 'church', input: 'kbm', needs: 'account' },
  { name: 'room-molenhoek_mid', room2: true, place: 'molenhoek_mid' },
  { name: 'room-house', room2: true, place: 'house' },
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
    if (c.first === true) c.first = await account('sfc');
    const rs = c.room2 ? await roomTogether(c.place) : [await run(c)];
    for (const r of rs) {
      results.push(r);
      const pass = r.first === 'ok' && ['ok', '', '-'].includes(r.again);
      console.log(`${pass ? 'ok  ' : 'FAIL'} ${r.name}: ${r.first}${r.again ? ` | again: ${r.again}` : ''}${r.notes.length ? ` (${r.notes.join('; ')})` : ''}`);
    }
  }
} finally {
  // The accounts made here go again.
  for (const a of accounts) {
    const login = await call('POST', '/api/account/login', { username: a.username, password: a.password });
    const cookie = login.r.headers.getSetCookie().map((x) => x.split(';')[0]).join('; ');
    await call('POST', '/api/account/delete', { password: a.password }, cookie);
  }
}
const failed = results.filter((r) => r.first !== 'ok' || !['ok', '', '-'].includes(r.again));
console.log(`\n| Case | First start | Play again as before |\n|---|---|---|`);
for (const r of results) console.log(`| ${r.name} | ${r.first} | ${r.again || 'not tried'} |`);
process.exit(failed.length ? 1 : 0);
