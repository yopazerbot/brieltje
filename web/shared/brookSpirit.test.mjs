// The Brook Spirit's fight (shared/brookSpirit.mjs) on a fake clock with seeded dice: its place in the wood, its
// fairness rules (tells that never follow, trunks as cover, no rising next to a fighter, the window's share, the
// shells' marks, lights that stay out, health that only scales up), mending and the reset, the beaten spirit's return,
// its limits against bad input, the wire, and whole fights played by a simple scripted player with the rifle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACTS, MODES, REST, actLength, blastSpirit, clearLine, hurtSpirit, lightsOf, newSpirit, readSpirit, spiritLook,
  spiritPart, spiritView, spiritWire, stepSpirit, windowCap,
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
  const most = data.attacks.bolt.damage;
  assert.ok(h2.damage < most * 0.4 && h2.damage >= Math.round(most * 0.3), `${h2.damage} at the edge`);
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
  // Next time A steps 1.5 m aside during the tell: spared, though the spirit could follow.
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
  assert.notEqual(w.s.node, REST, 'it attacks from somewhere else');
  if (first.kind === 'bolt') assert.ok(clearLine(w.s.x, w.s.z, me.x, me.z, [trunk]), 'a bolt from where it sees past the trunk');
  else assert.equal(first.kind, 'sweep', 'or a sweep, close by');
  // Phase 2, the same: pools instead (they ignore the trunks).
  const w2 = world({ trunks: [trunk] });
  w2.step([me]);
  w2.s.phase = 2;
  const tell = w2.until((e) => e.type === 'tell', [me], 2000);
  assert.equal(tell.kind, 'pool');
  assert.deepEqual([tell.x, tell.z], [me.x, me.z]);
  // Every bolt in whole fights had a clear line from where the spirit was to its target when its tell began.
  for (let seed = 1; seed <= 4; seed++) {
    const r = fight(seed, mixed(2));
    assert.ok(r.boltTells > 0);
    assert.equal(r.boltsThroughTrunks, 0, `seed ${seed}`);
  }
});

test('pools: from phase 2, 2.5 m, 8 every half second inside, 6 at most, and they fade after 6 s', () => {
  const w = world({ trunks: [] });
  // Woken, then 40 m from the spirit at its rest: too far for a bolt, so pools.
  w.step([fighter('a', -66, 488)]);
  w.s.phase = 2;
  const me = fighter('a', data.rest.x + 40, data.rest.z);
  const tell = w.until((e) => e.type === 'tell', [me], 3000);
  assert.equal(tell.kind, 'pool');
  // The tell fixes it: walk away, and come back into it once it is there.
  const pool = w.until((e) => e.type === 'pool', [fighter('a', me.x + 6, me.z)], 3000);
  assert.deepEqual([pool.x, pool.z], [me.x, me.z]);
  const inside = fighter('a', me.x - 2, me.z);
  const hits = w.run(2000, [inside]).filter((e) => e.type === 'hit');
  assert.equal(hits.length, 4, 'four stings in 2 s');
  assert.ok(hits.every((h) => h.damage === 8 && h.kind === 'pool'));
  assert.equal(w.run(1500, [fighter('a', me.x - data.attacks.pools.radius - 0.1, me.z)]).filter((e) => e.type === 'hit' && e.kind === 'pool' && Math.hypot(e.x - pool.x, e.z - pool.z) < 0.01).length, 0, 'outside it: nothing');
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

test('it never rises within 8 m of a fighter while a point is free, and waits under a while when none is', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const r = fight(seed, mixed(3));
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
  const under = () => {
    w.s.act = 'under';
    w.s.since = w.now - data.sink.gone * 1000;
    w.s.until = w.now;
    w.s.node = 2;
  };
  under();
  assert.equal(w.run(2000, all).filter((e) => e.type === 'rise').length, 0);
  assert.equal(w.s.act, 'under');
  const back = w.until((e) => e.type === 'rise', all.filter((f) => f.name !== 'f4'), 500);
  assert.deepEqual([back.x, back.z], [data.hover[4][0], data.hover[4][1]]);
  assert.ok(!back.forced);
  // A crowd that stays on every point cannot hold it under for good: after sink.wait it rises where they are farthest
  // (point 6 here: its fighter stands 5 m off), its tell as long as ever.
  const crowd = all.map((f, i) => (i === 6 ? { ...f, x: f.x + 3 } : f));
  under();
  const t0 = w.now;
  const forced = w.until((e) => e.type === 'rise', crowd, 10000);
  assert.ok(forced.forced);
  assert.ok(forced.now - t0 >= data.sink.wait * 1000 - STEP, `waited ${forced.now - t0} ms`);
  assert.deepEqual([forced.x, forced.z], [data.hover[6][0], data.hover[6][1]]);
  assert.equal(forced.ms, data.sink.rise * 1000);
});

test('one window never takes more than its share, the stun after a burst a little more', () => {
  const w = world({ trunks: [] });
  const me = fighter('a', -66, 488);
  w.until((e) => e.type === 'open', [me]);
  const share = windowCap(w.s);
  assert.equal(share, data.cap.window, 'for one fighter');
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
  // The stun after the first burst: a little more.
  const w2 = world({ trunks: [] });
  w2.until((e) => e.type === 'open', [me]);
  w2.s.hp = Math.round(0.67 * w2.s.max);
  w2.hurt('a', 0, 100);
  assert.equal(w2.s.shell, 0);
  for (const i of w2.s.draw[0]) w2.hurt('a', i + 1, 500);
  assert.equal(w2.s.act, 'stun');
  const before = w2.s.hp;
  for (let k = 0; k < 40; k++) w2.hurt('a', 0, 100);
  assert.equal(before - w2.s.hp, Math.round(data.cap.stun * windowCap(w2.s)));
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
  // Each light takes the first shell's light health (one fighter).
  const L = data.shell.lightHp[0];
  const [l0, l1, l2] = shell.lights;
  assert.equal(w.hurt('a', l0 + 1, 26).dealt, 26);
  assert.equal(w.hurt('a', l0 + 1, 500).dealt, L - 26);
  assert.equal(w.hurt('a', l1 + 1, L).events[0].type, 'out');
  const last = w.hurt('a', l2 + 1, L);
  assert.deepEqual(last.events.map((e) => e.type), ['out', 'burst', 'phase']);
  assert.equal(w.s.phase, 2);
  assert.equal(w.s.act, 'stun');
  assert.ok(spiritPart(w.s, 0, w.now));
  // The second mark the same way, with the other five lights.
  w.s.hp = Math.round(0.34 * w.s.max);
  const r2 = w.hurt('a', 0, 200);
  assert.equal(w.s.hp, Math.round(0.33 * w.s.max));
  const second = r2.events.find((e) => e.type === 'shell').lights;
  assert.equal(second.length, 5);
  assert.equal(w.s.lights[second[0]].hp, data.shell.lightHp[1], 'the second shell has its own light health');
});

test('lights that are out never light again: the second shell lights the other five', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const w = world({ seed, trunks: [] });
    const me = fighter('a', -66, 488);
    w.until((e) => e.type === 'open', [me]);
    w.s.hp = Math.round(0.67 * w.s.max);
    const first = w.hurt('a', 0, 100).events.find((e) => e.type === 'shell').lights;
    w.hurt('a', first[0] + 1, 500);
    w.run(60000, [me]);
    assert.ok(!w.s.lights[first[0]].lit, 'still out a minute later');
    assert.equal(w.hurt('a', first[0] + 1, 500).why, 'out');
    for (const i of first.slice(1)) w.hurt('a', i + 1, 500);
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
  const { base, per } = data.health;
  w.step([a]);
  assert.equal(w.s.max, base);
  w.step([a, b]);
  assert.equal(w.s.max, base + per);
  w.step([a]);
  w.run(1000, [a]);
  assert.equal(w.s.max, base + per, 'b leaving takes nothing off');
  w.step([a, b]);
  assert.equal(w.s.max, base + per, 'nor does b coming back count twice');
  const many = Array.from({ length: 12 }, (_, i) => fighter(`p${i}`, -66 + (i % 4), 488 + Math.floor(i / 4)));
  w.step(many);
  assert.equal(w.s.max, base + per * 7, 'at most 8 counted');
  assert.equal(windowCap(w.s), data.cap.window + data.cap.per * 7, 'the window grows more slowly');
  assert.ok(windowCap(w.s) / w.s.max < data.cap.window / base);
  // Health keeps its share when it grows.
  const w2 = world({ trunks: [] });
  w2.until((e) => e.type === 'open', [a]);
  w2.hurt('a', 0, 240);
  w2.step([a, b]);
  assert.equal(w2.s.hp, Math.round(((base - 240) / base) * (base + per)));
});

test('alone for 8 s it goes back over the brook and mends; a heart hit stops it; 45 s alone and it is new and asleep', () => {
  const w = world({ trunks: [] });
  const me = fighter('a', -66, 488);
  w.until((e) => e.type === 'open', [me]);
  w.hurt('a', 0, windowCap(w.s));
  const hp = w.s.hp;
  // Nobody for 8 s: mending.
  const mend = w.until((e) => e.type === 'mend', [], 9000);
  assert.ok(mend && mend.now - w.log.find((e) => e.type === 'open').now >= 8000);
  // Along the links (two reach the rest).
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
  assert.equal(w.s.max, data.health.base);
  assert.ok(w.s.lights.every((l) => !l.lit && !l.used));
  // Mended full while a fighter only watches (no damage for mend.noDamage s): reset too.
  const w2 = world({ trunks: [] });
  w2.until((e) => e.type === 'open', [me]);
  w2.hurt('a', 0, 100);
  const m2 = w2.until((e) => e.type === 'mend', [me], data.mend.noDamage * 1000 + 5000);
  assert.ok(m2.now - w2.log.find((e) => e.type === 'open').now >= data.mend.noDamage * 1000, 'after that long without damage');
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
  assert.equal(w.s.hp, data.health.base);
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
  assert.equal(hurtSpirit(w.s, 'a', 0, 1e12, w.now).dealt, Math.min(data.heart.most, windowCap(w.s)), 'a huge hit takes the share, no more');
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

// ---- Every attack can be walked out of

/**
 * A fighter who reacts after 0.5 s and only walks (1.4 m/s, as on a touch screen), straight along `dir` (x, z), from
 * `from`; the spirit's dice `seed`. Returns the world and where the fighter is at time `t`.
 */
function walker(from, react = 500, speed = 1.4) {
  let start = null;
  let dir = null;
  return {
    go(now, d) {
      start = now + react;
      dir = d;
    },
    at(now) {
      if (start === null || now <= start) return { ...from };
      const k = (speed * (now - start)) / 1000;
      return { ...from, x: from.x + dir.x * k, z: from.z + dir.z * k };
    },
  };
}

const MARGIN = 0.4;

test('every sweep can be walked out of, reacting after 0.5 s, with 0.4 m to spare', () => {
  for (let phase = 1; phase <= 3; phase++) {
    const w = world({ trunks: [] });
    const from = fighter('a', data.rest.x + 6, data.rest.z);
    const me = walker(from);
    w.step([from]);
    w.s.phase = phase;
    let tell = null;
    let sweep = null;
    for (let t = 0; t < 10000 && !sweep; t += STEP) {
      const ev = w.step([me.at(w.now)]);
      const e = ev.find((q) => q.type === 'tell');
      if (e && !tell) {
        assert.equal(e.kind, 'sweep');
        tell = e;
        // Sideways to the strip.
        const ex = e.x - e.fx;
        const ez = e.z - e.fz;
        const len = Math.hypot(ex, ez);
        me.go(e.now, { x: ez / len, z: -ex / len });
      }
      sweep = ev.find((q) => q.type === 'sweep') ?? null;
    }
    assert.ok(sweep, `phase ${phase}: a sweep`);
    assert.deepEqual(sweep.hits, [], `phase ${phase}: walked out`);
    const p = me.at(sweep.now);
    const ex = tell.x - tell.fx;
    const ez = tell.z - tell.fz;
    const side = Math.abs((p.x - tell.fx) * ez - (p.z - tell.fz) * ex) / Math.hypot(ex, ez);
    assert.ok(side - data.attacks.sweep.half >= MARGIN, `phase ${phase}: ${(side - data.attacks.sweep.half).toFixed(2)} m to spare`);
  }
});

test('every bolt can be walked out of at its nearest range, reacting after 0.5 s, with 0.4 m to spare', () => {
  // The nearest a bolt is cast at (no sweep here to take its place); every bolt of a volley in turn.
  const d = structuredClone(data);
  d.attacks.sweep.range = 0;
  for (let phase = 1; phase <= 3; phase++) {
    const w = world({ trunks: [], d });
    const from = fighter('a', data.rest.x + data.attacks.bolt.min, data.rest.z);
    const me = walker(from);
    w.step([from]);
    w.s.phase = phase;
    const landings = [];
    let bolts = 0;
    for (let t = 0; t < 20000 && bolts < data.attacks.bolt.volley[phase - 1]; t += STEP) {
      const ev = w.step([me.at(w.now)]);
      for (const e of ev) {
        if (e.type === 'tell' && !landings.length) me.go(e.now, { x: 0, z: 1 }); // across its line
        if (e.type === 'bolt') {
          bolts++;
          landings.push({ to: e.to, at: e.now + e.ms });
        }
        assert.notEqual(e.type, 'hit', `phase ${phase}: never hit`);
      }
    }
    assert.equal(bolts, data.attacks.bolt.volley[phase - 1], `phase ${phase}: the whole volley`);
    for (const l of landings) {
      const p = me.at(l.at);
      const gap = Math.hypot(p.x - l.to.x, p.z - l.to.z) - data.attacks.bolt.radius;
      assert.ok(gap >= MARGIN, `phase ${phase}: ${gap.toFixed(2)} m to spare`);
    }
    assert.equal(w.run(4000, () => [me.at(w.now)]).filter((e) => e.type === 'hit').length, 0);
  }
});

test('every pool can be walked out of before it spreads, reacting after 0.5 s, with 0.4 m to spare', () => {
  for (let phase = 2; phase <= 3; phase++) {
    const w = world({ trunks: [] });
    w.step([fighter('a', -66, 488)]);
    w.s.phase = phase;
    const from = fighter('a', data.rest.x + 40, data.rest.z); // too far for a bolt
    const me = walker(from);
    let pool = null;
    for (let t = 0; t < 10000 && !pool; t += STEP) {
      const ev = w.step([me.at(w.now)]);
      const tell = ev.find((e) => e.type === 'tell');
      if (tell) {
        assert.equal(tell.kind, 'pool');
        me.go(tell.now, { x: 0, z: 1 });
      }
      pool = ev.find((e) => e.type === 'pool') ?? null;
    }
    assert.ok(pool);
    const p = me.at(pool.now);
    const gap = Math.hypot(p.x - pool.x, p.z - pool.z) - data.attacks.pools.radius;
    assert.ok(gap >= MARGIN, `phase ${phase}: ${gap.toFixed(2)} m to spare`);
  }
});

// ---- Whole fights

/**
 * The scripted players. `aim`: the share of shots that hit (per pellet, less for a wide gun far off); `react`: s to
 * react to a tell it notices; `notice`: the share of tells it notices (it misses some while it shoots or looks for a
 * light); `sprint`: how often it sprints to dodge, else walks; `find`: s to find and turn to each light; `seeOpen`: s to
 * see the heart open.
 */
const AVERAGE = { aim: 0.45, react: [0.25, 0.55], notice: 0.8, sprint: 0.7, find: [3, 6], seeOpen: [0.3, 0.7] };
const SHARP = { aim: 0.8, react: [0.15, 0.3], notice: 0.95, sprint: 0.9, find: [1.5, 3], seeOpen: [0.15, 0.3] };
/** n players, average and sharp by turns. */
const mixed = (n) => Array.from({ length: n }, (_, i) => (i % 2 ? SHARP : AVERAGE));
/** The lights' hit radius the players aim at (the heart's is heart.r). */
const LIGHT_R = 0.35;

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

/** The nearest spot to `p`, `near` to `far` m from light `l` inside the leash, that sees it past the trunks. */
function spotFor(l, p, near, far) {
  let best = null;
  for (let r = near; r <= far; r += (far - near) / 2) {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const x = l.x + Math.sin(a) * r;
      const z = l.z + Math.cos(a) * r;
      if (Math.hypot(x - G.x, z - G.z) > G.leash - 2 || !clearLine(x, z, l.x, l.z, TRUNKS)) continue;
      const dist = Math.hypot(x - p.x, z - p.z);
      if (!best || dist < best.d) best = { x, z, d: dist };
    }
  }
  return best ?? { x: G.x, z: G.z };
}

/**
 * A whole fight by scripted players (`kinds`: AVERAGE, SHARP) with gun `gun` (shared/weapons.json): they walk in from the
 * lane, keep 12 to 16 m from the spirit where they see past the trunks (8 to 10.5 with the shotgun), dodge the tells
 * they notice, step out of pools, shoot the heart when they see it open (or mending) and the lights in a shell (each
 * found after a while, from a spot that sees it), reload, and when downed come back after 3 s at the wake spot. The
 * gun's spread is in screen units (weapon.ts): tan(36 degrees) radians each at the 72 degree view.
 */
function fight(seed, kinds, { gun = 'rifle', keep = false, limit = 20 * 60000 } = {}) {
  const w = world({ seed });
  const s = w.s;
  const mine = dice(seed * 7919 + 13);
  const W = weapons[gun];
  const range = gun === 'shotgun' ? [8, 10.5] : [12, 16];
  const spots = gun === 'shotgun' ? [5, 8] : [8, 16];
  const reach = gun === 'shotgun' ? 9 : 20;
  const players = kinds.map((k, i) => ({ ...k, name: `p${i}`, x: -46 - i, y: G.y, z: 480 + i * 2, hp: 100, alive: true, back: 0, ammo: W.mag, reload: 0, next: 0, dodge: null, downs: 0, light: -1, lightAt: 0 }));
  const out = { boltTells: 0, boltsThroughTrunks: 0, rises: 0, risesNear: 0, forced: 0, drifting: 0, offLinks: 0, windows: 0, capped: 0, marks: {}, log: [], wire: [] };
  const mark = (k) => (out.marks[k] ??= w.now);
  const pools = data.attacks.pools;
  const handle = (e, alive) => {
    if (keep) out.log.push({ ...e, now: w.now });
    if (e.type === 'wake') mark('wake');
    if (e.type === 'shell') mark(`shell${s.shell}`);
    if (e.type === 'burst') mark(`burst${s.phase - 1}`);
    if (e.type === 'beaten') mark('beaten');
    if (e.type === 'open') out.windows++;
    if (e.type === 'cap') out.capped++;
    if (e.type === 'tell' && e.kind === 'bolt') {
      out.boltTells++;
      if (!clearLine(s.x, s.z, e.x, e.z, TRUNKS)) out.boltsThroughTrunks++;
    }
    if (e.type === 'rise') {
      out.rises++;
      if (e.forced) out.forced++;
      else if (alive.some((f) => Math.hypot(f.x - e.x, f.z - e.z) <= data.sink.clear)) out.risesNear++;
    }
    if (e.type === 'hit') {
      const p = players.find((q) => q.name === e.name);
      if (p && p.alive) {
        p.hp -= e.damage;
        if (p.hp <= 0) Object.assign(p, { alive: false, back: w.now + data.down.back * 1000, dodge: null, downs: p.downs + 1, light: -1 });
      }
    }
    if (e.type === 'tell') {
      for (const p of players) {
        if (!p.alive || mine() > p.notice) continue;
        const react = (p.react[0] + mine() * (p.react[1] - p.react[0])) * 1000;
        const v = mine() < p.sprint ? 3.5 : 1.4;
        if (e.kind === 'bolt' && Math.hypot(p.x - e.x, p.z - e.z) < data.attacks.bolt.radius + 0.5) {
          const a = Math.atan2(p.x - s.x, p.z - s.z) + (Math.PI / 2) * (mine() < 0.5 ? 1 : -1);
          p.dodge = { at: w.now + react, x: p.x + Math.sin(a) * 5, z: p.z + Math.cos(a) * 5, v, until: w.now + react + 4000 };
        } else if (e.kind === 'sweep') {
          const ex = e.x - e.fx;
          const ez = e.z - e.fz;
          const len = Math.hypot(ex, ez);
          const side = ((p.x - e.fx) * ez - (p.z - e.fz) * ex) / len;
          const sg = side >= 0 ? 1 : -1;
          if (Math.abs(side) < data.attacks.sweep.half + 1) p.dodge = { at: w.now + react, x: p.x + (ez / len) * 2.6 * sg, z: p.z - (ex / len) * 2.6 * sg, v, until: w.now + react + 3000 };
        } else if (e.kind === 'pool' && Math.hypot(p.x - e.x, p.z - e.z) < pools.radius + 0.5) {
          const a = Math.atan2(p.x - e.x, p.z - e.z) + (mine() - 0.5);
          p.dodge = { at: w.now + react, x: e.x + Math.sin(a) * (pools.radius + 2), z: e.z + Math.cos(a) * (pools.radius + 2), v, until: w.now + react + 4000 };
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
        const lit = s.lights.map((l, i) => ({ l, i })).filter((q) => q.l.lit);
        if (lit.length) {
          if (p.light < 0 || !s.lights[p.light].lit) {
            lit.sort((a, b) => Math.hypot(a.l.x - p.x, a.l.z - p.z) - Math.hypot(b.l.x - p.x, b.l.z - p.z));
            p.light = lit[0].i;
            p.lightAt = w.now + (p.find[0] + mine() * (p.find[1] - p.find[0])) * 1000;
          }
          const l = s.lights[p.light];
          if (Math.hypot(l.x - p.x, l.z - p.z) > reach || !clearLine(p.x, p.z, l.x, l.z, TRUNKS)) goal = spotFor(l, p, ...spots);
        } else if (look.fade < 1) {
          const a = Math.atan2(p.x - s.x, p.z - s.z);
          const dist = Math.hypot(p.x - s.x, p.z - s.z);
          if (dist < range[0] || dist > range[1] || !clearLine(p.x, p.z, s.x, s.z, TRUNKS)) {
            for (const da of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6, 2.0, -2.0]) {
              const r = (range[0] + range[1]) / 2;
              const x = s.x + Math.sin(a + da) * r;
              const z = s.z + Math.cos(a + da) * r;
              if (Math.hypot(x - G.x, z - G.z) < G.leash - 3 && clearLine(x, z, s.x, s.z, TRUNKS)) {
                goal = { x, z };
                break;
              }
            }
          }
        }
        if (!goal && Math.hypot(p.x - G.x, p.z - G.z) > G.leash - 4) goal = { x: G.x, z: G.z };
        const inPool = s.pools.find((q) => Math.hypot(p.x - q.x, p.z - q.z) < pools.radius);
        if (inPool) {
          const a = Math.atan2(p.x - inPool.x, p.z - inPool.z);
          goal = { x: inPool.x + Math.sin(a) * (pools.radius + 1.5), z: inPool.z + Math.cos(a) * (pools.radius + 1.5) };
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
      let r = data.heart.r;
      const heart = spiritPart(s, 0, w.now);
      const seen = s.mode === 'mend' || ((s.act === 'open' || s.act === 'stun') && w.now - s.since >= (p.seeOpen[0] + mine() * (p.seeOpen[1] - p.seeOpen[0])) * 1000);
      if (heart && seen) [part, at] = [0, heart];
      else if (p.light >= 0 && s.lights[p.light].lit && w.now >= p.lightAt) [part, at, r] = [p.light + 1, s.lights[p.light], LIGHT_R];
      if (part === null) continue;
      const dist = Math.hypot(at.x - p.x, at.z - p.z);
      if (dist > 30 || !clearLine(p.x, p.z, at.x, at.z, TRUNKS)) continue;
      p.next = w.now + W.delay * 1000;
      if (--p.ammo <= 0) [p.ammo, p.reload] = [W.mag, w.now + W.reload * 1000];
      const each = p.aim * Math.min(1, (r / Math.max(1e-6, W.spread * Math.tan(Math.PI / 5) * dist)) ** 2);
      let n = 0;
      for (let k = 0; k < W.pellets; k++) if (mine() < each) n++;
      if (n) for (const e of w.hurt(p.name, part, n * W.body).events) handle(e, alive);
    }
  }
  const m = out.marks;
  out.ms = m.beaten === undefined ? Infinity : m.beaten - m.wake;
  out.shells = [(m.burst1 - m.shell0) / 1000, (m.burst2 - m.shell1) / 1000];
  out.downs = players.map((p) => p.downs);
  return out;
}

test('the same inputs and dice give the same fight', () => {
  const a = fight(11, mixed(2), { keep: true });
  const b = fight(11, mixed(2), { keep: true });
  assert.ok(a.log.length > 100);
  assert.equal(JSON.stringify(a.log), JSON.stringify(b.log));
  assert.equal(JSON.stringify(a.wire), JSON.stringify(b.wire));
  const c = fight(12, mixed(2), { keep: true });
  assert.notEqual(JSON.stringify(a.log), JSON.stringify(c.log), 'other dice, another fight');
});

test('it drifts only along the links, a burst in the middle of a drift too', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const r = fight(seed, mixed(1 + (seed % 3)));
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
  for (const i of w.s.draw[0]) w.hurt('a', i + 1, 500);
  assert.equal(w.s.act, 'stun');
  let drifted = false;
  const sink = w.until((e) => e.type === 'sink', (x) => {
    drifted ||= x.s.act === 'drift';
    return [me];
  }, 15000);
  assert.ok(sink, 'it sinks after the stun');
  assert.ok(!drifted, 'without drifting from the middle of the link');
});

/** Fights for seeds 1 to n, with a line each in the test's output. */
function fights(t, label, n, kinds, opts) {
  const all = [];
  for (let seed = 1; seed <= n; seed++) {
    const r = fight(seed, kinds, opts);
    t.diagnostic(`${label}, seed ${seed}: ${(r.ms / 60000).toFixed(2)} min, shells ${r.shells.map((v) => v.toFixed(0)).join(' and ')} s, windows ${r.windows} (${r.capped} capped), downed ${r.downs.join(',')}`);
    all.push(r);
  }
  return all;
}
const minutes = (r) => r.ms / 60000;
const capShare = (rs) => rs.reduce((k, r) => k + r.capped, 0) / rs.reduce((k, r) => k + r.windows, 0);

test('one average player with the rifle: 4 to 6 minutes, downed 1 to 4 times, rarely stopped by the window\'s cap', (t) => {
  const rs = fights(t, 'average', 12, [AVERAGE]);
  for (const r of rs) {
    assert.ok(minutes(r) >= 4 && minutes(r) <= 6, `${minutes(r).toFixed(2)} min`);
    assert.ok(r.downs[0] >= 1 && r.downs[0] <= 4, `downed ${r.downs[0]} times`);
    for (const shell of r.shells) assert.ok(shell >= 15 && shell <= 60, `a shell of ${shell} s`);
  }
  assert.ok(capShare(rs) < 0.25, `${(capShare(rs) * 100).toFixed(0)} % of windows capped`);
});

test('one sharp player with the rifle: at least 3 minutes, and the cap stops some of its windows', (t) => {
  const rs = fights(t, 'sharp', 12, [SHARP]);
  for (const r of rs) {
    assert.ok(minutes(r) >= 3 && minutes(r) <= 6, `${minutes(r).toFixed(2)} min`);
    assert.ok(r.downs[0] <= 4);
    assert.ok(r.shells[0] >= 10 && r.shells[1] >= 10, `shells ${r.shells.join(', ')} s`);
  }
  const share = capShare(rs);
  assert.ok(share > 0.2 && share < 0.9, `${(share * 100).toFixed(0)} % of windows capped`);
});

test('groups of 2, 4 and 8 take 3 to 6 minutes, none clearly quicker, and the cap usually stops a crowd', (t) => {
  const means = [];
  for (const n of [2, 4, 8]) {
    const rs = fights(t, `${n} players`, 10, mixed(n));
    for (const r of rs) {
      assert.ok(minutes(r) >= 3 && minutes(r) <= 6, `${n} players: ${minutes(r).toFixed(2)} min`);
      for (const shell of r.shells) assert.ok(shell >= 12, `${n} players: a shell of ${shell} s`);
    }
    if (n >= 4) assert.ok(capShare(rs) > 0.6, `${n} players: ${(capShare(rs) * 100).toFixed(0)} % capped`);
    means.push(rs.reduce((k, r) => k + minutes(r), 0) / rs.length);
  }
  assert.ok(Math.max(...means) / Math.min(...means) < 1.3, `means ${means.map((m) => m.toFixed(2)).join(', ')} min`);
});

test('one average player with the pistol or the shotgun beats it too, more slowly with the shotgun', (t) => {
  const pistol = fights(t, 'average with the pistol', 10, [AVERAGE], { gun: 'pistol' });
  const shotgun = fights(t, 'average with the shotgun', 10, [AVERAGE], { gun: 'shotgun' });
  for (const r of [...pistol, ...shotgun]) assert.ok(Number.isFinite(r.ms) && minutes(r) <= 15, `${minutes(r).toFixed(2)} min`);
});
