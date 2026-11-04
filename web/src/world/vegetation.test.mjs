import test from 'node:test';
import assert from 'node:assert/strict';
import { treeCrown, treeTrunk } from './vegetation.ts';

test('shared canopies stay closed, finite and within the near and far triangle budgets', () => {
  for (const simple of [false, true]) for (const seed of [1234, 2233, 3232]) {
    const geometry = treeCrown(seed, simple);
    assert.ok(geometry.index.count / 3 <= (simple ? 180 : 1000));
    const edges = new Map();
    const index = geometry.index.array;
    for (let i = 0; i < index.length; i += 3) for (let j = 0; j < 3; j++) {
      const a = index[i + j], b = index[i + (j + 1) % 3];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    assert.ok([...edges.values()].every((count) => count === 2), 'a canopy must not have open seams');
    for (const name of ['position', 'normal', 'color']) assert.ok([...geometry.getAttribute(name).array].every(Number.isFinite));
    const normal = geometry.getAttribute('normal');
    for (let i = 0; i < normal.count; i++) assert.ok(Math.abs(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)) - 1) < 1e-5);
    geometry.dispose();
  }
});

test('trunk forks share one small geometry with valid lighting normals', () => {
  const geometry = treeTrunk();
  assert.ok(geometry.index.count / 3 <= 60);
  for (const name of ['position', 'normal', 'color']) assert.ok([...geometry.getAttribute(name).array].every(Number.isFinite));
  geometry.dispose();
});
