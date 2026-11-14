// The stall in the Zombies game (shared/stall.mjs): what a zombie and a wave pay, what each thing
// costs, and that a purchase is refused, at no cost, outside the break, when short, or when it would
// give nothing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeBounds } from './bounds.mjs';
import { LOOT, Loot } from './loot.mjs';
import { bonusOf, priceOf, Stall, STALL } from './stall.mjs';
import { BIG, makeNav, RUNNER, runnersOf, waveSize } from './zombies.mjs';

const nav = makeNav({ prisms: [], height: () => 0, edge: makeBounds([[-40, -40], [40, -40], [40, 40], [-40, 40]]) });
/** A player who may get anything: hurt, with only the pistol. */
const at = (hp = 40) => ({ x: 0, y: 0, z: 0, w: 'pistol', hp, guns: ['pistol'] });
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
    const r = s.buy(loot, 'a', at(), k, 'break', 0);
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
    for (const k of KINDS) assert.deepEqual(s.buy(loot, 'a', at(), k, phase, 0), { why: 'shut' }, `${phase} ${k}`);
  }
  assert.equal(s.of('a'), 5000);
});

test('one coin short is refused; the exact price leaves nothing; the next one costs more', () => {
  for (const kind of KINDS) {
    const s = new Stall();
    const loot = new Loot(nav);
    const price = priceOf(kind, 0);
    s.coins.set('a', price - 1);
    assert.deepEqual(s.buy(loot, 'a', at(), kind, 'break', 0), { why: 'short' }, kind);
    assert.equal(s.of('a'), price - 1);
    s.coins.set('a', price);
    const r = s.buy(loot, 'a', at(), kind, 'break', 0);
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
    assert.deepEqual(s.buy(loot, 'a', p, kind, 'break', 0), { why: 'full' }, kind);
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
  assert.equal(s.buy(loot, 'a', at(40), 'medkit', 'break', 0).got.heal, LOOT.heal);
  assert.equal(s.buy(loot, 'a', at(80), 'medkit', 'break', 0).got.heal, 20);
  assert.equal(s.buy(loot, 'a', at(), 'nades', 'break', 0).got.kit.nades, LOOT.nades);
  assert.equal(s.buy(loot, 'a', at(), 'claymore', 'break', 0).got.kit.claymores, 1);
  assert.equal(s.buy(loot, 'a', at(), 'armor', 'break', 0).got.kit.armor, LOOT.armor);
  assert.equal(s.buy(loot, 'a', { ...at(), guns: ['pistol', 'rifle', 'sniper'] }, 'gun', 'break', 0).got.w, 'shotgun');
  assert.equal(s.buy(loot, 'a', at(), 'turret', 'break', 0).got.kit.turrets, 1);
  assert.equal(loot.items.size, 0, 'nothing put on the ground');
  assert.equal(loot.lulls.size, 0);
});

test('one player\'s purchases leave another\'s prices and coins alone', () => {
  const s = new Stall();
  const loot = new Loot(nav);
  s.coins.set('a', 5000);
  s.coins.set('b', 5000);
  for (let i = 0; i < 2; i++) assert.ok(s.buy(loot, 'a', at(), 'claymore', 'break', 0).got);
  assert.deepEqual(s.view('b'), { c: 5000, n: [0, 0, 0, 0, 0, 0] });
  assert.equal(s.buy(loot, 'b', at(), 'claymore', 'break', 0).price, 150);
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
