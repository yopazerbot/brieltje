// The view's movement on foot (src/viewMotion.ts): the gait's shape, the strengths, the springs, and that drawing
// leaves the camera exactly as it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MOTION, ViewMotion, gaitAt, gaitMix, motionStrength, strideSide, strideUp } from './viewMotion.ts';
import { footStep } from './footMove.ts';

const DEG = Math.PI / 180;
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i / n));

test('the eye is highest as the heel strikes, drops quickly and rises slowly', () => {
  assert.equal(strideUp(0), 1);
  assert.equal(strideUp(3), 1);
  assert.ok(Math.abs(strideUp(0.22) + 1) < 1e-12, 'lowest a fifth of a step in');
  // The drop takes 0.22 of a step, the rise the other 0.78.
  const low = range(1000, (u) => strideUp(u)).reduce((best, v, i, a) => (v < a[best] ? i : best), 0) / 1000;
  assert.ok(Math.abs(low - 0.22) < 0.002);
  // Smooth: no jump anywhere, the slope continuous at the joins.
  for (const u of [0, 0.22, 0.5, 0.999]) {
    const e = 1e-6;
    assert.ok(Math.abs(strideUp(u + e) - strideUp(u - e)) < 1e-4, `continuous at ${u}`);
  }
  // Nought on average: walking doesn't change the eye's height.
  const mean = range(10000, (u) => strideUp(u)).reduce((a, b) => a + b) / 10000;
  assert.ok(Math.abs(mean) < 1e-3);
});

test('side to side at half the rate of up and down, through the middle at each heel strike', () => {
  for (const n of [0, 1, 2, 7]) assert.ok(Math.abs(strideSide(n)) < 1e-9);
  assert.ok(Math.abs(strideSide(0.5) - 1) < 1e-12);
  assert.ok(Math.abs(strideSide(1.5) + 1) < 1e-12);
  // Over two steps: the eye's height goes round twice, the side once.
  const ups = range(2000, (u) => strideUp(u * 2));
  const crossings = ups.filter((v, i) => i && Math.sign(v) !== Math.sign(ups[i - 1])).length;
  assert.equal(crossings, 4);
});

test('walking and sprinting sizes, and nothing standing still', () => {
  assert.deepEqual(gaitMix(0), [0, 0]);
  assert.deepEqual(gaitMix(1.4), [1, 0]);
  assert.deepEqual(gaitMix(3.5), [1, 1]);
  assert.deepEqual(gaitMix(9), [1, 1]);
  const walk = gaitAt(0, 1.4);
  assert.ok(Math.abs(walk.up - MOTION.walk.up) < 1e-12);
  assert.ok(Math.abs(walk.pitch - MOTION.walk.nod * DEG) < 1e-12);
  const sprint = gaitAt(0.5, 3.5);
  assert.ok(Math.abs(sprint.side - MOTION.sprint.side) < 1e-12);
  assert.ok(Math.abs(sprint.roll + MOTION.sprint.roll * DEG) < 1e-12);
  const still = gaitAt(0.3, 0);
  for (const k of ['up', 'side', 'pitch', 'roll']) assert.equal(Math.abs(still[k]), 0);
});

test('the strengths: Off nothing, Full 1.8 times Subtle, touch two thirds', () => {
  assert.equal(motionStrength('off', false), 0);
  assert.equal(motionStrength('off', true), 0);
  assert.equal(motionStrength('subtle', false), 1);
  assert.equal(motionStrength('full', false), 1.8);
  assert.ok(Math.abs(motionStrength('subtle', true) - 2 / 3) < 1e-12);
  assert.ok(Math.abs(motionStrength('full', true) - 1.2) < 1e-12);
});

/** Run `frames` of 1/60 s with a feed made from the frame's time. */
function run(m, frames, feed, { aim = 0, scoped = false, allowed = true } = {}) {
  const outs = [];
  for (let i = 0; i < frames; i++) {
    const f = feed(i / 60);
    if (f) m.feed(f);
    m.step(1 / 60, allowed, aim, scoped);
    outs.push({ ...m.out });
  }
  return outs;
}
const walking = (speed, extra = {}) => (t) => ({ phase: (t * speed) / (0.65 + 0.15 * speed), speed, ahead: speed, right: 0, grounded: true, sprint: false, ...extra });

test('Off is truly still: no stride, no lean, no wider view', () => {
  const m = new ViewMotion();
  m.strength = 0;
  const outs = run(m, 300, walking(3.5, { sprint: true }));
  for (const o of outs) for (const k of ['up', 'side', 'pitch', 'roll', 'fov']) assert.equal(Math.abs(o[k]), 0);
});

test('sprinting widens the view by 4 degrees at 72, in over about 0.3 s, never past it', () => {
  const m = new ViewMotion();
  const outs = run(m, 120, walking(3.5, { sprint: true }));
  const fov = outs.map((o) => o.fov);
  const full = MOTION.fov / 72;
  assert.ok(fov.every((v) => v <= full + 1e-12), 'no overshoot');
  const at = (s) => fov[Math.round(s * 60) - 1];
  assert.ok(at(0.3) > 0.9 * full && at(0.3) < full, `0.3 s: ${at(0.3) / full}`);
  assert.ok(at(1.5) > 0.999 * full);
  // Aiming fades it all out; a scope stills it.
  const aimed = run(m, 1, walking(3.5, { sprint: true }), { aim: 0.85 })[0];
  for (const k of ['up', 'side', 'pitch', 'roll', 'fov']) assert.equal(Math.abs(aimed[k]), 0);
  const scoped = run(m, 1, walking(3.5, { sprint: true }), { aim: 0.3, scoped: true })[0];
  for (const k of ['up', 'side', 'pitch', 'roll', 'fov']) assert.equal(Math.abs(scoped[k]), 0);
});

test('a start leans in and a sidestep rolls into it, on springs with no wobble', () => {
  // The player's own speed builds up as it does on foot (footMove.ts): from standing to a sprint.
  const m = new ViewMotion();
  const v = { x: 0, z: 0 };
  const pitch = run(m, 120, () => {
    footStep(v, 3.5, 0, 1 / 60, 1);
    return { phase: 0, speed: 0, ahead: v.x, right: 0, grounded: true, sprint: false };
  }).map((o) => o.pitch);
  const most = Math.min(...pitch);
  assert.ok(most < -0.3 * DEG && most > -0.8 * DEG, `the lean at a sprint's start: ${most / DEG} degrees`);
  // Back to nought from its peak without passing it (critically damped).
  assert.ok(pitch.every((p) => p <= 1e-12), 'never leans back');
  const side = new ViewMotion();
  const roll = run(side, 120, () => ({ phase: 0, speed: 0, ahead: 0, right: 1.4, grounded: true, sprint: false })).map((o) => o.roll);
  assert.ok(roll.every((r, i) => i === 0 || r <= roll[i - 1] + 1e-12), 'rolls in steadily');
  assert.ok(Math.abs(roll.at(-1) + MOTION.side * DEG) < 1e-4, `settles at ${roll.at(-1) / DEG}`);
});

test('a jump gives a little first, and the stride holds in the air', () => {
  const m = new ViewMotion();
  run(m, 60, walking(1.4));
  m.jumped();
  const outs = run(m, 12, () => ({ phase: 0.5, speed: 1.4, ahead: 1.4, right: 0, grounded: false, sprint: false }));
  assert.ok(Math.min(...outs.map((o) => o.up)) < -0.015, 'the give');
  const later = run(m, 30, () => ({ phase: 0.5, speed: 1.4, ahead: 1.4, right: 0, grounded: false, sprint: false }));
  assert.ok(Math.abs(later.at(-1).up - later.at(-2).up) < 1e-9, 'held in the air');
});

test('watching, a seat or a car: nothing; drawing leaves the camera exactly as it was', () => {
  const m = new ViewMotion();
  m.strength = 1.8;
  const outs = run(m, 200, walking(3.5, { sprint: true }), { allowed: false });
  for (const k of ['up', 'side', 'pitch', 'roll', 'fov']) assert.ok(Math.abs(outs.at(-1)[k]) < 1e-9);

  run(m, 200, walking(3.5, { sprint: true }));
  assert.ok(m.out.fov > 0 && Math.abs(m.out.up) + Math.abs(m.out.roll) > 0);
  const camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.1, 1000);
  const gun = new THREE.Group();
  camera.add(gun);
  gun.scale.set(1.2, 1.2, 0.8);
  camera.position.set(3, 1.6, -2);
  camera.rotation.set(-0.1, 2.4, 0, 'YXZ');
  camera.updateMatrixWorld();
  const before = { m: camera.matrixWorld.clone(), inv: camera.matrixWorldInverse.clone(), p: camera.projectionMatrix.clone(), fov: camera.fov, gun: gun.matrixWorld.clone() };
  let drawn = null;
  m.draw(camera, gun, () => {
    camera.updateMatrixWorld();
    drawn = { m: camera.matrixWorld.clone(), fov: camera.fov, gunX: gun.scale.x };
  });
  assert.ok(!drawn.m.equals(before.m), 'drawn moved');
  assert.ok(drawn.fov > 72 && drawn.gunX > 1.2, 'drawn wider, the gun as much bigger');
  assert.ok(camera.matrixWorld.equals(before.m), 'the camera back');
  assert.ok(camera.projectionMatrix.equals(before.p) && camera.fov === before.fov);
  assert.ok(camera.matrixWorldInverse.equals(before.inv));
  // The gun's own place and size back; its world matrix is worked out again by the next drawing, as always.
  assert.ok(gun.scale.x === 1.2 && gun.scale.y === 1.2 && gun.scale.z === 0.8);
  camera.updateMatrixWorld();
  assert.ok(gun.matrixWorld.equals(before.gun));
  assert.equal(camera.rotation.y, 2.4);
});

test('the crosshair is drawn where the shot goes in the moved picture', () => {
  globalThis.innerWidth = 1920;
  globalThis.innerHeight = 1080;
  const m = new ViewMotion();
  m.strength = 1.8;
  run(m, 33, walking(3.5, { sprint: true })); // mid-stride, leaning, the view widening
  assert.ok(Math.abs(m.out.pitch) > 0.5 * DEG && m.out.fov > 0);
  const camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.1, 1000);
  camera.position.set(1, 1.6, 2);
  camera.rotation.set(0.05, -0.7, 0, 'YXZ');
  camera.updateMatrixWorld();
  // The shot's ray: straight ahead of the camera as the game has it (weapon.ts raycaster.setFromCamera at the middle).
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(0, 0), camera);
  const target = ray.ray.at(60, new THREE.Vector3());
  const mark = { style: { translate: '' } };
  let seen = null;
  m.draw(camera, new THREE.Group(), () => {
    camera.updateMatrixWorld();
    const p = target.clone().project(camera);
    seen = [(p.x * 1920) / 2, (-p.y * 1080) / 2];
  }, mark);
  const [x, y] = mark.style.translate.split(' ').map((v) => parseFloat(v));
  assert.ok(Math.abs(seen[1]) > 10, `the target moved in the picture: ${seen[1]} px`);
  assert.ok(Math.abs(x - seen[0]) < 0.1 && Math.abs(y - seen[1]) < 0.1, `crosshair ${x}, ${y}; the target ${seen}`);
  // Still again: back in the middle.
  m.strength = 0;
  run(m, 1, walking(0));
  m.draw(camera, new THREE.Group(), () => {}, mark);
  assert.equal(mark.style.translate, '');
});
