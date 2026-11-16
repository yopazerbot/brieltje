import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';

// What holds a fight on after it should have ended (game.mjs inPlayerFight, respawn, gather): a grenade thrown before a
// death, a strongman's hit at the Zombies start, and a grenade thrown at zombies.

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const game = new Game({ session: () => null, store: { addStats: async () => {}, setMeta: async () => {} }, log: () => {} }, []);
  for (const t of game.timers) clearInterval(t);
  const sent = new Map();
  game.broadcast = () => {};
  game.send = (ws, m) => sent.get(ws.name)?.push(structuredClone(m));
  game.stampState = () => {};
  const car = game.cars.tesla; // open ground by the car (as holsterFight.test.mjs)
  const player = (name, dx) => {
    const p = {
      ws: { name }, key: `k-${name}`, role: 'player', alive: true, protectedUntil: 0, drop: null, warp: 0, stamp: 0, nextHit: 0,
      state: { x: car.x + dx, y: car.y, z: car.z + 4, yaw: 0, pitch: 0, armed: true, flying: false, w: 'pistol', c: false },
      weapons: new Set(['pistol']), nades: [0, 0], thrown: [], window: clock, msgs: 0, states: 0, others: 0, budget: 0.5, vbudget: 0.5, movedAt: clock,
      hp: 100, score: { kills: 0, deaths: 0, points: 0 }, proto: 2,
    };
    sent.set(name, []);
    game.players.set(name, p);
    return p;
  };
  const send = (p, m) => {
    p.window = clock;
    p.msgs = p.states = p.others = 0;
    game.handle(p.ws.name, p, JSON.stringify(m));
  };
  const state = (p, armed) => {
    clock += 50;
    const s = p.state;
    send(p, { t: 'state', x: s.x, y: s.y, z: s.z, yaw: 0, pitch: 0, armed, w: 'pistol' });
  };
  const hit = (from, to) => {
    from.nextHit = 0;
    const hp = to.hp;
    send(from, { t: 'hit', target: to.ws.name, w: 'pistol', body: 1, head: 0 });
    return to.hp < hp;
  };
  const nade = (p) => send(p, { t: 'nade', x: p.state.x, y: p.state.y + 1.5, z: p.state.z, vx: 4, vy: 3, vz: 0 });
  return { game, player, send, state, hit, nade, at: (ms) => (clock += ms), now: () => clock };
}

test('a respawn clears the grenades still in the air: none holds the one back, none goes off for them', () => {
  const s = setup();
  const { game } = s;
  const a = s.player('ann', 0);
  const b = s.player('bob', 6);
  s.nade(a);
  assert.equal(a.thrown.length, 1);
  a.hp = 10;
  s.hit(b, a);
  assert.equal(a.alive, false);
  s.at(3_000);
  game.respawn('ann', a, s.now());
  assert.deepEqual(a.thrown, [], 'cleared');
  assert.equal(game.inPlayerFight(a, s.now()), false);
  const hp = b.hp;
  s.send(a, { t: 'boom', x: b.state.x - 2, y: b.state.y + 0.9, z: b.state.z, cover: [] });
  assert.equal(b.hp, hp, 'a bang told after the respawn hurts nobody');
});

test('the Zombies start keeps the health of a player in a fight with a player, and heals a strongman\'s hit', () => {
  const s = setup();
  const { game } = s;
  const a = s.player('ann', 0);
  const b = s.player('bob', 6);
  const c = s.player('cas', -6);
  assert.ok(s.hit(b, a), 'A is hit by B');
  game.bruteHits({ x: c.state.x, y: c.state.y, z: c.state.z }, 3, 20, s.now());
  assert.ok(c.hp < 100, 'C is hit by a strongman');
  assert.ok(game.inFight(c, s.now()) && !game.inPlayerFight(c, s.now()));
  const hpA = a.hp;
  s.at(1_000);
  game.gather(['ann', 'cas'], null, false, 'hp');
  assert.equal(a.hp, hpA, 'A: moved, not healed');
  assert.equal(c.hp, 100, 'C: healed, as a respawn');
});

test('a reconnect into a room keeps the whole fight on inFight, a strongman\'s hit too (as before)', () => {
  const s = setup();
  const { game } = s;
  const c = s.player('cas', -6);
  game.bruteHits({ x: c.state.x, y: c.state.y, z: c.state.z }, 3, 20, s.now());
  const hp = c.hp;
  assert.ok(hp < 100);
  game.gather(['cas'], null, false, 'fight');
  assert.equal(c.hp, hp, 'not healed');
});

test('during Zombies a thrown grenade holds no holster; outside Zombies it still does', () => {
  const s = setup();
  const { game } = s;
  const a = s.player('ann', 0);
  game.modes.state = { kind: 'zombies', phase: 'wave', z: { stop: () => {}, spareNade: () => false } };
  s.nade(a);
  assert.equal(a.thrown.length, 1, 'thrown');
  s.at(150);
  s.state(a, false);
  assert.equal(a.state.armed, false, 'Explore at once');
  // Out of Zombies, as before (holsterFight.test.mjs): the grenade holds the holster until it can go off.
  game.modes.state = { kind: 'free' };
  const b = s.player('bob', 6);
  s.state(b, true);
  s.at(16_000); // a grenade back
  s.nade(b);
  s.at(150);
  s.state(b, false);
  assert.equal(b.state.armed, true, 'held');
});
