// Gunfire draws the zombies, and a shot in the legs makes one limp (shared/zombies.mjs noise, lame).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Horde, ZOMBIE } from './zombies.mjs';

/** A horde with only what the two rules read: its zombies and who was heard. */
function horde(zombies) {
  const h = Object.create(Horde.prototype);
  h.zombies = new Map(zombies.map((z, i) => [i, { id: i, act: 'walk', ...z }]));
  h.loud = Object.create(null);
  return h;
}

test('a shot stirs the zombies within the gun\'s earshot, and no further', () => {
  const h = horde([{ x: 5, z: 0 }, { x: 20, z: 0 }, { x: 40, z: 0 }, { x: 3, z: 0, act: 'down' }]);
  assert.equal(h.noise(0, 0, 'pistol', 1000, 'anna'), 1, 'the pistol: only the one close by');
  assert.equal(h.zombies.get(0).alertUntil, 1000 + ZOMBIE.alertMs);
  assert.equal(h.zombies.get(1).alertUntil, undefined);
  assert.equal(h.noise(0, 0, 'sniper', 2000, 'anna'), 3, 'the sniper rifle carries');
  assert.equal(h.zombies.get(3).alertUntil, undefined, 'not one that is down');
  assert.equal(h.loud.anna, 2000 + ZOMBIE.alertMs, 'the shooter counts as nearer for as long');
});

test('the pistol is the quiet gun, and an unknown one makes no noise', () => {
  const far = ZOMBIE.hear;
  assert.ok(far.pistol < far.rifle && far.rifle < far.shotgun && far.shotgun < far.sniper);
  const h = horde([{ x: 1, z: 0 }]);
  assert.equal(h.noise(0, 0, 'whistle', 0, 'anna'), 0);
  assert.equal(h.noise(0, 0, 'turret', 0, 'anna'), 0);
  assert.equal('anna' in h.loud, false);
  assert.equal(h.zombies.get(0).alertUntil, undefined);
});

test('a leg shot makes a standing zombie limp once, for good', () => {
  const h = horde([{ x: 1, z: 0 }, { x: 2, z: 0, act: 'down' }]);
  assert.equal(h.lame(0), true);
  assert.equal(h.zombies.get(0).lame, true);
  assert.equal(h.lame(0), false, 'already limping');
  assert.equal(h.lame(1), false, 'down already');
  assert.equal(h.lame(99), false, 'no such zombie');
  assert.ok(ZOMBIE.lame > 0.3 && ZOMBIE.lame < 1 && ZOMBIE.alert > 1 && ZOMBIE.alert < 1.5);
});
