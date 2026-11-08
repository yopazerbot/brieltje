// The tree huts in the wood round the Sparrenhof (Yoshi, 8 Nov 2026: shooting bases): built by tools/tree_huts.py,
// placed with the café (shared/sparrenhof.mjs), in the zombies' grid up their timber stairs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeCafe, HUT_KEEP } from './sparrenhof.mjs';
import { makeChurch } from './church.mjs';
import { makeTerrain } from './terrain.mjs';
import { loadBounds } from './bounds.mjs';
import { arenaOf, arenaEdge, arenaSpots, portalOf, villageGround } from './arenas.mjs';
import { makeNav, Horde } from './zombies.mjs';
import { noShoot } from './zones.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const data = read('./sparrenhof.json');
const hutsData = read('./tree_huts.json');
const house = read('../src/data/house_shell.json');
const village = read('../src/data/village.json');
const pickups = read('./pickups.json');
const terrain = makeTerrain(read('./terrain.json'));
const height = (x, z) => terrain.height(x, z);
const groundAt = (x, z) => house.ground + height(x, z);
const cafe = makeCafe(data, house.ground + height(...data.origin), hutsData);
const churchData = read('./church.json');
const church = makeChurch(churchData, house.ground + height(...churchData.origin));
const arena = arenaOf('sparrenhof');
const edge = arenaEdge(arena, loadBounds(read('./bounds.json')));
const ground = villageGround(arena, edge, village, church, cafe);
const nav = makeNav({ prisms: ground.prisms, height, base: house.ground, edge, areas: ground.areas, doors: [], shut: true, panes: 0 });
const spots = arenaSpots(arena, nav.spawnSpots(), village, cafe);
const out = portalOf(arena).out;
const start = nav.seed(out[0], groundAt(out[0], out[1]), out[1]);
const tree = (x, z) => village.trees.find((t) => Math.hypot(t.x - x, t.z - z) < 0.05);

function inside(ring, x, z) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/** m from (x, z) to the outline `ring` (0 inside) */
function distance(ring, x, z) {
  if (inside(ring, x, z)) return 0;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[j], [xj, zj] = ring[i];
    const dx = xj - xi, dz = zj - zi;
    const t = Math.max(0, Math.min(1, ((x - xi) * dx + (z - zi) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(xi + dx * t - x, zi + dz * t - z));
  }
  return best;
}

/** A little random of our own, the same every run. */
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('three or four huts in the wood, 20 to 60 m from the café, inside the place\'s edge, at 3 to 6 m', () => {
  assert.ok(cafe.huts.length >= 3 && cafe.huts.length <= 4, `${cafe.huts.length} huts`);
  const cafeRing = data.outlines[0];
  const woods = village.prisms.filter((p) => p.m === 'forest');
  const heights = [];
  for (const h of cafe.huts) {
    const [t] = h.trees;
    const d = distance(cafeRing, t[0], t[1]);
    assert.ok(d >= 20 && d <= 60, `${h.id} ${d.toFixed(1)} m from the café`);
    assert.ok(woods.some((w) => inside(w.p[0], t[0], t[1])), `${h.id} in the wood`);
    for (const [x, z] of h.footprint) assert.ok(edge.inside(x, z) && !noShoot(x, z), `${h.id} inside the edge at ${x},${z}`);
    const floor = h.floors[0];
    const over = floor.y - groundAt(t[0], t[1]);
    assert.ok(over >= 3 && over <= 6, `${h.id} at ${over.toFixed(2)} m`);
    heights.push(over);
  }
  assert.ok(Math.max(...heights) - Math.min(...heights) > 1.5, 'at different heights');
  // Their blocks are in the place's blocks, inside its edge.
  const hutBlocks = cafe.prisms.filter((p) => p.lm === 'tree_huts');
  assert.ok(hutBlocks.length > 100);
  for (const p of hutBlocks) assert.ok(p.y1 > p.y0 && p.p[0].every(([x, z]) => edge.inside(x, z)));
  assert.ok(hutBlocks.every((p) => ground.prisms.includes(p)));
});

test('each hut stands by its real trees, and no other tree grows through a floor or a stair', () => {
  for (const h of cafe.huts) {
    for (const [x, z] of h.trees) {
      const t = tree(x, z);
      assert.ok(t, `${h.id}: a tree at ${x},${z}`);
      assert.ok(t.h > h.floors[0].y - groundAt(x, z) + 3, `${h.id}: its tree reaches over it`);
      // Against the footprint, not in it: within a metre of its edge.
      assert.ok(distance(h.footprint, x, z) < 1, `${h.id}: by its tree`);
    }
    for (const t of village.trees) {
      if (h.trees.some(([x, z]) => Math.hypot(t.x - x, t.z - z) < 0.05)) continue;
      assert.ok(distance(h.footprint, t.x, t.z) > 0.5, `${h.id}: a tree at ${t.x},${t.z} in it`);
    }
  }
});

test('the timber stairs are sized for a person and reach the ground', () => {
  for (const h of cafe.huts) {
    assert.ok(h.stairs.length >= 1, h.id);
    for (const s of h.stairs) {
      assert.ok(s.rise >= 0.15 && s.rise <= 0.185, `${s.id} rise ${s.rise}`);
      assert.equal(s.going, 0.25);
      assert.ok(Math.abs(s.foot.y - groundAt(s.foot.x, s.foot.z)) < 0.15, `${s.id} foot on the ground`);
      assert.ok(Math.abs(s.top.y - h.floors[0].y) < 0.01, `${s.id} up to the platform`);
      assert.ok(Math.abs(s.risers * s.rise - (s.top.y - s.foot.y)) < 0.15, `${s.id} risers`);
    }
  }
});

test('every floor of every hut is in the zombies\' grid, joined to the ground by its stairs', () => {
  assert.ok(start);
  for (const h of cafe.huts) {
    for (const s of h.stairs) {
      const foot = nav.seed(s.foot.x, s.foot.y, s.foot.z);
      assert.ok(foot && nav.joined(start.node, foot.node), `${s.id} foot`);
    }
    for (const f of h.floors) {
      const node = nav.seed(f.x, f.y, f.z);
      assert.ok(node, `${h.id} floor at ${f.y}`);
      assert.ok(Math.abs(nav.y(node.node) - f.y) < 0.3, `${h.id} floor ${nav.y(node.node)} vs ${f.y}`);
      assert.ok(nav.joined(start.node, node.node), `${h.id} floor joined`);
    }
  }
});

test('the out-of-reach rule never warns a player on a hut', () => {
  const horde = new Horde(nav, spots, { home: { x: out[0], z: out[1] }, rand: rng(2) });
  for (const h of cafe.huts) {
    for (const f of h.floors) {
      const s = horde.reachOf({ name: h.id, ...f });
      assert.ok(s?.ok, `${h.id} at ${f.x},${f.z} in reach`);
    }
  }
});

test('no zombie comes out within a few metres of a hut, and the wood still has plenty of spots', () => {
  assert.ok(HUT_KEEP >= 3);
  assert.ok(spots.length >= 40, `${spots.length} spots`);
  for (const s of spots) for (const h of cafe.huts) assert.ok(distance(h.footprint, s.x, s.z) > HUT_KEEP - 0.01, `${s.x},${s.z} by ${h.id}`);
});

for (const id of ['lookout', 'pair', 'north', 'west']) {
  test(`a wave climbs up to the ${id} hut after a player: no safe perch`, () => {
    const h = cafe.huts.find((q) => q.id === id);
    const player = { name: id, ...h.floors[0], alive: true, fighter: true, safe: false };
    const horde = new Horde(nav, spots, { home: { x: out[0], z: out[1] }, rand: rng(9) });
    horde.start(0);
    let hit = false;
    let climbed = false;
    let highest = -Infinity;
    for (let now = 0; now <= 240_000; now += 50) {
      const ev = horde.tick(now, 0.05, [player]);
      assert.ok(!ev.some((e) => e.type === 'perch' || e.type === 'perchOut'), 'warned off a hut the zombies reach');
      for (const z of horde.zombies.values()) {
        highest = Math.max(highest, z.y);
        if (now < (z.climbUntil ?? 0)) climbed = true;
      }
      if (ev.some((e) => e.type === 'swipe')) {
        hit = true;
        break;
      }
    }
    assert.ok(hit, `highest zombie ${highest.toFixed(2)}, floor ${h.floors[0].y.toFixed(2)}`);
    assert.ok(climbed, 'slowed on the stair');
  });
}

test('a sniper rifle lies in the highest hut', () => {
  const top = cafe.huts.reduce((a, b) => (b.floors[0].y - groundAt(...b.trees[0]) > a.floors[0].y - groundAt(...a.trees[0]) ? b : a));
  const w = pickups.find((p) => p.w === 'sniper' && distance(top.footprint, p.x, p.z) === 0);
  assert.ok(w, `a sniper in the ${top.id}`);
  assert.ok(Math.abs(w.y - top.floors[0].y) < 0.05, `on its floor (${w.y} vs ${top.floors[0].y})`);
  assert.ok(pickups.indexOf(w) === pickups.length - 1, 'added at the end');
});
