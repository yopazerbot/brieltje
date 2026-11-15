import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { KNOCK, knockBike, sweptHit } from '../shared/bikeKnock.mjs';
import { loadBounds } from '../shared/bounds.mjs';
import { homeAt } from '../shared/homes.mjs';
import { PORTALS } from '../shared/portals.mjs';
import { readBike } from '../shared/wire.mjs';
import { Game } from './game.mjs';

// A car that drives into a bike nobody rides knocks it over or throws it aside (server/bikeHits.mjs, shared/bikeKnock.mjs).
// The server finds the hit itself in the driver's states; no message of a page's moves a bike. A fake clock drives both the
// server's own clock (performance.now) and the wall clock, so the real movement budget and the real stamps (stampState) run
// as on the server; this file runs in a process of its own, so the clock touches no other test.

let T = 1_000_000;
const BASE = 1_800_000_000_000;
Date.now = () => BASE + T;
performance.now = () => T;
const wait = (ms) => (T += ms);

const BIKES = JSON.parse(readFileSync(new URL('../shared/bike.json', import.meta.url), 'utf8'));
const CAR = JSON.parse(readFileSync(new URL('../shared/car.json', import.meta.url), 'utf8')).cars.tesla;
const CAR_BOX = { halfL: CAR.length / 2, halfW: CAR.width / 2 };
const BIKE_BOX = { halfL: BIKES.length / 2, halfW: BIKES.width / 2 };
const VILLAGE = JSON.parse(readFileSync(new URL('../src/data/village.json', import.meta.url), 'utf8'));
const BOUNDS = loadBounds(JSON.parse(readFileSync(new URL('../shared/bounds.json', import.meta.url), 'utf8')));
const SPAWNS = JSON.parse(readFileSync(new URL('../shared/spawns.json', import.meta.url), 'utf8'));
/** The road in front of the house, along x: the car drives along -x (yaw pi / 2), the bike stands in its way. */
const ROAD = { x: 40, z: 22.5, yaw: Math.PI / 2 };

/** A game with a fake page per player (the real stampState, budgets and rate limits), and the church's first bike on the road. */
function onRoad() {
  const game = new Game({ session: () => null, store: { addStats: async () => {} } }, []);
  const told = [];
  game.broadcast = (m, except) => told.push({ ...JSON.parse(JSON.stringify(m)), except });
  game.send = () => {};
  const y = game.bikeHits.env.ground(ROAD.x, ROAD.z);
  const bike = game.bikes.church1;
  Object.assign(bike, { x: ROAD.x, y, z: ROAD.z, yaw: ROAD.yaw });
  const car = game.cars.tesla;
  Object.assign(car, { x: ROAD.x + 30, y, z: ROAD.z, yaw: ROAD.yaw });
  const player = (name, at = { x: car.x + 1.5, y, z: car.z + 1.5 }, role = 'player') => {
    const now = Date.now();
    const p = {
      ws: { name }, key: `k-${name}`, role, alive: true, protectedUntil: 0, drop: null, warp: 0, stamp: 0, ctGap: null, ctAt: 0,
      state: { x: at.x, y: at.y, z: at.z, yaw: 0, pitch: 0, armed: false, flying: false, w: 'pistol', c: false },
      weapons: new Set(['pistol']), nades: [0, 0], window: now, msgs: 0, states: 0, others: 0, budget: 0.5, vbudget: 0.5, movedAt: now,
      hp: 100, score: { kills: 0, deaths: 0, points: 0 }, joinTime: now,
    };
    game.players.set(name, p);
    return p;
  };
  const send = (name, p, m) => game.handle(name, p, JSON.stringify(m));
  /** A state of `name`'s page `ms` after the last, its own clock (`ct`) going along with ours unless given. */
  const state = (name, p, x, z = ROAD.z, ms = 33, extra = {}) => {
    wait(ms);
    send(name, p, { t: 'state', x, y, z, yaw: ROAD.yaw, pitch: 0, armed: false, w: 'pistol', ct: T, ...extra });
  };
  /** `name` gets in the Tesla where it stands (next to it, as the server asks), sits a second, sending states. */
  const driver = (name, x = car.x) => {
    car.x = x;
    const p = player(name);
    p.nextCar = 0;
    send(name, p, { t: 'car', op: 'in', id: 'tesla' });
    assert.equal(car.driver, name, 'at the wheel');
    for (let i = 0; i < 30; i++) state(name, p, car.x);
    return p;
  };
  /** Drive from where the car is to x1 at `kmh` along the road, a state every 33 ms; the car's place before each. */
  const run = (name, p, x1, kmh, z = ROAD.z, extra = {}) => {
    const step = (kmh / 3.6) * 0.033;
    const before = [];
    for (let x = car.x - step; x >= x1; x -= step) {
      before.push({ x: car.x, z: car.z, yaw: car.yaw });
      state(name, p, x, z, 33, extra);
    }
    return before;
  };
  /** A run-up long enough for the server's two speed windows (600 ms), the car stopping `to` m past the bike. */
  const runUp = (kmh) => ROAD.x + Math.max(6, (kmh / 3.6) * 0.75 + 3.5);
  const knocks = () => told.filter((m) => m.t === 'bike' && m.knock);
  const still = (k, at) => assert.ok(k.x === at.x && k.z === at.z && !k.lie, `${k.id} did not move: ${JSON.stringify(k)}`);
  const thrown = (m) => Math.hypot(m.bike.x - ROAD.x, m.bike.z - ROAD.z);
  return { game, told, bike, car, y, player, send, state, driver, run, runUp, knocks, still, thrown };
}

test('a car driven into a free bike knocks it aside: one message for everyone, on its side, at most 8 m, where the shared sums put it', () => {
  for (const kmh of [8, 40, 100]) {
    const { game, bike, car, driver, run, runUp, knocks } = onRoad();
    const anna = driver('anna', runUp(kmh));
    const from = { x: bike.x, z: bike.z, yaw: bike.yaw };
    // The speed the server took for each state, and the car's place before it.
    const seen = [];
    const speedOf = game.bikeHits.speedOf.bind(game.bikeHits);
    game.bikeHits.speedOf = (c, n, before, now) => {
      const v = speedOf(c, n, before, now);
      seen.push({ before: { ...before }, to: { x: c.x, z: c.z, yaw: c.yaw }, v });
      return v;
    };
    run('anna', anna, ROAD.x - 10, kmh);
    const got = knocks();
    assert.equal(got.length, 1, `${kmh} km/h: one knock`);
    const m = got[0];
    assert.equal(m.except, undefined, 'to every page, the driver\'s too');
    assert.ok(m.bike.lie === 1 || m.bike.lie === -1, 'on its side');
    const dist = Math.hypot(m.bike.x - from.x, m.bike.z - from.z);
    assert.ok(kmh < 10 ? dist <= 0.41 : dist > 2 && dist <= 8, `${kmh} km/h: ${dist} m`);
    assert.ok(Math.abs(m.knock.v - kmh / 3.6) < 0.06, `the car's own speed after a run-up: ${m.knock.v} m/s`);
    // The same as the shared sums on the server's own places and speed.
    const hit = seen.find((s) => sweptHit(CAR_BOX, s.before, s.to, { ...from, ...BIKE_BOX }));
    const at = sweptHit(CAR_BOX, hit.before, hit.to, { ...from, ...BIKE_BOX });
    const d = Math.hypot(hit.to.x - hit.before.x, hit.to.z - hit.before.z);
    const want = knockBike(from, at, ((hit.to.x - hit.before.x) / d) * hit.v, ((hit.to.z - hit.before.z) / d) * hit.v, (x, z, yaw) => game.bikeHits.spotOk(x, z, yaw, 'tesla'));
    assert.ok(Math.abs(want.x - m.bike.x) < 1e-9 && Math.abs(want.z - m.bike.z) < 1e-9 && want.lie === m.bike.lie && want.yaw === m.bike.yaw, `${JSON.stringify(want)} vs ${JSON.stringify(m.bike)}`);
    assert.equal(bike.y, game.bikeHits.env.ground(bike.x, bike.z), 'on the ground where it lies');
    assert.ok(game.bikeHits.spotOk(bike.x, bike.z, bike.yaw, 'tesla'), 'where it may lie');
  }
});

test('a lurch from a standstill, stamps squeezed together, a full-budget jump or the first state at the wheel buy no throw', () => {
  const most = KNOCK.base + KNOCK.per * KNOCK.gain + 1e-9; // what KNOCK.gain m/s throws
  // From a standstill 3.4 m from the bike, one state 1.4 m on 40 ms later (35 m/s by those two states).
  {
    const { car, driver, state, knocks, thrown } = onRoad();
    const p = driver('mallory', ROAD.x + 3.4);
    state('mallory', p, car.x - 1.4, ROAD.z, 40);
    assert.equal(knocks().length, 1);
    assert.ok(thrown(knocks()[0]) <= most && knocks()[0].knock.v <= KNOCK.gain, `a lurch: ${JSON.stringify(knocks()[0].knock)}, ${thrown(knocks()[0])} m`);
  }
  // Creeping at 1.5 m/s with the page's clock standing still (each stamp the last + 1 ms): a tip, as the creep is.
  {
    const { car, driver, state, knocks, thrown } = onRoad();
    const p = driver('mallory', ROAD.x + 3.4);
    for (let i = 0; i < 40 && !knocks().length; i++) state('mallory', p, car.x - 0.075, ROAD.z, 50, { ct: 5000 });
    assert.equal(knocks().length, 1);
    assert.ok(thrown(knocks()[0]) <= KNOCK.near + 1e-9 && knocks()[0].knock.v < KNOCK.tip, `squeezed stamps: ${JSON.stringify(knocks()[0].knock)}`);
  }
  // Standing half a second (the budget full: about 34 m), then one jump through the bike.
  {
    const { car, driver, state, knocks, thrown } = onRoad();
    const p = driver('mallory', ROAD.x + 20);
    for (let i = 0; i < 15; i++) state('mallory', p, car.x);
    state('mallory', p, ROAD.x - 20);
    assert.ok(car.x < ROAD.x - 5, `the jump the budget allows: to ${car.x}`);
    assert.equal(knocks().length, 1);
    assert.ok(thrown(knocks()[0]) <= most, `a full-budget jump: ${thrown(knocks()[0])} m`);
  }
  // Bob gets into a car Alice left (the trail starts again for him): his first state, a jump, buys no throw either.
  {
    const { game, car, driver, player, send, state, knocks, thrown } = onRoad();
    const a = driver('alice', ROAD.x + 30);
    for (let x = car.x; x > ROAD.x + 22; x -= 0.9) state('alice', a, x); // driving at 27 m/s
    send('alice', a, { t: 'car', op: 'out' });
    wait(450);
    const b = player('bob', { x: car.x + 1, y: car.y, z: car.z + 1.5 });
    b.nextCar = 0;
    send('bob', b, { t: 'car', op: 'in', id: 'tesla' });
    assert.equal(car.driver, 'bob');
    state('bob', b, ROAD.x - 20, ROAD.z, 1);
    assert.ok(knocks().length <= 1 && (knocks().length === 0 || thrown(knocks()[0]) <= most), `his first state: ${JSON.stringify(knocks()[0]?.knock)}`);
    assert.equal(game.bikeHits.trails.get('tesla').driver, 'bob');
  }
});

test('a car through a wall the server knows knocks nothing: not inside it, not just after it', () => {
  const { game, player, send, state, knocks } = onRoad();
  const env = game.bikeHits.env;
  let tried = 0;
  for (const id of Object.keys(game.bikes)) {
    const b = BIKES.bikes[id].park;
    // A straight way at the bike from 14 m that crosses the server's blocks for at least 1.5 m.
    let way = null;
    for (let a = 0; a < 16 && !way; a++) {
      const ux = Math.cos((a / 16) * 2 * Math.PI);
      const uz = Math.sin((a / 16) * 2 * Math.PI);
      const yaw = Math.atan2(-ux, -uz);
      let wall = 0;
      for (let d = 0; d <= 10; d += 0.5) {
        const x = b.x - ux * 14 + ux * d;
        const z = b.z - uz * 14 + uz * d;
        const gy = env.ground(x, z);
        if (!env.solids.boxFree(x, z, yaw, CAR_BOX.halfL, CAR_BOX.halfW, gy + 0.3, gy + CAR.height)) wall++;
      }
      if (wall >= 3) way = { ux, uz, yaw };
    }
    if (!way) continue;
    tried++;
    const car = game.cars.tesla;
    const from = { x: b.x - way.ux * 14, z: b.z - way.uz * 14 };
    Object.assign(car, { x: from.x, y: b.y, z: from.z, yaw: way.yaw, driver: null, passenger: null });
    const name = `m-${id}`;
    const p = player(name, { x: from.x + 1, y: b.y, z: from.z });
    p.nextCar = 0;
    send(name, p, { t: 'car', op: 'in', id: 'tesla' });
    for (let d = 0; d <= 20; d += 2) {
      wait(40);
      send(name, p, { t: 'state', x: from.x + way.ux * d, y: b.y, z: from.z + way.uz * d, yaw: way.yaw, pitch: 0, ct: T });
    }
    assert.equal(knocks().filter((m) => m.bike.id === id).length, 0, `${id}: knocked through a wall`);
    send(name, p, { t: 'car', op: 'out' });
    game.players.delete(name);
    wait(2000);
  }
  assert.ok(tried >= 10, `ways through walls found for ${tried} bikes`);
});

test('non-finite, huge and wrong-typed states at the wheel throw nothing and leave every bike and the car finite', () => {
  const { game, car, driver, send, state } = onRoad();
  const p = driver('mallory', ROAD.x + 3.4);
  for (const text of [
    '{"t":"state","x":1e999,"y":1e999,"z":-1e999,"yaw":1e999,"pitch":0,"ct":1e999}', '{"t":"state","x":null,"y":null,"z":null,"yaw":null,"ct":null}',
    '{"t":"state","x":"40","y":"0","z":"22.5","yaw":"1"}', '{"t":"state","x":1e308,"y":-1e308,"z":1e308,"yaw":-1e308,"ct":-1e308}',
    '{"t":"state","x":{"valueOf":1},"z":[1],"yaw":true,"ct":true}', '{"t":"state"}',
    `{"t":"state","x":${ROAD.x + 3.4},"y":0,"z":${ROAD.z},"yaw":99.9,"ct":-5e15}`, `{"t":"state","x":${ROAD.x + 3.4},"y":0,"z":${ROAD.z},"yaw":-99.9,"ct":5e15}`,
  ]) {
    wait(1);
    assert.doesNotThrow(() => game.handle('mallory', p, text));
  }
  for (let i = 0; i < 20; i++) send('mallory', p, { t: 'state', x: car.x - 0.2, y: car.y, z: ROAD.z, yaw: ROAD.yaw, pitch: 0, ct: T });
  state('mallory', p, car.x - 1);
  assert.ok(Object.values(game.bikes).every((b) => [b.x, b.y, b.z, b.yaw].every(Number.isFinite) && [0, 1, -1].includes(b.lie)));
  assert.ok([car.x, car.y, car.z, car.yaw].every(Number.isFinite));
});

test('made-up messages move no bike: a knock, a bike with a place, a bell with a place', () => {
  const { bike, player, send, knocks, still } = onRoad();
  const anna = player('anna', { x: ROAD.x + 1.2, y: bike.y, z: ROAD.z });
  const at = { x: bike.x, z: bike.z };
  for (const m of [
    { t: 'bikehit', id: 'church1', x: 0, z: 0 }, { t: 'knock', id: 'church1', x: 0, z: 0, lie: 1 },
    { t: 'bike', op: 'knock', id: 'church1', x: 0, z: 0, lie: 1 }, { t: 'bike', id: 'church1', x: 0, z: 0, lie: -1 },
    { t: 'bike', op: 'off', id: 'church1', x: 0, z: 0, lie: 1 }, { t: 'bell', id: 'church1', x: 0, z: 0 },
  ]) {
    anna.nextCar = 0;
    send('anna', anna, m);
  }
  send('anna', anna, { t: 'state', x: ROAD.x + 1.2, y: bike.y, z: ROAD.z, yaw: 0, pitch: 0, lie: 1, bike: { id: 'church1', x: 0, z: 0 } });
  still(bike, at);
  assert.equal(knocks().length, 0);
});

test('on foot with the car flag forged, as a passenger, or as the admin on foot: states across a bike knock nothing', () => {
  const { bike, car, player, state, driver, knocks, still } = onRoad();
  const at = { x: bike.x, z: bike.z };
  const walker = player('walker', { x: ROAD.x + 3, y: bike.y, z: ROAD.z });
  for (let x = ROAD.x + 3; x > ROAD.x - 3; x -= 0.15) state('walker', walker, x, ROAD.z, 33, { d: true, s: 1, bk: 1 });
  const admin = player('boss', { x: ROAD.x + 30, y: bike.y, z: ROAD.z }, 'admin');
  for (let x = ROAD.x + 30; x > ROAD.x - 30; x -= 6) state('boss', admin, x, ROAD.z, 33, { d: true });
  still(bike, at);
  driver('bert', ROAD.x + 15);
  car.passenger = 'anna';
  const anna = player('anna', { x: ROAD.x + 15, y: bike.y, z: ROAD.z });
  for (let x = ROAD.x + 15; x > ROAD.x - 10; x -= 1) state('anna', anna, x);
  assert.equal(car.x, ROAD.x + 15, 'the car stays with its driver');
  still(bike, at);
  assert.equal(knocks().length, 0);
});

test('a car standing on a bike, or passing 5 m beside it, knocks nothing', () => {
  const { bike, car, driver, state, run, knocks, still } = onRoad();
  const at = { x: bike.x, z: bike.z };
  const anna = driver('anna', ROAD.x);
  for (let i = 0; i < 20; i++) state('anna', anna, ROAD.x + (i % 2) * 0.01); // creeping on the spot
  still(bike, at);
  for (let x = car.x; x < ROAD.x + 25; x += 1) state('anna', anna, x, ROAD.z + 5);
  run('anna', anna, ROAD.x - 15, 100, ROAD.z + 5);
  still(bike, at);
  assert.equal(knocks().length, 0);
});

test('a ridden bike is never knocked: it stops the car, and its rider rides on', () => {
  const { game, bike, driver, run, runUp, knocks, still } = onRoad();
  bike.rider = 'bert';
  const at = { x: bike.x, z: bike.z };
  const anna = driver('anna', runUp(100));
  run('anna', anna, ROAD.x - 10, 100);
  still(bike, at);
  assert.equal(bike.rider, 'bert');
  assert.equal(game.bikeOf('bert'), bike);
  assert.equal(knocks().length, 0);
});

test('once per bike in 400 ms, six per driver a second, and two cars on one bike knock it once', () => {
  {
    const { bike, car, driver, run, runUp, knocks } = onRoad();
    const anna = driver('anna', runUp(60));
    run('anna', anna, ROAD.x - 2, 60);
    assert.equal(knocks().length, 1);
    Object.assign(bike, { x: car.x - 4, z: ROAD.z }); // put back in its way at once
    run('anna', anna, car.x - 8, 60);
    assert.equal(knocks().length, 1, 'not twice within 400 ms');
  }
  {
    // Seven bikes in a row, 3.5 m apart, driven through at 120 km/h (the row in 0.7 s): six go, the seventh stands.
    const { game, y, car, driver, state, knocks, still } = onRoad();
    game.bikes.church1.x = ROAD.x + 100; // out of the way
    const ids = Object.keys(game.bikes).filter((id) => id !== 'church1').slice(0, 7);
    ids.forEach((id, i) => Object.assign(game.bikes[id], { x: ROAD.x - i * 3.5, y, z: ROAD.z, yaw: ROAD.yaw }));
    const last = { ...game.bikes[ids[6]] };
    const bert = driver('bert', ROAD.x + 25);
    let first = null;
    for (let x = car.x - 1.1; x > ROAD.x - 27; x -= 1.1) {
      state('bert', bert, x);
      first ??= knocks().length ? T : null;
    }
    assert.ok(T - first < 1000 + 300, 'the row driven through within about a second of the first knock');
    assert.equal(knocks().length, 6, `six knocks: ${knocks().map((m) => m.bike.id)}`);
    still(game.bikes[ids[6]], last);
  }
  {
    // Two cars meeting one bike in the same moment, from either side: knocked once.
    const { game, y, driver, player, send, knocks } = onRoad();
    const second = game.cars.model3;
    Object.assign(second, { x: ROAD.x - 20, y, z: ROAD.z, yaw: -ROAD.yaw, driver: null, passenger: null });
    const anna = driver('anna', ROAD.x + 20);
    const bert = player('bert', { x: second.x - 1.5, y, z: second.z + 1.5 });
    bert.nextCar = 0;
    send('bert', bert, { t: 'car', op: 'in', id: 'model3' });
    assert.equal(second.driver, 'bert');
    // Both at 27 m/s towards it from either side, each state in the same moment.
    for (let i = 1; i < 30 && !knocks().length; i++) {
      wait(33);
      send('anna', anna, { t: 'state', x: ROAD.x + 20 - i * 0.9, y, z: ROAD.z, yaw: ROAD.yaw, pitch: 0, ct: T });
      send('bert', bert, { t: 'state', x: ROAD.x - 20 + i * 0.9, y, z: ROAD.z, yaw: -ROAD.yaw, pitch: 0, ct: T });
    }
    wait(33);
    send('bert', bert, { t: 'state', x: second.x + 0.9, y, z: ROAD.z, yaw: -ROAD.yaw, pitch: 0, ct: T });
    assert.equal(knocks().length, 1, 'once, by whichever came first');
  }
});

test('knock then get on, get on then knock: the order decides, and nothing is lost in between', () => {
  {
    // Knocked, then Bert next to where it lies gets on at once: he rides it from there, standing.
    const { bike, driver, run, runUp, player, send, knocks } = onRoad();
    const anna = driver('anna', runUp(40));
    run('anna', anna, ROAD.x - 10, 40);
    assert.equal(knocks().length, 1);
    const bert = player('bert', { x: bike.x + 1, y: bike.y, z: bike.z });
    bert.nextCar = 0;
    send('bert', bert, { t: 'bike', op: 'on', id: 'church1' });
    assert.equal(bike.rider, 'bert');
    assert.equal(bike.lie, 0);
  }
  {
    // Bert gets on first; the car then drives through: the ridden bike is not knocked.
    const { bike, driver, run, runUp, player, send, knocks } = onRoad();
    const bert = player('bert', { x: bike.x, y: bike.y, z: bike.z + 1 });
    bert.nextCar = 0;
    send('bert', bert, { t: 'bike', op: 'on', id: 'church1' });
    assert.equal(bike.rider, 'bert');
    const anna = driver('anna', runUp(40));
    run('anna', anna, ROAD.x - 10, 40);
    assert.equal(knocks().length, 0);
    assert.equal(bike.rider, 'bert');
  }
});

/** A small seeded random (mulberry32): the same hits every run. */
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('3000 hits round every bike, the house, the portals, the start places, the edge and a pond: every pose it lies in passes spotOk', () => {
  const { game } = onRoad();
  const H = game.bikeHits;
  const pond = VILLAGE.dips.find((d) => d.water);
  const mid = (ring) => [ring.reduce((a, v) => a + v[0], 0) / ring.length, ring.reduce((a, v) => a + v[1], 0) / ring.length];
  const edge = BOUNDS.map.putBack(0, 2000, 1) ?? { x: 0, z: 0 };
  const targets = [
    ...Object.values(BIKES.bikes).map((k) => [k.park.x, k.park.z]), ...PORTALS.flatMap((p) => [[p.x, p.z], [p.car[0], p.car[1]]]), ...SPAWNS.map((s) => [s.x, s.z]),
    mid(pond.rim), [edge.x, edge.z], [4, 6], [3, 2], [85, 190], [1505, -355], // the homes' walls
  ];
  const rnd = seeded(2026);
  let knocked = 0;
  let inPlace = 0;
  for (let i = 0; i < 3000; i++) {
    const [tx, tz] = targets[i % targets.length];
    // From each bike's own spot, or a walk of knocks: the bike starts where the last one left it, near the target.
    const bike = game.bikes.church1;
    const a = rnd() * Math.PI * 2;
    const r = 0.5 + rnd() * 3.5;
    const bx = tx + Math.cos(a) * r;
    const bz = tz + Math.sin(a) * r;
    if (i % 3 === 0 || !bike.lie) Object.assign(bike, { x: bx, z: bz, y: H.env.ground(bx, bz), yaw: rnd() * 6.28 - 3.14, lie: 0, rider: null });
    const before = { x: bike.x, z: bike.z, yaw: bike.yaw };
    const toward = Math.atan2(tz - bike.z, tx - bike.x) + (rnd() - 0.5);
    const kmh = 3 + rnd() * 197;
    const v = kmh / 3.6;
    const dx = Math.cos(toward);
    const dz = Math.sin(toward);
    // The shared sums with the server's own test, as strike calls them (the speed already the server's).
    const rest = knockBike(bike, { x: bike.x - dx * 2.5, z: bike.z - dz * 2.5 }, dx * v, dz * v, (x, z, yaw) => H.spotOk(x, z, yaw, 'tesla'));
    if (!rest) {
      assert.ok(!H.spotOk(bike.x, bike.z, bike.yaw, 'tesla'), `${i}: no knock only when it may not even lie where it stands`);
      continue;
    }
    knocked++;
    if (rest.dist === 0) inPlace++;
    Object.assign(bike, { x: rest.x, z: rest.z, yaw: rest.yaw, lie: rest.lie, y: H.env.ground(rest.x, rest.z) });
    assert.ok(H.spotOk(rest.x, rest.z, rest.yaw, 'tesla'), `${i}: lies where it may: ${JSON.stringify(rest)} from ${JSON.stringify(before)}`);
    assert.ok(!H.env.indoors(rest.x, rest.z), `${i}: not indoors`);
    assert.equal(homeAt(rest.x, rest.z, bike.y + 0.3), null, `${i}: not in a locked home`);
    assert.ok(Math.hypot(rest.x - before.x, rest.z - before.z) <= 8 + 1e-9, `${i}: at most 8 m`);
  }
  assert.ok(knocked > 1200 && inPlace > 100, `${knocked} knocked, ${inPlace} of them tipped where they stood`);
});

test('a state far past the movement budget is cut short: a bike beyond where the car may be stays', () => {
  const { bike, car, driver, state, knocks, still } = onRoad();
  Object.assign(bike, { x: ROAD.x - 40 });
  const at = { x: bike.x, z: bike.z };
  const anna = driver('anna', ROAD.x);
  // 80 m asked after standing (the budget full: half a second at 66.7 m/s, about 34 m): not as far as the bike 40 m on.
  state('anna', anna, ROAD.x - 80);
  assert.ok(car.x > ROAD.x - 34.5, `cut short at ${car.x}`);
  still(bike, at);
  assert.equal(knocks().length, 0);
});

test('two states at 55 m/s either side of a bike, the car\'s box at neither end on it, still knock it (the sweep)', () => {
  const { bike, car, driver, state, knocks } = onRoad();
  const anna = driver('anna', ROAD.x + 40);
  // A run-up at 55 m/s (1.8 m a state), then a state either side of the bike.
  for (let x = car.x; x > ROAD.x + 6; x -= 1.8) state('anna', anna, x);
  state('anna', anna, ROAD.x + 4.5, ROAD.z, 30);
  assert.equal(knocks().length, 0);
  assert.equal(sweptHit(CAR_BOX, { x: ROAD.x + 4.5, z: ROAD.z, yaw: ROAD.yaw }, { x: ROAD.x + 4.5, z: ROAD.z, yaw: ROAD.yaw }, { ...bike, ...BIKE_BOX }), null);
  state('anna', anna, ROAD.x - 4.5, ROAD.z, 163); // 9 m in 163 ms
  assert.equal(car.x, ROAD.x - 4.5);
  assert.equal(knocks().length, 1);
  assert.ok(knocks()[0].knock.v > 45, `${knocks()[0].knock.v} m/s`);
});

test('getting on a lying bike: from next to it it stands up and stays where it is left; from afar refused', () => {
  const { game, bike, driver, run, runUp, player, send, told } = onRoad();
  const anna = driver('anna', runUp(80));
  run('anna', anna, ROAD.x - 10, 80);
  assert.ok(bike.lie);
  const lying = { x: bike.x, z: bike.z };
  const far = player('far', { x: bike.x + 6, y: bike.y, z: bike.z });
  far.nextCar = 0;
  send('far', far, { t: 'bike', op: 'on', id: 'church1' });
  assert.equal(bike.rider, null);
  assert.ok(bike.lie, 'still lying');
  const bert = player('bert', { x: bike.x + 1, y: bike.y, z: bike.z });
  bert.nextCar = 0;
  send('bert', bert, { t: 'bike', op: 'on', id: 'church1' });
  assert.equal(bike.rider, 'bert');
  assert.equal(bike.lie, 0);
  assert.equal(told.at(-1).bike.lie, 0);
  assert.ok(bike.x === lying.x && bike.z === lying.z);
  bert.nextCar = 0;
  send('bert', bert, { t: 'bike', op: 'off' });
  wait(game.bikeHits.homeMs + 1000);
  game.bikeHits.home();
  assert.ok(bike.x === lying.x && bike.z === lying.z && bike.rider === null, 'ridden and left: it stays there');
});

test('a knocked bike left lying goes back to its own spot 5 minutes after its first knock, a later knock doesn\'t restart them, and it waits while its spot is taken', () => {
  const { game, bike, car, driver, run, runUp, told } = onRoad();
  const H = game.bikeHits;
  assert.equal(H.homeMs, 5 * 60_000, 'five minutes');
  const anna = driver('anna', runUp(40));
  run('anna', anna, ROAD.x - 10, 40);
  assert.ok(bike.lie);
  const first = T;
  // Four minutes on, knocked again (driven back at it): the time still counts from the first knock.
  wait(4 * 60_000);
  const x = bike.x;
  car.x = x + 12;
  car.z = bike.z;
  H.trails.clear();
  for (let i = 0; i < 30; i++) {
    wait(33);
    game.handle('anna', anna, JSON.stringify({ t: 'state', x: car.x, y: car.y, z: car.z, yaw: ROAD.yaw, pitch: 0, ct: T }));
  }
  for (let cx = car.x; cx > x - 8; cx -= 0.4) {
    wait(33);
    game.handle('anna', anna, JSON.stringify({ t: 'state', x: cx, y: car.y, z: car.z, yaw: ROAD.yaw, pitch: 0, ct: T }));
  }
  const knocks = told.filter((m) => m.t === 'bike' && m.knock);
  assert.equal(knocks.length, 2, 'knocked again');
  // A car stands on its spot when the time is up: it waits, and goes once the spot is free.
  const park = BIKES.bikes.church1.park;
  const other = game.cars.model3;
  Object.assign(other, { x: park.x, y: park.y, z: park.z, yaw: park.yaw });
  T = first + 5 * 60_000 + 10;
  H.home();
  assert.ok(bike.lie && bike.x !== park.x, 'waits while a car stands on its spot');
  Object.assign(other, { x: park.x + 50 });
  wait(3500);
  H.home();
  assert.deepEqual({ x: bike.x, y: bike.y, z: bike.z, yaw: bike.yaw, lie: bike.lie }, { ...park, lie: 0 }, '5 minutes after the first knock, not the second');
  assert.equal(told.at(-1).home, true);
  assert.equal(H.knocks.size, 0);
});

test('the tick carries the lying bike, and a player who joins later is given it where it lies', () => {
  const { game, bike, driver, run, runUp, player } = onRoad();
  const anna = driver('anna', runUp(80));
  run('anna', anna, ROAD.x - 10, 80);
  const lie = bike.lie;
  assert.ok(lie);
  let out = '';
  anna.ws = { name: 'anna', OPEN: 1, readyState: 1, send: (s) => (out = s) };
  anna.proto = 2;
  anna.full = true;
  game.snapshot(Date.now());
  const seen = JSON.parse(out).k.map(readBike).find((k) => k.id === 'church1');
  assert.equal(seen.lie, lie);
  assert.ok(Math.abs(seen.x - bike.x) < 0.01 && Math.abs(seen.z - bike.z) < 0.01);
  const late = player('late');
  const welcome = game.welcome(late, 'late', '#fff', Date.now());
  const given = welcome.bikes.find((k) => k.id === 'church1');
  assert.deepEqual({ x: given.x, z: given.z, lie: given.lie }, { x: bike.x, z: bike.z, lie });
  assert.deepEqual(Object.keys(given).sort(), ['id', 'lie', 'rider', 'x', 'y', 'yaw', 'z'], 'nothing of the server\'s own in it');
});

test('in a room and during Zombies nothing is knocked', () => {
  const { game, bike, car, driver, run, runUp, knocks, still } = onRoad();
  const at = { x: bike.x, z: bike.z };
  const anna = driver('anna', runUp(80)); // at the wheel before the game began
  Object.defineProperty(game.modes, 'zombies', { get: () => ({ fell: new Map() }), configurable: true });
  run('anna', anna, ROAD.x - 10, 80);
  still(bike, at);
  delete game.modes.zombies;
  game.room = { id: 'r1', edge: BOUNDS.map };
  Object.assign(car, { x: ROAD.x - 3 });
  game.bikeHits.strike('anna', anna, car, { x: ROAD.x + 3, y: bike.y, z: ROAD.z, yaw: ROAD.yaw });
  still(bike, at);
  assert.equal(knocks().length, 0);
});
