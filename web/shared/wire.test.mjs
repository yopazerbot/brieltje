// The `aim` flag in a player's state (shared/wire.mjs): the gun at their eye, for how the others see them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLAG, playerFields, readPlayer } from './wire.mjs';

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
