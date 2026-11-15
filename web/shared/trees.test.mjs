// The trees' trunks as blocks (shared/trees.mjs, Yoshi 15 Nov 2026: no more walking through trees): one per tree,
// as big as its drawn trunk, never a floor; no fixed spot of the game taken.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trunkHeight, trunkPrisms, trunkRadius, zombieTrunks, ZOMBIE_TRUNK_TOP } from './trees.mjs';
import { loadBounds } from './bounds.mjs';
import { STALL_SPOTS } from './stall.mjs';
import { PORTALS } from './portals.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const text = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const house = read('../src/data/house_shell.json');
const village = read('../src/data/village.json');
const bounds = loadBounds(read('./bounds.json'));
const ringTrees = house.surroundings.trees;
const trees = [...village.trees, ...ringTrees];
const centre = (p) => [p.p[0].reduce((s, q) => s + q[0], 0) / p.p[0].length, p.p[0].reduce((s, q) => s + q[1], 0) / p.p[0].length];

test('one block per tree, in the trees\' order: an octagon round its foot, named trunk', () => {
  const prisms = trunkPrisms(trees);
  assert.equal(prisms.length, trees.length);
  prisms.forEach((p, i) => {
    const t = trees[i];
    assert.equal(p.n, 'trunk');
    assert.equal(p.p.length, 1);
    assert.equal(p.p[0].length, 8);
    const [cx, cz] = centre(p);
    assert.ok(Math.hypot(cx - t.x, cz - t.z) < 0.002, `centred on its tree at ${t.x},${t.z}`);
  });
  assert.deepEqual(trunkPrisms([]), []);
});

test('as big as the drawn trunk: 12 to 35 cm each way, from under the ground up to its crown', () => {
  assert.equal(trunkRadius(3), 0.12);
  assert.equal(trunkRadius(40), 0.35);
  assert.ok(trunkRadius(15) > trunkRadius(10));
  for (const [i, p] of trunkPrisms(trees).entries()) {
    const t = trees[i];
    const r = Math.max(...p.p[0].map(([x, z]) => Math.hypot(x - t.x, z - t.z)));
    assert.ok(r >= 0.119 && r <= 0.351, `radius ${r}`);
    assert.equal(p.d, undefined, 'from the tree\'s own foot, as drawn (a tree in a ditch too), not draped on the relief');
    assert.ok(p.y0 - t.y < 0 && p.y0 - t.y >= -0.5, `foot ${p.y0} under the tree's ${t.y}`);
    assert.ok(p.y1 - t.y >= 1.995 && p.y1 - t.y <= Math.max(2, t.h) + 0.005, `top ${p.y1} for a tree of ${t.h} m at ${t.y}`);
    assert.ok(Math.abs(p.y1 - t.y - trunkHeight(t)) < 0.01);
  }
  // The zombies': one height for all, over every floor among the trees (the tree huts', at most 6 m up).
  const near = trees.filter((t) => bounds.map.inside(t.x, t.z));
  zombieTrunks(near, bounds.map).forEach((p, i) => assert.ok(Math.abs(p.y1 - near[i].y - ZOMBIE_TRUNK_TOP) < 0.01));
  assert.ok(ZOMBIE_TRUNK_TOP > 6 + 2);
});

test('never a floor or a ceiling: world/collision.ts skips a trunk\'s block in groundAt and ceilingAbove', () => {
  const src = text('../src/world/collision.ts');
  assert.match(src, /noFloor: p\.n === 'trunk'/);
  const body = (name) => {
    const at = src.indexOf(`\n  ${name}(`);
    return src.slice(at, src.indexOf('\n  }\n', at));
  };
  for (const f of ['groundAt', 'ceilingAbove']) assert.match(body(f), /s\.noFloor/, f);
  for (const f of ['resolve', 'boxFree', 'collide', 'touching']) assert.doesNotMatch(body(f), /noFloor/, `${f} meets trunks`);
});

test('no spawn, portal, place, gnome, route gate, stall or pick-up is taken by a trunk', () => {
  const spots = [
    ...read('./spawns.json').map((s) => ['spawn', s.x, s.z]),
    ...PORTALS.flatMap((p) => [['portal', p.x, p.z], ['portal out', p.out[0], p.out[1]]]),
    ...read('./places.json').places.map((p) => ['place', p.x, p.z]),
    ...read('./gnomes.json').gnomes.map((g) => [`gnome ${g.id}`, g.x, g.z]),
    ...read('./routes.json').routes.flatMap((r) => [[`gate ${r.id}`, ...r.gate], ...r.checkpoints.map((c) => [`checkpoint ${r.id}`, ...c])]),
    ...STALL_SPOTS.map(([id, x, z]) => [`stall ${id}`, x, z]),
    ...read('./pickups.json').map((p) => [`pickup ${p.w}`, p.x, p.z]),
    ...Object.entries(read('./bike.json').bikes).map(([id, k]) => [`bike ${id}`, k.park.x, k.park.z]),
  ];
  for (const [name, x, z] of spots) {
    for (const t of trees) {
      const gap = Math.hypot(t.x - x, t.z - z) - trunkRadius(t.h);
      assert.ok(gap > 0.3, `${name} at ${x},${z}: a trunk ${gap.toFixed(2)} m off`);
    }
  }
});
