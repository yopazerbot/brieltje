// Two players against a throwaway game server (a build of this branch): Alice gets on the bike by the main house and
// rides it, Bob sees her ride it in the ticks. Every forged message the bikes could be abused with is tried and must
// change nothing: getting on from afar, taking a ridden bike, riding faster than a bike, a ride state forged on foot,
// a bell from someone on foot. Then Alice drives the Tesla into the bike (server/bikeHits.mjs): Alice and Bob get the same
// knock, Carol joining later gets it lying there; a car state past the speed budget, made-up messages and a forged car
// flag on foot move no bike; a ridden bike is never knocked.
//
//   ADMIN_PASSWORD=... node tools/dev/bike_ws_check.mjs --api http://localhost:8310
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { FLAG, readBike, readPlayer } from '../../web/shared/wire.mjs';
import BIKES from '../../web/shared/bike.json' with { type: 'json' };
import { localOnly, options } from './cdp.mjs';

const o = options({ api: 'http://localhost:8310' });
localOnly(o.api); // it logs in as the admin and joins players: a throwaway server on this computer only
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
const guest = async (name) => {
  const j = await call('POST', '/api/join', { name, age: true });
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

// A car into the bike (server/bikeHits.mjs): no message of its own. Alice walks to the Tesla, gets in and drives along
// the street through the bike she left there, at 40 km/h, thirty states a second (the car's states are hers).
const knocked = (log, from) => log.slice(from).filter((m) => m.t === 'bike' && m.knock);
const left = [...b.log].reverse().find((m) => m.t === 'bike' && m.bike.id === 'house').bike;
await a.go(4.6, a.z, RUN * 0.9);
await a.go(4.6, 14.5, RUN * 0.9);
await sleep(350);
a.send({ t: 'car', op: 'in', id: 'tesla' });
await sleep(400);
ok('Alice is at the wheel of the Tesla', a.log.some((m) => m.t === 'car' && m.car.id === 'tesla' && m.car.driver === A));
/** Drive (Alice's states as the car's) to (x, z) at `speed` m/s, thirty states a second, facing the way she goes. */
const drive = async (x, z, speed) => {
  for (;;) {
    const d = Math.hypot(x - a.x, z - a.z);
    const step = Math.min(d, speed / 30);
    if (d > 1e-6) {
      a.yaw = Math.atan2(-(x - a.x), -(z - a.z));
      a.x += ((x - a.x) / d) * step;
      a.z += ((z - a.z) / d) * step;
    }
    a.state({ s: 0 });
    await sleep(33);
    if (d <= step) return;
  }
};
// Across the drive to the street, slowly (the server holds no walls for a car; only the speed budget), then along it.
await drive(2.17, left.z, 3);
await drive(left.x - 25, left.z, 11);
const [ka, kb] = [a.log.length, b.log.length];
await drive(left.x + 25, left.z, 40 / 3.6);
await sleep(300);
const ma = knocked(a.log, ka);
const mb = knocked(b.log, kb);
ok('driving into it: one knock, told to both', ma.length === 1 && mb.length === 1, `${ma.length} ${mb.length}`);
const k = mb[0]?.bike ?? {};
const moved = Math.hypot(k.x - left.x, k.z - left.z);
ok('the same place and side on both', JSON.stringify(ma[0]?.bike) === JSON.stringify(mb[0]?.bike) && (k.lie === 1 || k.lie === -1), JSON.stringify(k));
ok('thrown aside, about 3 m at 40 km/h', moved > 2 && moved < 3.6, `${moved.toFixed(2)} m, ${JSON.stringify(mb[0]?.knock)}`);
const tickK = seen(kb, 'house', A).last;
ok('the ticks carry it lying there', tickK?.lie === k.lie && Math.abs(tickK.x - k.x) < 0.02, JSON.stringify(tickK));
// Carol joins afterwards: her welcome has it lying where it lies.
const c = await guest('Carol');
const cw = c.log.find((m) => m.t === 'welcome')?.bikes?.find((x) => x.id === 'house');
ok('Carol, joining later, gets it lying there', cw && cw.lie === k.lie && Math.abs(cw.x - k.x) < 0.02 && Math.abs(cw.z - k.z) < 0.02, JSON.stringify(cw));

// Forged: car states claiming a place the speed budget doesn't allow (the church's rack, 900 m off), a 'bike' message
// with a place, made-up kinds of message, and Bob on foot with the car flag running over a bike: nothing moves.
const church = BIKES.bikes.church1.park;
const [fa, fb] = [a.log.length, b.log.length];
a.x = church.x;
a.z = church.z;
a.state({ s: 1 });
await sleep(100);
for (const m of [
  { t: 'bike', op: 'knock', id: 'church1', x: 0, z: 0, lie: 1 }, { t: 'bike', id: 'church2', x: 0, z: 0, lie: -1 },
  { t: 'bikehit', id: 'church3', x: 0, z: 0 }, { t: 'knock', id: 'church1' },
]) b.send(m);
await sleep(1300); // past a keyframe: every bike in a tick at least once a second
const any = [...a.log.slice(fa), ...b.log.slice(fb)].filter((m) => m.t === 'bike');
ok('a car state 900 m off and made-up messages move no bike', any.length === 0, JSON.stringify(any.map((m) => m.bike.id)));
const ticks = seen(fb, 'church1', A).bikes.concat(seen(fb, 'church2', A).bikes, seen(fb, 'church3', A).bikes);
ok('the church\'s bikes stand where they stood', ticks.length > 0 && ticks.every((t) => !t.lie && Math.hypot(t.x - church.x, t.z - church.z) < 1.6), JSON.stringify(ticks.at(-1)));
// Back to the street (in steps the budget allows, never near a bike), then Bob on foot over the lying bike with d: true.
a.x = left.x + 60;
a.z = left.z;
for (let i = 0; i < 40; i++) {
  a.state({ s: 0 });
  await sleep(60);
}
await b.go(-1.6, 19, RUN * 0.9);
await b.go(k.x - 3, k.z, RUN * 0.9);
const lf = b.log.length;
await b.go(k.x + 3, k.z, RUN * 0.9, { d: true, s: 1 });
await sleep(300);
ok('Bob on foot with the car flag forged knocks nothing', knocked(b.log, lf).length === 0);

// Bob gets on the lying bike (it stands up), and Alice drives through him at 40 km/h: a ridden bike is never knocked.
await b.go(k.x + 1, k.z, RUN * 0.9);
await sleep(350);
b.send({ t: 'bike', op: 'on', id: 'house' });
await sleep(400);
ok('Bob gets on the lying bike and it stands', b.log.some((m) => m.t === 'bike' && m.bike.id === 'house' && m.bike.rider === B && m.bike.lie === 0));
const rf = b.log.length;
await drive(k.x - 20, k.z, 30);
await sleep(400);
await drive(k.x + 20, k.z, 40 / 3.6);
await sleep(300);
ok('a ridden bike is never knocked; Bob rides on', knocked(b.log, rf).length === 0 && seen(rf, 'house', A).last?.rider === B);
b.send({ t: 'bike', op: 'off' });
a.send({ t: 'car', op: 'out' });
await sleep(300);

for (const p of [a, b, c]) p.ws.close();
await sleep(200);
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
