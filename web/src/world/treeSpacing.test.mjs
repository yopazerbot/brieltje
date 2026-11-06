import test from 'node:test';
import assert from 'node:assert/strict';
import { spaceTrees, CROWN_REACH } from './treeSpacing.ts';

const R = (t) => t.r;
const bottom = (t) => t.h * 0.4;
const tree = (x, z, r = 3, h = 10) => ({ x, z, y: 0, h, r });

test('two crowns never overlap: the shorter tree shrinks or is dropped', () => {
  const trees = [tree(0, 0), tree(4, 0), tree(20, 0)];
  const share = spaceTrees(trees, [], R, bottom);
  assert.equal(share[0], 1);
  assert.equal(share[2], 1);
  for (const i of [0, 1]) for (const j of [0, 1]) if (i < j && share[i] && share[j]) {
    assert.ok(Math.hypot(trees[i].x - trees[j].x, trees[i].z - trees[j].z) >= (R(trees[i]) * share[i] + R(trees[j]) * share[j]) * CROWN_REACH - 1e-9);
  }
  assert.ok(share[1] < 1);
});

test('a crown keeps clear of a tall hedge, and passes over a low one', () => {
  const ring = [[3, -10], [4, -10], [4, 10], [3, 10]];
  const t = [tree(0, 0)];
  const tall = spaceTrees(t, [{ ring, height: 6 }], R, bottom);
  assert.ok(tall[0] < 1);
  assert.ok(3 >= 3 * CROWN_REACH * tall[0] || tall[0] === 0);
  assert.equal(spaceTrees(t, [{ ring, height: 1 }], R, bottom)[0], 1);
});

test('the answer is the same whatever order the trees come in', () => {
  const a = [tree(0, 0), tree(3, 1, 3, 12), tree(-4, 2)];
  const s1 = spaceTrees(a, [], R, bottom);
  const s2 = spaceTrees([a[2], a[0], a[1]], [], R, bottom);
  assert.deepEqual([s2[1], s2[2], s2[0]], s1);
});
