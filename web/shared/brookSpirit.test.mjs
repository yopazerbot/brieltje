// The Brook Spirit's fight (shared/brookSpirit.mjs) on a fake clock with seeded dice: its place in the wood, its
// fairness rules (tells that never follow, trunks as cover, no rising next to a fighter, the window's share, the
// shells' marks, lights that stay out, health that only scales up), mending and the reset, the beaten spirit's return,
// its limits against bad input, the wire, and whole fights played by a simple scripted player with the rifle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACTS, MODES, REST, actLength, blastSpirit, clearLine, hurtSpirit, lightsOf, newSpirit, readSpirit, spiritLook,
  spiritPart, spiritView, spiritWire, stepSpirit,
} from './brookSpirit.mjs';
import { loadBounds } from './bounds.mjs';
import { trunkRadius } from './trees.mjs';
import { HOMES, distanceToHome, homeAt } from './homes.mjs';
import { makeTerrain } from './terrain.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const data = read('./brookSpirit.json');
const weapons = read('./weapons.json');
const house = read('../src/data/house_shell.json');
const bounds = loadBounds(read('./bounds.json'));
const terrain = makeTerrain(read('./terrain.json'));
const G = data.grove;
const trees = house.surroundings.trees;
/** The trunks the server passes in: the trees within the leash and `trunks.reach`. */
const TRUNKS = trees.filter((t) => Math.hypot(t.x - G.x, t.z - G.z) < data.trunks.reach).map((t) => ({ x: t.x, z: t.z, r: trunkRadius(t.h) }));
const relief = (x, z) => house.ground + terrain.height(x, z);

/** Seeded dice (mulberry32). */
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

const STEP = 50; // ms: the server's 20 a second
const fighter = (name, x, z, y = G.y) => ({ name, x, y, z });

/** A spirit on a fake clock: `run(ms, fighters)` steps it and keeps every event with its time. */
function world({ seed = 1, trunks = TRUNKS, d = data } = {}) {
  const s = newSpirit(d);
  const rand = dice(seed);
  const w = {
    s, now: 0, log: [],
    step(fighters) {
      w.now += STEP;
      const ev = stepSpirit(s, fighters, w.now, STEP / 1000, rand, trunks).map((e) => ({ ...e, now: w.now }));
      w.log.push(...ev);
      return ev;
    },
    run(ms, fighters) {
      const out = [];
      for (let t = 0; t < ms; t += STEP) out.push(...w.step(typeof fighters === 'function' ? fighters(w) : fighters));
      return out;
    },
    /** Step until `pred(event)`; the event, or null after `max` ms. */
    until(pred, fighters, max = 120000) {
      for (let t = 0; t < max; t += STEP) {
        const e = w.step(typeof fighters === 'function' ? fighters(w) : fighters).find(pred);
        if (e) return e;
      }
      return null;
    },
    hurt(who, part, damage) {
      const r = hurtSpirit(s, who, part, damage, w.now);
      for (const e of r.events) w.log.push({ ...e, now: w.now });
      return r;
    },
  };
  return w;
}

// ---- The place

const points = () => {
  const out = [['the grove', G.x, G.z, G.y], ['the rest', data.rest.x, data.rest.z, data.rest.y], ['the wake spot', data.wake.x, data.wake.z, data.wake.y], ['the sign', data.sign.x, data.sign.z, data.sign.y]];
  data.hover.forEach(([x, z, y], i) => out.push([`hover point ${i}`, x, z, y]));
  lightsOf(data).forEach((l, i) => out.push([`light ${i}`, l.x, l.z, data.lights[i].tree[2]]));
  return out;
};

test('every point is at least 9 m inside the edge of the game and outside the house games\' edge', () => {
  for (const [what, x, z] of points()) {
    assert.ok(bounds.map.depth(x, z) >= 9, `${what} is ${bounds.map.depth(x, z).toFixed(1)} m inside the edge`);
    assert.ok(bounds.party.depth(x, z) < 0, `${what} is outside the house games' edge`);
  }
});

test('nothing is inside a home, or anywhere near one', () => {
  for (const [what, x, z, y] of points()) {
    for (let up = 0; up <= 8; up += 0.5) assert.equal(homeAt(x, z, y + up), null, `${what} at ${up} m up`);
    for (const h of HOMES) assert.ok(distanceToHome(h.id, x, z) > 100, `${what} is far from ${h.id}`);
  }
});

test('the heights in the data are the relief\'s, and the trunks the trees\' own', () => {
  for (const [what, x, z, y] of points().filter(([w]) => !w.startsWith('light'))) assert.ok(Math.abs(y - relief(x, z)) < 0.05, `${what}: ${y} against ${relief(x, z).toFixed(2)}`);
  const near = trees.filter((t) => Math.hypot(t.x - G.x, t.z - G.z) < G.leash + 10);
  assert.ok(near.every((t) => Math.abs(trunkRadius(t.h) - data.trunks.r) < 1e-9), 'every trunk near is as thick as the data says');
  assert.equal(near.filter((t) => Math.hypot(t.x - G.x, t.z - G.z) < G.r).length, 15, '15 trunks in the grove');
});

test('hover points keep 3.5 m from every trunk and 2 m from the water', () => {
  const water = house.dips.filter((dip) => dip.water !== undefined);
  const inRing = (x, z, ring) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i];
      const [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    }
    return hit;
  };
  const toRing = (x, z, ring) => {
    if (inRing(x, z, ring)) return 0;
    let best = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, az] = ring[j];
      const [bx, bz] = ring[i];
      const dx = bx - ax;
      const dz = bz - az;
      const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-9)));
      best = Math.min(best, Math.hypot(x - ax - dx * u, z - az - dz * u));
    }
    return best;
  };
  data.hover.forEach(([x, z], i) => {
    for (const t of trees) assert.ok(Math.hypot(t.x - x, t.z - z) - trunkRadius(t.h) >= 3.5, `hover point ${i} is 3.5 m from the trunk at ${t.x},${t.z}`);
    for (const dip of water) assert.ok(toRing(x, z, dip.rim) >= 2, `hover point ${i} is 2 m from the water's edge`);
  });
  // The rest hangs over the brook itself.
  assert.ok(water.some((dip) => inRing(data.rest.x, data.rest.z, dip.rim)), 'the rest is over the brook');
});

test('each light hangs 1 m from a real tree, towards the grove\'s middle, at its own height', () => {
  const heights = [3.2, 4.5, 3.0, 5.5, 3.6, 4.8, 3.0, 5.0];
  const lights = lightsOf(data);
  assert.equal(lights.length, 8);
  data.lights.forEach((l, i) => {
    const [x, z, y] = l.tree;
    const tree = trees.find((t) => Math.abs(t.x - x) < 0.01 && Math.abs(t.z - z) < 0.01);
    assert.ok(tree, `light ${i}'s tree is a tree of the ring`);
    assert.ok(Math.abs(tree.y - y) < 0.01, `light ${i}'s tree's foot`);
    assert.ok(Math.abs(Math.hypot(lights[i].x - x, lights[i].z - z) - 1) < 1e-9, `light ${i} 1 m from its trunk`);
    assert.ok(Math.hypot(lights[i].x - G.x, lights[i].z - G.z) < Math.hypot(x - G.x, z - G.z), `light ${i} on the grove's side`);
    assert.equal(l.up, heights[i]);
    assert.ok(Math.abs(lights[i].y - (y + heights[i])) < 1e-9);
  });
});

test('the links between hover points keep 1.2 m clear of every trunk, and every point but the far bank is linked', () => {
  const clearance = (a, b) => {
    let best = Infinity;
    for (const t of trees) {
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const u = Math.max(0, Math.min(1, ((t.x - a[0]) * dx + (t.z - a[1]) * dz) / (dx * dx + dz * dz)));
      best = Math.min(best, Math.hypot(t.x - a[0] - dx * u, t.z - a[1] - dz * u) - trunkRadius(t.h));
    }
    return best;
  };
  const at = (n) => (n === REST ? [data.rest.x, data.rest.z] : data.hover[n]);
  for (const [a, b] of data.links) assert.ok(clearance(at(a), at(b)) >= data.trunks.clear, `link ${a}-${b}: ${clearance(at(a), at(b)).toFixed(2)} m`);
  for (const b of data.rest.links) assert.ok(clearance(at(REST), at(b)) >= data.trunks.clear, `rest-${b}`);
  // Every link that is clear is listed (none left out), the far bank (5) has none.
  for (let a = 0; a < 7; a++) {
    for (let b = a + 1; b < 7; b++) {
      const listed = data.links.some(([p, q]) => (p === a && q === b) || (p === b && q === a));
      if (a !== 5 && b !== 5) assert.equal(listed, clearance(at(a), at(b)) >= data.trunks.clear, `link ${a}-${b}`);
      else assert.ok(!listed, 'the far bank is reached only by sinking');
    }
  }
  // From the rest, every hover point but the far bank can be drifted to.
  const seen = new Set([REST]);
  const todo = [REST];
  while (todo.length) {
    const n = todo.pop();
    const next = n === REST ? data.rest.links : data.links.flatMap(([p, q]) => (p === n ? [q] : q === n ? [p] : [])).concat(data.rest.links.includes(n) ? [REST] : []);
    for (const m of next) if (!seen.has(m)) seen.add(m) && todo.push(m);
  }
  assert.deepEqual([...seen].filter((n) => n !== REST).sort(), [0, 1, 2, 3, 4, 6]);
});

test('the lane does not wake it, and a downed fighter comes back outside the fight', () => {
  // An armed walker on the lane passes 21 m from the middle.
  assert.ok(G.wakeR < 21);
  assert.ok(Math.hypot(data.sign.x - G.x, data.sign.z - G.z) > G.wakeR, 'the sign stands outside the wake radius');
  assert.ok(Math.hypot(data.wake.x - G.x, data.wake.z - G.z) > G.leash, 'the wake spot is outside the leash');
  for (const [x, z] of data.hover) assert.ok(Math.hypot(x - G.x, z - G.z) <= G.r, 'hover points inside the grove');
});

// ---- Waking

test('it sleeps until a fighter comes within the wake radius, and only fighters within the leash count', () => {
  const w = world();
  assert.equal(w.run(10000, [fighter('lane', G.x + 21, G.z)]).length, 0, 'nothing for a walker on the lane');
  assert.equal(w.s.mode, 'asleep');
  assert.equal(w.hurt('lane', 0, 26).why, 'mode', 'asleep it takes nothing');
  const e = w.until((e) => e.type === 'wake', [fighter('a', G.x + 16, G.z)], 1000);
  assert.ok(e, 'wakes for a fighter 16 m from the middle');
  assert.equal(w.s.mode, 'fight');
  w.step([fighter('a', G.x + 16, G.z), fighter('far', G.x + 31, G.z)]);
  assert.ok(!w.s.near.has('far'), 'past the leash: no fighter');
  assert.equal(w.hurt('far', 0, 26).why, 'who');
  assert.equal(w.hurt('villager', 0, 26).why, 'who', 'nobody but the fighters it was given');
});

// ---- Fairness

test('a bolt\'s tell fixes where it lands when it starts, and never follows', () => {
  const w = world({ trunks: [] });
  const me = fighter('a', -66, 488); // 14 m from the rest: a bolt
  const tell = w.until((e) => e.type === 'tell', [me]);
  assert.equal(tell.kind, 'bolt');
  assert.deepEqual([tell.x, tell.z], [me.x, me.z]);
  // Running sideways during the tell: the bolt still flies at where it was.
  let z = me.z;
  const bolt = w.until((e) => e.type === 'bolt', () => fighter('a', me.x, (z += 0.175)));
  assert.deepEqual([bolt.to.x, bolt.to.z], [me.x, me.z]);
  assert.ok(bolt.ms >= Math.round((14.2 / 14 + 0.4) * 1000) - 50, 'it takes its flight time');
  // Out of its circle by the landing: nothing.
  const hits = w.run(bolt.ms + 100, [fighter('a', me.x, me.z + 3.2)]).filter((e) => e.type === 'hit');
  assert.equal(hits.length, 0);
});

test('a bolt that lands on you hurts most in the middle, 30 % at the edge', () => {
  const w = world({ trunks: [] });
  const me = fighter('a', -66, 488);
  w.until((e) => e.type === 'tell', [me]);
  const bolt = w.until((e) => e.type === 'bolt', [me]);
  const hit = w.until((e) => e.type === 'hit', [me], bolt.ms + 200);
  assert.equal(hit.damage, data.attacks.bolt.damage);
  assert.equal(hit.kind, 'bolt');
  // At 2.9 m: a little.
  const w2 = world({ trunks: [] });
  w2.until((e) => e.type === 'tell', [me]);
  const b2 = w2.until((e) => e.type === 'bolt', [me]);
  const h2 = w2.until((e) => e.type === 'hit', [fighter('a', me.x, me.z + 2.9)], b2.ms + 200);
  assert.ok(h2.damage < 14 && h2.damage >= Math.round(35 * 0.3), `${h2.damage} at the edge`);
});

test('a sweep\'s strip is fixed when its tell starts, a step aside dodges it, and a trunk between spares you', () => {
  const rest = data.rest;
  // A at 5 m east of the rest (the nearest: the target); B 8 m east, in the strip, with a trunk between.
  const trunk = { x: rest.x + 6.5, z: rest.z, r: 0.35 };
  const w = world({ trunks: [trunk] });
  const A = fighter('A', rest.x + 5, rest.z);
  const B = fighter('B', rest.x + 8, rest.z);
  const tell = w.until((e) => e.type === 'tell', [A, B]);
  assert.equal(tell.kind, 'sweep');
  assert.equal(tell.target, 'A');
  assert.ok(Math.abs(tell.x - (rest.x + data.attacks.sweep.length)) < 0.01 && Math.abs(tell.z - rest.z) < 0.01, 'the strip runs 11 m towards A');
  const sweep = w.until((e) => e.type === 'sweep', [A, B]);
  assert.deepEqual(sweep.to, { x: tell.x, z: tell.z });
  assert.deepEqual(sweep.hits, ['A'], 'B behind the trunk is spared');
  assert.equal(w.log.find((e) => e.type === 'hit').damage, data.attacks.sweep.damage[0]);
  // Next time A steps 1.5 m aside during the tell (walking pace does it in the 1.1 s): spared, though the spirit could follow.
  const w2 = world({ trunks: [] });
  const t2 = w2.until((e) => e.type === 'tell', [A]);
  assert.equal(t2.kind, 'sweep');
  let side = 0;
  const s2 = w2.until((e) => e.type === 'sweep', () => fighter('A', A.x, A.z + (side = Math.min(1.5, side + 0.07))));
  assert.deepEqual(s2.hits, []);
  assert.deepEqual(s2.to, { x: t2.x, z: t2.z }, 'the strip never turned after A');
});

test('a bolt needs a clear line when its tell starts: behind a trunk it casts pools (phase 2) or moves on (phase 1)', () => {
  const rest = data.rest;
  const me = fighter('a', rest.x + 14, rest.z);
  const trunk = { x: rest.x + 7, z: rest.z, r: 0.35 };
  // Phase 1: no bolt from the rest; it drifts away to see past the trunk.
  const w = world({ trunks: [trunk] });
  w.run(1000, [me]);
  assert.equal(w.s.act, 'drift', 'no bolt through the trunk: it drifts away');
  const first = w.until((e) => e.type === 'tell', [me], 20000);
  assert.equal(first.kind, 'bolt');
  assert.notEqual(w.s.node, REST, 'from somewhere it sees past the trunk');
  assert.ok(clearLine(w.s.x, w.s.z, me.x, me.z, [trunk]));
  // Phase 2, the same: pools instead (they ignore the trunks).
  const w2 = world({ trunks: [trunk] });
  w2.step([me]);
  w2.s.phase = 2;
  const tell = w2.until((e) => e.type === 'tell', [me], 2000);
  assert.equal(tell.kind, 'pool');
  assert.deepEqual([tell.x, tell.z], [me.x, me.z]);
  // Every bolt in whole fights had a clear line from where the spirit was to its target when its tell began.
  for (let seed = 1; seed <= 4; seed++) {
    const r = scriptedFight(seed, 2);
    assert.ok(r.boltTells > 0);
    assert.equal(r.boltsThroughTrunks, 0, `seed ${seed}`);
  }
});

test('pools: from phase 2, 3.5 m, 8 every half second inside, 6 at most, and they fade after 6 s', () => {
  const w = world({ trunks: [] });
  // Woken, then 40 m from the spirit at its rest: too far for a bolt, so pools.
  w.step([fighter('a', -66, 488)]);
  w.s.phase = 2;
  const me = fighter('a', data.rest.x + 40, data.rest.z);
  const tell = w.until((e) => e.type === 'tell', [me], 3000);
  assert.equal(tell.kind, 'pool');
  // The tell fixes it: walk away, and come back into it once it is there.
  const pool = w.until((e) => e.type === 'pool', [fighter('a', me.x + 6, me.z)], 2000);
  assert.deepEqual([pool.x, pool.z], [me.x, me.z]);
  const inside = fighter('a', me.x - 3, me.z);
  const hits = w.run(2000, [inside]).filter((e) => e.type === 'hit');
  assert.equal(hits.length, 4, 'four stings in 2 s');
  assert.ok(hits.every((h) => h.damage === 8 && h.kind === 'pool'));
  assert.equal(w.run(1500, [fighter('a', me.x - 3.6, me.z)]).filter((e) => e.type === 'hit' && e.kind === 'pool' && Math.hypot(e.x - pool.x, e.z - pool.z) < 0.01).length, 0, 'outside it: nothing');
  w.run(4000, [me]);
  assert.ok(!w.s.pools.some((p) => p.x === pool.x && p.z === pool.z && p.from === pool.now), 'gone after 6 s');
  // Never more than 6, wherever you stand.
  const w3 = world({ trunks: [] });
  w3.step([fighter('a', -66, 488)]);
  w3.s.phase = 3;
  let most = 0;
  w3.run(120000, (x) => {
    most = Math.max(most, x.s.pools.length);
    return [fighter('a', data.rest.x + 40 - ((x.now / 1500) % 8), data.rest.z + 4)];
  });
  assert.ok(most <= data.attacks.pools.most, `${most} pools at once`);
});

test('it never rises within 8 m of a fighter, and stays under while every point has one close by', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const r = scriptedFight(seed, 3);
    assert.ok(r.rises > 0, `seed ${seed} rose somewhere`);
    assert.equal(r.risesNear, 0, `seed ${seed}`);
  }
  // Fighters standing 2 m from every hover point but one: it rises there.
  const w = world({ trunks: [] });
  const on = (skip) => data.hover.filter((_, i) => i !== skip).map(([x, z], i) => fighter(`f${i}`, x + 2, z));
  w.step(on(2));
  w.s.phase = 3;
  w.s.act = 'under';
  w.s.until = w.now;
  const rise = w.until((e) => e.type === 'rise', on(2), 2000);
  assert.deepEqual([rise.x, rise.z], [data.hover[2][0], data.hover[2][1]]);
  // Every point taken: it waits under, then rises where one has gone.
  const all = data.hover.map(([x, z], i) => fighter(`f${i}`, x + 2, z));
  w.s.act = 'under';
  w.s.until = w.now;
  w.s.node = 2;
  assert.equal(w.run(3000, all).filter((e) => e.type === 'rise').length, 0);
  assert.equal(w.s.act, 'under');
  const back = w.until((e) => e.type === 'rise', all.filter((f) => f.name !== 'f4'), 1000);
  assert.deepEqual([back.x, back.z], [data.hover[4][0], data.hover[4][1]]);
});

test('one window never takes more than its share, the stun after a burst a little more', () => {
  const w = world({ trunks: [] });
  const me = fighter('a', -66, 488);
  w.until((e) => e.type === 'open', [me]);
  const share = Math.round(data.cap.window * w.s.max);
  let dealt = 0;
  for (let k = 0; k < 40; k++) dealt += w.hurt('a', 0, 100).dealt;
  assert.equal(dealt, share, `${dealt} of ${share}`);
  assert.equal(w.log.filter((e) => e.type === 'cap').length, 1, 'it says so once');
  assert.equal(w.s.act, 'pause', 'and folds shut');
  assert.equal(w.hurt('a', 0, 26).dealt, 0);
  // A window that ends on time takes hits a moment longer (shots on their way), then nothing.
  const next = w.until((e) => e.type === 'open', [me]);
  assert.ok(next);
  w.hurt('a', 0, 26);
  w.until((e) => e.type === 'close', [me]);
  assert.equal(w.hurt('a', 0, 26).dealt, 26, 'within the grace');
  w.run(200, [me]);
  assert.equal(w.hurt('a', 0, 26).why, 'shut', 'after it');
  // The stun after the first burst: 15 %.
  const w2 = world({ trunks: [] });
  w2.until((e) => e.type === 'open', [me]);
  w2.s.hp = Math.round(0.67 * w2.s.max);
  w2.hurt('a', 0, 100);
  assert.equal(w2.s.shell, 0);
  for (const i of w2.s.draw[0]) w2.hurt('a', i + 1, 100);
  assert.equal(w2.s.act, 'stun');
  const before = w2.s.hp;
  for (let k = 0; k < 40; k++) w2.hurt('a', 0, 100);
  assert.equal(before - w2.s.hp, Math.round(data.cap.stun * w2.s.max));
});

test('health stops at 66 % and 33 % until the lights are out; then the shell bursts and the next phase begins', () => {
  const w = world({ trunks: [] });
  const me = fighter('a', -66, 488);
  w.until((e) => e.type === 'open', [me]);
  w.s.hp = Math.round(0.7 * w.s.max);
  const r = w.hurt('a', 0, 200);
  assert.equal(w.s.hp, Math.round(0.66 * w.s.max), 'stops at the mark');
  assert.equal(r.dealt, Math.round(0.7 * w.s.max) - Math.round(0.66 * w.s.max));
  const shell = r.events.find((e) => e.type === 'shell');
  assert.equal(shell.lights.length, 3);
  assert.equal(r.events.filter((e) => e.type === 'light').length, 3);
  assert.equal(w.hurt('a', 0, 26).why, 'shut', 'the heart is shut in the shell');
  assert.equal(spiritPart(w.s, 0, w.now), null);
  // It keeps casting, and opens no window while the shell is up.
  const during = w.run(30000, [me]);
  assert.ok(during.some((e) => e.type === 'tell'));
  assert.ok(!during.some((e) => e.type === 'open'));
  assert.equal(w.s.hp, Math.round(0.66 * w.s.max));
  // Each light takes 60.
  const [l0, l1, l2] = shell.lights;
  assert.equal(w.hurt('a', l0 + 1, 26).dealt, 26);
  assert.equal(w.hurt('a', l0 + 1, 100).dealt, 34);
  assert.equal(w.hurt('a', l1 + 1, 60).events[0].type, 'out');
  const last = w.hurt('a', l2 + 1, 60);
  assert.deepEqual(last.events.map((e) => e.type), ['out', 'burst', 'phase']);
  assert.equal(w.s.phase, 2);
  assert.equal(w.s.act, 'stun');
  assert.ok(spiritPart(w.s, 0, w.now));
  // The second mark the same way, with the other five lights.
  w.s.hp = Math.round(0.34 * w.s.max);
  const r2 = w.hurt('a', 0, 200);
  assert.equal(w.s.hp, Math.round(0.33 * w.s.max));
  assert.equal(r2.events.find((e) => e.type === 'shell').lights.length, 5);
});

test('lights that are out never light again: the second shell lights the other five', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const w = world({ seed, trunks: [] });
    const me = fighter('a', -66, 488);
    w.until((e) => e.type === 'open', [me]);
    w.s.hp = Math.round(0.67 * w.s.max);
    const first = w.hurt('a', 0, 100).events.find((e) => e.type === 'shell').lights;
    w.hurt('a', first[0] + 1, 60);
    w.run(60000, [me]);
    assert.ok(!w.s.lights[first[0]].lit, 'still out a minute later');
    assert.equal(w.hurt('a', first[0] + 1, 60).why, 'out');
    for (const i of first.slice(1)) w.hurt('a', i + 1, 60);
    w.s.hp = Math.round(0.34 * w.s.max);
    w.s.act = 'open';
    w.s.until = w.now + 4000;
    w.s.budget = 1000;
    const second = w.hurt('a', 0, 100).events.find((e) => e.type === 'shell').lights;
    assert.deepEqual([...first, ...second].sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
  }
});

test('its full health follows the fighters counted, only ever upwards', () => {
  const w = world({ trunks: [] });
  const a = fighter('a', -66, 488);
  const b = fighter('b', -64, 490);
  w.step([a]);
  assert.equal(w.s.max, 2400);
  w.step([a, b]);
  assert.equal(w.s.max, 3800);
  w.step([a]);
  w.run(1000, [a]);
  assert.equal(w.s.max, 3800, 'b leaving takes nothing off');
  w.step([a, b]);
  assert.equal(w.s.max, 3800, 'nor does b coming back count twice');
  const many = Array.from({ length: 12 }, (_, i) => fighter(`p${i}`, -66 + (i % 4), 488 + Math.floor(i / 4)));
  w.step(many);
  assert.equal(w.s.max, 2400 + 1400 * 7, 'at most 8 counted: 12 200');
  // Health keeps its share when it grows.
  const w2 = world({ trunks: [] });
  w2.until((e) => e.type === 'open', [a]);
  w2.hurt('a', 0, 240);
  w2.step([a, b]);
  assert.equal(w2.s.hp, Math.round((2160 / 2400) * 3800));
});

test('alone for 8 s it goes back over the brook and mends; a heart hit stops it; 45 s alone and it is new and asleep', () => {
  const w = world({ trunks: [] });
  const me = fighter('a', -66, 488);
  w.until((e) => e.type === 'open', [me]);
  w.hurt('a', 0, 200);
  const hp = w.s.hp;
  // Nobody for 8 s: mending.
  const mend = w.until((e) => e.type === 'mend', [], 9000);
  assert.ok(mend && mend.now - w.log.find((e) => e.type === 'open').now >= 8000);
  // Along the links (only one reaches the rest): up to half a minute.
  for (let t = 0; t < 30000 && w.s.act === 'drift'; t += STEP) w.step([]);
  assert.deepEqual([w.s.x, w.s.z], [data.rest.x, data.rest.z], 'over the brook');
  w.run(500, []);
  assert.ok(w.s.hp > hp, 'healing');
  // Healing 3 % a second.
  const h0 = w.s.hp;
  w.run(1000, []);
  assert.ok(Math.abs(w.s.hp - h0 - 0.03 * w.s.max) < 1);
  // A fighter comes back and hits its heart: the fight goes on.
  w.step([me]);
  assert.ok(spiritPart(w.s, 0, w.now), 'the heart takes hits while it mends');
  assert.ok(w.hurt('a', 0, 26).dealt === 26);
  assert.equal(w.s.mode, 'fight');
  // Alone again: after 45 s with nobody, a full reset, asleep.
  const reset = w.until((e) => e.type === 'reset', [], 46000);
  assert.ok(reset);
  assert.equal(w.s.mode, 'asleep');
  assert.equal(w.s.hp, w.s.max);
  assert.equal(w.s.max, 2400);
  assert.ok(w.s.lights.every((l) => !l.lit && !l.used));
  // Mended full while a fighter only watches (no damage for 25 s): reset too.
  const w2 = world({ trunks: [] });
  w2.until((e) => e.type === 'open', [me]);
  w2.hurt('a', 0, 100);
  const m2 = w2.until((e) => e.type === 'mend', [me], 30000);
  assert.ok(m2.now - w2.log.find((e) => e.type === 'open').now >= 25000, 'after 25 s without damage');
  assert.ok(w2.until((e) => e.type === 'reset', [me], 60000), 'full health: as new');
});

test('beaten, it comes apart harmless and gathers again after the return time', () => {
  const w = world({ trunks: [] });
  const me = fighter('a', -66, 488);
  w.until((e) => e.type === 'open', [me]);
  Object.assign(w.s, { phase: 3, shells: 2, hp: 50 });
  w.hurt('b', 0, 26); // not a fighter
  const r = w.hurt('a', 0, 100);
  assert.equal(r.dealt, 50);
  const beaten = r.events.find((e) => e.type === 'beaten');
  assert.deepEqual(beaten.names, ['a']);
  assert.deepEqual(beaten.by, ['a']);
  assert.ok(data.hover.some(([x, z]) => x === beaten.drop.x && z === beaten.drop.z), 'the launcher drops at a hover point');
  assert.equal(w.s.mode, 'apart');
  const harmless = w.run(data.beaten.apart * 1000 + 100, [me]);
  assert.equal(harmless.filter((e) => e.type === 'hit' || e.type === 'tell').length, 0);
  assert.equal(w.s.mode, 'gone');
  assert.equal(w.hurt('a', 0, 26).why, 'mode');
  assert.equal(blastSpirit(w.s, w.s.x, w.s.y, w.s.z, 4.5, 130, 'a', w.now).dealt, 0);
  assert.equal(w.run(data.beaten.back * 1000 - 500, [me]).length, 0, 'gone for 10 minutes');
  const back = w.until((e) => e.type === 'back', [me], 1000);
  assert.ok(back);
  assert.equal(w.s.mode, 'asleep');
  assert.equal(w.s.hp, 2400);
  assert.ok(w.until((e) => e.type === 'wake', [me], 200), 'and wakes again');
});

// ---- Its own limits

test('hurtSpirit and blastSpirit refuse bad input, never throw, and hold the window\'s share', () => {
  const w = world({ trunks: [] });
  const me = fighter('a', -66, 488);
  w.until((e) => e.type === 'open', [me]);
  const bad = [
    ['a', 0, NaN], ['a', 0, Infinity], ['a', 0, -26], ['a', 0, 0], ['a', 0, '26'], ['a', 0, null], ['a', 0, {}],
    ['a', -1, 26], ['a', 9, 26], ['a', 1.5, 26], ['a', '0', 26], ['a', NaN, 26], ['a', null, 26],
    [null, 0, 26], [7, 0, 26], [{}, 0, 26], ['__proto__', 0, 26], ['b', 0, 26],
  ];
  for (const [who, part, damage] of bad) assert.equal(hurtSpirit(w.s, who, part, damage, w.now).dealt, 0, `${String(who)} ${String(part)} ${String(damage)}`);
  assert.equal(hurtSpirit(w.s, 'a', 0, 26, NaN).dealt, 0);
  assert.equal(hurtSpirit(null, 'a', 0, 26, w.now).dealt, 0);
  assert.equal(hurtSpirit(w.s, 'a', 2, 26, w.now).why, 'out', 'a light that is not lit counts nothing');
  assert.equal(hurtSpirit(w.s, 'a', 0, 1e12, w.now).dealt, Math.round(data.cap.window * w.s.max), 'a huge hit takes the share, no more');
  // Blasts.
  const w2 = world({ trunks: [] });
  w2.until((e) => e.type === 'open', [me]);
  for (const args of [[NaN, 0, 0, 4.5, 130], [0, 0, 0, NaN, 130], [0, 0, 0, 4.5, Infinity], [0, 0, 0, -1, 130], ['1', 0, 0, 4.5, 130]]) {
    assert.equal(blastSpirit(w2.s, ...args, 'a', w2.now).dealt, 0);
  }
  assert.equal(blastSpirit(w2.s, w2.s.x + 20, w2.s.y, w2.s.z, 1e6, 130, 'a', w2.now).dealt, 0, 'a blast reaches no further than heart.blast');
  assert.equal(blastSpirit(w2.s, w2.s.x, w2.s.y, w2.s.z, 4.5, 130, 'nobody', w2.now).dealt, 0);
  const b = blastSpirit(w2.s, w2.s.x + 1, w2.s.y, w2.s.z, 4.5, 130, 'a', w2.now);
  assert.equal(b.dealt, Math.round(130 * (1 - (0.7 * 1) / 4.5)));
  assert.deepEqual(b.parts, [[0, b.dealt]]);
  // A step with rubbish in it.
  assert.doesNotThrow(() => stepSpirit(w2.s, [null, {}, { name: 'x', x: NaN, y: 0, z: 0 }, { name: 5, x: -66, y: 0, z: 488 }, 'a'], w2.now + 50, 0.05, () => NaN, [null, { x: 'a' }]));
  assert.doesNotThrow(() => stepSpirit(w2.s, 'nobody', NaN, NaN));
  assert.doesNotThrow(() => stepSpirit(w2.s, [me], w2.now + 100, 0.05, () => 7, [{ x: -70, z: 488, r: 0.35 }]));
});

// ---- The wire and the look

test('the wire carries what the look needs, and readSpirit refuses anything else', () => {
  const w = world({ trunks: [] });
  const me = fighter('a', -66, 488);
  const seen = new Set();
  w.run(60000, (x) => {
    const m = spiritWire(x.s, x.now);
    const v = readSpirit(JSON.parse(JSON.stringify(m)), x.now);
    assert.ok(v, JSON.stringify(m));
    const live = spiritView(x.s, x.now);
    assert.equal(v.mode, live.mode);
    assert.equal(v.act, live.act);
    assert.ok(Math.abs(v.x - live.x) <= 0.005 && Math.abs(v.z - live.z) <= 0.005);
    assert.ok(Math.abs(v.hp - live.hp) <= 0.0006);
    assert.equal(v.lights, live.lights);
    seen.add(v.act);
    return [me];
  });
  assert.ok(seen.has('open') && seen.has('bolt'));
  const good = spiritWire(w.s, w.now);
  const broken = [
    null, 'sp', {}, { s: [] }, { s: good.s.slice(0, 10) }, { s: [...good.s.slice(0, 10), 256] }, { s: [9, ...good.s.slice(1)] },
    { s: [0, 4, ...good.s.slice(2)] }, { s: [0, 1, 1001, ...good.s.slice(3)] }, { s: good.s.map((v, i) => (i === 3 ? NaN : v)) },
    { s: good.s.map((v, i) => (i === 6 ? 11 : v)) }, { s: good.s.map((v, i) => (i === 7 ? -1 : v)) }, { s: good.s.map((v, i) => (i === 4 ? '1' : v)) },
    { s: good.s, p: 'x' }, { s: good.s, p: Array.from({ length: 9 }, () => [0, 0, 0]) }, { s: good.s, p: [[0, 0]] }, { s: good.s, p: [[0, 0, -5]] },
  ];
  for (const m of broken) assert.equal(readSpirit(m, 0), null, JSON.stringify(m));
  assert.equal(MODES.length, 5);
  assert.equal(ACTS.length, 11);
});

test('the look: the heart opens in 0.3 s, the shell shuts, it fades sinking and rising, tells show where they land', () => {
  const base = { mode: 'fight', phase: 1, hp: 1, x: -68, y: -6.6, z: 486, tx: -60, tz: 486, lights: 0, pools: [], hurtAt: -Infinity, at: 0 };
  const at = (act, t, extra = {}) => {
    const v = { ...base, ...extra, act };
    v.ms = Math.max(0, actLength(data, v) * 1000 - t);
    return spiritLook(v, 0, data);
  };
  assert.equal(at('idle', 0).open, 0);
  assert.ok(Math.abs(at('open', 150).open - 0.5) < 1e-9);
  assert.ok(at('open', 300).open > 0.999999);
  assert.ok(at('pause', 150).open < 1 && at('pause', 300).open < 1e-6, 'folds again after the window');
  assert.equal(at('idle', 0, { mode: 'mend' }).open, data.mend.open);
  assert.equal(at('idle', 0, { lights: 0b101 }).shield, 1);
  assert.equal(at('pause', 0, { lights: 0b101 }).open, 0, 'in the shell the heart stays shut');
  assert.ok(Math.abs(at('stun', 200).shield - 0.5) < 1e-9 && at('stun', 400).shield === 0);
  assert.ok(Math.abs(at('sink', 500).fade - 0.5) < 1e-9);
  assert.equal(at('under', 0).fade, 1);
  assert.ok(Math.abs(at('rise', 650).fade - 0.5) < 1e-9);
  assert.equal(at('idle', 0, { mode: 'gone' }).fade, 1);
  assert.ok(Math.abs(at('idle', 1500, { mode: 'apart' }).fade - 0.5) < 1e-9);
  assert.deepEqual(at('bolt', 0).reach, { x: -60, z: 486 });
  assert.equal(at('open', 0).reach, null);
  assert.equal(at('idle', 0, { mode: 'asleep' }).anger, 0);
  assert.ok(Math.abs(at('sweep', 0, { phase: 3 }).anger - 1.0) < 1e-9);
  assert.ok(Math.abs(at('idle', 0).facing - Math.PI / 2) < 1e-9, 'faces where it looks');
  const pulse = spiritLook({ ...base, act: 'open', ms: 1000, hurtAt: -100 }, 0, data);
  assert.ok(pulse.hurt > 0 && pulse.hurt < 1);
});

// ---- The same for the same inputs and dice

test('the same inputs and dice give the same fight', () => {
  const a = scriptedFight(11, 2, { keep: true });
  const b = scriptedFight(11, 2, { keep: true });
  assert.ok(a.log.length > 100);
  assert.equal(JSON.stringify(a.log), JSON.stringify(b.log));
  assert.equal(JSON.stringify(a.wire), JSON.stringify(b.wire));
  const c = scriptedFight(12, 2, { keep: true });
  assert.notEqual(JSON.stringify(a.log), JSON.stringify(c.log), 'other dice, another fight');
});

// ---- Whole fights

/** How far (x, z) is from the nearest link (the rest's too). */
function offLink(x, z) {
  const at = (n) => (n === REST ? [data.rest.x, data.rest.z] : data.hover[n]);
  const segs = [...data.links, ...data.rest.links.map((b) => [REST, b])];
  let best = Infinity;
  for (const [p, q] of segs) {
    const [ax, az] = at(p);
    const [bx, bz] = at(q);
    const dx = bx - ax;
    const dz = bz - az;
    const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - ax - dx * u, z - az - dz * u));
  }
  return best;
}

test('it drifts only along the links, a burst in the middle of a drift too', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const r = scriptedFight(seed, 1 + (seed % 3));
    assert.ok(r.drifting > 100, `seed ${seed} drifted`);
    assert.equal(r.offLinks, 0, `seed ${seed}`);
  }
  // Its shell bursting while it drifts: after the stun it sinks rather than drift from where it is.
  const w = world({ trunks: [] });
  const me = fighter('a', -66, 488);
  w.until((e) => e.type === 'open', [me]);
  w.s.hp = Math.round(0.67 * w.s.max);
  w.hurt('a', 0, 100);
  // Half way from hover point 0 to 3.
  const [ax, az] = data.hover[0];
  const [bx, bz] = data.hover[3];
  Object.assign(w.s, { act: 'drift', node: null, path: [3], x: (ax + bx) / 2, z: (az + bz) / 2 });
  for (const i of w.s.draw[0]) w.hurt('a', i + 1, 60);
  assert.equal(w.s.act, 'stun');
  let drifted = false;
  const sink = w.until((e) => e.type === 'sink', (x) => {
    drifted ||= x.s.act === 'drift';
    return [me];
  }, 15000);
  assert.ok(sink, 'it sinks after the stun');
  assert.ok(!drifted, 'without drifting from the middle of the link');
});

/**
 * A simple scripted player (or several) with the rifle's numbers: walks in from the lane, keeps 12 to 16 m from the
 * spirit where it sees past the trunks, dodges the tells it sees (a reaction of 0.25 to 0.55 s, sprinting 7 times
 * in 10), shoots the heart when it is open or mending and the lights in a shell, hitting `aim` of its shots, reloads,
 * and when downed comes back after 3 s at the wake spot.
 */
function scriptedFight(seed, n = 1, { aim = 0.45, keep = false, limit = 15 * 60000 } = {}) {
  const w = world({ seed });
  const s = w.s;
  const mine = dice(seed * 7919 + 13);
  const rifle = weapons.rifle;
  const players = Array.from({ length: n }, (_, i) => ({ name: `p${i}`, x: -46 - i, y: G.y, z: 480 + i * 2, hp: 100, alive: true, back: 0, ammo: rifle.mag, reload: 0, next: 0, dodge: null, downs: 0 }));
  const out = { boltTells: 0, boltsThroughTrunks: 0, rises: 0, risesNear: 0, drifting: 0, offLinks: 0, downs: 0, marks: {}, log: [], wire: [] };
  const mark = (k) => (out.marks[k] ??= w.now);
  const handle = (e, alive) => {
    if (keep) out.log.push({ ...e, now: w.now });
    if (e.type === 'wake') mark('wake');
    if (e.type === 'shell') mark(`shell${s.shell}`);
    if (e.type === 'burst') mark(`burst${s.phase - 1}`);
    if (e.type === 'beaten') mark('beaten');
    if (e.type === 'tell' && e.kind === 'bolt') {
      out.boltTells++;
      if (!clearLine(s.x, s.z, e.x, e.z, TRUNKS)) out.boltsThroughTrunks++;
    }
    if (e.type === 'rise') {
      out.rises++;
      if (alive.some((f) => Math.hypot(f.x - e.x, f.z - e.z) <= data.sink.clear)) out.risesNear++;
    }
    if (e.type === 'hit') {
      const p = players.find((q) => q.name === e.name);
      if (p && p.alive) {
        p.hp -= e.damage;
        if (p.hp <= 0) Object.assign(p, { alive: false, back: w.now + data.down.back * 1000, dodge: null, downs: p.downs + 1 });
      }
    }
    if (e.type === 'tell') {
      for (const p of players) {
        if (!p.alive) continue;
        const react = 250 + mine() * 300;
        const v = mine() < 0.7 ? 3.5 : 1.4;
        if (e.kind === 'bolt' && Math.hypot(p.x - e.x, p.z - e.z) < 3) {
          const a = Math.atan2(p.x - s.x, p.z - s.z) + (Math.PI / 2) * (mine() < 0.5 ? 1 : -1);
          p.dodge = { at: w.now + react, x: p.x + Math.sin(a) * 5, z: p.z + Math.cos(a) * 5, v, until: w.now + react + 3000 };
        } else if (e.kind === 'sweep') {
          const ex = e.x - e.fx;
          const ez = e.z - e.fz;
          const len = Math.hypot(ex, ez);
          const side = ((p.x - e.fx) * ez - (p.z - e.fz) * ex) / len;
          const sg = side >= 0 ? 1 : -1;
          if (Math.abs(side) < 2) p.dodge = { at: w.now + react, x: p.x + (ez / len) * 2.8 * sg, z: p.z - (ex / len) * 2.8 * sg, v, until: w.now + react + 2000 };
        } else if (e.kind === 'pool' && Math.hypot(p.x - e.x, p.z - e.z) < 3.5) {
          const a = Math.atan2(p.x - e.x, p.z - e.z) + (mine() - 0.5);
          p.dodge = { at: w.now + react, x: e.x + Math.sin(a) * 5.5, z: e.z + Math.cos(a) * 5.5, v, until: w.now + react + 3000 };
        }
      }
    }
  };
  while (w.now < limit && out.marks.beaten === undefined) {
    const alive = players.filter((p) => p.alive).map((p) => fighter(p.name, p.x, p.z, p.y));
    for (const e of w.step(alive)) handle(e, alive);
    if (keep && w.now % 1000 === 0) out.wire.push(spiritWire(s, w.now));
    if (s.act === 'drift') {
      out.drifting++;
      if (offLink(s.x, s.z) > 0.01) out.offLinks++;
    }
    if (out.marks.beaten !== undefined) break;
    const look = spiritLook(spiritView(s, w.now), w.now, data);
    for (const p of players) {
      if (!p.alive) {
        if (w.now >= p.back) Object.assign(p, { alive: true, hp: 100, x: data.wake.x, y: data.wake.y, z: data.wake.z });
        continue;
      }
      let goal = null;
      let v = 1.4;
      if (p.dodge && w.now >= p.dodge.until) p.dodge = null;
      if (p.dodge && w.now >= p.dodge.at) {
        goal = p.dodge;
        v = p.dodge.v;
        if (Math.hypot(goal.x - p.x, goal.z - p.z) < 0.2) p.dodge = null;
      } else if (!p.dodge) {
        const lit = s.lights.filter((l) => l.lit).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
        if (lit.length) {
          const l = lit[0];
          if (Math.hypot(l.x - p.x, l.z - p.z) > 12 || !clearLine(p.x, p.z, l.x, l.z, TRUNKS)) goal = { x: (l.x + G.x) / 2, z: (l.z + G.z) / 2 };
        } else if (look.fade < 1) {
          const a = Math.atan2(p.x - s.x, p.z - s.z);
          const dist = Math.hypot(p.x - s.x, p.z - s.z);
          if (dist < 12 || dist > 16 || !clearLine(p.x, p.z, s.x, s.z, TRUNKS)) {
            for (const da of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6]) {
              const x = s.x + Math.sin(a + da) * 14;
              const z = s.z + Math.cos(a + da) * 14;
              if (Math.hypot(x - G.x, z - G.z) < G.leash - 3 && clearLine(x, z, s.x, s.z, TRUNKS)) {
                goal = { x, z };
                break;
              }
            }
          }
        }
        if (goal && Math.hypot(goal.x - p.x, goal.z - p.z) > 4) v = 3.5;
      }
      if (goal) {
        const dx = goal.x - p.x;
        const dz = goal.z - p.z;
        const dist = Math.hypot(dx, dz);
        const step = Math.min(dist, (v * STEP) / 1000);
        if (dist > 1e-6) {
          p.x += (dx / dist) * step;
          p.z += (dz / dist) * step;
        }
      }
      if (w.now < p.reload || w.now < p.next) continue;
      let part = null;
      let at = null;
      if ((look.open >= 0.99 || s.mode === 'mend') && spiritPart(s, 0, w.now)) [part, at] = [0, s];
      else {
        const i = s.lights.findIndex((l) => l.lit && Math.hypot(l.x - p.x, l.z - p.z) < 40 && clearLine(p.x, p.z, l.x, l.z, TRUNKS));
        if (i >= 0) [part, at] = [i + 1, s.lights[i]];
      }
      if (part === null) continue;
      p.next = w.now + rifle.delay * 1000;
      if (--p.ammo <= 0) [p.ammo, p.reload] = [rifle.mag, w.now + rifle.reload * 1000];
      if (!clearLine(p.x, p.z, at.x, at.z, TRUNKS) || mine() >= aim) continue;
      for (const e of w.hurt(p.name, part, rifle.body).events) handle(e, alive);
    }
  }
  out.downs = players.reduce((k, p) => k + p.downs, 0);
  out.ms = out.marks.beaten === undefined ? Infinity : out.marks.beaten - out.marks.wake;
  return out;
}

test('a whole fight for one fighter with the rifle: beatable, in 2 to 8 minutes', (t) => {
  const times = [];
  for (let seed = 1; seed <= 10; seed++) {
    const r = scriptedFight(seed, 1);
    assert.ok(Number.isFinite(r.ms), `seed ${seed}: beaten`);
    const m = r.marks;
    const min = (a, b) => ((m[b] - m[a]) / 60000).toFixed(2);
    t.diagnostic(`seed ${seed}: ${(r.ms / 60000).toFixed(2)} min (phase 1 ${min('wake', 'shell0')}, shell ${min('shell0', 'burst1')}, phase 2 ${min('burst1', 'shell1')}, shell ${min('shell1', 'burst2')}, phase 3 ${min('burst2', 'beaten')}), downed ${r.downs} times`);
    times.push(r.ms);
    assert.ok(r.ms >= 2 * 60000 && r.ms <= 8 * 60000, `seed ${seed}: ${(r.ms / 60000).toFixed(2)} min`);
  }
});

test('a group of four fights it through too, and full health grew with them', (t) => {
  for (let seed = 1; seed <= 3; seed++) {
    const r = scriptedFight(seed, 4, { aim: 0.6 });
    assert.ok(Number.isFinite(r.ms), `seed ${seed}: beaten`);
    t.diagnostic(`four fighters, seed ${seed}: ${(r.ms / 60000).toFixed(2)} min, downed ${r.downs} times`);
  }
});
