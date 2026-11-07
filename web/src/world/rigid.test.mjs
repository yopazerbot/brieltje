import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

// The solver as the game runs it (world/rigid.ts has no imports).
const source = readFileSync(new URL('./rigid.ts', import.meta.url), 'utf8').replaceAll('export ', '');
const { RigidBody, Pole, rotate, leanQuat, axisAngle } = new Function(stripTypeScriptTypes(source) + '\nreturn { RigidBody, Pole, rotate, leanQuat, axisAngle };')();

/** Flat ground at 0, and optionally a wall along x = wallX (the solid side beyond it). */
const flat = (wallX = Infinity) => ({
  ground: () => 0,
  wall: (a, b, r) => (b[0] + r > wallX ? [-1, 0] : null),
});

/** A wheelie bin: 12 kg, 0.58 x 1.0 x 0.72 m, its corners round its middle. */
const BIN = (() => {
  const half = [0.29, 0.5, 0.36];
  const points = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) points.push([x * half[0], y * half[1], z * half[2]]);
  return { mass: 12, half, points, bounce: 0.25, friction: 0.6, radius: 0.3 };
})();

const run = (body, world, seconds) => {
  for (let t = 0; t < seconds; t += 1 / 60) body.step(1 / 60, world);
};
const lowest = (body) => Math.min(...body.spec.points.map((c) => body.p[1] + rotate(body.q, c)[1]));
const upY = (body) => rotate(body.q, [0, 1, 0])[1];

test('a dropped bin lands, settles on its bottom and goes to sleep', () => {
  const b = new RigidBody(BIN, [0, 2, 0], [0, 0, 0, 1]);
  run(b, flat(), 4);
  assert.ok(b.asleep, 'asleep');
  assert.ok(Math.abs(lowest(b)) < 0.02, `resting on the ground (${lowest(b)})`);
  assert.ok(upY(b) > 0.99, 'still upright');
  assert.ok(b.knock > 3, 'it knocked on landing');
});

test('a bin tipped past its balance falls over and lies still on its side', () => {
  const b = new RigidBody(BIN, [0, 0.55, 0], axisAngle(0, 0, 1, 0.7));
  run(b, flat(), 6);
  assert.ok(b.asleep, 'asleep');
  assert.ok(Math.abs(upY(b)) < 0.1, `on its side (up.y ${upY(b)})`);
  assert.ok(lowest(b) > -0.03 && lowest(b) < 0.02, 'on the ground, not in it');
  for (const x of [...b.p, ...b.q]) assert.ok(Number.isFinite(x), 'finite');
});

test('a bin pushed along the ground slides, tumbles and stops by friction', () => {
  const b = new RigidBody(BIN, [0, 0.5, 0], [0, 0, 0, 1]);
  b.impulse([12 * 8, 12 * 1.5, 0], [-0.1, 0.35, 0]); // a bumper at 8 m/s, low on its side
  run(b, flat(), 8);
  assert.ok(b.asleep, 'asleep');
  assert.ok(b.p[0] > 1 && b.p[0] < 15, `went some way (${b.p[0]} m)`);
  assert.ok(Math.abs(b.p[2]) < 1.5, 'roughly straight on');
  assert.ok(lowest(b) > -0.03, 'not sunk into the ground');
});

test('a wall stops it and sends it back a little', () => {
  const b = new RigidBody(BIN, [0, 0.5, 0], [0, 0, 0, 1]);
  b.impulse([12 * 6, 0, 0], [0, 0, 0]);
  run(b, flat(1.5), 5);
  assert.ok(b.p[0] + BIN.radius <= 1.5 + 1e-6, `kept out of the wall (${b.p[0]})`);
});

test('a pole wobbles back from a small push and stays bent after a hard one', () => {
  const spec = { hz: 2.2, damping: 0.12, yield: 0.12, maxBend: 1.3 };
  const p = new Pole(spec);
  p.push(1, 0, 0.6); // walked into
  for (let t = 0; t < 6; t += 1 / 60) p.step(1 / 60);
  assert.ok(p.asleep, 'still again');
  assert.ok(Math.hypot(...p.bend) < 0.02, `no lasting bend (${p.bend})`);

  p.push(0, 1, 14); // a car
  let most = 0;
  for (let t = 0; t < 6; t += 1 / 60) {
    p.step(1 / 60);
    most = Math.max(most, Math.hypot(...p.lean));
  }
  assert.ok(p.asleep, 'still again');
  assert.ok(p.bend[1] > 0.5, `bent over towards the push (${p.bend})`);
  assert.ok(Math.hypot(...p.bend) <= spec.maxBend + 1e-9, 'no further than flat');
  assert.ok(most <= spec.maxBend + spec.yield + 1e-9, 'never through the ground');
});

test('leanQuat tilts the top towards the lean', () => {
  const top = rotate(leanQuat(0.3, 0), [0, 1, 0]);
  assert.ok(top[0] > 0.29 && top[0] < 0.3, `towards +x (${top})`);
  assert.ok(Math.abs(top[2]) < 1e-9);
  const top2 = rotate(leanQuat(0, -0.5), [0, 1, 0]);
  assert.ok(top2[2] < -0.47, `towards -z (${top2})`);
});
