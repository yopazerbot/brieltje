// The Zombies horde for a big group (shared/zombies.mjs ZOMBIE.crowd...): past eight players who fight, the wave's
// size, the most up at once, the pulses and the big ones' health grow with each one more; up to eight nothing changed.
// tools/dev/horde_sim.mjs measured the numbers (a game night: up to 30 in one game, up to 20 a room in the duel).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeBounds } from './bounds.mjs';
import { aliveCap, bigOf, Horde, makeNav, waveSize, zombieStats, ZOMBIE } from './zombies.mjs';

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

const block = (x0, z0, x1, z1) => ({ m: 'wall', y0: 0, y1: 3, p: [[[x0, z0], [x1, z0], [x1, z1], [x0, z1]]] });
const edge = makeBounds([[-60, -60], [60, -60], [60, 60], [-60, 60]]);
const houses = [block(-8, 14, 8, 22), block(-8, -22, 8, -14), block(14, -8, 22, 8), block(-22, -8, -14, 8)];
const nav = makeNav({ prisms: houses, height: () => 0, edge });
const spots = nav.spawnSpots();
const players = (n) => Array.from({ length: n }, (_, i) => ({ name: `p${i}`, x: Math.sin(i) * 2.5, y: 0, z: Math.cos(i) * 2.5, alive: true, fighter: true, safe: false }));
const horde = (n, wave, seed = 1) => {
  const h = new Horde(nav, spots, { home: { x: 0, z: 0 }, rand: dice(seed), mix: (w) => dice(seed * 31 + w) });
  h.selectWave(0, wave, n);
  return h;
};

test('up to eight players the rules are as they were: the same wave sizes and the same most up at once', () => {
  for (let p = 1; p <= 8; p++) {
    assert.equal(aliveCap(p), Math.min(30, 8 + 3 * p), `${p} players: the cap`);
    for (let n = 1; n <= 30; n++) assert.equal(waveSize(n, p), Math.round((3 + 2 * n) * (0.6 + 0.4 * p)), `${p} players, wave ${n}`);
  }
  assert.equal(ZOMBIE.crowd, 8);
});

test('past eight: each one more adds as much to the wave as each of the first eight, and to the most up at once, up to crowdMax', () => {
  assert.equal(ZOMBIE.crowdWave, 0.4);
  assert.equal(waveSize(10, 30), Math.round(23 * (0.6 + 0.4 * 30)), 'thirty: as if the eight went on (290 in wave 10)');
  assert.equal(waveSize(10, 30), 290);
  assert.equal(waveSize(10, 15), 152);
  assert.deepEqual([9, 12, 15, 20, 30].map(aliveCap), [32, 36, 41, 45, 45]);
  assert.equal(ZOMBIE.crowdMax, 45, 'the most up at once for any group: what the page draws and the ticks carry (see the row in DECISIONS)');
  for (let p = 9; p <= 40; p++) {
    assert.ok(aliveCap(p) >= aliveCap(p - 1) && aliveCap(p) <= ZOMBIE.crowdMax, `${p} players`);
    assert.ok(waveSize(5, p) > waveSize(5, p - 1));
  }
});

test('past eight the pulses grow with the players and follow one another sooner, never under gapLeast', () => {
  const mean = (h) => h.pulses.reduce((s, p) => s + p.n, 0) / h.pulses.length;
  const h8 = horde(8, 3), h30 = horde(30, 3);
  assert.equal(h30.pulses.reduce((s, p) => s + p.n, 0), waveSize(3, 30));
  const want = (ZOMBIE.pulse + ZOMBIE.pulsePer * 30 + ZOMBIE.crowdPulse * 22) / (ZOMBIE.pulse + ZOMBIE.pulsePer * 8);
  assert.ok(mean(h30) / mean(h8) > want * 0.7 && mean(h30) / mean(h8) < want * 1.3, `${(mean(h30) / mean(h8)).toFixed(2)} times eight's, about ${want.toFixed(2)}`);
  const gaps = (h) => h.pulses.map((p) => p.gap);
  const quick = (1 - ZOMBIE.gapShrink * 2) / (1 + ZOMBIE.crowdGap * 22);
  for (const g of gaps(h30)) assert.ok(g >= ZOMBIE.pulseGap[0] * Math.max(ZOMBIE.gapLeast, quick) - 1e-9 && g <= ZOMBIE.pulseGap[1] * Math.max(ZOMBIE.gapLeast, quick) + 1e-9);
  for (const g of gaps(horde(30, 20))) assert.ok(g >= ZOMBIE.pulseGap[0] * ZOMBIE.gapLeast - 1e-9, 'never under gapLeast of it');
  assert.ok(horde(15, 10).pulses.every((p) => p.ways >= 1 && p.ways <= 3), 'from one to three sides');
});

test('past eight a pulse comes out crowdStagger apart, out of sight, never more up than the cap', () => {
  const h = horde(30, 6, 3);
  const ps = players(30);
  const out = [];
  let most = 0;
  for (let now = 0; now < 40_000 && h.phase === 'wave'; now += 50) {
    for (const e of h.tick(now, 0.05, ps)) if (e.type === 'spawn') out.push({ ...h.zombies.get(e.id), at: now, pulse: h.pi - (h.cur ? 0 : 1) });
    let up = 0;
    for (const z of h.zombies.values()) if (z.act !== 'down') up++;
    most = Math.max(most, up);
  }
  assert.equal(h.cap, aliveCap(30));
  assert.ok(most <= h.cap && most > 30, `${most} up at most, cap ${h.cap}`);
  const first = out.filter((z) => z.pulse === 0);
  assert.ok(first.length >= 10, `${first.length} in the first pulse`);
  const steps = first.slice(1).map((z, i) => z.at - first[i].at);
  assert.ok(steps.every((d) => d >= ZOMBIE.crowdStagger), 'no two at once');
  assert.ok(steps.filter((d) => d === ZOMBIE.crowdStagger).length >= steps.length / 2, `mostly ${ZOMBIE.crowdStagger} ms apart: ${steps.join(' ')}`);
  for (const z of out.slice(0, 20)) {
    for (const p of ps) {
      assert.ok(Math.hypot(z.x - p.x, z.z - p.z) >= ZOMBIE.spawnMin - 0.6, 'never too close');
      assert.equal(nav.clear(z.x, z.z, p.x, p.z, true), false, 'out of sight');
    }
  }
  // Eight players: the zombies of a pulse as ever, ZOMBIE.stagger apart.
  const h8 = horde(8, 6, 3);
  const at = [];
  for (let now = 0; now < 6000; now += 50) for (const e of h8.tick(now, 0.05, players(8))) if (e.type === 'spawn' && h8.pi === 0) at.push(now);
  assert.ok(at.length >= 3 && at.slice(1).every((t, i) => t - at[i] >= ZOMBIE.stagger));
});

test('past eight a big one has crowdBig more health a player: thirty take about as long to beat it as eight do', () => {
  const big = (n) => {
    const h = horde(n, 5, 2);
    h.toSpawn = 0; // only the big one of wave 5
    h.plan();
    const ps = players(n);
    for (let now = 0; now < 30_000; now += 50) {
      for (const e of h.tick(now, 0.05, ps)) if (e.type === 'spawn') return h.zombies.get(e.id);
    }
    return null;
  };
  assert.equal(bigOf(5), 1);
  const base = zombieStats(5, true).hp;
  assert.equal(big(8).hp, base, 'eight: as ever');
  assert.equal(big(30).hp, Math.round(base * (1 + ZOMBIE.crowdBig * 22)));
  assert.equal(big(30).max, big(30).hp);
  assert.ok(Math.abs(big(30).hp / 30 - base / 8) / (base / 8) < 0.05, 'the same health a gun');
});
