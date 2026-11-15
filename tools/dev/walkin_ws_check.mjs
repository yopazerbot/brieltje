// A walked-into home (default: the brick house on Kapellenhoek) against a throwaway game server, with two players: Alice
// has no right, Bob types the code (and the admin is the third). Every WebSocket message is logged, and the check proves
// that Alice is sent nothing of the inside (door states, broken panes), that she is held at the door and told so, that
// Bob walks in, and that when the admin revokes the code Bob is put out on the home's own spot. Then, from one sender:
// the inside endpoint refuses, and wrong codes for the home, for a made-up id and for a home without a code give the same
// refusal after the same work (times compared), the ninth in ten minutes a 429.
//
//   ADMIN_PASSWORD=... node tools/dev/walkin_ws_check.mjs --api http://localhost:8457 [--home kapellenhoek_home]
//
// The password comes from the environment and is never printed; nor is the code. Each run needs a fresh server (the
// limits per sender are in its memory), on your own port, with the private data (web/.private/ on this PC).
import { readFileSync } from 'node:fs';
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { findHome, homeAt, WALK_INS } from '../../web/shared/homes.mjs';
import { localOnly, options } from './cdp.mjs';

const o = options({ api: 'http://localhost:8457', home: 'kapellenhoek_home' });
localOnly(o.api); // it makes and revokes a home's code: a throwaway server on this computer only
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');
const H = o.home;
const home = findHome(H);
if (!home?.out || !WALK_INS[H]) throw new Error(`${H} is not a walked-into home with a spot of its own`);
const shell = JSON.parse(readFileSync(new URL(`../../web/src/data/${H}_shell.json`, import.meta.url), 'utf8'));
const host = new URL(o.api).host;
let failed = 0;
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
  if (!pass) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (method, path, body, cookie = '') => {
  const r = await fetch(o.api + path, { method, headers: { 'Content-Type': 'application/json', Origin: o.api, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  return { r, data: await r.json().catch(() => null) };
};
const cookieOf = (r) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const connect = async (cookie) => {
  const log = [];
  const ws = new WebSocket(`ws://${host}/ws?v=4`, { headers: { Cookie: cookie, Origin: o.api } });
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', n: m.n })); // as a page does: a silent one is let go
    log.push(m);
  });
  await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)));
  await sleep(800);
  return { ws, log, send: (m) => ws.send(JSON.stringify(m)) };
};
const guest = async (asked) => {
  const cookie = cookieOf((await call('POST', '/api/join', { name: asked, age: true })).r);
  const c = await connect(cookie);
  return { name: c.log.find((m) => m.t === 'welcome')?.you ?? asked, cookie, ...c };
};

// The home's frame: floor coordinates (u along the front, v into the house) for the walks, from its first band's ring.
const { o: fo, a: fa, floor } = shell.frame;
const toWorld = ([x, z]) => [fo[0] + x * Math.cos(fa) + z * Math.sin(fa), fo[1] - x * Math.sin(fa) + z * Math.cos(fa)];
const [ox, oz] = home.out;

const admin = cookieOf((await call('POST', '/api/login', { username: 'admin', password })).r);
const made = await call('POST', `/api/admin/homes/${H}/code`, {}, admin);
ok('the admin made a code', made.r.status === 200);
const code = made.data.code;
const packRes = await call('GET', `/api/home/${H}/inside`, undefined, admin);
ok('the admin gets the inside', packRes.r.status === 200, String(packRes.r.status));
if (packRes.r.status !== 200) process.exit(1);
const pack = packRes.data;
const insideDoor = pack.doors[0].id;
const window0 = WALK_INS[H].glass; // the shell's first window

const a = await guest('Alice'); // no right
const b = await guest('Bob'); // types the code
const root = await connect(admin);
const welcomeA = a.log.find((m) => m.t === 'welcome');
ok('both joined', !!welcomeA && !!b.log.find((m) => m.t === 'welcome'));
const ofHome = (m) => (m.t === 'door' && (m.id.startsWith('kh-home-') || m.id === insideDoor)) || (m.t === 'glass' && m.i >= WALK_INS[H].glass && m.i < WALK_INS[H].doorGlass + WALK_INS[H].size) || m.t === 'inside';
ok('a: no door of the home in the welcome', !Object.keys(welcomeA.doors).some((id) => id.startsWith('kh-home-')));

// Both go to the street by chat travel, then walk to the drive (the server's speed budget: small steps).
const pos = { Alice: null, Bob: null };
const at = (p, x, z, y) => {
  pos[p.name] = { x, z, y };
  p.send({ t: 'state', x, y, z, yaw: 0, pitch: 0 });
};
const walk = async (p, x, z, y) => {
  const from = pos[p.name];
  const d = Math.hypot(x - from.x, z - from.z);
  const n = Math.max(1, Math.ceil(d / 0.35));
  for (let k = 1; k <= n; k++) {
    at(p, from.x + ((x - from.x) * k) / n, from.z + ((z - from.z) * k) / n, from.y + ((y - from.y) * k) / n);
    await sleep(100);
  }
};
for (const p of [a, b]) {
  p.send({ t: 'travel', to: 'street:kapellenhoek', via: 'chat' });
  await sleep(600);
  const t = p.log.find((m) => m.t === 'travel' && m.name === p.name);
  ok(`${p.name} travelled to the street`, t?.ok === true, JSON.stringify(t ?? p.log.filter((m) => m.t !== 's').map((m) => m.t)));
}
const street = JSON.parse(readFileSync(new URL('../../web/shared/places.json', import.meta.url), 'utf8')).places.find((q) => q.id === 'street:kapellenhoek');
const groundAt = floor - 0.4;
for (const p of [a, b]) {
  pos[p.name] = { x: street.x, z: street.z, y: groundAt };
  at(p, street.x, street.z, groundAt);
  await sleep(200);
  await walk(p, ox, oz, groundAt);
}
/** A player's last position as the admin's ticks show it (the admin sees into every home; Alice no longer sees Bob inside). */
const seen = (who) => {
  for (let i = root.log.length - 1; i >= 0; i--) {
    const m = root.log[i];
    if (m.t !== 's' || !m.p) continue;
    const e = m.p.find((q) => q[0] === who);
    if (e) return { x: e[2], y: e[3], z: e[4] };
  }
  return null;
};
// The front door: its leaf's middle, from 1 m outside to 1.2 m in.
const front = shell.doors.find((d) => d.id === 'kh-home-front');
const fa0 = toWorld(front.panels[0].a);
const fb0 = toWorld(front.panels[0].b);
const mid = [(fa0[0] + fb0[0]) / 2, (fa0[1] + fb0[1]) / 2];
const inward = [mid[0] - ox, mid[1] - oz];
const L = Math.hypot(...inward);
const step = (k) => [mid[0] + (inward[0] / L) * k, mid[1] + (inward[1] / L) * k];
const [px, pz] = step(-1);
const [ix, iz] = step(1.2);
ok('the spot inside is the home\'s', homeAt(ix, iz, floor) === H);

// Alice: to the door, then in. Held, and told.
await walk(a, px, pz, floor);
await walk(a, ix, iz, floor);
await sleep(500);
ok('a: told the home is locked', a.log.some((m) => m.t === 'homelock' && m.id === H));
await sleep(300);
const aSeen = (() => {
  for (let i = b.log.length - 1; i >= 0; i--) {
    const e = b.log[i].t === 's' ? b.log[i].p?.find((q) => q[0] === a.name) : null;
    if (e) return { x: e[2], y: e[3], z: e[4] };
  }
  return null;
})();
ok('a: the others see her outside, never in', aSeen && homeAt(aSeen.x, aSeen.z, aSeen.y) === null, JSON.stringify(aSeen));
// Without the right Bob's door and glass messages for the home do nothing, and the inside is refused.
b.send({ t: 'door', id: 'kh-home-front', open: true, dir: 1 });
b.send({ t: 'glass', i: window0 });
await sleep(500);
ok('without the right a door or pane message does nothing', !a.log.some(ofHome) && !root.log.some(ofHome));
const early = await call('GET', `/api/home/${H}/inside`, undefined, b.cookie);
ok('GET inside is refused without the grant', early.r.status === 403 && !JSON.stringify(early.data).includes('prisms'));

// Bob types the code: the pack comes with the answer; he opens the front door and an inside one, breaks a window.
const unlock = await call('POST', '/api/home/unlock', { id: H, code }, b.cookie);
ok('the right code answers with the inside', unlock.r.status === 200 && Array.isArray(unlock.data.inside?.prisms));
ok('the answer is never cached', /no-store/.test(unlock.r.headers.get('cache-control')) && /private/.test(unlock.r.headers.get('cache-control')));
await sleep(500);
for (const id of ['kh-home-front', insideDoor]) {
  b.send({ t: 'door', id, open: true, dir: 1 });
  await sleep(1100); // one door message a second
}
b.send({ t: 'glass', i: window0 });
await sleep(600);
ok('the admin hears the doors and the pane', root.log.some((m) => m.t === 'door' && m.id === insideDoor) && root.log.some((m) => m.t === 'glass' && m.i === window0),
  `${root.log.filter((m) => m.t === 'door' || m.t === 'glass').length} messages`);
ok('a hears nothing of the home: no door, no pane, no inside', !a.log.some(ofHome), `${a.log.filter(ofHome).length} of ${a.log.length} messages`);
ok('and still no inside for a', (await call('GET', `/api/home/${H}/inside`, undefined, a.cookie)).r.status === 403);
// Bob walks in through the open door.
await walk(b, px, pz, floor);
await walk(b, ix, iz, floor);
await sleep(600);
const bIn = seen(b.name);
ok('b walks in with the grant', bIn && homeAt(bIn.x, bIn.z, bIn.y) === H, JSON.stringify(bIn));
// Alice tries through the door Bob opened: held.
a.log.length = 0;
await walk(a, px, pz, floor);
await walk(a, ix, iz, floor);
await sleep(500);
ok('a: an open door is no way in', a.log.some((m) => m.t === 'homelock' && m.id === H));
// A forged position deep inside (a changed page): held where she was.
at(a, toWorld([-8, 5])[0], toWorld([-8, 5])[1], floor + 2.95);
await sleep(600);
const aNow = (() => {
  for (let i = b.log.length - 1; i >= 0; i--) {
    const e = b.log[i].t === 's' ? b.log[i].p?.find((q) => q[0] === a.name) : null;
    if (e) return { x: e[2], y: e[3], z: e[4] };
  }
  return null;
})();
ok('a: a forged position inside is not taken', aNow && homeAt(aNow.x, aNow.z, aNow.y) === null, JSON.stringify(aNow));

// A garage door that opens (the brick house's rises): Bob opens it, Alice is told nothing and is held at it all the same.
const garage = shell.doors.find((d) => d.id === 'kh-home-garage' && d.panels.some((p) => p.lift || p.slide || p.swing));
if (garage) {
  a.log.length = 0;
  b.send({ t: 'door', id: garage.id, open: true, dir: 1 });
  await sleep(1100);
  ok('the admin hears the garage door open', root.log.some((m) => m.t === 'door' && m.id === garage.id && m.open));
  const ga = toWorld(garage.panels[0].a);
  const gb = toWorld(garage.panels[0].b);
  const gm = [(ga[0] + gb[0]) / 2, (ga[1] + gb[1]) / 2];
  const gl = Math.hypot(gb[0] - ga[0], gb[1] - ga[1]);
  let gn = [-(gb[1] - ga[1]) / gl, (gb[0] - ga[0]) / gl];
  if (homeAt(gm[0] + gn[0] * 1.2, gm[1] + gn[1] * 1.2, floor) !== H) gn = [-gn[0], -gn[1]];
  const gStep = (k) => [gm[0] + gn[0] * k, gm[1] + gn[1] * k];
  ok('the spot behind the garage door is the home\'s', homeAt(...gStep(1.2), floor) === H);
  await walk(a, px, pz, floor);
  await walk(a, ...gStep(-1), floor);
  await walk(a, ...gStep(1.2), floor);
  await sleep(600);
  ok('a: the open garage door is no way in', a.log.some((m) => m.t === 'homelock' && m.id === H));
  const aG = (() => {
    for (let i = b.log.length - 1; i >= 0; i--) {
      const e = b.log[i].t === 's' ? b.log[i].p?.find((q) => q[0] === a.name) : null;
      if (e) return { x: e[2], y: e[3], z: e[4] };
    }
    return null;
  })();
  ok('a: the others see her outside the garage, never in', aG && homeAt(aG.x, aG.z, aG.y) === null, JSON.stringify(aG));
  ok('a hears nothing of the garage door: she sees it shut', !a.log.some(ofHome), `${a.log.filter(ofHome).length} messages`);
}

// The admin revokes the code: Bob, inside, is put out on the home's spot at his next move.
const revoked = await call('DELETE', `/api/admin/homes/${H}/code`, undefined, admin);
ok('the admin revoked the code', revoked.r.status === 200);
b.log.length = 0;
at(b, ix + 0.05, iz, floor);
await sleep(700);
const bOut = seen(b.name);
ok('b is told, and put out on the home\'s own spot', b.log.some((m) => m.t === 'homelock' && m.id === H) && bOut && Math.hypot(bOut.x - ox, bOut.z - oz) < 0.05, JSON.stringify(bOut));
a.ws.close();
b.ws.close();
root.ws.close();

// From one sender (this computer): the same refusal for the home with a wrong code, a made-up id and a home without a
// code, after the same work; the ninth wrong code for one home in ten minutes is slowed.
const made2 = await call('POST', `/api/admin/homes/${H}/code`, {}, admin);
ok('a new code', made2.r.status === 200);
const tries = async (id, n) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const r = await call('POST', '/api/home/unlock', { id, code: 'BBBBB-BBBBB' });
    out.push({ status: r.r.status, body: JSON.stringify(r.data), ms: performance.now() - t0 });
  }
  return out;
};
const stats = (list) => {
  const ms = list.map((x) => x.ms).sort((p, q) => p - q);
  return { min: ms[0], median: ms[Math.floor(ms.length / 2)], max: ms.at(-1) };
};
// Bob's right code above was the first try at the home from this sender: seven more make eight.
const homeTries = await tries(H, 7);
const madeUp = await tries('nowhere_home', 7);
const noCode = await tries('bungalow', 7);
const same = [...homeTries, ...madeUp, ...noCode];
ok('all the same refusal', same.every((x) => x.status === 403 && x.body === same[0].body), [...new Set(same.map((x) => `${x.status} ${x.body}`))].join(' | '));
const [s1, s2, s3] = [stats(homeTries), stats(madeUp), stats(noCode)];
const f = (s) => `${s.min.toFixed(0)}/${s.median.toFixed(0)}/${s.max.toFixed(0)} ms`;
ok('the same work: the medians within each other\'s spread', [s1, s2, s3].every((s) => [s1, s2, s3].every((t) => s.median >= t.min * 0.8 && s.median <= t.max * 1.25)),
  `home ${f(s1)}, made-up ${f(s2)}, no code ${f(s3)} (min/median/max)`);
const ninth = await call('POST', '/api/home/unlock', { id: H, code: 'BBBBB-BBBBB' });
ok('the ninth wrong code for the home from one sender: 429', ninth.r.status === 429, String(ninth.r.status));
await call('DELETE', `/api/admin/homes/${H}/code`, undefined, admin);
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
