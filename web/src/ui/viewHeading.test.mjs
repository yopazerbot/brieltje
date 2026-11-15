import test from 'node:test';
import assert from 'node:assert/strict';
import { easeHeading, viewHeading } from './viewHeading.ts';

/** A camera's forward and up as three.js builds them from yaw, pitch (rotation order YXZ) and no roll. */
const view = (yaw, pitch) => [
  -Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch),
  Math.sin(yaw) * Math.sin(pitch), Math.cos(yaw) * Math.sin(pitch),
];
const near = (a, b, eps = 1e-9) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < eps;

test('straight ahead: the yaw the camera was built from', () => {
  const [fx, fy, fz, ux, uz] = view(0, 0);
  assert.ok(near(viewHeading(fx, fy, fz, ux, uz, 2), 0));
  const [gx, gy, gz, vx, vz] = view(0.7, -0.3);
  assert.ok(near(viewHeading(gx, gy, gz, vx, vz, 2), 0.7));
});

test('a full turn, a step at a time: each heading is the yaw, wherever the view looks up or down', () => {
  for (let i = 0; i <= 36; i++) {
    const yaw = (i / 36) * 2 * Math.PI;
    for (const pitch of [-1.3, -0.5, 0, 0.6, 1.4]) {
      const [fx, fy, fz, ux, uz] = view(yaw, pitch);
      assert.ok(near(viewHeading(fx, fy, fz, ux, uz, 9), yaw, 1e-6), `yaw ${yaw.toFixed(2)} pitch ${pitch}`);
    }
  }
});

test('looking straight down or up: the heading neither spins nor jumps', () => {
  for (const yaw of [0, 1, -2.5]) {
    for (const pitch of [-Math.PI / 2, Math.PI / 2, -Math.PI / 2 + 1e-4, Math.PI / 2 - 0.2]) {
      const [fx, fy, fz, ux, uz] = view(yaw, pitch);
      assert.ok(near(viewHeading(fx, fy, fz, ux, uz, 9), yaw, 1e-6), `yaw ${yaw} pitch ${pitch}`);
    }
  }
  // Straight down with the top edge flat on nothing either (rolled over): the heading before.
  assert.equal(viewHeading(0, -1, 0, 0, 0, 0.4), 0.4);
});

test('a roll (the car leans) does not turn the heading while the view has a way on the ground', () => {
  const [fx, fy, fz] = view(1.2, -0.4);
  // The top edge leaned sideways a good deal: only the forward counts here.
  assert.ok(near(viewHeading(fx, fy, fz, 0.3, -0.2, 9), 1.2, 1e-9));
});

test('a NaN direction: the heading before', () => {
  assert.equal(viewHeading(NaN, 0, -1, 0, 0, 0.25), 0.25);
  assert.equal(viewHeading(0, NaN, NaN, NaN, NaN, -1), -1);
});

test('easing: a small change half way, a turn at once, the first draw as it is', () => {
  assert.equal(easeHeading(NaN, 1), 1);
  assert.ok(near(easeHeading(1, 1.02), 1.01));
  assert.equal(easeHeading(1, 1.5), 1.5);
  // Across the back (+π to -π) it is a small change, not nearly a whole turn.
  assert.ok(near(easeHeading(Math.PI - 0.01, -Math.PI + 0.01), Math.PI));
  // Held still, it reaches the view within a few draws.
  let h = 0;
  for (let i = 0; i < 10; i++) h = easeHeading(h, 0.04);
  assert.ok(near(h, 0.04, 1e-4));
});
