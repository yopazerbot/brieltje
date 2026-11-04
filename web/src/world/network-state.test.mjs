import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

// Exercise the actual state-update methods without loading graphics assets in Node.
function method(file, signature, name) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const start = source.indexOf(signature);
  assert.ok(start >= 0);
  const end = source.indexOf('\n  }', start) + 4;
  const code = stripTypeScriptTypes(`class Subject { ${source.slice(start, end)} }`);
  const constants = source.match(/^const RESPAWN_S = \d+;/m)?.[0] ?? '';
  return new Function(`${constants}\n${code}; return Subject.prototype.${name};`)();
}
const invalid = ['__proto__', 'constructor', 'toString', 'map', 'length', '0', -1, 0.5, NaN, Infinity, null, {}];

test('network IDs cannot select prototypes or non-index properties for state updates', () => {
  const down = method('./cats.ts', '  down(i:', 'down');
  const pickup = method('./pickups.ts', '  setReady(i:', 'setReady');
  const solid = method('./collision.ts', '  setSolid(index:', 'setSolid');
  const horses = method('./horses.ts', '  setAll(list:', 'setAll');
  const cat = { deadUntil: 0 }, item = { ready: true, back: 0, model: { visible: true, userData: { ring: { visible: true } } } };
  const block = { off: false }, horse = { state: { parked: false, rider: '' }, track: { clear() {} } };
  for (const id of invalid) {
    down.call({ cats: [cat], now: 10 }, id, 15);
    pickup.call({ items: [item], clock: 10 }, id, false);
    solid.call({ solids: [block] }, id, false);
    horses.call({ horses: [horse], mounted: -1 }, [{ i: id, parked: true, rider: 'test', x: 4, z: 5, yaw: 1 }], 'me');
  }
  assert.equal(cat.deadUntil, 0);
  assert.equal(item.ready, true);
  assert.equal(block.off, false);
  assert.equal(horse.state.parked, false);
  for (const key of ['deadUntil', 'ready', 'back', 'off', 'state']) {
    assert.equal(Object.hasOwn(Array.prototype, key), false);
    assert.equal(Object.hasOwn(Array, key), false);
  }
  down.call({ cats: [cat], now: 10 }, 0, 15);
  pickup.call({ items: [item], clock: 10 }, 0, false);
  solid.call({ solids: [block] }, 0, false);
  horses.call({ horses: [horse], mounted: -1 }, [{ i: 0, parked: true, rider: 'test', x: 4, z: 5, yaw: 1 }], 'me');
  assert.equal(cat.deadUntil, 25);
  assert.equal(item.ready, false);
  assert.equal(item.back, 30);
  assert.equal(block.off, true);
  assert.equal(horse.x, 4);
});

test('glass only dispatches registered numeric callbacks and checks their type', () => {
  const solid = method('./glass.ts', '  private setSolid(index:', 'setSolid');
  const calls = [], fallback = [];
  const receiver = { others: new Map([[7, (broken) => calls.push(broken)], [8, {}]]), world: { setSolid: (...args) => fallback.push(args) } };
  for (const id of invalid) solid.call(receiver, id, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(fallback, []);
  solid.call(receiver, 7, false);
  solid.call(receiver, 8, true);
  assert.deepEqual(calls, [true]);
  assert.deepEqual(fallback, [[8, true]]);
});
