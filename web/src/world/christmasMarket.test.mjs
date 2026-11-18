import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHALETS, TABLES, TABLE_R, chaletRing, tableRing } from './christmasMarketPlan.ts';
import { PORTALS } from '../../shared/portals.mjs';

const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const roads = json('../data/roads.json');
const detail = json('../data/roadDetail.json');
const bikes = json('../../shared/bike.json');
// The tree's spot and Sinterklaas's loop, read from their modules (they load graphics, so they can't be imported here).
const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const treeAt = /TREE_AT = \{ x: ([\d.-]+), z: ([\d.-]+) \}/.exec(source('./christmas.ts')).slice(1).map(Number);
const loop = /loop: \{ x: ([\d.-]+), z: ([\d.-]+), r: ([\d.]+) \}/.exec(source('./sinterklaas.ts')).slice(1).map(Number);

/** Every outline of the market: the chalets' and the tables'. */
const outlines = [...CHALETS.map(chaletRing), ...TABLES.map(tableRing)];

/** The distance from a point to a segment. */
function toSegment([px, pz], [ax, az], [bx, bz]) {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

/** The nearest an outline comes to a point (0 inside it). */
function ringTo(ring, p) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  if (inside) return 0;
  return Math.min(...ring.map((a, i) => toSegment(p, a, ring[(i + 1) % ring.length])));
}

/** The nearest two outlines come (corners against edges both ways; enough for these convex shapes apart). */
function ringToRing(a, b) {
  return Math.min(...a.map((p) => ringTo(b, p)), ...b.map((p) => ringTo(a, p)));
}

test('the market stays out of the cars’ way: 2 m from the traffic’s lanes through the square (a car is 2 m wide)', () => {
  for (const route of roads.routes) {
    for (const leg of route.legs) {
      const p = leg.p;
      for (let k = 0; k + 3 < p.length; k += 2) {
        if (Math.hypot(p[k] - 525, p[k + 1] + 766) > 60) continue;
        for (const ring of outlines) {
          const d = Math.min(...ring.map((q) => toSegment(q, [p[k], p[k + 1]], [p[k + 2], p[k + 3]])));
          assert.ok(d >= 2, `${JSON.stringify(ring[0])} is ${d.toFixed(2)} m from a lane`);
        }
      }
    }
  }
});

test('the market stays off the parking bays', () => {
  const bays = detail.patches.filter((b) => b.t === '#5d5c59' && b.r[0].length <= 12).map((b) => {
    const r = b.r[0];
    const ring = [];
    for (let i = 0; i < r.length; i += 2) ring.push([r[i], r[i + 1]]);
    return ring;
  });
  const near = bays.filter((ring) => Math.hypot(ring[0][0] - 525, ring[0][1] + 766) < 40);
  assert.ok(near.length >= 10, 'the square’s bays are found');
  for (const ring of outlines) for (const bay of near) assert.ok(ringToRing(ring, bay) >= 0.5, `${JSON.stringify(ring[0])} near a bay`);
});

test('the market keeps clear of the tree, Sinterklaas’s loop, the portal, the bus stop, the bikes and the notice board', () => {
  const spots = [
    { what: 'the tree', at: treeAt, clear: 2.4 + 2 }, // its crown, and room to walk round it
    { what: 'Sinterklaas’s loop', at: loop.slice(0, 2), clear: loop[2] + 3 },
    { what: 'the portal', at: (() => { const c = PORTALS.find((q) => q.id === 'church'); return [c.x, c.z]; })(), clear: 4 },
    { what: 'the bus stop', at: roads.stops.find((s) => s[3] === 'Smetlede Kerk').slice(0, 2), clear: 4 },
    { what: 'the notice board', at: [549, -761], clear: 4 },
    ...Object.entries(bikes.bikes ?? bikes).filter(([id]) => id.startsWith('church')).map(([id, b]) => ({ what: id, at: [b.park.x, b.park.z], clear: 3 })),
  ];
  assert.ok(spots.length >= 8);
  for (const { what, at, clear } of spots) for (const ring of outlines) assert.ok(ringTo(ring, at) >= clear, `${what}: ${ringTo(ring, at).toFixed(2)} m`);
});

test('the chalets and the tables stand apart, with room to walk to every counter', () => {
  for (let i = 0; i < outlines.length; i++) {
    for (let j = i + 1; j < outlines.length; j++) assert.ok(ringToRing(outlines[i], outlines[j]) >= (i < CHALETS.length && j < CHALETS.length ? 0.15 : 0.9), `${i} and ${j}`);
  }
  assert.ok(CHALETS.length >= 4 && CHALETS.length <= 6);
  assert.equal(new Set(CHALETS.map((c) => c.goods)).size, CHALETS.length);
  assert.ok(TABLE_R < 0.5);
});
