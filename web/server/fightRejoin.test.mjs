import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';

// Out of a fight by reconnecting (game.mjs join, fights): a page in a fight dropped its socket and joined again, and
// came back with full health, spawn protection, unarmed and without its fight clocks: unhittable at once, healed, and
// free to take a car, a bike, the helicopter or a parachute (damage avoidance by reconnect). Now the fight waits for
// them for the rest of its 10 s: the clocks, the health, no spawn protection, armed as they were. Outside that time,
// or dead when they left, joining is as before.

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const game = new Game({ session: () => null, store: { addStats: async () => {}, setMeta: async () => {} }, log: () => {} }, []);
  for (const t of game.timers) clearInterval(t);
  game.auth = { ...game.auth, session: () => null, log: () => {}, addressOf: () => '127.0.0.1' };
  const sent = new Map();
  game.broadcast = () => {};
  game.send = (ws, m) => sent.get(ws.name)?.push(structuredClone(m));
  game.stampState = () => {};
  const sockets = new Map();
  /** A page joins under `name` (a fresh socket each time); `drop()` closes it as a lost connection does. */
  const join = (name) => {
    const on = {};
    const ws = { name, readyState: 1, OPEN: 1, send() {}, on: (e, f) => (on[e] = f), close: () => {} };
    sent.set(name, []);
    game.join(ws, { username: name, role: 'player', key: `k-${name}` }, { headers: {}, socket: {} });
    sockets.set(name, () => on.close?.());
    return game.players.get(name);
  };
  const drop = (name) => sockets.get(name)();
  const send = (p, m) => {
    p.window = clock;
    p.msgs = p.states = p.others = 0;
    p.nextCar = 0;
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
  const said = (name) => sent.get(name).filter((m) => m.t === 'system').map((m) => m.code);
  /** Both in Action, past the spawn protection of joining. */
  const ready = (...ps) => {
    clock += 2500;
    for (const p of ps) state(p, true);
  };
  return { game, join, drop, send, state, hit, said, sent, ready, at: (ms) => (clock += ms), now: () => clock };
}

test('the attack: hit, the socket dropped and joined again 1 s later: still hittable, the same health, no car seat', () => {
  const s = setup();
  const { game } = s;
  const ann = s.join('ann');
  let bob = s.join('bob');
  s.ready(ann, bob);
  assert.ok(s.hit(ann, bob));
  const hp = bob.hp;
  s.at(1_000);
  s.drop('bob');
  bob = s.join('bob');
  assert.equal(bob.hp, hp, 'not healed');
  assert.equal(bob.protectedUntil, 0, 'no spawn protection');
  assert.equal(bob.state.armed, true, 'armed as he was');
  assert.deepEqual(s.sent.get('bob').filter((m) => m.t === 'hurt').map((m) => m.hp), [hp], 'his page is told his health');
  s.state(bob, false); // and his page in Explore: kept, as anyone in a fight
  assert.equal(bob.state.armed, true);
  assert.ok(s.said('bob').includes('holsterFight'));
  assert.ok(s.hit(ann, bob), 'hit at once');
  const car = game.cars.tesla;
  s.send(bob, { t: 'car', op: 'in', id: 'tesla' });
  assert.notEqual(car.driver, 'bob', 'no car seat');
  assert.ok(s.said('bob').includes('heliFight'));
  // The one who hit him keeps her clock too, over a reconnect of her own.
  s.drop('ann');
  const back = s.join('ann');
  assert.equal(back.protectedUntil, 0);
  assert.ok(game.inFight(back, s.now()));
});

test('a second tab takes over the fight of the first', () => {
  const s = setup();
  const ann = s.join('ann');
  const bob = s.join('bob');
  s.ready(ann, bob);
  s.hit(ann, bob);
  const hp = bob.hp;
  const tab = s.join('bob'); // the first connection is replaced (its close comes later)
  assert.equal(tab.hp, hp);
  assert.equal(tab.protectedUntil, 0);
  assert.ok(s.hit(ann, tab));
});

test('outside the fight, or 10 s after it, joining is as before; dead when they left, back as after a respawn', () => {
  const s = setup();
  const { game } = s;
  const ann = s.join('ann');
  let bob = s.join('bob');
  let cas = s.join('cas');
  s.ready(ann, bob, cas);
  // Never in a fight: as before.
  s.drop('cas');
  cas = s.join('cas');
  assert.equal(cas.hp, 100);
  assert.ok(cas.protectedUntil > s.now());
  assert.equal(cas.state.armed, false);
  // Away past the 10 s: as before, and forgotten.
  s.hit(ann, bob);
  s.drop('bob');
  s.at(10_000);
  bob = s.join('bob');
  assert.equal(bob.hp, 100);
  assert.ok(bob.protectedUntil > s.now());
  assert.equal(game.fights.has('bob'), false);
  // Dead when they left: back alive and protected, as today (and as after a respawn: holstering at once), the seat clock kept.
  s.ready(ann, bob);
  bob.hp = 10;
  s.hit(ann, bob);
  assert.equal(bob.alive, false);
  s.at(1_000);
  s.drop('bob');
  bob = s.join('bob');
  assert.equal(bob.alive, true);
  assert.equal(bob.hp, 100);
  assert.ok(bob.protectedUntil > s.now());
  s.state(bob, false);
  assert.equal(bob.state.armed, false);
  assert.ok(game.inFight(bob, s.now()), 'no seat or parachute straight after');
});
