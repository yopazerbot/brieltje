// The zombies walk round the trees' trunks at every Zombies place (Yoshi 15 Nov 2026, with the trunks' blocks for
// walking: shared/trees.mjs), the same grid on the page alone as on the server together: the same data and the same
// shared code on both sides (shared/arenas.mjs villageGround, shared/trees.mjs zombieTrunks, server/game.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zombieTrunks } from './trees.mjs';
import { makeCafe, woodTrunks } from './sparrenhof.mjs';
import { makeChurch } from './church.mjs';
import { makeTerrain } from './terrain.mjs';
import { loadBounds } from './bounds.mjs';
import { ARENAS, arenaEdge, arenaHome, arenaOf, arenaSpots, villageGround } from './arenas.mjs';
import { Horde, houseAreas, makeNav } from './zombies.mjs';
import { Game } from '../server/game.mjs';
import { STALL_SPOTS, stallBox } from './stall.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const text = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const house = read('../src/data/house_shell.json');
const village = read('../src/data/village.json');
const terrain = makeTerrain(read('./terrain.json'));
const height = (x, z) => terrain.height(x, z);
const cafeData = read('./sparrenhof.json');
const cafe = makeCafe(cafeData, house.ground + height(...cafeData.origin), read('./tree_huts.json'));
const churchData = read('./church.json');
const church = makeChurch(churchData, house.ground + height(...churchData.origin));
const bounds = loadBounds(read('./bounds.json'));
const homeStreet = Object.values(read('../src/data/homestreet.json').clusters).flatMap((c) => c.blocks ?? []);
const centre = (p) => [p.p[0].reduce((s, q) => s + q[0], 0) / p.p[0].length, p.p[0].reduce((s, q) => s + q[1], 0) / p.p[0].length];

/** The zombies' grid at place `a` as the server makes it (server/game.mjs zombieGround), with the stall's box; `trunks`: with them. */
function grid(a, trunks = true) {
  const edge = arenaEdge(a, bounds);
  const boxes = [stallBox(a.id)].filter(Boolean);
  if (a.center) {
    const g = villageGround(a, edge, trunks ? village : { ...village, trees: [] }, church, cafe);
    const nav = makeNav({ prisms: g.prisms, height, base: house.ground, edge, boxes, areas: g.areas, doors: [], shut: true, panes: 0 });
    return { edge, nav, prisms: g.prisms, spots: arenaSpots(a, nav.spawnSpots(), village, cafe) };
  }
  const prisms = [...house.prisms, ...house.surroundings.prisms, ...homeStreet, ...(trunks ? zombieTrunks(house.surroundings.trees, edge) : [])];
  const nav = makeNav({ prisms, height, base: house.ground, edge, boxes, areas: houseAreas(house.prisms), doors: house.doors, shut: false, panes: house.prisms.length });
  return { edge, nav, prisms, spots: nav.spawnSpots() };
}

for (const a of ARENAS) {
  test(`zombies at ${a.id}: round the trunks, every start joined to the portal, the stall's front open`, () => {
    const { edge, nav, prisms, spots } = grid(a);
    const trunks = prisms.filter((p) => p.n === 'trunk');
    assert.ok(trunks.length > 0, 'trunks in the grid');
    for (const p of trunks) {
      const [x, z] = centre(p);
      if (edge.inside(x, z) && !nav.inHouse(x, z)) assert.ok(!nav.walkable(x, z), `a zombie stands in the trunk at ${x},${z}`);
    }
    const home = arenaHome(a);
    const start = nav.seed(home.x, house.ground + height(home.x, home.z), home.z);
    assert.ok(start, 'the portal\'s spot in the grid');
    // Fewer places to come out (none right by a trunk), still plenty, and none shut in by the trunks (a few in closed
    // yards are shut in without them too).
    const bare = grid(a, false);
    const bareStart = bare.nav.seed(home.x, house.ground + height(home.x, home.z), home.z);
    const shutBefore = new Set(bare.spots.filter((s) => !bare.nav.joined(bareStart.node, s.node)).map((s) => `${s.x},${s.z}`));
    assert.ok(spots.length >= 12 && spots.length >= bare.spots.length * 0.5, `${spots.length} places to come out (${bare.spots.length} without the trunks)`);
    for (const s of spots) assert.ok(nav.joined(start.node, s.node) || shutBefore.has(`${s.x},${s.z}`), `a start at ${s.x},${s.z} shut in by a trunk`);
    const st = STALL_SPOTS.find(([id]) => id === a.id);
    if (st) {
      const [, x, z, yaw] = st;
      const fx = x - Math.sin(yaw) * 1.6, fz = z - Math.cos(yaw) * 1.6;
      const front = nav.seed(fx, house.ground + height(fx, fz), fz);
      assert.ok(front && nav.joined(start.node, front.node), 'the stall\'s front shut in');
    }
  });
}

/** A little random of our own, the same every run. */
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

for (const id of ['sparrenhof', 'church', 'house']) {
  test(`together at ${id} (the server's own grid): the horde comes round the trunks to two players among trees`, () => {
    const game = new Game({ session: () => null }, []);
    const g = game.zombieGround(arenaOf(id));
    const trunks = (id === 'house' ? zombieTrunks(house.surroundings.trees, g.edge) : woodTrunks(village.trees, cafe, g.edge)).map(centre);
    for (const [x, z] of trunks) if (g.edge.inside(x, z) && !g.nav.inHouse(x, z)) assert.ok(!g.nav.walkable(x, z), `the server's grid: a trunk at ${x},${z} open`);
    // Two players where the trees stand thickest (open ground joined to the portal, 8 m or more apart).
    const start = g.nav.seed(g.home.x, house.ground + height(g.home.x, g.home.z), g.home.z);
    const among = [];
    for (const s of g.spots.filter((q) => g.nav.joined(start.node, q.node))) {
      const n = trunks.filter(([x, z]) => Math.hypot(x - s.x, z - s.z) < 6).length;
      among.push([n, s]);
    }
    among.sort((a, b) => b[0] - a[0]);
    const [p1] = among;
    const p2 = among.find(([, s]) => Math.hypot(s.x - p1[1].x, s.z - p1[1].z) > 8);
    const players = [p1[1], p2[1]].map((s, i) => ({ name: `p${i}`, x: s.x, y: house.ground + height(s.x, s.z), z: s.z, alive: true, fighter: true, safe: false }));
    const horde = new Horde(g.nav, g.spots, { home: g.home, rand: rng(11), doors: g.doors, doorOpen: g.doorOpen });
    horde.start(0);
    const hit = new Set();
    const moved = new Map();
    for (let now = 0; now <= 120_000; now += 50) {
      for (const e of horde.tick(now, 0.05, players)) if (e.type === 'swipe') hit.add(e.name);
      for (const zb of horde.zombies.values()) {
        for (const [x, z] of trunks) assert.ok(Math.hypot(x - zb.x, z - zb.z) > 0.1, `a zombie in the trunk at ${x},${z}`);
        const d = Math.min(...players.map((p) => Math.hypot(p.x - zb.x, p.z - zb.z)));
        if (d < (moved.get(zb.id)?.d ?? Infinity)) moved.set(zb.id, { d, x: zb.x, z: zb.z, act: zb.act });
        else moved.get(zb.id).now = [zb.x, zb.z, zb.act];
      }
    }
    // Every zombie that came got to a player or is still closing in (none stuck among the trees; 4 m: the last of a
    // crowd round one), and they hit.
    const far = [...moved.values()].filter((m) => m.d > 4 && m.now);
    assert.ok(hit.size >= 1 && moved.size >= 3 && far.length === 0, `${moved.size} zombies came, ${far.length} never got near ${JSON.stringify(far)}, ${hit.size} players reached (${JSON.stringify(players.map((p) => [p.x, p.z]))}, trees near them: ${p1[0]}, ${p2[0]})`);
  });
}

test('alone and together alike: both sides build the trunks from the same data with the same code', () => {
  const page = text('../src/main.ts');
  const server = text('../server/game.mjs');
  // At home from the ring's trees; in Smetlede from village.json's trees as the server reads them (the page keeps a
  // copy from before its street models thin them out and the football ground adds its own).
  assert.match(page, /zombieTrunks\(house\.surroundings\?\.trees \?\? \[\], edge\)/);
  assert.match(server, /zombieTrunks\(HOUSE\.surroundings\?\.trees \?\? \[\], edge\)/);
  assert.match(page, /villageGround\(arena, edge, \{ \.\.\.data, trees: villageTrees \?\? data\.trees \}/);
  assert.match(page, /villageTrees \?\?= \[\.\.\.data\.trees\];\s*\/\/[^\n]*\n\s*if \(!noFootball\) fcGround\.addToVillage\(data\)/);
  assert.match(server, /villageGround\(arena, edge, VILLAGE, CHURCH, CAFE\)/);
  for (const a of ARENAS.filter((q) => q.center)) {
    const edge = arenaEdge(a, bounds);
    const trunks = villageGround(a, edge, village, church, cafe).prisms.filter((p) => p.n === 'trunk');
    const round = village.trees.filter((t) => t.x >= edge.minX - 2 && t.x <= edge.maxX + 2 && t.z >= edge.minZ - 2 && t.z <= edge.maxZ + 2);
    // all of them (a few on the box's very edge aside), but those on the café's open ground
    assert.ok(trunks.length <= round.length && (a.id === 'sparrenhof' || trunks.length >= round.length - 3), `${a.id}: ${trunks.length} of ${round.length}`);
  }
});
