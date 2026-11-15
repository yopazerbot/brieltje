import test from 'node:test';
import assert from 'node:assert/strict';

const { RoofField, SLAB, climb, boxAround, inBoxes } = await import('./roofField.ts');

/**
 * A gable roof as world/surroundings.ts draws one: a rectangle 10 m along x and 8 m across z with 30 cm of overhang,
 * eaves at 3 m (dropping 15 cm at the overhang), ridge at 7 m along z = 4. Two quads, four triangles.
 */
const EAVES = 3;
const RIDGE = 7;
const O = 0.3;
const slope = (z) => (z <= 4 ? EAVES - 0.15 + ((z + O) / (4 + O)) * (RIDGE - EAVES + 0.15) : EAVES - 0.15 + ((8 + O - z) / (4 + O)) * (RIDGE - EAVES + 0.15));
const quad = (p, q, s, t) => [...p, ...q, ...s, ...p, ...s, ...t];
const v = (x, z) => [x, slope(z), z];
function gable() {
  const f = new RoofField();
  const kept = f.add([...quad(v(-O, -O), v(10 + O, -O), v(10 + O, 4), v(-O, 4)), ...quad(v(-O, 4), v(10 + O, 4), v(10 + O, 8 + O), v(-O, 8 + O))], EAVES);
  return { f, kept };
}

test('a roof is the drawn height at every point of it, the ridge and the eaves included', () => {
  const { f, kept } = gable();
  assert.equal(kept, 4);
  for (let x = -0.25; x <= 10.25; x += 0.37) {
    for (let z = -0.25; z <= 8.25; z += 0.29) {
      assert.ok(f.sample(x, z), `a roof at ${x}, ${z}`);
      assert.ok(Math.abs(f.top - slope(z)) < 1e-4, `at ${x}, ${z}: ${f.top} against ${slope(z)}`);
    }
  }
  assert.ok(f.sample(5, 4) && Math.abs(f.top - RIDGE) < 1e-4, 'the ridge exactly');
});

test('outside the roof nothing changes', () => {
  const { f } = gable();
  for (const [x, z] of [[-0.4, 4], [10.4, 4], [5, -0.4], [5, 8.4], [40, 40], [-200, 3]]) {
    assert.equal(f.sample(x, z), false, `${x}, ${z}`);
    assert.equal(f.floor(x, z, 0, 0.5), null);
    assert.equal(f.blocks(x, z, 0, 0.5, 1.8), false);
  }
});

test('under the roof it is solid down to the eaves, under the overhang a slab', () => {
  const { f } = gable();
  f.sample(5, 2);
  assert.equal(f.bottom, EAVES, 'over the walls: down to the eaves');
  f.sample(5, -0.2);
  assert.ok(Math.abs(f.bottom - (f.top - SLAB)) < 1e-6, 'the overhang: a slab');
  // From above: the roof is the floor, whatever the height of the drop.
  assert.equal(f.floor(5, 4, 1e6, 0), f.top);
  assert.ok(Math.abs(f.floor(5, 2, 100, 0) - slope(2)) < 1e-4);
  // A body inside the roof's solid goes up onto the roof (the way out), one under the eaves stays where it is.
  assert.ok(Math.abs(f.floor(5, 2, EAVES + 0.1, 0.5) - slope(2)) < 1e-4);
  assert.equal(f.floor(5, -0.2, 0, 0.5), null, 'standing in the street under the overhang');
  // Walking: the roof stops a body whose head reaches it, not one standing on it or well under it.
  assert.equal(f.blocks(5, 2, slope(2), 0.5, 1.8), false, 'on the slope');
  assert.equal(f.blocks(5, 2, slope(2) - 0.4, 0.5, 1.8), false, 'a step below the slope: stepped onto');
  assert.equal(f.blocks(5, 2, EAVES - 1.0, 0.5, 1.8), true, 'the eaves at head height');
  assert.equal(f.blocks(5, -0.2, 0, 0.5, 1.8), false, 'under eaves at 2.85 m: free');
});

test('an open eave, shelter or porch roof never stops a walker; the roof of a building does', () => {
  const lean = new RoofField(); // a lean-to's overhang: eaves at 2 m, 15 cm lower at its edge, nothing under it
  lean.add(quad([0, 1.85, -0.3], [4, 1.85, -0.3], [4, 1.9, 0], [0, 1.9, 0]), Infinity);
  assert.equal(lean.blocks(2, -0.1, 0, 0.5, 1.8), false, 'walked under, the head passes as when roofs were drawn only');
  assert.ok(lean.sample(2, -0.1) && lean.open, 'an open slab');
  assert.ok(Math.abs(lean.floor(2, -0.1, 3, 0) - (1.85 + 0.05 * (0.2 / 0.3))) < 1e-3, 'landed on from above');
  const shelter = new RoofField(); // a bike shelter's clear roof at 1.7 to 1.9 m, posts only under it
  shelter.add(quad([0, 1.7, 0], [10, 1.7, 0], [10, 1.9, 3], [0, 1.9, 3]), Infinity);
  assert.equal(shelter.blocks(5, 1.5, 0, 0.5, 1.8), false);
  const house = new RoofField(); // over a building's walls (eaves at 2 m): solid down to them, a wall to the side
  house.add(quad([0, 2, 0], [4, 2, 0], [4, 4, 3], [0, 4, 3]), 2);
  assert.ok(house.sample(2, 2) && !house.open);
  assert.equal(house.blocks(2, 2, 0.5, 0.5, 1.8), true);
  assert.equal(house.blocks(2, 0.1, 0, 0.5, 1.8), false, 'by the eaves the roof is a slab over the wall line: the wall stops you there');
});

test('the slope under a point, and how fast a roof is walked up', () => {
  const { f } = gable();
  assert.equal(f.slope(40, 40), null);
  const k = (RIDGE - EAVES + 0.15) / (4 + O);
  assert.ok(Math.abs(f.slope(5, 2) - (Math.atan(k) * 180) / Math.PI) < 1e-3);
  assert.equal(climb(0), 1, 'flat');
  assert.equal(climb(-3), 1, 'down');
  assert.equal(climb(Math.tan((30 * Math.PI) / 180)), 1, '30 degrees: full pace');
  assert.ok(Math.abs(climb(Math.tan((47.5 * Math.PI) / 180)) - 0.5) < 1e-9, 'half way: half pace');
  assert.equal(climb(Math.tan((60 * Math.PI) / 180)), 0, '60 degrees: not at all');
  assert.equal(climb(10), 0, 'steeper');
  // The fastest way up stays far under the server's 16 m/s up or down: even at 8 m/s across, at most about 5 m/s up.
  let up = 0;
  for (let a = 0; a < 90; a += 0.5) { const r = Math.tan((a * Math.PI) / 180); up = Math.max(up, 8 * climb(r) * r); }
  assert.ok(up < 6, `${up}`);
});

test('a box round a building leaves its roof out (the play tower)', () => {
  const box = boxAround([[10, 10], [12, 10], [12, 14], [10, 14]], 1);
  assert.deepEqual(box, [9, 9, 13, 15]);
  assert.ok(inBoxes([box], 11, 12) && inBoxes([box], 9.1, 14.9));
  assert.ok(!inBoxes([box], 8.9, 12) && !inBoxes([], 11, 12));
});

test('an eave by the ground is air below the lowest a roof counts from: no ramp up for a car or a horse', () => {
  const f = new RoofField(); // a shed's slope from 0.3 m over the ground up to 3 m
  f.add(quad([0, 0.3, 0], [4, 0.3, 0], [4, 3, 4], [0, 3, 4]), 0.3);
  const LOW = 1.0; // what world/collision.ts asks: a metre over the ground
  assert.equal(f.sample(2, 0.5, LOW), false, 'the low edge: air');
  assert.equal(f.floor(2, 0.5, 0, 0.5, LOW), null, 'a car at the ground stays on it');
  assert.equal(f.blocks(2, 0.5, 0, 0.3, 1.5, LOW), false);
  assert.ok(f.sample(2, 3, LOW) && f.top > LOW, 'higher up: the roof');
  assert.ok(f.blocks(2, 3, 0, 0.5, 1.8, LOW), 'and a wall to walk into from the ground');
});

test('the highest drawn surface counts: a chimney on the ridge, a higher roof over a lower one', () => {
  const { f } = gable();
  // A chimney top 1 m over the ridge, 60 cm square: solid whatever stands under it.
  f.add(quad([7, 8, 3.7], [7.6, 8, 3.7], [7.6, 8, 4.3], [7, 8, 4.3]), EAVES, null, true);
  assert.ok(f.sample(7.3, 4) && Math.abs(f.top - 8) < 1e-6 && f.closed);
  assert.ok(f.sample(6, 4) && !f.closed, 'the roof beside it asks for a wall under it');
  assert.equal(f.blocks(7.3, 4, RIDGE - 0.05, 0.5, 1.8), true, 'its side stops a body on the ridge');
  assert.ok(f.sample(6, 4) && Math.abs(f.top - RIDGE) < 1e-4, 'beside it the ridge');
});

test('walls and gables are left out; any slope up to steep is kept', () => {
  const f = new RoofField();
  assert.equal(f.add([0, 0, 0, 4, 0, 0, 4, 3, 0], EAVES), 0, 'upright');
  assert.equal(f.add([0, 0, 0, 4, 0, 0, 4, 4, 1], EAVES), 1, 'a 76 degree slope');
  assert.equal(f.add([0, 0, 0, 0, 0, 1, 4, 0, 0], EAVES, [0, 1, 2]), 1, 'indexed, either winding');
});

test('per-triangle bottoms, and many batches over many squares of the index', () => {
  const f = new RoofField();
  for (let i = 0; i < 50; i++) f.add(quad([i * 7, 5, 0], [i * 7 + 5, 5, 0], [i * 7 + 5, 6, 30], [i * 7, 6, 30]), [2 + i * 0.01, Infinity]);
  for (let i = 0; i < 50; i++) {
    assert.ok(f.sample(i * 7 + 4, 2));
    assert.ok(Math.abs(f.top - (5 + 2 / 30)) < 1e-4);
    assert.ok(f.sample(i * 7 + 1, 28));
    assert.ok(Math.abs(f.bottom - (f.top - SLAB)) < 1e-6, 'the second triangle: a slab');
    assert.equal(f.sample(i * 7 + 6, 10), false, 'between the roofs');
  }
  assert.equal(f.count, 100);
  assert.ok(f.bytes > 100 * 40);
});

test('the solid under a roof never reaches down past the lowest a roof counts from: nothing on the ground is inside one', () => {
  const f = new RoofField(); // a roof at 6 m whose building's top (from a corner down the slope) is at 1.2 m
  f.add(quad([0, 6, 0], [8, 6, 0], [8, 6, 8], [0, 6, 8]), 1.2);
  assert.ok(f.sample(4, 4) && Math.abs(f.bottom - 1.2) < 1e-6 && !f.open);
  const ground = 3.4; // the ground here, higher up the slope
  assert.ok(f.sample(4, 4, ground + 1) && Math.abs(f.bottom - (ground + 1)) < 1e-6);
  assert.equal(f.floor(4, 4, ground, 0, ground + 1), null, 'a villager or a car on the ground here stays on it');
});
