// Zombies at the church follow players into the café there (shared/keet.mjs, shared/arenas.mjs villageGround), against a
// throwaway game server: the admin starts Zombies at the church and picks a wave, five guests go in and stand where
// a player could hide: behind the bar, in a toilet with its doors shut (shut again whenever a zombie shoves them open), on
// a chair, on the pool table, and one in the front room slamming the front door shut ten times a second (the server takes
// five a second at most). Every WebSocket message is logged. The check proves that zombies come into the room of each
// one and swipe (a 'hurt' from a zombie) within --secs, that nobody is told they are out of the zombies' reach (zPerch),
// that no zombie stands inside a wall or a piece of furniture of the café or higher than a chair, and it counts the doors
// the zombies shoved and the zombies that came in.
//
//   ADMIN_PASSWORD=... node tools/dev/keet_zombies_ws_check.mjs --api http://localhost:8457 [--wave 2] [--secs 120]
//
// The password comes from the environment and is never printed. Each run needs a fresh server on an empty web/.data
// (the guests' names stay taken for the day), on your own port.
import { readFileSync } from 'node:fs';
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { makeKeet } from '../../web/shared/keet.mjs';
import { readZombie } from '../../web/shared/wire.mjs';
import { localOnly, options } from './cdp.mjs';

const o = options({ api: 'http://localhost:8457', wave: '2', secs: '120' });
localOnly(o.api); // it starts a game as the admin: a throwaway server on this computer only
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');
const host = new URL(o.api).host;
const read = (f) => JSON.parse(readFileSync(new URL(`../../web/src/data/${f}`, import.meta.url), 'utf8'));
const keet = makeKeet(read('keet_shell.json'), read('keet_rooms.json'));
const F = keet.floor;
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
    if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', n: m.n }));
    log.push(m);
  });
  await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)));
  await sleep(800);
  return { ws, log, send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)) };
};

// Where each one stands: a room's middle, or the top of a piece of furniture.
const mid = (p) => [p.p[0].reduce((t, q) => t + q[0], 0) / p.p[0].length, p.p[0].reduce((t, q) => t + q[1], 0) / p.p[0].length];
const area = (p) => {
  const r = p.p[0];
  let s = 0;
  for (let i = 0; i < r.length; i++) s += r[i][0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * r[i][1];
  return Math.abs(s) / 2;
};
const front = keet.prisms.filter((p) => p.n === 'front room');
const chair = front.find((p) => Math.abs(p.y1 - F - 0.46) < 0.02 && p.y0 <= F + 0.01);
const pool = front.filter((p) => Math.abs(p.y1 - F - 0.8) < 0.02).sort((a, b) => area(b) - area(a))[0];
const spot = (name) => keet.spots.find((s) => s.name === name);
const { o: fo, a: fa } = read('keet_shell.json').frame;
const W = (u, v) => [fo[0] + u * Math.cos(fa) + v * Math.sin(fa), fo[1] - u * Math.sin(fa) + v * Math.cos(fa)];
const [fx, fz] = W(4.4, 2.0); // in the front room, by the front door
const places = [
  { who: 'Bar', x: spot('behind the bar').x, y: F, z: spot('behind the bar').z },
  { who: 'Loo', x: spot('toilet 1').x, y: F, z: spot('toilet 1').z, shut: ['keet-toilets', 'keet-toilet1'] },
  { who: 'Chair', x: mid(chair)[0], y: chair.y1, z: mid(chair)[1] },
  { who: 'Pool', x: mid(pool)[0], y: pool.y1, z: mid(pool)[1] },
  { who: 'Door', x: fx, y: F, z: fz, slam: 'keet-front' },
];

const admin = cookieOf((await call('POST', '/api/login', { username: 'admin', password })).r);
const root = await connect(admin);
ok('the admin joined', root.log.some((m) => m.t === 'welcome'));
const guests = [];
for (const p of places) {
  const cookie = cookieOf((await call('POST', '/api/join', { name: p.who, age: true })).r);
  const c = await connect(cookie);
  const you = c.log.find((m) => m.t === 'welcome')?.you ?? p.who;
  guests.push({ ...p, ...c, you, hurtAt: -1, perch: 0, down: false });
}
ok('five guests joined', guests.every((g) => g.log.some((m) => m.t === 'welcome')));

root.send({ t: 'mode', kind: 'zombies', place: 'church' });
await sleep(1500);
ok('Zombies started at the church', root.log.some((m) => m.t === 'mode' && m.mode?.kind === 'zombies'));
const t0 = Date.now();
// Each guest walks there (the server moves them no faster than a run, straight: it keeps no walls for walkers), armed.
const state = (g) => g.send({ t: 'state', x: g.x, y: g.y, z: g.z, yaw: 0, pitch: 0, armed: true, flying: false, w: 'pistol', c: false });
let picked = false;
const zombies = new Map();
const seen = { inside: new Set(), worstY: -Infinity, inSolid: 0, samples: 0 };
const shoved = new Map();
const solids = keet.prisms.filter((p) => p.y1 > F + 0.3 && p.y0 < F + 1.75);
const inRing = (x, z, ring) => {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
};
let read0 = 0;
const timer = setInterval(() => {
  for (const g of guests) {
    state(g);
    if (g.slam) g.send({ t: 'door', id: g.slam, open: false, dir: 1 });
  }
}, 100);
const doorTimer = setInterval(() => {
  for (const g of guests) for (const id of g.shut ?? []) g.send({ t: 'door', id, open: false, dir: 1 });
}, 2000);
while (Date.now() - t0 < Number(o.secs) * 1000 && guests.some((g) => g.hurtAt < 0)) {
  await sleep(250);
  if (!picked && Date.now() - t0 > 20000) {
    root.send({ t: 'zwave', wave: Number(o.wave) }); // everyone in place: this wave now
    picked = true;
  }
  // The admin's log: the zombies' ticks and the doors they shove.
  for (; read0 < root.log.length; read0++) {
    const m = root.log[read0];
    if (m.t === 's' && Array.isArray(m.z)) {
      for (const e of m.z) {
        const z = readZombie(e);
        zombies.set(z.id, z);
        if (z.act === 'down' || !keet.contains(z.x, z.z)) continue;
        seen.inside.add(z.id);
        seen.samples++;
        if (z.y !== null) seen.worstY = Math.max(seen.worstY, z.y - F);
        if (solids.some((p) => inRing(z.x, z.z, p.p[0]) && (z.y ?? F) + 0.02 < p.y1 && (z.y ?? F) + 1.6 > p.y0)) seen.inSolid++;
      }
    }
    if (m.t === 'zgone') for (const id of m.ids ?? []) zombies.delete(id);
    if (m.t === 'door' && m.by === '' && m.open) shoved.set(m.id, (shoved.get(m.id) ?? 0) + 1);
  }
  for (const g of guests) {
    if (g.hurtAt < 0 && g.log.some((m) => m.t === 'hurt' && /zombie/.test(m.by ?? ''))) {
      g.hurtAt = Date.now() - t0;
      const near = [...zombies.values()].filter((z) => z.act !== 'down').map((z) => Math.hypot(z.x - g.x, z.z - g.z)).sort((a, b) => a - b)[0];
      g.near = near;
    }
    g.perch = g.log.filter((m) => m.t === 'system' && m.code === 'zPerch').length;
  }
}
clearInterval(timer);
clearInterval(doorTimer);
for (const g of guests) {
  ok(`${g.who}: a zombie came and swiped`, g.hurtAt >= 0, g.hurtAt >= 0 ? `after ${(g.hurtAt / 1000).toFixed(1)} s (the wave picked at 20 s), the nearest zombie ${g.near?.toFixed(2)} m off` : '');
  ok(`${g.who}: never told the zombies can't reach them`, g.perch === 0, `${g.perch}`);
}
ok('zombies came into the café', seen.inside.size > 0, `${seen.inside.size} zombies inside, ${seen.samples} positions seen there`);
ok('no zombie inside a wall or a piece of furniture', seen.inSolid === 0, `${seen.inSolid}`);
ok('no zombie inside walks on a chair or higher (the back door\'s steps aside)', seen.worstY < 0.4, `${seen.worstY.toFixed(2)} m over the floor at most`);
console.log(`doors the zombies shoved open: ${[...shoved].map(([id, n]) => `${id} ${n}x`).join(', ') || 'none'}`);
const slammer = guests.find((g) => g.slam);
const slams = root.log.filter((m) => m.t === 'door' && m.by === slammer.you).length;
const secs = (Date.now() - t0) / 1000;
ok('a page slamming the front door is held to five a second', slams <= secs * 5 + 1, `${slams} in ${secs.toFixed(0)} s`);
root.send({ t: 'mode', kind: 'free' });
await sleep(500);
for (const g of guests) g.ws.close();
root.ws.close();
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
