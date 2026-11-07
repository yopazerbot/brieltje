import test from 'node:test';
import assert from 'node:assert/strict';
import { CARRY, CLIMB, PlayTower, TOWER } from './playground.ts';

const tower = new PlayTower(TOWER, 0);
const T = TOWER;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
/** Facing the tower from the ladder's side, and facing away from it. */
const IN = tower.yaw;
const OUT = tower.yaw + Math.PI;

test('the frame: the tower data has the parts the game needs, its directions at right angles and of unit length', () => {
  assert.ok(Math.abs(Math.hypot(...T.v) - 1) < 1e-5 && Math.abs(Math.hypot(...T.w) - 1) < 1e-5);
  assert.ok(Math.abs(T.v[0] * T.w[0] + T.v[1] * T.w[1]) < 1e-5);
  const [dv, dw] = tower.local(...tower.at(0.3, -1.2));
  assert.ok(near(dv, 0.3, 1e-5) && near(dw, -1.2, 1e-5));
  assert.ok(near(tower.facing(IN), 1, 1e-5) && near(tower.facing(OUT), -1, 1e-5));
  // The ladder leans from the playground to the platform's edge, the slide goes down the other side.
  assert.ok(T.ladder.foot < T.ladder.top && T.ladder.top <= -T.platform.half + 1e-9);
  assert.ok(T.slide.top[0] >= T.platform.half - 1e-9 && T.slide.bottom[1] < T.slide.top[1] && T.slide.end[0] > T.slide.bottom[0]);
});

test('the blocks: a platform to stand on at its height, two boards as low walls, four posts; open towards the ladder and the slide', () => {
  const prisms = tower.prisms();
  assert.equal(prisms.length, 1 + 2 + 4);
  const [floor, ...rest] = prisms;
  assert.ok(near(floor.y1, T.y + T.platform.y1));
  for (const p of prisms) for (const [x, z] of p.p[0]) assert.ok(Number.isFinite(x) && Number.isFinite(z));
  // Nothing stands in the ladder's way or the slide's: the middle of each open side is clear.
  const inRing = (x, z, ring) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i];
      const [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    }
    return hit;
  };
  for (const dw of [-T.platform.half + 0.05, T.platform.half - 0.05]) {
    for (const dv of [-0.3, 0, 0.3]) assert.ok(!rest.some((p) => inRing(...tower.at(dv, dw), p.p[0])), `clear at ${dv}, ${dw}`);
  }
  // The boards are taller than a step up from the platform: walls, not floors.
  for (const b of rest.slice(0, 2)) assert.ok(b.y1 - floor.y1 > 0.5);
});

test('at the foot, facing it, forward climbs; facing away or standing back, it does not', () => {
  const foot = tower.climbPose(0);
  assert.ok(near(foot.feet, T.y));
  assert.deepEqual(tower.grab(foot.x, foot.z, foot.feet, IN, 1, 0, 0), { kind: 'ladder', s: 0 });
  assert.equal(tower.grab(foot.x, foot.z, foot.feet, OUT, 1, 0, 0), null, 'facing away');
  assert.equal(tower.grab(foot.x, foot.z, foot.feet, IN, 0, 0, 0), null, 'not pressing forward');
  assert.equal(tower.grab(...tower.at(0, T.ladder.foot - 2), T.y, IN, 1, 0, 0), null, 'two metres back');
  assert.equal(tower.grab(...tower.at(1.2, T.ladder.foot), T.y, IN, 1, 0, 0), null, 'beside it');
  assert.equal(tower.grab(foot.x, foot.z, T.y + 2, IN, 1, 0, 0), null, 'flying past above it');
});

test('up the ladder at the climbing pace, a creak for each rung, onto the platform at the top', () => {
  const c = { kind: 'ladder', s: 0 };
  let t = 0, rungs = 0, end = null, last = tower.climbPose(0).feet;
  while (!end && t < 20) {
    const step = tower.climb(c, 1 / 60, 1, 1);
    t += 1 / 60;
    rungs += step.rungs;
    end = step.end;
    const p = tower.climbPose(c.s);
    assert.ok(p.feet >= last - 1e-9, 'never down while climbing up');
    assert.ok(p.feet - last < 0.05, 'no jumps');
    last = p.feet;
  }
  assert.equal(end, 'top');
  assert.ok(Math.abs(t - tower.ladderLength / CLIMB) < 0.05, `took ${t.toFixed(2)} s`);
  assert.equal(rungs, T.ladder.rungs + 1, 'the rungs and the top');
  const top = tower.climbPose(c.s);
  assert.ok(near(top.feet, T.y + T.platform.y1));
  const [dv, dw] = tower.local(top.x, top.z);
  assert.ok(Math.abs(dv) < 1e-9 && dw > -T.platform.half + 0.25 && dw < T.platform.half, 'standing on the platform, clear of its edge');
});

test('down the ladder: back from the foot side, or forward facing out from the platform; off at the bottom', () => {
  const c = { kind: 'ladder', s: tower.ladderLength / 2 };
  let end = null;
  for (let i = 0; i < 600 && !end; i++) end = tower.climb(c, 1 / 60, -1, 1).end;
  assert.equal(end, 'bottom');
  assert.ok(near(tower.climbPose(c.s).feet, T.y));
  // From the platform: walking out over the ladder's edge takes you onto its top.
  const [x, z] = tower.at(0, -T.platform.half + 0.15);
  const w = T.w;
  const grabbed = tower.grab(x, z, T.y + T.platform.y1, OUT, 1, -w[0] * 1.4, -w[1] * 1.4);
  assert.ok(grabbed && grabbed.s > tower.ladderLength * 0.7, 'near the top');
  assert.equal(tower.grab(x, z, T.y + T.platform.y1, OUT, 1, w[0] * 1.4, w[1] * 1.4), null, 'walking back in: no');
  const pose = tower.climbPose(grabbed.s);
  assert.ok(Math.hypot(pose.x - x, pose.z - z) < 0.3 && Math.abs(pose.feet - (T.y + T.platform.y1)) < 0.05, 'no jump in where you are');
  let down = null;
  for (let i = 0; i < 600 && !down; i++) down = tower.climb(grabbed, 1 / 60, 1, tower.facing(OUT)).end;
  assert.equal(down, 'bottom');
});

test('the ladder stays on its line and finite under any step: spikes, zero, negative, NaN', () => {
  const c = { kind: 'ladder', s: 0.4 };
  for (const dt of [0, -1, NaN, Infinity, 5, 1e-9, 0.5, 1 / 60]) {
    for (const move of [1, -1, NaN, 0, 7]) {
      tower.climb(c, dt, move, 1);
      assert.ok(Number.isFinite(c.s) && c.s >= 0 && c.s <= tower.ladderLength);
      const p = tower.climbPose(c.s);
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z) && p.feet >= T.y - 1e-9 && p.feet <= T.y + T.platform.y1 + 1e-9);
    }
  }
  // One long frame moves at most a quarter of a second's climb.
  const d = { kind: 'ladder', s: 0 };
  tower.climb(d, 10, 1, 1);
  assert.ok(d.s <= CLIMB * 0.25 + 1e-9);
});

test('onto the slide from the platform\'s edge, walking out within its width; not beside it, not from the ground', () => {
  const w = T.w;
  const [x, z] = tower.at(0.05, T.platform.half - 0.1);
  const top = T.y + T.platform.y1;
  const r = tower.enter(x, z, top, w[0] * 1.4, w[1] * 1.4);
  assert.ok(r && r.u === 0 && near(r.side, 0.05, 1e-5));
  assert.equal(tower.enter(x, z, top, -w[0] * 1.4, -w[1] * 1.4), null, 'walking back in');
  assert.equal(tower.enter(x, z, top, 0, 0), null, 'standing still');
  assert.equal(tower.enter(...tower.at(0.6, T.platform.half - 0.1), top, w[0], w[1]), null, 'beside the slide');
  assert.equal(tower.enter(x, z, T.y, w[0], w[1]), null, 'from the ground under it');
});

test('down the slide: on its line all the way, 3 to 4 m/s at its foot, slower on the run-out, standing up with a little speed', () => {
  const r = { kind: 'slide', u: 0, speed: 1, side: 0.1, t: 0 };
  let done = false, t = 0, atFoot = null, last = tower.slidePose(r).feet, top = 0;
  const footU = Math.hypot(T.slide.bottom[0] - T.slide.top[0], T.slide.bottom[1] - T.slide.top[1]);
  while (!done && t < 10) {
    done = tower.slide(r, 1 / 60);
    t += 1 / 60;
    const p = tower.slidePose(r);
    const [dv, dw] = tower.local(p.x, p.z);
    assert.ok(Math.abs(dv) < T.slide.half, 'on the slide, between its sides');
    assert.ok(dw >= T.slide.top[0] - 1e-9 && dw <= T.slide.end[0] + 1e-9);
    assert.ok(p.feet <= last + 1e-9, 'only ever down');
    last = p.feet;
    top = Math.max(top, r.speed);
    if (atFoot === null && r.u >= footU) atFoot = r.speed;
  }
  assert.ok(done, 'it ends');
  assert.ok(atFoot >= 3 && atFoot <= 4, `at the foot ${atFoot?.toFixed(2)} m/s`);
  assert.ok(r.speed < atFoot, 'the run-out brakes');
  assert.ok(t > 1 && t < 3, `took ${t.toFixed(2)} s`);
  const end = tower.slidePose(r);
  const [, dw] = tower.local(end.x, end.z);
  assert.ok(near(dw, T.slide.end[0], 1e-6), 'at the run-out\'s end');
  assert.ok(end.feet - T.y < 0.5, 'a step down to the ground at most');
  const [cx, cz] = tower.carry(r);
  const s = Math.hypot(cx, cz);
  assert.ok(s > 0.5 && s <= CARRY.max + 1e-9, `standing up at ${s.toFixed(2)} m/s`);
  assert.ok(cx * T.w[0] + cz * T.w[1] > 0, 'on, away from the tower');
});

test('the slide stays finite and on its line under dt spikes, zero, negative and NaN; a long frame is cut short', () => {
  const r = { kind: 'slide', u: 0.5, speed: 2, side: 0, t: 0 };
  for (const dt of [0, -1, NaN, Infinity, 1e-9, 3, 1 / 60, 0.25]) {
    tower.slide(r, dt);
    const p = tower.slidePose(r);
    for (const v of [r.u, r.speed, r.side, p.x, p.z, p.feet, p.slope]) assert.ok(Number.isFinite(v));
    assert.ok(r.u >= 0 && r.u <= tower.slideLength);
  }
  const s = { kind: 'slide', u: 0, speed: 1, side: 0, t: 0 };
  tower.slide(s, 30);
  assert.ok(s.u < 1.5, 'at most a quarter of a second at once');
  const bad = { kind: 'slide', u: NaN, speed: NaN, side: NaN, t: 0 };
  tower.slide(bad, 1 / 60);
  assert.ok(Number.isFinite(bad.u) && Number.isFinite(bad.speed) && Number.isFinite(bad.side), 'a broken ride starts again at the top');
});

test('under the roof on the platform you stoop; not on the ground under it, not out on the slide, not at the ladder', () => {
  const top = T.y + T.platform.y1;
  assert.ok(tower.underRoof(...tower.at(0, 0), top));
  assert.ok(tower.underRoof(...tower.at(0.4, -0.6), top));
  assert.ok(!tower.underRoof(...tower.at(0, 0), T.y), 'on the ground');
  assert.ok(!tower.underRoof(...tower.at(0, 2.5), top), 'out on the slide');
  assert.ok(!tower.underRoof(...tower.at(0, T.ladder.foot), T.y), 'at the ladder\'s foot');
});
