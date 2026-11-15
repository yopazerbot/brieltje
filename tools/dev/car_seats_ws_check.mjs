// The cars' seats against a throwaway game server (a build of this branch, server/carSeats.mjs): a driver, a passenger,
// a third player with a gun and a walker, and the admin for the party games. Every forged message from a seat must
// change nothing: a passenger's own position (pinned to the car), hits on and from the car, a grenade's blast at it,
// a pickup, a cat, a clown and villagers from a seat, a forged leap after getting out. Honest play still works: the
// passenger rides along, gets out beside the car and back in. Out, two hits and back in at once: refused, either seat,
// for 10 s after hitting or being hit (the page told why). A walker's forged rise is held to the climbing budget, an
// honest one taken whole. The treasure hunt's coins from a car: none (on foot:
// counted); tag from a car: none, being tagged in it: yes. A car standing inside a code-locked home: no guest gets in.
//
//   ADMIN_PASSWORD=... node tools/dev/car_seats_ws_check.mjs --api http://localhost:8310
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { readCar, readPlayer } from '../../web/shared/wire.mjs';
import CARS from '../../web/shared/car.json' with { type: 'json' };
import PICKUPS from '../../web/shared/pickups.json' with { type: 'json' };
import { homeAt } from '../../web/shared/homes.mjs';
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
const SPEC = CARS.cars.tesla;
const SIDE = SPEC.width / 2 + 0.45; // the page's exit spot: half the width and 45 cm (src/world/car.ts exitSpot)

/** Everyone the server has, as one page's ticks show them; and the Tesla. */
const world = { players: new Map(), car: null };
const connect = async (cookie, watch = false, into = world) => {
  const log = [];
  const ws = new WebSocket(`ws://${host}/ws?v=2`, { headers: { Cookie: cookie, Origin: o.api } });
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 'ping') return ws.send(JSON.stringify({ t: 'pong', n: m.n }));
    if (m.t === 's') {
      if (!watch) return;
      for (const e of m.p ?? []) into.players.set(String(e[0]), readPlayer(e));
      for (const e of m.c ?? []) if (e[0] === 'tesla') into.car = readCar(e);
      return;
    }
    log.push(m);
  });
  await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)));
  await sleep(600);
  const welcome = log.find((m) => m.t === 'welcome');
  const me = { cookie, ws, log, welcome, name: welcome?.you, x: 4.5, y: -0.1, z: 19, armed: true, send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)) };
  me.state = (extra = {}) => me.send({ t: 'state', x: me.x, y: me.y, z: me.z, yaw: 0, pitch: 0, armed: me.armed, w: 'pistol', ct: Date.now(), ...extra });
  /** Walk (or drive) to (x, z) at `speed` m/s, twenty states a second. */
  me.go = async (x, z, speed = 4) => {
    for (;;) {
      const d = Math.hypot(x - me.x, z - me.z);
      const step = Math.min(d, speed / 20);
      if (d > 1e-6) {
        me.x += ((x - me.x) / d) * step;
        me.z += ((z - me.z) / d) * step;
      }
      me.state();
      await sleep(50);
      if (d <= step) return;
    }
  };
  /**
   * Walk to (x, z) round the main house's east side (no way through a code-locked home), at a jog, on the ground (-0.1:
   * the yard's height; a gathering may have put them on the roof terrace, and a car is entered only at its own height).
   */
  me.walk = async (x, z) => {
    me.sync();
    me.y = -0.1;
    if (Math.min(me.x, x) < 9.5 && Math.min(me.z, z) < 12.5) {
      await me.go(12, me.z, RUN * 0.9);
      await me.go(12, z, RUN * 0.9);
    }
    await me.go(x, z, RUN * 0.9);
    for (let i = 0; i < 10; i++) {
      me.state(); // held there while the server's budget catches up with the page
      await sleep(50);
    }
    me.sync();
  };
  /** Where the server has me now (from the watcher's ticks), copied into my own page's idea of it. */
  me.sync = () => {
    const p = world.players.get(me.name);
    if (p) Object.assign(me, { x: p.x, y: p.y, z: p.z });
    return p;
  };
  return me;
};
const guest = async (name, watch = false) => connect(cookieOf((await call('POST', '/api/join', { name, age: true })).r), watch);

// The admin's own ticks: a car inside a code-locked home is out of every guest's sight, so only these still show it.
const adminWorld = { players: new Map(), car: null };
const admin = await connect(cookieOf((await call('POST', '/api/login', { username: 'admin', password })).r), true, adminWorld);
admin.armed = false;
admin.send({ t: 'rules', parachute: false }); // a party game's gathering by parachute would take long
const gun = await guest('Gunner', true);
const dr = await guest('Driver');
const pa = await guest('Rider');
const wa = await guest('Walker', true); // a second watcher: a page's ticks may leave out its own player
const all = [admin, gun, dr, pa, wa];
const seen = (c) => world.players.get(c.name);
const carSeen = () => world.car;
const since = (c, from, pred) => c.log.slice(from).some(pred);
const keepAlive = setInterval(() => admin.state(), 400);

/** The car stands at `car`: everyone walks next to it (each to their own spot), the driver and the passenger get in. */
const board = async (car = carSeen() ?? SPEC.park) => {
  await Promise.all([dr.walk(car.x - 1.5, car.z), pa.walk(car.x + 1.5, car.z + 0.5)]);
  dr.send({ t: 'car', op: 'in', id: 'tesla' });
  await sleep(350);
  pa.send({ t: 'car', op: 'in', id: 'tesla' });
  await sleep(400);
  const now = [...dr.log].reverse().find((m) => m.t === 'car' && m.car.id === 'tesla')?.car;
  Object.assign(dr, { x: now?.x ?? car.x, y: now?.y ?? car.y, z: now?.z ?? car.z }); // the driver's page sends the car's pose
  Object.assign(pa, { x: dr.x, y: dr.y, z: dr.z });
  dr.state({ d: 1 });
  pa.state({ d: 1 });
  await sleep(300);
  return now;
};

// The street start to the Tesla in the carport.
for (const c of all) c.state();
await sleep(400);
const c0 = await board();
ok('driver and passenger in', c0?.driver === dr.name && c0?.passenger === pa.name, JSON.stringify({ driver: c0?.driver, passenger: c0?.passenger }));
await Promise.all([gun.go(c0.x + 6, c0.z + 4), wa.go(c0.x + 0.5, c0.z + 3.4)]);
for (let i = 0; i < 50; i++) {
  dr.state();
  pa.state();
  gun.state();
  wa.state();
  await sleep(50); // protection over (2 s after joining)
}

// 1. The passenger runs off while the car stands: 6 s of states 300 m off (71 m/s on main).
{
  const from = { ...carSeen() };
  let most = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    pa.send({ t: 'state', x: pa.x + (Date.now() - t0 < 3000 ? 300 : -300), y: pa.y + 20, z: pa.z - 40, yaw: 0.7, pitch: 0, armed: true, w: 'pistol' });
    dr.state();
    await sleep(40);
    const p = seen(pa);
    if (p) most = Math.max(most, Math.hypot(p.x - from.x, p.z - from.z));
  }
  await sleep(300);
  const p = seen(pa), car = carSeen();
  ok('1. a passenger\'s forged position: they stay where the car is', most < 0.05 && Math.hypot(car.x - from.x, car.z - from.z) < 0.05, `furthest from the car ${most.toFixed(2)} m; the car moved ${Math.hypot(car.x - from.x, car.z - from.z).toFixed(2)} m; seen in it: ${p?.d}`);
}

// 2. Hits on and from the car, at 3 to 7 m.
{
  const n = pa.log.length, m = dr.log.length, g = gun.log.length;
  for (const target of [pa.name, dr.name, pa.name]) {
    gun.send({ t: 'hit', target, w: 'pistol', body: 1, head: 0 });
    await sleep(300);
  }
  ok('2. pistol hits at the passenger and the driver: nothing lands', !since(pa, n, (x) => x.t === 'hurt' || x.t === 'kill') && !since(dr, m, (x) => x.t === 'hurt'));
  pa.send({ t: 'hit', target: gun.name, w: 'pistol', body: 1, head: 0 });
  dr.send({ t: 'hit', target: gun.name, w: 'pistol', body: 1, head: 0 });
  await sleep(300);
  ok('   hits from the seats: nothing lands', !since(gun, g, (x) => x.t === 'hurt'));
  // A control on foot: the same hit at the walker lands.
  const w = wa.log.length;
  await sleep(300);
  gun.send({ t: 'hit', target: wa.name, w: 'pistol', body: 1, head: 0 });
  await sleep(300);
  ok('   control: the same hit at the walker on foot lands', since(wa, w, (x) => x.t === 'hurt'));
}

// 3. A grenade's blast at the car: the two in it are spared, the walker beside it is not.
{
  const n = pa.log.length, m = dr.log.length, w = wa.log.length;
  const car = carSeen();
  gun.send({ t: 'nade', x: gun.x, y: gun.y + 1.5, z: gun.z, vx: (car.x - gun.x) / 1.2, vy: 3, vz: (car.z - gun.z) / 1.2 });
  for (let i = 0; i < 50; i++) {
    for (const c of [dr, pa, gun, wa]) c.state();
    await sleep(50);
  }
  gun.send({ t: 'boom', x: car.x + 0.3, y: car.y + 0.5, z: car.z + 1.6, cover: [] });
  await sleep(500);
  const hurt = [...pa.log.slice(n), ...dr.log.slice(m)].filter((x) => x.t === 'hurt' || (x.t === 'kill' && (x.victim === pa.name || x.victim === dr.name)));
  ok('3. a grenade at the car: neither in it is hurt', hurt.length === 0, JSON.stringify(hurt).slice(0, 200));
  ok('   control: the walker beside the car is', since(wa, w, (x) => x.t === 'hurt') || admin.log.some((x) => x.t === 'kill' && x.victim === wa.name));
}

// 4. A pickup, a cat, a clown and villagers from a seat: the car driven onto the carport's rifle.
{
  const spot = PICKUPS[0];
  await dr.go(spot.x, spot.z, 5);
  for (let i = 0; i < 6; i++) {
    dr.state();
    pa.state();
    await sleep(50);
  }
  const n = admin.log.length;
  pa.send({ t: 'pickup', i: 0 });
  dr.send({ t: 'pickup', i: 0 });
  pa.send({ t: 'cat', i: 0, w: 'pistol' });
  dr.send({ t: 'clownhit', id: admin.welcome.clowns?.[0]?.id ?? 1, w: 'pistol' });
  pa.send({ t: 'vil', ids: [0, 1], w: 'pistol' });
  await sleep(500);
  const got = [...new Set(admin.log.slice(n).map((x) => x.t))].filter((t) => ['item', 'cat', 'clownhit', 'vil'].includes(t));
  ok('4. pickup, cat, clownhit and vil from the seats: nothing', got.length === 0, JSON.stringify(got));
}

// 5. Out beside the car, a forged leap after it, and back in.
{
  const car = carSeen();
  pa.send({ t: 'car', op: 'out' });
  await sleep(300);
  const p = seen(pa);
  const d = Math.hypot(p.x - car.x, p.z - car.z);
  // By their door, else (a wall the server knows there) the other door, behind or in front: as the page picks.
  const spots = [Math.hypot(SIDE, 0.3), SPEC.length / 2 + 0.5];
  ok('5. out: beside the car, on foot', spots.some((s) => Math.abs(d - s) < 0.3) && !p.d, `${d.toFixed(2)} m from its middle`);
  pa.sync();
  const from = { x: pa.x, z: pa.z };
  pa.send({ t: 'state', x: pa.x + 60, y: pa.y, z: pa.z, yaw: 0, pitch: 0, armed: true, w: 'pistol' });
  await sleep(300);
  const q = seen(pa);
  ok('   a forged 60 m step after getting out', Math.hypot(q.x - from.x, q.z - from.z) < 3, `${Math.hypot(q.x - from.x, q.z - from.z).toFixed(2)} m taken`);
  pa.sync();
  await pa.go(car.x + 1.5, car.z, RUN * 0.9);
  pa.send({ t: 'car', op: 'in', id: 'tesla' });
  await sleep(400);
  ok('   back in', [...pa.log].reverse().find((m) => m.t === 'car' && m.car.id === 'tesla')?.car.passenger === pa.name);
  // And the honest ride: driving 20 m at 8 m/s takes the passenger along.
  Object.assign(pa, { x: dr.x, y: dr.y, z: dr.z });
  const start = { ...carSeen() };
  const ride = (async () => {
    for (let i = 0; i < 60; i++) {
      pa.state();
      await sleep(50);
    }
  })();
  await dr.go(dr.x + 6, dr.z + 18, 8);
  await ride;
  await sleep(300);
  const c = carSeen(), r = seen(pa);
  ok('   the passenger rides along', Math.hypot(c.x - start.x, c.z - start.z) > 15 && Math.hypot(r.x - c.x, r.z - c.z) < 0.05, `the car went ${Math.hypot(c.x - start.x, c.z - start.z).toFixed(1)} m, the passenger ${Math.hypot(r.x - c.x, r.z - c.z).toFixed(2)} m from it`);
}

// 5b. Out, two hits, back in 0.42 s later (damage avoidance): no seat within 10 s of hitting or of being hit, the page
// told why (the helicopter's code); the passenger's seat the same. Ten seconds on, both get in again.
{
  dr.send({ t: 'car', op: 'out' });
  pa.send({ t: 'car', op: 'out' });
  await sleep(300);
  dr.sync();
  pa.sync();
  for (let i = 0; i < 6; i++) {
    for (const c of [dr, pa, gun]) c.state();
    await sleep(50);
  }
  const g = gun.log.length, d = dr.log.length, p = pa.log.length;
  dr.send({ t: 'hit', target: gun.name, w: 'pistol', body: 1, head: 0 });
  await sleep(250);
  dr.send({ t: 'hit', target: gun.name, w: 'pistol', body: 1, head: 0 });
  await sleep(170);
  dr.send({ t: 'car', op: 'in', id: 'tesla' });
  await sleep(400);
  const hits = gun.log.slice(g).filter((x) => x.t === 'hurt').length;
  ok('5b. out, two hits, back in 0.42 s later: refused, and told why', hits === 2 && carSeen()?.driver !== dr.name && since(dr, d, (x) => x.t === 'system' && x.code === 'heliFight'), `${hits} hits landed; at the wheel: ${carSeen()?.driver}`);
  gun.send({ t: 'hit', target: pa.name, w: 'pistol', body: 1, head: 0 });
  await sleep(300);
  pa.send({ t: 'car', op: 'in', id: 'tesla' });
  await sleep(400);
  ok('   hit beside the car: not into the passenger\'s seat either', since(pa, p, (x) => x.t === 'hurt') && carSeen()?.passenger !== pa.name && since(pa, p, (x) => x.t === 'system' && x.code === 'heliFight'));
  for (let i = 0; i < 205; i++) { // ten seconds on
    for (const c of [dr, pa, gun]) c.state();
    await sleep(50);
  }
  dr.send({ t: 'car', op: 'in', id: 'tesla' });
  await sleep(350);
  pa.send({ t: 'car', op: 'in', id: 'tesla' });
  await sleep(400);
  ok('   control: ten seconds on, both get in again', carSeen()?.driver === dr.name && carSeen()?.passenger === pa.name, JSON.stringify({ driver: carSeen()?.driver, passenger: carSeen()?.passenger }));
  Object.assign(dr, carSeen() ? { x: carSeen().x, y: carSeen().y, z: carSeen().z } : {});
  Object.assign(pa, { x: dr.x, y: dr.y, z: dr.z });
}

// 5c. Rising on foot (position forgery): states 1 m higher every 50 ms (20 m/s) for 3 s, not flying. Before, the server
// took 16 m/s of it (a walker on the ground was at 56 m after 3 s); now at most the climbing budget (server/game.mjs
// FOOT_RISE: 5 m stored and 3 m/s). Back down at a fall's pace; then an honest sprint up a stair, 2.9 m in a second, whole.
{
  wa.sync();
  const y0 = wa.y;
  for (let k = 1; k <= 60; k++) {
    wa.send({ t: 'state', x: wa.x, y: y0 + k, z: wa.z, yaw: 0, pitch: 0, armed: true, w: 'pistol' });
    dr.state();
    pa.state();
    await sleep(50);
  }
  await sleep(300);
  const up = (seen(wa)?.y ?? y0) - y0;
  ok('5c. forged states rising at 20 m/s for 3 s, on foot: held to the climbing budget', up <= 5 + 3 * 3.4 + 0.5, `${up.toFixed(2)} m up (it was 56)`);
  for (let k = 0; k < 40; k++) {
    wa.send({ t: 'state', x: wa.x, y: y0, z: wa.z, yaw: 0, pitch: 0, armed: true, w: 'pistol' });
    await sleep(50);
  }
  const down = (seen(wa)?.y ?? 0) - y0;
  for (let k = 1; k <= 20; k++) {
    wa.send({ t: 'state', x: wa.x, y: y0 + (2.9 * k) / 20, z: wa.z, yaw: 0, pitch: 0, armed: true, w: 'pistol' });
    await sleep(50);
  }
  await sleep(300);
  const stair = (seen(wa)?.y ?? y0) - y0;
  ok('   control: back down, then a sprint up a stair (2.9 m in a second) taken whole', Math.abs(down) < 0.05 && Math.abs(stair - 2.9) < 0.05, `down to ${down.toFixed(2)} m, then ${stair.toFixed(2)} m up`);
  for (let k = 0; k < 10; k++) {
    wa.send({ t: 'state', x: wa.x, y: y0, z: wa.z, yaw: 0, pitch: 0, armed: true, w: 'pistol' });
    await sleep(50);
  }
  wa.sync();
}

// 6. The treasure hunt: nobody collects from the car; on foot the same coin counts.
{
  admin.send({ t: 'mode', kind: 'treasure' });
  await sleep(1500);
  const view = [...admin.log].reverse().find((m) => m.t === 'mode')?.mode;
  ok('6. a treasure hunt', view?.kind === 'treasure' && view.coins?.length === 15, `${view?.coins?.length} coins`);
  for (const c of all) c.sync();
  const car = await board();
  ok('   driver and passenger in again', car?.driver === dr.name && car?.passenger === pa.name);
  let tried = 0;
  for (const coin of view.coins.filter((q) => q.y < 1)) {
    Object.assign(dr, { x: carSeen().x, z: carSeen().z }); // from where the server has the car (a home's wall may have held it)
    await dr.go(coin.x, coin.z, 12);
    Object.assign(pa, { x: dr.x, y: dr.y, z: dr.z });
    for (let i = 0; i < 4; i++) {
      dr.state();
      pa.state();
      await sleep(50);
    }
    if (Math.hypot(carSeen().x - coin.x, carSeen().z - coin.z) > 0.5) continue; // the car never got there: no test of the seat
    dr.send({ t: 'coin', i: coin.i });
    pa.send({ t: 'coin', i: coin.i });
    await sleep(120);
    tried++;
  }
  await sleep(400);
  const after = [...admin.log].reverse().find((m) => m.t === 'mode')?.mode;
  ok('   coins from the car', tried >= 3 && (after.counts?.[dr.name] ?? 0) + (after.counts?.[pa.name] ?? 0) === 0 && after.coins.length === 15, `${tried} coins driven onto and asked for from both seats, ${after.coins.length} left`);
  const coin = after.coins.find((q) => q.y < 1);
  wa.sync();
  await wa.walk(coin.x, coin.z);
  for (let i = 0; i < 4; i++) {
    wa.state();
    await sleep(50);
  }
  wa.send({ t: 'coin', i: coin.i });
  await sleep(400);
  const last = [...admin.log].reverse().find((m) => m.t === 'mode')?.mode;
  ok('   control: on foot the same kind of coin counts', last.counts?.[wa.name] === 1);
  admin.send({ t: 'mode', kind: 'free' });
  await sleep(500);
}

// 7. Tag: from the car never; in the car one can be tagged.
{
  admin.send({ t: 'mode', kind: 'tag' });
  await sleep(1500);
  let view = [...admin.log].reverse().find((m) => m.t === 'mode')?.mode;
  ok('7. a game of tag', view?.kind === 'tag', `${view?.it} is it`);
  for (const c of all) c.sync();
  const car = await board();
  ok('   driver and passenger in for the game', car?.driver === dr.name && car?.passenger === pa.name);
  const foot = all.filter((c) => c !== dr && c !== pa);
  const itIs = () => [...admin.log].reverse().find((m) => m.t === 'mode')?.mode?.it;
  // Everyone on foot next to the passenger's door (within the tag's 1.8 m of the car's middle).
  for (const c of foot) c.sync();
  await Promise.all(foot.map((c, i) => c.walk(car.x + 1.3, car.z + (i - 1.5) * 0.4)));
  let it = itIs();
  const runner = all.find((c) => c.name === it);
  if (runner === dr || runner === pa) {
    runner.send({ t: 'tag', target: wa.name });
    await sleep(400);
    ok('   "it" in the car tags a walker beside it: refused', itIs() === it);
    // Out and on foot, the same tag passes it on; then the walker tags the one still in the car.
    runner.send({ t: 'car', op: 'out' });
    await sleep(300);
    runner.sync();
    wa.sync();
    await runner.go(wa.x, wa.z + 0.8, RUN * 0.9);
    for (let i = 0; i < 10; i++) {
      runner.state(); // held there while the server's budget catches up with the page
      await sleep(50);
    }
    runner.send({ t: 'tag', target: wa.name });
    await sleep(400);
    ok('   control: on foot it is passed on', itIs() === wa.name);
    const sitter = runner === dr ? pa : dr;
    wa.send({ t: 'tag', target: sitter.name });
    await sleep(400);
    const [ws, ss] = [seen(wa), seen(sitter)];
    ok('   someone in the car is tagged', itIs() === sitter.name, `${itIs()} is it; ${Math.hypot(ws.x - ss.x, ws.z - ss.z).toFixed(2)} m apart, ${(ws.y - ss.y).toFixed(2)} m up`);
  } else {
    runner.send({ t: 'tag', target: pa.name });
    await sleep(400);
    ok('   the passenger in the car is tagged', itIs() === pa.name, `by ${it}`);
    await sleep(3200); // no tag straight back
    pa.send({ t: 'tag', target: runner.name });
    pa.send({ t: 'tag', target: foot.find((c) => c !== runner).name });
    await sleep(400);
    ok('   "it" in the car tags a walker beside it: refused', itIs() === pa.name);
  }
  admin.send({ t: 'mode', kind: 'free' });
  await sleep(400);
}

// 8. A car standing inside a code-locked home (the admin, who may enter every home, drives it in, as a code's holder with a
// changed page could): a guest within reach outside can't get in, so no way in through it.
{
  for (const c of [dr, pa]) c.send({ t: 'car', op: 'out' });
  await sleep(400);
  // A point inside the main house with an outside point 2.5 m east of it (the guest's spot).
  let inside = null;
  for (let x = 8.8; x > 0 && !inside; x -= 0.25) for (let z = -2; z < 11.5 && !inside; z += 0.25) if (homeAt(x, z, -0.05) === 'house' && homeAt(x + 2.5, z, -0.05) === null && homeAt(x + 1, z, -0.05) === 'house') inside = { x, z };
  ok('8. a point inside the main house by its east wall', !!inside, JSON.stringify(inside));
  const car = carSeen();
  admin.sync();
  await admin.walk(car.x - 1.5, car.z);
  admin.send({ t: 'car', op: 'in', id: 'tesla' });
  await sleep(400);
  Object.assign(admin, { x: car.x, y: car.y, z: car.z });
  admin.sync = () => null; // inside the home the guests' ticks no longer show the admin: keep the script's own idea of the place
  await admin.walk(inside.x, inside.z); // at the wheel: the car goes along (round the house's east side)
  await sleep(400);
  const parked = adminWorld.car ?? carSeen();
  ok('   the admin drove the car into the house', homeAt(parked.x, parked.z, parked.y) === 'house', JSON.stringify({ x: parked.x, z: parked.z }));
  admin.send({ t: 'car', op: 'out' });
  await sleep(400);
  wa.sync();
  await wa.walk(inside.x + 2.5, inside.z);
  const n = wa.log.length;
  wa.send({ t: 'car', op: 'in', id: 'tesla' });
  await sleep(500);
  const got = [...wa.log.slice(n)].reverse().find((m) => m.t === 'car' && m.car.id === 'tesla')?.car;
  const w = seen(wa);
  ok('   a guest outside within reach: not let in', got?.driver !== wa.name && got?.passenger !== wa.name && homeAt(w.x, w.z, w.y) === null, `${Math.hypot(w.x - parked.x, w.z - parked.z).toFixed(1)} m from the car, told ${JSON.stringify({ driver: got?.driver, passenger: got?.passenger })}`);
}

clearInterval(keepAlive);
for (const c of all) c.ws.close();
await sleep(300);
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
