// The stall in the Zombies game (shared/stall.mjs): what a zombie and a wave pay, what each thing
// costs, and that a purchase is refused, at no cost, outside the break, when short, or when it would
// give nothing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { arenaEdge, ARENAS, portalOf, villageGround } from './arenas.mjs';
import { loadBounds, makeBounds } from './bounds.mjs';
import { makeChurch } from './church.mjs';
import { LOOT, Loot } from './loot.mjs';
import { PORTALS } from './portals.mjs';
import { makeCafe } from './sparrenhof.mjs';
import { bonusOf, priceOf, Stall, STALL, STALL_SPOTS, stallBox, stallReach, stallSpot } from './stall.mjs';
import { makeTerrain } from './terrain.mjs';
import { house as HOUSE } from './testData.mjs';
import { BIG, houseAreas, makeNav, RUNNER, runnersOf, waveSize } from './zombies.mjs';
import { noShoot } from './zones.mjs';

const nav = makeNav({ prisms: [], height: () => 0, edge: makeBounds([[-40, -40], [40, -40], [40, 40], [-40, 40]]) });
/** A player who may get anything: hurt, with only the pistol. */
const at = (hp = 40) => ({ x: 0, y: 0, z: 0, w: 'pistol', hp, guns: ['pistol'] });
/** The stall, at the buyer's feet. */
const HERE = Object.freeze({ x: 0, y: 0, z: 0 });
const KINDS = STALL.items.map(([k]) => k);
const BAD = ['__proto__', 'constructor', 'toString', '', 'ammo', 'scope', 'stakes', 'lull', 5, null, undefined, {}, ['medkit'], 'MEDKIT'];

test('the six things, in order, and the table cannot be changed', () => {
  assert.deepEqual(KINDS, ['medkit', 'nades', 'claymore', 'armor', 'gun', 'turret']);
  assert.ok(Object.isFrozen(STALL) && Object.isFrozen(STALL.items) && Object.isFrozen(STALL.kill));
  for (const row of STALL.items) assert.ok(Object.isFrozen(row));
  assert.throws(() => {
    'use strict';
    STALL.items[0][1] = 0;
  });
});

test('every price is a safe positive integer, never falls, and stops rising after twenty purchases', () => {
  for (const kind of KINDS) {
    let last = 0;
    for (let n = 0; n <= 1000; n++) {
      const p = priceOf(kind, n);
      assert.ok(Number.isSafeInteger(p) && p > 0, `${kind} ${n}: ${p}`);
      assert.ok(p >= last, `${kind} ${n}: falls`);
      if (n > STALL.steps) assert.equal(p, priceOf(kind, STALL.steps), `${kind} ${n}: rises after ${STALL.steps}`);
      last = p;
    }
    for (const n of [-1, 1.5, NaN, Infinity, '3', null]) assert.equal(priceOf(kind, n), priceOf(kind, 0), `${kind} with ${n}`);
  }
  assert.equal(priceOf('turret', STALL.steps), 6600);
  assert.equal(priceOf('medkit', 0), 100);
  assert.equal(priceOf('medkit', 1), 150);
  for (const k of BAD) assert.equal(priceOf(k, 0), 0, String(k));
});

test('a walker pays 10, a runner 15, a big one 100, to the cap', () => {
  const s = new Stall();
  assert.equal(s.earn('a', 0), 10);
  assert.equal(s.earn('a', 2), 20);
  assert.equal(s.earn('a', RUNNER), 35);
  assert.equal(s.earn('a', BIG), 135);
  assert.equal(s.of('b'), 0, 'nobody else');
  s.coins.set('a', STALL.max - 5);
  assert.equal(s.earn('a', BIG), STALL.max);
  assert.equal(s.earn('a', 0), STALL.max);
});

test('the wave bonus: 20 + 5 a wave to 100, half when down, nothing for a bad wave', () => {
  assert.equal(bonusOf(1), 25);
  assert.equal(bonusOf(3), 35);
  assert.equal(bonusOf(16), 100);
  assert.equal(bonusOf(500), 100);
  for (const w of [0, -1, 1.5, NaN, Infinity, '3', null, undefined]) assert.equal(bonusOf(w), 0, String(w));
  const s = new Stall();
  const got = s.cleared(['a', 'b', 'a'], ['c', 'a'], 3);
  assert.deepEqual([...got], [['a', 35], ['b', 35], ['c', 17]]);
  assert.equal(s.of('a'), 35, 'once a name');
  assert.equal(s.of('c'), 17);
  assert.equal(s.cleared(['a'], ['c'], 0).size, 0);
  assert.equal(s.of('a'), 35);
});

test('anything not sold changes nothing', () => {
  const s = new Stall();
  const loot = new Loot(nav);
  s.coins.set('a', 5000);
  for (const k of BAD) {
    const r = s.buy(loot, 'a', at(), k, 'break', 0, HERE);
    assert.deepEqual(r, { why: 'kind' }, String(k));
  }
  assert.equal(s.of('a'), 5000);
  assert.equal(s.bought.size, 0);
  assert.deepEqual(loot.kit('a'), { ammo: [], scope: false, claymores: 0, stakes: 0, turrets: 0, armor: 0, nades: 0 });
});

test('outside the break the stall is shut', () => {
  const s = new Stall();
  const loot = new Loot(nav);
  s.coins.set('a', 5000);
  for (const phase of ['wave', 'over', 'idle', '', undefined, 'BREAK', 'break ']) {
    for (const k of KINDS) assert.deepEqual(s.buy(loot, 'a', at(), k, phase, 0, HERE), { why: 'shut' }, `${phase} ${k}`);
  }
  assert.equal(s.of('a'), 5000);
});

test('one coin short is refused; the exact price leaves nothing; the next one costs more', () => {
  for (const kind of KINDS) {
    const s = new Stall();
    const loot = new Loot(nav);
    const price = priceOf(kind, 0);
    s.coins.set('a', price - 1);
    assert.deepEqual(s.buy(loot, 'a', at(), kind, 'break', 0, HERE), { why: 'short' }, kind);
    assert.equal(s.of('a'), price - 1);
    s.coins.set('a', price);
    const r = s.buy(loot, 'a', at(), kind, 'break', 0, HERE);
    assert.equal(r.price, price, kind);
    assert.equal(r.got.kind, kind);
    assert.equal(s.of('a'), 0);
    assert.deepEqual(s.view('a').n, KINDS.map((k) => (k === kind ? 1 : 0)));
    assert.equal(priceOf(kind, s.view('a').n[KINDS.indexOf(kind)]), price + STALL.items[KINDS.indexOf(kind)][2]);
  }
});

test('each refusal of the table costs nothing', () => {
  const full = (setup, p, kind) => {
    const s = new Stall();
    const loot = new Loot(nav);
    setup(loot.kit('a'));
    s.coins.set('a', 5000);
    assert.deepEqual(s.buy(loot, 'a', p, kind, 'break', 0, HERE), { why: 'full' }, kind);
    assert.equal(s.of('a'), 5000, kind);
    assert.deepEqual(s.view('a').n, [0, 0, 0, 0, 0, 0]);
  };
  for (const hp of [100, 90, 86, NaN, undefined, '40']) full(() => {}, { ...at(), hp }, 'medkit');
  full((k) => (k.nades = LOOT.nadesCarry), at(), 'nades');
  full((k) => (k.claymores = LOOT.carry), at(), 'claymore');
  full((k) => (k.armor = LOOT.armor), at(), 'armor');
  full(() => {}, { ...at(), guns: ['pistol', 'rifle', 'shotgun', 'sniper'] }, 'gun');
  full(() => {}, { ...at(), guns: undefined }, 'gun');
  full((k) => (k.turrets = 1), at(), 'turret');
});

test('the effects are the pick-up\'s', () => {
  const s = new Stall();
  const loot = new Loot(nav, () => 0);
  s.coins.set('a', STALL.max);
  assert.equal(s.buy(loot, 'a', at(40), 'medkit', 'break', 0, HERE).got.heal, LOOT.heal);
  assert.equal(s.buy(loot, 'a', at(80), 'medkit', 'break', 0, HERE).got.heal, 20);
  assert.equal(s.buy(loot, 'a', at(), 'nades', 'break', 0, HERE).got.kit.nades, LOOT.nades);
  assert.equal(s.buy(loot, 'a', at(), 'claymore', 'break', 0, HERE).got.kit.claymores, 1);
  assert.equal(s.buy(loot, 'a', at(), 'armor', 'break', 0, HERE).got.kit.armor, LOOT.armor);
  assert.equal(s.buy(loot, 'a', { ...at(), guns: ['pistol', 'rifle', 'sniper'] }, 'gun', 'break', 0, HERE).got.w, 'shotgun');
  assert.equal(s.buy(loot, 'a', at(), 'turret', 'break', 0, HERE).got.kit.turrets, 1);
  assert.equal(loot.items.size, 0, 'nothing put on the ground');
  assert.equal(loot.lulls.size, 0);
});

test('one player\'s purchases leave another\'s prices and coins alone', () => {
  const s = new Stall();
  const loot = new Loot(nav);
  s.coins.set('a', 5000);
  s.coins.set('b', 5000);
  for (let i = 0; i < 2; i++) assert.ok(s.buy(loot, 'a', at(), 'claymore', 'break', 0, HERE).got);
  assert.deepEqual(s.view('b'), { c: 5000, n: [0, 0, 0, 0, 0, 0] });
  assert.equal(s.buy(loot, 'b', at(), 'claymore', 'break', 0, HERE).price, 150);
  assert.equal(loot.kit('b').claymores, 1);
  assert.equal(s.of('a'), 5000 - 150 - 200);
});

test('the view is a copy', () => {
  const s = new Stall();
  const v = s.view('a');
  v.n[0] = 99;
  v.c = 99;
  assert.deepEqual(s.view('a'), { c: 0, n: [0, 0, 0, 0, 0, 0] });
});

test('waves 1 to 3 alone pay 305: two cheap things, or the crate, or half a turret', () => {
  const s = new Stall();
  for (let w = 1; w <= 3; w++) {
    const size = waveSize(w, 1);
    const runners = runnersOf(w, size);
    for (let i = 0; i < size; i++) s.earn('me', i < runners ? RUNNER : 0);
    s.cleared(['me'], [], w);
  }
  assert.equal(s.of('me'), 305);
  assert.ok(priceOf('medkit', 0) + priceOf('nades', 0) <= 305);
  assert.ok(priceOf('gun', 0) <= 305);
  assert.ok(priceOf('turret', 0) / 2 <= 305 && priceOf('turret', 0) > 305);
});

test('the reach: within STALL.reach on the plan and STALL.rise up or down, measured to the stall', () => {
  const buy = (p, where, kind = 'medkit', phase = 'break', coins = 5000) => {
    const s = new Stall();
    const loot = new Loot(nav);
    s.coins.set('a', coins);
    const r = s.buy(loot, 'a', p, kind, phase, 0, where);
    return { r, s, loot };
  };
  const p = (x, y = 0, z = 0) => ({ ...at(), x, y, z });
  assert.ok(buy(p(3.5), HERE).r.got, '3.5 m buys');
  assert.ok(buy(p(0, 0, -3.5), HERE).r.got, 'any side');
  assert.ok(buy(p(0, 1.6), HERE).r.got, '1.6 m above');
  for (const [why, pos, where] of [
    ['3.51 m', p(3.51), HERE],
    ['2.5 m by 2.5 m', p(2.5, 0, 2.5), HERE],
    ['1.7 m above', p(0, 1.7), HERE],
    ['1.7 m below', p(0, -1.7), HERE],
    ['no stall', p(0), undefined],
    ['a null stall', p(0), null],
    ['an empty stall', p(0), {}],
    ['NaN', p(0), { x: NaN, y: 0, z: 0 }],
    ['Infinity', p(0), { x: 0, y: Infinity, z: 0 }],
    ['a string', p(0), { x: '0', y: 0, z: 0 }],
    ['a NaN position', p(NaN), HERE],
    ['no height', { ...at(), y: undefined }, HERE],
  ]) {
    const { r, s, loot } = buy(pos, where);
    assert.deepEqual(r, { why: 'far' }, why);
    assert.equal(s.of('a'), 5000, `${why}: costs nothing`);
    assert.deepEqual(s.view('a').n, [0, 0, 0, 0, 0, 0], `${why}: counts nothing`);
    assert.deepEqual(loot.kit('a'), { ammo: [], scope: false, claymores: 0, stakes: 0, turrets: 0, armor: 0, nades: 0 }, `${why}: gives nothing`);
  }
  // The order: the kind, the break, the reach, then the coins.
  assert.deepEqual(buy(p(30), HERE, 'medkit', 'wave').r, { why: 'shut' }, 'far in a wave: shut');
  assert.deepEqual(buy(p(30), HERE, 'medkit', 'break', 0).r, { why: 'far' }, 'far and short: far');
  assert.deepEqual(buy(p(30), HERE, '__proto__').r, { why: 'kind' }, 'a bad kind from far: kind');
  assert.equal(stallReach(p(1), HERE), true);
  assert.equal(stallReach(null, HERE), false);
  assert.equal(stallReach(p(1), null), false);
});

test('the spots: one for every Zombies place, found by a Map, and frozen', () => {
  for (const a of ARENAS) {
    const s = stallSpot(a.id);
    assert.ok(s && [s.x, s.z, s.yaw].every(Number.isFinite), a.id);
    assert.deepEqual(stallBox(a.id), { x: s.x, z: s.z, yaw: s.yaw, halfL: STALL.box.halfL, halfW: STALL.box.halfW });
  }
  assert.equal(STALL_SPOTS.length, ARENAS.length);
  for (const id of ['__proto__', 'constructor', 'toString', 5, null, undefined, {}, '', 'HOUSE']) {
    assert.equal(stallSpot(id), null, String(id));
    assert.equal(stallBox(id), null, String(id));
  }
  assert.ok(Object.isFrozen(STALL_SPOTS) && STALL_SPOTS.every(Object.isFrozen) && Object.isFrozen(STALL.box) && Object.isFrozen(stallSpot('house')));
  assert.throws(() => {
    'use strict';
    STALL_SPOTS[0][1] = 0;
  });
});

// The ground at every spot, on the zombies' grid as server/game.mjs builds it.
const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const TERRAIN = makeTerrain(read('./terrain.json'));
const BOUNDS = loadBounds(read('./bounds.json'));
const VILLAGE = read('../src/data/village.json');
const SPAWNS = read('./spawns.json');
const CHURCH_DATA = read('./church.json');
const CHURCH = makeChurch(CHURCH_DATA, HOUSE.ground + TERRAIN.height(...CHURCH_DATA.origin));
const CAFE_DATA = read('./sparrenhof.json');
const CAFE = makeCafe(CAFE_DATA, HOUSE.ground + TERRAIN.height(...CAFE_DATA.origin), read('./tree_huts.json'));
const ZOMBIE_PRISMS = [...HOUSE.prisms, ...(HOUSE.surroundings?.prisms ?? []), ...Object.values(read('../src/data/homestreet.json').clusters).flatMap((c) => c.blocks ?? [])];
const height = (x, z) => TERRAIN.height(x, z);
const groundNav = (a, boxes) => {
  const edge = arenaEdge(a, BOUNDS);
  const v = a.center ? villageGround(a, edge, VILLAGE, CHURCH, CAFE) : null;
  const nav = v
    ? makeNav({ prisms: v.prisms, height, base: HOUSE.ground, edge, boxes, areas: v.areas, doors: [], shut: true, panes: 0 })
    : makeNav({ prisms: ZOMBIE_PRISMS, height, base: HOUSE.ground, edge, boxes, areas: houseAreas(HOUSE.prisms), doors: HOUSE.doors, shut: false, panes: HOUSE.prisms.length });
  return { nav, edge };
};

test('every spot stands on open, level ground, clear of the portals, with room in front and joined to the start', () => {
  for (const a of ARENAS) {
    const s = stallSpot(a.id);
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw); // its front (the game's yaw)
    const ax = -fz, az = fx; // along the table
    const { nav, edge } = groundNav(a, []);
    let lo = Infinity, hi = -Infinity;
    for (let u = -(STALL.box.halfW + 1.25); u <= STALL.box.halfW + 1.25 + 1e-6; u += 0.25) {
      for (let v = -(STALL.box.halfL + 1.25); v <= STALL.box.halfL + 2.2 + 1e-6; v += 0.25) {
        const px = s.x + ax * u + fx * v, pz = s.z + az * u + fz * v;
        assert.ok(nav.walkable(px, pz) && !nav.inHouse(px, pz), `${a.id}: (${px.toFixed(2)}, ${pz.toFixed(2)}) is open ground`);
        lo = Math.min(lo, height(px, pz));
        hi = Math.max(hi, height(px, pz));
      }
    }
    assert.ok(hi - lo <= 0.3, `${a.id}: a slope of ${(hi - lo).toFixed(2)} m`);
    assert.ok(edge.depth(s.x, s.z) >= 6, `${a.id}: ${edge.depth(s.x, s.z).toFixed(1)} m inside the edge`);
    assert.equal(noShoot(s.x, s.z), null, `${a.id}: not on the school grounds`);
    const stand = { x: s.x + fx * 1.3, z: s.z + fz * 1.3 };
    for (const pad of PORTALS) {
      assert.ok(Math.hypot(pad.x - s.x, pad.z - s.z) >= 4.5, `${a.id}: clear of the ${pad.id} pad`);
      assert.ok(Math.hypot(pad.x - stand.x, pad.z - stand.z) > 3, `${a.id}: the buyer clear of the ${pad.id} pad`);
    }
    // With the stall in the grid: its square shut, the buyer's open and joined to where the players start.
    const { nav: withBox } = groundNav(a, [stallBox(a.id)]);
    assert.equal(withBox.walkable(s.x, s.z), false, `${a.id}: zombies walk round it`);
    assert.ok(withBox.walkable(stand.x, stand.z), `${a.id}: room in front`);
    const portal = portalOf(a);
    const start = a.id === 'house' ? SPAWNS[0] : { x: portal.out[0], z: portal.out[1] };
    const node = (x, z) => withBox.locate(x, HOUSE.ground + height(x, z), z);
    assert.ok(withBox.joined(node(stand.x, stand.z), node(start.x, start.z)), `${a.id}: the buyer can walk there from the start`);
    assert.ok(withBox.spawnSpots().length > 0, `${a.id}: zombies still come out`);
  }
});
