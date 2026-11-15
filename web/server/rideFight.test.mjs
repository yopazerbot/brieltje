import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';

// Out of a fight and into a seat (game.mjs fightRefused): within 10 s of being hit or of hitting someone, no getting into
// a car (at the wheel or beside it) or onto a bike, where no shot reaches you. Before, a driver got out, hit someone
// twice and was back in the unhittable seat 0.42 s later (damage avoidance). The helicopter's rule, clock and code.
// Horses stay as they are: riding and shooting from horseback is allowed.

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const game = new Game({ session: () => null, store: { addStats: async () => {}, setMeta: async () => {} }, log: () => {} }, []);
  for (const t of game.timers) clearInterval(t);
  const sent = new Map();
  game.broadcast = () => {};
  game.send = (ws, m) => sent.get(ws.name)?.push(structuredClone(m));
  game.stampState = () => {};
  const car = game.cars.tesla;
  const player = (name, at) => {
    const p = {
      ws: { name }, key: `k-${name}`, role: 'player', alive: true, protectedUntil: 0, drop: null, warp: 0, stamp: 0, nextHit: 0,
      state: { x: at.x, y: at.y, z: at.z, yaw: 0, pitch: 0, armed: true, flying: false, w: 'pistol', c: false },
      weapons: new Set(['pistol']), nades: [0, 0], thrown: [], window: clock, msgs: 0, states: 0, others: 0, budget: 0.5, vbudget: 0.5, movedAt: clock,
      hp: 100, score: { kills: 0, deaths: 0, points: 0 }, proto: 2,
    };
    sent.set(name, []);
    game.players.set(name, p);
    return p;
  };
  /** A message from `p`, with the flood guard's window and the vehicles' 300 ms gate let go. */
  const send = (p, m) => {
    p.window = clock;
    p.msgs = p.states = p.others = 0;
    p.nextCar = 0;
    game.handle(p.ws.name, p, JSON.stringify(m));
  };
  const hit = (from, to) => {
    from.nextHit = 0;
    send(from, { t: 'hit', target: to.ws.name, w: 'pistol', body: 1, head: 0 });
  };
  const said = (p) => sent.get(p.ws.name).filter((m) => m.t === 'system').map((m) => m.code);
  return { game, car, player, send, hit, said, at: (ms) => (clock += ms) };
}

test('the attack: out of the car, two hits, back in 0.42 s later: refused, and the page is told why', () => {
  const s = setup();
  const { car } = s;
  const dan = s.player('dan', { x: car.x - 1.5, y: car.y, z: car.z });
  const vic = s.player('vic', { x: car.x + 6, y: car.y, z: car.z + 4 });
  s.send(dan, { t: 'car', op: 'in', id: 'tesla' });
  assert.equal(car.driver, 'dan');
  s.send(dan, { t: 'car', op: 'out' });
  assert.equal(car.driver, null);
  s.hit(dan, vic);
  s.at(210);
  s.hit(dan, vic);
  assert.ok(vic.hp < 100, 'the hits counted');
  s.at(210);
  const told = s.said(dan).length;
  s.send(dan, { t: 'car', op: 'in', id: 'tesla' });
  assert.equal(car.driver, null, 'not back at the wheel');
  assert.deepEqual(s.said(dan).slice(told), ['heliFight']);
  // The one hit may not take the seat either: no escaping into it.
  s.send(vic, { t: 'car', op: 'in', id: 'tesla' });
  assert.equal(car.driver, null);
  // Ten seconds on: both may get in again.
  s.at(10_000);
  s.send(dan, { t: 'car', op: 'in', id: 'tesla' });
  assert.equal(car.driver, 'dan');
});

test('the passenger\'s seat counts the same, and a bike too', () => {
  const s = setup();
  const { car, game } = s;
  const dan = s.player('dan', { x: car.x - 1.5, y: car.y, z: car.z });
  const pam = s.player('pam', { x: car.x + 1.5, y: car.y, z: car.z });
  const foe = s.player('foe', { x: car.x + 8, y: car.y, z: car.z });
  s.send(dan, { t: 'car', op: 'in', id: 'tesla' });
  s.hit(foe, pam); // pam is hit
  s.send(pam, { t: 'car', op: 'in', id: 'tesla' });
  assert.equal(car.passenger, null, 'no passenger\'s seat right after being hit');
  assert.ok(s.said(pam).includes('heliFight'));
  const bike = Object.values(game.bikes)[0];
  Object.assign(bike, { x: foe.state.x + 1, y: foe.state.y, z: foe.state.z, rider: null });
  s.send(foe, { t: 'bike', op: 'on', id: bike.id });
  assert.equal(bike.rider, null, 'no bike right after hitting');
  assert.ok(s.said(foe).includes('heliFight'));
  s.at(10_001);
  s.send(pam, { t: 'car', op: 'in', id: 'tesla' });
  assert.equal(car.passenger, 'pam');
  s.send(foe, { t: 'bike', op: 'on', id: bike.id });
  assert.equal(bike.rider, 'foe');
});

test('nobody else is held back: a bystander gets in, and a horse is still mounted after a fight', () => {
  const s = setup();
  const { car, game } = s;
  const amy = s.player('amy', { x: car.x - 1.5, y: car.y, z: car.z });
  const foe = s.player('foe', { x: car.x + 8, y: car.y, z: car.z });
  const vic = s.player('vic', { x: car.x + 12, y: car.y, z: car.z });
  s.hit(foe, vic);
  s.send(amy, { t: 'car', op: 'in', id: 'tesla' });
  assert.equal(car.driver, 'amy');
  const horse = game.horses[0];
  Object.assign(horse, { parked: true, x: foe.state.x + 1, z: foe.state.z, rider: null });
  s.send(foe, { t: 'horse', op: 'on', i: 0 });
  assert.equal(horse.rider, 'foe');
});
