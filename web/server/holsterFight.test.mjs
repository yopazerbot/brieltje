import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';

// Holstering out of a fight (game.mjs state, inFight): an unarmed player (Explore) can't be hit, a rule kept for honest
// play. But the switch was the page's word, at once: A hit B, sent one state with armed false, B's hit on A was dropped,
// and A armed again and hit 0.45 s later (damage avoidance by a forged state). Now holstering counts only 10 s after the
// last fight, hitting or being hit (the seats' clock, fightRefused): until then the server keeps them armed for bullets,
// blasts and the strongmen, shows them armed to everyone, and tells them once.

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const game = new Game({ session: () => null, store: { addStats: async () => {}, setMeta: async () => {} }, log: () => {} }, []);
  for (const t of game.timers) clearInterval(t);
  const sent = new Map();
  const told = [];
  game.broadcast = (m) => told.push(structuredClone(m));
  game.send = (ws, m) => sent.get(ws.name)?.push(structuredClone(m));
  game.stampState = () => {};
  const car = game.cars.tesla; // open ground by the car, away from the school grounds and the homes (as rideFight.test.mjs)
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
  /** A message from `p`, with the flood guard's window let go. */
  const send = (p, m) => {
    p.window = clock;
    p.msgs = p.states = p.others = 0;
    game.handle(p.ws.name, p, JSON.stringify(m));
  };
  /** A state where the server has them, armed or not (as a page sends it, 50 ms on). */
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
  const said = (p) => sent.get(p.ws.name).filter((m) => m.t === 'system').map((m) => m.code);
  const shown = (p) => game.scoreList().find((s) => s.name === p.ws.name).armed;
  return { game, player, send, state, hit, said, shown, told, at: (ms) => (clock += ms), now: () => clock };
}

test('the attack: A hits B, holsters, and is hit back all the same; told once; shown armed to everyone', () => {
  const s = setup();
  const a = s.player('ann', 0);
  const b = s.player('bob', 6);
  assert.ok(s.hit(a, b), 'A\'s hit counts');
  s.state(a, false); // one forged (or honest) state: Explore
  assert.equal(a.state.armed, true, 'the server keeps A armed');
  assert.equal(s.shown(a), true, 'and the scores show A in the fight');
  s.at(400);
  assert.ok(s.hit(b, a), 'B\'s hit on A counts (it was dropped)');
  s.state(a, false);
  s.state(a, false);
  assert.deepEqual(s.said(a), ['holsterFight'], 'told once, not with every state');
  // A arms again and hits 0.45 s later: as before, A is armed, and stays so 10 s on from this hit.
  s.state(a, true);
  s.at(450);
  assert.ok(s.hit(a, b));
  s.state(a, false);
  s.at(9_000);
  s.state(a, false);
  assert.equal(a.state.armed, true, '9 s after A\'s last hit: still armed');
  assert.ok(s.hit(b, a), 'and still hit');
});

test('10 s after the last fight the holster counts: no hit, no blast, no strongman; the scores say so', () => {
  const s = setup();
  const { game } = s;
  const a = s.player('ann', 0);
  const b = s.player('bob', 6);
  s.hit(b, a); // A was hit
  s.state(a, false);
  s.at(9_800);
  s.state(a, false);
  assert.equal(a.state.armed, true, '9.9 s after being hit: still armed');
  s.at(100);
  const before = s.told.length;
  s.state(a, false);
  assert.equal(a.state.armed, false, '10 s on: holstered');
  assert.equal(s.shown(a), false);
  assert.ok(s.told.slice(before).some((m) => m.t === 'scores'), 'everyone is told');
  assert.equal(s.hit(b, a), false, 'a bullet: dropped');
  const hp = a.hp;
  game.blast('bob', { x: a.state.x, y: a.state.y + 0.9, z: a.state.z }, 'grenade');
  game.bruteHits({ x: a.state.x, y: a.state.y, z: a.state.z }, 3, 20, s.now());
  assert.equal(a.hp, hp, 'a blast and a strongman\'s rock: nothing');
});

test('within the delay a blast and a strongman hurt as a bullet does', () => {
  const s = setup();
  const { game } = s;
  const a = s.player('ann', 0);
  const b = s.player('bob', 6);
  s.hit(a, b);
  s.state(a, false);
  let hp = a.hp;
  game.bruteHits({ x: a.state.x, y: a.state.y, z: a.state.z }, 3, 20, s.now());
  assert.ok(a.hp < hp, 'the strongman\'s rock hurts');
  hp = a.hp;
  game.blast('bob', { x: a.state.x + 2, y: a.state.y + 0.9, z: a.state.z }, 'grenade');
  assert.ok(a.hp < hp, 'the grenade hurts');
});

test('honest play as before: out of any fight the holster counts at once; dead or down too, and a respawn starts clean', () => {
  const s = setup();
  const { game } = s;
  const a = s.player('ann', 0);
  const b = s.player('bob', 6);
  const c = s.player('cas', -6);
  s.state(c, false); // never in a fight
  assert.equal(c.state.armed, false);
  assert.deepEqual(s.said(c), []);
  assert.equal(s.hit(b, c), false, 'an Explore player is still out of reach');
  // A bystander's fight holds nobody else: B hits A, C holsters again at once.
  s.state(c, true);
  s.hit(b, a);
  s.state(c, false);
  assert.equal(c.state.armed, false);
  // A beaten: dead, the page's word (nobody hits the dead); back, out of the fight.
  a.hp = 10;
  s.hit(b, a);
  assert.equal(a.alive, false);
  s.state(a, false);
  assert.equal(a.state.armed, false, 'dead: as the page says');
  s.at(3_000);
  game.respawn('ann', a, s.now());
  s.state(a, false);
  assert.equal(a.state.armed, false, 'back after a respawn, in Explore: out of reach');
  s.at(2_500); // past the spawn protection, still within 10 s of the fight
  s.state(a, false);
  assert.equal(a.state.armed, false);
  assert.equal(s.hit(b, a), false);
  assert.deepEqual(s.said(a), [], 'and never told');
});

test('a strongman\'s or a zombie\'s hit holds no holster: Explore near them is safe at once, as before', () => {
  const s = setup();
  const { game } = s;
  const a = s.player('ann', 0);
  game.bruteHits({ x: a.state.x, y: a.state.y, z: a.state.z }, 3, 20, s.now());
  game.zombieHurt('ann', a, 10, false, s.now());
  assert.ok(a.hp < 100, 'hurt by both');
  s.state(a, false);
  assert.equal(a.state.armed, false, 'Explore counts at once');
  assert.deepEqual(s.said(a), []);
  assert.ok(game.inFight(a, s.now()), 'the seats and /parachute still wait, as before (hurtAt)');
});

test('a grenade thrown armed holds the holster until it goes off, and its bang is the thrower\'s hit', () => {
  // Before: throw armed, Explore 150 ms later, the bang 3 s later hurt B and B's answer was dropped (a free grenade).
  const s = setup();
  const a = s.player('ann', 0);
  const b = s.player('bob', 6);
  s.send(a, { t: 'nade', x: a.state.x, y: a.state.y + 1.5, z: a.state.z, vx: 4, vy: 3, vz: 0 });
  s.at(150);
  s.state(a, false);
  assert.equal(a.state.armed, true, 'held while the grenade is live');
  s.at(2_800);
  s.state(a, false);
  assert.equal(a.state.armed, true);
  const hp = b.hp;
  s.send(a, { t: 'boom', x: b.state.x - 3, y: b.state.y + 0.9, z: b.state.z, cover: [] });
  assert.ok(b.hp < hp, 'the bang hurts B');
  s.state(a, false);
  assert.equal(a.state.armed, true, 'and holds her 10 s from then');
  assert.ok(s.hit(b, a), 'B\'s answer counts');
});

test('a grenade that hurts nobody holds the holster no longer than it can go off', () => {
  const s = setup();
  const a = s.player('ann', 0);
  s.send(a, { t: 'nade', x: a.state.x, y: a.state.y + 1.5, z: a.state.z, vx: 4, vy: 3, vz: 0 });
  s.at(6_100); // past the fuse and the 3 s a bang may still be told
  s.state(a, false);
  assert.equal(a.state.armed, false);
});

test('a trip from the chat waits for the fight\'s 10 s, with the seats\' line', () => {
  // Before: 1 s after a fight, a chat trip to the school grounds (where nobody shoots) was taken.
  const s = setup();
  const { game } = s;
  const a = s.player('ann', 0);
  const b = s.player('bob', 6);
  assert.ok(s.hit(b, a));
  s.at(1_000);
  const at = { x: a.state.x, z: a.state.z };
  const told = [];
  const send = game.send;
  game.send = (ws, m) => (m.t === 'travel' && told.push(m), send(ws, m));
  s.send(a, { t: 'travel', to: 'school', via: 'chat' });
  assert.deepEqual([a.state.x, a.state.z], [at.x, at.z], 'not taken');
  assert.deepEqual(told.map((m) => [m.ok, m.code]), [[false, 'heliFight']]);
  s.at(9_100);
  s.send(a, { t: 'travel', to: 'school', via: 'chat' });
  assert.ok(Math.hypot(a.state.x - at.x, a.state.z - at.z) > 100, '10 s on: the trip is taken');
});

test('a page that stays in Action while dead (as an honest one does) may holster at once after its respawn', () => {
  const s = setup();
  const { game } = s;
  const a = s.player('ann', 0);
  const b = s.player('bob', 6);
  a.hp = 10;
  s.hit(b, a);
  assert.equal(a.alive, false);
  s.state(a, true);
  s.at(3_000);
  game.respawn('ann', a, s.now());
  s.state(a, true);
  s.at(500);
  s.state(a, false); // Explore, 3.5 s after the hit that beat her
  assert.equal(a.state.armed, false, 'the death ended that fight');
  assert.deepEqual(s.said(a), []);
  // Back in it: she arms, hits, holsters: kept as anyone.
  s.state(a, true);
  s.at(2_000);
  assert.ok(s.hit(a, b));
  s.state(a, false);
  assert.equal(a.state.armed, true);
  // And the one who beat her is still in that fight.
  s.state(b, false);
  assert.equal(b.state.armed, true);
});
