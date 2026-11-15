import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';
import { readFileSync } from 'node:fs';
import { distanceToHome, HOMES, homeAt } from '../shared/homes.mjs';
import { KICK, PITCHES } from '../shared/ball.mjs';
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

// ---------------------------------------------------------------- every kind of thing with a place (Game.homeOf)
// Each kind that can stand inside a home: out of the welcome, the ticks and every message of a page without its right.
// Each kind that can never be inside one: a test that says so. The admin's watch view sees everything (broadcastHome).

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
/** How far (x, z) is from the inside of the nearest home, at the heights y0 to y1 (any height without them). */
const nearestHome = (x, z, y0, y1) => Math.min(...HOMES.map((h) => distanceToHome(h.id, x, z, y0, y1)));
/** The least distance to a home along a line of points [[x, z], ...], sampled every 0.25 m. */
function closest(points) {
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    const [ax, az] = points[i];
    const [bx, bz] = points[Math.min(i + 1, points.length - 1)];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.25));
    for (let k = 0; k <= n; k++) best = Math.min(best, nearestHome(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n));
  }
  return best;
}
const pairs = (flat) => Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i], flat[2 * i + 1]]);
/** The entries of list `k` ('c', 'h', 'k', 'b', 'z') in a page's ticks. */
const entries = (p, k) => p.got.filter((m) => m.t === 's').flatMap((m) => m[k] ?? []);

for (const h of HOMES) {
  test(`${h.id}: a horse left inside is in no welcome, tick, message or refusal of a page without the right`, () => {
    const { game, grants, player } = setup();
    const { inside, outside } = spots(h);
    const rider = player('rider', inside);
    const friend = player('friend', outside);
    const other = player('other', outside);
    const old = player('old', outside);
    old.proto = 1;
    grants.add(`k-rider|${h.id}`);
    grants.add(`k-friend|${h.id}`);
    const horse = game.horses[0];
    Object.assign(horse, { x: inside.x, z: inside.z, rider: 'rider', parked: false });
    game.releaseHorse('rider');
    assert.equal(other.got.filter((m) => m.t === 'horse').length, 0, 'getting off inside');
    assert.equal(friend.got.filter((m) => m.t === 'horse').length, 1);
    assert.ok(!game.welcome(other, 'other', '#888', Date.now()).horses.some((q) => q.i === 0), 'the welcome');
    assert.ok(game.welcome(friend, 'friend', '#888', Date.now()).horses.some((q) => q.i === 0));
    game.snapshot(Date.now());
    assert.ok(!entries(other, 'h').some((e) => e[0] === 0), 'the ticks');
    assert.ok(entries(friend, 'h').some((e) => e[0] === 0));
    game.oldStates(Date.now());
    assert.ok(!old.got.find((m) => m.t === 'states').horses.some((q) => q.i === 0), 'pages from before the ticks');
    other.alive = false; // a refused mount tells the page the horse as it is: not this one
    other.got.length = 0;
    game.mountHorse('other', other, horse, Date.now());
    assert.equal(other.got.length, 0, 'a refusal');
  });

  test(`${h.id}: a car and a bike inside are in no tick, message or refusal of a page without the right`, () => {
    const { game, grants, player } = setup();
    const { inside, outside } = spots(h);
    const driver = player('driver', inside);
    const other = player('other', outside);
    const friend = player('friend', outside);
    grants.add(`k-driver|${h.id}`);
    grants.add(`k-friend|${h.id}`);
    game.cars = { c9: { id: 'c9', ...inside, yaw: 0, s: 0, driver: 'driver', passenger: null } };
    game.bikes = { k9: { id: 'k9', ...inside, yaw: 0, rider: 'driver' } };
    assert.equal(game.homeOf('car', game.cars.c9), h.id);
    game.snapshot(Date.now());
    assert.ok(!entries(other, 'c').some((e) => e[0] === 'c9') && !entries(other, 'k').some((e) => e[0] === 'k9'), 'the ticks');
    assert.ok(entries(friend, 'c').some((e) => e[0] === 'c9') && entries(friend, 'k').some((e) => e[0] === 'k9'));
    game.releaseCar('driver');
    game.releaseBike('driver');
    assert.ok(!other.got.some((m) => m.t === 'car' || m.t === 'bike'), 'getting out inside');
    assert.ok(friend.got.some((m) => m.t === 'car') && friend.got.some((m) => m.t === 'bike'));
    other.alive = false;
    other.got.length = 0;
    game.enterCar('other', other, game.cars.c9);
    game.mountBike('other', other, game.bikes.k9, Date.now());
    assert.equal(other.got.length, 0, 'refusals');
  });

  test(`${h.id}: a figure spawned inside and a strongman who walked in are out of sight; nobody inside is his target`, () => {
    const { game, grants, player } = setup();
    const { inside, outside } = spots(h);
    const owner = player('owner', inside);
    const other = player('other', { ...outside });
    other.state.armed = false;
    grants.add(`k-owner|${h.id}`);
    game.clowns = new Map([[1, game.character(1, inside.x, inside.y, inside.z, 'clown')], [2, game.character(2, inside.x, inside.y, inside.z, 'strongman')]]);
    assert.deepEqual(game.clownList(Date.now(), other), [], 'the welcome\'s figures');
    assert.equal(game.clownList(Date.now(), owner).length, 2);
    game.sendClowns(Date.now());
    assert.deepEqual(other.got.find((m) => m.t === 'clowns').list, []);
    game.snapshot(Date.now());
    assert.ok(!entries(other, 'b').some((e) => e[0] === 2), 'the strongman in the ticks');
    assert.ok(entries(owner, 'b').some((e) => e[0] === 2));
    // A strongman just outside, the owner inside armed and within his reach: no rock, no stomp, no harm.
    game.clowns = new Map([[3, game.character(3, outside.x + 2.5, outside.y, outside.z + 2.5, 'strongman')]]);
    const near = { ...inside };
    owner.state = { ...owner.state, ...near };
    for (let i = 0; i < 100; i++) game.stepBrutes(Date.now() + i * 50);
    assert.equal(owner.hp, 100);
  });

  test(`${h.id}: a figure hit, a pickup or a zombie beaten from inside: the others are told without the name`, () => {
    const { game, grants, player } = setup();
    const { inside, outside } = spots(h);
    const owner = player('owner', inside);
    const friend = player('friend', outside);
    const other = player('other', outside);
    grants.add(`k-owner|${h.id}`);
    grants.add(`k-friend|${h.id}`);
    owner.nextCat = 0;
    game.handle('owner', owner, JSON.stringify({ t: 'cat', i: 0, w: 'rifle' }));
    assert.equal(other.got.find((m) => m.t === 'cat')?.by, '', 'a cat');
    assert.equal(friend.got.find((m) => m.t === 'cat')?.by, 'owner');
    // At a place inside (a zombie that went in, a figure spawned there): not at all.
    game.broadcastEvent({ t: 'zdown', id: 5, by: 'friend', w: 'rifle' }, inside, 'friend');
    assert.ok(!other.got.some((m) => m.t === 'zdown'), 'something beaten inside');
    assert.ok(owner.got.some((m) => m.t === 'zdown'));
    assert.equal(game.homeOf('zombie', [5, inside.x, inside.z, 0, 0, 1, inside.y]), h.id, 'a zombie\'s tick entry');
  });

  test(`${h.id}: a placed car never stands inside, and each page's list leaves out one that does`, () => {
    const { game, grants, player } = setup();
    const { inside, outside } = spots(h);
    const other = player('other', outside);
    const owner = player('owner', inside);
    grants.add(`k-owner|${h.id}`);
    assert.ok(game.parkingProblem('modelY-white', { ...inside, yaw: 0 }), 'refused inside');
    game.cars = { p1: { id: 'p1', kind: 'modelY-white', ...inside, yaw: 0, s: 0, driver: null, passenger: null } };
    game.sendPlaced();
    assert.deepEqual(other.got.find((m) => m.t === 'teslas').list, []);
    assert.equal(owner.got.find((m) => m.t === 'teslas').list.length, 1);
  });

  test(`${h.id}: furniture inside is in the welcome of those with the right only`, () => {
    const { game, grants, player } = setup();
    const { inside, outside } = spots(h);
    const other = player('other', outside);
    const owner = player('owner', outside);
    grants.add(`k-owner|${h.id}`);
    game.furniture = new Map([[1, { id: 1, item: 'chair', ...inside, yaw: 0 }]]);
    assert.equal(game.welcome(other, 'other', '#888', Date.now()).furniture.length, 0);
    assert.equal(game.welcome(owner, 'owner', '#888', Date.now()).furniture.length, 1);
  });
}

test('things that can never be inside a home: cats, villagers, pickups and the footballs keep clear of every one', () => {
  for (const [i, path] of json('../shared/cats.json').cats.entries()) assert.ok(closest(path) > 0.5, `cat ${i}`);
  const villagers = json('../src/data/villagers.json');
  for (const [i, walk] of [...villagers.walks, ...villagers.bikes].entries()) assert.ok(closest(pairs(walk)) > 0.5, `villager route ${i}`);
  for (const [i, s] of json('../shared/pickups.json').entries()) assert.ok(nearestHome(s.x, s.z, s.y - 0.5, s.y + 2) > 0.5, `pickup ${i}`); // taken from inside (within reach of a wall): broadcastEvent leaves the name out
  // A ball's middle never leaves its pitch's outline, and a kick reaches KICK.reach from it.
  for (const p of PITCHES) {
    const ring = p.outline;
    assert.ok(closest([...ring, ring[0]]) > KICK.reach + 0.5, `${p.id}: its edge`);
    for (const h of HOMES) for (const band of h.bands) assert.ok(!band.ring.some(([x, z]) => inside2d(x, z, ring)), `${p.id}: no home within it`);
  }
});

test('pets and chat carry no place: the dog lives in a home\'s sealed pack only, a chat line has no position', () => {
  for (const f of ['house_shell.json', 'kapellenhoek_home_shell.json', 'molenhoek_end_shell.json']) assert.equal(json(`../src/data/${f}`).pets, undefined, f);
  const { game, player } = setup();
  const h = HOMES[3];
  const { inside, outside } = spots(h);
  const owner = player('owner', inside);
  const other = player('other', outside);
  assert.equal('pets' in game.welcome(other, 'other', '#888', Date.now()), false);
  game.handle('owner', owner, JSON.stringify({ t: 'chat', text: 'hello' }));
  const line = other.got.find((m) => m.t === 'chat');
  assert.ok(line && Object.keys(line).every((k) => ['t', 'from', 'color', 'text'].includes(k)), JSON.stringify(line));
});

/** Whether (x, z) lies inside ring `ring` (even-odd). */
function inside2d(x, z, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
