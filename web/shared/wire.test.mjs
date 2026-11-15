// The `aim` flag in a player's state (shared/wire.mjs): the gun at their eye, for how the others see them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bikeFields, FLAG, heliFields, playerFields, readBike, readHeli, readPlayer } from './wire.mjs';

const state = { x: 1, y: 2, z: 3, yaw: 0.5, pitch: 0.1, armed: true, flying: false, w: 'sniper', c: false };

test('aiming travels in the flags and comes out again', () => {
  const aiming = readPlayer(['anna', 0, ...playerFields({ ...state, a: true }, true, false, 0)]);
  assert.equal(aiming.aim, true);
  assert.equal(aiming.armed, true);
  assert.equal(aiming.w, 'sniper');
  assert.equal(readPlayer(['anna', 0, ...playerFields(state, true, false, 0)]).aim, false);
});

test('the aim bit leaves every older flag and the teleport counter alone', () => {
  const full = { ...state, flying: true, c: true, d: true, chute: true, open: true, bk: true };
  for (const warp of [0, 1, 2, 3]) {
    const without = readPlayer(['a', 0, ...playerFields(full, true, true, warp)]);
    const withAim = readPlayer(['a', 0, ...playerFields({ ...full, a: true }, true, true, warp)]);
    assert.deepEqual({ ...withAim, aim: false }, without);
    assert.equal(withAim.warp, warp);
  }
  assert.equal(FLAG.aim, 2048);
});

// A bike knocked over by a car (shared/bikeKnock.mjs): the side it lies on, last in its entry.
test('a lying bike travels in the tick; an entry from before it reads as standing', () => {
  const bike = { x: 1.234, y: 0.5, z: -3.456, yaw: 0.7, rider: null };
  for (const lie of [1, -1, 0]) assert.equal(readBike(['house', 0, ...bikeFields({ ...bike, lie })]).lie, lie);
  for (const lie of [2, '1', NaN, undefined, null]) assert.equal(bikeFields({ ...bike, lie })[5], 0, String(lie));
  const old = readBike(['house', 12, 1.23, 0.5, -3.46, 0.7, 'anna']);
  assert.deepEqual(old, { id: 'house', age: 12, x: 1.23, y: 0.5, z: -3.46, yaw: 0.7, rider: 'anna', lie: 0 });
  assert.equal(readBike(['house', 0, 1, 0, 1, 0, null, 7]).lie, 0, 'a made-up side reads as standing');
});

// A helicopter (server/helis.mjs): its pose, its rotor and who sits where, in its tick entry.
test('a helicopter travels in the tick and comes out again; a hostile entry reads as zeros and empty seats', () => {
  const h = { x: -32.123, y: 41.5, z: -8.456, yaw: 3.5, p: 0.25, r: -0.4, n: 0.876, g: 0, seats: ['anna', null, 'bert', null] };
  const back = readHeli(['house', 40, ...heliFields(h)]);
  const yaw = Math.round(Math.atan2(Math.sin(3.5), Math.cos(3.5)) * 1000) / 1000;
  assert.deepEqual(back, { id: 'house', age: 40, x: -32.12, y: 41.5, z: -8.46, yaw, p: 0.25, r: -0.4, n: 0.88, g: 0, seats: ['anna', null, 'bert', null] });
  assert.equal(readHeli(['house', 0, ...heliFields({ ...h, g: 1 })]).g, 1);
  assert.equal(heliFields({ x: 0, y: 0, z: 0, yaw: 0 }).length, 12, 'no seats given: four empty ones');
  const hostile = readHeli(['house', '9', 'x', {}, [], null, '1', true, NaN, '1', { name: 'a' }, ['b'], 7, '<b>']);
  assert.deepEqual(hostile, { id: 'house', age: 0, x: 0, y: 0, z: 0, yaw: 0, p: 0, r: 0, n: 0, g: 0, seats: [null, null, null, '<b>'] });
  assert.deepEqual(readHeli(['house', 0]).seats, [null, null, null, null], 'a short entry: empty seats');
});
