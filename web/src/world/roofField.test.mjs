import test from 'node:test';
import assert from 'node:assert/strict';

const { RoofField, SLAB } = await import('./roofField.ts');

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

test('a low eave stops a body, a garage roof at 2.4 m does not', () => {
  const lean = new RoofField(); // a lean-to: eaves at 2 m, 15 cm lower at its edge
  lean.add(quad([0, 1.85, -0.3], [4, 1.85, -0.3], [4, 3, 3], [0, 3, 3]), 2);
  assert.equal(lean.blocks(2, -0.1, 0, 0.5, 1.8), true);
  const garage = new RoofField(); // a flat-ish garage roof at 2.4 m
  garage.add(quad([0, 2.25, -0.3], [4, 2.25, -0.3], [4, 2.5, 6], [0, 2.5, 6]), 2.4);
  assert.equal(garage.blocks(2, -0.1, 0, 0.5, 1.8), false);
  assert.equal(garage.floor(2, -0.1, 0, 0.5), null, 'a car or a body under it stays on the ground');
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
  // A chimney top 1 m over the ridge, 60 cm square.
  f.add(quad([7, 8, 3.7], [7.6, 8, 3.7], [7.6, 8, 4.3], [7, 8, 4.3]), EAVES);
  assert.ok(f.sample(7.3, 4) && Math.abs(f.top - 8) < 1e-6);
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
