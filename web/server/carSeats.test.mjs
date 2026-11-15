import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { HOMES, homeAt } from '../shared/homes.mjs';
import { Game } from './game.mjs';
import { SEAT_ALLOWED, SEAT_REFUSED } from './carSeats.mjs';

// The cars' seats (server/carSeats.mjs): a passenger is where the car is, whatever their page says; the driver's step
// takes them along and never into a code-locked home they may not enter; getting out puts them beside the car with
// walking's budgets; nothing is taken, collected, tagged or hurt from a car's seat or a bike's saddle; hits and blasts
// agree (nobody in a car or on a bike is hurt by either). Each forged message below must change nothing it may not.

const GAME_SRC = readFileSync(new URL('./game.mjs', import.meta.url), 'utf8');
const PICKUPS = JSON.parse(readFileSync(new URL('../shared/pickups.json', import.meta.url), 'utf8'));
const RUN_SPEED = 1.4 * 2.5 * 1.3; // m/s across on foot (game.mjs)
const MAX_SPEED = 16; // m/s up or down on foot (game.mjs)

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const game = new Game({ session: () => null, store: { addStats: async () => {}, setMeta: async () => {} }, log: () => {} }, []);
  for (const t of game.timers) clearInterval(t);
  const told = [];
  const sent = new Map();
  game.broadcast = (m, except) => told.push(structuredClone({ ...m, except }));
  game.send = (ws, m) => sent.get(ws.name)?.push(structuredClone(m));
  game.stampState = () => {};
  const car = game.cars.tesla;
  const player = (name, at = { x: car.x + 1.5, y: car.y, z: car.z }, role = 'player') => {
    const p = {
      ws: { name }, key: `k-${name}`, role, alive: true, protectedUntil: 0, drop: null, warp: 0, stamp: 0,
      state: { x: at.x, y: at.y, z: at.z, yaw: 0, pitch: 0, armed: true, flying: false, w: 'pistol', c: false },
      weapons: new Set(['pistol']), nades: [0, 0], thrown: [], window: clock, msgs: 0, states: 0, others: 0, budget: 0.5, vbudget: 0.5, movedAt: clock,
      hp: 100, score: { kills: 0, deaths: 0, points: 0 }, proto: 2,
    };
    sent.set(name, []);
    game.players.set(name, p);
    return p;
  };
  /** A message from `p`, with the flood guard's window and the vehicles' 300 ms gate let go. */
  const send = (name, p, m) => {
    p.window = clock;
    p.msgs = p.states = p.others = 0;
    p.nextCar = 0;
    game.handle(name, p, JSON.stringify(m));
  };
  /** A state `dt` ms after the last (the clock moves on), at `to` (missing fields: where the server has them). */
  const state = (name, p, to = {}, dt = 50) => {
    clock += dt;
    const s = p.state;
    send(name, p, { t: 'state', x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: 0, armed: s.armed, w: 'pistol', ...to });
  };
  /** The car put at `pos` by the test (not by a message), everyone in it with it. */
  const put = (pos) => {
    Object.assign(car, pos);
    for (const n of [car.driver, car.passenger]) if (n) Object.assign(game.players.get(n).state, { x: car.x, y: car.y, z: car.z });
  };
  const at = (ms) => (clock += ms);
  return { game, told, sent, car, player, send, state, put, at, now: () => clock };
}

/** A driver and a passenger in the Tesla, both armed with a rifle too. */
function crew(s) {
  const dan = s.player('dan', { x: s.car.x - 1.5, y: s.car.y, z: s.car.z });
  const pam = s.player('pam', { x: s.car.x + 1.5, y: s.car.y, z: s.car.z });
  s.send('dan', dan, { t: 'car', op: 'in', id: 'tesla' });
  s.send('pam', pam, { t: 'car', op: 'in', id: 'tesla' });
  assert.deepEqual([s.car.driver, s.car.passenger], ['dan', 'pam']);
  Object.assign(dan.state, { x: s.car.x, y: s.car.y, z: s.car.z }); // the driver's page sends the car's pose from here on
  for (const p of [dan, pam]) p.weapons.add('shotgun');
  return [dan, pam];
}

const off = (p, c) => Math.hypot(p.state.x - c.x, p.state.z - c.z);

test('a passenger\'s forged position moves nobody: they stay where the car is, the car and the driver stay put', () => {
  const s = setup();
  const { car, state } = s;
  const [dan, pam] = crew(s);
  // The reviewer's attack: 6 s of states 300 m off while the car stands (it was 71 m/s on main).
  const c0 = { x: car.x, y: car.y, z: car.z };
  for (let i = 0; i < 150; i++) state('pam', pam, { x: pam.state.x + (i < 75 ? 300 : -300), y: pam.state.y + 30, z: pam.state.z - 40, yaw: 1.2 }, 40);
  assert.deepEqual([pam.state.x, pam.state.y, pam.state.z], [c0.x, c0.y, c0.z], 'pinned to the car');
  assert.equal(pam.state.yaw, 1.2, 'looking round stays theirs');
  assert.deepEqual({ x: car.x, y: car.y, z: car.z }, c0, 'the car never moves for a passenger');
  assert.deepEqual([dan.state.x, dan.state.z], [c0.x, c0.z]);
  assert.equal(pam.state.d, true, 'still in the car for everyone');
});

test('the driver drives: the passenger goes along; a passenger with no driver stays in the standing car', () => {
  const s = setup();
  const { game, car, state } = s;
  const [dan, pam] = crew(s);
  for (let i = 0; i < 20; i++) state('dan', dan, { z: dan.state.z + 1 });
  assert.ok(car.z > 14.5 + 15, `the car went (${car.z.toFixed(1)})`);
  assert.deepEqual([pam.state.x, pam.state.y, pam.state.z], [car.x, car.y, car.z], 'the passenger is where the car is');
  s.send('dan', dan, { t: 'car', op: 'out' });
  const c0 = { x: car.x, z: car.z };
  for (let i = 0; i < 20; i++) state('pam', pam, { z: pam.state.z + 3 });
  assert.equal(game.carOf('pam'), car, 'still the passenger');
  assert.deepEqual({ x: car.x, z: car.z }, c0, 'no driver: the car stands');
  assert.deepEqual([pam.state.x, pam.state.z], [car.x, car.z]);
});

test('out: beside the car by the page\'s rule, budgets started again; a forged 60 m step after it takes under 3 m', () => {
  const s = setup();
  const { car, state } = s;
  const [dan, pam] = crew(s);
  s.put({ x: 30, z: 40, yaw: 0 }); // somewhere open, facing -z
  for (const x of [30 + 1.41, 30 - 1.41]) assert.ok(s.game.carSeats.free(x, 40 - 0.3, car.y + 0.5, car.y + 1.8), 'no wall at either door');
  state('dan', dan, {}, 1000); // standing a while: a full budget stored in the car
  state('pam', pam, {}, 1000);
  s.send('pam', pam, { t: 'car', op: 'out' });
  assert.equal(s.game.carOf('pam'), null);
  const side = 1.92 / 2 + 0.45; // the Model Y's half width and the page's 45 cm (world/car.ts exitSpot)
  const d = off(pam, car);
  assert.ok(Math.abs(d - Math.hypot(side, 0.3)) < 1e-6, `by the door: ${d.toFixed(2)} m from the middle`);
  // Facing -z, the passenger's door is on +x (the right), the driver's on -x.
  assert.ok(pam.state.x > car.x, 'the passenger\'s side');
  assert.equal(pam.budget, 0.5);
  assert.equal(pam.state.d, false, 'on foot');
  const from = { x: pam.state.x, z: pam.state.z };
  state('pam', pam, { x: pam.state.x + 60, z: pam.state.z + 10 });
  const step = Math.hypot(pam.state.x - from.x, pam.state.z - from.z);
  assert.ok(step < 3 && step <= 0.5 + RUN_SPEED * 0.05 + 1e-9, `${step.toFixed(2)} m`);
  // The driver gets out on their own side.
  s.send('dan', dan, { t: 'car', op: 'out' });
  assert.ok(dan.state.x < car.x && Math.abs(off(dan, car) - Math.hypot(side, 0.3)) < 1e-6, 'the driver by their door');
  assert.equal(dan.budget, 0.5);
});

test('out: never into a wall the server knows, a home without the right or past the edge; else the next spot or the middle', () => {
  const s = setup();
  const { game, car, put } = s;
  const [, pam] = crew(s);
  put({ x: 30, z: 40, yaw: 0 });
  // The passenger's door side refused (as a wall or a home would be): the other side.
  const right = (x) => x > car.x + 0.5;
  game.gate.mayStand = (p, x) => !right(x);
  s.send('pam', pam, { t: 'car', op: 'out' });
  assert.ok(pam.state.x < car.x, 'the other side');
  // Nowhere: the car's middle.
  s.send('pam', pam, { t: 'car', op: 'in', id: 'tesla' });
  game.gate.mayStand = () => false;
  s.send('pam', pam, { t: 'car', op: 'out' });
  assert.deepEqual([pam.state.x, pam.state.z], [car.x, car.z]);
});

test('a respawn or a death: out of the seat, at the start place or beside the car', () => {
  const s = setup();
  const { game, car, now } = s;
  const [dan, pam] = crew(s);
  game.respawn('pam', pam, now());
  assert.equal(car.passenger, null);
  assert.ok(off(pam, car) > 3, 'at a start place');
  assert.equal(pam.budget, 0.5);
  const foe = s.player('foe', { x: 0, y: -0.1, z: 0 });
  game.damage('foe', foe, 'dan', dan, 500, false, 'rifle', now());
  assert.equal(car.driver, null, 'dead: out');
  assert.ok(off(dan, car) < 2);
});

test('the driver\'s step never carries a passenger into a home they may not enter; their own right lets them in', () => {
  const s = setup();
  const { game, car, put, state } = s;
  const home = HOMES.find((h) => h.id === 'house');
  // A point inside the main house at the car's height, and one 6 m outside it.
  let inside = null;
  for (let x = home.box[0]; x <= home.box[2] && !inside; x += 0.25) for (let z = home.box[1]; z <= home.box[3] && !inside; z += 0.25) if (homeAt(x, z, -0.05) === 'house' && homeAt(x, z + 6, -0.05) !== 'house' && z + 6 > home.box[3]) inside = { x, z };
  assert.ok(inside, 'a point inside the house');
  const [dan, pam] = crew(s);
  dan.role = 'admin'; // the driver may go in (the admin may), the passenger may not
  put({ x: inside.x, y: -0.05, z: inside.z + 6 });
  const c0 = { x: car.x, z: car.z };
  for (let i = 0; i < 5; i++) state('dan', dan, { x: inside.x, y: -0.05, z: inside.z });
  assert.deepEqual({ x: car.x, z: car.z }, c0, 'the step is put back');
  assert.equal(homeAt(pam.state.x, pam.state.z, pam.state.y), null);
  // Without a passenger the admin drives in (their own right, as walking in).
  s.send('pam', pam, { t: 'car', op: 'out' });
  for (let i = 0; i < 5; i++) state('dan', dan, { x: inside.x, y: -0.05, z: inside.z });
  assert.equal(homeAt(car.x, car.z, car.y), 'house');
  assert.equal(game.carOf('pam'), null);
});

test('up and down: a car climbs no faster than a walker may (it was the car\'s 67 m/s)', () => {
  const s = setup();
  const { car, state } = s;
  const [dan] = crew(s);
  const y0 = car.y;
  for (let i = 0; i < 20; i++) state('dan', dan, { y: dan.state.y + 30 }); // 1 s of claims of 30 m every 50 ms
  const rose = car.y - y0;
  assert.ok(rose <= MAX_SPEED * 1 + MAX_SPEED * 0.5 + 0.5 + 1e-6, `${rose.toFixed(1)} m in 1 s`);
  // Across the car's speed still holds (an honest drive is unchanged).
  const x0 = car.x;
  for (let i = 0; i < 20; i++) state('dan', dan, { x: dan.state.x + 2.5 });
  assert.ok(car.x - x0 > 49, `across at 50 m/s: ${(car.x - x0).toFixed(1)} m`);
});

test('hits and blasts agree: nobody in a car or on a bike is hurt by either, and nobody fights from one', () => {
  const s = setup();
  const { game, car, send, now } = s;
  const [dan, pam] = crew(s);
  const foe = s.player('foe', { x: car.x + 3, y: car.y, z: car.z });
  const kid = s.player('kid', { x: car.x - 3, y: car.y, z: car.z + 2 });
  const bike = Object.values(game.bikes)[0];
  Object.assign(bike, { x: car.x - 3, y: car.y, z: car.z + 2, rider: 'kid' });
  foe.weapons.add('rifle');
  for (const target of ['dan', 'pam', 'kid']) {
    foe.nextHit = 0;
    send('foe', foe, { t: 'hit', target, w: 'pistol', body: 1, head: 0 });
  }
  assert.deepEqual([dan.hp, pam.hp, kid.hp], [100, 100, 100], 'bullets');
  game.blast('foe', { x: car.x, y: car.y + 1, z: car.z + 1 }, 'grenade');
  game.blast('foe', { x: car.x, y: car.y + 1, z: car.z + 1 }, 'bazooka');
  assert.deepEqual([dan.hp, pam.hp, kid.hp], [100, 100, 100], 'blasts');
  // Control: the same blast hurts someone on foot there.
  const walker = s.player('walker', { x: car.x + 0.5, y: car.y, z: car.z + 1 });
  game.blast('foe', { x: car.x, y: car.y + 1, z: car.z + 1 }, 'grenade');
  assert.ok(walker.hp < 100, 'on foot: hurt');
  // From the seats: nothing lands.
  for (const [n, p] of [['dan', dan], ['pam', pam]]) {
    p.nextHit = 0;
    send(n, p, { t: 'hit', target: 'foe', w: 'pistol', body: 1, head: 0 });
  }
  assert.equal(foe.hp, 100);
  void now;
});

test('every refused type, from the driver\'s seat, the passenger\'s and a bike\'s saddle, changes nothing', () => {
  const s = setup();
  const { game, car, told, send } = s;
  const [dan, pam] = crew(s);
  const kid = s.player('kid', { x: car.x - 3, y: car.y, z: car.z + 2 });
  Object.assign(Object.values(game.bikes)[0], { x: kid.state.x, y: kid.state.y, z: kid.state.z, rider: 'kid' });
  const foe = s.player('foe', { x: car.x + 1, y: car.y, z: car.z });
  for (const t of SEAT_REFUSED) {
    for (const [name, p] of [['dan', dan], ['pam', pam], ['kid', kid]]) {
      const n = told.length;
      const before = JSON.stringify([[...p.weapons], foe.hp, game.items.map((i) => i.until), game.catsDown, game.doors]);
      send(name, p, { t, target: 'foe', w: 'pistol', body: 1, head: 0, i: 0, id: Object.keys(game.doors)[0] ?? 'x', open: true, x: car.x, y: car.y, z: car.z, kind: 'claymore', ids: [0], b: 0, v: [1, 0, 0] });
      assert.equal(told.length, n, `${t} from ${name}: nothing told`);
      assert.equal(JSON.stringify([[...p.weapons], foe.hp, game.items.map((i) => i.until), game.catsDown, game.doors]), before, `${t} from ${name}: nothing changed`);
    }
  }
  assert.equal(game.carOf('dan'), car);
  assert.equal(game.bikeOf('kid')?.rider, 'kid');
});

test('a pickup from a car: refused; on foot at the same spot: taken', () => {
  const s = setup();
  const { game, car, told, send, put } = s;
  const [, pam] = crew(s);
  const spot = PICKUPS[0];
  put({ x: spot.x, y: spot.y, z: spot.z });
  send('pam', pam, { t: 'pickup', i: 0 });
  assert.equal(pam.weapons.has(spot.w), false);
  assert.equal(told.filter((m) => m.t === 'item').length, 0);
  s.send('pam', pam, { t: 'car', op: 'out' });
  Object.assign(pam.state, { x: spot.x, y: spot.y, z: spot.z });
  send('pam', pam, { t: 'pickup', i: 0 });
  assert.equal(pam.weapons.has(spot.w), true, 'on foot: taken');
  void game;
});

test('the treasure hunt: no coin from a car (driver or passenger); on foot at the same coin: counted', () => {
  const s = setup();
  const { game, car, send, put } = s;
  s.player('dan', { x: car.x - 1.5, y: car.y, z: car.z });
  s.player('pam', { x: car.x + 1.5, y: car.y, z: car.z });
  game.modes.start('treasure', 'admin');
  const dan = game.players.get('dan'), pam = game.players.get('pam');
  put({ x: 2.17, y: -0.05, z: 14.5 });
  Object.assign(dan.state, { x: car.x - 1.5, y: car.y, z: car.z });
  Object.assign(pam.state, { x: car.x + 1.5, y: car.y, z: car.z });
  send('dan', dan, { t: 'car', op: 'in', id: 'tesla' });
  send('pam', pam, { t: 'car', op: 'in', id: 'tesla' });
  assert.deepEqual([car.driver, car.passenger], ['dan', 'pam']);
  const coins = game.modes.state.coins;
  const n = coins.length;
  for (const c of [...coins]) {
    put({ x: c.x, y: c.y, z: c.z });
    send('dan', dan, { t: 'coin', i: c.i });
    send('pam', pam, { t: 'coin', i: c.i });
  }
  assert.equal(game.modes.state.coins.length, n, 'every coin still there');
  assert.deepEqual([game.modes.state.counts.dan, game.modes.state.counts.pam], [0, 0]);
  s.send('pam', pam, { t: 'car', op: 'out' });
  const c = game.modes.state.coins[0];
  Object.assign(pam.state, { x: c.x, y: c.y, z: c.z });
  send('pam', pam, { t: 'coin', i: c.i });
  assert.equal(game.modes.state.counts.pam, 1, 'on foot: counted');
});

test('tag: nobody tags from a car; someone in a car can still be tagged (a car is no hiding place)', () => {
  const s = setup();
  const { game, car, send } = s;
  s.player('dan', { x: car.x - 1.5, y: car.y, z: car.z });
  s.player('pam', { x: car.x + 1.5, y: car.y, z: car.z });
  const it = s.player('it', { x: car.x + 2.5, y: car.y, z: car.z });
  game.modes.start('tag', 'admin');
  const dan = game.players.get('dan'), pam = game.players.get('pam');
  Object.assign(car, { x: 2.17, y: -0.05, z: 14.5, yaw: 0 });
  Object.assign(dan.state, { x: car.x - 1.5, y: car.y, z: car.z });
  Object.assign(pam.state, { x: car.x + 1.5, y: car.y, z: car.z });
  Object.assign(it.state, { x: car.x + 1.6, y: car.y, z: car.z });
  send('dan', dan, { t: 'car', op: 'in', id: 'tesla' });
  send('pam', pam, { t: 'car', op: 'in', id: 'tesla' });
  Object.assign(dan.state, { x: car.x, y: car.y, z: car.z }); // the driver's state is the car's
  assert.ok(Math.hypot(it.state.x - dan.state.x, it.state.z - dan.state.z) < 1.8, 'within the tag reach of the car');
  // The driver is it: tagging the one beside the car is refused from the seat.
  game.modes.state.it = 'dan';
  game.modes.state.last = null;
  send('dan', dan, { t: 'tag', target: 'it' });
  assert.equal(game.modes.state.it, 'dan', 'no tag from a seat');
  // On foot, "it" tags the passenger in the car (within reach of the car's middle, where the passenger is).
  game.modes.state.it = 'it';
  send('it', it, { t: 'tag', target: 'pam' });
  assert.equal(game.modes.state.it, 'pam', 'tagged in the car');
});

/** A point inside home `h` (its first band, in the middle of its heights), deep enough that a car's doors are inside too. */
function insideOf(h) {
  const band = h.bands[0];
  const y = band.y0 + Math.min(1, (band.y1 - band.y0) / 2);
  let best = null;
  for (let x = h.box[0]; x <= h.box[2]; x += 0.25) {
    for (let z = h.box[1]; z <= h.box[3]; z += 0.25) {
      if (homeAt(x, z, y) !== h.id) continue;
      const room = [[1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]].filter(([dx, dz]) => homeAt(x + dx, z + dz, y) === h.id).length;
      if (!best || room > best.room) best = { x, y, z, room };
    }
  }
  return best;
}

test('a car standing inside a code-locked home: nobody without the right gets in, and getting out there puts them out of it', () => {
  for (const h of HOMES) {
    const s = setup();
    const { game, car, send, put, sent } = s;
    const at = insideOf(h);
    assert.ok(at, `${h.id}: a point inside`);
    put({ x: at.x, y: at.y, z: at.z, yaw: 0 }); // left there by a code's holder with a changed page
    // A guest within reach (on the server's positions) asks to get in: refused, and told the car as it is.
    const gus = s.player('gus', { x: at.x + 1, y: at.y, z: at.z }, 'guest');
    send('gus', gus, { t: 'car', op: 'in', id: 'tesla' });
    assert.equal(game.carOf('gus'), null, `${h.id}: no way in through the car`);
    assert.equal(sent.get('gus').at(-1)?.t, 'car');
    // The admin (who may enter every home) gets in as ever.
    const ada = s.player('ada', { x: at.x - 1, y: at.y, z: at.z }, 'admin');
    send('ada', ada, { t: 'car', op: 'in', id: 'tesla' });
    assert.equal(car.driver, 'ada', `${h.id}: the admin gets in`);
    // Seated there anyhow (in before the car was in the home): out at the centre, where no wall-free door is found.
    car.passenger = 'gus';
    Object.assign(gus.state, { x: car.x, y: car.y, z: car.z });
    game.carSeats.free = () => false; // walls at every door: the fallback, the car's centre
    send('gus', gus, { t: 'car', op: 'out' });
    assert.equal(game.carOf('gus'), null);
    assert.notEqual(homeAt(gus.state.x, gus.state.z, gus.state.y), h.id, `${h.id}: put out of the home at once`);
    assert.equal(gus.budget, 0.5);
    // The admin getting out there stays at the centre (their right).
    send('ada', ada, { t: 'car', op: 'out' });
    assert.equal(homeAt(ada.state.x, ada.state.z, ada.state.y), h.id, `${h.id}: the admin may stand there`);
  }
});

test('the gnomes: a passenger carried over one finds nothing; the driver finds it as before', () => {
  const s = setup();
  const { game, car, state, put } = s;
  const [dan, pam] = crew(s);
  const finds = [];
  game.goals.found = (name, p, id) => finds.push([name, id]);
  for (const n of ['dan', 'pam']) game.goals.joined(n, 'player');
  const g = game.goals.gnomes.find((q) => homeAt(q.x, q.z, 0) === null);
  const gy = game.goals.gnomeY[game.goals.gnomes.indexOf(g)];
  put({ x: g.x, y: gy, z: g.z + 4, yaw: 0 });
  // Both send a state where they are (the tracker's first step is no step), then the driver drives over the gnome
  // while the passenger sends states as the car carries them, and the car stands on it a while.
  state('dan', dan);
  state('pam', pam);
  for (let i = 0; i < 8; i++) {
    state('dan', dan, { x: g.x, y: gy, z: g.z + 4 - Math.min(i, 4) });
    state('pam', pam);
  }
  for (let i = 0; i < 5; i++) state('pam', pam);
  assert.ok(Math.hypot(car.x - g.x, car.z - g.z) < 1, 'the car stands on the gnome');
  assert.deepEqual(finds.filter(([n]) => n === 'pam'), [], 'the passenger finds nothing');
  assert.deepEqual([...new Set(finds.filter(([n]) => n === 'dan').map(([, id]) => id))], [g.id], 'the driver finds it (the rule unchanged)');
});

test('every type Game.handle reads is sorted: refused from a seat or let through', () => {
  const start = GAME_SRC.indexOf('  handle(name, player, raw) {');
  const end = GAME_SRC.indexOf('\n  }\n', start);
  const types = new Set([...GAME_SRC.slice(start, end).matchAll(/m\.t === '([a-z]+)'/g)].map((x) => x[1]));
  assert.ok(types.size > 40, `${types.size} types`);
  for (const t of types) assert.ok(SEAT_REFUSED.has(t) !== SEAT_ALLOWED.includes(t), `${t}: in exactly one list`);
  for (const t of SEAT_REFUSED) assert.equal(SEAT_ALLOWED.includes(t), false, t);
  for (const t of [...SEAT_REFUSED, ...SEAT_ALLOWED]) assert.ok(types.has(t), `${t}: a type Game.handle reads`);
});
