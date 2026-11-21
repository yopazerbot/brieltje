import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AFTER_VENT, laserPull, laserRefill, PAIR_MS, QUICK, TOLERANCE } from './laserGate.mjs';

// The laser rifle's pace on the server (server/laserGate.mjs), against the page's own gun played frame by frame
// (src/weapon.ts shoot, update, cool, reload, as they are): an honest page is never refused, with the network's jitter
// and at any frame rate; a page that skips the heat, the vent or the cell (rate abuse) fires no more than an honest one
// does over any span of time, give or take one shot.

const LASER = JSON.parse(readFileSync(new URL('../shared/weapons.json', import.meta.url), 'utf8')).laser;
const B = LASER.beam;

/** A seeded dice (the same runs every time). */
function dice(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * The page's gun, frame by frame (`frame()`: seconds), trigger pulled whenever it can fire and `gap()` s have passed since
 * the last shot; at every `quickAt`-th vent the cell is swapped (quicker, it has shots left) while it vents. Times (s).
 */
function page({ seconds, frame = () => 1 / 60, gap = () => 0, quickAt = 0, mag = LASER.mag }) {
  let t = 0, cooldown = 0, heat = 0, venting = 0, ammo = mag, reloading = 0, since = 99, vents = 0, next = 0;
  const shots = [];
  while (t < seconds) {
    const dt = frame();
    cooldown = Math.max(0, cooldown - dt); // advanceFire
    if (t >= next && cooldown <= 0 && reloading <= 0 && venting <= 0) {
      if (ammo === 0) reloading = LASER.reload;
      else {
        ammo--;
        cooldown = LASER.delay;
        since = 0;
        shots.push(t);
        heat = Math.min(1, heat + B.heat);
        if (heat >= 1) {
          venting = B.vent;
          vents++;
          if (quickAt && vents % quickAt === 0 && ammo > 0) reloading = LASER.reload * QUICK;
        }
        if (ammo === 0) reloading = LASER.reload;
        next = t + gap();
      }
    }
    // update: the reload, then cool, then the clock since the last shot
    if (reloading > 0) {
      reloading -= dt;
      if (reloading <= 0) ammo = mag;
    }
    if (venting > 0) {
      venting = Math.max(0, venting - dt);
      heat = AFTER_VENT + (1 - AFTER_VENT) * (venting / B.vent);
    } else if (heat > 0 && since >= B.wait) heat = Math.max(0, heat - B.cool * dt);
    since += dt;
    t += dt;
  }
  return shots;
}

/**
 * Each shot's messages as the server gets them (ms): the hit (with probability `hits`) before the 'shot' or after it,
 * each `base` ms on the way and up to `jitter` more, in the order sent (one socket).
 */
function arrivals(shots, { jitter, hits = 0.6, base = 40, seed = 1 }) {
  const r = dice(seed);
  const out = [];
  let last = 0;
  for (const s of shots) {
    const kinds = r() < hits ? (r() < 0.5 ? ['hit', 'shot'] : ['shot', 'hit']) : ['shot'];
    for (const kind of kinds) {
      last = Math.max(last, s * 1000 + base + r() * jitter);
      out.push({ at: last, kind });
    }
  }
  return out;
}

/**
 * Runs of each honest way. A long check by hand: LASER_SEEDS=80 runs more and prints what was refused instead of failing
 * (80 seeds, about 490 000 shots: none refused up to 60 ms of jitter, 3 at 150 ms on gaps round the cooling point).
 */
const SEEDS = Number(process.env.LASER_SEEDS) || 4;
const fresh = () =>({ weapons: new Set(['pistol', 'laser']) });
const refused = (p, msgs, cap = LASER.mag) => msgs.filter((m) => !laserPull(p, m.kind, m.at, LASER, cap)).length;

test('an honest page is never refused: firing as fast as it can, with pauses, swapping cells, any frame rate, with jitter', () => {
  const ways = [
    { name: 'flat out', gap: () => 0 },
    { name: 'flat out, a quick swap every third vent', gap: () => 0, quickAt: 3 },
    { name: 'flat out, a quick swap every vent', gap: () => 0, quickAt: 1 },
    { name: 'round the cooling point', gap: (r) => 0.25 + r() * 0.35 },
    { name: 'bursts and rests', gap: (r) => (r() < 0.15 ? 0.5 + r() * 2 : 0) },
  ];
  const frames = [() => 1 / 60, () => 1 / 30, () => 1 / 144];
  let n = 0;
  const tally = {};
  for (const way of ways) {
    for (const [fi, frame] of frames.entries()) {
      for (const jitter of [0, 60, 150]) {
        for (let seed = 1; seed <= SEEDS; seed++) {
          const r = dice(seed * 31 + fi);
          const shots = page({ seconds: 60, frame: fi === 2 ? () => 1 / 144 + r() * 0.04 : frame, gap: () => way.gap(r), quickAt: way.quickAt });
          const msgs = arrivals(shots, { jitter, seed });
          n += shots.length;
          const bad = refused(fresh(), msgs);
          if (process.env.LASER_SEEDS) {
            tally[`${way.name} j${jitter}`] = (tally[`${way.name} j${jitter}`] ?? 0) + bad;
            continue;
          }
          assert.equal(bad, 0, `${way.name}, frame ${fi}, jitter ${jitter} ms, seed ${seed}`);
        }
      }
    }
  }
  if (process.env.LASER_SEEDS) console.log('shots', n, tally);
  assert.ok(n > 10000, 'many shots tried');
});

test('the bigger cell (the Zombies ammo pack): 45 shots before a swap, honest at 45, the 46th without one refused', () => {
  const cap = Math.round(LASER.mag * 1.5);
  const shots = page({ seconds: 60, mag: cap });
  assert.equal(refused(fresh(), arrivals(shots, { jitter: 80 }), cap), 0, 'never refused with its own cell');
  // Without the bigger cell the server holds it to 30: the same page is refused at its 31st shot.
  const p = fresh();
  const msgs = arrivals(shots, { jitter: 0, hits: 0 });
  assert.ok(refused(p, msgs) > 0, 'a page claiming a bigger cell than it has');
});

/**
 * The most shots an honest page fires in any span of `ms`: flat out, swapping the cell at a vent or when empty, or
 * waiting a moment after each vent so that a shot more goes before the next; at a very high frame rate (the fastest).
 */
function honestMost() {
  const fast = () => 1 / 2000;
  const ways = [0, 1, 2, 3].map((quickAt) => ({ quickAt }));
  for (const wait of [0.13, 0.25]) ways.push({ gap: (() => { let n = 0; return () => (++n % 9 === 0 ? wait : 0); })() });
  const runs = ways.map((p) => page({ seconds: 120, frame: fast, ...p }).map((s) => s * 1000));
  return (ms) => {
    let most = 0;
    for (const t of runs) for (let i = 0, j = 0; i < t.length; i++) {
      while (j < t.length && t[j] - t[i] <= ms) j++;
      most = Math.max(most, j - i);
    }
    return most;
  };
}

test('a page that skips the heat, the vent and the cell gets no more than an honest one over any span (rate abuse)', () => {
  const most = honestMost();
  for (const [name, every] of [['tries every 10 ms', 10], ['every 175 ms (the shot clock)', 175], ['every 250 ms (the delay)', 250]]) {
    for (const kind of ['shot', 'hit']) {
      const p = fresh();
      const ok = [];
      for (let t = 0; t < 120000; t += every) if (laserPull(p, kind, t, LASER)) ok.push(t);
      for (let i = 0; i < ok.length; i++) {
        for (let j = i; j < ok.length; j += 7) {
          const span = ok[j] - ok[i];
          assert.ok(j - i + 1 <= most(span) + 1, `${name}, ${kind}s: ${j - i + 1} in ${span} ms, an honest page ${most(span)}`);
        }
      }
      // Over the two minutes: no more than the fastest honest page.
      assert.ok(ok.length <= most(120000) + 1, `${name}: ${ok.length} in two minutes, honest ${most(120000)}`);
      assert.ok(ok.length > 0.8 * most(120000), `${name}: the gun still fires at its own pace (${ok.length})`);
    }
  }
});

test('a page that times its shots to what the server gives it (a pause a vent long, the heat slack, a pause short of a swap) stays within 4% of an honest one (rate abuse)', () => {
  const most = honestMost();
  const honest = most(120000);
  const cheats = [];
  // After each vent, wait `w` ms more, then fire as soon as it lets you.
  for (const w of [0, 25, 50, 75, 100, 150]) {
    const p = fresh();
    let n = 0;
    let wait = 0;
    for (let t = 0; t < 120000; t += 5) {
      if (t < wait || !laserPull(p, 'shot', t, LASER)) continue;
      n++;
      if (p.laser.ventEnd > p.laser.v) wait = p.laser.ventEnd + w;
    }
    cheats.push([`${w} ms after each vent`, n]);
  }
  // Fire `k` shots, then pause a vent's time (less the tolerance) instead of venting; or a swap's time instead of swapping.
  for (const [k, pause] of [[8, 1000], [9, 1000], [7, 1000], [28, 1640], [20, 1640]]) {
    const p = fresh();
    let n = 0;
    let shots = 0;
    let wait = 0;
    for (let t = 0; t < 120000; t += 5) {
      if (t < wait || !laserPull(p, 'shot', t, LASER)) continue;
      n++;
      if (++shots % k === 0) wait = t + pause;
    }
    cheats.push([`${k} shots, a ${pause} ms pause`, n]);
  }
  if (process.env.LASER_SEEDS) console.log('honest', honest, cheats);
  for (const [name, n] of cheats) assert.ok(n <= honest * 1.04 + 1, `${name}: ${n} in two minutes, an honest page ${honest}`);
});

test('a cold gun fires its burst, then vents: the shot during the vent is refused, the one after it is not', () => {
  const p = fresh();
  let t = 0;
  for (let i = 0; i < 11; i++, t += 250) assert.equal(laserPull(p, 'shot', t, LASER), true, `shot ${i + 1}`);
  // The eleventh brought it to full heat at 2500 ms: it vents to 3700 ms.
  assert.equal(laserPull(p, 'shot', 2750, LASER), false, 'in the vent');
  assert.equal(laserPull(p, 'shot', 3700 - TOLERANCE - 10, LASER), false, 'still in it, past the tolerance');
  assert.equal(laserPull(p, 'shot', 3700, LASER), true, 'after it');
});

test('one pull is one shot and one hit: a second hit in it is a pull of its own, and a burst of hits is held to the gun (hit forgery)', () => {
  const p = fresh();
  assert.equal(laserPull(p, 'hit', 0, LASER), true);
  assert.equal(laserPull(p, 'shot', 1, LASER), true, 'its shot joins it');
  assert.equal(laserPull(p, 'hit', 2, LASER), false, 'a second hit is a new pull, too soon');
  assert.equal(laserPull(p, 'shot', 3, LASER), false, 'so is a second shot');
  assert.equal(laserPull(p, 'hit', 250, LASER), true, 'the next pull');
  // Nine more pulls to full heat (the eleventh vents); a hit just after the last one's window is a pull in the vent.
  for (let i = 2; i <= 10; i++) assert.equal(laserPull(p, 'shot', 250 * i, LASER), true, `pull ${i + 1}`);
  assert.equal(laserPull(p, 'hit', 2500 + PAIR_MS + 1, LASER), false, 'a late hit is not part of it');
  assert.equal(laserPull(p, 'hit', 2500 + PAIR_MS - 1, LASER), true, 'one in time is');
});

test('a new set of guns is a fresh gun; laserRefill fills the cell without a reload', () => {
  const p = fresh();
  let t = 0;
  // 30 shots at an easy pace (no vent), then the cell is empty: the next needs the reload.
  for (let i = 0; i < 30; i++, t += 600) assert.equal(laserPull(p, 'shot', t, LASER), true, `shot ${i + 1}`);
  t -= 600;
  assert.equal(laserPull(p, 'shot', t + 600, LASER), false, 'the cell is empty: no swap in 600 ms');
  laserRefill(p, LASER.mag);
  assert.equal(laserPull(p, 'shot', t + 650, LASER), true, 'filled (an ammo pack): it fires');
  p.weapons = new Set(['pistol', 'laser']); // a respawn
  for (let i = 0; i < 11; i++) assert.equal(laserPull(p, 'shot', t + 1000 + 250 * i, LASER), true, `a fresh gun, shot ${i + 1}`);
});

test('refused in silence: not a kind, not a time, no player', () => {
  const p = fresh();
  for (const kind of ['zap', '', null, undefined, 'constructor']) assert.equal(laserPull(p, kind, 0, LASER), false);
  for (const t of [NaN, Infinity, '5']) assert.equal(laserPull(p, 'shot', t, LASER), false);
  assert.equal(laserPull(null, 'shot', 0, LASER), false);
});
