import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';
import { PORTALS } from '../shared/portals.mjs';

// Portals switched off during a fight (Yoshi, 16 Nov 2026: "poorten tijdens gevecht uitschakelen"). A trip from the chat
// already waited for the fight's 10 s (inFight); a portal walked onto did not, so a player who was hit stepped onto a pad
// and was gone, to the school grounds (where nobody shoots) among others: escaping a fight through a trip the server
// grants. Now a portal waits too, with its own line, and a driver's trip waits for the passenger's fight as well.

const HOME = PORTALS.find((p) => p.id === 'house');
const BUNGALOW = PORTALS.find((p) => p.id === 'bungalow');

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const game = new Game({ session: () => null, store: { addStats: async () => {}, setMeta: async () => {} }, log: () => {} }, []);
  for (const t of game.timers) clearInterval(t);
  const sent = new Map();
  const all = [];
  game.broadcast = (m) => m.t === 'travel' && all.push(structuredClone(m)); // a trip taken is told to everyone
  game.broadcastThing = () => {};
  game.send = (ws, m) => (m.t === 'travel' && all.push(structuredClone(m)), sent.get(ws.name)?.push(structuredClone(m)));
  game.stampState = () => {};
  const car = game.cars.tesla; // open ground by the car (as holsterFight.test.mjs): where the hits happen
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
  /** A message from `p`, with the flood guard's window and the trips' ask gate let go. */
  const send = (p, m) => {
    p.window = clock;
    p.msgs = p.states = p.others = 0;
    p.nextTravelAsk = 0;
    game.handle(p.ws.name, p, JSON.stringify(m));
  };
  const hit = (from, to) => {
    from.nextHit = 0;
    const hp = to.hp;
    send(from, { t: 'hit', target: to.ws.name, w: 'pistol', body: 1, head: 0 });
    return to.hp < hp;
  };
  /** Stand on the house's pad, as the page has it after walking there. */
  const onPad = (p) => Object.assign(p.state, { x: HOME.x, y: p.state.y, z: HOME.z });
  const answers = (p) => all.filter((m) => m.name === p.ws.name).map((m) => [m.ok, m.code ?? null]);
  return { game, car, player, send, hit, onPad, answers, at: (ms) => (clock += ms) };
}

test('the attack: hit, onto a portal, and gone: refused with the portal\'s own line, the player stays', () => {
  const s = setup();
  const a = s.player('ann', 0);
  const b = s.player('bob', 6);
  assert.ok(s.hit(b, a), 'B\'s hit counts');
  s.at(1_000);
  s.onPad(a);
  s.send(a, { t: 'travel', to: 'school', via: 'portal' });
  assert.deepEqual([a.state.x, a.state.z], [HOME.x, HOME.z], 'still on the pad');
  assert.deepEqual(s.answers(a), [[false, 'portalFight']]);
  // Hitting someone counts as being hit does (inFight): B can't walk away through a portal either.
  s.onPad(b);
  s.send(b, { t: 'travel', to: 'school', via: 'portal' });
  assert.deepEqual([b.state.x, b.state.z], [HOME.x, HOME.z]);
  assert.deepEqual(s.answers(b), [[false, 'portalFight']]);
});

test('10 s after the last fight the portal takes them, as before', () => {
  const s = setup();
  const a = s.player('ann', 0);
  const b = s.player('bob', 6);
  s.hit(b, a);
  s.onPad(a);
  s.at(9_900);
  s.send(a, { t: 'travel', to: 'school', via: 'portal' });
  assert.deepEqual(s.answers(a), [[false, 'portalFight']], '9.9 s on: still refused');
  s.at(100);
  s.send(a, { t: 'travel', to: 'school', via: 'portal' });
  assert.deepEqual(s.answers(a).at(-1), [true, null]);
  assert.ok(Math.hypot(a.state.x - HOME.x, a.state.z - HOME.z) > 100, '10 s on: the trip is taken');
});

test('out of any fight a portal works at once; the chat keeps the seats\' line', () => {
  const s = setup();
  const a = s.player('ann', 0);
  const b = s.player('bob', 6);
  const c = s.player('cas', -6);
  s.onPad(c);
  s.send(c, { t: 'travel', to: 'bungalow', via: 'portal' });
  assert.deepEqual(s.answers(c), [[true, null]], 'never in a fight: taken');
  s.hit(b, a);
  s.send(a, { t: 'travel', to: 'school', via: 'chat' });
  assert.deepEqual(s.answers(a), [[false, 'heliFight']]);
});

test('a driver takes the car through: refused while the passenger is in a fight, taken 10 s on', () => {
  const s = setup();
  const { car } = s;
  const dan = s.player('dan', -1.5);
  const pia = s.player('pia', 1.5);
  const vic = s.player('vic', 6);
  assert.ok(s.hit(vic, pia), 'the passenger is hit (or hits): in a fight');
  // In the car, stopped on the house's pad (the seats are taken as they were before the hit).
  Object.assign(car, { x: HOME.x, z: HOME.z, driver: 'dan', passenger: 'pia', s: 0 });
  Object.assign(dan.state, { x: HOME.x, z: HOME.z });
  Object.assign(pia.state, { x: HOME.x, z: HOME.z });
  s.at(1_000);
  s.send(dan, { t: 'travel', to: 'bungalow', via: 'portal' });
  assert.deepEqual(s.answers(dan), [[false, 'portalFightRider']]);
  assert.deepEqual([car.x, car.z, pia.state.x, pia.state.z], [HOME.x, HOME.z, HOME.x, HOME.z], 'car and passenger stay');
  s.send(dan, { t: 'travel', to: 'bungalow', via: 'chat' });
  assert.deepEqual(s.answers(dan).at(-1), [false, 'portalFightRider'], 'from the chat the same');
  // The passenger can't go alone either (as before).
  s.send(pia, { t: 'travel', to: 'bungalow', via: 'portal' });
  assert.deepEqual(s.answers(pia), [[false, 'travelDriverOnly']]);
  s.at(9_000);
  s.send(dan, { t: 'travel', to: 'bungalow', via: 'portal' });
  assert.deepEqual(s.answers(dan).at(-1), [true, null], '10 s on: taken');
  assert.deepEqual([car.x, car.z], BUNGALOW.car.slice(0, 2));
  assert.deepEqual([pia.state.x, pia.state.z], BUNGALOW.car.slice(0, 2), 'the passenger comes along');
});
