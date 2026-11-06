import test from 'node:test';
import assert from 'node:assert/strict';
import { sameText } from './constant-time-text.mjs';

test('exact text comparison preserves ASCII and Unicode password behaviour', () => {
  for (const value of ['', 'test value', 'é🔑', 'x'.repeat(4096)]) assert.equal(sameText(value, value), true);
  for (const [a, b] of [['a', 'b'], ['short', 'longer'], ['é', 'e'], ['é', 'e\u0301'], ['x', 'x\0'], ['\0', '']]) {
    assert.equal(sameText(a, b), false);
    assert.equal(sameText(b, a), false);
  }
});
