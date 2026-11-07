/**
 * Small rigid bodies for the loose things along the streets (world/looseProps.ts): a wheelie bin knocked
 * over by a car, a parked bike falling flat, a garden chair pushed across the patio. Our own solver, no
 * physics library (DECISIONS: "Own simple collision instead of a physics library"); no imports, so the
 * node tests run it as the game does.
 *
 * A body is a box for how it turns (its inertia) and a handful of points it touches the ground with (a
 * bin's corners, a bike's wheels, pedal and handlebar ends). Each step: gravity, then for every point
 * under the ground an impulse that stops it going further down (bouncing a little when it lands hard)
 * and friction along the ground, then a ball round its middle against walls. Small steps (240 a
 * second) keep it steady; a body that has barely moved for a moment sleeps until something pushes it.
 *
 * A pole (a letterbox on its post, a sign) is anchored at its foot instead: it leans and wobbles back on
 * a spring, and a push past its yield bends it for good, the way a steel post stays bent after a car.
 */

export type V3 = [number, number, number];
/** A rotation as a quaternion: x, y, z, w */
export type Q = [number, number, number, number];

const G = 9.81;
const STEP = 1 / 240;

/** The world a body moves in. */
export interface RigidWorld {
  /** The ground's height under (x, z), looking down from y */
  ground(x: number, z: number, y: number): number;
  /** A wall in the way of a ball of radius r from a to b: its normal on the plan (pointing back out), or null */
  wall(a: V3, b: V3, r: number): [number, number] | null;
}

export interface RigidSpec {
  /** kg */
  mass: number;
  /** Half the sizes of the box its turning follows (m) */
  half: V3;
  /** Where it touches the ground, in its own frame round its centre of mass (m) */
  points: V3[];
  /** Share of the speed into the ground that comes back on a hard landing */
  bounce: number;
  /** Friction against the ground */
  friction: number;
  /** The ball round its middle that walls stop (m) */
  radius: number;
  /** Points far from the middle that walls stop too, once a frame (a bike's handlebar and saddle as it falls) */
  edges?: V3[];
}

/** v rotated by q, into `out`. */
export function rotate(q: Q, v: V3, out: V3 = [0, 0, 0]): V3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // t = 2 (q.xyz x v); v' = v + w t + q.xyz x t
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  out[0] = vx + w * tx + (y * tz - z * ty);
  out[1] = vy + w * ty + (z * tx - x * tz);
  out[2] = vz + w * tz + (x * ty - y * tx);
  return out;
}

/** a then b: the rotation b applied after a (b * a). */
export function compose(b: Q, a: Q): Q {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    bw * ax + bx * aw + by * az - bz * ay,
    bw * ay - bx * az + by * aw + bz * ax,
    bw * az + bx * ay - by * ax + bz * aw,
    bw * aw - bx * ax - by * ay - bz * az,
  ];
}

/** A turn of `angle` round the unit axis (x, y, z). */
export function axisAngle(x: number, y: number, z: number, angle: number): Q {
  const s = Math.sin(angle / 2);
  return [x * s, y * s, z * s, Math.cos(angle / 2)];
}

/** The tilt that leans an upright thing's top towards (lx, lz) on the plan, by the length of (lx, lz) in radians. */
export function leanQuat(lx: number, lz: number): Q {
  const a = Math.hypot(lx, lz);
  if (a < 1e-6) return [0, 0, 0, 1];
  // up x (lx, 0, lz) = (lz, 0, -lx)
  return axisAngle(lz / a, 0, -lx / a, a);
}

const cross = (a: V3, b: V3, out: V3): V3 => {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
};

export class RigidBody {
  /** Its centre of mass (world) */
  readonly p: V3;
  /** Its turn */
  readonly q: Q;
  /** m/s */
  readonly v: V3 = [0, 0, 0];
  /** Turning, rad/s round the world's axes */
  readonly w: V3 = [0, 0, 0];
  asleep = false;
  /** The hardest landing since it was last read (m/s into the ground) */
  knock = 0;
  /** Points on the ground in the last step */
  touching = 0;
  private still = 0;
  private invI: V3;
  private invM: number;
  private groundY = 0;
  private groundAt: [number, number] = [Infinity, Infinity];
  // Scratch vectors: no new objects per step.
  private r: V3 = [0, 0, 0];
  private t: V3 = [0, 0, 0];
  private u: V3 = [0, 0, 0];
  private back: Q = [0, 0, 0, 1];

  readonly spec: RigidSpec;

  constructor(spec: RigidSpec, p: V3, q: Q) {
    this.spec = spec;
    this.p = [...p] as V3;
    this.q = [...q] as Q;
    const [hx, hy, hz] = spec.half;
    const m = spec.mass;
    // A solid box: I = m/12 (b^2 + c^2) over the full sizes, so m/3 over the halves.
    this.invI = [3 / (m * (hy * hy + hz * hz)), 3 / (m * (hx * hx + hz * hz)), 3 / (m * (hx * hx + hy * hy))];
    this.invM = 1 / m;
  }

  /** The inverse inertia in the world's frame times x, into out. */
  private invInertia(x: V3, out: V3): V3 {
    const q = this.q;
    this.back[0] = -q[0];
    this.back[1] = -q[1];
    this.back[2] = -q[2];
    this.back[3] = q[3];
    rotate(this.back, x, out);
    out[0] *= this.invI[0];
    out[1] *= this.invI[1];
    out[2] *= this.invI[2];
    return rotate(q, out, out);
  }

  /** A push of `j` (kg m/s) at the world point `at`: it moves and turns, and wakes. */
  impulse(j: V3, at: V3): void {
    const r = this.r;
    r[0] = at[0] - this.p[0];
    r[1] = at[1] - this.p[1];
    r[2] = at[2] - this.p[2];
    this.apply(j, r);
    this.wake();
  }

  wake(): void {
    this.asleep = false;
    this.still = 0;
  }

  /** Impulse j at r from the centre of mass. */
  private apply(j: V3, r: V3): void {
    this.v[0] += j[0] * this.invM;
    this.v[1] += j[1] * this.invM;
    this.v[2] += j[2] * this.invM;
    const dw = this.invInertia(cross(r, j, this.t), this.u);
    this.w[0] += dw[0];
    this.w[1] += dw[1];
    this.w[2] += dw[2];
  }

  /** How hard it is to push the point at r along the unit n (1 / the effective mass). */
  private give(r: V3, n: V3): number {
    const a = this.invInertia(cross(r, n, this.t), this.u);
    const b = cross(a, r, this.t);
    return this.invM + b[0] * n[0] + b[1] * n[1] + b[2] * n[2];
  }

  /** Move it on by dt seconds (nothing while it sleeps). */
  step(dt: number, world: RigidWorld): void {
    if (this.asleep || !(dt > 0)) return;
    const n = Math.min(16, Math.ceil(dt / STEP));
    const h = dt / n;
    const edges = this.spec.edges ?? [];
    const before = edges.map((c) => this.toWorld(c));
    for (let i = 0; i < n && !this.asleep; i++) this.sub(h, world);
    // Its far points against walls: pushed back out along the wall's normal, their speed into it taken away.
    edges.forEach((c, i) => {
      const now = this.toWorld(c);
      const hit = world.wall(before[i], now, 0.04);
      if (!hit) return;
      const [nx, nz] = hit;
      const into = -((now[0] - before[i][0]) * nx + (now[2] - before[i][2]) * nz);
      if (into > 0) {
        this.p[0] += nx * into;
        this.p[2] += nz * into;
      }
      const r = rotate(this.q, c, this.r);
      const vn = (this.v[0] + (this.w[1] * r[2] - this.w[2] * r[1])) * nx + (this.v[2] + (this.w[0] * r[1] - this.w[1] * r[0])) * nz;
      if (vn >= 0) return;
      const n3: V3 = [nx, 0, nz];
      const j = (-(1 + this.spec.bounce) * vn) / this.give(r, n3);
      this.apply([nx * j, 0, nz * j], r);
      this.knock = Math.max(this.knock, -vn);
    });
  }

  /** A point of its own frame in the world. */
  toWorld(c: V3): V3 {
    const r = rotate(this.q, c);
    return [this.p[0] + r[0], this.p[1] + r[1], this.p[2] + r[2]];
  }

  private sub(h: number, world: RigidWorld): void {
    const { p, q, v, w, spec } = this;
    const from: V3 = [p[0], p[1], p[2]];
    v[1] -= G * h;
    p[0] += v[0] * h;
    p[1] += v[1] * h;
    p[2] += v[2] * h;
    const [qx, qy, qz, qw] = q;
    const k = 0.5 * h;
    q[0] += k * (w[0] * qw + w[1] * qz - w[2] * qy);
    q[1] += k * (-w[0] * qz + w[1] * qw + w[2] * qx);
    q[2] += k * (w[0] * qy - w[1] * qx + w[2] * qw);
    q[3] += k * (-w[0] * qx - w[1] * qy - w[2] * qz);
    const ql = Math.hypot(q[0], q[1], q[2], q[3]);
    for (let j = 0; j < 4; j++) q[j] /= ql;

    // The ground under its middle, looked up again once it has moved a little.
    if (Math.hypot(p[0] - this.groundAt[0], p[2] - this.groundAt[1]) > 0.3) {
      this.groundY = world.ground(p[0], p[2], p[1] + 0.6);
      this.groundAt = [p[0], p[2]];
    }
    const gy = this.groundY;
    const r = this.r;
    const up: V3 = [0, 1, 0];
    let deepest = 0;
    let touching = 0;
    for (const c of spec.points) {
      rotate(q, c, r);
      const depth = gy - (p[1] + r[1]);
      if (depth < -0.003) continue;
      touching++;
      deepest = Math.max(deepest, depth);
      // The point's speed: v + w x r.
      const vy = v[1] + (w[2] * r[0] - w[0] * r[2]);
      if (vy >= 0) continue;
      const e = -vy > 1.2 ? spec.bounce : 0; // no bouncing at rest: it would never settle
      const jn = (-(1 + e) * vy) / this.give(r, up);
      this.apply([0, jn, 0], r);
      this.knock = Math.max(this.knock, -vy);
      // Friction along the ground, at most `friction` times the push up.
      const vx = v[0] + (w[1] * r[2] - w[2] * r[1]);
      const vz = v[2] + (w[0] * r[1] - w[1] * r[0]);
      const vt = Math.hypot(vx, vz);
      if (vt < 1e-5) continue;
      const tdir: V3 = [-vx / vt, 0, -vz / vt];
      const jt = Math.min(vt / this.give(r, tdir), spec.friction * jn);
      this.apply([tdir[0] * jt, 0, tdir[2] * jt], r);
    }
    if (deepest > 0) p[1] += Math.min(deepest, 0.05) * 0.8;
    this.touching = touching;

    // Walls: a ball round its middle, kept off the ground's own test (that is the points' job).
    const hit = world.wall(from, p, spec.radius);
    if (hit) {
      p[0] = from[0];
      p[2] = from[2];
      const into = v[0] * hit[0] + v[2] * hit[1];
      if (into < 0) {
        v[0] -= (1 + spec.bounce) * into * hit[0];
        v[2] -= (1 + spec.bounce) * into * hit[1];
        this.knock = Math.max(this.knock, -into);
      }
      for (let j = 0; j < 3; j++) w[j] *= 0.7;
    }

    // Air, and the ground taking the spin out (rolling on edges).
    const air = Math.exp(-0.05 * h);
    const roll = Math.exp(-(touching ? 1.2 : 0.2) * h);
    for (let j = 0; j < 3; j++) {
      v[j] *= air;
      w[j] *= roll;
    }
    const slow = Math.hypot(v[0], v[1], v[2]) < 0.12 && Math.hypot(w[0], w[1], w[2]) < 0.3;
    this.still = touching >= 2 && slow ? this.still + h : 0;
    if (this.still > 0.35) {
      this.asleep = true;
      v.fill(0);
      w.fill(0);
    }
  }
}

export interface PoleSpec {
  /** How fast it wobbles (Hz) */
  hz: number;
  /** Damping ratio (0: rings for ever, 1: no wobble) */
  damping: number;
  /** Radians it leans before it stays bent */
  yield: number;
  /** The most it bends (rad) */
  maxBend: number;
}

/**
 * Something on a post anchored in the ground: its lean (where its top went, on the plan: the
 * direction, the angle as the length, rad), the bend it keeps, and how fast it leans.
 */
export class Pole {
  readonly lean: [number, number] = [0, 0];
  readonly bend: [number, number] = [0, 0];
  readonly spin: [number, number] = [0, 0];
  asleep = true;

  readonly spec: PoleSpec;

  constructor(spec: PoleSpec) {
    this.spec = spec;
  }

  /** Knocked towards (dx, dz) on the plan (a unit direction), turning at `rate` rad/s. */
  push(dx: number, dz: number, rate: number): void {
    this.spin[0] += dx * rate;
    this.spin[1] += dz * rate;
    this.asleep = false;
  }

  /** Straight again (put back). */
  reset(): void {
    this.lean.fill(0);
    this.bend.fill(0);
    this.spin.fill(0);
    this.asleep = true;
  }

  step(dt: number): void {
    if (this.asleep || !(dt > 0)) return;
    const { hz, damping, yield: give, maxBend } = this.spec;
    const w0 = 2 * Math.PI * hz;
    const n = Math.min(16, Math.ceil(dt / STEP));
    const h = dt / n;
    const { lean, bend, spin } = this;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < 2; j++) {
        spin[j] += (-w0 * w0 * (lean[j] - bend[j]) - 2 * damping * w0 * spin[j]) * h;
        lean[j] += spin[j] * h;
      }
      // Past its yield it stays bent: the bend follows the lean to within the yield.
      const dx = lean[0] - bend[0];
      const dz = lean[1] - bend[1];
      const d = Math.hypot(dx, dz);
      if (d > give) {
        const k = 1 - give / d;
        bend[0] += dx * k;
        bend[1] += dz * k;
      }
      const b = Math.hypot(bend[0], bend[1]);
      if (b > maxBend) {
        bend[0] *= maxBend / b;
        bend[1] *= maxBend / b;
      }
      const l = Math.hypot(lean[0], lean[1]);
      if (l > maxBend + give) {
        // Down on the ground: it stops there.
        lean[0] *= (maxBend + give) / l;
        lean[1] *= (maxBend + give) / l;
        const out = (spin[0] * lean[0] + spin[1] * lean[1]) / l;
        if (out > 0) {
          spin[0] -= (out * lean[0]) / l;
          spin[1] -= (out * lean[1]) / l;
        }
      }
    }
    if (Math.hypot(spin[0], spin[1]) < 0.01 && Math.hypot(lean[0] - bend[0], lean[1] - bend[1]) < 0.002) {
      lean[0] = bend[0];
      lean[1] = bend[1];
      spin.fill(0);
      this.asleep = true;
    }
  }
}
