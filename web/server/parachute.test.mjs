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
  g.startDrop(p, now, 0);
  assert.equal(g.dropping(p, now), true);
  assert.equal(g.calm(p), true);
  assert.equal(p.protectedUntil, now + DROP.maxMs);
  assert.equal(g.dropping(p, now + DROP.maxMs), false); // a drop that takes too long ends
  g.landed(p, now + 1000);
  assert.equal(p.drop, null);
  assert.equal(g.calm(p), false);
  assert.ok(p.protectedUntil > now + 1000 && p.protectedUntil <= now + 1000 + 5000);
});

/** A page's feet over the landing place through a real drop (src/player.ts descend), every 50 ms: [s, m]. */
function realDrop() {
  const out = [];
  let [y, vy, t] = [DROP.height, -2, 0];
  for (const dt = 0.05; y > 0; t += dt) {
    if (t < DROP.fall) vy = Math.max(-12, vy - 9.81 * dt);
    else vy += (-(y < DROP.flareAt ? 1.2 : DROP.sink) - vy) * (1 - Math.exp(-dt * (t < DROP.fall + DROP.deploy ? 1.6 : 3)));
    y = Math.max(0, y + vy * dt);
    out.push([t + dt, y]);
  }
  return out;
}

test('the server ends a drop by itself: a page holding the flag gets no longer protection', () => {
  const g = Object.create(Game.prototype);
  const now = 1e6;
  const drop = () => {
    const p = { state: { ...state }, protectedUntil: 0, drop: null };
    g.startDrop(p, now, 0);
    return p;
  };
  // When a page sending `y` every 50 ms (its messages `late` s old) loses the drop, in s.
  const ends = (path, late = 0) => {
    const p = drop();
    for (const [t, y] of path) if (g.dropOver(p, true, y, now + (t + late) * 1000)) return t + late;
    return null;
  };
  const steps = (secs, at) => Array.from({ length: secs * 20 }, (_, i) => [(i + 1) / 20, at((i + 1) / 20)]);

  // A real drop keeps it until its feet are within a metre of the ground, even with messages 0.5 s late.
  const real = realDrop();
  const down = real.find(([, y]) => y < 1)[0];
  assert.ok(down < 6, `a drop takes ${down} s`);
  for (const late of [0, 0.25, 0.5]) assert.ok(Math.abs(ends(real, late) - (down + late)) < 1e-9, `late ${late}`);
  // Hovering up high, or on the ground holding the flag, ends it after DROP.slack.
  assert.ok(ends(steps(8, () => DROP.height)) <= DROP.slack + 0.05);
  assert.ok(ends(steps(8, () => DROP.height - 4)) < DROP.slack + 1.2);
  assert.ok(ends(steps(8, () => 0)) <= DROP.graceMs / 1000 + 0.05);
  // Sinking at half the canopy's speed ends it long before DROP.maxMs.
  assert.ok(ends(steps(8, (t) => DROP.height - (DROP.sink / 2) * t)) < 4.5);
  // Saying it landed ends it; DROP.maxMs ends it whatever the page says.
  assert.equal(g.dropOver(drop(), false, 10, now + 1500), true);
  assert.equal(g.dropOver(drop(), true, DROP.height, now + DROP.maxMs), true);
  assert.ok(DROP.maxMs <= 8000);
});
