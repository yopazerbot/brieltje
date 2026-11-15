// Tests for the way along the roads (shared/roadPath.mjs): the shortest way over a small network, the straight line
// where the roads are no help, and the timed routes' legs over the game's own road data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DETOUR_MAX, lengthOf, makeRoads, onLine, STRAIGHT_UNDER } from './roadPath.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const STREETS = read('../src/data/streets.json');
const { routes: ROUTES } = read('./routes.json');

// A square block of 200 m with one street across its middle: 0-1-2 along the bottom, 3-4-5 the top, 1-4 across.
const BLOCK = {
  points: [[0, 0], [100, 0], [200, 0], [0, 200], [100, 200], [200, 200]],
  edges: [[0, 1], [1, 2], [3, 4], [4, 5], [0, 3], [2, 5], [1, 4]],
};

test('roadPath: the shortest way over the network, joined at the nearest road', () => {
  const roads = makeRoads(BLOCK);
  const r = roads.route([5, -10], [105, 190]);
  assert.ok(r.roads);
  // Along the bottom to the street across, up it, off it 5 m before its end: no detour round a corner.
  assert.deepEqual(r.line[0], [5, -10]);
  assert.deepEqual(r.line.at(-1), [105, 190]);
  assert.deepEqual(r.line.slice(1, -1), [[5, 0], [100, 0], [100, 190]]);
  assert.ok(Math.abs(r.length - (10 + 95 + 190 + 5)) < 1e-6, String(r.length));
  assert.ok(Math.abs(lengthOf(r.line) - r.length) < 1e-6);
});

test('roadPath: straight where it is short, where the roads go round too far, and with no roads', () => {
  const roads = makeRoads(BLOCK);
  assert.deepEqual(roads.route([10, 10], [10 + STRAIGHT_UNDER - 1, 10]).line, [[10, 10], [10 + STRAIGHT_UNDER - 1, 10]]);
  // Across the middle of the left half: the roads are about as far as straight from each end.
  const across = roads.route([50, 60], [50, 140]);
  assert.equal(across.roads, false);
  assert.equal(across.line.length, 2);
  // Roads only round three sides of a field: across it, straight.
  const field = makeRoads({ points: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]], edges: [[0, 1], [1, 2], [2, 3]] });
  const r = field.route([-5, 100], [-5, 900]);
  assert.equal(r.roads, false);
  assert.equal(r.length, 800);
  // Unreachable (two networks): straight.
  const split = makeRoads({ points: [[0, 0], [100, 0], [0, 300], [100, 300]], edges: [[0, 1], [2, 3]] });
  assert.equal(split.route([0, -5], [100, 305]).roads, false);
  assert.equal(makeRoads({ points: [], edges: [] }).route([0, 0], [500, 0]).roads, false);
  assert.ok(DETOUR_MAX >= 2);
});

test('roadPath: onLine finds where on a line you are', () => {
  const line = [[0, 0], [100, 0], [100, 100]];
  const a = onLine(line, 50, 8);
  assert.equal(a.i, 0);
  assert.deepEqual(a.p, [50, 0]);
  assert.equal(a.d, 8);
  const b = onLine(line, 103, 60);
  assert.equal(b.i, 1);
  assert.deepEqual(b.p, [100, 60]);
  assert.equal(onLine([[3, 4]], 0, 0).d, 5);
});

test('roadPath: the timed routes over the game\'s roads: on the roads where it goes along them, never a long detour', () => {
  const roads = makeRoads(STREETS.graph);
  const onRoad = ([x, z]) => roads.nearest(x, z).d < 0.01;
  let along = 0;
  for (const route of ROUTES) {
    const pts = [route.gate, ...route.checkpoints, route.gate];
    for (let i = 1; i < pts.length; i++) {
      const r = roads.route(pts[i - 1], pts[i]);
      const straight = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      assert.ok(r.length >= straight - 1e-6 && r.length <= straight * DETOUR_MAX + 1e-6, `${route.id} leg ${i}: ${r.length} for ${straight}`);
      if (!r.roads) continue;
      along++;
      // Every point between where it joins and where it leaves the roads lies on a road.
      for (const p of r.line.slice(1, -1)) assert.ok(onRoad(p), `${route.id} leg ${i}: ${p} off the roads`);
    }
  }
  assert.ok(along >= 10, `${along} legs along the roads`);
  // The walking route round the church square is short legs: straight.
  const foot = ROUTES.find((r) => r.by === 'foot');
  assert.equal(roads.route(foot.gate, foot.checkpoints[0]).roads, false);
});
