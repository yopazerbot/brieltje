import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';
import { STAGE, VEHICLE } from './vehicleDamage.mjs';

// A car's look (`dent`, src/world/carDamage.ts): its dents, scratches and mud as its driver's page shows them, nine
// whole numbers 0 to 15. Only the car's driver may set it, at most every 800 ms, only exactly that shape; it is kept as
// a copy on the car and passed on to the others as the car's look, and changes nothing else about the car or anyone.

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const game = new Game({ session: () => null, store: { addStats: async () => {}, setMeta: async () => {} }, log: () => {} }, []);
  for (const t of game.timers) clearInterval(t);
  const told = [];
  game.broadcast = (m, except) => told.push(structuredClone({ ...m, except }));
  game.send = () => {};
  game.stampState = () => {};
  const car = game.cars.tesla;
  const player = (name, at) => {
    const p = {
      ws: { name }, key: `k-${name}`, role: 'player', alive: true, protectedUntil: 0, drop: null, warp: 0, stamp: 0,
      state: { x: at.x, y: at.y, z: at.z, yaw: 0, pitch: 0, armed: false, flying: false, w: 'pistol', c: false },
      weapons: new Set(['pistol']), nades: [0, 0], thrown: [], window: clock, msgs: 0, states: 0, others: 0, budget: 0.5, vbudget: 0.5, movedAt: clock,
      hp: 100, score: { kills: 0, deaths: 0, points: 0 }, proto: 2,
    };
    game.players.set(name, p);
    return p;
  };
  /** A message from `p`, the flood guard's window and the vehicles' 300 ms gate let go (not the dent's own). */
  const send = (name, p, m) => {
    p.window = clock;
    p.msgs = p.states = p.others = 0;
    p.nextCar = 0;
    game.handle(name, p, JSON.stringify(m));
  };
  const at = (ms) => (clock += ms);
  const dan = player('dan', { x: car.x - 1.5, y: car.y, z: car.z });
  const pam = player('pam', { x: car.x + 1.5, y: car.y, z: car.z });
  const eve = player('eve', { x: car.x + 3, y: car.y, z: car.z + 2 });
  send('dan', dan, { t: 'car', op: 'in', id: 'tesla' });
  send('pam', pam, { t: 'car', op: 'in', id: 'tesla' });
  assert.deepEqual([car.driver, car.passenger], ['dan', 'pam']);
  told.length = 0;
  return { game, car, told, send, at, dan, pam, eve };
}

const LOOK = [3, 0, 0, 0, 0, 0, 0, 9, 4];
const looks = (told) => told.filter((m) => m.t === 'car').map((m) => m.car.dm);

test('the driver\'s look is kept as a copy on the car and passed on to everyone with the car', () => {
  const { car, told, send, dan } = setup();
  const before = { x: car.x, y: car.y, z: car.z, yaw: car.yaw, s: car.s, driver: car.driver, passenger: car.passenger };
  send('dan', dan, { t: 'dent', dm: LOOK });
  assert.deepEqual(car.dm, LOOK);
  assert.deepEqual(looks(told), [LOOK]);
  assert.deepEqual({ x: car.x, y: car.y, z: car.z, yaw: car.yaw, s: car.s, driver: car.driver, passenger: car.passenger }, before, 'nothing else about the car changed');
  assert.deepEqual(Object.keys(car).filter((k) => !(k in before) && k !== 'id' && k !== 'dm'), [], 'no other field was added');
});

test('only the driver: not the passenger, not someone outside the car', () => {
  const { car, told, send, pam, eve } = setup();
  send('pam', pam, { t: 'dent', dm: LOOK });
  send('eve', eve, { t: 'dent', dm: LOOK });
  assert.equal(car.dm, undefined);
  assert.deepEqual(looks(told), []);
});

test('only nine whole numbers 0 to 15: everything else is dropped without a word', () => {
  const { car, told, send, dan, at } = setup();
  const bad = [
    undefined, null, 7, 'abc', {}, { 0: 1, length: 9 }, [], LOOK.slice(0, 8), [...LOOK, 0],
    [16, 0, 0, 0, 0, 0, 0, 0, 0], [-1, 0, 0, 0, 0, 0, 0, 0, 0], [1.5, 0, 0, 0, 0, 0, 0, 0, 0], ['1', 0, 0, 0, 0, 0, 0, 0, 0],
    [null, 0, 0, 0, 0, 0, 0, 0, 0], [1e9, 0, 0, 0, 0, 0, 0, 0, 0], [[1], 0, 0, 0, 0, 0, 0, 0, 0], [true, 0, 0, 0, 0, 0, 0, 0, 0],
  ];
  for (const dm of bad) {
    at(1000);
    send('dan', dan, { t: 'dent', dm });
  }
  assert.equal(car.dm, undefined);
  assert.deepEqual(looks(told), []);
});

test('at most every 800 ms; the same look again is not passed on', () => {
  const { car, told, send, dan, at } = setup();
  send('dan', dan, { t: 'dent', dm: LOOK });
  at(300);
  send('dan', dan, { t: 'dent', dm: [15, 15, 15, 15, 15, 15, 15, 15, 15] });
  assert.deepEqual(car.dm, LOOK, 'too soon: dropped');
  at(800);
  send('dan', dan, { t: 'dent', dm: LOOK });
  assert.deepEqual(looks(told), [LOOK], 'the same again: nothing passed on');
  at(800);
  const next = [4, 0, 0, 0, 0, 0, 0, 9, 4];
  send('dan', dan, { t: 'dent', dm: next });
  assert.deepEqual(car.dm, next);
  assert.deepEqual(looks(told), [LOOK, next]);
  // A flood: one a millisecond for 2 s gets at most three through.
  told.length = 0;
  for (let i = 0; i < 2000; i++) {
    at(1);
    send('dan', dan, { t: 'dent', dm: [i % 16, 0, 0, 0, 0, 0, 0, 0, 0] });
  }
  assert.ok(looks(told).length <= 3, `${looks(told).length} passed on`);
});

test('the look stays with the car after the driver gets out, and a new driver may change it', () => {
  const { car, send, dan, pam, at } = setup();
  send('dan', dan, { t: 'dent', dm: LOOK });
  send('dan', dan, { t: 'car', op: 'out' });
  send('pam', pam, { t: 'car', op: 'out' });
  assert.deepEqual(car.dm, LOOK);
  at(1000);
  send('dan', dan, { t: 'dent', dm: [0, 0, 0, 0, 0, 0, 0, 0, 0] });
  assert.deepEqual(car.dm, LOOK, 'out of the car: no say');
  Object.assign(pam.state, { x: car.x + 1.5, z: car.z });
  send('pam', pam, { t: 'car', op: 'in', id: 'tesla' });
  assert.equal(car.driver, 'pam');
  at(1000);
  send('pam', pam, { t: 'dent', dm: [0, 0, 0, 0, 0, 0, 0, 0, 2] });
  assert.deepEqual(car.dm, [0, 0, 0, 0, 0, 0, 0, 0, 2]);
});

/** A team match on (vehicles take damage only then), its vehicles' clock started; ticks of `ms` after. */
function match(s) {
  const now = Date.now();
  s.game.modes.state = { kind: 'teams', phase: 'playing', until: now + 600_000, teams: Object.create(null), score: { house: 0, bungalow: 0 }, switched: Object.create(null), goal: 25 };
  const vd = s.game.vehicleDamage;
  vd.tick(now);
  const ticks = (ms) => {
    for (let t = 0; t < ms; t += 100) {
      s.at(100);
      vd.tick(Date.now());
    }
  };
  /** Car `c` destroyed by the server's own vehicle damage (no attacker: nobody's kill, no blast). */
  const wreck = (c) => vd.harm('car', c.id, c, VEHICLE.health.car, null, 'rifle', Date.now());
  return { vd, ticks, wreck };
}

/** Every `car` and `vdmg` message told through broadcastThing (its home's audience only), as it was then. */
function things(game) {
  const out = [];
  const broadcastThing = game.broadcastThing.bind(game);
  game.broadcastThing = (msg, kind, t, except) => {
    if (msg.t === 'car' || msg.t === 'vdmg') out.push({ ...structuredClone(msg), kind, same: msg.t !== 'car' || t === msg.car });
    return broadcastThing(msg, kind, t, except);
  };
  return out;
}

test('a wreck back whole: its dents and broken parts gone on the server and on every page, its mud kept', () => {
  const s = setup();
  const { car, send, dan, pam, eve } = s;
  send('dan', dan, { t: 'dent', dm: LOOK });
  const { vd, ticks, wreck } = match(s);
  wreck(car);
  assert.equal(vd.out('car', car.id), true, 'a wreck');
  assert.deepEqual([car.driver, car.passenger], [null, null], 'everyone put out');
  assert.deepEqual(car.dm, LOOK, 'a wreck keeps its look while it lies');
  for (const p of [dan, pam, eve]) p.state.x += 40; // away from its parking place: it may go home
  const told = things(s.game);
  ticks(VEHICLE.wreckMs + VEHICLE.goneMs + 1000);
  assert.equal(vd.recs.size, 0, 'whole again');
  assert.deepEqual(car.dm, [0, 0, 0, 0, 0, 0, 0, 0, 4], 'dents, glass and lamps mended, the mud kept');
  const whole = told.findIndex((m) => m.t === 'vdmg' && m.st === STAGE.whole);
  const mended = told.findIndex((m) => m.t === 'car' && m.car.dm.every((v, i) => (i < 8 ? v === 0 : v === 4)));
  assert.ok(mended >= 0 && mended < whole, 'every page told the mended look, then that it is whole');
  const m = told[mended];
  assert.equal(m.kind, 'car');
  assert.ok(m.same, 'about the car itself, to those who may see it where it stands (broadcastThing)');
  // Nobody at its wheel: every page takes it as the car's look, its last driver's too (src/main.ts 'car': only the
  // page of the car's driver skips the look, its own dents being newer than the server's echo).
  assert.deepEqual([m.car.driver, m.car.passenger ?? null], [null, null]);
  // A new driver dents it again as before.
  Object.assign(pam.state, { x: car.x + 1.5, z: car.z });
  send('pam', pam, { t: 'car', op: 'in', id: car.id });
  assert.equal(car.driver, 'pam');
  s.at(1000);
  send('pam', pam, { t: 'dent', dm: [2, 0, 0, 0, 0, 0, 0, 0, 5] });
  assert.deepEqual(car.dm, [2, 0, 0, 0, 0, 0, 0, 0, 5]);
});

test('the match ends: a wreck comes back mended at once; a car only damaged keeps its dents; one never dented is not told', () => {
  const s = setup();
  const { game, car, send, dan, pam } = s;
  send('dan', dan, { t: 'dent', dm: LOOK });
  send('dan', dan, { t: 'car', op: 'out' });
  send('pam', pam, { t: 'car', op: 'out' });
  const other = game.cars.model3;
  other.dm = [0, 5, 0, 0, 0, 0, 0, 0, 1];
  const { vd, ticks, wreck } = match(s);
  wreck(car);
  vd.harm('car', other.id, other, Math.round(VEHICLE.health.car * 0.6), null, 'rifle', Date.now()); // smoking, not a wreck
  const plain = Object.values(game.cars).find((c) => c !== car && c !== other && !c.dm);
  wreck(plain);
  ticks(1000);
  const told = things(game);
  game.modes.state = { kind: 'free' };
  ticks(100);
  assert.equal(vd.recs.size, 0);
  assert.deepEqual(car.dm, [0, 0, 0, 0, 0, 0, 0, 0, 4], 'the wreck: mended, the mud kept');
  assert.deepEqual(other.dm, [0, 5, 0, 0, 0, 0, 0, 0, 1], 'only damaged: its dents are its own');
  assert.equal(plain.dm, undefined, 'never dented: no look made up');
  assert.deepEqual(told.filter((m) => m.t === 'car' && m.car.dm).map((m) => m.car.id), [car.id], 'one mended look told');
});
