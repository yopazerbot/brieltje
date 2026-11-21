import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { Game, ZOMBIE_NAVS } from './game.mjs';
import { NavCache } from './navCache.mjs';
import { ARENAS } from '../shared/arenas.mjs';
import { makeNav, navOn } from '../shared/zombies.mjs';

// The zombie grids' part that never changes per place, kept on the server (server/navCache.mjs, shared/zombies.mjs
// navBase and navOn): a game's start adds only its cars, a few ms instead of 10 to 60 (and with 30 players more), by any
// route. The grid a game gets is the grid made whole as before, square for square, at every place; one place's part
// serves every game at once and is never written by one; it is kept for the seven places only; the server's start
// makes them all over its first second, a few ms at a time.

let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

function newGame() {
  const store = { addStats: async () => {}, setMeta: async () => {}, getMeta: async () => null, addCar: async () => 1, deleteCar: async () => {} };
  const game = new Game({ session: () => null, store, log: () => {} }, [], null);
  for (const x of game.timers) clearInterval(x);
  return game;
}

/** Two grids the same: every square, every floor and its links, the regions, a field's distances, sight and reach. */
function same(a, b, label) {
  for (const k of ['nodes', 'outdoor', 'x0', 'z0', 'nx', 'nz']) assert.equal(a[k], b[k], `${label}: ${k}`);
  assert.deepEqual(a.floors(), b.floors(), `${label}: the houses' floors and their links`);
  assert.deepEqual(a.spawnSpots(), b.spawnSpots(), `${label}: where zombies come out`);
  const { x0, z0, nz } = a;
  for (let k = 0; k < a.outdoor; k++) {
    const x = x0 + (Math.floor(k / nz) + 0.5) * a.cell, z = z0 + ((k % nz) + 0.5) * a.cell;
    if (a.walkable(x, z) !== b.walkable(x, z)) assert.fail(`${label}: walkable at square ${k}`);
  }
  for (let k = 0; k < a.nodes; k++) if (a.region(k) !== b.region(k) || a.open(k) !== b.open(k)) assert.fail(`${label}: node ${k}'s region`);
  const src = [0, 1, 2].map(() => Math.floor(rnd() * a.nodes));
  a.field(src);
  b.field(src);
  for (let k = 0; k < a.nodes; k++) if (a.distance(k) !== b.distance(k)) assert.fail(`${label}: node ${k}'s distance`);
  for (let s = 0; s < 400; s++) {
    const ax = x0 + rnd() * a.nx * a.cell, az = z0 + rnd() * a.nz * a.cell, bx = ax + (rnd() - 0.5) * 20, bz = az + (rnd() - 0.5) * 20;
    const y = a.ground(ax, az) + rnd() * 6;
    assert.equal(a.clear(ax, az, bx, bz, true), b.clear(ax, az, bx, bz, true), `${label}: sight`);
    assert.equal(a.locate(ax, y, az), b.locate(ax, y, az), `${label}: locate`);
    assert.equal(a.reach(ax, y, az, bx, y + 0.5, bz), b.reach(ax, y, az, bx, y + 0.5, bz), `${label}: reach`);
  }
}

/** A hash of every array of a place's kept part. */
function sum(base) {
  let h = 0;
  for (const v of [...Object.values(base), ...Object.values(base.links)]) if (ArrayBuffer.isView(v)) for (let i = 0; i < v.length; i += 3) h = (h * 31 + v[i]) | 0;
  return h;
}

test('every place: a game\'s grid on the kept part is the grid made whole, with its cars, on a house\'s doorstep, and with panes broken', () => {
  const game = newGame();
  for (const arena of ARENAS) {
    const opts = ZOMBIE_NAVS.optsOf(arena);
    const base = ZOMBIE_NAVS.base(arena);
    // The game's own cars as a start takes them (game.mjs zombieGround), and some more: anywhere, and right on the squares
    // where a house's floor meets the ground (shared/zombies.mjs carLinks), and on a spot deep in the wood.
    const seams = [...base.links.seams.keys()];
    const e = opts.edge;
    const boxes = [];
    for (let c = 0; c < 12; c++) boxes.push({ x: e.minX + rnd() * (e.maxX - e.minX), z: e.minZ + rnd() * (e.maxZ - e.minZ), yaw: rnd() * 6, halfL: 2.2, halfW: 0.9 });
    for (let c = 0; c < 3 && seams.length; c++) {
      const k = seams[Math.floor(rnd() * seams.length)];
      boxes.push({ x: base.x0 + (Math.floor(k / base.nz) + 0.5) * 0.5, z: base.z0 + ((k % base.nz) + 0.5) * 0.5, yaw: 0, halfL: 0.3, halfW: 0.2 });
    }
    const w = ZOMBIE_NAVS.woodOf(arena);
    if (!w.same) boxes.push({ x: w.spots[0].x, z: w.spots[0].z, yaw: 0, halfL: 1, halfW: 0.5 });
    for (const [label, mine, theirs] of [
      [`${arena.id}, as a start makes it`, game.zombieGround(arena).nav, null],
      [`${arena.id}, with cars on its doorsteps`, navOn(base, boxes), makeNav({ ...opts, boxes })],
    ]) {
      const ref = theirs ?? makeNav({ ...opts, boxes: startBoxes(game, arena) });
      same(mine, ref, label);
      const panes = Array.from({ length: 40 }, () => Math.floor(rnd() * 400)).concat([3000, 3001]);
      mine.setPanes(panes);
      ref.setPanes(panes);
      same(mine, ref, `${label}, panes broken`);
      // Where the horde comes out: as shared/arenas.mjs arenaSpots gives it on the grid made whole.
      assert.deepEqual(ZOMBIE_NAVS.spots(arena, mine), ZOMBIE_NAVS.spotsOf(arena, ref.spawnSpots()), `${label}: the horde's spots`);
    }
    if (seams.length) assert.ok(navOn(base, boxes).floors().reduce((s, f) => s + f.links, 0) < navOn(base, []).floors().reduce((s, f) => s + f.links, 0), `${arena.id}: a car on a doorstep cuts its link`);
  }
});

/** The cars and the stall a start at `arena` adds (game.mjs zombieGround), from the game as it stands. */
function startBoxes(game, arena) {
  const seen = [];
  const navOf = ZOMBIE_NAVS.nav;
  ZOMBIE_NAVS.nav = (a, boxes) => (seen.push(boxes), navOf.call(ZOMBIE_NAVS, a, boxes));
  try {
    game.zombieGround(arena);
  } finally {
    ZOMBIE_NAVS.nav = navOf;
  }
  return seen[0];
}

test('one kept part, two games at once: neither changes the other\'s grid, and the part itself is never written', () => {
  const arena = ARENAS.find((a) => a.id === 'house'); // the houses' panes: a broken one opens floors
  const base = ZOMBIE_NAVS.base(arena);
  const before = sum(base);
  const a = navOn(base, []);
  const b = navOn(base, [{ x: 10, z: 30, yaw: 0, halfL: 2.3, halfW: 1 }]);
  const floors = b.floors();
  const regions = Array.from({ length: b.nodes }, (_, k) => b.region(k));
  // Game a: every pane broken, fields worked out over and over; then mended.
  const panes = Array.from({ length: 4000 }, (_, i) => i);
  a.setPanes(panes);
  for (let i = 0; i < 20; i++) a.field([Math.floor(rnd() * a.nodes)]);
  assert.notDeepEqual(a.floors().map((f) => f.open), floors.map((f) => f.open), 'game a\'s panes broken: its floors open');
  assert.deepEqual(b.floors(), floors, 'game b\'s grid as it was');
  assert.ok(regions.every((r, k) => b.region(k) === r), 'game b\'s regions as they were');
  assert.equal(sum(base), before, 'the kept part unchanged');
  // A third game on it now gets the grid made whole, not one changed by game a.
  const opts = ZOMBIE_NAVS.optsOf(arena);
  same(navOn(base, []), makeNav({ ...opts, boxes: [] }), 'a new game after');
});

test('kept for the seven places only, one part each (home and the bungalow share theirs); a place not on the list is never kept', () => {
  const game = newGame();
  for (let r = 0; r < 3; r++) for (const a of ARENAS) game.zombieGround(a);
  const keys = new Set(ARENAS.map((a) => ZOMBIE_NAVS.keyOf(a)));
  assert.equal(ZOMBIE_NAVS.bases.size, keys.size);
  assert.equal(keys.size, ARENAS.length - 1);
  assert.equal(ZOMBIE_NAVS.base(ARENAS[0]), ZOMBIE_NAVS.base(ARENAS[1]), 'home and the bungalow: one');
  // A place made up (not one of shared/arenas.mjs ARENAS, the same id): made, not kept, nothing kept grows.
  const forged = { ...ARENAS.find((a) => a.id === 'molenhoek') };
  const size = ZOMBIE_NAVS.bases.size;
  const kept = ZOMBIE_NAVS.base(ARENAS.find((a) => a.id === 'molenhoek'));
  for (let i = 0; i < 3; i++) assert.notEqual(ZOMBIE_NAVS.base(forged), kept);
  assert.equal(ZOMBIE_NAVS.bases.size, size);
  assert.equal(ZOMBIE_NAVS.woods.size <= ARENAS.length, true);
  const mb = ZOMBIE_NAVS.bytes() / 1e6;
  assert.ok(mb < 16, `the kept parts: ${mb.toFixed(1)} MB`);
});

test('the warm-up makes every place\'s part in slices, the server going on between; a start meanwhile finishes its own', async () => {
  const cache = new NavCache(ARENAS, ZOMBIE_NAVS.keyOf, ZOMBIE_NAVS.optsOf, ZOMBIE_NAVS.spotsOf);
  let ticks = 0;
  const iv = setInterval(() => ticks++, 1);
  const t0 = performance.now();
  const done = new Promise((res) => cache.warm(ARENAS, { slice: 4, gap: 2, done: res }));
  // A start at the church in the middle of it: takes the church's part there and then (made once).
  await new Promise((res) => setTimeout(res, 30));
  const church = ARENAS.find((a) => a.id === 'church');
  const mid = cache.base(church);
  await done;
  clearInterval(iv);
  const took = performance.now() - t0;
  assert.equal(cache.bases.size, new Set(ARENAS.map((a) => cache.keyOf(a))).size, 'every place\'s part made');
  assert.equal(cache.woods.size, ARENAS.length, 'and every place\'s spots');
  assert.equal(cache.base(church), mid, 'the church\'s made once');
  assert.equal(cache.pending.size, 0);
  const held = cache.held;
  assert.ok(held.length > cache.bases.size, `in slices: ${held.length}, the longest ${Math.max(...held).toFixed(1)} ms, in all ${took.toFixed(0)} ms`);
  assert.ok(ticks >= held.length / 2, `the server went on in between: ${ticks} ticks`);
  // The same grids as the server's own kept parts.
  for (const a of ARENAS) assert.deepEqual(navOn(cache.base(a), []).floors(), navOn(ZOMBIE_NAVS.base(a), []).floors(), a.id);
  cache.warm(ARENAS, { done: () => {} }); // all made: nothing to do, a timer that ends at once
  cache.stop();
});
