import test from 'node:test';
import assert from 'node:assert/strict';
import { NAME_RE, RESERVED } from '../../server/auth.mjs';
import { GUEST_WORDS, guestName } from './guestName.ts';

test('every ready-made guest name keeps to the server name rules, with the lowest and the highest number', () => {
  for (const word of GUEST_WORDS) {
    for (const n of [10, 99]) {
      const name = `${word}-${n}`.toLowerCase(); // the server lowercases a name before it checks it
      assert.match(name, NAME_RE, name);
      assert.ok(!RESERVED.has(name), name);
    }
  }
});

test('guestName gives a word from the list and a number from 10 to 99', () => {
  for (const r of [0, 0.25, 0.5, 0.999999]) {
    const name = guestName(() => r);
    const [, word, n] = /^([A-Za-z]+)-(\d+)$/.exec(name) ?? [];
    assert.ok(GUEST_WORDS.includes(word), name);
    assert.ok(Number(n) >= 10 && Number(n) <= 99, name);
  }
  for (let i = 0; i < 200; i++) assert.match(guestName().toLowerCase(), NAME_RE);
});

test('the words are distinct and plain letters', () => {
  assert.equal(new Set(GUEST_WORDS).size, GUEST_WORDS.length);
  for (const w of GUEST_WORDS) assert.match(w, /^[A-Z][a-z]+$/);
});
