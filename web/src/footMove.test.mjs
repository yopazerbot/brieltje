// How your speed on foot follows the keys (src/footMove.ts): the build-up, the stop, turning, and never faster than
// the pace the keys ask for (the server's bound on running, server/game.mjs RUN_SPEED, is never in reach).
import test from 'node:test';
import assert from 'node:assert/strict';
import { SIDE, footStep, sprintShare } from './footMove.ts';

const WALK = 1.4;
const SPRINT = 3.5;
/** Frames of `dt` until `done(v)`, going for (tx, tz); returns [seconds, metres along x, v]. */
function until(v, tx, tz, dt, done, scale = 1) {
  let t = 0;
  let d = 0;
  for (let i = 0; i < 10000 && !done(v); i++) {
    footStep(v, tx, tz, dt, scale);
    t += dt;
    d += v.x * dt;
  }
  return [t, d, v];
}

test('the build-up: walking pace in 0.2 s, a sprint from standing in 0.4 s, at any frame rate', () => {
  for (const hz of [30, 60, 144]) {
    const dt = 1 / hz;
    const [walk] = until({ x: 0, z: 0 }, WALK, 0, dt, (v) => v.x >= WALK - 1e-9);
    assert.ok(Math.abs(walk - 0.2) <= dt + 1e-9, `walking pace at ${hz} Hz in ${walk.toFixed(3)} s`);
    const [run] = until({ x: 0, z: 0 }, SPRINT, 0, dt, (v) => v.x >= SPRINT - 1e-9);
    assert.ok(Math.abs(run - 0.4) <= dt + 1e-9, `a sprint at ${hz} Hz in ${run.toFixed(3)} s`);
  }
});

test('a stop is quicker than a start and ends at exactly nought: nobody slides', () => {
  const dt = 1 / 60;
  const [fromWalk, walkDist] = until({ x: WALK, z: 0 }, 0, 0, dt, (v) => v.x === 0 && v.z === 0);
  assert.ok(Math.abs(fromWalk - 0.15) <= dt + 1e-9, `from walking in ${fromWalk.toFixed(3)} s`);
  assert.ok(walkDist < 0.12, `from walking within ${walkDist.toFixed(3)} m`);
  const [fromSprint, sprintDist] = until({ x: SPRINT, z: 0 }, 0, 0, dt, (v) => v.x === 0 && v.z === 0);
  assert.ok(Math.abs(fromSprint - 0.3) <= dt + 1e-9, `from a sprint in ${fromSprint.toFixed(3)} s`);
  assert.ok(sprintDist > 0.4 && sprintDist < 0.5, `from a sprint within ${sprintDist.toFixed(3)} m`);
  // Standing, nothing moves.
  const still = { x: 0, z: 0 };
  for (let i = 0; i < 600; i++) footStep(still, 0, 0, dt, 1);
  assert.deepEqual(still, { x: 0, z: 0 });
});

test('turning at walking pace stays crisp; left to right and back is as quick as it was', () => {
  const dt = 1 / 60;
  // Right to left at walking pace: today's (a rate of 12 per second) took 0.31 s to 95 %.
  const [flip] = until({ x: WALK, z: 0 }, -WALK, 0, dt, (v) => v.x <= -0.95 * WALK);
  assert.ok(flip < 0.36, `right to left in ${flip.toFixed(3)} s`);
  // A quarter turn: the old way's speed is gone in a stop's time, the new one there in a start's.
  const [quarter, , q] = until({ x: WALK, z: 0 }, 0, WALK, dt, (v) => v.x === 0 && v.z >= WALK - 1e-9);
  assert.ok(quarter <= 0.2 + dt, `a quarter turn in ${quarter.toFixed(3)} s`);
  assert.equal(q.x, 0);
  // Turning the view a little each frame at walking pace (a mouse sweep of 180 degrees a second): the speed keeps up.
  const v = { x: 0, z: -WALK };
  let worst = 0;
  for (let i = 0; i < 120; i++) {
    const a = (i * Math.PI) / 60;
    footStep(v, -Math.sin(a) * WALK, -Math.cos(a) * WALK, dt, 1);
    const lag = Math.acos(Math.max(-1, Math.min(1, (v.x * -Math.sin(a) + v.z * -Math.cos(a)) / Math.hypot(v.x, v.z))));
    worst = Math.max(worst, lag);
  }
  assert.ok(worst < (6 * Math.PI) / 180, `the way you go lags the view by at most ${((worst * 180) / Math.PI).toFixed(1)} degrees`);
});

test('never faster than the larger of where you were and where the keys go (so never past the top pace)', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let n = 0; n < 20000; n++) {
    const v = { x: (rnd() - 0.5) * 7, z: (rnd() - 0.5) * 7 };
    const a = rnd() * 2 * Math.PI;
    const want = rnd() * SPRINT;
    const was = Math.hypot(v.x, v.z);
    const dt = [1 / 144, 1 / 60, 1 / 30, 0.25][n % 4];
    footStep(v, Math.cos(a) * want, Math.sin(a) * want, dt, 1, n % 3 === 0);
    assert.ok(Math.hypot(v.x, v.z) <= Math.max(want, was) + 1e-9);
  }
});

test('in the air: the speed kept, a quarter of the steering, a standing jump still nudged onto a ledge', () => {
  const dt = 1 / 60;
  const AIRTIME = 0.633; // s in a jump of 0.5 m (player.ts JUMP_HEIGHT)
  const frames = Math.round(AIRTIME / dt);
  // No keys: the speed you left the ground with, all the way.
  const v = { x: SPRINT, z: 0 };
  for (let i = 0; i < frames; i++) footStep(v, 0, 0, dt, 1, true);
  assert.deepEqual(v, { x: SPRINT, z: 0 });
  // A running jump, the view turned a quarter round at once: the way you go turns far less than the view.
  const turn = { x: SPRINT, z: 0 };
  for (let i = 0; i < frames; i++) footStep(turn, 0, SPRINT, dt, 1, true);
  const turned = (Math.atan2(turn.z, turn.x) * 180) / Math.PI;
  assert.ok(turned > 30 && turned < 60, `a running jump turned ${turned.toFixed(1)} degrees of 90`);
  // On the ground the same turn is done in that time.
  const ground = { x: SPRINT, z: 0 };
  for (let i = 0; i < frames; i++) footStep(ground, 0, SPRINT, dt, 1, false);
  assert.ok(ground.x === 0 && ground.z > 0.95 * SPRINT);
  // A standing jump with the walk key down: forward far enough to land on a ledge in front of you.
  const stand = { x: 0, z: 0 };
  let d = 0;
  for (let i = 0; i < frames; i++) {
    footStep(stand, WALK, 0, dt, 1, true);
    d += stand.x * dt;
  }
  assert.ok(d > 0.25 && d < 0.6, `a standing jump goes ${d.toFixed(3)} m forward`);
});

test('the full sprint only within 45 degrees of ahead, 70 % of it sideways and backwards, smooth on a stick', () => {
  const pace = (x, y) => 1.4 * (1 + 1.5 * sprintShare(x, y));
  assert.equal(pace(0, 1), SPRINT);
  assert.equal(pace(1, 1), SPRINT, 'forward and right on the keys: a full sprint');
  assert.equal(pace(-0.7, 0.7), SPRINT);
  for (const [x, y] of [[1, 0], [-1, 0], [0, -1], [0.7, -0.7], [-0.3, -1]]) assert.ok(Math.abs(pace(x, y) - 0.7 * SPRINT) < 1e-9, `${x}, ${y}`);
  // The stick's tilt doesn't change the share (half tilt is half of the pace that way); no step anywhere round it.
  assert.equal(sprintShare(0.2, 0.2), sprintShare(1, 1));
  let last = sprintShare(0, 1);
  for (let a = 0; a <= Math.PI; a += 0.001) {
    const s = sprintShare(Math.sin(a), Math.cos(a));
    assert.ok(s <= last + 1e-12 && last - s < 0.002, `smooth and never more further round (${a.toFixed(3)} rad)`);
    last = s;
  }
  // Mid-way round (67.5 degrees) half of the way down.
  assert.ok(Math.abs(sprintShare(Math.sin((3 * Math.PI) / 8), Math.cos((3 * Math.PI) / 8)) - (1 + SIDE) / 2) < 1e-6);
  assert.equal(sprintShare(0, 0), 1);
});

test('the rates follow the walking speed and the admin\'s turbo: the same times at any pace', () => {
  const dt = 1 / 60;
  const [t] = until({ x: 0, z: 0 }, WALK * 15, 0, dt, (v) => v.x >= WALK * 15 - 1e-9, 15);
  assert.ok(Math.abs(t - 0.2) <= dt + 1e-9, `turbo walking pace in ${t.toFixed(3)} s`);
});
