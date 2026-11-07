/**
 * A beaten figure going limp (world/zombies.ts): our own small solver, no physics library (DECISIONS:
 * "Own simple collision instead of a physics library"). Sixteen points sit on the skeleton's main
 * joints (pelvis, chest, neck, head, shoulders, elbows, hands, hips, knees, feet). They move by
 * Verlet steps under gravity, and sticks between them keep the bones' lengths. The pelvis and the
 * chest are stiff boxes; the spine and the neck give a little. Simple limits stop a limb bending the
 * wrong way: knees and elbows bend one way only and not all the way, a thigh doesn't fold up into the
 * chest, the head stays on its shoulders. Each point is a small ball against the game's own blocks
 * (world/collision.ts): the ground, floors, steps and walls.
 *
 * From the points come eleven parts (pelvis, chest, head, upper and lower arms and legs), each a
 * turn and a shift since the fall began. The skinning moves every bone with its part.
 *
 * Purely cosmetic and local: the server decides every hit and every death. Steps are fixed at 1/60 s,
 * at most a few a frame (a long frame slows the fall instead of blowing it up). A body that has
 * stopped moving sleeps and costs nothing more.
 */

export interface Vec {
  x: number;
  y: number;
  z: number;
}

/** The game's blocks, as world/collision.ts's World answers about them. */
export interface RagdollWorld {
  collide(a: Vec, b: Vec, r: number): { nx: number; ny: number; nz: number } | null;
  groundAt(x: number, z: number, feet: number, stepUp: number): { y: number };
}

// The points.
const PELVIS = 0, CHEST = 1, NECK = 2, HEAD = 3;
const SH_L = 4, EL_L = 5, HA_L = 6, SH_R = 7, EL_R = 8, HA_R = 9;
const HIP_L = 10, KN_L = 11, FT_L = 12, HIP_R = 13, KN_R = 14, FT_R = 15;
export const PARTS = 16;

/**
 * Where each point starts: the head of this bone (names lower case, without dots or the loader's
 * numbers). The head's point is moved up along its bone by HEAD_UP of the figure's height.
 */
export const PART_BONES = ['hips', 'chest', 'neck', 'head', 'upperarml', 'lowerarml', 'handl', 'upperarmr', 'lowerarmr', 'handr', 'upperlegl', 'lowerlegl', 'footl', 'upperlegr', 'lowerlegr', 'footr'];
export const HEAD_UP = 0.07;

// The parts.
const S_PELVIS = 0, S_CHEST = 1, S_HEAD = 2, S_UARM_L = 3, S_LARM_L = 4, S_UARM_R = 5, S_LARM_R = 6, S_THIGH_L = 7, S_SHIN_L = 8, S_THIGH_R = 9, S_SHIN_R = 10;
export const SEGS = 11;

/** Which part moves a bone, by its name (as the loader has it: 'UpperArmL', 'Foot_R', 'Head_2'). */
export function segmentOf(name: string): number {
  const n = name.replace(/_\d+$/, '').replace(/[._\s]/g, '').toLowerCase();
  const table: Record<string, number> = {
    root: S_PELVIS, hips: S_PELVIS, spine: S_PELVIS,
    chest: S_CHEST, shoulderl: S_CHEST, shoulderr: S_CHEST,
    neck: S_HEAD, head: S_HEAD,
    upperarml: S_UARM_L, lowerarml: S_LARM_L, handl: S_LARM_L,
    upperarmr: S_UARM_R, lowerarmr: S_LARM_R, handr: S_LARM_R,
    upperlegl: S_THIGH_L, lowerlegl: S_SHIN_L, footl: S_SHIN_L,
    upperlegr: S_THIGH_R, lowerlegr: S_SHIN_R, footr: S_SHIN_R,
  };
  return table[n] ?? S_PELVIS;
}

/**
 * The parts: [origin, end, parent]. The pelvis and the chest (parent -1) take their whole turn from
 * three points (origin to end, and the side: the last two numbers). The others follow their parent
 * and turn their own length the shortest way onto where it points (see pose).
 */
const SEG_DEF: [number, number, number, number, number][] = [
  [PELVIS, CHEST, -1, HIP_R, HIP_L],
  [CHEST, NECK, -1, SH_R, SH_L],
  [NECK, HEAD, S_CHEST, 0, 0],
  [SH_L, EL_L, S_CHEST, 0, 0],
  [EL_L, HA_L, S_UARM_L, 0, 0],
  [SH_R, EL_R, S_CHEST, 0, 0],
  [EL_R, HA_R, S_UARM_R, 0, 0],
  [HIP_L, KN_L, S_PELVIS, 0, 0],
  [KN_L, FT_L, S_THIGH_L, 0, 0],
  [HIP_R, KN_R, S_PELVIS, 0, 0],
  [KN_R, FT_R, S_THIGH_R, 0, 0],
];

/** Sticks: [a, b, shortest, longest] as parts of the length they start with. */
const STICKS: [number, number, number, number][] = [
  // The pelvis and the chest: stiff.
  [PELVIS, HIP_L, 1, 1], [PELVIS, HIP_R, 1, 1], [HIP_L, HIP_R, 1, 1],
  [CHEST, NECK, 1, 1], [CHEST, SH_L, 1, 1], [CHEST, SH_R, 1, 1], [SH_L, SH_R, 1, 1], [NECK, SH_L, 1, 1], [NECK, SH_R, 1, 1],
  // The spine: its length, and a little bend and twist between hips and shoulders.
  [PELVIS, CHEST, 1, 1], [PELVIS, NECK, 0.86, 1.02],
  [HIP_L, SH_L, 0.84, 1.04], [HIP_R, SH_R, 0.84, 1.04], [HIP_L, SH_R, 0.88, 1.04], [HIP_R, SH_L, 0.88, 1.04],
  // The head on its neck, nodding a little.
  [NECK, HEAD, 1, 1], [CHEST, HEAD, 0.82, 1.02],
  // Arms and legs.
  [SH_L, EL_L, 1, 1], [EL_L, HA_L, 1, 1], [SH_R, EL_R, 1, 1], [EL_R, HA_R, 1, 1],
  [HIP_L, KN_L, 1, 1], [KN_L, FT_L, 1, 1], [HIP_R, KN_R, 1, 1], [KN_R, FT_R, 1, 1],
  // A thigh doesn't fold up into the chest (about 130 degrees at most).
  [KN_L, CHEST, 0.45, Infinity], [KN_R, CHEST, 0.45, Infinity],
  // The legs don't pass through each other.
  [KN_L, KN_R, 0.5, Infinity], [FT_L, FT_R, 0.5, Infinity], [KN_L, FT_R, 0.2, Infinity], [KN_R, FT_L, 0.2, Infinity],
];

/** Fold limits: [a, b over the joint, c, shortest a-c as a part of a-b plus b-c]. */
const FOLDS: [number, number, number, number][] = [
  [HIP_L, KN_L, FT_L, 0.32], [HIP_R, KN_R, FT_R, 0.32],
  [SH_L, EL_L, HA_L, 0.26], [SH_R, EL_R, HA_R, 0.26],
];

/** Hinges: [a, joint, c, the body part that carries the joint's axis, which way it bends (1 knee, -1 elbow)]. */
const HINGES: [number, number, number, number, number][] = [
  [HIP_L, KN_L, FT_L, S_PELVIS, 1], [HIP_R, KN_R, FT_R, S_PELVIS, 1],
  [SH_L, EL_L, HA_L, S_CHEST, -1], [SH_R, EL_R, HA_R, S_CHEST, -1],
];

/** Point radii (m, for a figure 1.75 m tall) and weights (heavier points move less when pulled). */
const RADIUS = [0.1, 0.12, 0.08, 0.12, 0.08, 0.06, 0.06, 0.08, 0.06, 0.06, 0.09, 0.07, 0.07, 0.09, 0.07, 0.07];
const MASS = [3, 3, 1.5, 1.5, 1.5, 1, 0.7, 1.5, 1, 0.7, 2, 1.2, 1, 2, 1.2, 1];

const STEP = 1 / 60;
const GRAVITY = 9.81;
const DAMP = 0.996; // per step, the air
const DAMP_DOWN = 0.975; // per step once it has hit the ground: a limp body soaks up its fall
const FRICTION = 0.3; // part of the sliding speed lost per step on the ground
const VMAX = 14; // m/s at most, per point
const SLEEP_MOVE = 0.0015; // m per step: less than this is still
const SLEEP_STEPS = 24; // still for this many steps: asleep
const SLEEP_AFTER = 0.6; // s: never asleep before this
const MAX_AGE = 6; // s: asleep after this whatever it does
const HINGE_GIVE = 0.12; // sine of the angle a knee or elbow may go past straight

export interface RagdollOptions {
  /** Which way the figure faced (unit, on the ground) */
  fwd: [number, number];
  /** Its height over 1.75 m (the big one's about 1.5): the radii follow */
  scale?: number;
  /** Each point's speed at the start (m/s, 3 per point): the clip's own movement and the figure's walk */
  vel?: ArrayLike<number>;
}

// 3x3 matrices, row-major, in a Float64Array at an offset.
function mul3(a: Float64Array, ao: number, b: Float64Array, bo: number, out: Float64Array, oo: number): void {
  for (let i = 0; i < 3; i++) {
    const a0 = a[ao + i * 3], a1 = a[ao + i * 3 + 1], a2 = a[ao + i * 3 + 2];
    out[oo + i * 3] = a0 * b[bo] + a1 * b[bo + 3] + a2 * b[bo + 6];
    out[oo + i * 3 + 1] = a0 * b[bo + 1] + a1 * b[bo + 4] + a2 * b[bo + 7];
    out[oo + i * 3 + 2] = a0 * b[bo + 2] + a1 * b[bo + 5] + a2 * b[bo + 8];
  }
}

/** The basis of a framed part (columns: side, along, front) from its length `u` and side `s`. */
function basis(ux: number, uy: number, uz: number, sx: number, sy: number, sz: number, out: Float64Array, o: number): void {
  let l = Math.hypot(ux, uy, uz) || 1;
  ux /= l; uy /= l; uz /= l;
  const d = sx * ux + sy * uy + sz * uz;
  sx -= ux * d; sy -= uy * d; sz -= uz * d;
  l = Math.hypot(sx, sy, sz);
  if (l < 1e-6) {
    // The side along the length (can't happen to a stiff box, but stay finite): any side.
    [sx, sy, sz] = Math.abs(ux) < 0.9 ? [0, -uz, uy] : [uz, 0, -ux];
    l = Math.hypot(sx, sy, sz);
  }
  sx /= l; sy /= l; sz /= l;
  const fx = sy * uz - sz * uy, fy = sz * ux - sx * uz, fz = sx * uy - sy * ux;
  out[o] = sx; out[o + 1] = ux; out[o + 2] = fx;
  out[o + 3] = sy; out[o + 4] = uy; out[o + 5] = fy;
  out[o + 6] = sz; out[o + 7] = uz; out[o + 8] = fz;
}

/** The shortest turn taking unit u to unit v (row-major). */
function arc(ux: number, uy: number, uz: number, vx: number, vy: number, vz: number, out: Float64Array, o: number): void {
  const c = ux * vx + uy * vy + uz * vz;
  if (c < -0.9999) {
    // Half a turn about any line across u.
    let [ax, ay, az] = Math.abs(ux) < 0.9 ? [0, -uz, uy] : [uz, 0, -ux];
    const l = Math.hypot(ax, ay, az) || 1;
    ax /= l; ay /= l; az /= l;
    out.set([2 * ax * ax - 1, 2 * ax * ay, 2 * ax * az, 2 * ay * ax, 2 * ay * ay - 1, 2 * ay * az, 2 * az * ax, 2 * az * ay, 2 * az * az - 1], o);
    return;
  }
  const kx = uy * vz - uz * vy, ky = uz * vx - ux * vz, kz = ux * vy - uy * vx;
  const f = 1 / (1 + c);
  // I + K + K^2 / (1 + c), K the cross-product matrix of k = u x v.
  out[o] = 1 - (ky * ky + kz * kz) * f;
  out[o + 1] = -kz + kx * ky * f;
  out[o + 2] = ky + kx * kz * f;
  out[o + 3] = kz + kx * ky * f;
  out[o + 4] = 1 - (kx * kx + kz * kz) * f;
  out[o + 5] = -kx + ky * kz * f;
  out[o + 6] = -ky + kx * kz * f;
  out[o + 7] = kx + ky * kz * f;
  out[o + 8] = 1 - (kx * kx + ky * ky) * f;
}

export class Ragdoll {
  /** The points now, and a step ago (their speed is the difference) */
  readonly p = new Float64Array(PARTS * 3);
  private q = new Float64Array(PARTS * 3);
  /** Where they started (the parts' turns are since then) */
  private p0 = new Float64Array(PARTS * 3);
  private inv = new Float64Array(PARTS);
  readonly radius = new Float64Array(PARTS);
  private sticks: Float64Array;
  private folds: Float64Array;
  /** Per part: its turn now (3x3), the framed parts' start basis, the others' start direction */
  private rot = new Float64Array(SEGS * 9);
  private b0 = new Float64Array(2 * 9);
  private d0 = new Float64Array(SEGS * 3);
  /** Per hinge: its axis at the start */
  private axis0 = new Float64Array(HINGES.length * 3);
  private fwd0: [number, number, number];
  private tmp = new Float64Array(18);
  private tops = new Float64Array(PARTS);
  private rotOld = new Float64Array(SEGS * 9);
  private m3 = new Float64Array(18);
  /** The points at the end of the last step: clear of the blocks */
  private safe = new Float64Array(PARTS * 3);
  private acc = 0;
  private still = 0;
  /** Seconds it has fallen; false once it lies still (or was frozen) */
  age = 0;
  awake = true;
  /** More than its feet touched the ground or a floor: it lies there (it soaks up its speed from now on) */
  landed = false;

  /** `start`: the points' places (x, y, z each, PART_BONES' order) as the figure stood when it fell. */
  constructor(start: ArrayLike<number>, opts: RagdollOptions) {
    const scale = opts.scale ?? 1;
    for (let i = 0; i < PARTS * 3; i++) this.p[i] = this.p0[i] = this.safe[i] = start[i];
    for (let i = 0; i < PARTS; i++) {
      this.inv[i] = 1 / MASS[i];
      this.radius[i] = RADIUS[i] * scale;
      const v = opts.vel;
      for (let c = 0; c < 3; c++) this.q[i * 3 + c] = this.p[i * 3 + c] - (v ? Math.max(-VMAX, Math.min(VMAX, v[i * 3 + c] || 0)) : 0) * STEP;
    }
    const len = (a: number, b: number) => Math.hypot(start[b * 3] - start[a * 3], start[b * 3 + 1] - start[a * 3 + 1], start[b * 3 + 2] - start[a * 3 + 2]);
    this.sticks = new Float64Array(STICKS.length * 4);
    STICKS.forEach(([a, b, lo, hi], i) => {
      const l = len(a, b);
      this.sticks.set([a, b, l * lo, l * hi], i * 4);
    });
    this.folds = new Float64Array(FOLDS.length * 3);
    FOLDS.forEach(([a, b, c, k], i) => this.folds.set([a, c, (len(a, b) + len(b, c)) * k], i * 3));
    const [fx, fz] = opts.fwd;
    const fl = Math.hypot(fx, fz) || 1;
    this.fwd0 = [fx / fl, 0, fz / fl];
    // The parts as they start: the framed ones' bases, the others' directions; no turn yet.
    SEG_DEF.forEach(([o, e, parent, s0, s1], s) => {
      const p = this.p;
      if (parent < 0) basis(p[e * 3] - p[o * 3], p[e * 3 + 1] - p[o * 3 + 1], p[e * 3 + 2] - p[o * 3 + 2], p[s1 * 3] - p[s0 * 3], p[s1 * 3 + 1] - p[s0 * 3 + 1], p[s1 * 3 + 2] - p[s0 * 3 + 2], this.b0, s * 9);
      else {
        const l = len(o, e) || 1;
        this.d0.set([(p[e * 3] - p[o * 3]) / l, (p[e * 3 + 1] - p[o * 3 + 1]) / l, (p[e * 3 + 2] - p[o * 3 + 2]) / l], s * 3);
      }
      this.rot.set([1, 0, 0, 0, 1, 0, 0, 0, 1], s * 9);
    });
    // The hinges' axes: across the bend if the joint is bent, else across the figure (a knee's to
    // its side, bending forward; an elbow's the other way round).
    const [ux, uy, uz] = [0, 1, 0];
    const across = [uy * this.fwd0[2] - uz * this.fwd0[1], uz * this.fwd0[0] - ux * this.fwd0[2], ux * this.fwd0[1] - uy * this.fwd0[0]];
    HINGES.forEach(([a, b, c, , way], h) => {
      const p = this.p;
      const t = [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]];
      const f = [p[c * 3] - p[b * 3], p[c * 3 + 1] - p[b * 3 + 1], p[c * 3 + 2] - p[b * 3 + 2]];
      const x = [t[1] * f[2] - t[2] * f[1], t[2] * f[0] - t[0] * f[2], t[0] * f[1] - t[1] * f[0]];
      const xl = Math.hypot(x[0], x[1], x[2]);
      const tl = Math.hypot(t[0], t[1], t[2]) * Math.hypot(f[0], f[1], f[2]) || 1;
      const guess = [across[0] * way, across[1] * way, across[2] * way];
      const bent = xl / tl > 0.15 && x[0] * guess[0] + x[1] * guess[1] + x[2] * guess[2] > 0;
      this.axis0.set(bent ? [x[0] / xl, x[1] / xl, x[2] / xl] : guess, h * 3);
    });
  }

  /**
   * A push: every point's speed changes by (vx, vy, vz) m/s, most near `at` (within about `reach` m),
   * a part of it everywhere (so the whole body goes along).
   */
  push(vx: number, vy: number, vz: number, at: Vec | null, reach = 0.5, everywhere = 0.35): void {
    for (let i = 0; i < PARTS; i++) {
      let w = 1;
      if (at) {
        const d2 = (this.p[i * 3] - at.x) ** 2 + (this.p[i * 3 + 1] - at.y) ** 2 + (this.p[i * 3 + 2] - at.z) ** 2;
        w = everywhere + (1 - everywhere) * Math.exp(-d2 / (reach * reach));
      }
      this.q[i * 3] -= vx * w * STEP;
      this.q[i * 3 + 1] -= vy * w * STEP;
      this.q[i * 3 + 2] -= vz * w * STEP;
    }
    this.awake = true;
    this.still = 0;
  }

  /** Lets it fall for `dt` s: whole steps of 1/60 s, at most `maxSteps` (the rest is dropped: a long frame slows it down). */
  step(dt: number, world: RagdollWorld, iterations = 6, maxSteps = 4): void {
    if (!this.awake) return;
    this.acc += Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.25)) : 0;
    let n = 0;
    while (this.acc >= STEP && n < maxSteps && this.awake) {
      this.substep(world, iterations);
      this.acc -= STEP;
      n++;
    }
    if (n >= maxSteps) this.acc = 0;
  }

  private substep(world: RagdollWorld, iterations: number): void {
    const p = this.p, q = this.q;
    const g = GRAVITY * STEP * STEP;
    const vmax = VMAX * STEP;
    const damp = this.landed ? DAMP_DOWN : DAMP;
    for (let i = 0; i < PARTS * 3; i += 3) {
      let vx = (p[i] - q[i]) * damp, vy = (p[i + 1] - q[i + 1]) * damp, vz = (p[i + 2] - q[i + 2]) * damp;
      const v = Math.hypot(vx, vy, vz);
      if (v > vmax) {
        vx *= vmax / v; vy *= vmax / v; vz *= vmax / v;
      }
      q[i] = p[i]; q[i + 1] = p[i + 1]; q[i + 2] = p[i + 2];
      p[i] += vx; p[i + 1] += vy - g; p[i + 2] += vz;
    }
    // The floor under each point, looked up once a step; the sticks and limits work on top of it.
    const tops = this.tops;
    for (let i = 0; i < PARTS; i++) tops[i] = world.groundAt(p[i * 3], p[i * 3 + 2], p[i * 3 + 1], this.radius[i] + 0.25).y + this.radius[i];
    this.pose();
    for (let it = 0; it < iterations; it++) {
      this.solveSticks();
      this.limits();
      for (let i = 0; i < PARTS; i++) if (p[i * 3 + 1] < tops[i]) p[i * 3 + 1] = tops[i];
    }
    this.solveSticks();
    this.collide(world);
    // Gone wrong anyhow (it shouldn't): back to the last good places, and still.
    let move = 0;
    for (let i = 0; i < PARTS * 3; i++) {
      const d = Math.abs(p[i] - q[i]);
      if (!(d < 1e3)) {
        p.set(q);
        this.awake = false;
        return;
      }
      if (d > move) move = d;
    }
    this.age += STEP;
    this.still = move < SLEEP_MOVE ? this.still + 1 : 0;
    if ((this.still >= SLEEP_STEPS && this.age > SLEEP_AFTER) || this.age > MAX_AGE) {
      this.awake = false;
      q.set(p);
    }
  }

  private solveSticks(): void {
    const p = this.p, s = this.sticks, inv = this.inv;
    const pull = (a: number, b: number, lo: number, hi: number) => {
      const dx = p[b * 3] - p[a * 3], dy = p[b * 3 + 1] - p[a * 3 + 1], dz = p[b * 3 + 2] - p[a * 3 + 2];
      const l = Math.hypot(dx, dy, dz);
      if (l < 1e-9) return;
      const target = l < lo ? lo : l > hi ? hi : l;
      if (target === l) return;
      const k = (l - target) / (l * (inv[a] + inv[b]));
      p[a * 3] += dx * k * inv[a]; p[a * 3 + 1] += dy * k * inv[a]; p[a * 3 + 2] += dz * k * inv[a];
      p[b * 3] -= dx * k * inv[b]; p[b * 3 + 1] -= dy * k * inv[b]; p[b * 3 + 2] -= dz * k * inv[b];
    };
    for (let i = 0; i < s.length; i += 4) pull(s[i], s[i + 1], s[i + 2], s[i + 3]);
    const f = this.folds;
    for (let i = 0; i < f.length; i += 3) pull(f[i], f[i + 1], f[i + 2], Infinity);
  }

  /** A vector (x, y, z) fixed in part `s` (as it was at the start) where it points now. */
  private turned(s: number, x: number, y: number, z: number, out: Float64Array, o: number): void {
    const r = this.rot;
    const b = s * 9;
    out[o] = r[b] * x + r[b + 1] * y + r[b + 2] * z;
    out[o + 1] = r[b + 3] * x + r[b + 4] * y + r[b + 5] * z;
    out[o + 2] = r[b + 6] * x + r[b + 7] * y + r[b + 8] * z;
  }

  /** The joints' limits: the head on its shoulders, knees and elbows bending one way. */
  private limits(): void {
    const p = this.p, q = this.q, t = this.tmp;
    // The head: within about 55 degrees of the chest's line.
    let cx = p[NECK * 3] - p[CHEST * 3], cy = p[NECK * 3 + 1] - p[CHEST * 3 + 1], cz = p[NECK * 3 + 2] - p[CHEST * 3 + 2];
    const cl = Math.hypot(cx, cy, cz) || 1;
    cx /= cl; cy /= cl; cz /= cl;
    const hx = p[HEAD * 3] - p[NECK * 3], hy = p[HEAD * 3 + 1] - p[NECK * 3 + 1], hz = p[HEAD * 3 + 2] - p[NECK * 3 + 2];
    const hl = Math.hypot(hx, hy, hz);
    if (hl > 1e-6) {
      const e = (hx * cx + hy * cy + hz * cz) / hl;
      if (e < 0.57) {
        const fix = (0.57 - e) * hl;
        p[HEAD * 3] += cx * fix; p[HEAD * 3 + 1] += cy * fix; p[HEAD * 3 + 2] += cz * fix;
      }
    }
    // Knees and elbows: bent the wrong way past straight, the lower bone turns back to straight.
    const axis0 = this.axis0;
    for (let h = 0; h < HINGES.length; h++) {
      const [a, b, c, seg] = HINGES[h];
      // The axis as the body (pelvis or chest) carries it, square to the upper bone: the hip and the
      // shoulder may turn the limb about its length. Along the bone (a leg straight out to the side)
      // any bend will do.
      this.turned(seg, axis0[h * 3], axis0[h * 3 + 1], axis0[h * 3 + 2], t, 0);
      let ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
      const ul = Math.hypot(ux, uy, uz) || 1;
      ux /= ul; uy /= ul; uz /= ul;
      const along = t[0] * ux + t[1] * uy + t[2] * uz;
      let ax = t[0] - ux * along, ay = t[1] - uy * along, az = t[2] - uz * along;
      const al = Math.hypot(ax, ay, az);
      if (al < 0.35) continue;
      ax /= al; ay /= al; az /= al;
      // "Back": where a natural bend takes the lower bone (axis x upper bone).
      const bx = ay * uz - az * uy, by = az * ux - ax * uz, bz = ax * uy - ay * ux;
      const vx = p[c * 3] - p[b * 3], vy = p[c * 3 + 1] - p[b * 3 + 1], vz = p[c * 3 + 2] - p[b * 3 + 2];
      const vl = Math.hypot(vx, vy, vz);
      // The lower bone in those three directions: along the upper one, back, along the axis. A few
      // degrees past straight is fine (lying flat, a straight leg rests a little past straight).
      let sU = vx * ux + vy * uy + vz * uz;
      const sB = vx * bx + vy * by + vz * bz, sA = vx * ax + vy * ay + vz * az;
      if (sB >= -HINGE_GIVE * vl) continue;
      if (sU < 0) sU = vl; // folded back the wrong way: straight on
      // Its back part taken out, turned about the joint with its length kept (so the sticks don't fight it).
      let wx = ux * sU + ax * sA, wy = uy * sU + ay * sA, wz = uz * sU + az * sA;
      const wl = Math.hypot(wx, wy, wz);
      if (wl < 1e-6) continue;
      wx *= vl / wl; wy *= vl / wl; wz *= vl / wl;
      // Not into the floor: there the joint goes up instead (a knee lifts off the ground, the foot
      // stays on it), so the two don't push each other back and forth.
      const under = this.tops[c] - (p[b * 3 + 1] + wy);
      if (under > 0) {
        p[b * 3 + 1] += under;
        q[b * 3 + 1] += under;
      }
      // The end moves (and where it was a step ago: putting a joint right adds no speed).
      const dx = p[b * 3] + wx - p[c * 3], dy = p[b * 3 + 1] + wy - p[c * 3 + 1], dz = p[b * 3 + 2] + wz - p[c * 3 + 2];
      p[c * 3] += dx; p[c * 3 + 1] += dy; p[c * 3 + 2] += dz;
      q[c * 3] += dx; q[c * 3 + 1] += dy; q[c * 3 + 2] += dz;
    }
  }

  /** Each point a ball against the blocks: on the ground or a floor (with friction), out of walls. */
  private collide(world: RagdollWorld): void {
    const p = this.p, q = this.q;
    const a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < PARTS; i++) {
      const o = i * 3;
      const r = this.radius[i];
      // On the ground, a floor or a step (the one under it this step: one it sank into a little comes up onto it).
      if (p[o + 1] < this.tops[i] + 1e-3) {
        p[o + 1] = this.tops[i] + 1e-4;
        q[o + 1] = p[o + 1]; // no bounce
        q[o] = p[o] - (p[o] - q[o]) * (1 - FRICTION);
        q[o + 2] = p[o + 2] - (p[o + 2] - q[o + 2]) * (1 - FRICTION);
        if (i !== FT_L && i !== FT_R) this.landed = true; // more than the feet it stood on
      }
      // From where it was at the end of the last step (clear of every block) to where it is now.
      const s = this.safe;
      a.x = s[o]; a.y = s[o + 1]; a.z = s[o + 2];
      b.x = p[o]; b.y = p[o + 1]; b.z = p[o + 2];
      const hit = world.collide(a, b, r);
      if (!hit) continue;
      if (hit.ny > 0.5) {
        // A top it came down on that the floor test didn't see (more than a step above): stays on it.
        p[o + 1] = Math.max(p[o + 1], s[o + 1]);
        q[o + 1] = p[o + 1];
        if (i !== FT_L && i !== FT_R) this.landed = true; // more than the feet it stood on
      } else if (hit.ny < -0.5) {
        p[o + 1] = Math.min(p[o + 1], s[o + 1]);
      } else {
        // A wall: back out of it as far as it went in since the last step (and a little more), and
        // no more speed into it.
        const hl = Math.hypot(hit.nx, hit.nz) || 1;
        const nx = hit.nx / hl, nz = hit.nz / hl;
        const into = (p[o] - s[o]) * nx + (p[o + 2] - s[o + 2]) * nz;
        if (into < 0) {
          p[o] -= nx * into;
          p[o + 2] -= nz * into;
        }
        p[o] += nx * 0.004;
        p[o + 2] += nz * 0.004;
        const v = (p[o] - q[o]) * nx + (p[o + 2] - q[o + 2]) * nz;
        if (v < 0) {
          q[o] += nx * v;
          q[o + 2] += nz * v;
        }
      }
    }
    this.safe.set(p);
  }

  /**
   * Every part's turn since the start, from the points now. A limb carries on from its own last turn:
   * turned along with its parent since then, then the shortest way onto where it points now. Each
   * of those turns is small (so it never jumps, even with an arm over the head), and a limb keeps
   * the twist it had.
   */
  private pose(): void {
    const p = this.p, r = this.rot, old = this.rotOld, t = this.tmp, m = this.m3;
    old.set(r);
    SEG_DEF.forEach(([o, e, parent, s0, s1], s) => {
      const ux = p[e * 3] - p[o * 3], uy = p[e * 3 + 1] - p[o * 3 + 1], uz = p[e * 3 + 2] - p[o * 3 + 2];
      const k = s * 9;
      if (parent < 0) {
        // R = B now times B at the start, turned over (its inverse).
        basis(ux, uy, uz, p[s1 * 3] - p[s0 * 3], p[s1 * 3 + 1] - p[s0 * 3 + 1], p[s1 * 3 + 2] - p[s0 * 3 + 2], t, 0);
        const b0 = this.b0;
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) r[k + i * 3 + j] = t[i * 3] * b0[k + j * 3] + t[i * 3 + 1] * b0[k + j * 3 + 1] + t[i * 3 + 2] * b0[k + j * 3 + 2];
        }
        return;
      }
      // The parent's turn since last time (new times old turned over), on this part's last turn.
      const pk = parent * 9;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) m[i * 3 + j] = r[pk + i * 3] * old[pk + j * 3] + r[pk + i * 3 + 1] * old[pk + j * 3 + 1] + r[pk + i * 3 + 2] * old[pk + j * 3 + 2];
      }
      mul3(m, 0, old, k, m, 9);
      // Where that carries the start direction, then the shortest turn onto the direction now.
      const d = this.d0;
      t[0] = m[9] * d[s * 3] + m[10] * d[s * 3 + 1] + m[11] * d[s * 3 + 2];
      t[1] = m[12] * d[s * 3] + m[13] * d[s * 3 + 1] + m[14] * d[s * 3 + 2];
      t[2] = m[15] * d[s * 3] + m[16] * d[s * 3 + 1] + m[17] * d[s * 3 + 2];
      const l = Math.hypot(ux, uy, uz) || 1;
      arc(t[0], t[1], t[2], ux / l, uy / l, uz / l, t, 9);
      mul3(t, 9, m, 9, r, k);
    });
  }

  /**
   * Each part's move since the start as a 4x4 matrix (column-major, 16 numbers a part, as three.js
   * has them): a point of the figure as it stood goes where that part has it now.
   */
  frames(out: Float32Array | Float64Array): void {
    this.pose();
    const p = this.p, p0 = this.p0, r = this.rot;
    SEG_DEF.forEach(([o], s) => {
      const k = s * 9, m = s * 16;
      const ox = p0[o * 3], oy = p0[o * 3 + 1], oz = p0[o * 3 + 2];
      for (let i = 0; i < 3; i++) {
        out[m + i] = r[k + i * 3];
        out[m + 4 + i] = r[k + i * 3 + 1];
        out[m + 8 + i] = r[k + i * 3 + 2];
        out[m + 12 + i] = p[o * 3 + i] - (r[k + i * 3] * ox + r[k + i * 3 + 1] * oy + r[k + i * 3 + 2] * oz);
      }
      out[m + 3] = out[m + 7] = out[m + 11] = 0;
      out[m + 15] = 1;
    });
  }

  /** The lowest point of it (its ball's bottom), for the patch on the ground. */
  lowest(): number {
    let y = Infinity;
    for (let i = 0; i < PARTS; i++) y = Math.min(y, this.p[i * 3 + 1] - this.radius[i]);
    return y;
  }
}
