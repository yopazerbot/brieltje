// The Zombies game's rewards (shared/loot.mjs): how often each falls, who may take one, and what the
// five newer ones do: a first-aid kit, an armour vest, extra grenades, a music box, a supply crate.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeBounds } from './bounds.mjs';
import { Loot, LOOT } from './loot.mjs';
import { BIG, Horde, makeNav, RUNNER } from './zombies.mjs';

const nav = makeNav({ prisms: [], height: () => 0, edge: makeBounds([[-40, -40], [40, -40], [40, 40], [-40, 40]]) });
const seeded = (seed = 17) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const NEW = ['medkit', 'armor', 'nades', 'lull', 'gun'];
/** A player at x, y, z who may take any of them: hurt, with only the pistol. */
const at = (x = 0, y = 0, z = 0) => ({ x, y, z, w: 'pistol', hp: 40, guns: ['pistol'] });

test('the weights add up to one, ammo is the commonest, and the drops follow them', () => {
  const sum = LOOT.weights.reduce((s, [, w]) => s + w, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `sum ${sum}`);
  const ammo = LOOT.weights.find(([k]) => k === 'ammo')[1];
  for (const [k, w] of LOOT.weights) if (k !== 'ammo') assert.ok(w < ammo, k);
  assert.equal(LOOT.chance, 0.06);
  for (const k of NEW) assert.ok(LOOT.weights.some(([kind]) => kind === k), k);
  const loot = new Loot(nav, seeded());
  const count = Object.create(null);
  const N = 20000;
  for (let i = 0; i < N; i++) {
    loot.items.clear();
    loot.dropped = false;
    const [it] = loot.drop({ x: 0, y: 0, z: 0, yaw: 0, kind: 0 }, 0, true); // the wave's last: one always falls
    count[it.kind] = (count[it.kind] ?? 0) + 1;
  }
  for (const [k, w] of LOOT.weights) assert.ok(Math.abs((count[k] ?? 0) / N - w) < 0.02, `${k}: ${(count[k] ?? 0) / N} for ${w}`);
});

test('each new reward: too far, a floor up, expired or taken twice gives nothing', () => {
  for (const kind of NEW) {
    const loot = new Loot(nav, seeded());
    const it = loot.put(kind, 0, 0, 0, 0);
    assert.equal(loot.take('a', at(LOOT.reach + 0.2, 0, 0), it.id, 0), null, `${kind}: too far`);
    assert.equal(loot.take('a', at(0, LOOT.rise + 1, 0), it.id, 0), null, `${kind}: a floor up`);
    assert.equal(loot.take('a', at(), it.id, LOOT.life), null, `${kind}: expired`);
    assert.ok(loot.items.has(it.id), `${kind}: still lying`);
    const got = loot.take('a', at(), it.id, 10);
    assert.equal(got?.kind, kind);
    assert.equal(loot.take('a', at(), it.id, 20), null, `${kind}: taken twice`);
    assert.equal(loot.take('b', at(), it.id, 20), null, `${kind}: by another`);
    for (const id of ['1', 1.5, null, {}, it.id + 1000]) assert.equal(loot.take('a', at(), id, 20), null);
  }
});

test('a first-aid kit: back to full at most, and only for who misses enough of it', () => {
  const loot = new Loot(nav);
  const kit = loot.put('medkit', 0, 0, 0, 0);
  for (const hp of [100, 95, 100 - LOOT.healMin + 1, undefined, NaN, '40']) {
    assert.equal(loot.take('a', { ...at(), hp }, kit.id, 1), null, `refused at ${hp}`);
  }
  assert.ok(loot.items.has(kit.id), 'it stays for a hurt teammate');
  assert.equal(loot.take('a', { ...at(), hp: 80 }, kit.id, 1).heal, 20);
  const b = loot.put('medkit', 0, 0, 0, 0);
  assert.equal(loot.take('a', { ...at(), hp: 40 }, b.id, 1).heal, LOOT.heal);
});

test('an armour vest takes a swipe first; refused while full', () => {
  const loot = new Loot(nav);
  const v = loot.put('armor', 0, 0, 0, 0);
  assert.equal(loot.take('a', at(), v.id, 1).kit.armor, LOOT.armor);
  const w = loot.put('armor', 0, 0, 0, 0);
  assert.equal(loot.take('a', at(), w.id, 1), null, 'refused at full');
  assert.ok(loot.items.has(w.id));
  assert.equal(loot.soak('a', 20), 0);
  assert.equal(loot.kit('a').armor, 30);
  assert.equal(loot.soak('a', 45), 15);
  assert.equal(loot.kit('a').armor, 0);
  assert.equal(loot.soak('a', 10), 10, 'no vest left');
  assert.equal(loot.soak('nobody', 10), 10);
  loot.kit('a').armor = 50;
  for (const n of [-5, NaN, Infinity]) assert.ok(Object.is(loot.soak('a', n), n), `unchanged: ${n}`);
  assert.equal(loot.kit('a').armor, 50, 'and the vest untouched');
  // Taken again once worn: full again (not more).
  assert.equal(loot.soak('a', 30), 0);
  assert.equal(loot.take('a', at(), w.id, 2).kit.armor, LOOT.armor);
});

test('extra grenades: three a time, six at most, each spare used once', () => {
  const loot = new Loot(nav);
  const ids = [0, 1, 2].map(() => loot.put('nades', 0, 0, 0, 0).id);
  assert.equal(loot.take('a', at(), ids[0], 1).kit.nades, LOOT.nades);
  assert.equal(loot.take('a', at(), ids[1], 1).kit.nades, LOOT.nadesCarry);
  assert.equal(loot.take('a', at(), ids[2], 1), null, 'refused at six');
  assert.ok(loot.items.has(ids[2]));
  for (let i = 0; i < LOOT.nadesCarry; i++) assert.equal(loot.spare('a'), true);
  assert.equal(loot.spare('a'), false);
  assert.equal(loot.kit('a').nades, 0);
  assert.equal(loot.spare('nobody'), false);
});

test('a supply crate: one gun you lack, refused when you have them all', () => {
  const loot = new Loot(nav, seeded());
  const c = loot.put('gun', 0, 0, 0, 0);
  assert.equal(loot.take('a', { ...at(), guns: ['pistol', 'rifle', 'shotgun', 'sniper'] }, c.id, 1), null);
  assert.equal(loot.take('a', { ...at(), guns: undefined }, c.id, 1), null, 'nothing said: nothing given');
  assert.ok(loot.items.has(c.id));
  assert.equal(loot.take('a', { ...at(), guns: ['pistol', 'rifle', 'sniper'] }, c.id, 1).w, 'shotgun');
  for (let i = 0; i < 30; i++) {
    const d = loot.put('gun', 0, 0, 0, 0);
    const w = loot.take('a', { ...at(), guns: ['pistol', 'sniper'] }, d.id, 1).w;
    assert.ok(w === 'rifle' || w === 'shotgun', w);
  }
});

test('an assault rifle: out of ammo\'s share, about one drop in seventeen, over many seeds', () => {
  const weight = (k) => LOOT.weights.find(([kind]) => kind === k)?.[1];
  assert.equal(weight('rifle'), 0.06);
  assert.equal(weight('ammo'), 0.24);
  for (const k of ['claymore', 'nades', 'medkit', 'scope', 'armor', 'lull', 'gun']) assert.ok(weight(k) > 0, `${k} keeps its share`);
  // Real drops (not the wave's last), regular zombies and runners: the rifle's part of what fell.
  let fell = 0;
  let rifles = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const loot = new Loot(nav, seeded(seed));
    for (let i = 0; i < 5000; i++) {
      loot.items.clear();
      for (const it of loot.drop({ x: 0, y: 0, z: 0, yaw: 0, kind: i % 5 ? 0 : RUNNER }, 0)) {
        fell++;
        if (it.kind === 'rifle') rifles++;
      }
    }
  }
  assert.ok(fell > 10000, `${fell} fell`);
  assert.ok(Math.abs(rifles / fell - 0.06) < 0.01, `the rifle: ${rifles} of ${fell}`);
});

test('no rifle falls while every fighter carries one: its share is the ammo pack\'s again; one fighter without, and it falls', () => {
  const sum = LOOT.weights.reduce((s, [, w]) => s + w, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `the weights sum to ${sum}`);
  const weight = (k) => LOOT.weights.find(([kind]) => kind === k)[1];
  /** The share of each kind over many seeds, the wave's last zombie each time (one always falls). */
  const shares = (rifled) => {
    const count = Object.create(null);
    let n = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const loot = new Loot(nav, seeded(seed));
      for (let i = 0; i < 2000; i++) {
        loot.items.clear();
        loot.dropped = false;
        const [it] = loot.drop({ x: 0, y: 0, z: 0, yaw: 0, kind: 0 }, 0, true, ['a', 'b'], rifled);
        count[it.kind] = (count[it.kind] ?? 0) + 1;
        n++;
      }
    }
    return Object.fromEntries(Object.entries(count).map(([k, c]) => [k, c / n]));
  };
  const all = shares(true);
  assert.equal(all.rifle, undefined, 'every fighter carries a rifle: none falls');
  assert.ok(Math.abs(all.ammo - (weight('ammo') + weight('rifle'))) < 0.01, `ammo ${all.ammo}: its old share (0.30) back`);
  for (const k of ['claymore', 'nades', 'medkit', 'scope', 'armor', 'lull', 'gun']) assert.ok(Math.abs(all[k] - weight(k)) < 0.01, `${k} keeps its share: ${all[k]}`);
  const some = shares(false);
  assert.ok(Math.abs(some.rifle - weight('rifle')) < 0.01, `one fighter without: the rifle falls, ${some.rifle}`);
  assert.ok(Math.abs(some.ammo - weight('ammo')) < 0.01);
});

test('an assault rifle: yours when you carry none; refused while you carry one, or when nothing is said, and it stays', () => {
  const loot = new Loot(nav, seeded());
  const r = loot.put('rifle', 0, 0, 0, 0);
  assert.equal(loot.take('a', { ...at(), guns: ['pistol', 'rifle'] }, r.id, 1), null, 'one carried already');
  assert.equal(loot.take('a', { ...at(), guns: ['pistol', 'rifle', 'shotgun', 'sniper'] }, r.id, 1), null);
  assert.equal(loot.take('a', { ...at(), guns: undefined }, r.id, 1), null, 'nothing said: nothing given');
  assert.equal(loot.take('a', { ...at(), guns: 'pistol' }, r.id, 1), null);
  assert.ok(loot.items.has(r.id), 'it stays for a teammate');
  const got = loot.take('b', { ...at(), guns: ['pistol', 'shotgun'] }, r.id, 1);
  assert.equal(got.kind, 'rifle');
  assert.equal(got.w, 'rifle');
  assert.equal(loot.items.has(r.id), false, 'taken once');
  assert.deepEqual(loot.kit('b').ammo, [], 'not mistaken for an ammo pack');
  assert.equal(loot.take('a', { ...at(), guns: ['pistol'] }, r.id, 1), null, 'gone');
});

test('a music box plays where it lay and slows the zombies near it, for its time', () => {
  const loot = new Loot(nav);
  const box = loot.put('lull', 10, 0, 10, 0);
  loot.take('a', at(10.8, 0, 10.5), box.id, 1000);
  const [[, x, y, z]] = loot.view().lulls;
  assert.deepEqual([x, y, z], [10, 0, 10], 'where it lay, not where its taker stood');
  const near = { id: 1, kind: 0, act: 'walk', x: 14, y: 0, z: 10 };
  const big = { id: 2, kind: BIG, act: 'walk', x: 10, y: 0, z: 16 };
  const far = { id: 3, kind: 0, act: 'walk', x: 18, y: 0, z: 10 };
  const up = { id: 4, kind: 0, act: 'walk', x: 11, y: 4, z: 10 };
  loot.tick(2000, [near, big, far, up]);
  assert.equal(near.lull, LOOT.lullSlow);
  assert.equal(near.lullUntil, 2000 + LOOT.lullHold);
  assert.equal(big.lull, LOOT.lullBigSlow);
  assert.equal(far.lull, undefined, '8 m off');
  assert.equal(up.lull, undefined, '4 m up');
  const { faded } = loot.tick(1000 + LOOT.lullMs, [near]);
  assert.equal(faded.length, 1);
  assert.equal(loot.view().lulls.length, 0);
  // At most LOOT.lullsAll at once: the oldest stops.
  for (let i = 0; i < LOOT.lullsAll + 1; i++) loot.take('a', at(i * 3, 0, 0), loot.put('lull', i * 3, 0, 0, 0).id, 20000);
  assert.equal(loot.lulls.size, LOOT.lullsAll);
  assert.ok(!loot.view().lulls.some(([, lx]) => lx === 0), 'the first one stopped');
});

test('a zombie in the music box\'s circle walks at about 30% of its pace', () => {
  const run = (lulled) => {
    let r = 17;
    const h = new Horde(nav, nav.spawnSpots(), { home: { x: 0, z: 0 }, rand: () => ((r = (r * 1664525 + 1013904223) >>> 0) / 2 ** 32) });
    h.selectWave(0, 1, 1);
    Object.assign(h, { toSpawn: 0, bigs: 0 }); // only the zombie below
    const node = nav.locate(20, 0.3, 0, 0.6);
    const z = { id: 1, kind: 0, x: 20, y: nav.y(node, 20, 0), z: 0, node, yaw: -Math.PI / 2, speed: 0, top: 1, hp: 50, max: 50, damage: 10, act: 'walk', actAt: 0, until: 0, struck: false, next: 0, downAt: 0, target: null };
    h.zombies.set(1, z);
    const loot = new Loot(nav);
    if (lulled) loot.take('a', at(20, 0, 0), loot.put('lull', 20, 0, 0, 0).id, 0);
    const players = [{ name: 'a', x: 0, y: 0, z: 0, alive: true, fighter: true, safe: false }];
    for (let now = 50; now <= 3000; now += 50) {
      loot.tick(now, h.zombies.values());
      h.tick(now, 0.05, players);
    }
    return 20 - z.x;
  };
  const free = run(false), slowed = run(true);
  assert.ok(free > 1, `it walks (${free} m)`);
  assert.ok(Math.abs(slowed / free - LOOT.lullSlow) < 0.06, `${slowed.toFixed(2)} m of ${free.toFixed(2)} m`);
});
