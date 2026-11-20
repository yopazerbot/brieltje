// The horde's pacing in a wave (shared/zombies.mjs Horde.plan, spawn, lookout): pulses that come out at once in groups
// from two or three sides, near and out of sight, peaks and short rests, the big ones as an event, and a hurry for
// those far off and out of everyone's sight. Alone and together it is one code path; in the duel both rooms get the same.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeBounds } from './bounds.mjs';
import { bigOf, Horde, makeNav, waveSize, ZOMBIE } from './zombies.mjs';

/** mulberry32: a seeded dice */
function dice(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A block standing 3 m tall over the box x0..x1, z0..z1 (a house, as far as the zombies and the sight go). */
const block = (x0, z0, x1, z1) => ({ m: 'wall', y0: 0, y1: 3, p: [[[x0, z0], [x1, z0], [x1, z1], [x0, z1]]] });
const edge = makeBounds([[-60, -60], [60, -60], [60, 60], [-60, 60]]);
// Four houses round the middle, 14 to 22 m off, each 16 m wide: out of sight behind them, near by the way.
const houses = [block(-8, 14, 8, 22), block(-8, -22, 8, -14), block(14, -8, 22, 8), block(-22, -8, -14, 8)];
const nav = makeNav({ prisms: houses, height: () => 0, edge });
const spots = nav.spawnSpots();
const players = (n) => Array.from({ length: n }, (_, i) => ({ name: `p${i}`, x: Math.sin(i) * 1.5, y: 0, z: Math.cos(i) * 1.5, alive: true, fighter: true, safe: false }));

/** A horde in wave `wave` for `n` players; every zombie that comes out goes down at once when `beat`. */
function run(n, wave, { seed = 1, ms = 60_000, beat = false, shift = 0, extra = 0 } = {}) {
  const rand = dice(seed);
  for (let k = 0; k < extra; k++) rand();
  const h = new Horde(nav, spots, { home: { x: 0, z: 0 }, rand, mix: (w) => dice(seed * 31 + w) });
  h.selectWave(0, wave, n);
  const ps = players(n).map((p) => ({ ...p, x: p.x + shift }));
  const out = [];
  for (let now = 0; now < ms && h.phase === 'wave'; now += 50) {
    for (const e of h.tick(now, 0.05, ps)) if (e.type === 'spawn') out.push({ ...h.zombies.get(e.id), at: now, pulse: h.pi - (h.cur ? 0 : 1) });
    if (beat) for (const z of h.zombies.values()) if (z.act !== 'down') h.hit(z.id, 1e9, 'p0', now);
  }
  return { h, out };
}

test('a wave is planned as pulses: every zombie of it once, the big ones in one pulse after a rest, from a side each', () => {
  for (const [n, wave] of [[1, 1], [4, 3], [8, 5], [15, 10], [15, 15], [2, 20]]) {
    const h = new Horde(nav, spots, { home: { x: 0, z: 0 }, rand: dice(7) });
    h.selectWave(0, wave, n);
    const sum = h.pulses.reduce((s, p) => s + p.n, 0);
    assert.equal(sum, waveSize(wave, n), `${n} players, wave ${wave}: the regular ones`);
    assert.equal(h.pulses.reduce((s, p) => s + p.bigs, 0), bigOf(wave), 'the big ones');
    const bi = h.pulses.findIndex((p) => p.bigs > 0);
    if (bigOf(wave)) {
      assert.ok(bi >= 0 && h.pulses.filter((p) => p.bigs).length === 1, 'all big ones in one pulse');
      if (bi > 0) assert.equal(h.pulses[bi - 1].rest, true, 'a rest before them');
      assert.equal(h.pulses[bi].ways, Math.min(3, bigOf(wave)), 'a side each');
    } else assert.equal(bi, -1);
    for (const p of h.pulses) assert.ok(p.ways >= 1 && p.ways <= 3 && p.gap >= ZOMBIE.pulseGap[0] * ZOMBIE.gapLeast && p.gap <= ZOMBIE.pulseGap[1]);
    assert.ok(h.pulses.some((p) => p.rest), 'a rest in every wave');
  }
});

test('more players, bigger pulses: fifteen get about as many a head as four', () => {
  const size = (n, wave) => {
    const h = new Horde(nav, spots, { home: { x: 0, z: 0 }, rand: dice(3) });
    h.selectWave(0, wave, n);
    return h.pulses.reduce((s, p) => s + p.n, 0) / h.pulses.length;
  };
  assert.ok(size(1, 5) < size(4, 5) && size(4, 5) < size(15, 5));
  assert.ok(size(15, 5) / 15 > 0.35 * (size(4, 5) / 4), 'not a trickle for many');
  assert.ok(size(4, 8) > size(4, 1), 'a little bigger each wave');
});

test('a pulse comes out at once in groups, its sides a quarter turn apart round the players, out of sight and near', () => {
  const { out } = run(8, 4, { ms: 12_000 });
  assert.ok(out.length >= 6, `${out.length} out`);
  const first = out.filter((z) => z.pulse === 0);
  assert.ok(first.length >= 4, 'the first pulse');
  assert.ok(first[first.length - 1].at - first[0].at <= first.length * ZOMBIE.stagger + 1500, 'all within moments');
  for (const z of first) {
    for (const p of players(8)) {
      assert.ok(Math.hypot(z.x - p.x, z.z - p.z) >= ZOMBIE.spawnMin - 0.6, 'never too close');
      assert.equal(nav.clear(z.x, z.z, p.x, p.z, true), false, 'out of sight');
    }
  }
  // Sides: each zombie near its own group's first; the groups' firsts a quarter turn apart.
  const groups = [];
  for (const z of first) {
    const g = groups.find((q) => Math.hypot(q[0].x - z.x, q[0].z - z.z) <= ZOMBIE.groupSpread + 1);
    if (g) g.push(z);
    else groups.push([z]);
  }
  assert.ok(groups.length >= 2 && groups.length <= 3, `${groups.length} sides`);
  for (let a = 0; a < groups.length; a++) {
    for (let b = a + 1; b < groups.length; b++) {
      const [p, q] = [groups[a][0], groups[b][0]];
      const cos = (p.x * q.x + p.z * q.z) / (Math.hypot(p.x, p.z) * Math.hypot(q.x, q.z));
      assert.ok(cos <= ZOMBIE.flank + 1e-9, 'a quarter turn apart at least');
    }
  }
  // Near: by the way, behind a house, not across the field.
  const far = first.filter((z) => Math.hypot(z.x, z.z) > ZOMBIE.spawnMax + 1);
  assert.equal(far.length, 0);
});

test('a rest after a peak: nothing new while it is fought, a moment of quiet once it is beaten, then the next build-up', () => {
  const h = new Horde(nav, spots, { home: { x: 0, z: 0 }, rand: dice(5), mix: (w) => dice(50 + w) });
  h.selectWave(0, 6, 4);
  const ps = players(4);
  let restAt = -1, nextAt = -1, beatAt = -1;
  for (let now = 0; now < 120_000 && nextAt < 0; now += 50) {
    const ev = h.tick(now, 0.05, ps);
    if (restAt < 0 && h.resting) restAt = now;
    if (restAt >= 0 && now < restAt + 8000) {
      assert.ok(!ev.some((e) => e.type === 'spawn') || now === restAt, 'none while the peak stands');
    }
    if (restAt >= 0 && now === restAt + 8000) {
      // The players beat the peak.
      for (const z of h.zombies.values()) if (z.act !== 'down') h.hit(z.id, 1e9, 'p0', now);
      beatAt = now;
    }
    if (beatAt >= 0 && ev.some((e) => e.type === 'spawn')) nextAt = now;
  }
  assert.ok(restAt > 0 && beatAt > 0 && nextAt > 0, `rest ${restAt}, beaten ${beatAt}, next ${nextAt}`);
  assert.ok(nextAt - beatAt >= ZOMBIE.rest && nextAt - beatAt <= ZOMBIE.rest + 1000, `${nextAt - beatAt} ms of quiet`);
});

test('a peak that goes on too long still ends its rest after restMax', () => {
  const h = new Horde(nav, spots, { home: { x: 0, z: 0 }, rand: dice(9) });
  h.selectWave(0, 6, 4);
  h.resting = 1000 + ZOMBIE.restMax;
  for (let k = 0; k < 10; k++) h.zombies.set(900 + k, { id: 900 + k, act: 'walk', x: 50, z: 50, y: 0, node: -1 });
  h.spawn(1000, players(4), []);
  assert.ok(h.resting > 0, 'still the peak');
  h.spawn(1000 + ZOMBIE.restMax, players(4), []);
  assert.equal(h.resting, 0);
  assert.equal(h.nextSpawn, 1000 + ZOMBIE.restMax + ZOMBIE.rest);
});

test('far off and out of everyone\'s sight a zombie hurries; in sight it walks at its own pace', () => {
  const h = new Horde(nav, spots, { home: { x: 0, z: 0 }, rand: dice(2) });
  h.selectWave(0, 1, 1);
  h.toSpawn = 0;
  h.bigs = 0;
  const ps = [{ name: 'p0', x: 0, y: 0, z: 0, alive: true, fighter: true, safe: false }];
  const put = (id, x, z) => h.zombies.set(id, { id, kind: 0, x, y: 0, z, node: nav.locate(x, 0, z), yaw: 0, speed: 0, top: 0.65, hp: 50, max: 50, damage: 10, act: 'walk', actAt: 0, until: 0, struck: false, next: 0, downAt: 0, target: null });
  put(1, 0, 40); // behind the house to the north, about 40 m round it
  put(2, 30, 30); // in the open, in sight
  put(3, -40, 0); // behind the house to the west
  h.tick(0, 0.05, ps);
  assert.equal(h.zombies.get(1).hurry, true);
  assert.equal(h.zombies.get(2).hurry, false, 'in sight');
  assert.equal(h.zombies.get(3).hurry, true);
  const before = { x: h.zombies.get(1).x, z: h.zombies.get(1).z };
  for (let now = 50; now < 1000; now += 50) h.tick(now, 0.05, ps);
  const went = Math.hypot(h.zombies.get(1).x - before.x, h.zombies.get(1).z - before.z);
  assert.ok(went > 1.0, `hurried ${went.toFixed(2)} m in about a second`);
  assert.ok(went < ZOMBIE.hurry * 1.2, 'no faster than the hurry');
  const open = h.zombies.get(2);
  assert.ok(open.speed <= 0.65 * 1.01 + 0.3, 'its own pace in sight');
});

test('the duel: the same dice, the same pulses and the same zombies in the same order in both rooms', () => {
  const plan = (extra) => {
    const r = dice(42);
    for (let k = 0; k < extra; k++) r(); // the other room threw more for places
    const h = new Horde(nav, spots, { home: { x: 0, z: 0 }, rand: r, mix: (w) => dice(4242 + w) });
    h.selectWave(0, 10, 6);
    return h.pulses.map((p) => [p.n, p.bigs, p.ways, p.rest, Math.round(p.gap)]);
  };
  assert.deepEqual(plan(0), plan(17));
  // The rooms' players stand elsewhere and their places' dice went otherwise: the k-th zombie is still the same.
  const order = (opts) => run(6, 5, { seed: 11, ms: 90_000, beat: true, ...opts }).out.map((z) => [z.kind, z.top, z.hp]);
  const a = order({}), b = order({ shift: 4, extra: 5 });
  assert.equal(a.length, waveSize(5, 6) + bigOf(5));
  assert.deepEqual(a, b);
});

test('alone and together one code path: wave sizes, the cap and the breaks as before', () => {
  assert.equal(waveSize(1, 1), 5);
  assert.equal(waveSize(1, 4), 11);
  assert.equal(ZOMBIE.maxAlive, 30, 'at most 30 up: the page draws them, the wire sends them');
  const { h } = run(15, 8, { ms: 120_000 });
  let up = 0;
  for (const z of h.zombies.values()) if (z.act !== 'down') up++;
  assert.ok(up <= h.cap);
});
