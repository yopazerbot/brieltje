import test from 'node:test';
import assert from 'node:assert/strict';
import { homeAt } from '../../shared/homes.mjs';
import { AloneFurniture, scrubFurniture } from './furnitureStore.ts';

// A localStorage of its own for each test.
function storage(init = {}) {
  const m = new Map(Object.entries(init));
  const s = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
  globalThis.localStorage = new Proxy(s, { ownKeys: () => [...m.keys()], getOwnPropertyDescriptor: (_, k) => (m.has(k) ? { enumerable: true, configurable: true, value: m.get(k) } : undefined) });
  return m;
}
const INSIDE = { x: 4, y: 1, z: 5 }; // the main house's ground floor
const OUT = { x: 100, y: 0, z: 100 }; // nowhere near a home
const TERRACE = { x: 20, y: 0, z: 20 }; // a starting piece outside the home's rooms
const piece = (id, at, item = 'chair') => ({ id, item, yaw: 0, ...at });
const layouts = [{ id: 'house', pieces: [['bed', INSIDE.x, INSIDE.y, INSIDE.z, 0], ['bench', TERRACE.x, TERRACE.y, TERRACE.z, 0]] }];

test('the points used here are where the test says', () => {
  assert.equal(homeAt(INSIDE.x, INSIDE.z, INSIDE.y), 'house');
  assert.equal(homeAt(OUT.x, OUT.z, OUT.y), null);
  assert.equal(homeAt(TERRACE.x, TERRACE.z, TERRACE.y), null);
});

test('a home\'s starting pieces and anything inside a home are never stored; the rest is', () => {
  const m = storage();
  const f = new AloneFurniture();
  const list = f.seedHome('house', layouts, [piece(-1, OUT)]);
  assert.equal(list.length, 3);
  f.save([...list, piece(-50, INSIDE, 'lamp')]);
  const stored = JSON.parse(m.get('briel.furnitureAlone'));
  assert.deepEqual(stored.map((p) => p.id), [-1], 'only the piece put outside the homes');
  // In memory for the visit: loading again (leaving the others) brings them all back, without a second seed.
  const again = f.load(layouts);
  assert.deepEqual(again.map((p) => p.item).sort(), ['bed', 'bench', 'chair', 'lamp']);
  assert.equal(f.seedHome('house', layouts, again), null, 'once a visit');
});

test('a new visit starts from the starting layout again, the stored pieces kept', () => {
  storage({ 'briel.furnitureAlone': JSON.stringify([piece(-1, OUT)]) });
  const f = new AloneFurniture();
  assert.deepEqual(f.load([]).map((p) => p.id), [-1]);
  const list = f.seedHome('house', layouts, f.load([]));
  assert.deepEqual(list.map((p) => p.item).sort(), ['bed', 'bench', 'chair']);
  assert.equal(new Set(list.map((p) => p.id)).size, 3, 'no id twice');
});

test('scrub: an old list that held an inside goes whole, with the restore numbers', () => {
  const m = storage({ 'briel.furniture': JSON.stringify([piece(-1, INSIDE), piece(-2, TERRACE), piece(-3, OUT)]), 'briel.furnitureRestore.house': '3', 'briel.furnitureRestore': '2', 'briel.lang': 'nl' });
  scrubFurniture();
  assert.deepEqual([...m.keys()], ['briel.lang']);
});

test('scrub: an old list after a home was seeded goes whole, even with every piece outside', () => {
  const m = storage({ 'briel.furniture': JSON.stringify([piece(-2, TERRACE)]), 'briel.furnitureRestore.house': '3' });
  scrubFurniture();
  assert.equal(m.size, 0);
});

test('scrub: an old list that never held an inside is moved over', () => {
  const m = storage({ 'briel.furniture': JSON.stringify([piece(-3, OUT)]) });
  scrubFurniture();
  assert.deepEqual([...m.keys()], ['briel.furnitureAlone']);
  assert.deepEqual(JSON.parse(m.get('briel.furnitureAlone')).map((p) => p.id), [-3]);
});

test('scrub: a piece inside a home in the new list goes, an unreadable list goes', () => {
  let m = storage({ 'briel.furnitureAlone': JSON.stringify([piece(-1, INSIDE), piece(-3, OUT)]) });
  scrubFurniture();
  assert.deepEqual(JSON.parse(m.get('briel.furnitureAlone')).map((p) => p.id), [-3]);
  m = storage({ 'briel.furnitureAlone': '{nope' });
  scrubFurniture();
  assert.equal(m.size, 0);
});
