import assert from 'node:assert/strict';
import test from 'node:test';
import { DOOR_ID, Game, knownDoor } from './game.mjs';
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

test('only the doors of the game: every real one is known, a made-up one is not', () => {
  for (const d of [...house.doors, ...end.doors]) assert.ok(knownDoor(d.id), d.id);
  for (const id of ['house-out-0', 'house-out-99', 'mh-end-x', 'some-door', 'toString', 'constructor']) assert.ok(!knownDoor(id), id);
});

test('a flood of made-up door ids never reaches the table, and the real doors keep working', () => {
  const game = new Game({ session: () => null }, []);
  const told = [];
  game.broadcast = (m) => told.push(m);
  const p = {
    key: 'k-a', role: 'admin', got: [], ws: { readyState: 1, OPEN: 1, send() {} }, alive: true, state: { x: 0, y: 0, z: 30, yaw: 0, pitch: 0, armed: false, flying: false, w: 'pistol', c: false },
    budget: 100, vbudget: 100, movedAt: Date.now(), warp: 0, stamp: 0, weapons: new Set(['pistol']), nades: [], window: Date.now(), msgs: 0, states: 0, others: 0,
  };
  game.players.set('a', p);
  const door = (id) => {
    p.nextDoor = 0;
    p.msgs = p.others = 0; // past the flood guard: this test is about the ids
    game.handle('a', p, JSON.stringify({ t: 'door', id, open: true, dir: 1 }));
  };
  for (let i = 0; i < 300; i++) door(`jam-${i}`);
  assert.equal(Object.keys(game.doors).length, 0, 'none of them kept');
  assert.equal(told.length, 0, 'and none sent on');
  const real = [...house.doors, ...end.doors].map((d) => d.id);
  for (const id of real) door(id);
  assert.deepEqual(Object.keys(game.doors).sort(), [...real].sort(), 'every real door still opens');
});
