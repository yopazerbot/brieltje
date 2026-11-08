import test from 'node:test';
import assert from 'node:assert/strict';
import { AimAssist, ASSIST, aimError, coneAt, frictionScale, rangeFade, snapPlan } from './aimAssist.ts';

const DEG = Math.PI / 180;
const eye = { x: 0, y: 1.6, z: 0 };

/** A zombie's hit boxes as world/zombies.ts makes them, standing at (x, z), `id` in its userData. */
function zombieGroup(id, x, z, { visible = true, big = false, userData } = {}) {
  const s = big ? 1.9 : 1;
  return {
    children: [
      { visible, position: { x, y: 0, z }, scale: { x: s, y: 1.2, z: s }, userData: userData ?? { zombie: id, part: 'body' } },
      { visible, position: { x, y: big ? 2.4 : 1.6, z }, scale: { x: 1, y: 1, z: 1 }, userData: userData ?? { zombie: id, part: 'head' } },
    ],
  };
}

/** The yaw that looks at (x, z) from the eye (forward is -z at yaw 0). */
const yawTo = (x, z) => Math.atan2(-(x - eye.x), -(z - eye.z));

const pad = (lookX = 0.6, extra = {}) => ({ lookX, lookY: 0, mouseX: 0, mouseY: 0, aimHeld: false, anyPadButton: false, ...extra });

test('range: full to 25 m, fading out to nothing at 60 m', () => {
  assert.equal(rangeFade(5), 1);
  assert.equal(rangeFade(25), 1);
  assert.ok(Math.abs(rangeFade(42.5) - 0.5) < 1e-9);
  assert.equal(rangeFade(60), 0);
  assert.equal(rangeFade(90), 0);
  assert.equal(rangeFade(NaN), 0);
});

test('the cone covers about a body: wider close by, within 1 and 6 degrees', () => {
  assert.ok(coneAt(3, 0.275) <= 6 * DEG + 1e-9);
  assert.ok(coneAt(10, 0.275) > coneAt(20, 0.275));
  assert.ok(Math.abs(coneAt(10, 0.275) - Math.atan2(0.475, 10)) < 1e-9, 'half its width plus the margin, seen from 10 m');
  assert.ok(coneAt(200, 0.275) >= 1 * DEG - 1e-9);
  assert.ok(coneAt(10, 0.52) > coneAt(10, 0.275), 'a big one: a wider cone');
});

test('slowdown: about half speed on the target, easing to none at the edge of the cone', () => {
  const cone = coneAt(10, 0.275);
  const centre = frictionScale(0, 10, 0.275, false);
  assert.ok(centre >= 0.4 && centre <= 0.6, `centre ${centre}`);
  const mid = frictionScale(cone / 2, 10, 0.275, false);
  assert.ok(mid > centre && mid < 1, 'halfway out: in between');
  assert.ok(frictionScale(cone * 0.95, 10, 0.275, false) > 0.98, 'nearly none at the edge');
  assert.equal(frictionScale(cone, 10, 0.275, false), 1);
  assert.equal(frictionScale(cone * 2, 10, 0.275, false), 1);
  // Monotone from the centre out.
  let prev = 0;
  for (let i = 0; i <= 20; i++) {
    const s = frictionScale((cone * i) / 20, 10, 0.275, false);
    assert.ok(s >= prev - 1e-12);
    prev = s;
  }
});

test('slowdown: weaker for the sniper and far off, nothing beyond 60 m', () => {
  const plain = frictionScale(0, 10, 0.275, false);
  const sniper = frictionScale(0, 10, 0.275, true);
  assert.ok(sniper > plain && sniper >= 0.7, `sniper ${sniper}`);
  assert.ok(frictionScale(0, 45, 0.275, false) > plain, 'weaker at 45 m');
  assert.equal(frictionScale(0, 60, 0.275, false), 1);
  assert.equal(frictionScale(0, 80, 0.275, false), 1);
});

test('aim error: zero looking straight at it, the right sign for the turn', () => {
  const t = { id: 1, foot: { x: 0, y: 0.35, z: -10 }, top: { x: 0, y: 1.6, z: -10 }, radius: 0.275 };
  const on = aimError(eye, 0, 0, t);
  assert.ok(on.angle < 1e-6 && Math.abs(on.dYaw) < 1e-6 && Math.abs(on.dPitch) < 1e-6);
  assert.ok(Math.abs(on.dist - 10) < 1e-6);
  // Looking 3 degrees to its left (yaw turns left): the turn back is to the right, negative yaw.
  const off = aimError(eye, 3 * DEG, 0, t);
  assert.ok(Math.abs(off.angle - 3 * DEG) < 1e-3);
  assert.ok(Math.abs(off.dYaw + 3 * DEG) < 1e-3);
  // Looking over its head: the nearest point is the top of the line, the turn is down.
  const over = aimError(eye, 0, 10 * DEG, t);
  assert.ok(over.dPitch < 0 && Math.abs(over.point.y - 1.6) < 1e-9);
});

test('snap: only within its cone, part of the way, never more than 3.5 degrees (the sniper 1.5)', () => {
  assert.equal(snapPlan(6 * DEG, 10, 6 * DEG, 0, false), null, 'outside the cone');
  assert.equal(snapPlan(3 * DEG, 10, 3 * DEG, 0, true), null, 'the sniper: half the cone');
  const small = snapPlan(2 * DEG, 10, 2 * DEG, 0, false);
  assert.ok(Math.abs(small.yaw - 2 * DEG * ASSIST.share) < 1e-9 && small.pitch === 0, 'part of the way');
  for (const a of [3, 4, 4.9]) {
    const p = snapPlan(a * DEG, 10, a * DEG * 0.8, a * DEG * 0.6, false);
    assert.ok(Math.hypot(p.yaw, p.pitch) <= 3.5 * DEG + 1e-9);
    assert.ok(Math.hypot(p.yaw, p.pitch) < a * DEG, 'never all the way');
  }
  const s = snapPlan(2.4 * DEG, 10, 2.4 * DEG, 0, true);
  assert.ok(Math.hypot(s.yaw, s.pitch) <= 1.5 * DEG + 1e-9);
  assert.equal(snapPlan(2 * DEG, 61, 2 * DEG, 0, false), null, 'nothing beyond 60 m');
  assert.ok(Math.hypot(...Object.values(snapPlan(4 * DEG, 50, 4 * DEG, 0, false))) < 3.5 * DEG * 0.3, 'less far off');
});

test('the class: slows the stick over a zombie, never turns the view with the stick still', () => {
  const hits = { children: [zombieGroup(7, 0, -10)] };
  const a = new AimAssist(hits, () => true);
  const view = { yaw: 0, pitch: 0 };
  const input = pad(0.6);
  a.shape(input, 1 / 60, view, eye, true, false, 0);
  const speed = (input.lookX / 0.6) ** 2;
  assert.ok(speed >= 0.4 && speed <= 0.6, `speed ${speed}`);
  assert.equal(a.last.target, 7);
  assert.deepEqual(view, { yaw: 0, pitch: 0 }, 'friction never turns the view itself');
  // Stick still, not aiming: nothing changes, the view stays put.
  const still = pad(0);
  const v2 = { yaw: 2 * DEG, pitch: 0 };
  for (let i = 0; i < 30; i++) a.shape(still, 1 / 60, v2, eye, true, false, i * 16);
  assert.deepEqual(v2, { yaw: 2 * DEG, pitch: 0 });
  assert.equal(still.lookX, 0);
});

test('the class: nothing for anything but a zombie, a fallen one, or through a wall', () => {
  const view = { yaw: 0, pitch: 0 };
  // A player's (or a clown's, a cat's) hit box carries no zombie id.
  const other = new AimAssist({ children: [zombieGroup(1, 0, -10, { userData: { player: 'someone', part: 'body' } })] }, () => true);
  const i1 = pad(0.6);
  other.shape(i1, 1 / 60, view, eye, true, false, 0);
  assert.equal(i1.lookX, 0.6);
  const down = new AimAssist({ children: [zombieGroup(2, 0, -10, { visible: false })] }, () => true);
  const i2 = pad(0.6);
  down.shape(i2, 1 / 60, view, eye, true, false, 0);
  assert.equal(i2.lookX, 0.6);
  const walled = new AimAssist({ children: [zombieGroup(3, 0, -10)] }, () => false);
  const i3 = pad(0.6);
  walled.shape(i3, 1 / 60, view, eye, true, false, 0);
  assert.equal(i3.lookX, 0.6);
  const far = new AimAssist({ children: [zombieGroup(4, 0, -61)] }, () => true);
  const i4 = pad(0.6);
  far.shape(i4, 1 / 60, view, eye, true, false, 0);
  assert.equal(i4.lookX, 0.6);
});

test('the class: nothing without the controller, or switched off', () => {
  const hits = { children: [zombieGroup(1, 0, -10)] };
  // The mouse moved last: off, even with the stick pushed too.
  const a = new AimAssist(hits, () => true);
  const mouse = pad(0.6, { mouseX: 3 });
  a.shape(mouse, 1 / 60, { yaw: 0, pitch: 0 }, eye, true, false, 0);
  assert.equal(mouse.lookX, 0.6);
  // And it stays off for an aim with the mouse's button (no stick, no pad button since).
  const view = { yaw: 2 * DEG, pitch: 0 };
  a.shape(pad(0, { aimHeld: true }), 1 / 60, view, eye, true, false, 16);
  assert.equal(view.yaw, 2 * DEG);
  // Off (the setting, another mode, no Zombies game): nothing.
  const b = new AimAssist(hits, () => true);
  const off = pad(0.6);
  b.shape(off, 1 / 60, { yaw: 0, pitch: 0 }, eye, false, false, 0);
  assert.equal(off.lookX, 0.6);
});

test('the class: the snap at the start of aiming moves a few degrees, over 150 ms, then stops', () => {
  const hits = { children: [zombieGroup(1, 0, -10)] };
  const a = new AimAssist(hits, () => true);
  const start = yawTo(0, -10) + 4 * DEG; // 4 degrees to its left
  const view = { yaw: start, pitch: 0 };
  a.shape(pad(0, { anyPadButton: true }), 1 / 60, view, eye, true, false, 0); // the pad in use
  assert.equal(view.yaw, start);
  let t = 0;
  for (let i = 0; i < 30; i++) a.shape(pad(0, { aimHeld: true }), 1 / 60, view, eye, true, false, (t += 16));
  const moved = (start - view.yaw) / DEG;
  assert.ok(moved > 2 && moved <= 3.5 + 1e-9, `moved ${moved}°`);
  assert.ok(Math.abs(view.pitch) < 1 * DEG, 'towards its line, hardly up or down');
  const after = view.yaw;
  for (let i = 0; i < 30; i++) a.shape(pad(0, { aimHeld: true }), 1 / 60, view, eye, true, false, (t += 16));
  assert.equal(view.yaw, after, 'no tracking afterwards');
  // A target outside the cone, or behind a wall: no snap.
  for (const [clear, off] of [[true, 7], [false, 3]]) {
    const b = new AimAssist(hits, () => clear);
    const v = { yaw: yawTo(0, -10) + off * DEG, pitch: 0 };
    const y0 = v.yaw;
    b.shape(pad(0, { anyPadButton: true }), 1 / 60, v, eye, true, false, 0);
    for (let i = 0; i < 20; i++) b.shape(pad(0, { aimHeld: true }), 1 / 60, v, eye, true, false, 16 * (i + 1));
    assert.equal(v.yaw, y0);
  }
  // The sniper: at most 1.5 degrees.
  const c = new AimAssist(hits, () => true);
  const v = { yaw: yawTo(0, -10) + 2.4 * DEG, pitch: 0 };
  const y0 = v.yaw;
  c.shape(pad(0, { anyPadButton: true }), 1 / 60, v, eye, true, true, 0);
  for (let i = 0; i < 20; i++) c.shape(pad(0, { aimHeld: true }), 1 / 60, v, eye, true, true, 16 * (i + 1));
  assert.ok((y0 - v.yaw) / DEG <= 1.5 + 1e-9 && y0 > v.yaw);
});
