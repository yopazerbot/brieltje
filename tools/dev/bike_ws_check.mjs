// Two players against a throwaway game server (a build of this branch): Alice gets on the bike by the main house and
// rides it, Bob sees her ride it in the ticks. Every forged message the bikes could be abused with is tried and must
// change nothing: getting on from afar, taking a ridden bike, riding faster than a bike, a ride state forged on foot,
// a bell from someone on foot.
//
//   ADMIN_PASSWORD=... node tools/dev/bike_ws_check.mjs --api http://localhost:8310
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { FLAG, readBike, readPlayer } from '../../web/shared/wire.mjs';
import BIKES from '../../web/shared/bike.json' with { type: 'json' };
import { options } from './cdp.mjs';

const o = options({ api: 'http://localhost:8310' });
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
const RUN = 1.4 * 2.5 * 1.3; // m/s on foot (server/game.mjs RUN_SPEED)
const BIKE = BIKES.maxSpeed * 1.3; // m/s on a bike
const HOUSE = BIKES.bikes.house.park;

const admin = cookieOf((await call('POST', '/api/login', { username: 'admin', password })).r);
await call('POST', '/api/pin', { pin: '482915' }, admin);
const guest = async (name) => {
  const j = await call('POST', '/api/join', { name, pin: '482915', age: true });
  const cookie = cookieOf(j.r);
  const log = [];
  const ws = new WebSocket(`ws://${host}/ws?v=2`, { headers: { Cookie: cookie, Origin: o.api } });
  ws.on('message', (d) => log.push(JSON.parse(String(d))));
  await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)));
  await sleep(600);
  const me = { name, cookie, ws, log, x: 4.5, y: -0.1, z: 19, yaw: 0, send: (m) => ws.send(JSON.stringify(m)) };
  me.state = (extra = {}) => me.send({ t: 'state', x: me.x, y: me.y, z: me.z, yaw: me.yaw, pitch: 0, armed: false, w: 'pistol', ct: Date.now(), ...extra });
  /** Walk (or ride) to (x, z) at `speed` m/s, twenty states a second. */
  me.go = async (x, z, speed, extra = {}) => {
    for (;;) {
      const d = Math.hypot(x - me.x, z - me.z);
      const step = Math.min(d, speed / 20);
      if (d > 1e-6) {
        me.x += ((x - me.x) / d) * step;
        me.z += ((z - me.z) / d) * step;
      }
      me.state(extra);
      await sleep(50);
      if (d <= step) return;
    }
  };
  return me;
};
const a = await guest('Alice');
const b = await guest('Bob');
// Their names as the server has them (lower case).
const A = a.log.find((m) => m.t === 'welcome').you;
const B = b.log.find((m) => m.t === 'welcome').you;
const welcome = a.log.find((m) => m.t === 'welcome');
ok('the welcome has every bike, nobody on them', welcome?.bikes?.length === Object.keys(BIKES.bikes).length && welcome.bikes.every((k) => k.rider === null));
/** The newest tick entries Bob got for bike `id` and player `name` since `from` (an index into his log). */
const seen = (from, id, name) => {
  const ticks = b.log.slice(from).filter((m) => m.t === 's');
  const bikes = ticks.flatMap((m) => (m.k ?? []).map(readBike)).filter((k) => k.id === id);
  const players = ticks.flatMap((m) => (m.p ?? []).map(readPlayer)).filter((p) => p.name === name);
  return { bikes, players, last: bikes.at(-1), me: players.at(-1) };
};

// From the street, on to the bike from afar: refused.
a.send({ t: 'bike', op: 'on', id: 'house' });
await sleep(400);
ok('getting on from the street (13 m off) is refused', !a.log.some((m) => m.t === 'bike' && m.bike.rider === A));
// Walk there at running pace (down the side passage), then on.
await a.go(-1.6, 19, RUN * 0.9);
await a.go(-1.6, HOUSE.z + 1, RUN * 0.9);
await sleep(350);
a.send({ t: 'bike', op: 'on', id: 'house' });
await sleep(400);
ok('next to it Alice gets on, and Bob is told', a.log.some((m) => m.t === 'bike' && m.bike.rider === A) && b.log.some((m) => m.t === 'bike' && m.bike.id === 'house' && m.bike.rider === A));
// Bob comes along and tries to take it from her.
await b.go(-1.6, 19, RUN * 0.9);
await b.go(-1.6, HOUSE.z + 2, RUN * 0.9);
await sleep(350);
const [la, lb] = [a.log.length, b.log.length];
b.send({ t: 'bike', op: 'on', id: 'house' });
b.send({ t: 'bike', op: 'off', id: 'house' });
await sleep(400);
const taken = [...a.log.slice(la), ...b.log.slice(lb)].some((m) => m.t === 'bike' && m.bike.id === 'house' && m.bike.rider !== A);
ok('Bob can\'t take the bike she rides, nor push her off', !taken);
for (const id of ['__proto__', 'toString', 'nope', 5]) b.send({ t: 'bike', op: 'on', id });
await sleep(300);
ok('ids that are no bike do nothing', !b.log.some((m) => m.t === 'bike' && m.bike?.rider === B));

// She rides out of the passage to the street at 24 km/h: Bob sees the bike and her on it, moving.
const from = b.log.length;
a.x = HOUSE.x;
a.z = HOUSE.z;
a.yaw = Math.PI;
await a.go(HOUSE.x, 20, 6.7);
await a.go(20, 20.5, 6.7);
await sleep(300);
const ride = seen(from, 'house', A);
ok('Bob sees the bike move with Alice on it', ride.bikes.length > 20 && ride.last.rider === A && Math.abs(ride.last.x - 20) < 1.5, JSON.stringify(ride.last));
ok('and her figure flagged on a bike (not in a car)', !!ride.me?.bike && !ride.me.d, JSON.stringify(ride.me));

// Faster than a bike: a jump of 40 m in a twentieth of a second is cut to what the budget allows.
const before = seen(0, 'house', A).last;
a.x += 40;
a.state();
await sleep(300);
const after = seen(from, 'house', A).last;
ok('a 40 m jump on the bike is held to a bike\'s pace', after.x - before.x <= BIKE * 0.5 + 0.6, `${(after.x - before.x).toFixed(2)} m`);
a.x = after.x;

// The bell: hers rings for Bob at her bike; his (on foot) rings for nobody.
a.send({ t: 'bell' });
b.send({ t: 'bell' });
await sleep(300);
ok('Alice\'s bell reaches Bob, at her bike', b.log.some((m) => m.t === 'bell' && m.id === 'house'));
ok('Bob\'s bell on foot reaches nobody', !a.log.some((m) => m.t === 'bell'));

// Off again; then a ride state forged on foot (the bike flag, the car flag) buys no speed.
a.send({ t: 'bike', op: 'off' });
await sleep(400);
ok('off: the bike stands where she left it', b.log.some((m) => m.t === 'bike' && m.bike.id === 'house' && m.bike.rider === null && Math.abs(m.bike.x - a.x) < 1.5));
const foot0 = seen(0, 'house', A).me;
const mark = b.log.length;
for (let i = 0; i < 10; i++) {
  a.x += 3; // 60 m/s
  a.state({ bk: 1, d: true, s: 0.4 });
  await sleep(50);
}
await sleep(300);
const foot1 = seen(mark, 'house', A).me;
const ran = foot1.x - foot0.x;
// (Running for the half second and the network's slack, plus at most the half second's worth stored while standing.)
ok('on foot, a forged ride state is held to running pace', ran <= RUN * 1.2 + 0.5, `${ran.toFixed(2)} m in 0.5 s (30 m asked)`);
ok('and the bike flag stays off', !foot1.bike);

for (const p of [a, b]) p.ws.close();
await sleep(200);
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
