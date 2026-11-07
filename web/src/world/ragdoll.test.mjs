import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

// The solver as the game runs it (world/ragdoll.ts has no imports).
const source = readFileSync(new URL('./ragdoll.ts', import.meta.url), 'utf8').replaceAll('export ', '');
const { Ragdoll, PARTS, SEGS, segmentOf } = new Function(stripTypeScriptTypes(source) + '\nreturn { Ragdoll, PARTS, SEGS, segmentOf };')();

// A figure 1.75 m tall standing at the origin, facing +z, knees and elbows a little bent (the points in PART_BONES' order).
const STAND = [
  [0, 0.95, 0], [0, 1.3, 0], [0, 1.5, 0], [0, 1.64, 0.02],
  [0.2, 1.42, 0], [0.25, 1.15, 0], [0.27, 0.95, 0.15],
  [-0.2, 1.42, 0], [-0.25, 1.15, 0], [-0.27, 0.95, 0.15],
  [0.1, 0.9, 0], [0.11, 0.5, 0.05], [0.11, 0.08, 0],
  [-0.1, 0.9, 0], [-0.11, 0.5, 0.05], [-0.11, 0.08, 0],
];
const BONES = [[0, 10], [0, 13], [10, 13], [1, 2], [2, 3], [0, 1], [4, 5], [5, 6], [7, 8], [8, 9], [10, 11], [11, 12], [13, 14], [14, 15]];
const start = (dx = 0, dy = 0, dz = 0) => STAND.flatMap(([x, y, z]) => [x + dx, y + dy, z + dz]);
const at = (p, i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(...a);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Blocks as world/collision.ts has them, boxes only: [minX, maxX, minZ, maxZ, top] standing on the ground at 0. */
function world(boxes = []) {
  const inBox = (b, x, z, r = 0) => x > b[0] - r && x < b[1] + r && z > b[2] - r && z < b[3] + r;
  return {
    groundAt(x, z, feet, stepUp) {
      let y = 0;
      for (const b of boxes) if (inBox(b, x, z) && b[4] <= feet + stepUp && b[4] > y) y = b[4];
      return { y };
    },
    collide(a, b, r) {
      if (b.y - r < 0) return { nx: 0, ny: 1, nz: 0 };
      for (const s of boxes) {
        if (!inBox(s, b.x, b.z, r) || b.y - r >= s[4]) continue;
        if (a.y - r >= s[4] - 1e-4) return { nx: 0, ny: 1, nz: 0 };
        const cx = Math.max(s[0], Math.min(s[1], a.x)), cz = Math.max(s[2], Math.min(s[3], a.z));
        let nx = a.x - cx, nz = a.z - cz;
        const d = Math.hypot(nx, nz);
        if (d < 1e-6) [nx, nz] = [a.x - b.x, a.z - b.z];
        const l = Math.hypot(nx, nz) || 1;
        return { nx: nx / l, ny: 0, nz: nz / l };
      }
      return null;
    },
  };
}

const finite = (rd) => rd.p.every(Number.isFinite);

test('the parts map the zombies\' bones as the loader names them', () => {
  assert.equal(segmentOf('Hips'), 0);
  assert.equal(segmentOf('Chest_2'), 1);
  assert.equal(segmentOf('Head'), 2);
  assert.equal(segmentOf('UpperArmL'), 3);
  assert.equal(segmentOf('HandL_3'), 4);
  assert.equal(segmentOf('LowerArm.R'), 6);
  assert.equal(segmentOf('FootR'), 10);
  assert.equal(segmentOf('Something'), 0);
});

test('stays finite and in place through long frames, odd frame times and big pushes', () => {
  const w = world();
  const rd = new Ragdoll(start(), { fwd: [0, 1] });
  rd.push(0, 2, -30, { x: 0, y: 1.4, z: 0 });
  const dts = [0.016, 5, NaN, 0.25, 1e9, -1, 0, Infinity, 0.001, 0.1];
  for (let i = 0; i < 400; i++) {
    rd.step(dts[i % dts.length], w, 6, 4);
    assert.ok(finite(rd), `finite after step ${i}`);
    for (let j = 0; j < PARTS; j++) assert.ok(Math.abs(rd.p[j * 3]) < 40 && rd.p[j * 3 + 1] > -0.05 && rd.p[j * 3 + 1] < 6, `point ${j} near`);
  }
  const f = new Float32Array(SEGS * 16);
  rd.frames(f);
  assert.ok(f.every(Number.isFinite));
});

test('falls and comes to rest on the ground, then sleeps', () => {
  for (const [vx, vz, iterations] of [[0, -3, 6], [0, 3, 6], [3, 0, 3], [-1, 1, 3], [0, 0, 6]]) {
    const rd = new Ragdoll(start(), { fwd: [0, 1] });
    rd.push(vx, 0.5, vz, { x: 0, y: 1.35, z: 0 });
    let t = 0;
    while (rd.awake && t < 10) {
      rd.step(1 / 60, world(), iterations);
      t += 1 / 60;
    }
    assert.equal(rd.awake, false, `asleep (push ${vx}, ${vz})`);
    assert.ok(t < 6.5, `still within the time (took ${t.toFixed(2)} s)`);
    assert.ok(rd.landed);
    assert.ok(rd.lowest() > -0.01, 'nothing under the ground');
    assert.ok(at(rd.p, 0)[1] < 0.45 && at(rd.p, 1)[1] < 0.5, `lying down (pelvis at ${at(rd.p, 0)[1].toFixed(2)} m)`);
    const before = Array.from(rd.p);
    rd.step(1, world(), iterations);
    assert.deepEqual(Array.from(rd.p), before, 'asleep: no more steps');
  }
});

test('keeps its bones\' lengths and bends knees and elbows only the right way', () => {
  const rest = BONES.map(([a, b]) => len(sub(at(start(), a), at(start(), b))));
  // The hinges' axes at the start (each joint is a little bent the natural way in STAND), carried by
  // the pelvis (knees) or the chest (elbows) and square to the upper bone, as the solver has them.
  const hinges = [[10, 11, 12, 0], [13, 14, 15, 0], [4, 5, 6, 1], [7, 8, 9, 1]].map(([a, b, c, seg]) => {
    const s = start();
    const x = cross(sub(at(s, b), at(s, a)), sub(at(s, c), at(s, b)));
    return { a, b, c, seg, axis: x.map((v) => v / len(x)) };
  });
  const f = new Float32Array(SEGS * 16);
  // Pushes as the game gives them (world/zombies.ts): a shot near where it hit (m/s), or a blast (null: the whole body, and up).
  const pushes = [[0, -1.5], [0, -3], [0, -4.5], [2.5, 0], [-2, -2], [0, 3], [3, 0]];
  let worst = 0, worstAt = '';
  for (const [vx, vz] of pushes) {
    for (const where of [1.6, 1.3, 1, null]) {
      for (const iterations of [6, 3]) {
        const rd = new Ragdoll(start(), { fwd: [0, 1] });
        rd.push(vx, where === null ? 2 : 1, vz, where === null ? null : { x: 0, y: where, z: 0 });
        const bends = () => hinges.map((h) => {
          const m = h.seg * 16;
          const A = [0, 1, 2].map((r) => f[m + r] * h.axis[0] + f[m + 4 + r] * h.axis[1] + f[m + 8 + r] * h.axis[2]);
          const u = sub(at(rd.p, h.b), at(rd.p, h.a)), v = sub(at(rd.p, h.c), at(rd.p, h.b));
          // Not folded all the way either.
          assert.ok(len(sub(at(rd.p, h.c), at(rd.p, h.a))) > 0.2 * (len(u) + len(v)), `joint ${h.b} folded flat`);
          const along = dot(A, u) / len(u);
          const axis = A.map((x, i) => x - (u[i] / len(u)) * along);
          if (len(axis) < 0.35) return [h.b, 0]; // a limb straight out along its axis: any bend will do
          return [h.b, dot(cross(u, v), axis) / (len(axis) * len(u) * len(v))];
        });
        for (let i = 0; i < 400 && rd.awake; i++) {
          rd.step(1 / 60, world(), iterations);
          BONES.forEach(([a, b], k) => {
            const l = len(sub(at(rd.p, a), at(rd.p, b)));
            const off = Math.abs(l - rest[k]) / (iterations === 6 ? 1 : 1.6); // m (fewer passes: a little more give)
            if (off > worst) [worst, worstAt] = [off, `bone ${a}-${b} push ${vx},${vz} at ${where}, ${iterations} passes, step ${i}`];
          });
          rd.frames(f);
          // Falling, a joint may go a little past straight for a moment (it is put right each pass)...
          for (const [b, bend] of bends()) assert.ok(bend > -0.25, `joint ${b} bent backwards (${bend.toFixed(2)}) after push ${vx}, ${vz} at ${where} m, ${iterations} passes, step ${i}`);
        }
        // ...but lying still, at most a few degrees.
        assert.equal(rd.awake, false);
        for (const [b, bend] of bends()) assert.ok(bend > -0.16, `joint ${b} rests bent backwards (${bend.toFixed(2)}) after push ${vx}, ${vz} at ${where} m`);
      }
    }
  }
  // A bone stretches or shrinks by at most a few centimetres, at a hard landing (the skinning moves each part as a whole).
  assert.ok(worst < 0.03, `bones keep their length (worst ${(worst * 100).toFixed(1)} cm off, ${worstAt})`);
});

test('a part\'s frame carries its start to where it is now', () => {
  const rd = new Ragdoll(start(), { fwd: [0, 1] });
  const f = new Float32Array(SEGS * 16);
  rd.frames(f);
  for (let s = 0; s < SEGS; s++) assert.deepEqual(Array.from(f.slice(s * 16, s * 16 + 16)).map((v) => Math.round(v * 1e6) / 1e6), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  rd.push(0, 0, -3, { x: 0, y: 1.4, z: 0 });
  for (let i = 0; i < 40; i++) rd.step(1 / 60, world(), 6);
  rd.frames(f);
  // The thigh's origin (left hip, point 10) and its knee (11) at the start, moved by the thigh's frame.
  const s0 = start();
  const apply = (seg, p) => [0, 1, 2].map((r) => f[seg * 16 + r] * p[0] + f[seg * 16 + 4 + r] * p[1] + f[seg * 16 + 8 + r] * p[2] + f[seg * 16 + 12 + r]);
  const hip = apply(7, at(s0, 10));
  assert.ok(len(sub(hip, at(rd.p, 10))) < 1e-6, 'the hip where it is');
  const knee = apply(7, at(s0, 11));
  assert.ok(len(sub(knee, at(rd.p, 11))) < 0.02, `the knee where it is (${len(sub(knee, at(rd.p, 11))).toFixed(3)} m off)`);
  // Pelvis: a rotation (orthonormal) and its hips where they are.
  const pel = apply(0, at(s0, 13));
  assert.ok(len(sub(pel, at(rd.p, 13))) < 0.05, `the right hip near where it is (${len(sub(pel, at(rd.p, 13))).toFixed(3)} m off: the spine bends a little)`);
});

test('a wall stops it and a step holds it up', () => {
  // A wall 0.5 m behind the figure (it is pushed back, towards -z), and a step of 18 cm behind that on the other side.
  const w = world([[-3, 3, -1.1, -0.5, 2.5]]);
  const rd = new Ragdoll(start(), { fwd: [0, 1] });
  rd.push(0, 0.5, -6, { x: 0, y: 1.4, z: 0 });
  for (let i = 0; i < 400 && rd.awake; i++) {
    rd.step(1 / 60, w, 6);
    for (let j = 0; j < PARTS; j++) assert.ok(rd.p[j * 3 + 2] > -0.5 - 0.02, `point ${j} not in the wall (z ${rd.p[j * 3 + 2].toFixed(3)})`);
  }
  // On a step: a figure standing on an 18 cm block falls onto it and the ground beside it, never under it.
  const s = world([[-0.6, 0.6, -2, 0.4, 0.18]]);
  const on = new Ragdoll(start(0, 0.18, 0), { fwd: [0, 1] });
  on.push(0, 0, 3, { x: 0, y: 1.6, z: 0 });
  for (let i = 0; i < 500 && on.awake; i++) {
    on.step(1 / 60, s, 6);
    for (let j = 0; j < PARTS; j++) {
      const [x, y, z] = at(on.p, j);
      const top = s.groundAt(x, z, y, 0).y;
      assert.ok(y - on.radius[j] > top - 0.03, `point ${j} not in the step (y ${y.toFixed(3)} over ${top})`);
    }
  }
  assert.equal(on.awake, false);
});

test('fewer iterations (phones) still settle', () => {
  const rd = new Ragdoll(start(), { fwd: [0, 1], scale: 1.5 });
  rd.push(0, 0, -2, null);
  for (let i = 0; i < 600 && rd.awake; i++) rd.step(1 / 30, world(), 3, 2);
  assert.equal(rd.awake, false);
  assert.ok(finite(rd) && rd.lowest() > -0.01);
});
