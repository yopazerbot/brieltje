import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { barrierHeights, DOOR_GLASS, distanceToHome, END_DOOR_GLASS, findHome, HOMES, homeAt, homeOfDoor, inEndGarden, makePaneHomes, PANE_LIMIT, WALK_IN_GLASS, WALK_INS } from './homes.mjs';
import { brick, brickInside, end, HAVE_PRIVATE, house, packs, pickupsInside, SKIP, spawnsInside } from './testData.mjs';
import { loadBounds } from './bounds.mjs';
import { makeSolids } from './parking.mjs';
import { PORTALS } from './portals.mjs';
import { makeTerrain } from './terrain.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const spawns = read('./spawns.json');
const pickups = read('./pickups.json');
const places = read('./places.json').places;
const terrain = makeTerrain(read('./terrain.json'));

// The walked-into houses' doors and outlines: the doors are in each one's own frame (src/world/walkIn.ts toWorld), their
// heights above its floor.
const frameOf = (data) => {
  const { o, a, floor } = data.frame;
  return { floor, toWorld: ([x, z]) => [o[0] + x * Math.cos(a) + z * Math.sin(a), o[1] - x * Math.sin(a) + z * Math.cos(a)] };
};
const { floor, toWorld } = frameOf(end);
const { floor: brickFloor, toWorld: brickWorld } = frameOf(brick);
const wallPoints = (d) => d.panels.flatMap((p) => (d.id.startsWith('mh-end-') ? [toWorld(p.a), toWorld(p.b)] : d.id.startsWith('kh-home-') ? [brickWorld(p.a), brickWorld(p.b)] : [p.a, p.b]));
/** A point of the brick house in its floor coordinates (u along the front, v into the house), in the world. */
const brickAt = (u, v) => [613.14 + u * -0.26634 + v * 0.96384, -361.86 + u * 0.96384 + v * 0.26634];

/** Whether any height holds the point inside a home (a person flying over it, or standing under it). */
const anyHeight = (x, z) => {
  for (let y = -5; y <= 40; y += 0.25) if (homeAt(x, z, y)) return homeAt(x, z, y);
  return null;
};

function inPoly(x, z, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
function edgeDist(x, z, ring) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[j];
    const [bx, bz] = ring[i];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-9)));
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return best;
}
/** Points over a polygon 0.5 m apart, at least `margin` m from its edge (several for any room of a metre or more). */
function samples(ring, margin = 0.45) {
  const xs = ring.map((q) => q[0]);
  const zs = ring.map((q) => q[1]);
  const out = [];
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += 0.5) for (let z = Math.min(...zs); z <= Math.max(...zs); z += 0.5) if (inPoly(x, z, ring) && edgeDist(x, z, ring) >= margin) out.push([x, z]);
  return out;
}
/** Points over a polygon, its edges and corners too. */
const outlinePoints = (ring) => [...ring, ...samples(ring, 0)];

test('four homes, with a few bands each', () => {
  assert.deepEqual(HOMES.map((h) => h.id), ['house', 'bungalow', 'molenhoek_end', 'kapellenhoek_home']);
  assert.deepEqual(HOMES.map((h) => h.bands.length), [3, 2, 1, 2]);
  for (const h of HOMES) for (const b of h.bands) assert.ok(b.ring.length >= 4 && b.ring.length <= 12 && b.y1 > b.y0, h.id);
  assert.equal(findHome('bungalow')?.id, 'bungalow');
  assert.equal(findHome('home-01'), null);
  assert.equal(findHome({}), null);
});

test('every door of the data belongs to a home, exactly', { skip: SKIP }, () => {
  const owners = { house: [], bungalow: [], molenhoek_end: [], kapellenhoek_home: [] };
  for (const d of [...house.doors, ...end.doors, ...brick.doors]) {
    const home = homeOfDoor(d.id);
    assert.ok(home, `${d.id} has no home`);
    owners[home].push(d.id);
  }
  const ids = (home) => (packs.find((p) => p.id === home)?.doors ?? []).map((d) => d.id);
  assert.deepEqual(owners.bungalow, [...house.doors.filter((d) => d.id.startsWith('bungalow-out-')).map((d) => d.id), ...ids('bungalow')]);
  assert.deepEqual(owners.molenhoek_end, end.doors.map((d) => d.id));
  assert.deepEqual(owners.kapellenhoek_home, brick.doors.map((d) => d.id));
  assert.ok(brick.doors.length > 10, 'the shell\'s outside doors and the pack\'s inside ones');
  assert.deepEqual(owners.house, [...house.doors.filter((d) => d.id.startsWith('house-out-')).map((d) => d.id), ...ids('house')]);
  assert.ok(owners.house.length > 15);
  for (const id of ['', 'nope', 'door-x', 'house-out', 'mh-end', 'kh-home', 'kh-hom-x', null, undefined, 7, {}]) assert.equal(homeOfDoor(id), null, String(id));
});

test('each home\'s doors lie on a band\'s ring or inside it, at their own heights', () => {
  for (const d of [...house.doors, ...end.doors, ...brick.doors]) {
    const home = homeOfDoor(d.id);
    const [y0, y1] = d.id.startsWith('mh-end-') ? [d.y0 + floor, d.y1 + floor] : d.id.startsWith('kh-home-') ? [d.y0 + brickFloor, d.y1 + brickFloor] : [d.y0, d.y1];
    const far = Math.min(...wallPoints(d).map(([x, z]) => distanceToHome(home, x, z, y0 + 0.1, y1 - 0.1)));
    assert.ok(far <= 0.5, `${d.id} is ${far.toFixed(2)} m from the ${home}`);
  }
});

test('rooms of every floor are inside their home, sampled all over, standing and jumping', { skip: SKIP }, () => {
  let n = 0;
  // The main house: the rooms of the data, by level.
  const levels = Object.fromEntries(house.levels.map((l) => [l.id, l.floor]));
  for (const r of house.rooms) {
    for (const [x, z] of samples(r.p[0])) {
      for (const dy of [0.05, 1, 1.8]) {
        assert.equal(homeAt(x, z, levels[r.level] + dy), 'house', `${r.name} ${r.level} ${x},${z} +${dy}`);
        n++;
      }
    }
  }
  // The bungalow: the floors of its ground level and its roof space ("old house" floors).
  for (const p of house.prisms) {
    if (!/\(old house\)$/.test(p.n ?? '') || !/^old_(floor|wood)$/.test(p.m) || /trap|Driveway/i.test(p.n)) continue;
    for (const [x, z] of samples(p.p[0])) {
      for (const dy of [0.05, 1.2, 1.8]) {
        assert.equal(homeAt(x, z, p.y1 + dy), 'bungalow', `${p.n} ${x},${z} +${dy}`);
        n++;
      }
    }
  }
  // The end house: its outline, both floors.
  for (const [x, z] of samples(end.outline)) {
    for (const dy of [0.05, 1.5, 2.95, 4.5, 5.5]) {
      assert.equal(homeAt(x, z, floor + dy), 'molenhoek_end', `end ${x},${z} +${dy}`);
      n++;
    }
  }
  // The brick house: the floors of its rooms (the pack's, in its own frame), both floors, the garage too.
  let brickRooms = 0;
  for (const p of brickInside.prisms) {
    if (!brickInside.rooms.includes(p.n) || !['wood', 'tile', 'concrete'].includes(p.m) || p.y1 - p.y0 < 0.05) continue;
    brickRooms++;
    for (const [x, z] of samples(p.p[0].map(brickWorld))) {
      for (const dy of [0.05, 1, 1.8]) {
        assert.equal(homeAt(x, z, brickFloor + p.y1 + dy), 'kapellenhoek_home', `brick ${p.n} ${x},${z} +${dy}`);
        n++;
      }
    }
  }
  assert.ok(brickRooms >= 15, `${brickRooms} rooms of the brick house`);
  assert.ok(n > 3000, `${n} samples`);
});

test('outside stays free: the roof terrace and its stair, the carport, terraces, paths, gardens, roofs', () => {
  const named = (names) => house.prisms.filter((p) => names.includes(p.n));
  // The roof terrace (floor 3.03) and the top of the outside stair.
  for (const p of named(['roof terrace', 'Dakterras', 'outside stair to roof terrace'])) {
    for (const [x, z] of outlinePoints(p.p[0])) for (const dy of [0.02, 0.5, 1.7]) assert.equal(homeAt(x, z, p.y1 + dy), null, `${p.n} ${x},${z} y ${p.y1 + dy}`);
  }
  // The stair's steps, where the feet stand on them (their tops), all the way up to the terrace.
  for (const p of named(['outside stair to roof terrace'])) for (const [x, z] of outlinePoints(p.p[0])) assert.equal(homeAt(x, z, p.y1), null, `stair ${x},${z} y ${p.y1}`);
  // The carport under the first floor's strip, and the paths and terraces round the house, at the height of the ground.
  for (const p of named(['covered terrace', 'back terrace (uncovered)', 'path along the outbuilding', 'side path (right)', 'driveway', 'front path', 'stepping slab'])) {
    for (const [x, z] of outlinePoints(p.p[0])) for (const dy of [0.05, 1, 1.7]) assert.equal(homeAt(x, z, p.y1 + dy), null, `${p.n} ${x},${z} +${dy}`);
  }
  for (let x = 0.7; x <= 4.3; x += 0.3) for (const z of [10.7, 11, 11.4, 11.9]) for (const y of [-0.1, 0.8, 1.7]) assert.equal(homeAt(x, z, y), null, `carport ${x},${z},${y}`);
  // Standing on the roofs (a landing, a person on the shed or the front roof), and above: the bands end below them.
  for (const p of named(['1st floor roof, rear', '1st floor roof, front', '2nd floor roof', 'garden shed'])) {
    if (p.n === 'garden shed') continue; // its floor slab; the shed's roof is the terrace (checked above)
    for (const [x, z] of outlinePoints(p.p[0])) for (const dy of [0.05, 2, 30, 150]) assert.equal(homeAt(x, z, p.y1 + dy), null, `${p.n} ${x},${z} +${dy}`);
  }
  // The end house's roof, and above every home (drops start at 170 m and fly over them).
  for (const [x, z] of outlinePoints(end.outline)) for (const dy of [6.1, 20, 170]) assert.equal(homeAt(x, z, floor + dy), null, `end roof ${dy}`);
  for (const h of HOMES) for (const b of h.bands) for (const [x, z] of outlinePoints(b.ring)) assert.equal(homeAt(x, z, 170), null, `${h.id} at 170 m`);
  // The brick house (floor coordinates: u along the front, v into the house, heights above its floor): the covered
  // terrace in its back corner, the drive and the path in front, the garden behind and beside it, at the ground's heights.
  const grid = (u0, u1, v0, v1) => {
    const out = [];
    for (let u = u0; u <= u1 + 1e-9; u += 0.25) for (let v = v0; v <= v1 + 1e-9; v += 0.25) out.push(brickAt(u, v));
    return out;
  };
  const outside = [
    ['terrace', grid(0, 4.98, 9.02, 11.6)],
    ['drive and path', grid(-1, 17, -8, -0.02)],
    ['garden', grid(-1, 17, 11.5, 20)],
    ['left side', grid(-4, -0.02, -1, 12)],
    ['wing side', grid(15.98, 19, -1, 12)],
  ];
  for (const [name, pts] of outside) for (const [x, z] of pts) for (const dy of [-0.4, 0, 1, 1.75]) assert.equal(homeAt(x, z, brickFloor + dy), null, `brick ${name} ${x},${z} +${dy}`);
  // Its roofs: on the main roof (from its eaves at 5.65), the flat roof at the back (3.1), the wing's (from its eaves at
  // 3.5), and a metre over each: the bands end below them.
  const roofs = [['main roof', grid(0, 11.91, 0, 9), 5.65], ['flat roof', grid(4.98, 11.67, 9, 11.47), 3.1], ['wing roof', grid(11.92, 15.96, 0, 11.47), 3.5]];
  for (const [name, pts, y] of roofs) for (const [x, z] of pts) for (const dy of [0, 0.5, 1, 30]) assert.equal(homeAt(x, z, brickFloor + y + dy), null, `brick ${name} ${x},${z} +${y + dy}`);
});

test('start places, pickups, portals and travel places are outside, at any height; the private ones are inside their home', () => {
  for (const s of spawns) assert.equal(anyHeight(s.x, s.z), null, `${s.name}: the public list holds outside places only`);
  for (const w of pickups) assert.equal(homeAt(w.x, w.z, w.y), null, `pickup ${w.where}`);
  if (HAVE_PRIVATE) {
    assert.ok(spawnsInside.length > 0 && pickupsInside.length > 0);
    for (const s of spawnsInside) assert.equal(homeAt(s.x, s.z, s.y), s.home, `inside start place of the ${s.home}`);
    for (const w of pickupsInside) assert.equal(homeAt(w.x, w.z, w.y), w.home, 'inside pickup');
  }
  for (const p of PORTALS) {
    assert.equal(anyHeight(p.out[0], p.out[1]), null, `${p.id} out`);
    assert.equal(anyHeight(p.car[0], p.car[1]), null, `${p.id} car`);
    assert.equal(anyHeight(p.x, p.z), null, p.id);
  }
  for (const p of places) assert.equal(anyHeight(p.x, p.z), null, p.id);
  for (const [x, z] of [[4.5, 19], [4.5, -6], [10.5, 6], [9.5, 2], [5, -4.5], [0.85, -9.5], [97, 172], [1519, -353]]) assert.equal(anyHeight(x, z), null, `${x},${z}`);
  assert.equal(homeAt(Infinity, 0, 0), null);
  assert.equal(homeAt(NaN, NaN, NaN), null);
});

test('every home has a portal or a spot of its own that brings you out outside it', () => {
  for (const h of HOMES) {
    const p = PORTALS.find((q) => q.id === h.id);
    assert.ok(p || h.out, h.id);
    const out = p?.out ?? h.out;
    assert.equal(anyHeight(out[0], out[1]), null, h.id);
  }
  // The brick house has no portal: its spot is on its drive, open ground inside the game's edge, a few metres in front.
  const h = findHome('kapellenhoek_home');
  assert.equal(PORTALS.some((q) => q.id === h.id), false);
  const [x, z, yaw] = h.out;
  const edge = loadBounds(read('./bounds.json'));
  assert.ok(edge.map.inside(x, z), 'inside the game\'s edge (a game whose own edge leaves it out puts you back inside that, Game.putOut)');
  const d = distanceToHome(h.id, x, z);
  assert.ok(d > 3 && d < 6, `${d.toFixed(2)} m from the house`);
  const village = JSON.parse(readFileSync(new URL('../src/data/village.json', import.meta.url), 'utf8'));
  const near = village.prisms.filter((p) => p.d === undefined && p.p?.[0]?.some(([px, pz]) => Math.hypot(px - x, pz - z) < 12));
  const blocks = makeSolids(near.filter((p) => !(p.y1 - p.y0 > 5 && inPoly(...brickAt(8, 5), p.p[0]))), (px, pz) => terrain.height(px, pz)); // not the village's own block of the house, which the walk-in replaces
  assert.ok(blocks.boxFree(x, z, 0, 0.8, 0.8, 0.1, 1.9), 'nothing within 80 cm');
  const [fx, fz] = brickAt(8, 5); // it faces the house: the camera looks along (-sin yaw, -cos yaw)
  const toHouse = Math.atan2(-(fx - x), -(fz - z));
  assert.ok(Math.abs(Math.atan2(Math.sin(yaw - toHouse), Math.cos(yaw - toHouse))) < 0.3, 'facing the house');
});

test('panes: windows by where they stand, the end house by range, door glass by its door', () => {
  const pane = makePaneHomes({ prisms: house.prisms, doors: house.doors });
  const by = { house: 0, bungalow: 0, null: 0 };
  const glass = house.prisms.filter((p) => p.m === 'glass');
  for (const p of house.prisms) {
    if (p.m === 'glass') {
      assert.ok(Number.isInteger(p.glass), 'every pane block has its number');
      assert.ok(pane.has(p.glass));
      by[pane(p.glass)] += 1;
    } else assert.equal('glass' in p, false, 'only panes carry a number');
  }
  assert.ok(by.house >= 10, JSON.stringify(by));
  assert.equal(new Set(glass.map((p) => p.glass)).size, glass.length, 'no number twice');
  // The end house: its windows and its door glass, by range.
  for (let i = WALK_IN_GLASS; i < WALK_IN_GLASS + end.panes.length; i++) assert.equal(pane(i), 'molenhoek_end');
  assert.equal(pane(END_DOOR_GLASS), 'molenhoek_end');
  assert.equal(pane(4999), 'molenhoek_end');
  // The brick house: its windows and its door glass, by range; nothing past them is a pane.
  const k = WALK_INS.kapellenhoek_home;
  assert.ok(brick.panes.length > 10 && brick.panes.length < k.size, `${brick.panes.length} windows`);
  for (let i = k.glass; i < k.glass + brick.panes.length; i++) assert.equal(pane(i), 'kapellenhoek_home');
  for (const i of [k.doorGlass, k.doorGlass + k.size - 1, k.glass + k.size - 1]) assert.equal(pane(i), 'kapellenhoek_home', String(i));
  assert.equal(PANE_LIMIT, k.doorGlass + k.size);
  assert.equal(pane(5999), null, 'the insides\' own range ends where the brick house begins');
  for (const bad of [8000, 8001, 1e9]) assert.equal(pane.has(bad), false, String(bad));
  // Door glass: the number each leaf carries, in its door's home.
  let leaves = 0;
  for (const d of house.doors) {
    for (const p of d.panels) {
      if (!p.glass) continue;
      assert.ok(Number.isInteger(p.glassNo), `${d.id} glass has a number`);
      assert.equal(pane(p.glassNo), homeOfDoor(d.id), d.id);
      leaves++;
    }
  }
  assert.ok(leaves > 0);
  for (const bad of [-1, NaN, PANE_LIMIT, 1.5, DOOR_GLASS - 1 + 0.5]) assert.equal(pane.has(bad), false, String(bad));
  assert.equal(pane(NaN), null);
});

test('the bungalow team\'s start places by the driveway are open ground inside the game\'s edge, outside its bands', () => {
  const solids = makeSolids([...house.prisms, ...(house.surroundings?.prisms ?? [])], (x, z) => terrain.height(x, z));
  const edge = loadBounds(read('./bounds.json'));
  const mine = spawns.filter((s) => s.team === 'bungalow' && s.outside);
  assert.equal(mine.length, 3);
  for (const s of mine) {
    assert.ok(solids.boxFree(s.x, s.z, 0, 0.8, 0.8, 0.1, 1.9), `${s.name}: nothing within 80 cm`);
    assert.ok(edge.party.inside(s.x, s.z) && edge.map.inside(s.x, s.z), `${s.name}: inside the edges`);
    assert.equal(s.y, house.ground + terrain.height(s.x, s.z), `${s.name}: on the ground`);
    assert.ok(distanceToHome('bungalow', s.x, s.z) > 3, `${s.name}: well outside the bungalow`);
  }
});

test('one height rule: the page\'s body overlap with the barrier equals the server\'s feet in the band', () => {
  const [STEP_UP, HEIGHT] = [0.5, 1.8]; // src/player.ts
  for (const h of HOMES) {
    for (const b of h.bands) {
      const [lo, hi] = barrierHeights(b.y0, b.y1, STEP_UP, HEIGHT);
      for (let feet = b.y0 - 3; feet <= b.y1 + 3; feet += 0.01) {
        if (Math.abs(feet - b.y0) < 1e-6 || Math.abs(feet - b.y1) < 1e-6) continue; // the exact edges
        const page = !(hi <= feet + STEP_UP || lo >= feet + HEIGHT); // World.resolve skips a block above or below the body
        assert.equal(page, feet > b.y0 && feet < b.y1, `${h.id} band ${b.y0}..${b.y1} feet ${feet.toFixed(2)}`);
      }
    }
  }
});

test('the end house\'s garden: the lawn outside the house, on the ground', () => {
  const lawn = end.lawn;
  const mine = samples(lawn.p, 0.3).filter(([x, z]) => !homeAt(x, z, floor + 1) && !inPoly(x, z, end.outline));
  assert.ok(mine.length > 30, `${mine.length} lawn points`);
  for (const [x, z] of mine) {
    assert.equal(inEndGarden(x, z, lawn.y + 0.05), true, `${x},${z}`);
    assert.equal(inEndGarden(x, z, lawn.y + 6), false, 'not in the air');
  }
  for (const [x, z] of samples(end.outline)) assert.equal(inEndGarden(x, z, floor + 0.05), false, 'the house is no garden');
  for (const [x, z] of [[1480, -330], [1520, -340], [1495, -365]]) assert.equal(inEndGarden(x, z, lawn.y), false, 'outside the fence');
  const p = PORTALS.find((q) => q.id === 'molenhoek_end');
  assert.equal(inEndGarden(p.out[0], p.out[1], lawn.y), false, 'the portal is on the street side');
});
