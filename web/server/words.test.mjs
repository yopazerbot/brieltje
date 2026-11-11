import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Words } from './words.mjs';

test('swear words are starred out in chat, whole or hidden in a longer word, in English and Dutch', () => {
  const w = new Words();
  assert.equal(w.clean('what the fuck'), 'what the ****');
  assert.equal(w.clean('F.U.C.K off'), '******* off');
  assert.equal(w.clean('wat een klootzak'), 'wat een ********');
  assert.equal(w.clean('kut!'), '***!');
  assert.equal(w.clean('fuckface'), '********');
});

test('innocent words stay: catering, eikels, classic, Dickens', () => {
  const w = new Words();
  for (const s of ['catering', 'eikels van de eik', 'a classic', 'Dickens', 'kutsen', 'pikant']) assert.equal(w.clean(s), s);
  for (const n of ['catering', 'dickens', 'scunthorpe']) assert.equal(w.rude(n), false, n);
});

test("names: rude ones refused, also with the host's own words inside them", () => {
  const w = new Words();
  assert.equal(w.rude('fuckface'), true);
  assert.equal(w.rude('kut'), true);
  w.set(['broccoli', 'x', 42, 'a'.repeat(40)]);
  assert.deepEqual(w.list(), ['broccoli']); // too short, not text, too long: left out
  assert.equal(w.rude('broccolifan'), true);
  assert.equal(w.clean('I like Broccoli'), 'I like ********');
});
