import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Game } from './game.mjs';
import { arenaEdge, arenaOf, ARENAS, portalOf, villageGround } from '../shared/arenas.mjs';
import { loadBounds } from '../shared/bounds.mjs';
import { makeChurch } from '../shared/church.mjs';
import { makeKeet } from '../shared/keet.mjs';
import { Loot } from '../shared/loot.mjs';
import { makeCafe } from '../shared/sparrenhof.mjs';
import { stallBox } from '../shared/stall.mjs';
import { makeTerrain } from '../shared/terrain.mjs';
import { Horde, makeNav } from '../shared/zombies.mjs';
import { NO_SHOOT } from '../shared/zones.mjs';

// Zombies at the church follow players into the café there (Yoshi, 16 Nov 2026): its rooms in the zombies' grid, its doors
// shoved open, the church place's edge round it and its back street. The grid as the server builds it (game.zombieGround).
const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const house = read('../src/data/house_shell.json');
const village = read('../src/data/village.json');
const terrain = makeTerrain(read('../shared/terrain.json'));
const height = (x, z) => terrain.height(x, z);
const cafeData = read('../shared/sparrenhof.json');
const cafe = makeCafe(cafeData, house.ground + height(...cafeData.origin), read('../shared/tree_huts.json'));
const churchData = read('../shared/church.json');
const church = makeChurch(churchData, house.ground + height(...churchData.origin));
const bounds = loadBounds(read('../shared/bounds.json'));
const shell = read('../src/data/keet_shell.json');
const keet = makeKeet(shell, read('../src/data/keet_rooms.json'));
const arena = arenaOf('church');
const edge = arenaEdge(arena, bounds);

// The café's frame (shared/keet.mjs): u along the front to the east, v into the house.
const { o, a } = shell.frame;
const W = (u, v) => [o[0] + u * Math.cos(a) + v * Math.sin(a), o[1] - u * Math.sin(a) + v * Math.cos(a)];
const F = keet.floor;
const inRings = (x, z, rings) => {
  let hit = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i];
      const [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    }
  }
  return hit;
};
const solids = keet.prisms.filter((p) => p.y1 > F + 0.3 && p.y0 < F + 1.75);
/** Whether a body (0.3 m round) can stand on the floor at (x, z): nothing solid of the café there between knee and head. */
const free = (x, z) => [[0, 0], ...Array.from({ length: 8 }, (_, k) => [0.3 * Math.sin((k * Math.PI) / 4), 0.3 * Math.cos((k * Math.PI) / 4)])].every(([dx, dz]) => !solids.some((p) => inRings(x + dx, z + dz, p.p)));

/** The church place's grid with the café, as game.zombieGround makes it; `extra`: blocks added (a doorway shut for a test). */
function grid(extra = [], withKeet = true, a2 = arena) {
  const e = arenaEdge(a2, bounds);
  const g = villageGround(a2, e, village, church, cafe, withKeet ? keet : null);
  const nav = makeNav({ prisms: [...g.prisms, ...extra], height: g.relief(height, house.ground), base: house.ground, edge: e, boxes: [stallBox(a2.id)].filter(Boolean), areas: g.areas, doors: g.doors, shut: false, panes: 0 });
  return { nav, g, spots: nav.spawnSpots(), edge: e };
}
const church0 = grid();
const regionsOf = ({ nav, spots }) => new Set(spots.map((s) => nav.region(s.node)));
/** A wall across a doorway (its leaf's line, 0.4 m thick, floor to head): the way through it shut. */
const wallAcross = (id) => {
  const d = keet.doors.find((q) => q.id === id);
  const [ax, az] = d.panels[0].a;
  const [bx, bz] = d.panels[0].b;
  const len = Math.hypot(bx - ax, bz - az);
  const nx = (-(bz - az) / len) * 0.2, nz = ((bx - ax) / len) * 0.2;
  const ex = ((bx - ax) / len) * 0.1, ez = ((bz - az) / len) * 0.1;
  return { m: 'wall', y0: F - 0.5, y1: F + 2.6, p: [[[ax - ex + nx, az - ez + nz], [bx + ex + nx, bz + ez + nz], [bx + ex - nx, bz + ez - nz], [ax - ex - nx, az - ez - nz]]] };
};
const floors = keet.prisms.filter((p) => p.n && Math.abs(p.y1 - F) < 1e-6);
/** Points every 0.5 m over each room's floor where a body fits: { room, x, z }. */
const lattice = (() => {
  const out = [];
  for (const f of floors) {
    const r = f.p[0];
    const us = [], vs = [];
    for (const [x, z] of r) {
      const dx = x - o[0], dz = z - o[1];
      us.push(dx * Math.cos(a) - dz * Math.sin(a));
      vs.push(dx * Math.sin(a) + dz * Math.cos(a));
    }
    for (let u = Math.min(...us) + 0.25; u < Math.max(...us); u += 0.5) {
      for (let v = Math.min(...vs) + 0.25; v < Math.max(...vs); v += 0.5) {
        const [x, z] = W(u, v);
        if (inRings(x, z, f.p) && free(x, z)) out.push({ room: f.n, x, z });
      }
    }
  }
  return out;
})();
const horde = (g, doorOpen = () => false) => new Horde(g.nav, g.spots, { home: { x: portalOf(arena).out[0], z: portalOf(arena).out[1] }, doors: g.g.doors, doorOpen, rand: seeded(7) });
function seeded(s) {
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

test('every room of the café joins where the zombies come out: its middle, and every 0.5 m of floor a body fits on', (t) => {
  t.diagnostic(`${lattice.length} points on ${floors.length} floors; the grid ${church0.nav.nodes} nodes`);
  const regions = regionsOf(church0);
  const { nav } = church0;
  const rooms = new Set(floors.map((f) => f.n));
  assert.deepEqual([...rooms].sort(), [...keet.spots.map((s) => s.name)].sort(), 'a floor for each room');
  assert.ok(lattice.length > 150, `${lattice.length} points`);
  for (const r of rooms) assert.ok(lattice.some((q) => q.room === r), `points in ${r}`);
  for (const q of lattice) {
    const s = nav.seed(q.x, F, q.z, (k) => regions.has(nav.region(k)));
    assert.ok(s && s.gap <= 0.3 && Math.abs(nav.y(s.node, q.x, q.z) - F) < 0.4, `${q.room} at ${q.x.toFixed(2)}, ${q.z.toFixed(2)}: ${JSON.stringify(s)}`);
  }
  for (const s of keet.spots) {
    const k = nav.seed(s.x, s.y, s.z, (n) => regions.has(nav.region(n)));
    assert.ok(k && k.gap <= 0.6, `${s.name}'s middle (the front room's is under the pool table's edge): ${JSON.stringify(k)}`);
  }
});

test('the perch rule never fires for someone in a room, on a chair, on a table or on the pool table', () => {
  const h = horde(church0);
  const at = (name, x, y, z) => h.reachOf({ name, x, y, z });
  for (const s of keet.spots) assert.equal(at(s.name, s.x, s.y, s.z)?.ok, true, s.name);
  for (const q of lattice) assert.equal(at('p', q.x, F, q.z)?.ok, true, `${q.room} ${q.x.toFixed(2)} ${q.z.toFixed(2)}`);
  // On the furniture a body can stand on (nothing over 0.95 m: tools/keet.py): every chair, table and the pool table.
  const tops = keet.prisms.filter((p) => p.n && p.y1 > F + 0.3 && p.y1 <= F + 0.95 && p.y0 <= F + 0.05);
  assert.ok(tops.length >= 20, `${tops.length} pieces to stand on`);
  for (const p of tops) {
    const r = p.p[0];
    const x = r.reduce((t, q) => t + q[0], 0) / r.length, z = r.reduce((t, q) => t + q[1], 0) / r.length;
    assert.equal(at('p', x, p.y1, z)?.ok, true, `on ${p.n}'s piece at ${(p.y1 - F).toFixed(2)} m, ${x.toFixed(2)}, ${z.toFixed(2)}`);
  }
});

test('two ways in: with the front door walled up the front room is reached by the back, and the toilets by the front', () => {
  for (const [id, rooms] of [['keet-front', ['front room', 'bar room', 'toilet 1', 'toilet 2']], ['keet-back', ['front room', 'back hall', 'toilet 1', 'toilet 2', 'behind the bar']]]) {
    const g = grid([wallAcross(id)]);
    const regions = regionsOf(g);
    for (const r of rooms) {
      const pts = lattice.filter((q) => q.room === r);
      const reached = pts.filter((q) => {
        const s = g.nav.seed(q.x, F, q.z);
        return s && regions.has(g.nav.region(s.node));
      });
      assert.equal(reached.length, pts.length, `${id} walled up: ${r} ${reached.length} of ${pts.length}`);
    }
  }
  // Both walled up: nothing inside is reached (the windows are no way in, below).
  const g = grid([wallAcross('keet-front'), wallAcross('keet-back')]);
  const regions = regionsOf(g);
  for (const q of lattice) {
    const s = g.nav.seed(q.x, F, q.z);
    assert.ok(!s || !regions.has(g.nav.region(s.node)), `${q.room} reached with both doors walled up`);
  }
});

test('the windows are no way in, whole or broken: no floor inside joins the ground outside across a sill', () => {
  const g = grid([wallAcross('keet-front'), wallAcross('keet-back')]);
  for (const broken of [[], keet.panes]) {
    g.nav.setPanes(broken);
    const regions = regionsOf(g);
    for (const q of lattice) {
      const s = g.nav.seed(q.x, F, q.z);
      assert.ok(!s || !regions.has(g.nav.region(s.node)), `${broken.length} broken: ${q.room}`);
    }
  }
  // Walking straight out through each window from a step inside it: never a way.
  for (const w of keet.prisms.filter((p) => Number.isInteger(p.glass))) {
    const r = w.p[0];
    const mx = r.reduce((t, q) => t + q[0], 0) / r.length, mz = r.reduce((t, q) => t + q[1], 0) / r.length;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ix = mx + dx * 0.6, iz = mz + dz * 0.6;
      if (!keet.contains(ix, iz)) continue;
      const k = church0.nav.locate(ix, F, iz);
      if (k < 0) continue;
      assert.equal(church0.nav.walk(k, ix, iz, mx - dx * 0.8, mz - dz * 0.8), -1, `out through pane ${w.glass}`);
    }
  }
});

test('the church place\'s edge goes round the café, the lane, the canopy\'s yard and the back street, and not onto the school', () => {
  for (const s of keet.spots) assert.ok(edge.inside(s.x, s.z), s.name);
  for (const [u, v, what] of [[7.8, 9, 'the lane'], [-2, 12.5, 'under the canopy'], [2.9, 19.5, 'the back street'], [4.73, -1, 'in front of the door']]) assert.ok(edge.inside(...W(u, v)), what);
  assert.ok(edge.inside(541, -764), 'the stall');
  assert.ok(edge.inside(536.3, -771.6), 'the portal\'s way out');
  assert.ok(!edge.inside(...W(2.9, 22)), 'past the back street: out');
  const ring = edge.ring;
  assert.ok(ring.length > 40, 'the circle and the café\'s box');
  for (const [x, z] of ring) assert.ok(bounds.map.depth(x, z) >= 2 - 1e-6, `${x}, ${z}: 2 m inside the map's edge`);
  // No point of the school's zone, its corners or inside it, is in the place.
  for (const zone of NO_SHOOT) {
    for (const [x, z] of zone.poly) assert.ok(!edge.inside(x, z), `${zone.id} ${x}, ${z}`);
    const xs = zone.poly.map((q) => q[0]), zs = zone.poly.map((q) => q[1]);
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 1) for (let z = Math.min(...zs); z <= Math.max(...zs); z += 1) if (inRings(x, z, [zone.poly])) assert.ok(!edge.inside(x, z), `${zone.id} ${x}, ${z}`);
  }
  // A simple ring: no two sides cross.
  const cross = (p, q, r, s) => {
    const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    return d(p, q, r) * d(p, q, s) < 0 && d(r, s, p) * d(r, s, q) < 0;
  };
  for (let i = 0; i < ring.length; i++) {
    for (let j = i + 2; j < ring.length; j++) {
      if (i === 0 && j === ring.length - 1) continue;
      assert.ok(!cross(ring[i], ring[(i + 1) % ring.length], ring[j], ring[(j + 1) % ring.length]), `sides ${i} and ${j} cross`);
    }
  }
  // The circle's own points, where they are not round the café, are where they were.
  const plain = arenaEdge({ ...arena, also: undefined }, bounds).ring;
  const kept = plain.filter((q) => ring.some((r) => r[0] === q[0] && r[1] === q[1]));
  assert.ok(kept.length >= plain.length - 2, `${kept.length} of ${plain.length} of the circle's points kept`);
});

test('the café\'s doors: a zombie shoves a shut one open when its way leads through it, the server tells every page', () => {
  const open = new Map();
  const h = horde(church0, (id) => open.get(id) ?? false);
  const inside = keet.spots.find((s) => s.name === 'front room');
  const [px, pz] = W(4.73, 2.2); // just inside the front door
  const [zx, zz] = W(4.73, -1.6); // on the square in front of it
  const node = church0.nav.locate(zx, house.ground + height(zx, zz), zz);
  assert.ok(node >= 0 && inside);
  h.phase = 'wave';
  h.wave = 1;
  h.zombies.set(1, { id: 1, kind: 0, x: zx, y: church0.nav.y(node, zx, zz), z: zz, node, yaw: 0, speed: 0, top: 1.2, hp: 50, max: 50, damage: 10, act: 'walk', actAt: 0, until: 0, struck: false, next: 0, downAt: 0, target: null });
  const doorsShoved = [];
  let swiped = false;
  for (let t = 0; t < 20000 && !swiped; t += 50) {
    for (const e of h.tick(t, 0.05, [{ name: 'p', x: px, y: F, z: pz, alive: true, fighter: true, safe: false }])) {
      if (e.type === 'door') {
        doorsShoved.push(e.id);
        open.set(e.id, true);
      }
      if (e.type === 'swipe') swiped = true;
    }
  }
  assert.deepEqual(doorsShoved, ['keet-front']);
  assert.ok(swiped, 'and swipes at the player inside');
  // The server: open for everyone, a guest without any home's right told too.
  const game = new Game({ session: () => null }, []);
  game.homes = { granted: () => false };
  const got = [];
  game.players.set('guest', { key: 'k', role: 'guest', ws: { readyState: 1, OPEN: 1, send: (d) => got.push(JSON.parse(d)) }, alive: true, state: { x: 545, y: 6, z: -740 } });
  game.zombieDoor('keet-front', 1);
  assert.equal(game.doors['keet-front'], true);
  assert.deepEqual(got.filter((m) => m.t === 'door').map((m) => [m.id, m.open]), [['keet-front', true]]);
  // A home's door is as it was: never told to a page without its right.
  got.length = 0;
  const before = game.doors['kh-home-front'];
  game.zombieDoor('kh-home-front', 1);
  assert.ok(!got.some((m) => m.t === 'door'), 'no home\'s door to a guest');
  assert.ok(game.doors['kh-home-front'] === before || game.doors['kh-home-front'] === true);
  game.zombieDoor('keet-nosuch', 1);
  game.zombieDoor('toString', 1);
  assert.equal(game.doors['keet-nosuch'], undefined);
  assert.ok(!Object.hasOwn(game.doors, 'toString'));
});

test('a wave at the church: zombies reach a player in a toilet behind two shut doors, swipe, and follow them back out', (t) => {
  const open = new Map(keet.doors.map((d) => [d.id, false]));
  const h = horde(church0, (id) => open.get(id) ?? true);
  h.start(0);
  const t2 = keet.spots.find((s) => s.name === 'toilet 2');
  let me = { name: 'p', x: t2.x, y: F, z: t2.z, alive: true, fighter: true, safe: false };
  const shoved = new Set();
  let swipeAt = -1;
  let outAt = -1;
  let worst = 0;
  const on = (z) => z.node >= 0 && church0.nav.open(z.node);
  for (let now = 0; now < 180000; now += 50) {
    if (swipeAt >= 0 && me.x === t2.x) me = { ...me, x: 541, z: -745 }; // out on the square
    for (const e of h.tick(now, 0.05, [me])) {
      if (e.type === 'door') {
        shoved.add(e.id);
        open.set(e.id, true);
      }
      if (e.type === 'swipe' && swipeAt < 0) swipeAt = now;
      if (e.type === 'perch') assert.fail('perched in the toilet');
    }
    for (const z of h.zombies.values()) {
      if (z.act === 'down') continue;
      assert.ok(on(z), `zombie ${z.id} on a closed square at ${z.x.toFixed(2)}, ${z.z.toFixed(2)}`);
      if (keet.contains(z.x, z.z)) worst = Math.max(worst, z.y - F);
    }
    if (swipeAt >= 0 && now > swipeAt + 1000 && outAt < 0) {
      const inside = [...h.zombies.values()].filter((z) => z.act !== 'down' && keet.contains(z.x, z.z));
      if (!inside.length) outAt = now;
    }
    if (outAt >= 0) break;
  }
  assert.ok(swipeAt >= 0 && swipeAt < 8000 + 90000, `a swipe in the toilet after ${swipeAt} ms`);
  assert.ok(shoved.has('keet-toilet2') && shoved.has('keet-toilets'), `doors shoved: ${[...shoved]}`);
  assert.ok(worst < 0.4, `inside the café no zombie walks on a chair or higher (the back door's steps aside): ${worst.toFixed(2)} m`);
  assert.ok(outAt >= 0 && outAt - swipeAt < 60000, `out of the café after the player within ${outAt - swipeAt} ms`);
  t.diagnostic(`first swipe in the toilet ${swipeAt} ms after the start (the first break is ${8000} ms); all out ${outAt - swipeAt} ms after; doors shoved ${[...shoved].join(' ')}`);
});

test('claymores, stakes and turrets in the café: on its floor only, a doorway too, and none of them shuts a way', () => {
  const loot = new Loot(church0.nav);
  const regions = () => keet.spots.map((s) => church0.nav.region(church0.nav.seed(s.x, s.y, s.z).node)).join();
  const before = regions();
  const kit = loot.kit('p');
  Object.assign(kit, { claymores: 2, stakes: 3, turrets: 1 });
  const [dx, dz] = W(4.73, 0.6); // the front doorway, just inside its leaf
  const me = { x: W(4.73, 1.8)[0], y: F, z: W(4.73, 1.8)[1] };
  const at = (x, z, y = F) => ({ x, y, z, yaw: 0 });
  assert.ok(loot.place('p', me, at(dx, dz), 0).mine, 'a claymore in the front doorway');
  const along = -Math.atan2(Math.cos(a) === 0 ? 1 : -Math.sin(a), Math.cos(a)); // the game's yaw along the front wall
  const row = loot.placeStakes('p', me, { ...at(...W(4.73, 0.15), F + 0.05), yaw: along }, null).row;
  assert.ok(row, 'a row of stakes in it');
  assert.ok(row.b - row.a <= 0.94, `no wider than the doorway: ${(row.b - row.a).toFixed(2)} m`);
  assert.ok(loot.placeTurret('p', me, at(...W(4.2, 2.5)), 0).turret, 'a turret in the front room');
  // Not in a wall, not on the counter, not in the air over the pool table.
  Object.assign(kit, { claymores: 2 });
  for (const [u, v, y, what] of [[2.75, 9.5, F + 1.1, 'on the counter'], [5.58, 2.2, F, 'in the east wall'], [2.5, 4.4, F + 1.5, 'over the pool table']]) {
    const [x, z] = W(u, v);
    assert.equal(loot.spot({ x: x - 0.5, y: F, z }, at(x, z, y)), null, what);
  }
  assert.equal(regions(), before, 'every room as joined as before');
});

test('the other places\' grids are as they were', () => {
  for (const id of ['molenhoek', 'sparrenhof', 'molenhoek_mid', 'molenhoek_end']) {
    const a2 = arenaOf(id);
    const after = grid([], true, a2);
    const e = arenaEdge(a2, bounds);
    const g = villageGround(a2, e, village, church, cafe);
    const before = makeNav({ prisms: g.prisms, height, base: house.ground, edge: e, boxes: [stallBox(id)].filter(Boolean), areas: g.areas, doors: [], shut: true, panes: 0 });
    assert.equal(after.nav.nodes, before.nodes, id);
    assert.equal(after.g.doors.length, 0, id);
    assert.equal(after.g.relief(height, house.ground), height, `${id}: the relief as it is`);
  }
  assert.ok(ARENAS.filter((q) => q.also).every((q) => q.id === 'church'), 'only the church place grows');
});

test('the server builds that grid at the church, with the café\'s doors for its horde and nothing shut', () => {
  const game = new Game({ session: () => null }, []);
  const t0 = performance.now();
  const g = game.zombieGround(arena);
  const ms = performance.now() - t0;
  assert.deepEqual(g.doors.map((d) => d.id).sort(), [...keet.doorIds].sort());
  assert.equal(g.nav.nodes, church0.nav.nodes);
  assert.equal(g.doorOpen('keet-mid'), true, 'the door to the bar room stands open at the start');
  assert.equal(g.doorOpen('keet-front'), false);
  assert.ok(ms < 2000, `${ms.toFixed(0)} ms`);
});
