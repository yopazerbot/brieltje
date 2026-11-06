import assert from 'node:assert/strict';
import test from 'node:test';
import { DOOR_ID } from './game.mjs';
import { end, house, SKIP } from '../shared/testData.mjs';

test('every door id of the shell is one the server takes in a door message', () => {
  const ids = [...house.doors, ...end.doors].map((d) => d.id);
  assert.ok(ids.length >= 10);
  for (const id of ids) assert.match(id, DOOR_ID, id);
});

test('and the inside\'s door ids too (dots, 31 characters, capitals were refused once)', { skip: SKIP }, () => {
  const ids = [...house.doors, ...end.doors].map((d) => d.id);
  assert.ok(ids.length > 40);
  for (const id of ids) assert.match(id, DOOR_ID, id);
  assert.ok(ids.some((id) => /[.A-Z]/.test(id) || id.length > 30), 'the data still has an id of the kinds that were once refused');
});

test('and nothing else gets through: no empty, long, spaced or special ids', () => {
  for (const id of ['', 'a'.repeat(41), 'a b', '__proto__', 'a/b', 'a\n', 'ä', '<x>', 'a;b']) assert.ok(!DOOR_ID.test(id), JSON.stringify(id));
});
