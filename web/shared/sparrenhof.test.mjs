// The Sparrenhof as a Zombies place (Yoshi, 7 Nov 2026): the horde comes out of the wood round the café, and its
// five outside stairs lead up to its roofs and platforms, where the zombies follow (shared/sparrenhof.mjs, shared/arenas.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeCafe, cafePrisms, woodSpots, WOOD_DEPTH } from './sparrenhof.mjs';
import { makeChurch, churchPrisms } from './church.mjs';
import { makeTerrain } from './terrain.mjs';
import { loadBounds } from './bounds.mjs';
import { ARENAS, arenaOf, arenaEdge, arenaPrisms, arenaSpots, portalOf, villageGround } from './arenas.mjs';
import { makeNav, Horde, ZOMBIE } from './zombies.mjs';
import { noShoot } from './zones.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const data = read('./sparrenhof.json');
const house = read('../src/data/house_shell.json');
const village = read('../src/data/village.json');
const terrain = makeTerrain(read('./terrain.json'));
const height = (x, z) => terrain.height(x, z);
const cafe = makeCafe(data, house.ground + height(...data.origin));
const churchData = read('./church.json');
const church = makeChurch(churchData, house.ground + height(...churchData.origin));
const bounds = loadBounds(read('./bounds.json'));
const arena = arenaOf('sparrenhof');
const edge = arenaEdge(arena, bounds);
const ground = villageGround(arena, edge, village, church, cafe);
const nav = makeNav({ prisms: ground.prisms, height, base: house.ground, edge, areas: ground.areas, doors: [], shut: true, panes: 0 });
const spots = arenaSpots(arena, nav.spawnSpots(), village, cafe);
const seed = (p) => nav.seed(p.x, p.y, p.z);

/** A little random of our own, the same every run. */
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('the Sparrenhof is a Zombies place in the wood, its portal and café inside its edge', () => {
  assert.ok(ARENAS.some((a) => a.id === 'sparrenhof'));
  assert.equal(arena.id, 'sparrenhof');
  assert.ok(arena.woods);
  const p = portalOf(arena);
  assert.ok(edge.inside(p.out[0], p.out[1]));
  for (const s of cafe.stairs) assert.ok(edge.inside(s.foot.x, s.foot.z) && edge.inside(s.top.x, s.top.z), s.id);
  for (const r of cafe.roofs) assert.ok(edge.inside(r.at.x, r.at.z) && !noShoot(r.at.x, r.at.z), r.id);
  for (const a of ARENAS) if (a.id !== 'sparrenhof') assert.ok(!a.woods, a.id);
});

test('the stairs are sized for a person: rise at most 18.5 cm, going 25 cm', () => {
  assert.equal(cafe.stairs.length, 5);
  assert.deepEqual(cafe.stairs.map((s) => s.id).sort(), ['forecourt', 'ridge', 'side', 'terrace', 'upper']);
  for (const s of cafe.stairs) {
    assert.ok(s.rise >= 0.15 && s.rise <= 0.185, `${s.id} rise ${s.rise}`);
    assert.equal(s.going, 0.25);
    assert.ok(s.top.y - s.foot.y > 2.4, `${s.id} climbs to a roof`);
  }
});

test('the higher platforms (8 Nov 2026): the upper deck and the ridge by stairs from the annex\'s deck, the walkway between two roofs', () => {
  const at = (id) => cafe.roofs.find((r) => r.id === id).at;
  const stair = (id) => cafe.stairs.find((s) => s.id === id);
  const deck = at('deck');
  for (const id of ['upper', 'ridge']) {
    assert.ok(Math.abs(stair(id).foot.y - deck.y) < 0.01, `${id} leaves from the deck`);
    assert.ok(Math.abs(stair(id).top.y - at(id).y) < 0.01, `${id} arrives on its platform`);
  }
  assert.ok(at('upper').y - deck.y > 2.6, 'the upper deck a storey over the deck');
  assert.ok(Math.max(...cafe.roofs.map((r) => r.at.y)) === at('ridge').y, 'the ridge the highest');
  assert.ok(at('ridge').y - deck.y > 3.2);
  // The walkway is level with the roofs it links: a step of a few centimetres, no stair.
  assert.ok(Math.abs(at('link').y - at('carport').y) < 0.2 && Math.abs(at('link').y - at('walk').y) < 0.2);
  // From each of them a zombie gets at a player: the out-of-reach rule never warns there.
  const horde = new Horde(nav, spots, { home: { x: portalOf(arena).out[0], z: portalOf(arena).out[1] }, rand: rng(1) });
  for (const id of ['upper', 'ridge', 'link']) {
    const s = horde.reachOf({ name: id, ...at(id) });
    assert.ok(s?.ok, `${id} in reach`);
    assert.ok(Math.abs(nav.y(s.node) - at(id).y) < 0.3, `${id} on its own floor`);
  }
});

test("the café's own blocks stand in for its plain open-data block, every other block stays", () => {
  const blocks = cafePrisms(village.prisms, cafe);
  const gone = village.prisms.filter((p) => !blocks.includes(p));
  assert.ok(gone.length >= 1 && gone.length <= 8, `${gone.length} replaced`);
  for (const p of gone) assert.equal(p.d, undefined, 'never a draped ground cover or fence');
  assert.ok(blocks.filter((p) => p.lm === 'sparrenhof').length === cafe.prisms.length);
  assert.deepEqual(cafePrisms(blocks, cafe).length, blocks.length, 'idempotent');
  assert.ok(cafe.prisms.every((p) => p.y1 > p.y0 && p.p.flat().flat().every(Number.isFinite)));
});

test('the other places keep the same grid as before', () => {
  for (const id of ['church', 'molenhoek', 'molenhoek_mid', 'molenhoek_end']) {
    const a = arenaOf(id);
    const e = arenaEdge(a, bounds);
    const g = villageGround(a, e, village, church, cafe);
    assert.deepEqual(g.prisms, arenaPrisms(churchPrisms(village.prisms, church), e), id);
    assert.deepEqual(g.areas, id === 'church' ? [church.area] : [], id);
    const s = [{ x: 0, z: 0, node: 1 }];
    assert.equal(arenaSpots(a, s, village, cafe), s);
  }
});

test('every stair joins the ground to its roof, and the roofs are in the zombies\' grid', () => {
  const portal = portalOf(arena);
  const start = seed({ x: portal.out[0], y: house.ground + height(portal.out[0], portal.out[1]), z: portal.out[1] });
  assert.ok(start);
  for (const s of cafe.stairs) {
    const foot = seed(s.foot);
    const top = seed(s.top);
    assert.ok(foot && top, s.id);
    assert.ok(Math.abs(nav.y(top.node) - s.top.y) < 0.3, `${s.id} top ${nav.y(top.node)} vs ${s.top.y}`);
    assert.ok(nav.joined(start.node, foot.node), `${s.id} foot`);
    assert.ok(nav.joined(start.node, top.node), `${s.id} top`);
  }
  for (const r of cafe.roofs) {
    const node = seed(r.at);
    assert.ok(node, r.id);
    assert.ok(Math.abs(nav.y(node.node) - r.at.y) < 0.3, `${r.id} at ${nav.y(node.node)} vs ${r.at.y}`);
    assert.ok(nav.joined(start.node, node.node), r.id);
  }
});

test('the guard rails close the roofs\' edges: a swipe goes along the deck, not across its rail', () => {
  const deck = cafe.roofs.find((r) => r.id === 'deck').at;
  const walk = cafe.roofs.find((r) => r.id === 'walk').at;
  assert.ok(nav.reach(deck.x, deck.y + 1, deck.z, deck.x + 0.8, deck.y + 1, deck.z + 0.4));
  // Along the roof walk (it runs across the café, about along z): yes. Over its rails to either side: no.
  assert.ok(nav.reach(walk.x, walk.y + 1, walk.z, walk.x, walk.y + 1, walk.z + 1.2));
  const across = (dx) => nav.reach(walk.x, walk.y + 1, walk.z, walk.x + dx, walk.y + 1, walk.z + 0.2);
  assert.equal(across(1.1), false);
  assert.equal(across(-1.1), false);
});

test('the horde comes out deep in the wood, never on the café\'s open ground', () => {
  assert.ok(spots.length >= 40, `${spots.length} spots in the wood`);
  assert.ok(spots.every((s) => s.wood));
  const woods = village.prisms.filter((p) => p.m === 'forest');
  const inside = (x, z, ring) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i], [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    }
    return hit;
  };
  for (const s of spots) {
    assert.ok(edge.inside(s.x, s.z));
    assert.ok(woods.some((w) => inside(s.x, s.z, w.p[0])), `${s.x},${s.z} in the wood`);
    for (const ring of cafe.clear) assert.ok(!inside(s.x, s.z, ring), `${s.x},${s.z} not on the open ground`);
  }
  // Round the café: on both sides and behind it, not only on one.
  const sides = new Set(spots.map((s) => Math.floor(((Math.atan2(s.x - 662, s.z - 952) + Math.PI) / (2 * Math.PI)) * 4) % 4));
  assert.ok(sides.size >= 3, `spots on ${sides.size} sides`);
  // Too few deep spots (a place with hardly any wood): all of them, as before.
  assert.equal(woodSpots([{ x: 0, z: 0, node: 1 }], village.prisms, cafe).length, 0);
  assert.ok(WOOD_DEPTH >= 2);
});

test('the trees are in the zombies\' way, the stairs and roofs clear of them', () => {
  const trunks = ground.prisms.filter((p) => p.n === 'trunk');
  assert.ok(trunks.length > 50, `${trunks.length} trunks`);
  const centre = (p) => [p.p[0].reduce((s, q) => s + q[0], 0) / 8, p.p[0].reduce((s, q) => s + q[1], 0) / 8];
  for (const t of trunks) {
    const [x, z] = centre(t);
    for (const s of cafe.stairs) {
      // along the flight from its foot to its top
      for (let f = 0; f <= 1; f += 0.1) {
        const px = s.foot.x + (s.top.x - s.foot.x) * f, pz = s.foot.z + (s.top.z - s.foot.z) * f;
        assert.ok(Math.hypot(x - px, z - pz) > 1.2, `a trunk at ${x},${z} on the ${s.id} stair`);
      }
    }
  }
});

test('the first waves come out of the wood and walk out between the trees to the forecourt', () => {
  const rand = rng(5);
  const horde = new Horde(nav, spots, { home: { x: portalOf(arena).out[0], z: portalOf(arena).out[1] }, rand });
  const out = portalOf(arena).out;
  const player = { name: 'p', x: out[0], y: house.ground + height(out[0], out[1]), z: out[1], alive: true, fighter: true, safe: false };
  horde.start(0);
  const born = new Map();
  let closest = Infinity;
  for (let now = 0; now <= 90_000; now += 50) {
    const ev = horde.tick(now, 0.05, [player]);
    for (const e of ev) if (e.type === 'spawn') born.set(e.id, { ...horde.zombies.get(e.id) });
    for (const z of horde.zombies.values()) closest = Math.min(closest, Math.hypot(z.x - player.x, z.z - player.z));
    if (ev.some((e) => e.type === 'swipe')) break;
  }
  assert.ok(born.size >= 3, `${born.size} came`);
  for (const z of born.values()) assert.ok(spots.some((s) => Math.hypot(s.x - z.x, s.z - z.z) < 1), `zombie ${z.id} at ${z.x},${z.z} out of a wood spot`);
  assert.ok(closest < 2, `they reach the forecourt (closest ${closest.toFixed(1)} m)`);
});

for (const id of ['deck', 'walk', 'carport', 'upper', 'ridge', 'link']) {
  test(`a wave follows a player up to the ${id}: no unreachable perch`, () => {
    const rand = rng(17);
    const roof = cafe.roofs.find((r) => r.id === id).at;
    const horde = new Horde(nav, spots, { home: { x: portalOf(arena).out[0], z: portalOf(arena).out[1] }, rand });
    const player = { name: 'roof', ...roof, alive: true, fighter: true, safe: false };
    horde.start(0);
    let hit = false;
    let highest = -Infinity;
    let climbed = false;
    for (let now = 0; now <= 180_000; now += 50) {
      const ev = horde.tick(now, 0.05, [player]);
      assert.ok(!ev.some((e) => e.type === 'perch' || e.type === 'perchOut'), 'warned off a roof the zombies reach');
      for (const z of horde.zombies.values()) {
        highest = Math.max(highest, z.y);
        if (now < (z.climbUntil ?? 0)) climbed = true;
      }
      if (ev.some((e) => e.type === 'swipe')) {
        hit = true;
        break;
      }
    }
    assert.ok(hit, `highest zombie ${highest}, roof ${roof.y}`);
    assert.ok(climbed, 'slowed on the stair');
  });
}

test('on a stair a zombie is slower than on the flat', () => {
  const s = cafe.stairs.find((q) => q.id === 'side');
  const roof = cafe.roofs.find((r) => r.id === 'deck').at;
  const timeUp = (climb) => {
    const was = ZOMBIE.climb;
    ZOMBIE.climb = climb;
    try {
      const horde = new Horde(nav, spots, { home: s.foot, rand: rng(3) });
      horde.phase = 'wave';
      horde.wave = 1;
      horde.toSpawn = 0;
      const node = seed(s.foot).node;
      horde.zombies.set(1, { id: 1, kind: 0, x: s.foot.x, y: nav.y(node), z: s.foot.z, node, yaw: 0, speed: 0, top: 1.2, hp: 1e6, max: 1e6, damage: 0,
        act: 'walk', actAt: 0, until: 0, struck: false, next: 0, downAt: 0, target: null });
      const player = { name: 'roof', ...roof, alive: true, fighter: true, safe: true };
      for (let now = 0; now < 60_000; now += 50) {
        horde.tick(now, 0.05, [player]);
        if (horde.zombies.get(1).y > s.top.y - 0.1) return now;
      }
      return Infinity;
    } finally {
      ZOMBIE.climb = was;
    }
  };
  const slow = timeUp(ZOMBIE.climb);
  const fast = timeUp(1);
  assert.ok(Number.isFinite(slow) && Number.isFinite(fast), `${slow} ${fast}`);
  assert.ok(slow > fast * 1.3, `up the stair in ${slow} ms, ${fast} ms at full pace`);
});
