// The routes' floors (server/floors.mjs): the page's own numbers, copied here, still the page's; the tightest line
// through the rings; each floor under every honest way round. Run: node --test server/floors.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BIKE, bikeTime, CAR, carTime, cutPath, floors, footTime, RUN } from './floors.mjs';
import { readGoals } from './goals.mjs';
import { makeTerrain } from '../shared/terrain.mjs';
import { makeRoads } from '../shared/roadPath.mjs';

const text = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const json = (p) => JSON.parse(text(p));
/** `const NAME = 1.2;` in a page file. */
const constant = (src, name) => Number(new RegExp(`const ${name} = ([0-9.]+);`).exec(src)?.[1]);
const TERRAIN = makeTerrain(json('../shared/terrain.json'));
const BIKES = json('../shared/bike.json');
const CARS = json('../shared/car.json');
const MODELS = { height: (x, z) => TERRAIN.height(x, z), bike: { pedal: BIKES.pedalSpeed, max: BIKES.maxSpeed }, car: { top: Math.max(...Object.values(CARS.cars).map((c) => c.maxSpeed)) } };

test('the page\'s numbers copied here are still the page\'s (src/world/bike.ts, car.ts, main.ts)', () => {
  const bike = text('../src/world/bike.ts');
  for (const k of ['ACCEL', 'POWER', 'MASS', 'ROLL', 'DRAG']) assert.equal(constant(bike, k), BIKE[k], `bike.ts ${k}`);
  assert.match(bike, /return PEDAL \* \(1 - clamp\(slope \* 8, -0\.3, 0\.35\)\);/, 'bike.ts pedalCap');
  const car = text('../src/world/car.ts');
  for (const k of ['ACCEL', 'BRAKE', 'TYRE']) assert.equal(constant(car, k), CAR[k], `car.ts ${k}`);
  assert.match(car, /ACCEL \* this\.pedal \* Math\.max\(0, 1 - 0\.65 \* \(u \/ max\) \*\* 2\)/, 'car.ts: the pull less towards the top');
  assert.match(text('../src/main.ts'), /REAL_WALK = 1\.4\b/, 'main.ts REAL_WALK');
  assert.equal(RUN, 3.5);
});

test('the tightest line touches every ring in order and is shorter than the line through the centres', () => {
  for (const r of readGoals().routes) {
    const { pts, length } = cutPath(r);
    const centres = [r.gate, ...r.checkpoints, r.gate];
    assert.equal(pts.length, centres.length);
    pts.forEach(([x, z], i) => assert.ok(Math.abs(Math.hypot(x - centres[i][0], z - centres[i][1]) - r.radius) < 1e-6, `${r.id} ${i}`));
    let straight = 0;
    for (let i = 1; i < centres.length; i++) straight += Math.hypot(centres[i][0] - centres[i - 1][0], centres[i][1] - centres[i - 1][1]);
    assert.ok(length < straight - 2 * r.radius, `${r.id}: ${length} against ${straight}`);
  }
});

test('each floor: the tightest line at the page\'s top, a little under; every honest way round the roads takes longer', () => {
  const routes = readGoals().routes;
  const f = floors(routes, MODELS);
  // The floors as built (ms) from today's layouts.
  assert.deepEqual(Object.fromEntries(Object.entries(f).map(([id, v]) => [id, Math.round(v.ms / 100) / 10])), { foot: 26.4, bike: 75.6, car: 39.8 });
  // Along the road register (the sat-nav's line), at the page's own top: over the floor, for each way.
  const net = makeRoads(json('../src/data/streets.json').graph);
  for (const r of routes) {
    const centres = [r.gate, ...r.checkpoints, r.gate];
    let road = [];
    for (let i = 1; i < centres.length; i++) {
      const line = net.route(centres[i - 1], centres[i]);
      const pts = Array.isArray(line) ? line : line?.line ?? [centres[i - 1], centres[i]];
      road = road.concat(road.length ? pts.slice(1) : pts);
    }
    const s = r.by === 'foot' ? footTime(road) : r.by === 'bike' ? bikeTime(road, MODELS.height, MODELS.bike) : carTime(road, MODELS.car);
    assert.ok(s * 1000 > f[r.id].ms, `${r.id}: the roads in ${s.toFixed(1)} s, the floor ${f[r.id].ms} ms`);
  }
  // A bike at its pedalling speed on the flat, without a slope: the model holds it there.
  assert.ok(Math.abs(bikeTime([[0, 0], [1000, 0]], () => 0, MODELS.bike) - 1000 / BIKES.pedalSpeed) < 3);
  // A car on a straight 1 km from its top speed: the top speed all the way.
  assert.ok(Math.abs(carTime([[0, 0], [1000, 0]], MODELS.car) - 1000 / MODELS.car.top) < 0.5);
});
