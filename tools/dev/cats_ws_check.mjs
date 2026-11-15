// The cats shot down, against a throwaway game server (a build of this branch, server/game.mjs catInReach): a guest by
// the house fells a cat there and the others are told; the same guest, after a trip to the church (about 940 m away),
// fells none, whatever its page says (hit forgery: before, a walker anywhere on the map felled any cat). The cats walk on
// the shared clock (shared/cats.mjs), so this check works out where each is as the page and the server do.
//
//   ADMIN_PASSWORD=... node tools/dev/cats_ws_check.mjs --api http://localhost:8430
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import CATS from '../../web/shared/cats.json' with { type: 'json' };
import { catWalk } from '../../web/shared/cats.mjs';
import { localOnly, options } from './cdp.mjs';

const o = options({ api: 'http://localhost:8430' });
localOnly(o.api); // it logs in as the admin and joins a guest: a throwaway server on this computer only
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');
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
  const ws = new WebSocket(`ws://${host}/ws?v=2`, { headers: { Cookie: cookie, Origin: o.api } });
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 'ping') return ws.send(JSON.stringify({ t: 'pong', n: m.n }));
    if (m.t !== 's') log.push(m);
  });
  await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)));
  await sleep(800);
  const welcome = log.find((m) => m.t === 'welcome');
  return { ws, log, name: welcome?.you, welcome, send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)) };
};

const admin = await connect(cookieOf((await call('POST', '/api/login', { username: 'admin', password })).r));
const parachute = admin.welcome?.rules?.parachute;
admin.send({ t: 'rules', parachute: false }); // no page here to land a drop
const j = await call('POST', '/api/join', { name: `Cats${process.pid % 10000}`, age: true });
if (!j.data?.username) throw new Error(`join: ${j.r.status} ${j.data?.code ?? ''}`);
const guest = await connect(cookieOf(j.r));
const at = { x: 4.5, y: -0.1, z: 19 }; // by the house, out of its front door's portal
const state = () => guest.send({ t: 'state', ...at, yaw: 0, pitch: 0, armed: true, w: 'rifle', ct: Date.now() });
for (let k = 0; k < 10; k++) (state(), await sleep(50));
const felled = (i) => admin.log.filter((m) => m.t === 'cat' && m.i === i && m.by === guest.name).length;

// By the house: a cat there, as the guest's page sees it on the shared clock, is felled for everyone.
const c = catWalk(CATS, 1, Date.now() / 1000);
ok('by the house the cats are within reach', Math.hypot(c.x - at.x, c.z - at.z) < 60, `${Math.hypot(c.x - at.x, c.z - at.z).toFixed(1)} m`);
guest.send({ t: 'cat', i: 1, w: 'rifle' });
await sleep(500);
ok('a cat felled from by the house: the others are told', felled(1) === 1);

// A trip to the church, then a cat at the house: nobody is told, the cat stays up.
guest.send({ t: 'travel', to: 'church', via: 'chat' });
await sleep(600);
const trip = guest.log.find((m) => m.t === 'travel' && m.name === guest.name);
ok('the trip to the church', trip?.ok === true, JSON.stringify(trip ?? null));
Object.assign(at, { x: 536, y: 3, z: -772 }); // the church's portal, as the trip put them
for (let k = 0; k < 10; k++) (state(), await sleep(50));
for (const i of [0, 2, 3]) {
  guest.send({ t: 'cat', i, w: 'rifle' });
  await sleep(350); // past the 300 ms between cats
}
guest.send({ t: 'cat', i: 0, w: 'grenade' }); // and as a blast of a grenade it never threw
await sleep(500);
ok('cats "felled" from the church (940 m away): nobody is told', [0, 2, 3].every((i) => felled(i) === 0), [0, 2, 3].map(felled).join(','));

if (parachute !== false) admin.send({ t: 'rules', parachute: true }); // the server's rule as it was
await sleep(300);
for (const p of [admin, guest]) p.ws.close();
await sleep(300);
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
