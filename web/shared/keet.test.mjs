import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DOOR_GLASS, END_DOOR_GLASS, findHome, HOMES, homeAt, homeOfDoor, makePaneHomes, PANE_LIMIT, WALK_IN_GLASS, WALK_INS } from './homes.mjs';
import { PACK_IDS, WALK_IN_FILES } from './insideData.mjs';
import { KEET_DOOR, keetPrisms, keetRelief, makeKeet, PUBLIC_WALK_INS } from './keet.mjs';
import { arenaOf } from './arenas.mjs';
import { HAVE_PRIVATE, house, packs } from './testData.mjs';

// The café at the church is public and the homes are locked: nothing of the one may ever be taken for the other (a confused
// deputy between the public walk-in and the locked ones). Its door ids and pane numbers belong to no home, no home's are its.
const read = (name) => JSON.parse(readFileSync(new URL(`../src/data/${name}`, import.meta.url), 'utf8'));
const shell = read('keet_shell.json');
const rooms = read('keet_rooms.json');
const keet = makeKeet(shell, rooms);
const HOME_PREFIXES = ['house-out-', 'bungalow-out-', 'mh-end-', 'kh-home-'];
const inRing = (x, z, ring) => {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
};

test('the café\'s pane numbers lie in no home\'s range and under the server\'s limit', () => {
  const r = PUBLIC_WALK_INS.keet;
  const ranges = [
    ...Object.values(WALK_INS).flatMap((w) => [[w.glass, w.glass + w.size], [w.doorGlass, w.doorGlass + w.size]]),
    [WALK_IN_GLASS, WALK_IN_GLASS + 1000], [DOOR_GLASS, DOOR_GLASS + 1000], [END_DOOR_GLASS, END_DOOR_GLASS + 1000], [5000, 6000],
  ];
  for (const [a, b] of [[r.glass, r.glass + r.size], [r.doorGlass, r.doorGlass + r.size]]) {
    for (const [c, d] of ranges) assert.ok(b <= c || a >= d, `the café's ${a}..${b} overlaps ${c}..${d}`);
    assert.ok(b <= PANE_LIMIT, `${b} is over the limit ${PANE_LIMIT}`);
  }
  assert.deepEqual(keet.panes, [8000, 8001, 8002, 8003], 'its four windows, no glass in a door');
  for (let i = 7990; i < 9010; i++) assert.equal(keet.publicPane(i), keet.panes.includes(i), `pane ${i}: only the numbers that exist`);
  assert.equal(keet.publicPane('8000'), false);
});

test('every café door id is its own: none starts as a home\'s, none belongs to a home', () => {
  assert.equal(keet.doorIds.size, 8);
  for (const id of keet.doorIds) {
    assert.match(id, KEET_DOOR);
    for (const p of HOME_PREFIXES) assert.ok(!id.startsWith(p), `${id} looks like a home's door`);
    assert.equal(homeOfDoor(id), null, id);
  }
  for (const p of HOME_PREFIXES) assert.doesNotMatch(`${p}1`, KEET_DOOR);
  assert.throws(() => makeKeet(shell, { ...rooms, doors: [{ ...rooms.doors[0], id: 'kh-home-front' }] }), /not one of its own/);
});

test('nowhere in the café is a home: every room, every height, 200 points through it', () => {
  assert.equal(keet.spots.length, 7);
  for (const s of keet.spots) {
    for (let y = keet.floor; y <= keet.floor + 2.5; y += 0.25) assert.equal(homeAt(s.x, s.z, y), null, `${s.name} at ${y}`);
  }
  const { minX, maxX, minZ, maxZ } = keet.area;
  let n = 0;
  for (let k = 0; n < 200 && k < 20000; k++) {
    const x = minX + ((k * 0.6180339) % 1) * (maxX - minX);
    const z = minZ + ((k * 0.4142135) % 1) * (maxZ - minZ);
    if (!inRing(x, z, keet.outline)) continue;
    n++;
    for (const y of [keet.floor, keet.floor + 1, keet.floor + 3, keet.floor + 6]) assert.equal(homeAt(x, z, y), null, `${x} ${z} ${y}`);
  }
  assert.equal(n, 200);
});

test('the café is in no list of the homes and no home\'s pane holds its numbers', () => {
  assert.equal(findHome('keet'), null);
  assert.ok(!HOMES.some((h) => h.id === 'keet'));
  for (const list of [Object.keys(WALK_INS), PACK_IDS, Object.keys(WALK_IN_FILES)]) assert.ok(!list.includes('keet'));
  const paneHome = makePaneHomes({ prisms: house.prisms, doors: house.doors });
  for (let i = 8000; i < 9000; i++) {
    assert.equal(paneHome(i), null, `pane ${i}`);
    assert.equal(paneHome.has(i), false, `pane ${i}`);
  }
});

test('no home\'s inside has a café door id or a pane number of the café\'s', { skip: HAVE_PRIVATE ? false : 'web/.private/ is absent: this check needs the private insides' }, () => {
  for (const p of packs) {
    for (const d of p.doors) {
      assert.ok(!d.id.startsWith('keet-'), `${p.id}: ${d.id}`);
      for (const panel of d.panels ?? []) if (Number.isInteger(panel.glassNo)) assert.ok(panel.glassNo < 8000, `${p.id}: door glass ${panel.glassNo}`);
    }
    for (const b of p.prisms ?? []) if (Number.isInteger(b.glass)) assert.ok(b.glass < 8000, `${p.id}: pane ${b.glass}`);
  }
});

test('the café\'s blocks: walls and floors in the world, its windows as glass with their numbers', () => {
  const glass = keet.prisms.filter((p) => p.m === 'glass' && Number.isInteger(p.glass));
  assert.deepEqual(glass.map((p) => p.glass), keet.panes);
  for (const p of keet.prisms) for (const [x, z] of p.p[0]) assert.ok(x > keet.area.minX && x < keet.area.maxX && z > keet.area.minZ && z < keet.area.maxZ);
  const front = keet.doors.find((d) => d.id === 'keet-front');
  assert.ok(Math.abs(front.y0 - keet.floor - 0.05) < 1e-9);
  assert.ok(keet.doors.find((d) => d.id === 'keet-mid').open, 'the door to the bar room stands open at the start');
});

test('in the zombies\' grid at the church (keetPrisms): the café\'s own blocks in place of its plain ones, and nothing else', () => {
  const village = read('village.json').prisms;
  const mid = (p) => [p.p[0].reduce((t, q) => t + q[0], 0) / p.p[0].length, p.p[0].reduce((t, q) => t + q[1], 0) / p.p[0].length];
  const out = keetPrisms(village, keet);
  const gone = village.filter((p) => !out.includes(p));
  assert.ok(gone.length >= 1 && gone.every((p) => p.d === undefined && keet.contains(...mid(p))), `${gone.length} plain blocks of the café go`);
  assert.ok(village.filter((p) => p.d !== undefined && p.p[0].some(([x, z]) => keet.contains(x, z))).every((p) => out.includes(p)), 'the paving under it stays');
  assert.equal(out.length, village.length - gone.length + keet.prisms.length);
  // Its blocks as they are, but the seats: over a zombie's step (0.5 m), so they walk round the chairs.
  const seats = keet.prisms.filter((p) => !out.includes(p));
  assert.ok(seats.length >= 17 && seats.every((p) => p.m === 'c' && p.y1 - keet.floor >= 0.3 && p.y1 - keet.floor <= 0.5), `${seats.length} seats`);
  const raised = out.slice(village.length - gone.length).filter((p) => !keet.prisms.includes(p));
  assert.equal(raised.length, seats.length);
  assert.ok(raised.every((p) => p.y1 - keet.floor > 0.5 && p.y1 - keet.floor < 0.6 && p.m === 'c'));
  assert.ok(out.every((p) => !keet.contains(...mid(p)) || p.d !== undefined || p.m !== 'c' || p.y1 - keet.floor < 0.3 || p.y1 - keet.floor > 0.5), 'no seat a zombie steps on');
});

test('its relief for the zombies\' grid (keetRelief): never over the floor inside, as it was outside', () => {
  const base = -0.1;
  const height = (x, z) => 6.4 - base + (z + 720) * 0.01; // over the floor everywhere round here
  const cut = keetRelief(height, keet, base);
  for (const s of keet.spots) assert.ok(Math.abs(cut(s.x, s.z) + base - keet.floor) < 1e-9, s.name);
  for (const [x, z] of [[545, -716], [534, -716], [540, -728], [540, -705]]) assert.equal(cut(x, z), height(x, z), `${x}, ${z}`);
});

test('the church place\'s box round the café is in the café\'s own frame (shared/arenas.mjs)', () => {
  const box = arenaOf('church').also;
  const { o, a } = shell.frame;
  const at = (u, v) => [o[0] + u * Math.cos(a) + v * Math.sin(a), o[1] - u * Math.sin(a) + v * Math.cos(a)];
  const want = [at(-2.5, 2), at(10.5, 2), at(10.5, 21), at(-2.5, 21)];
  for (let i = 0; i < 4; i++) assert.ok(Math.hypot(box[i][0] - want[i][0], box[i][1] - want[i][1]) < 0.02, `${box[i]} against ${want[i]}`);
});
