// Every zombie that comes out has a way to the players (shared/zombies.mjs Horde.pick and rehome). A zombie that came out
// where the way round is longer than the distance field reaches walked at the players as the crow flies and stood
// against a building, and the wave never ended: from the lane beside the café at the church every game stalled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { arenaEdge, arenaOf, arenaSpots, portalOf, villageGround } from './arenas.mjs';
import { loadBounds } from './bounds.mjs';
import { makeChurch } from './church.mjs';
import { makeKeet } from './keet.mjs';
import { makeCafe } from './sparrenhof.mjs';
import { stallBox } from './stall.mjs';
import { makeTerrain } from './terrain.mjs';
import { Horde, makeNav, ZOMBIE } from './zombies.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const house = read('../src/data/house_shell.json');
const village = read('../src/data/village.json');
const terrain = makeTerrain(read('./terrain.json'));
const height = (x, z) => terrain.height(x, z);
const cafeData = read('./sparrenhof.json');
const cafe = makeCafe(cafeData, house.ground + height(...cafeData.origin), read('./tree_huts.json'));
const churchData = read('./church.json');
const church = makeChurch(churchData, house.ground + height(...churchData.origin));
const bounds = loadBounds(read('./bounds.json'));
const shell = read('../src/data/keet_shell.json');
const keet = makeKeet(shell, read('../src/data/keet_rooms.json'));
const { o, a } = shell.frame;
const W = (u, v) => [o[0] + u * Math.cos(a) + v * Math.sin(a), o[1] - u * Math.sin(a) + v * Math.cos(a)];

/** The place's grid as server/game.mjs zombieGround makes it. */
function grid(id) {
  const arena = arenaOf(id);
  const edge = arenaEdge(arena, bounds);
  const g = villageGround(arena, edge, village, church, cafe, keet);
  const nav = makeNav({ prisms: g.prisms, height: g.relief(height, house.ground), base: house.ground, edge, boxes: [stallBox(id)].filter(Boolean), areas: g.areas, doors: g.doors, shut: false, panes: 0 });
  return { arena, nav, doors: g.doors, spots: arenaSpots(arena, nav.spawnSpots(), village, cafe) };
}

/**
 * A fighter standing at (x, z) through waves 1 to 3 (each picked, as the admin does, after a while): every zombie that
 * comes out stands where the way from the fighter reaches, as a second grid of the same place (the judge, whose
 * fields the horde never sees) says with a field as far as the horde's goes; and no zombie stays without a way.
 */
function check(id, x, z, y) {
  const g = grid(id);
  const judge = grid(id).nav;
  const me = { name: 'p', x, y, z, alive: true, fighter: true, safe: false };
  let seed = 5;
  const doorState = new Map(g.doors.map((d) => [d.id, !!d.open]));
  const horde = new Horde(g.nav, g.spots, { home: { x: portalOf(g.arena).out[0], z: portalOf(g.arena).out[1] }, doors: g.doors, doorOpen: (k) => doorState.get(k) ?? true, rand: () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646 });
  const seedOf = horde.reachOf(me);
  assert.ok(seedOf?.ok, 'the fighter is where the zombies can get at them');
  judge.field([judge.locate(x, y, z) >= 0 ? judge.locate(x, y, z) : seedOf.node]);
  const way = (zz) => judge.distance(judge.locate(zz.x, zz.y + 0.3, zz.z, 0.6)) < Infinity;
  horde.start(0);
  let now = 0;
  const spawned = [];
  const lost = new Map();
  let worstLost = 0;
  for (const wave of [1, 2, 3]) {
    horde.selectWave(now, wave, 1);
    for (let t = 0; t < 60000; t += 50) {
      now += 50;
      for (const e of horde.tick(now, 0.05, [me])) {
        if (e.type === 'door') doorState.set(e.id, true);
        if (e.type === 'spawn') spawned.push({ wave, ok: way(horde.zombies.get(e.id)) });      }
      for (const zz of horde.zombies.values()) {
        if (zz.act === 'down' || way(zz)) lost.delete(zz.id);
        else {
          if (!lost.has(zz.id)) lost.set(zz.id, now);
          worstLost = Math.max(worstLost, now - lost.get(zz.id));
        }
      }
    }
  }
  return { spawned, worstLost };
}

test('a fighter in the lane beside the café at the church: every zombie that comes out has a way to them', () => {
  const [x, z] = W(8, 9);
  const { spawned, worstLost } = check('church', x, z, house.ground + height(x, z));
  assert.ok(spawned.length >= 15, `${spawned.length} zombies came out`);
  const none = spawned.filter((s) => !s.ok);
  assert.equal(none.length, 0, `${none.length} of ${spawned.length} came out where the way does not reach (waves ${none.map((s) => s.wave).join(' ')})`);
  assert.ok(worstLost <= ZOMBIE.lostMs + ZOMBIE.fieldEvery * 2, `a zombie went ${worstLost} ms without a way`);
});

test('the same from the café\'s toilet and from the square in front of the church', () => {
  const t1 = keet.spots.find((s) => s.name === 'toilet 1');
  const out = portalOf(arenaOf('church')).out;
  for (const [what, x, z, y] of [['toilet 1', t1.x, t1.z, keet.floor], ['the square', out[0], out[1], house.ground + height(out[0], out[1])]]) {
    const { spawned, worstLost } = check('church', x, z, y);
    assert.ok(spawned.length >= 15, `${what}: ${spawned.length} came out`);
    assert.equal(spawned.filter((s) => !s.ok).length, 0, `${what}: a zombie came out without a way`);
    assert.ok(worstLost <= ZOMBIE.lostMs + ZOMBIE.fieldEvery * 2, `${what}: a zombie went ${worstLost} ms without a way`);
  }
});
