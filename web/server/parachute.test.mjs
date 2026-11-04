import test from 'node:test';
import assert from 'node:assert/strict';
import { DROP, dropStart } from '../shared/parachute.mjs';
import { FLAG, playerFields, readPlayer } from '../shared/wire.mjs';
import { Game } from './game.mjs';

const state = { x: 1, y: 20, z: 2, yaw: 0, pitch: 0, armed: true, w: 'pistol', c: false, flying: false };

test('the parachute flag travels in a tick without touching the teleport counter', () => {
  for (const warp of [0, 1, 2, 3]) {
    const f = playerFields({ ...state, chute: true }, true, true, warp);
    assert.equal(f[5] & FLAG.chute, FLAG.chute);
    const p = readPlayer(['a', 0, ...f]);
    assert.equal(p.chute, true);
    assert.equal(p.warp, warp);
    assert.equal(p.safe, true);
    assert.equal(readPlayer(['a', 0, ...playerFields(state, true, false, warp)]).chute, false);
  }
});

test('a drop starts DROP.reach behind the place it lands on, whichever way it faces', () => {
  for (const yaw of [0, 1, -2.5, Math.PI]) {
    const s = dropStart(10, -5, yaw);
    // Forward is (-sin yaw, -cos yaw): gliding forward from the start reaches the place.
    assert.ok(Math.abs(s.x + -Math.sin(yaw) * DROP.reach - 10) < 1e-9);
    assert.ok(Math.abs(s.z + -Math.cos(yaw) * DROP.reach + 5) < 1e-9);
  }
});

test('under a parachute nobody shoots or is hurt, until landing gives the usual short protection', () => {
  const g = Object.create(Game.prototype);
  const p = { state: { ...state, x: 300, z: 300 }, protectedUntil: 0, drop: null };
  const now = Date.now();
  assert.equal(g.calm(p), false); // far from the school grounds
  g.startDrop(p, now);
  assert.equal(g.dropping(p, now), true);
  assert.equal(g.calm(p), true);
  assert.equal(p.protectedUntil, now + DROP.maxMs);
  assert.equal(g.dropping(p, now + DROP.maxMs), false); // a drop that takes too long ends
  g.landed(p, now + 1000);
  assert.equal(p.drop, null);
  assert.equal(g.calm(p), false);
  assert.ok(p.protectedUntil > now + 1000 && p.protectedUntil <= now + 1000 + 5000);
});
