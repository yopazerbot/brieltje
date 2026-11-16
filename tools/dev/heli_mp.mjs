// The helicopters together (src/heliPilot.ts, world/heli.ts; the server's side server/helis.mjs), real pages on a
// throwaway game server (a build of this branch, its API on --api) through a dev server whose proxy points at it
// (API_PORT=<server port> npx vite --port <n>). Pages and their parts:
//   Pilot, RiderA, RiderB and RiderC (a phone: touch emulation) start at the house; Fifth there too; Watcher at the church.
// 1. The four board the house's machine (seat 0 first, then 1, 2, 3, the phone by its Use button), Fifth is refused (the
//    line says it is full, nothing sent), everyone sees the four seated with their names over the machine. Fifth goes to
//    the church and flies its machine with Watcher aboard, while Pilot flies the house's to the church's deck: two crews,
//    each to the other's pad, at once. Each passenger's machine is drawn where its pilot had it at that moment (to
//    0.5 m at top speed). They land; everyone gets out; once nobody stands by the pads both go back to their own (the
//    server's own-pads rule: the two swap).
// 2. The four board the church's machine on its deck, RiderA's view key switches to his seat and back, and Pilot flies
//    it to the house, part of the way at 30 frames a second and with 250 ms frames, past Watcher on the ground: the
//    machine he sees moves on smoothly (no jump of more than 0.5 m from where its last frames led, never back), with the
//    four seated and named (the 250 ms part's numbers are printed: see `agreement`). A page that joins while it hangs over
//    the house sees it there with its four. A party game started by the admin puts everyone out and the machine home.
// 3. The four board the house's machine. Pilot gets out on the ground, RiderA takes the stick (the up key), Pilot boards
//    again into the seat freed; RiderA lifts off. RiderB's page closes in the air (his seat empties everywhere), then
//    RiderA's, the pilot's: the machine hangs still, the line says nobody flies; after 20 s the two left aboard are put
//    out and it is on its pad, with a line in the chat. The admin's rule off: the line beside it says so and Use asks
//    nothing. Zombies started in the air puts Pilot and RiderC out and the machine home.
// 4. Only on its own (--phases 4): the watcher's frame time with the four aboard hanging 12 m over the house's pad, and
//    with it parked empty there, each against the same view without it (briel.bench, alternated), on Medium and Low.
// 5. The jump together (--phases 5 on its own takes three pages): Pilot, RiderC (the phone) and RiderA aboard, 60 m
//    over the house's pad; RiderA's line in the air says Use jumps, the phone's shows no keys. RiderC jumps by the Use
//    button (the page sends no position): the canopy opens by itself, Pilot and RiderA see it, and RiderC lands where
//    the server and both pages have it (1 m). Then Pilot jumps by E: the machine hangs where it was, RiderA takes the
//    stick; with the parachute rule off his E in the air asks nothing and the line says to land first; he lands it on
//    its pad. The jumpers' cameras ease from where they were (no snap into the eyes); pictures with --out.
// The boarders stand at four places round the cabin, two by the rear skids: someone standing there once threw a seated
// pilot's machine 2 m up (world/heli.ts env, shared/heli.mjs heliHeads); phase 1 checks it stays down. No page errors.
// Pictures with --out.
//
//   ADMIN_PASSWORD=... node tools/dev/heli_mp.mjs --url http://localhost:5737/ --api http://localhost:8613 \
//     --ports 9731,9732,9733,9734,9735,9736,9737 [--phases 1,2,3 | 4] [--out <folder>]
//
// It takes about ten minutes (six pages load, three flights, the 20 s waits).
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { PORTALS } from '../../web/shared/portals.mjs';
import { launch, localOnly, options } from './cdp.mjs';

const o = options({ url: 'http://localhost:5737/', api: 'http://localhost:8613', ports: '9731,9732,9733,9734,9735,9736,9737', phases: '1,2,3', out: '' });
localOnly(o.url, '--url');
localOnly(o.api); // it logs in as the admin, changes rules and starts games: a throwaway server on this computer only
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');
const ports = o.ports.split(',').map(Number);
const phases = new Set(o.phases.split(',').map(Number));
if (o.out) mkdirSync(o.out, { recursive: true });
const DATA = JSON.parse(readFileSync(new URL('../../web/shared/heli.json', import.meta.url), 'utf8'));
const PARK = Object.fromEntries(DATA.machines.map((m) => [m.id, m.park]));
const CRUISE = { house: PARK.church.y + 45, church: PARK.church.y + 60 }; // the two crews a level apart
const SQUARE = PORTALS.find((p) => p.id === 'church').out; // where you come out on the church square: [x, z, yaw]
const GARDEN = { x: 4.5, z: -6 }; // the house's garden start place, 37 m from its pad (shared/spawns.json)
let failed = 0;
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
  if (!pass) failed++;
};
const row = (what, got) => console.log(`     ${what}: ${got}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (v) => (Math.round(v * 100) / 100).toFixed(2);

// ---- The admin, over a socket of its own: the rules, the games, and where the server has everyone (its ticks).
const host = new URL(o.api).host;
const call = async (method, path, body) => {
  const r = await fetch(o.api + path, { method, headers: { 'Content-Type': 'application/json', Origin: o.api }, body: body ? JSON.stringify(body) : undefined });
  return { r, data: await r.json().catch(() => null) };
};
const login = await call('POST', '/api/login', { username: 'admin', password });
const cookie = login.r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const admin = { players: new Map(), helis: new Map(), heliMsgs: 0 };
admin.ws = new WebSocket(`ws://${host}/ws?v=2`, { headers: { Cookie: cookie, Origin: o.api } });
admin.ws.on('message', (d) => {
  const m = JSON.parse(String(d));
  if (m.t === 'ping') return admin.ws.send(JSON.stringify({ t: 'pong', n: m.n }));
  if (m.t === 's') for (const p of m.p ?? []) admin.players.set(String(p[0]).toLowerCase(), { x: p[2], y: p[3], z: p[4] });
  if (m.t === 'heli') {
    admin.heliMsgs++;
    admin.helis.set(m.heli.id, m.heli);
  }
  if (m.t === 'welcome') for (const h of m.helis ?? []) admin.helis.set(h.id, h);
});
await new Promise((res, rej) => (admin.ws.on('open', res), admin.ws.on('error', rej)));
admin.send = (m) => admin.ws.send(JSON.stringify(m));
await sleep(800);
admin.send({ t: 'rules', parachute: false, heli: true, travel: true }); // no drops: everyone starts on their feet

// ---- The pages.
const pages = [];
const CODES = { KeyE: ['e', 69], KeyI: ['i', 73], Space: [' ', 32] };
async function page(port, name, { spawn = 'house', phone = false, quality = 'low' } = {}) {
  const b = await launch({ port, width: 900, height: 506 });
  console.log(`${name}: browser PID ${b.pid}`);
  b.who = name;
  b.phone = phone;
  pages.push(b);
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('briel.graphics','${quality}');localStorage.setItem('briel.lang','en');localStorage.setItem('briel.spawn','${spawn}');localStorage.setItem('briel.playMode','explore');localStorage.setItem('briel.feedback','later');` });
  if (phone) {
    await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await b.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  }
  const url = new URL(o.url);
  url.searchParams.set('nobake', '');
  await b.send('Page.navigate', { url: url.href });
  const button = phone ? '#choose-touch' : '#choose-kbm';
  await b.waitFor(`!!document.querySelector('${button}')`);
  await b.sleep(6000); // the dev build attaches the start screen's handlers late
  await b.evaluate(`(() => {
    const n = document.querySelector('#nick'); n.value = '${name}'; n.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-mp=multi]').click();
    const age = document.querySelector('#mp-age'); if (!age.checked) age.click();
    document.querySelector('${button}').click();
  })()`, false);
  await b.waitFor('!!window.briel', 90000);
  await b.waitFor("(() => { const p = document.getElementById('start-panel'); if (!p || p.offsetParent === null) return true; const s = getComputedStyle(p); return s.visibility === 'hidden' || Number(s.opacity) < 0.05; })()", 240000);
  await b.waitFor('briel.helis.together && !!briel.combat.me', 60000);
  await b.evaluate("document.getElementById('cc-close')?.click()", false);
  // What the page sends (its helicopter asks; at the stick its states, the machine's pose at its time `ct`), every frame
  // where each machine is drawn and at what server time (net/track.ts netClock), the autopilot, slow frames.
  await b.evaluate(`(async () => {
    window.__nc = (await import('/src/net/track.ts')).netClock;
    window.__sent = []; window.__poses = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const m = JSON.parse(data);
        if (m.t === 'heli') window.__sent.push(m);
        if (m.t === 'state' && typeof m.hp === 'number' && window.__rec) window.__poses.push([m.ct + window.__nc.best, m.x, m.y, m.z]);
      } catch {}
      return send.call(this, data);
    };
    window.__rec = null;
    for (const m of briel.helis.machines) {
      const update = m.update, fly = m.fly;
      m.update = function (dt, eye) {
        update.call(this, dt, eye);
        const r = window.__rec;
        if (r) (r[this.spec.id] ??= []).push([performance.now(), this.flown ? NaN : window.__nc.time, this.s.x, this.s.y, this.s.z, this.seats.filter(Boolean).length]);
      };
      m.fly = function (dt, input, others) { return fly.call(this, dt, window.__ap && this.flown ? window.__apInput(this.s) : input, others); };
    }
    // The autopilot: up to its cruise, across to (x, z) turning to face it, slowing on the way in, then down onto it
    // (the pad's pull centres it); with \`hover\` it stays at the cruise height over the spot instead.
    window.__ap = null;
    window.__apInput = (s) => {
      const ap = window.__ap, clamp = (v, a = -1, b = 1) => Math.max(a, Math.min(b, v)), wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
      const dx = ap.x - s.x, dz = ap.z - s.z, d = Math.hypot(dx, dz);
      const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw), rx = -fz, rz = fx;
      if (s.ground && d < 4 && ap.landed) return {};
      if (s.rotor < 0.99 && s.ground) return { lift: 1 };
      const high = s.y > ap.cruise - 4;
      const v = high || d < 6 ? Math.min(47, d * 0.35) : 0;
      const wx = d > 0 ? (dx / d) * v : 0, wz = d > 0 ? (dz / d) * v : 0;
      const fwd = clamp((wx * fx + wz * fz) / 47), side = clamp((wx * rx + wz * rz) / 15);
      const turn = d > 25 ? clamp(-wrap(Math.atan2(-dx, -dz) - s.yaw) * 1.5) : 0;
      const speed = Math.hypot(s.vx, s.vz);
      let lift = clamp((ap.cruise - s.y) / 6);
      if (!ap.hover && d < 4 && speed < 2.5) lift = -1;
      if (s.ground && d < 4) ap.landed = true;
      return d < 4 ? { lift } : { fwd, side, turn, lift };
    };
    window.__slow = 0;
    const spin = () => { const t = performance.now(); while (window.__slow && performance.now() - t < window.__slow) {} requestAnimationFrame(spin); };
    requestAnimationFrame(spin);
    window.__M = (id) => briel.helis.machines.find((q) => q.spec.id === id);
  })()`);
  return b;
}
const key = (b, type, code) => b.send('Input.dispatchKeyEvent', { type, code, key: CODES[code][0], windowsVirtualKeyCode: CODES[code][1] });
const tap = async (b, code) => {
  await key(b, 'keyDown', code);
  await b.sleep(80);
  await key(b, 'keyUp', code);
};
/** A touch button (touch emulation): a tap on its middle; `cls` its class, or its text. */
const touch = async (b, cls) => {
  const at = await b.evaluate(`(() => { const e = [...document.querySelectorAll('#touch button, #touch .t-btn, #touch > *')].find((q) => q.classList.contains('${cls}') && q.offsetParent !== null); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (!at) return false;
  await b.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at[0], y: at[1], id: 3 }] });
  await b.sleep(120);
  await b.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  return true;
};
/** Use: E, or the phone's Use button. */
const use = (b) => (b.phone ? touch(b, 't-use') : tap(b, 'KeyE'));
const me = (b) => b.evaluate('briel.combat.me');
const aboard = (b) => b.evaluate('({ aboard: briel.helis.aboard, seat: briel.helis.seat, id: briel.helis.heli?.spec.id ?? null, piloting: briel.helis.piloting })');
const seatsOn = (b, id) => b.evaluate(`[...__M('${id}').seats]`);
const machine = (b, id) => b.evaluate(`(() => { const s = __M('${id}').s; return { x: s.x, y: s.y, z: s.z, yaw: s.yaw, ground: s.ground, rotor: s.rotor, h: s.h }; })()`);
const prompt = (b) => b.evaluate("document.getElementById('prompt')?.textContent ?? ''");
const chatText = (b) => b.evaluate("document.getElementById('chat-log')?.textContent ?? ''");
/** Where the server has `name` (the admin's ticks). */
const server = (name) => admin.players.get(String(name).toLowerCase());
const shot = async (b, file) => {
  if (o.out) await b.screenshot(join(o.out, `${file}.png`));
};

/** Beside machine `id` at place `slot` (0 to 3: right front, left front, right back, left back), until the server has it there too. */
async function besideIt(b, id, slot) {
  const at = await b.evaluate(`(() => {
    const s = __M('${id}').s, lx = ${slot % 2 ? -1 : 1} * ${DATA.size.skidX + 0.45}, lz = ${slot < 2 ? -1.4 : 0.4};
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw), rx = -fz, rz = fx;
    const x = s.x + rx * lx - fx * lz, z = s.z + rz * lx - fz * lz;
    briel.teleport(x, z, s.y + 0.3, Math.atan2(-(s.x - x), -(s.z - z)), -0.2);
    return { x, z, y: s.y };
  })()`);
  const name = await me(b);
  for (let i = 0; i < 60; i++) {
    const p = server(name);
    if (p && Math.hypot(p.x - at.x, p.z - at.z) < 0.6 && Math.abs(p.y - at.y) < 1) return true;
    await sleep(250);
  }
  return false;
}
/** In machine `id`, in seat `seat` as the server says: asked with Use beside it, again if needed. */
async function board(b, id, slot, seat) {
  await stopPilot(b);
  await besideIt(b, id, slot);
  for (let i = 0; i < 6; i++) {
    await use(b);
    for (let k = 0; k < 10; k++) {
      await sleep(200);
      const a = await aboard(b);
      if (a.aboard) return a.id === id && a.seat === seat;
    }
  }
  console.log(`     ${b.who} could not board:`, await diag(b, id));
  return false;
}
/** What a page has beside machine `id`, when something there did not work. */
const diag = async (b, id) => JSON.stringify(await b.evaluate(`(() => { const p = briel.player, m = __M('${id}'); return { alive: briel.combat.alive, together: briel.helis.together, near: !!briel.helis.near(p.x, p.z, p.feet), d: m.distanceTo(p.x, p.z), feet: p.feet, my: m.s.y, v: Math.hypot(m.s.vx, m.s.vy, m.s.vz), away: m.away, seats: m.seats, game: briel.games.view.kind, ball: !!briel.football.near(p.x, p.feet, p.z), ask: briel.askState(), target: !!briel.doors.lookedAt(briel.three.composer.passes.find((q) => q.camera?.isPerspectiveCamera).camera), prompt: document.getElementById('prompt')?.textContent, sent: window.__sent.slice(-3) }; })()`));
/** Flown by the autopilot to (x, z) (onto it unless `hover`), until it rests there or hangs over it; seconds taken. */
async function fly(b, to, cruise, { hover = false, secs = 120, during } = {}) {
  await b.evaluate(`window.__ap = ${JSON.stringify({ x: to.x, z: to.z, cruise, hover })}`);
  const t0 = Date.now();
  while (Date.now() - t0 < secs * 1000) {
    await sleep(500);
    const s = await b.evaluate('(() => { const h = briel.helis.heli; return h ? { x: h.s.x, y: h.s.y, z: h.s.z, ground: h.s.ground, v: Math.hypot(h.s.vx, h.s.vz) } : null; })()');
    await during?.((Date.now() - t0) / 1000, s);
    if (!s) return -1;
    const d = Math.hypot(s.x - to.x, s.z - to.z);
    if (hover ? d < 6 && s.v < 1.5 && Math.abs(s.y - cruise) < 3 : s.ground && d < 4) {
      if (!hover) await stopPilot(b);
      return (Date.now() - t0) / 1000;
    }
  }
  await stopPilot(b);
  return -1;
}
const stopPilot = (b) => b.evaluate('window.__ap = null');
const record = (bs, on) => Promise.all(bs.map((b) => b.evaluate(on ? 'window.__rec = {}; window.__poses = [];' : 'window.__rec')));
/** The pilot's pose at server time `t` (its states as sent, in between linearly), or null outside them. */
const truthAt = (poses, t) => {
  for (let i = 1; i < poses.length; i++) {
    if (poses[i][0] < t) continue;
    const [ta, ...a] = poses[i - 1], [tb, ...b] = poses[i];
    if (ta > t) return null;
    const f = tb > ta ? (t - ta) / (tb - ta) : 0;
    return a.map((v, j) => v + (b[j] - v) * f);
  }
  return null;
};
/** How far a page's drawn machine was from where its pilot had it at the same server time, while it went faster than `fast` m/s. */
function agreement(rec, poses, fast = 30) {
  const errs = [];
  for (let i = 1; i < rec.length; i++) {
    const [w0, , x0, , z0] = rec[i - 1], [w, t, x, y, z] = rec[i];
    const speed = Math.hypot(x - x0, z - z0) / Math.max(1e-3, (w - w0) / 1000);
    const truth = truthAt(poses, t);
    if (truth && speed > fast) errs.push(Math.hypot(x - truth[0], y - truth[1], z - truth[2]));
  }
  errs.sort((a, b) => a - b);
  return { n: errs.length, p95: errs[Math.floor(errs.length * 0.95)] ?? NaN, max: errs.at(-1) ?? NaN };
}
/** Smoothness of a drawn path: each frame against where the two before it led (constant speed), and any step back. */
function smoothness(rec, from = 0) {
  let jump = 0, back = 0, n = 0, worst = null;
  const dts = [];
  for (let i = from + 2; i < rec.length; i++) {
    // On the time each frame drew it at (the server's clock, set as the frame begins: net/track.ts), not when this
    // record was taken later in the frame; the pilot's own on the page's clock.
    const at = (q) => (Number.isFinite(q[1]) ? q[1] : q[0]);
    const [xa, ya, za] = rec[i - 2].slice(2), [xb, yb, zb] = rec[i - 1].slice(2), [xc, yc, zc] = rec[i].slice(2);
    const wa = at(rec[i - 2]), wb = at(rec[i - 1]), wc = at(rec[i]);
    const k = (wc - wb) / Math.max(1e-3, wb - wa);
    const px = xb + (xb - xa) * k, py = yb + (yb - ya) * k, pz = zb + (zb - za) * k;
    const off = Math.hypot(xc - px, yc - py, zc - pz);
    if (off > jump) worst = { at: r2((wc - at(rec[from])) / 1000), ms: [r2(wb - wa), r2(wc - wb)], speed: r2(Math.hypot(xb - xa, zb - za) / Math.max(1e-3, (wb - wa) / 1000)), y: r2(yc) };
    jump = Math.max(jump, off);
    const dot = (xc - xb) * (xb - xa) + (zc - zb) * (zb - za);
    const len = Math.hypot(xb - xa, zb - za);
    if (len > 0.05 && dot < 0) back = Math.max(back, -dot / len);
    dts.push(wc - wb);
    n++;
  }
  dts.sort((a, b) => a - b);
  return { n, jump, back, frame: dts[Math.floor(dts.length / 2)] ?? NaN, worst: JSON.stringify(worst) };
}
/** What page `b` shows of `name`: seated (its figure at its seat, its hit boxes hidden), its name tag over that seat. */
const seen = (b, name) => b.evaluate(`(() => {
  const n = [...briel.avatars.avatars.keys()].find((k) => k.toLowerCase() === '${name}'.toLowerCase());
  const a = n && briel.avatars.avatars.get(n);
  if (!a) return null;
  const seat = briel.heliPeople.seat(n);
  const V = a.root.position.constructor;
  const at = a.body.root.getWorldPosition(new V()), tag = a.tag.getWorldPosition(new V());
  return { seat: !!seat, shown: a.root.visible && a.body.root.visible, gap: seat ? at.distanceTo(new V(seat.root?.x ?? seat.x, seat.root?.y ?? seat.y, seat.root?.z ?? seat.z)) : null,
    tag: a.tag.visible, tagOver: seat ? Math.hypot(tag.x - seat.x, tag.z - seat.z) : null, hits: a.body.hits.some((h) => h.visible) };
})()`);
/** Errors a page logged (none expected). */
const errors = (b) => b.logs.filter((l) => /^(error|exception)/.test(l) && !/Failed to load resource|WebSocket/.test(l));

const tag = Math.random().toString(36).slice(2, 5);
try {
  const solo5 = phases.size === 1 && phases.has(5); // the jump together on its own: three pages
  const P = await page(ports[0], `Pilot${tag}`);
  const A = await page(ports[1], `RiderA${tag}`);
  const B = solo5 ? null : await page(ports[2], `RiderB${tag}`);
  const C = await page(ports[3], `RiderC${tag}`, { phone: true });
  const Q = solo5 ? null : await page(ports[4], `Fifth${tag}`);
  const W = solo5 ? null : await page(ports[5], `Watcher${tag}`, { spawn: 'church', quality: 'medium' });
  const crew = [P, A, B, C].filter(Boolean);
  const names = {};
  for (const b of pages) names[b.who] = await me(b);
  console.log('names:', JSON.stringify(names));
  await Promise.all(pages.map((b) => b.waitFor("briel.village() === 'ready'", 240000)));
  const programs = {};
  for (const b of crew) programs[b.who] = await b.evaluate('(window.__progs = new Set(briel.three.renderer.info.programs.map((p) => p.id))).size');

  if (phases.has(1)) {
    console.log('-- 1. four aboard the house\'s machine, a fifth refused; two crews, each to the other\'s pad');
    for (const [i, b] of crew.entries()) {
      if (i === 2) {
        // Someone by the rear skid of a machine with its pilot seated: it stays where it stands, on every page.
        const before = await machine(P, 'house');
        await besideIt(B, 'house', 2);
        await sleep(2000);
        const on = await Promise.all([P, A, B].map((q) => machine(q, 'house')));
        const line = await prompt(B);
        ok('a boarder by the rear skid lifts nothing', on.every((m) => m.ground && Math.abs(m.y - before.y) < 0.05) && /Ride along/.test(line), `${on.map((m) => r2(m.y - before.y)).join(', ')} m, "${line}"`);
      }
      ok(`${b.who} boards: seat ${i}`, await board(b, 'house', i, i), JSON.stringify(await aboard(b)));
    }
    const want = crew.map((b) => names[b.who]);
    for (const b of pages) ok(`${b.who} sees the four in their seats`, JSON.stringify(await seatsOn(b, 'house')) === JSON.stringify(want), JSON.stringify(await seatsOn(b, 'house')));
    await besideIt(Q, 'house', 0);
    await sleep(600);
    const full = await prompt(Q);
    Q.evaluate('window.__sent.length = 0', false);
    await use(Q);
    await sleep(1500);
    const asked = await Q.evaluate('window.__sent.length');
    ok('the fifth: the line says it is full, Use asks nothing, no seat', /full/i.test(full) && asked === 0 && !(await aboard(Q)).aboard, `"${full}", ${asked} sent`);
    await sleep(1500);
    for (const n of want.slice(1)) {
      const s = await seen(Q, n);
      ok(`the fifth sees ${n} seated, the name over the machine`, s?.seat && s.shown && s.gap < 0.15 && s.tag && s.tagOver < 0.8 && !s.hits, JSON.stringify(s));
    }
    {
      const s = await seen(A, want[0]);
      ok('RiderA sees the pilot seated', s?.seat && s.shown && s.gap < 0.15, JSON.stringify(s));
    }
    await shot(Q, '1_four_aboard_fifth');
    await shot(A, '1_four_aboard_riderA');
    await shot(C, '1_four_aboard_riderC_phone');
    for (const b of crew) {
      const fresh = await b.evaluate('briel.three.renderer.info.programs.filter((p) => !__progs.has(p.id)).map((p) => p.name || p.cacheKey.slice(0, 60)).join(" | ")');
      ok(`${b.who}: no new shader program at boarding`, fresh === '', fresh);
    }

    // The fifth goes to the church and takes its machine, Watcher rides along.
    await Q.evaluate("briel.travel('church')", false);
    await sleep(6000);
    ok('the fifth flies the church\'s machine', await board(Q, 'church', 0, 0), JSON.stringify(await aboard(Q)));
    ok('Watcher rides along in it', await board(W, 'church', 1, 1), JSON.stringify(await aboard(W)));

    await record(pages, true);
    let progs = false;
    const flights = Promise.all([
      fly(P, PARK.church, CRUISE.house, { during: async (t) => {
        if (t > 8 && !progs && (progs = true)) for (const b of crew) {
          const fresh = await b.evaluate('briel.three.renderer.info.programs.filter((p) => !__progs.has(p.id)).map((p) => p.name || p.cacheKey.slice(0, 60)).join(" | ")');
          ok(`${b.who}: no new shader program at the take-off`, fresh === '', fresh);
        }
        if (t > 14 && t < 14.6) await Promise.all([shot(A, '1_cruise_riderA'), shot(W, '1_cruise_watcher')]);
      } }),
      fly(Q, PARK.house, CRUISE.church),
    ]);
    const [t1, t2] = await flights;
    ok('the house\'s machine landed on the church\'s deck', t1 > 0, `${t1.toFixed(1)} s`);
    ok('the church\'s machine landed on the house\'s pad', t2 > 0, `${t2.toFixed(1)} s`);
    const recs = Object.fromEntries(await Promise.all(pages.map(async (b) => [b.who, await b.evaluate('window.__rec')])));
    const poses = { house: await P.evaluate('window.__poses'), church: await Q.evaluate('window.__poses') };
    await record(pages, false);
    for (const b of [A, B, C]) {
      const g = agreement(recs[b.who].house, poses.house);
      ok(`${b.who} draws the machine where the pilot had it (over 30 m/s)`, g.n > 50 && g.p95 < 0.5, `${g.n} frames, p95 ${r2(g.p95)} m, worst ${r2(g.max)} m`);
    }
    {
      const g = agreement(recs[W.who].church, poses.church);
      ok('Watcher draws the church\'s machine where the fifth had it', g.n > 50 && g.p95 < 0.5, `${g.n} frames, p95 ${r2(g.p95)} m, worst ${r2(g.max)} m`);
      const sm = smoothness(recs[A.who].house);
      row('RiderA\'s machine frame to frame', `${sm.n} frames of ${r2(sm.frame)} ms: worst ${r2(sm.jump)} m off its way, back ${r2(sm.back)} m; the worst ${sm.worst}`);
    }
    for (const b of pages) {
      const h = await machine(b, 'house'), c = await machine(b, 'church');
      ok(`${b.who}: each machine on the other's pad`, Math.hypot(h.x - PARK.church.x, h.z - PARK.church.z) < 3 && Math.hypot(c.x - PARK.house.x, c.z - PARK.house.z) < 3, `house (${r2(h.x)}, ${r2(h.z)}), church (${r2(c.x)}, ${r2(c.z)})`);
    }
    await shot(P, '1_landed_on_deck_pilot');
    await shot(W, '1_landed_house_watcher');
    for (const b of [...crew, Q, W]) {
      await use(b);
      await sleep(900);
      ok(`${b.who} gets out`, !(await aboard(b)).aboard);
    }
    await sleep(800);
    for (const b of pages) ok(`${b.who}: both machines empty`, (await seatsOn(b, 'house')).every((n) => !n) && (await seatsOn(b, 'church')).every((n) => !n));
    // Off the pads, so they can go home: down to the church square, or to the house's garden.
    for (const [i, b] of crew.entries()) await b.evaluate(`briel.teleport(${SQUARE[0] + i * 1.5}, ${SQUARE[1]}, ${PARK.church.y}, 0)`, false);
    for (const [i, b] of [Q, W].entries()) await b.evaluate(`briel.teleport(${GARDEN.x + i * 1.5}, ${GARDEN.z}, ${PARK.house.y + 0.5}, 0)`, false);
    let home = false;
    for (let i = 0; i < 80 && !home; i++) {
      await sleep(500);
      const h = admin.helis.get('house'), c = admin.helis.get('church');
      home = h && c && Math.hypot(h.x - PARK.house.x, h.z - PARK.house.z) < 1 && Math.hypot(c.x - PARK.church.x, c.z - PARK.church.z) < 1;
    }
    ok('20 s empty on each other\'s pads: both back on their own (they swap)', home);
    await sleep(800);
    for (const b of pages) {
      const h = await machine(b, 'house'), c = await machine(b, 'church');
      ok(`${b.who}: both on their own pads`, Math.hypot(h.x - PARK.house.x, h.z - PARK.house.z) < 1 && Math.hypot(c.x - PARK.church.x, c.z - PARK.church.z) < 1 && h.ground && c.ground);
    }
  }

  if (phases.has(2)) {
    console.log('-- 2. the church\'s machine to the house past a watcher, slow frames at the stick, a late joiner, a game in the air');
    if (!phases.has(1)) {
      // On its own: the four to the church, the watcher to the house (by the chat, as anyone would).
      for (const b of crew) await b.evaluate("briel.travel('church')", false);
      await W.evaluate("briel.travel('house')", false);
      await sleep(8000);
    }
    // Watcher waits by the house, 37 m from where the machine will hang; the fifth's page closes (a late joiner comes instead).
    await W.evaluate(`briel.teleport(${GARDEN.x}, ${GARDEN.z}, ${PARK.house.y + 0.5}, ${Math.PI / 2}, 0.5)`, false); // looking west, up at the pad
    if (pages.includes(Q)) {
      Q.close();
      pages.splice(pages.indexOf(Q), 1);
    }
    for (const [i, b] of crew.entries()) ok(`${b.who} boards the church's machine: seat ${i}`, await board(b, 'church', i, i), JSON.stringify(await aboard(b)));
    await tap(A, 'KeyI');
    await sleep(600);
    const view = await A.evaluate(`(() => { const m = __M('church'), cam = briel.three.composer.passes.find((q) => q.camera?.isPerspectiveCamera).camera, V = cam.position.constructor; const seat = m.seatPoint(1).clone(); seat.y += 0.76; m.group.updateMatrixWorld(true); const at = seat.applyMatrix4(m.group.children[0].matrixWorld); return { view: m.view, off: cam.position.distanceTo(at) }; })()`);
    ok('RiderA\'s view key: from his own seat', view.view === 'cockpit' && view.off < 0.05, JSON.stringify(view));
    await shot(A, '2_seat_view_riderA');
    await tap(A, 'KeyI');
    await sleep(300);
    ok('and back behind it', (await A.evaluate("__M('church').view")) === 'chase');
    if (C.phone) {
      const t = await C.evaluate("({ layout: document.body.dataset.touch, use: !!document.querySelector('#touch .t-use') })");
      ok('RiderC (a phone): the helicopter\'s touch layout', t.layout === 'heli' && t.use, JSON.stringify(t));
    }
    await record(pages, true);
    const over = { x: PARK.house.x, z: PARK.house.z };
    const slow = { done: new Set() };
    // The pilot's frames: 30 a second from 4 s, 250 ms from 9 s, as usual again from 13 s (far out still: the watcher's
    // part of the flight, its last 400 m, is flown at the usual rate). Each switch noted on the server's clock.
    const mark = (ms) => P.evaluate(`(window.__slow = ${ms}, (window.__marks ??= []).push(performance.now() + __nc.best))`);
    let fast = 0;
    const t = await fly(P, over, PARK.house.y + 40, { hover: true, during: async (s, q) => {
      if (!fast && q?.v > 40) fast = s; // at cruise speed: 4 s at 30 frames a second, 3 s at 250 ms frames
      if (fast && s > fast && !slow.done.has(30)) {
        slow.done.add(30);
        await mark(22);
      }
      if (fast && s > fast + 4 && !slow.done.has(250)) {
        slow.done.add(250);
        await mark(245);
      }
      if (fast && s > fast + 7 && !slow.done.has(0)) {
        slow.done.add(0);
        await mark(0);
      }
    } });
    await P.evaluate('window.__slow = 0');
    const marks = await P.evaluate('window.__marks ?? []');
    ok('the church\'s machine hangs over the house', t > 0, `${t.toFixed(1)} s`);
    const recs = Object.fromEntries(await Promise.all(pages.map(async (b) => [b.who, await b.evaluate('window.__rec')])));
    const poses = await P.evaluate('window.__poses');
    await record(pages, false);
    {
      const own = recs[P.who].church;
      const fr = (a, b) => {
        const d = [];
        for (let i = 1; i < own.length; i++) if (own[i][0] - own[0][0] > a * 1000 && own[i][0] - own[0][0] < b * 1000) d.push(own[i][0] - own[i - 1][0]);
        d.sort((x, y) => x - y);
        return d[Math.floor(d.length / 2)] ?? NaN;
      };
      row('the pilot\'s frames', `${r2(fr(fast - 3, fast))} ms, then ${r2(fr(fast + 0.5, fast + 4))} ms (about 30 a second), then ${r2(fr(fast + 4.5, fast + 7))} ms, then ${r2(fr(fast + 8, fast + 14))} ms`);
      const [m30, m250, m0] = marks;
      const part = (rec, a, b) => rec.filter((q) => q[1] >= a && q[1] < b);
      for (const b of [A, B, C, W]) {
        const rec = recs[b.who].church;
        for (const [what, a, z, limit] of [['usual frames', -Infinity, m30, 0.5], ['30 frames a second', m30, m250, 0.5], ['250 ms frames', m250, m0, 99], ['usual again', m0 + 1500, Infinity, 0.5]]) {
          const g = agreement(part(rec, a, z), poses);
          // With 250 ms frames at the stick its states come four a second: net/track.ts carries a thing on past its
          // newest state only while they come at most 250 ms apart, so it is drawn behind and then catches up (as a
          // car whose driver has such frames). Reported, not held to the 0.5 m.
          if (limit > 1) row(`${b.who} at the pilot's ${what}`, `${g.n} frames, p95 ${r2(g.p95)} m, worst ${r2(g.max)} m`);
          else ok(`${b.who} draws the machine where the pilot had it (over 30 m/s), the pilot at ${what}`, g.n > 10 && g.p95 < limit, `${g.n} frames, p95 ${r2(g.p95)} m, worst ${r2(g.max)} m`);
        }
      }
      const w = recs[W.who].church;
      const near = w.filter((q) => Math.hypot(q[2] - GARDEN.x, q[4] - GARDEN.z) < 400 && q[1] > m0 + 1500); // drawn from 400 m
      const sm = smoothness(near);
      ok('Watcher on the ground: it flies in smoothly (no jump over 0.5 m from where its last frames led, never back)', sm.n > 100 && sm.jump < 0.5 && sm.back < 0.05, `${sm.n} frames of ${r2(sm.frame)} ms: worst ${r2(sm.jump)} m off its way, back ${r2(sm.back)} m; the worst ${sm.worst}`);
      const slowPart = smoothness(part(w, m250, m0 + 1500));
      row('Watcher while the pilot had 250 ms frames (far off)', `${slowPart.n} frames: worst ${r2(slowPart.jump)} m off its way, back ${r2(slowPart.back)} m`);
    }
    await sleep(1500);
    for (const n of crew.map((b) => names[b.who])) {
      const s = await seen(W, n);
      ok(`Watcher sees ${n} seated, the name over the machine`, s?.seat && s.shown && s.gap < 0.15 && s.tag && s.tagOver < 0.8, JSON.stringify(s));
    }
    await shot(W, '2_hanging_over_house_watcher');
    // A page that joins now.
    const L = await page(ports[6], `Late${tag}`, { quality: 'medium' });
    names[L.who] = await me(L);
    await L.evaluate(`briel.teleport(${GARDEN.x}, ${GARDEN.z + 2}, ${PARK.house.y + 0.5}, ${Math.PI / 2}, 0.5)`, false);
    await sleep(3000);
    {
      const m = await machine(L, 'church'), p = await machine(P, 'church');
      const seats = await seatsOn(L, 'church');
      ok('the late joiner sees it hanging where it is, with the four in their seats', Math.hypot(m.x - p.x, m.y - p.y, m.z - p.z) < 1 && !m.ground && JSON.stringify(seats) === JSON.stringify(crew.map((b) => names[b.who])), `${r2(Math.hypot(m.x - p.x, m.y - p.y, m.z - p.z))} m from the pilot's, ${JSON.stringify(seats)}`);
      for (const n of crew.map((b) => names[b.who])) {
        const s = await seen(L, n);
        ok(`the late joiner sees ${n} seated`, s?.seat && s.shown && s.gap < 0.15 && s.tag, JSON.stringify(s));
      }
      await shot(L, '2_late_joiner');
    }
    // A party game, started by the admin with the machine in the air.
    admin.send({ t: 'mode', kind: 'treasure' });
    await sleep(2500);
    for (const b of crew) ok(`${b.who}: a game starting puts you out`, !(await aboard(b)).aboard);
    for (const b of [P, A]) ok(`${b.who}: the chat says it went home`, /went back to its pad/.test(await chatText(b)));
    for (const b of [W, L]) {
      const c = await machine(b, 'church');
      ok(`${b.who}: the church's machine is home`, Math.hypot(c.x - PARK.church.x, c.z - PARK.church.z) < 1 && c.ground && (await seatsOn(b, 'church')).every((n) => !n));
    }
    admin.send({ t: 'mode', kind: 'free' });
    await sleep(3000);
  }

  if (phases.has(3)) {
    console.log('-- 3. the stick taken, a passenger and then the pilot gone in the air, the rule off, Zombies');
    const others = pages.filter((b) => !crew.includes(b));
    for (const [i, b] of crew.entries()) ok(`${b.who} boards the house's machine: seat ${i}`, await board(b, 'house', i, i), JSON.stringify(await aboard(b)));
    await use(P);
    await sleep(1200);
    if ((await aboard(P)).aboard) console.log('     the pilot is still aboard:', await diag(P, 'house'), JSON.stringify(await P.evaluate("({ rest: __M('house').atRest, exit: __M('house').exitSpot(), active: document.activeElement?.tagName + '#' + (document.activeElement?.id ?? ''), menu: briel.askState() })")));
    ok('the pilot gets out on the ground', !(await aboard(P)).aboard);
    const line = await prompt(A);
    ok('RiderA\'s line: nobody flies, the up key flies it', /Nobody is flying/.test(line), `"${line}"`);
    await tap(A, 'Space');
    await sleep(1500);
    const a = await aboard(A);
    ok('RiderA takes the stick', a.aboard && a.seat === 0 && a.piloting, JSON.stringify(a));
    ok('the pilot boards again, into the seat freed', await board(P, 'house', 1, 1), JSON.stringify(await aboard(P)));
    for (const b of pages) {
      const s = await seatsOn(b, 'house');
      ok(`${b.who} sees the new seats`, s[0] === names[A.who] && s[1] === names[P.who] && s[2] === names[B.who] && s[3] === names[C.who], JSON.stringify(s));
    }
    const h0 = await machine(A, 'house');
    const t = await fly(A, h0, h0.y + 40, { hover: true, secs: 40 });
    ok('RiderA lifts off and hangs 40 m up', t > 0, `${t.toFixed(1)} s`);
    // A passenger's page closes.
    B.close();
    pages.splice(pages.indexOf(B), 1);
    await sleep(2500);
    for (const b of pages) ok(`${b.who}: RiderB's seat empties`, (await seatsOn(b, 'house'))[2] === null);
    // Then the pilot's.
    const hang = await machine(P, 'house');
    A.close();
    pages.splice(pages.indexOf(A), 1);
    await sleep(4000);
    for (const b of pages) {
      const m = await machine(b, 'house');
      ok(`${b.who}: with nobody at the stick it hangs still`, Math.hypot(m.x - hang.x, m.y - hang.y, m.z - hang.z) < 1 && !m.ground && (await seatsOn(b, 'house'))[0] === null, `${r2(Math.hypot(m.x - hang.x, m.y - hang.y, m.z - hang.z))} m`);
    }
    for (const b of [P, C]) ok(`${b.who}: the line says nobody flies`, /Nobody is flying/.test(await prompt(b)), `"${await prompt(b)}"`);
    await shot(C, '3_nobody_flies_riderC_phone');
    let out = false;
    for (let i = 0; i < 60 && !out; i++) {
      await sleep(500);
      out = !(await aboard(P)).aboard && !(await aboard(C)).aboard;
    }
    ok('after 20 s without a pilot the two aboard are put out', out);
    await sleep(2500);
    for (const b of [P, C]) ok(`${b.who}: the chat says it went home`, /went back to its pad/.test(await chatText(b)));
    for (const b of pages) {
      const m = await machine(b, 'house');
      ok(`${b.who}: the house's machine on its pad`, Math.hypot(m.x - PARK.house.x, m.z - PARK.house.z) < 1 && m.ground);
    }
    for (const b of [P, C]) {
      const p = await b.evaluate('({ feet: briel.player.feet, ground: briel.world.groundAt(briel.player.x, briel.player.z, briel.player.feet + 0.2, 0).y })');
      ok(`${b.who}: on the ground after the fall`, Math.abs(p.feet - p.ground) < 0.3, JSON.stringify(p));
    }
    // The admin's rule off.
    admin.send({ t: 'rules', heli: false });
    await sleep(800);
    await besideIt(P, 'house', 0);
    await sleep(500);
    await P.evaluate('window.__sent.length = 0', false);
    const off = await prompt(P);
    await use(P);
    await sleep(1200);
    ok('the rule off: the line says so, Use asks nothing', /switched off/.test(off) && (await P.evaluate('window.__sent.length')) === 0 && !(await aboard(P)).aboard, `"${off}"`);
    ok('and the chat says it was turned off', /the helicopter off/.test(await chatText(P)));
    admin.send({ t: 'rules', heli: true });
    await sleep(800);
    // Zombies started in the air.
    ok('the pilot boards again', await board(P, 'house', 0, 0));
    ok('RiderC boards again (the phone)', await board(C, 'house', 1, 1));
    const z = await machine(P, 'house');
    ok('up 30 m', (await fly(P, z, z.y + 30, { hover: true, secs: 40 })) > 0);
    admin.send({ t: 'mode', kind: 'zombies', place: 'house' });
    await sleep(3000);
    for (const b of [P, C]) ok(`${b.who}: Zombies starting puts you out`, !(await aboard(b)).aboard);
    for (const b of pages) {
      const m = await machine(b, 'house');
      ok(`${b.who}: the machine home`, Math.hypot(m.x - PARK.house.x, m.z - PARK.house.z) < 1 && m.ground);
    }
    admin.send({ t: 'mode', kind: 'free' });
    await sleep(2000);
  }

  if (phases.has(4) && phases.size === 1) {
    // The cost of a full machine drawn from the server (four aboard, hanging 12 m over the house's pad) and of the same
    // machine parked empty there (what a watcher had before), each against the same view without it (the machine and
    // the figures in it hidden for the frames measured): briel.bench, alternated, the chip shared with other agents.
    console.log('-- 4. frame time with a full machine in view, on Medium and Low (the watcher, 37 m off)');
    const med = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
    const view = async (aloft) => W.evaluate(`(() => { const x = ${GARDEN.x}, z = ${GARDEN.z}, m = __M('house'), dx = m.s.x - x, dz = m.s.z - z; briel.teleport(x, z, ${PARK.house.y}, Math.atan2(-dx, -dz), Math.atan2(${aloft ? 13 : 1} - 1.6, Math.hypot(dx, dz))); })()`, false);
    const hide = (names, on) => W.evaluate(`(() => { __M('house').group.visible = ${!on}; for (const n of ${JSON.stringify(names)}) { const k = [...briel.avatars.avatars.keys()].find((q) => q.toLowerCase() === n); if (k) briel.avatars.avatars.get(k).root.visible = ${!on}; } })()`, false);
    const cost = async (names, aloft, what) => {
      for (const q of ['medium', 'low']) {
        await W.evaluate(`(briel.three.holdQuality(true), briel.three.applyQuality('${q}'))`, false);
        await view(aloft);
        await sleep(1500);
        await W.evaluate('briel.bench(60)'); // warm-up
        const a = [], b = [];
        for (let i = 0; i < 6; i++) {
          a.push((await W.evaluate('briel.bench(90)')).msPerFrame);
          await hide(names, true);
          b.push((await W.evaluate('briel.bench(90)')).msPerFrame);
          await hide(names, false);
        }
        const draws = await W.evaluate("(briel.three.renderer.render(briel.three.scene, briel.three.composer.passes.find((q) => q.camera?.isPerspectiveCamera).camera), { heli: __M('house').draws(), calls: briel.three.renderer.info.render.calls })");
        row(`${what}, ${q}`, `${r2(med(a))} ms with it against ${r2(med(b))} ms without (+${r2(med(a) - med(b))}), six pairs; the machine ${draws.heli} draws`);
      }
      await W.evaluate("(briel.three.applyQuality('medium'), briel.three.holdQuality(false))", false);
    };
    for (const [i, b] of crew.entries()) ok(`${b.who} boards: seat ${i}`, await board(b, 'house', i, i));
    const h0 = await machine(P, 'house');
    ok('up 12 m over the pad', (await fly(P, h0, h0.y + 12, { hover: true, secs: 40 })) > 0);
    await cost(crew.map((b) => names[b.who]), true, 'four aboard, hanging 12 m up');
    row('the flown machine on the pilot\'s page', `${await P.evaluate("__M('house').draws()")} draws`);
    await P.evaluate(`window.__ap = ${JSON.stringify({ x: PARK.house.x, z: PARK.house.z, cruise: PARK.house.y + 12 })}`);
    for (let i = 0; i < 60 && !(await machine(P, 'house')).ground; i++) await sleep(500);
    await stopPilot(P);
    for (const b of crew) await use(b);
    await sleep(2000);
    for (const [i, b] of crew.entries()) await b.evaluate(`briel.teleport(${GARDEN.x + 3 + i}, ${GARDEN.z + 4}, ${PARK.house.y + 0.5}, 0)`, false);
    await sleep(9000); // its rotor run down
    await cost([], false, 'parked empty on its pad');
  }

  if (phases.has(5)) {
    console.log('-- 5. the jump together: RiderC (the phone) jumps by its Use button, then the pilot by E; RiderA takes the stick');
    admin.send({ t: 'rules', parachute: true });
    await sleep(800);
    const three = [P, A, C];
    /** How page `b` draws `name`: where its figure is, under a parachute or not, its canopy out or not. */
    const figure = (b, name) => b.evaluate(`(() => {
      const k = [...briel.avatars.avatars.keys()].find((q) => q.toLowerCase() === '${name}'.toLowerCase());
      if (!k) return null;
      const p = briel.avatars.avatars.get(k).root.getWorldPosition(new (briel.avatars.avatars.get(k).root.position.constructor)());
      const f = briel.parachutes.flights.get(k);
      return { x: p.x, y: p.y, z: p.z, chute: !!f && f.phase !== 'land', open: !!f && f.openT !== null };
    })()`);
    const own = (b) => b.evaluate('({ x: briel.player.x, z: briel.player.z, feet: briel.player.feet, chute: briel.player.chute, canopy: briel.player.canopy, aboard: briel.helis.aboard })');
    ok('Pilot boards: seat 0', await board(P, 'house', 0, 0));
    ok('RiderC boards (the phone): seat 1', await board(C, 'house', 1, 1));
    ok('RiderA boards: seat 2', await board(A, 'house', 2, 2));
    const h0 = await machine(P, 'house');
    const lines = new Set();
    const t = await fly(P, h0, h0.y + 60, { hover: true, secs: 60, during: async () => lines.add(await prompt(A)) });
    ok('up 60 m over the pad', t > 0, `${t.toFixed(1)} s`);
    ok('RiderA\'s line in the air says Use jumps', [...lines].some((l) => /Jump/.test(l)), JSON.stringify([...lines]));
    ok('RiderC\'s (the phone) shows no keys', !/Jump/.test(await prompt(C)), `"${await prompt(C)}"`);
    /** The camera's place every frame for `n` frames from now: its largest step from one frame to the next (a snap into the eyes is metres). */
    const filmCam = (b, n = 90) => b.evaluate(`(() => { window.__cams = []; const c = briel.three.composer.passes.find((q) => q.camera?.isPerspectiveCamera).camera;
      const f = () => { window.__cams.push([c.position.x, c.position.y, c.position.z]); if (window.__cams.length < ${n}) requestAnimationFrame(f); }; requestAnimationFrame(f); })()`, false);
    const camStep = (b) => b.evaluate('(() => { let most = 0; const v = window.__cams; for (let i = 1; i < v.length; i++) most = Math.max(most, Math.hypot(v[i][0] - v[i - 1][0], v[i][1] - v[i - 1][1], v[i][2] - v[i - 1][2])); return { most, frames: v.length }; })()');
    await C.evaluate('window.__sent.length = 0', false);
    await filmCam(C);
    await use(C);
    await sleep(250);
    await shot(C, '5_riderC_just_jumped');
    await sleep(350);
    ok('the phone\'s Use asks the jump, with no position', JSON.stringify(await C.evaluate('window.__sent')) === JSON.stringify([{ t: 'heli', op: 'jump' }]), JSON.stringify(await C.evaluate('window.__sent')));
    const c0 = await own(C);
    ok('RiderC is out and in a drop from where the server had the machine', !c0.aboard && c0.chute !== null, JSON.stringify(c0));
    await sleep(1500);
    const cc = await camStep(C);
    ok('RiderC\'s camera eases from where it was, no snap into the eyes (largest step a frame under 2 m)', cc.most < 2, `${r2(cc.most)} m over ${cc.frames} frames`);
    await sleep(1000);
    for (const b of [P, A]) {
      const f = await figure(b, names[C.who]);
      ok(`${b.who} sees RiderC under an open canopy`, !!f && f.chute && f.open, JSON.stringify(f));
    }
    ok('RiderC\'s own canopy is out (by itself)', (await own(C)).canopy !== null);
    await shot(A, '5_riderC_canopy_from_riderA');
    let c1 = null;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      c1 = await own(C);
      if (c1.chute === null) break;
    }
    ok('RiderC lands', c1?.chute === null, JSON.stringify(c1));
    await sleep(1500);
    const sv = server(names[C.who]);
    ok('the server has RiderC where it landed (1 m)', !!sv && Math.hypot(sv.x - c1.x, sv.z - c1.z) < 1, sv && `${r2(Math.hypot(sv.x - c1.x, sv.z - c1.z))} m`);
    for (const b of [P, A]) {
      const f = await figure(b, names[C.who]);
      ok(`${b.who} sees RiderC land where RiderC's page has it (1 m)`, !!f && Math.hypot(f.x - c1.x, f.z - c1.z) < 1, f && `${r2(Math.hypot(f.x - c1.x, f.z - c1.z))} m`);
    }
    // The pilot jumps: the machine hangs where it was; RiderA takes the stick and flies it home.
    const hang = await machine(A, 'house');
    await filmCam(P);
    await tap(P, 'KeyE');
    await sleep(250);
    await shot(P, '5_pilot_just_jumped');
    await sleep(1250);
    const p0 = await own(P);
    ok('the pilot is out and in a drop', !p0.aboard && p0.chute !== null, JSON.stringify(p0));
    const pc = await camStep(P);
    ok('the pilot\'s camera eases from the chase view, no snap (largest step a frame under 2 m)', pc.most < 2, `${r2(pc.most)} m over ${pc.frames} frames`);
    await stopPilot(P);
    const m1 = await machine(A, 'house');
    ok('RiderA: the machine hangs where it was, nobody at the stick', Math.hypot(m1.x - hang.x, m1.y - hang.y, m1.z - hang.z) < 1 && (await seatsOn(A, 'house'))[0] === null, `${r2(Math.hypot(m1.x - hang.x, m1.y - hang.y, m1.z - hang.z))} m`);
    ok('RiderA\'s line: nobody flies', /Nobody is flying/.test(await prompt(A)), `"${await prompt(A)}"`);
    await tap(A, 'Space');
    await sleep(1500);
    const a = await aboard(A);
    ok('RiderA takes the stick', a.aboard && a.seat === 0 && a.piloting, JSON.stringify(a));
    // The admin's parachute rule off: E in the air asks nothing, the line says to land first.
    admin.send({ t: 'rules', parachute: false });
    await sleep(1000);
    await A.evaluate('window.__sent.length = 0', false);
    await tap(A, 'KeyE');
    await sleep(300);
    const offLine = await prompt(A);
    await sleep(900);
    ok('the parachute rule off: E in the air sends no jump, still aboard, the line says land first', (await A.evaluate('window.__sent.length')) === 0 && (await aboard(A)).aboard && /Land first/.test(offLine), `"${offLine}"`);
    admin.send({ t: 'rules', parachute: true });
    await sleep(800);
    ok('and flies it down onto its pad', (await fly(A, PARK.house, hang.y, { secs: 90 })) > 0);
    await use(A);
    let p1 = null;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      p1 = await own(P);
      if (p1.chute === null) break;
    }
    ok('the pilot lands', p1?.chute === null, JSON.stringify(p1));
    for (const b of three) ok(`${b.who}: nobody aboard`, !(await aboard(b)).aboard);
    admin.send({ t: 'rules', parachute: false });
    await sleep(800);
  }
  for (const b of pages) ok(`${b.who}: no page errors`, errors(b).length === 0, JSON.stringify(errors(b).slice(-3)));
} catch (e) {
  console.log('FAIL', e?.stack ?? e);
  failed++;
} finally {
  for (const b of pages) b.close();
  admin.ws.close();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exitCode = failed ? 1 : 0;
