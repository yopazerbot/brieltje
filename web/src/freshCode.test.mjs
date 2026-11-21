// When the page loads again after a lazy part of the game failed to arrive (src/freshCode.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { AGAIN_MS, shouldReload } from './freshCode.ts';

const NOW = 1_800_000_000_000;

test('a part failed and the server answers: the page loads again, the first time', () => {
  assert.equal(shouldReload(true, 0, NOW), true);
  assert.equal(shouldReload(true, NaN, NOW), true, 'a stored value that is no number counts as never');
});

test('not when the server cannot be reached: playing on without the part is better than no page', () => {
  assert.equal(shouldReload(false, 0, NOW), false);
});

test('not twice within two minutes: a part that keeps failing never makes the page load for ever', () => {
  assert.equal(shouldReload(true, NOW - 1000, NOW), false);
  assert.equal(shouldReload(true, NOW - AGAIN_MS + 1, NOW), false);
  assert.equal(shouldReload(true, NOW - AGAIN_MS, NOW), true);
});

test('not in a tab whose storage cannot be read: a reload could not be counted', () => {
  assert.equal(shouldReload(true, null, NOW), false);
});
