import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';

// Going up on foot has a budget of its own (game.mjs FOOT_RISE: 3 m/s, 5 m stored). Before, anyone on foot rose at the
// fall's 16 m/s by forged states, up to the ceiling (a walker went from the ground to y 55.9 in 3 s, not flying and in
// no drop): position forgery. Honest climbs (measured on the page: a stair at a sprint, a jump, the lift out of a drawn
// roof, a second's states arriving at once) are never shortened; falling stays at 16 m/s; flying, the admin, horses,
// bikes and cars keep their own rules.

const FOOT = { rate: 3, store: 5 };

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const game = new Game({ session: () => null, store: { addStats: async () => {}, setMeta: async () => {} }, log: () => {} }, []);
  for (const t of game.timers) clearInterval(t);
  game.broadcast = () => {};
  game.send = () => {};
  game.stampState = () => {};
  game.rules.flying = false;
  const player = (name, at = { x: 4.5, y: -0.1, z: 19 }, role = 'player') => {
    const p = {
      ws: { name }, key: `k-${name}`, role, alive: true, protectedUntil: 0, drop: null, warp: 0, stamp: 0,
      state: { x: at.x, y: at.y, z: at.z, yaw: 0, pitch: 0, armed: true, flying: false, w: 'pistol', c: false },
      weapons: new Set(['pistol']), nades: [0, 0], thrown: [], window: clock, msgs: 0, states: 0, others: 0, budget: 0.5, vbudget: 0.5,
      movedAt: clock - 5000, hp: 100, score: { kills: 0, deaths: 0, points: 0 }, proto: 2,
    };
    game.players.set(name, p);
    return p;
  };
  /** A state `dt` ms after the last at height `y` (x, z where the server has them), `extra` on top. */
  const state = (p, y, dt = 50, extra = {}) => {
    clock += dt;
    p.window = clock;
    p.msgs = p.states = p.others = 0;
    game.handle(p.ws.name, p, JSON.stringify({ t: 'state', x: p.state.x, y, z: p.state.z, yaw: 0, pitch: 0, armed: true, w: 'pistol', ...extra }));
    return p.state.y;
  };
  /** Rise at `speed` m/s for `secs` s, 20 states a second: where the server has them. */
  const rise = (p, speed, secs, extra = {}) => {
    const y0 = p.state.y;
    let y = y0;
    for (let k = 1; k <= secs * 20; k++) y = state(p, y0 + (speed * k) / 20, 50, extra);
    return y - y0;
  };
  return { game, player, state, rise, at: (ms) => (clock += ms) };
}

test('the attack: forged states rising at 20 m/s for 3 s, on foot, flying not allowed: held to the climbing budget', () => {
  const s = setup();
  const w = s.player('w');
  const got = s.rise(w, 20, 3);
  assert.ok(got <= FOOT.store + FOOT.rate * 3 + 0.01, `rose ${got.toFixed(2)} m (it was 56 m)`);
  // Going on, it gains no more than the rate.
  const got3 = s.rise(w, 20, 4);
  assert.ok(got3 <= FOOT.rate * 4 + 0.01, `then ${got3.toFixed(2)} m in 4 s`);
  // Flying asked for while the rule is off: the same.
  const v = s.player('v');
  const got2 = s.rise(v, 20, 3, { flying: true });
  assert.ok(got2 <= FOOT.store + FOOT.rate * 3 + 0.01, `rose ${got2.toFixed(2)} m with a forged flying`);
});

test('honest climbs are never cut: a sprint up the steepest stair, hops, the lift out of a roof, a laggy burst', () => {
  const s = setup();
  const w = s.player('w');
  // The main house's outside stair at a sprint: 2.9 m in a second, then hopping on the terrace.
  assert.equal(+s.rise(w, 2.9, 1).toFixed(3), 2.9);
  for (let k = 0; k < 6; k++) {
    for (const y of [0.17, 0.31, 0.41, 0.47, 0.5, 0.47, 0.41, 0.31, 0.17, 0]) assert.ok(Math.abs(s.state(w, 2.8 + y) - 2.8 - y) < 1e-6, 'a jump');
  }
  // The lift out of a drawn roof that came in round you: 4 m/s, 4 m.
  assert.equal(+s.rise(w, 4, 1).toFixed(3), 4);
  // The church's tower stair: 12.6 m in 8.4 s.
  assert.equal(+s.rise(w, 1.5, 8.4).toFixed(3), 12.6);
  // A second of climbing a stair (2.9 m) arriving at once after a second with no states.
  s.at(1000);
  const y0 = w.state.y;
  for (let k = 1; k <= 20; k++) s.state(w, y0 + (2.9 * k) / 20, 1);
  assert.equal(+(w.state.y - y0).toFixed(3), 2.9, 'the bunched states');
});

test('falling stays as fast as a fall, and flying, the admin and the saddles keep their own rules', () => {
  const s = setup();
  const w = s.player('w', { x: 4.5, y: 30, z: 19 });
  assert.ok(s.rise(w, -15, 2) <= -29.9, 'a fall from 30 m');
  // Flying allowed: up at the fall's 16 m/s, as before.
  s.game.rules.flying = true;
  const f = s.player('f');
  assert.ok(s.rise(f, 15, 2, { flying: true }) >= 29.9, 'flying up');
  s.game.rules.flying = false;
  // The admin.
  const a = s.player('a', undefined, 'admin');
  assert.ok(s.rise(a, 15, 2) >= 29.9, 'the admin');
  // A car's driver: the car's own rule (MAX_SPEED up and down), as before.
  const car = s.game.cars.tesla;
  const d = s.player('d', { x: car.x - 1.5, y: car.y, z: car.z });
  d.nextCar = 0;
  s.game.handle('d', d, JSON.stringify({ t: 'car', op: 'in', id: 'tesla' }));
  assert.equal(car.driver, 'd');
  Object.assign(d.state, { x: car.x, y: car.y, z: car.z });
  assert.ok(s.rise(d, 15, 1, { d: 1 }) >= 14.9, 'at the wheel');
});
