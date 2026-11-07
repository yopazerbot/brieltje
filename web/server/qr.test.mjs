// Our QR codes (server/qr.mjs): the error correction against the standard's worked example, the fixed
// patterns where a reader looks for them, the sizes, and too long refused. Run: node --test server/qr.test.mjs
// (They were also decoded with a reader for every length from version 1 to 10 when this was written.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { eccOf, qrMatrix, svgPath } from './qr.mjs';

test('the error correction bytes of the standard worked example (1-M, "01234567")', () => {
  const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
  assert.deepEqual(eccOf(data, 10), [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
});

test('the three finders, the timing lines and the dark module are where a reader looks', () => {
  for (const text of ['https://brieltje.be/pair/#K7QH-3MXP', 'x'.repeat(150)]) {
    const m = qrMatrix(text);
    const n = m.length;
    const finder = (ox, oy) => {
      for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
        const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        assert.equal(m[oy + y][ox + x], d !== 2, `finder at ${ox},${oy}`);
      }
    };
    finder(0, 0);
    finder(n - 7, 0);
    finder(0, n - 7);
    for (let i = 8; i < n - 8; i++) {
      assert.equal(m[6][i], i % 2 === 0);
      assert.equal(m[i][6], i % 2 === 0);
    }
    assert.equal(m[n - 8][8], true);
  }
});

test('the smallest version that fits; 213 bytes at most', () => {
  assert.equal(qrMatrix('https://brieltje.be/pair/#K7QH-3MXP').length, 29); // version 3
  assert.equal(qrMatrix('x'.repeat(213)).length, 57); // version 10
  assert.throws(() => qrMatrix('x'.repeat(214)));
  const { size, d } = svgPath('hi');
  assert.equal(size, 21 + 8);
  assert.match(d, /^(M\d+ \d+h\d+v1h-\d+z)+$/);
});
