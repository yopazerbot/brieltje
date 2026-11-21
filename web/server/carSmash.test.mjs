import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Game } from './game.mjs';

// A parked car that a driven one runs into is dented where it was hit (server/carSmash.mjs). The server finds the hit
// itself in the driver's states, with its own record of both cars and its own clock; no message of a page dents a car
// that someone else drives or that stands across the map. A fake clock drives both the server's own clock and the wall
// clock; this file runs in a process of its own.

let T = 1_000_000;
const BASE = 1_800_000_000_000;
Date.now = () => BASE + T;
performance.now = () => T;
const wait = (ms) => (T += ms);

const CARS = JSON.parse(readFileSync(new URL('../shared/car.json', import.meta.url), 'utf8')).cars;
/** The road in front of the house, along x: the Tesla drives along -x (yaw pi / 2) into the back of the parked Model 3. */
const ROAD = { x: 40, z: 22.5, yaw: Math.PI / 2 };

function onRoad() {
  const game = new Game({ session: () => null, store: { addStats: async () => {} } }, []);
  for (const t of game.timers ?? []) clearInterval(t);
  const told = [];
  game.broadcast = (m, except) => told.push({ ...JSON.parse(JSON.stringify(m)), except });
  game.send = () => {};
  const y = game.bikeHits.env.ground(ROAD.x, ROAD.z);
  const parked = game.cars.model3;
  Object.assign(parked, { x: ROAD.x, y, z: ROAD.z, yaw: ROAD.yaw });
  const car = game.cars.tesla;
  /** m from the parked car's middle where the Tesla's nose touches its tail */
  const touch = CARS.tesla.length / 2 + CARS.model3.length / 2 + 0.05;
  const player = (name, at) => {
    const now = Date.now();
    const p = {
      ws: { name }, key: `k-${name}`, role: 'player', alive: true, protectedUntil: 0, drop: null, warp: 0, stamp: 0, ctGap: null, ctAt: 0,
      state: { x: at.x, y, z: at.z, yaw: 0, pitch: 0, armed: false, flying: false, w: 'pistol', c: false },
      weapons: new Set(['pistol']), nades: [0, 0], window: now, msgs: 0, states: 0, others: 0, budget: 0.5, vbudget: 0.5, movedAt: now,
      hp: 100, score: { kills: 0, deaths: 0, points: 0 }, joinTime: now,
    };
    game.players.set(name, p);
    return p;
  };
  const send = (name, p, m) => game.handle(name, p, JSON.stringify(m));
  const state = (name, p, x, ms = 33, z = ROAD.z) => {
    wait(ms);
    send(name, p, { t: 'state', x, y, z, yaw: ROAD.yaw, pitch: 0, armed: false, w: 'pistol', ct: T });
  };
  /** `name` gets in the Tesla `from` m behind the parked car and sits a second. */
  const driver = (name, from) => {
    Object.assign(car, { x: ROAD.x + from, y, z: ROAD.z, yaw: ROAD.yaw });
    const p = player(name, { x: car.x + 1.5, z: car.z + 1.5 });
    p.nextCar = 0;
    send(name, p, { t: 'car', op: 'in', id: 'tesla' });
    assert.equal(car.driver, name, 'at the wheel');
    for (let i = 0; i < 30; i++) state(name, p, car.x);
    return p;
  };
  /** Drive at `kmh` to `stop` m from the parked car's middle, a state every 33 ms. */
  const run = (name, p, kmh, stop = touch) => {
    const step = (kmh / 3.6) * 0.033;
    for (let x = car.x - step; x >= ROAD.x + stop; x -= step) state(name, p, x);
    state(name, p, ROAD.x + stop);
  };
  const dents = () => told.filter((m) => m.t === 'car' && m.car.id === 'model3' && m.car.dm);
  return { game, told, car, parked, touch, player, send, state, driver, run, dents };
}

test('a parked car run into at 40 km/h is dented at its back, told to everyone as its look', () => {
  const { driver, run, dents, parked } = onRoad();
  const anna = driver('anna', 20);
  run('anna', anna, 40);
  const got = dents();
  assert.equal(got.length, 1, 'one message');
  const dm = got[0].car.dm;
  assert.equal(got[0].except, undefined, 'to every page');
  assert.equal(dm.length, 9);
  assert.ok(dm[4] >= 4, `its back (zone 4) dented: ${dm}`);
  for (const k of [0, 1, 2, 6, 7]) assert.equal(dm[k], 0, `zone ${k} untouched: ${dm}`);
  assert.equal(dm[8], 0, 'no mud');
  assert.deepEqual(parked.dm, dm, 'kept on the car');
  assert.equal(parked.driver, null);
});

test('harder hits dent more; under the page\'s 9 km/h nothing', () => {
  const zone = (kmh) => {
    const { driver, run, dents } = onRoad();
    run('anna', driver('anna', 25), kmh);
    return dents().at(-1)?.car.dm[4] ?? 0;
  };
  assert.equal(zone(7), 0);
  const [a, b, c] = [zone(25), zone(50), zone(80)];
  assert.ok(a > 0 && a < b && b < c, `${a} < ${b} < ${c}`);
});

test('one crash is one hit: standing against it, or pushing on, adds nothing', () => {
  const { driver, run, state, dents } = onRoad();
  const anna = driver('anna', 20);
  run('anna', anna, 40);
  const first = dents().length;
  const x = anna.state.x;
  for (let i = 0; i < 60; i++) state('anna', anna, x - (i % 2) * 0.02);
  assert.equal(first, 1);
  assert.equal(dents().length, first);
});

test('a car someone drives is not dented by it (its own driver\'s page dents it)', () => {
  const { game, driver, run, dents, player, send } = onRoad();
  const bo = player('bo', { x: ROAD.x + 1.5, z: ROAD.z + 1.5 });
  bo.nextCar = 0;
  send('bo', bo, { t: 'car', op: 'in', id: 'model3' });
  assert.equal(game.cars.model3.driver, 'bo');
  run('anna', driver('anna', 20), 40);
  assert.equal(dents().length, 0);
});

test('a lurch from a standstill straight into it, within the budget, buys no dent', () => {
  const { car, driver, state, dents, touch } = onRoad();
  const anna = driver('anna', 0);
  car.x = ROAD.x + touch + 1;
  for (let i = 0; i < 30; i++) state('anna', anna, car.x);
  state('anna', anna, ROAD.x + touch);
  assert.equal(dents().length, 0);
});

test('passing beside it, close but not touching, dents nothing', () => {
  const { car, driver, state, dents } = onRoad();
  const z = ROAD.z + (CARS.tesla.width + CARS.model3.width) / 2 + 0.4;
  const anna = driver('anna', 20);
  for (let i = 0; i < 30; i++) state('anna', anna, car.x, 33, z);
  for (let x = car.x; x > ROAD.x - 20; x -= 0.4) state('anna', anna, x, 33, z); // 44 km/h
  assert.ok(car.x < ROAD.x - 15, 'it drove past');
  assert.equal(dents().length, 0);
});
