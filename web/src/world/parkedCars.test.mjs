import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The cars parked on the drives (tools/roads.py writes them to roads.json; world/traffic.ts draws them).
const roads = JSON.parse(readFileSync(new URL('../data/roads.json', import.meta.url), 'utf8'));
// Their sizes, as tools/roads.py fits them: length and width per kind (hatch, estate, van).
const tool = readFileSync(new URL('../../../tools/roads.py', import.meta.url), 'utf8');
const sizes = [.../^KINDS = \{(.*)\}$/m.exec(tool)[1].matchAll(/\(([\d.]+), ([\d.]+)\)/g)].map((m) => [Number(m[1]), Number(m[2])]);

/** A parked car's outline on the plan: its four corners (nose along -z turned by its yaw). */
function outline([x, z, yaw, kind]) {
  const [length, width] = sizes[kind];
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => [x + (fx * length * a) / 2 - (fz * width * b) / 2, z + (fz * length * a) / 2 + (fx * width * b) / 2]);
}

/** The gap between two rectangles along the axis that parts them most (negative: they overlap). */
function gap(a, b) {
  let best = -Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < 4; i++) {
      const [x1, z1] = poly[i];
      const [x2, z2] = poly[(i + 1) % 4];
      const l = Math.hypot(x2 - x1, z2 - z1);
      const nx = (z2 - z1) / l;
      const nz = -(x2 - x1) / l;
      const pa = a.map(([x, z]) => x * nx + z * nz);
      const pb = b.map(([x, z]) => x * nx + z * nz);
      best = Math.max(best, Math.min(...pb) - Math.max(...pa), Math.min(...pa) - Math.max(...pb));
    }
  }
  return best;
}

test('three kinds of parked car, each spot a known kind', () => {
  assert.equal(sizes.length, 3);
  assert.ok(roads.parked.length > 200);
  for (const p of roads.parked) assert.ok(p[3] >= 0 && p[3] < sizes.length, JSON.stringify(p));
});

test('no two parked cars overlap or stand closer than 0.7 m (room to open a door)', () => {
  const rings = roads.parked.map(outline);
  const close = [];
  for (let i = 0; i < rings.length; i++) {
    for (let j = i + 1; j < rings.length; j++) {
      if (Math.hypot(roads.parked[i][0] - roads.parked[j][0], roads.parked[i][1] - roads.parked[j][1]) > 8) continue;
      const g = gap(rings[i], rings[j]);
      if (g < 0.7) close.push(`${JSON.stringify(roads.parked[i])} and ${JSON.stringify(roads.parked[j])}: ${g.toFixed(2)} m`);
    }
  }
  assert.deepEqual(close, []);
});
