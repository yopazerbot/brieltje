import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { FLAG, playerFields, readBike, readPlayer } from '../shared/wire.mjs';
import { knockBike, sweptHit } from '../shared/bikeKnock.mjs';
import { loadBounds } from '../shared/bounds.mjs';
import { homeAt } from '../shared/homes.mjs';
import { PORTALS } from '../shared/portals.mjs';
import { Game } from './game.mjs';

// The bikes (shared/bike.json, src/world/bike.ts): the server decides who rides which bike, lets only
// that rider move at a bike's speed, keeps riders out of the fighting as a car does, and rings a bell
// only for a rider. Each forged message below must change nothing.

const BIKES = JSON.parse(readFileSync(new URL('../shared/bike.json', import.meta.url), 'utf8'));
const RUN_SPEED = 1.4 * 2.5 * 1.3; // m/s across on foot (game.mjs)
const BIKE_SPEED = BIKES.maxSpeed * 1.3; // m/s on a bike (game.mjs)
const HOUSE = BIKES.bikes.house.park;

function setup() {
  const game = new Game({ session: () => null, store: { addStats: async () => {} } }, []);
  const told = [];
  const sent = new Map();
  game.broadcast = (m, except) => told.push({ ...m, except });
  game.send = (ws, m) => sent.get(ws.name)?.push(m);
  game.stampState = () => {};
  const player = (name, at = { x: HOUSE.x - 1.0, y: HOUSE.y, z: HOUSE.z }) => {
    const now = Date.now();
    const p = {
      ws: { name }, key: `k-${name}`, role: 'player', alive: true, protectedUntil: 0, drop: null, warp: 0, stamp: 0,
      state: { x: at.x, y: at.y, z: at.z, yaw: 0, pitch: 0, armed: true, flying: false, w: 'pistol', c: false },
      weapons: new Set(['pistol']), nades: [0, 0], window: now, msgs: 0, states: 0, others: 0, budget: 0.5, vbudget: 0.5, movedAt: now,
      hp: 100, score: { kills: 0, deaths: 0, points: 0 },
    };
    sent.set(name, []);
    game.players.set(name, p);
    return p;
  };
  const send = (name, p, m) => game.handle(name, p, JSON.stringify(m));
  /** On a bike: the message, with the wait for the next one (three a second) let go. */
  const ask = (name, p, m) => {
    p.nextCar = 0;
    send(name, p, m);
  };
  return { game, told, sent, player, send, ask };
}

/**
 * Move `p` by `dz` along z (down the side passage, towards the street) in a state `ms` after its last
 * one (the budget refills with the time). Returns where the server has them along z.
 */
function move(send, name, p, dz, ms, extra = {}) {
  p.movedAt = Date.now() - ms;
  p.window = Date.now();
  p.states = 0;
  p.msgs = 0;
  const s = p.state;
  send(name, p, { t: 'state', x: s.x, y: s.y, z: s.z + dz, yaw: s.yaw, pitch: 0, armed: s.armed, w: 'pistol', ...extra });
  return p.state.z;
}

test('every bike in the data stands on the map with its paint, and the bike speed is a bike speed', () => {
  const ids = Object.keys(BIKES.bikes);
  assert.ok(ids.length >= 10);
  for (const id of ids) {
    const k = BIKES.bikes[id];
    assert.match(k.paint, /^#[0-9a-f]{6}$/);
    for (const v of [k.park.x, k.park.y, k.park.z, k.park.yaw]) assert.ok(Number.isFinite(v), id);
  }
  // 25 km/h pedalling, at most 36 km/h downhill: much more than running, far less than a car.
  assert.ok(Math.abs(BIKES.pedalSpeed * 3.6 - 25) < 0.1);
  assert.ok(BIKES.maxSpeed > BIKES.pedalSpeed && BIKES.maxSpeed * 3.6 <= 40);
  assert.ok(BIKE_SPEED > RUN_SPEED * 2 && BIKE_SPEED < 20);
});

test('getting on: next to a free bike, alive and on foot; not from afar, not dead, not a ridden one, not twice', () => {
  const { game, told, sent, player, ask } = setup();
  const anna = player('anna');
  const bert = player('bert', { x: HOUSE.x - 1.0, y: HOUSE.y, z: HOUSE.z + 1.5 });
  const far = player('far', { x: HOUSE.x - 1.0, y: HOUSE.y, z: HOUSE.z + 8 });
  const dead = player('dead');
  dead.alive = false;
  ask('far', far, { t: 'bike', op: 'on', id: 'house' });
  ask('dead', dead, { t: 'bike', op: 'on', id: 'house' });
  assert.equal(game.bikes.house.rider, null);
  assert.equal(told.length, 0);
  assert.equal(sent.get('far')[0].t, 'bike', 'a refusal tells the page the bike as it is');
  ask('anna', anna, { t: 'bike', op: 'on', id: 'house' });
  assert.equal(game.bikes.house.rider, 'anna');
  assert.deepEqual(told.map((m) => [m.t, m.bike?.id, m.bike?.rider]), [['bike', 'house', 'anna']]);
  // Stealing a ridden bike: refused, and so is a second bike for the same rider.
  ask('bert', bert, { t: 'bike', op: 'on', id: 'house' });
  assert.equal(game.bikes.house.rider, 'anna');
  anna.state.x = BIKES.bikes.bungalow.park.x;
  anna.state.z = BIKES.bikes.bungalow.park.z;
  ask('anna', anna, { t: 'bike', op: 'on', id: 'bungalow' });
  assert.equal(game.bikes.bungalow.rider, null);
  // Someone else's "off" frees only their own (none): Anna keeps hers.
  ask('bert', bert, { t: 'bike', op: 'off', id: 'house' });
  assert.equal(game.bikes.house.rider, 'anna');
  ask('anna', anna, { t: 'bike', op: 'off' });
  assert.equal(game.bikes.house.rider, null);
});

test('forged ids and kinds of message are refused: unknown, inherited and non-string ids, and the rate', () => {
  const { game, told, player, send, ask } = setup();
  const anna = player('anna');
  for (const id of ['__proto__', 'toString', 'constructor', 'nope', 7, null, { id: 'house' }, ['house']]) ask('anna', anna, { t: 'bike', op: 'on', id });
  assert.equal(told.length, 0);
  assert.equal(game.bikeOf('anna'), null);
  // At most three a second: a second "on" right after an "off" waits.
  ask('anna', anna, { t: 'bike', op: 'on', id: 'house' });
  send('anna', anna, { t: 'bike', op: 'off' });
  assert.equal(game.bikes.house.rider, 'anna');
});

test('no bikes during Zombies, as no cars and no horses', () => {
  const { game, sent, player, ask } = setup();
  const anna = player('anna');
  Object.defineProperty(game.modes, 'zombies', { get: () => ({}) });
  ask('anna', anna, { t: 'bike', op: 'on', id: 'house' });
  assert.equal(game.bikes.house.rider, null);
  assert.equal(sent.get('anna').at(-1).code, 'zNoBike');
});

test('only a rider moves at a bike speed: on foot the run budget holds, whatever flags the page sends', () => {
  const { game, player, send, ask } = setup();
  const anna = player('anna');
  // On foot, a forged ride state (the bike flag, the car flag, a steer) buys nothing: still running pace.
  const x0 = anna.state.z;
  const x1 = move(send, 'anna', anna, 5, 500, { bk: 1, bike: 'house', d: true, s: 0.5 });
  assert.ok(x1 - x0 <= RUN_SPEED * 0.5 + 0.5 + 1e-9, `on foot ${x1 - x0} m in 0.5 s`);
  assert.equal(anna.state.bk, false, 'the bike flag is the server\'s');
  assert.equal(game.bikeOf('anna'), null);
  // Riding: a bike's pace, and the bike goes along.
  anna.state.z = HOUSE.z;
  ask('anna', anna, { t: 'bike', op: 'on', id: 'house' });
  assert.equal(game.bikes.house.rider, 'anna');
  const r0 = anna.state.z;
  const r1 = move(send, 'anna', anna, 5, 500);
  assert.ok(Math.abs(r1 - r0 - 5) < 1e-6, 'five metres in half a second is a bike (36 km/h)');
  assert.equal(anna.state.bk, true);
  assert.equal(game.bikes.house.z, anna.state.z);
  // Faster than the bike's top speed (with the jitter allowed) is cut back.
  const r2 = move(send, 'anna', anna, 30, 500);
  assert.ok(r2 - r1 <= BIKE_SPEED * 0.5 + 0.5 + 1e-9, `${r2 - r1} m in 0.5 s on a bike`);
  // Off again: back to running pace at once.
  ask('anna', anna, { t: 'bike', op: 'off' });
  const f0 = anna.state.z;
  const f1 = move(send, 'anna', anna, 5, 500);
  assert.ok(f1 - f0 <= RUN_SPEED * 0.5 + 0.5 + 1e-9, `after getting off ${f1 - f0} m in 0.5 s`);
  assert.ok(Math.abs(game.bikes.house.z - r2) < 1e-9, 'the bike stays where it was left');
});

test('a rider can\'t shoot or be shot, as in a car; the others see the bike flag', () => {
  const { game, told, player, send, ask } = setup();
  const anna = player('anna');
  const bert = player('bert', { x: HOUSE.x - 1.0, y: HOUSE.y, z: HOUSE.z + 2 });
  ask('anna', anna, { t: 'bike', op: 'on', id: 'house' });
  assert.equal(game.inCar('anna'), true);
  assert.equal(game.inCar('bert'), false);
  told.length = 0;
  send('anna', anna, { t: 'shot', w: 'pistol', x: 0, y: 1, z: 0 });
  assert.equal(told.length, 0, 'no shot from a bike');
  const hp = anna.hp;
  send('bert', bert, { t: 'hit', target: 'anna', w: 'pistol', body: 1, head: 0 });
  assert.equal(anna.hp, hp, 'no hit on a rider');
  // Riders are no flying, crouching figures.
  move(send, 'anna', anna, 1, 500, { flying: true, c: true });
  assert.equal(anna.state.flying, false);
  assert.equal(anna.state.c, false);
  const seen = readPlayer(['anna', 0, ...playerFields(anna.state, true, false, 0)]);
  assert.equal(seen.bike, true);
  assert.equal(seen.d, false, 'not in a car: their figure shows');
  assert.equal(playerFields({ ...anna.state, bk: false }, true, false, 3)[5] & FLAG.bike, 0);
});

test('getting off by dying, leaving or respawning leaves the bike where it is', () => {
  const { game, player, ask } = setup();
  const anna = player('anna');
  ask('anna', anna, { t: 'bike', op: 'on', id: 'house' });
  game.npcDamage('anna', anna, 1000, Date.now(), 'a strongman');
  assert.equal(game.bikes.house.rider, null);
  anna.alive = true;
  ask('anna', anna, { t: 'bike', op: 'on', id: 'house' });
  assert.equal(game.bikes.house.rider, 'anna');
  game.releaseBike('anna');
  assert.equal(game.bikes.house.rider, null);
});

test('the bell: only from a rider, at most every 400 ms, and only the bike\'s id goes out', () => {
  const { told, player, send, ask } = setup();
  const anna = player('anna');
  send('anna', anna, { t: 'bell' });
  assert.equal(told.length, 0, 'no bell on foot');
  ask('anna', anna, { t: 'bike', op: 'on', id: 'house' });
  told.length = 0;
  send('anna', anna, { t: 'bell', id: 'church1', x: 500, z: -700 });
  send('anna', anna, { t: 'bell' });
  assert.deepEqual(told, [{ t: 'bell', id: 'house', except: 'anna' }], 'rung once, at her own bike');
  anna.nextBell = 0;
  send('anna', anna, { t: 'bell' });
  assert.equal(told.length, 2);
});

test('the ticks carry the bikes, and a page reads them back', () => {
  const { game, player, ask } = setup();
  const anna = player('anna');
  ask('anna', anna, { t: 'bike', op: 'on', id: 'house' });
  let out = '';
  anna.ws = { name: 'anna', OPEN: 1, readyState: 1, send: (s) => (out = s) };
  anna.proto = 2;
  anna.full = true;
  game.snapshot(Date.now());
  const tick = JSON.parse(out);
  const house = tick.k.map(readBike).find((k) => k.id === 'house');
  assert.equal(house.rider, 'anna');
  assert.ok(Math.abs(house.x - HOUSE.x) < 0.01 && Math.abs(house.z - HOUSE.z) < 0.01);
  assert.equal(tick.k.length, Object.keys(BIKES.bikes).length);
});

// ---------------------------------------------------------------------------------------------------------------
// A car that drives into a bike nobody rides knocks it over or throws it aside (server/bikeHits.mjs,
// shared/bikeKnock.mjs). The server finds the hit itself in the driver's states; no message of the page's moves a bike.

const CAR = JSON.parse(readFileSync(new URL('../shared/car.json', import.meta.url), 'utf8')).cars.tesla;
const CAR_BOX = { halfL: CAR.length / 2, halfW: CAR.width / 2 };
const BIKE_BOX = { halfL: BIKES.length / 2, halfW: BIKES.width / 2 };
/** The road in front of the house, along x: the car drives along -x (yaw pi / 2), the bike stands in its way. */
const ROAD = { x: 40, z: 22.5, yaw: Math.PI / 2 };
const VILLAGE = JSON.parse(readFileSync(new URL('../src/data/village.json', import.meta.url), 'utf8'));
const BOUNDS = loadBounds(JSON.parse(readFileSync(new URL('../shared/bounds.json', import.meta.url), 'utf8')));
const SPAWNS = JSON.parse(readFileSync(new URL('../shared/spawns.json', import.meta.url), 'utf8'));

/** A game with the church's first bike moved onto the road, a fake clock for the states' stamps, and a driver's states. */
function onRoad() {
  const s = setup();
  const { game } = s;
  let clock = 10_000;
  game.stampState = (p) => {
    p.stamp = clock;
  };
  const y = game.bikeHits.env.ground(ROAD.x, ROAD.z);
  const bike = game.bikes.church1;
  Object.assign(bike, { x: ROAD.x, y, z: ROAD.z, yaw: ROAD.yaw });
  const car = game.cars.tesla;
  /** `name` at the wheel of the Tesla, standing at x on the road. */
  const driver = (name, x = ROAD.x + 15, role = 'player') => {
    const p = s.player(name, { x, y, z: ROAD.z });
    p.role = role;
    Object.assign(car, { x, y, z: ROAD.z, yaw: ROAD.yaw, driver: name });
    game.carAt.tesla = clock;
    return p;
  };
  /** `name`'s next state, `ms` after the last, at x along the road (z: across it); the movement budget full unless `budget`. */
  const drive = (name, p, x, ms = 33, z = ROAD.z, extra = {}, budget = 1000) => {
    clock += ms;
    p.movedAt = Date.now() - ms;
    p.window = Date.now();
    p.states = p.msgs = p.others = 0;
    p.budget = budget;
    s.send(name, p, { t: 'state', x, y, z, yaw: ROAD.yaw, pitch: 0, armed: false, w: 'pistol', ...extra });
  };
  /** Drive from x0 to x1 at `kmh`, one state every 33 ms; returns the car's place before each state. */
  const run = (name, p, x0, x1, kmh, z = ROAD.z, extra = {}) => {
    const step = (kmh / 3.6) * 0.033;
    const before = [];
    for (let x = x0 - step; x >= x1; x -= step) {
      before.push({ x: car.x, z: car.z, yaw: car.yaw, at: game.carAt.tesla });
      drive(name, p, x, 33, z, extra);
    }
    return before;
  };
  const knocks = () => s.told.filter((m) => m.t === 'bike' && m.knock);
  const still = (k, at) => assert.ok(k.x === at.x && k.z === at.z && !k.lie, `${k.id} did not move: ${JSON.stringify(k)}`);
  return { ...s, bike, car, y, driver, drive, run, knocks, still, clock: () => clock };
}

test('a car driven into a free bike knocks it aside: one message for everyone, on its side, at most 8 m, where the shared sums put it', () => {
  for (const kmh of [8, 40, 100]) {
    const { game, bike, car, driver, run, knocks } = onRoad();
    const anna = driver('anna');
    const from = { x: bike.x, z: bike.z, yaw: bike.yaw };
    const before = run('anna', anna, car.x, ROAD.x - 10, kmh);
    const got = knocks();
    assert.equal(got.length, 1, `${kmh} km/h: one knock`);
    const m = got[0];
    assert.equal(m.except, undefined, 'to every page, the driver\'s too');
    assert.equal(m.bike.id, 'church1');
    assert.ok(m.bike.lie === 1 || m.bike.lie === -1, 'on its side');
    const dist = Math.hypot(m.bike.x - from.x, m.bike.z - from.z);
    assert.ok(dist <= 8 + 1e-9, `${dist} m`);
    assert.ok(kmh < 10 ? dist <= 0.41 : dist > 2, `${kmh} km/h: ${dist} m`);
    assert.ok(m.knock.ms > 0 && m.knock.v > 0 && m.knock.v <= 55.6);
    // The same as the shared sums on the server's own places: the state that met it, its speed over the stamps.
    const hit = before.find((b, i) => {
      const to = before[i + 1] ?? car;
      return sweptHit(CAR_BOX, b, to, { ...from, ...BIKE_BOX });
    });
    const i = before.indexOf(hit);
    const to = before[i + 1];
    const at = sweptHit(CAR_BOX, hit, to, { ...from, ...BIKE_BOX });
    const gap = to.at - hit.at;
    const d = Math.hypot(to.x - hit.x, to.z - hit.z);
    const v = Math.min(55.6, d / (gap / 1000));
    const want = knockBike(from, at, ((to.x - hit.x) / d) * v, ((to.z - hit.z) / d) * v, (x, z, yaw) => game.bikeHits.spotOk(x, z, yaw, 'tesla'));
    assert.ok(Math.abs(want.x - m.bike.x) < 1e-9 && Math.abs(want.z - m.bike.z) < 1e-9 && want.lie === m.bike.lie && want.yaw === m.bike.yaw, `${JSON.stringify(want)} vs ${JSON.stringify(m.bike)}`);
    assert.equal(bike.y, game.bikeHits.env.ground(bike.x, bike.z), 'on the ground where it lies');
    assert.equal(bike.rider, null);
  }
});

test('made-up messages move no bike: a knock, a bike with a place, a bell with a place', () => {
  const { bike, player, send, ask, knocks, still } = onRoad();
  const anna = player('anna', { x: ROAD.x + 1.2, y: bike.y, z: ROAD.z });
  const at = { x: bike.x, z: bike.z };
  for (const m of [
    { t: 'bikehit', id: 'church1', x: 0, z: 0 }, { t: 'knock', id: 'church1', x: 0, z: 0, lie: 1 },
    { t: 'bike', op: 'knock', id: 'church1', x: 0, z: 0, lie: 1 }, { t: 'bike', id: 'church1', x: 0, z: 0, lie: -1 },
    { t: 'bike', op: 'off', id: 'church1', x: 0, z: 0, lie: 1 }, { t: 'bell', id: 'church1', x: 0, z: 0 },
  ]) ask('anna', anna, m);
  send('anna', anna, { t: 'state', x: ROAD.x + 1.2, y: bike.y, z: ROAD.z, yaw: 0, pitch: 0, lie: 1, bike: { id: 'church1', x: 0, z: 0 } });
  still(bike, at);
  assert.equal(knocks().length, 0);
});

test('on foot with the car flag forged, as a passenger, or as the admin on foot: states across a bike knock nothing', () => {
  const { bike, car, player, drive, driver, knocks, still } = onRoad();
  const at = { x: bike.x, z: bike.z };
  const walker = player('walker', { x: ROAD.x + 3, y: bike.y, z: ROAD.z });
  for (let x = ROAD.x + 3; x > ROAD.x - 3; x -= 0.15) drive('walker', walker, x, 33, ROAD.z, { d: true, s: 1, bk: 1 });
  const admin = player('boss', { x: ROAD.x + 30, y: bike.y, z: ROAD.z });
  admin.role = 'admin';
  for (let x = ROAD.x + 30; x > ROAD.x - 30; x -= 6) drive('boss', admin, x, 33, ROAD.z, { d: true });
  still(bike, at);
  // Riding along: the passenger's states don't move the car, and knock nothing.
  driver('bert', ROAD.x + 15);
  car.passenger = 'anna';
  const anna = player('anna', { x: ROAD.x + 15, y: bike.y, z: ROAD.z });
  for (let x = ROAD.x + 15; x > ROAD.x - 10; x -= 1) drive('anna', anna, x);
  assert.equal(car.x, ROAD.x + 15, 'the car stays with its driver');
  still(bike, at);
  assert.equal(knocks().length, 0);
});

test('a car standing on a bike, or passing 5 m beside it, knocks nothing', () => {
  const { bike, car, driver, drive, run, knocks, still } = onRoad();
  const at = { x: bike.x, z: bike.z };
  const anna = driver('anna', ROAD.x);
  for (let i = 0; i < 20; i++) drive('anna', anna, ROAD.x + (i % 2) * 0.01); // creeping on the spot: under 0.5 m/s
  still(bike, at);
  car.x = ROAD.x + 15;
  run('anna', anna, car.x, ROAD.x - 15, 100, ROAD.z + 5);
  still(bike, at);
  assert.equal(knocks().length, 0);
});

test('a ridden bike is never knocked: it stops the car, and its rider rides on', () => {
  const { game, bike, driver, run, knocks, still } = onRoad();
  bike.rider = 'bert';
  const at = { x: bike.x, z: bike.z };
  const anna = driver('anna');
  run('anna', anna, ROAD.x + 15, ROAD.x - 10, 100);
  still(bike, at);
  assert.equal(bike.rider, 'bert');
  assert.equal(game.bikeOf('bert'), bike);
  assert.equal(knocks().length, 0);
});

test('once per bike in 400 ms, six per driver a second', () => {
  const { game, bike, car, driver, run, knocks } = onRoad();
  const anna = driver('anna');
  run('anna', anna, car.x, ROAD.x - 2, 60);
  assert.equal(knocks().length, 1);
  // Put back in the car's way at once: within 400 ms it is not knocked again.
  Object.assign(bike, { x: car.x - 4, z: ROAD.z });
  run('anna', anna, car.x, car.x - 8, 60);
  assert.equal(knocks().length, 1, 'not twice within 400 ms');
  // Seven bikes in a row, 5 m apart, driven through within a second: six go, the seventh stands.
  const s = onRoad();
  const ids = Object.keys(s.game.bikes).filter((id) => id !== 'church1').slice(0, 7);
  ids.forEach((id, i) => Object.assign(s.game.bikes[id], { x: ROAD.x - i * 5, y: s.y, z: ROAD.z, yaw: ROAD.yaw }));
  const last = { ...s.game.bikes[ids[6]] };
  const bert = s.driver('bert');
  const t0 = Date.now();
  s.run('bert', bert, s.car.x, ROAD.x - 34, 120);
  assert.ok(Date.now() - t0 < 1000, 'all within a second');
  assert.equal(s.knocks().length, 6, `six knocks: ${s.knocks().map((m) => m.bike.id)}`);
  s.still(s.game.bikes[ids[6]], last);
  assert.ok(bert.bikeKnocks.length <= 6);
  assert.equal(game.bikeHits.knocks.size, 1);
});

/** A small seeded random (mulberry32): the same 200 hits every run. */
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('200 hits round every bike, the house, the portals, the start places, the edge and a pond: never anywhere it may not lie', () => {
  const { game } = onRoad();
  const H = game.bikeHits;
  const pond = VILLAGE.dips.find((d) => d.water);
  const mid = (ring) => [ring.reduce((a, v) => a + v[0], 0) / ring.length, ring.reduce((a, v) => a + v[1], 0) / ring.length];
  const edge = BOUNDS.map.putBack(BOUNDS.map.inside(0, 0) ? 0 : 0, 2000, 1) ?? { x: 0, z: 0 };
  const targets = [
    ...Object.values(BIKES.bikes).map((k) => [k.park.x, k.park.z]), ...PORTALS.map((p) => [p.x, p.z]), ...SPAWNS.map((s) => [s.x, s.z]),
    mid(pond.rim), [edge.x, edge.z], [4, 6], [3, 2], // the main house's walls
  ];
  const rnd = seeded(2026);
  let thrown = 0;
  for (let i = 0; i < 200; i++) {
    const [tx, tz] = targets[i % targets.length];
    const a = rnd() * Math.PI * 2;
    const r = 0.5 + rnd() * 3.5;
    const bike = game.bikes.church1;
    const bx = tx + Math.cos(a) * r;
    const bz = tz + Math.sin(a) * r;
    Object.assign(bike, { x: bx, z: bz, y: H.env.ground(bx, bz), yaw: rnd() * 6.28 - 3.14, lie: 0, rider: null });
    H.knocks.clear();
    // The car comes at it from 3.6 m (its middle; clear of it), aimed through it at the target, at 8 to 200 km/h.
    const toward = Math.atan2(tz - bz, tx - bx) + (rnd() - 0.5);
    const v = (8 + rnd() * 192) / 3.6;
    const dx = Math.cos(toward);
    const dz = Math.sin(toward);
    const yaw = Math.atan2(-dx, -dz);
    const step = Math.max(1, v * 0.033);
    const gap = (step / v) * 1000;
    const car = game.cars.tesla;
    const before = { x: bx - dx * 3.6, y: bike.y, z: bz - dz * 3.6, yaw, at: 5000 };
    Object.assign(car, { x: before.x + dx * step, y: bike.y, z: before.z + dz * step, yaw, driver: 'anna' });
    game.carAt.tesla = before.at + gap;
    game.players.get('anna') ?? game.players.set('anna', { bikeKnocks: [] });
    const anna = game.players.get('anna');
    anna.bikeKnocks = [];
    H.strike('anna', anna, car, before, Date.now());
    const moved = Math.hypot(bike.x - bx, bike.z - bz);
    assert.ok(moved <= 8 + 1e-9, `${i}: ${moved} m`);
    if (moved > 0) {
      thrown++;
      assert.ok(H.spotOk(bike.x, bike.z, bike.yaw, 'tesla'), `${i}: lies where it may: ${JSON.stringify(bike)}`);
      assert.ok(!H.env.indoors(bike.x, bike.z), `${i}: not indoors`);
      assert.equal(homeAt(bike.x, bike.z, bike.y + 0.3), null, `${i}: not in a locked home`);
      assert.ok(PORTALS.every((p) => Math.hypot(p.x - bike.x, p.z - bike.z) > 2.2), `${i}: off the pads`);
      assert.ok(SPAWNS.every((s) => Math.hypot(s.x - bike.x, s.z - bike.z) > 1.5), `${i}: off the start places`);
      assert.ok(BOUNDS.map.inside(bike.x, bike.z), `${i}: inside the edge`);
    }
  }
  assert.ok(thrown > 60, `most were thrown somewhere (${thrown} of 200)`);
});

test('a state far past the movement budget is cut short: a bike beyond where the car may be stays', () => {
  const { bike, car, driver, drive, knocks, still } = onRoad();
  Object.assign(bike, { x: ROAD.x - 20 });
  const at = { x: bike.x, z: bike.z };
  const anna = driver('anna', ROAD.x);
  // 40 m in 33 ms, with an empty budget: the car gets about 2 m (66.7 m/s), not to the bike 20 m on.
  drive('anna', anna, ROAD.x - 40, 33, ROAD.z, {}, 0);
  assert.ok(car.x > ROAD.x - 3, `cut short at ${car.x}`);
  still(bike, at);
  assert.equal(knocks().length, 0);
});

test('two states at 55 m/s either side of a bike, the car\'s box at neither end on it, still knock it (the sweep)', () => {
  const { bike, car, driver, drive, knocks } = onRoad();
  const anna = driver('anna', ROAD.x + 4.5);
  assert.equal(sweptHit(CAR_BOX, { x: ROAD.x + 4.5, z: ROAD.z, yaw: ROAD.yaw }, { x: ROAD.x + 4.5, z: ROAD.z, yaw: ROAD.yaw }, { ...bike, ...BIKE_BOX }), null);
  drive('anna', anna, ROAD.x - 4.5, 163); // 9 m in 163 ms: 55 m/s
  assert.equal(car.x, ROAD.x - 4.5);
  assert.equal(knocks().length, 1);
  assert.ok(knocks()[0].knock.v > 50);
});

test('getting on a lying bike: from next to it it stands up and stays where it is left; from afar refused', () => {
  const { game, bike, car, driver, run, player, ask, told } = onRoad();
  const anna = driver('anna');
  run('anna', anna, car.x, ROAD.x - 10, 80);
  assert.ok(bike.lie);
  const lying = { x: bike.x, z: bike.z };
  const far = player('far', { x: bike.x + 6, y: bike.y, z: bike.z });
  ask('far', far, { t: 'bike', op: 'on', id: 'church1' });
  assert.equal(bike.rider, null);
  assert.ok(bike.lie, 'still lying');
  const bert = player('bert', { x: bike.x + 1, y: bike.y, z: bike.z });
  ask('bert', bert, { t: 'bike', op: 'on', id: 'church1' });
  assert.equal(bike.rider, 'bert');
  assert.equal(bike.lie, 0);
  assert.equal(told.at(-1).bike.lie, 0);
  assert.ok(bike.x === lying.x && bike.z === lying.z);
  // Ridden and left: it stays there, even after the time a lying one goes back.
  ask('bert', bert, { t: 'bike', op: 'off' });
  game.bikeHits.homeMs = 0;
  game.bikeHits.home(Date.now() + 1);
  assert.ok(bike.x === lying.x && bike.z === lying.z && bike.rider === null);
});

test('a knocked bike left lying goes back to its own spot after the time (5 minutes), for everyone', () => {
  const { game, bike, car, driver, run, told } = onRoad();
  game.bikeHits.homeMs = 50;
  const anna = driver('anna');
  run('anna', anna, car.x, ROAD.x - 10, 80);
  assert.ok(bike.lie);
  const t = Date.now();
  game.bikeHits.home(t + 10);
  assert.ok(bike.lie, 'not yet');
  game.bikeHits.home(t + 60);
  const park = BIKES.bikes.church1.park;
  assert.deepEqual({ x: bike.x, y: bike.y, z: bike.z, yaw: bike.yaw, lie: bike.lie }, { ...park, lie: 0 });
  assert.equal(told.at(-1).home, true);
  assert.equal(told.at(-1).bike.id, 'church1');
  assert.equal(game.bikeHits.knocks.size, 0);
  // The constant itself: five minutes.
  assert.equal(onRoad().game.bikeHits.homeMs, 5 * 60_000);
});

test('the tick carries the lying bike, and a player who joins later is given it where it lies', () => {
  const { game, bike, car, driver, run, player } = onRoad();
  const anna = driver('anna');
  run('anna', anna, car.x, ROAD.x - 10, 80);
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
  const { game, bike, car, driver, run, knocks, still } = onRoad();
  const at = { x: bike.x, z: bike.z };
  Object.defineProperty(game.modes, 'zombies', { get: () => ({ fell: new Map() }), configurable: true });
  const anna = driver('anna');
  run('anna', anna, car.x, ROAD.x - 10, 80);
  still(bike, at);
  delete game.modes.zombies;
  game.room = { id: 'r1', edge: BOUNDS.map };
  const before = { x: ROAD.x + 3, y: bike.y, z: ROAD.z, yaw: ROAD.yaw, at: 1000 };
  Object.assign(car, { x: ROAD.x - 3, driver: 'anna' });
  game.carAt.tesla = 1100;
  game.bikeHits.strike('anna', anna, car, before, Date.now());
  still(bike, at);
  assert.equal(knocks().length, 0);
});
