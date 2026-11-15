import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';
import { HOMES, homeAt } from '../shared/homes.mjs';
import { PROTO } from '../shared/wire.mjs';

// A player inside a code-locked home is out of sight for everyone without that home's right (server/homeGate.mjs
// hides): not in their ticks, not in their welcome's vehicles, not in a shot, throw, blast, rally or kill they are told
// of; and neither of two players hidden from one another can hurt the other. For all four homes.

/** A point inside each home's ground floor (its first band, at its floor's height) and one just outside it. */
function spots(h) {
  const b = h.bands[0];
  const y = Math.max(b.y0 + 3, b.y0 + 0.1) === b.y0 + 3 && b.y0 < -1 ? 0.05 : b.y0 + 3.05; // the main house's floor is 0
  const [x0, z0, x1, z1] = b.box;
  for (let x = x0; x <= x1; x += 0.25) {
    for (let z = z0; z <= z1; z += 0.25) {
      if (homeAt(x, z, y) === h.id && homeAt(x + 0.5, z, y) === h.id && homeAt(x - 0.5, z, y) === h.id && homeAt(x, z + 0.5, y) === h.id && homeAt(x, z - 0.5, y) === h.id) {
        return { inside: { x, y, z }, outside: { x: x0 - 3, y, z: z0 - 3 } };
      }
    }
  }
  throw new Error(`no spot inside ${h.id}`);
}

function setup() {
  const game = new Game({ session: () => null, store: { addStats: async () => {} } }, []);
  const grants = new Set(); // `${key}|${home}`
  game.homes = { granted: (key, id) => grants.has(`${key}|${id}`) };
  game.stats = () => {};
  const player = (name, at, role = 'player') => {
    const now = Date.now();
    const p = {
      key: `k-${name}`, role, got: [], raw: [], proto: PROTO, full: true, slot: 0, sentKey: '', fresh: true, warp: 0, stamp: 0,
      ws: { readyState: 1, OPEN: 1, send(d) { p.raw.push(String(d)); p.got.push(JSON.parse(d)); } },
      alive: true, protectedUntil: 0, drop: null, hp: 100, score: { kills: 0, deaths: 0, points: 0 }, color: '#888',
      state: { ...at, yaw: 0, pitch: 0, armed: true, flying: false, w: 'rifle', c: false },
      weapons: new Set(['pistol', 'rifle', 'sniper', 'bazooka']), nades: [0, 0], thrown: [], window: now, msgs: 0, states: 0, others: 0, budget: 100, vbudget: 100, movedAt: now,
    };
    game.players.set(name, p);
    return p;
  };
  const ticks = (p) => p.got.filter((m) => m.t === 's');
  const named = (p, who) => ticks(p).some((m) => (m.p ?? []).some((e) => e[0] === who));
  return { game, grants, player, ticks, named };
}

for (const h of HOMES) {
  test(`${h.id}: a player inside is in the ticks only of those with its right, and vanishes at the door for the others`, () => {
    const { game, grants, player, ticks, named } = setup();
    const { inside, outside } = spots(h);
    const owner = player('owner', inside);
    const friend = player('friend', outside); // has the right, stands outside
    const other = player('other', outside); // has no right
    const root = player('root', outside, 'admin');
    grants.add(`k-owner|${h.id}`);
    grants.add(`k-friend|${h.id}`);
    game.snapshot(Date.now()); // the first tick: everything for everyone
    assert.equal(named(other, 'owner'), false, 'no entry of the insider for the one without the right');
    assert.deepEqual(ticks(other)[0].o, ['owner'], 'told once that the insider is out of sight');
    assert.ok(named(friend, 'owner') && named(root, 'owner'), 'the right and the admin see them');
    assert.ok(!other.raw.some((r) => r.includes(String(owner.state.x)) && r.includes('"owner"')), 'no place of theirs in any message');
    // Many ticks: still nothing, and the out-of-sight list is not repeated.
    for (let i = 0; i < 30; i++) {
      owner.fresh = true;
      owner.state.x += 0.01;
      game.snapshot(Date.now());
    }
    assert.equal(named(other, 'owner'), false);
    assert.equal(ticks(other).filter((m) => m.o).length, 1);
    // Out of the house: in the very next tick of the one without the right, whatever its turn.
    Object.assign(owner.state, outside);
    other.got.length = 0;
    game.snapshot(Date.now());
    assert.equal(named(other, 'owner'), true, 'back in sight at once');
  });

  test(`${h.id}: shots, throws, blasts, rallies and kills from inside reach only those who may see in`, () => {
    const { game, grants, player } = setup();
    const { inside, outside } = spots(h);
    const owner = player('owner', inside);
    const mate = player('mate', inside);
    const other = player('other', outside);
    grants.add(`k-owner|${h.id}`);
    grants.add(`k-mate|${h.id}`);
    const told = (p, t) => p.got.filter((m) => m.t === t);
    owner.nextShot = 0;
    game.handle('owner', owner, JSON.stringify({ t: 'shot', w: 'rifle', ...inside }));
    assert.equal(told(other, 'shot').length, 0, 'a shot from inside');
    assert.equal(told(mate, 'shot').length, 1);
    game.handle('owner', owner, JSON.stringify({ t: 'nade', ...inside, vx: 1, vy: 1, vz: 1 }));
    assert.equal(told(other, 'nade').length, 0, 'a throw from inside');
    game.blast('owner', { ...inside }, 'grenade');
    assert.equal(told(other, 'blast').length, 0, 'a blast inside');
    game.modes.state = { kind: 'teams', phase: 'playing' };
    game.modes.friends = () => true;
    owner.lastRally = 0;
    game.handle('owner', owner, JSON.stringify({ t: 'rally' }));
    assert.equal(told(other, 'rally').length, 0, 'a rally from inside');
    assert.equal(told(mate, 'rally').length, 1);
    game.modes.friends = () => false;
    game.damage('owner', owner, 'mate', mate, 500, false, 'rifle', Date.now());
    assert.equal(told(other, 'kill').length, 0, 'a kill inside');
    assert.equal(told(owner, 'kill').length, 1);
  });

  test(`${h.id}: nobody hurts, or is hurt by, someone they may not see`, () => {
    const { game, grants, player } = setup();
    const { inside, outside } = spots(h);
    const owner = player('owner', inside);
    const other = player('other', { ...outside });
    grants.add(`k-owner|${h.id}`);
    game.modes.friends = () => false;
    const hit = (from, name, target) => {
      from.nextHit = 0;
      game.handle(name, from, JSON.stringify({ t: 'hit', target, w: 'rifle', body: 1, head: 0 }));
    };
    hit(other, 'other', 'owner');
    assert.equal(owner.hp, 100, 'from outside, at someone inside');
    hit(owner, 'owner', 'other');
    assert.equal(other.hp, 100, 'from inside, at someone outside who may not see in');
    game.blast('other', { ...inside }, 'grenade');
    assert.equal(owner.hp, 100, 'a grenade from outside, set off inside');
    game.blast('owner', { ...outside }, 'grenade');
    assert.equal(other.hp, 100, 'a grenade from inside, set off by someone outside');
    // With the right both ways (the other one too), they may fight as anywhere.
    grants.add(`k-other|${h.id}`);
    hit(other, 'other', 'owner');
    assert.ok(owner.hp < 100, 'in sight of each other');
  });
}

test('the welcome lists no bike or car standing inside a home the page may not see into', () => {
  const { game, player } = setup();
  const h = HOMES[0];
  const { inside, outside } = spots(h);
  const other = player('other', outside);
  game.bikes = { 7: { id: 7, ...inside, yaw: 0, rider: null }, 8: { id: 8, ...outside, yaw: 0, rider: null } };
  const w = game.welcome(other, 'other', '#888', Date.now());
  assert.deepEqual(w.bikes.map((k) => k.id), [8]);
  assert.ok(w.cars.every((c) => homeAt(c.x, c.z, c.y) === null));
});

test('pages from before the ticks get nobody who is inside a home', () => {
  const { game, grants, player } = setup();
  const h = HOMES[3];
  const { inside, outside } = spots(h);
  player('owner', inside);
  const old = player('old', outside);
  old.proto = 1;
  player('third', outside);
  grants.add(`k-owner|${h.id}`);
  grants.add(`k-old|${h.id}`);
  game.oldStates(Date.now());
  const states = old.got.find((m) => m.t === 'states');
  assert.ok(states && !states.players.some((s) => s.name === 'owner'));
});

test('hide and seek and tag: nobody stands inside a home, with its code or not, and keeps the code', () => {
  const { game, grants, player } = setup();
  const h = HOMES[3];
  const { inside, outside } = spots(h);
  const owner = player('owner', { ...outside });
  grants.add(`k-owner|${h.id}`);
  for (const kind of ['hide', 'tag']) {
    game.modes.state = { kind, phase: 'playing' };
    assert.equal(game.gate.mayStand(owner, inside.x, inside.y, inside.z), false, kind);
    const next = { ...inside };
    assert.ok(game.gate.keepOut(owner, { ...outside }, next), kind);
    assert.deepEqual([next.x, next.z], [outside.x, outside.z], `${kind}: held outside`);
    assert.equal(game.gate.may(owner, h.id), true, `${kind}: the right stays`);
  }
  for (const kind of ['free', 'teams', 'zombies', 'treasure']) {
    game.modes.state = { kind, phase: 'playing' };
    assert.equal(game.gate.mayStand(owner, inside.x, inside.y, inside.z), true, kind);
  }
});
