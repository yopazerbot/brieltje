import PLAYGROUND from '../../shared/playground.json' with { type: 'json' };
import type { Prism } from './houseData';

/**
 * The play tower on the school's playground (tools/school.py builds it and writes its sizes to
 * shared/playground.json): you climb its ladder, stand on its platform and go down its slide.
 *
 * The game's own collision (world/collision.ts) knows flat outlines between two heights, and the
 * player is an upright cylinder that steps up half a metre: it has no ladders and no slopes. So the
 * platform, its two boards and the posts are blocks like any other, and the ladder and the slide are
 * two rides of their own along a line, worked out here (pure, for the tests: playground.test.mjs).
 * The player (src/player.ts) hands over to them and takes over again at their ends.
 *
 * The ladder: at its foot, facing it, forward climbs (CLIMB m/s) and back climbs down; jump lets go. At
 * the top you step onto the platform; from the platform, walking out over the ladder's edge takes you
 * onto it again, and forward goes where you look (down, facing out). The slide: walking off the
 * platform onto its top sits you down; gravity along the slope less the friction sets the speed (about
 * 3.5 m/s at the foot, as a children's slide), the run-out slows you and you stand up with a little of
 * the speed left. Jump gets you off either at any moment.
 */

/** The tower as shared/playground.json has it: dv along `v`, dw along `w` (the ladder at -w, the slide at +w), heights over `y`. */
export type Tower = typeof PLAYGROUND.tower;

export const TOWER: Tower = PLAYGROUND.tower;

const G = 9.81;
/** m/s along the ladder */
export const CLIMB = 0.6;
/** Friction on the slide's sheet and on its run-out (the run-out is nearly flat: it brakes) */
export const MU = 0.15;
export const MU_OUT = 0.8;
/** m: your middle stands this far out from the ladder's rails, the way it leans */
const OFF = 0.3;
/** m: where you stand on the platform after the ladder, in from its edge */
const ON = 0.35;
/** The longest step taken at once (s); a longer frame is cut into steps this long, a very long one is cut short */
const STEP = 1 / 120;
const MAX_DT = 0.25;
/** At most this fast leaving the slide's end (m/s), and the share of the speed you keep standing up */
export const CARRY = { max: 2.0, share: 0.6 };

export interface Pose {
  x: number;
  z: number;
  feet: number;
}

/** On the ladder: metres along its line from the foot (the last stretch goes over the edge onto the platform). */
export interface Climb {
  kind: 'ladder';
  s: number;
}

/** On the slide: metres along its middle line, the speed along it, how far off the middle (m), seconds on it. */
export interface Slide {
  kind: 'slide';
  u: number;
  speed: number;
  side: number;
  t: number;
}

export type Ride = Climb | Slide;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const finite = (v: number) => (Number.isFinite(v) ? v : 0);

export class PlayTower {
  /** Its name as a place you stand on (the place line, src/i18n.ts placeName) */
  readonly name = 'play tower';
  /** The game's height of the tower's foot */
  readonly y: number;
  readonly t: Tower;
  /** The heading (yaw) that looks from the ladder towards the slide */
  readonly yaw: number;
  /** The ladder's line: (dw, height) at its foot, at its top and on the platform, and the lengths between */
  private readonly lad: [number, number][];
  private readonly ladLen: [number, number];
  /** The slide's middle line: (dw, height) at its top, foot and end, and the lengths between */
  private readonly sl: [number, number][];
  private readonly slLen: [number, number];
  /** The slope's sine and cosine, on the slide and on its run-out */
  private readonly slope: [number, number][];

  /** `base`: the game's height of the plot's ground (house.ground); the tower's own heights are over the relief there. */
  constructor(tower: Tower, base: number) {
    this.t = tower;
    this.y = base + tower.y;
    this.yaw = Math.atan2(-tower.w[0], -tower.w[1]);
    const L = tower.ladder;
    const P = tower.platform;
    this.lad = [[L.foot - OFF, 0], [L.top - OFF, L.rise], [-P.half + ON, P.y1]];
    // The step over the edge goes twice as fast as the climb: a step, not a crawl.
    this.ladLen = [Math.hypot(L.top - L.foot, L.rise), 0.5 * Math.hypot(this.lad[2][0] - this.lad[1][0], this.lad[2][1] - this.lad[1][1])];
    const S = tower.slide;
    const seat = S.thick / 2;
    this.sl = [[S.top[0], S.top[1] + seat], [S.bottom[0], S.bottom[1] + seat], [S.end[0], S.end[1] + seat]];
    const d = [0, 1].map((k) => [this.sl[k + 1][0] - this.sl[k][0], this.sl[k + 1][1] - this.sl[k][1]]);
    this.slLen = [Math.hypot(d[0][0], d[0][1]), Math.hypot(d[1][0], d[1][1])];
    this.slope = d.map(([dw, dy], k) => [-dy / this.slLen[k], dw / this.slLen[k]]);
  }

  /** A point of the tower's frame on the plan. */
  at(dv: number, dw: number): [number, number] {
    const { at, v, w } = this.t;
    return [at[0] + v[0] * dv + w[0] * dw, at[1] + v[1] * dv + w[1] * dw];
  }

  /** A point on the plan in the tower's frame: [dv, dw]. */
  local(x: number, z: number): [number, number] {
    const { at, v, w } = this.t;
    const dx = x - at[0], dz = z - at[1];
    return [dx * v[0] + dz * v[1], dx * w[0] + dz * w[1]];
  }

  /** The blocks to walk on and into: the platform, its two boards (open on the ladder's side and the slide's) and the four posts. */
  prisms(): Prism[] {
    const { platform: P, boards: B, posts } = this.t;
    const rect = (v0: number, v1: number, w0: number, w1: number): [number, number][] => [this.at(v0, w0), this.at(v1, w0), this.at(v1, w1), this.at(v0, w1)];
    const y = this.y;
    const out: Prism[] = [{ m: 'oak', n: this.name, y0: y + P.y0, y1: y + P.y1, p: [rect(-P.half, P.half, -P.half, P.half)] }];
    for (const s of [-1, 1]) {
      const [a, b] = s < 0 ? [-B.to, -B.from] : [B.from, B.to];
      out.push({ m: 'oak', n: this.name, y0: y + P.y0, y1: y + B.y1, p: [rect(a, b, -P.half, P.half)] });
    }
    const h = posts.size / 2;
    for (const dv of [-posts.at, posts.at]) {
      for (const dw of [-posts.at, posts.at]) out.push({ m: 'oak', n: this.name, y0: y + posts.foot, y1: y + posts.top, p: [rect(dv - h, dv + h, dw - h, dw + h)] });
    }
    return out;
  }

  /**
   * On the platform under the little roof (or stepping onto it from the ladder): a grown-up has no room there to
   * stand up straight or to jump, so you stoop (src/player.ts).
   */
  underRoof(x: number, z: number, feet: number): boolean {
    const [dv, dw] = this.local(x, z);
    const h = this.t.roof.half;
    return Math.abs(dv) < h && Math.abs(dw) < h + 0.1 && feet > this.y + this.t.platform.y0;
  }

  /** The ladder's whole line (m): up the rails, then over the edge onto the platform. */
  get ladderLength(): number {
    return this.ladLen[0] + this.ladLen[1];
  }

  /** The heights of the rungs over the tower's foot. */
  get rungs(): number[] {
    const L = this.t.ladder;
    return Array.from({ length: L.rungs }, (_, k) => (L.rise * (k + 1)) / (L.rungs + 1));
  }

  /** How much `yaw` looks towards the tower from the ladder's side (1: straight at it, -1: away from it). */
  facing(yaw: number): number {
    const { w } = this.t;
    return -Math.sin(yaw) * w[0] - Math.cos(yaw) * w[1];
  }

  /** Standing at the ladder's foot, facing it: forward would climb. */
  atFoot(x: number, z: number, feet: number, yaw: number): boolean {
    const [dv, dw] = this.local(x, z);
    const L = this.t.ladder;
    return Math.abs(feet - this.y) < 0.35 && Math.abs(dv) < L.half + 0.2 && dw > L.foot - OFF - 0.7 && dw < L.top - 0.25 && this.facing(yaw) > 0.5;
  }

  /**
   * Onto the ladder: from its foot, facing it and pressing forward (`moveY` > 0); or from the platform, walking out
   * over its edge on the ladder's side (`vx`, `vz` the way you move). Where on its line, or null.
   */
  grab(x: number, z: number, feet: number, yaw: number, moveY: number, vx: number, vz: number): Climb | null {
    if (this.atFoot(x, z, feet, yaw) && moveY > 0.3) return { kind: 'ladder', s: 0 };
    const [dv, dw] = this.local(x, z);
    const { ladder: L, platform: P, w } = this.t;
    const out = -(vx * w[0] + vz * w[1]);
    if (Math.abs(feet - (this.y + P.y1)) < 0.12 && Math.abs(dv) < L.half + 0.1 && dw < -P.half + 0.3 && dw > -P.half - 0.3 && out > 0.3) {
      const [[w1], [w2]] = [this.lad[1], this.lad[2]];
      return { kind: 'ladder', s: this.ladLen[0] + this.ladLen[1] * clamp((dw - w1) / (w2 - w1), 0, 1) };
    }
    return null;
  }

  /**
   * A step on the ladder: `moveY` forward (+) or back (-), `facing` as facing() says. Facing the tower forward climbs;
   * facing away (come down from the platform) forward goes down. Returns 'top' on the platform, 'bottom' on the
   * ground (then the ride is over), else null; `rungs` counts the rungs your feet passed.
   */
  climb(c: Climb, dt: number, moveY: number, facing: number): { end: 'top' | 'bottom' | null; rungs: number } {
    dt = clamp(finite(dt), 0, MAX_DT);
    const dir = facing >= -0.2 ? 1 : -1;
    const rate = clamp(finite(moveY), -1, 1) * dir * CLIMB;
    const before = this.climbPose(c.s).feet - this.y;
    c.s = clamp(finite(c.s) + rate * dt, 0, this.ladderLength);
    const after = this.climbPose(c.s).feet - this.y;
    const lo = Math.min(before, after), hi = Math.max(before, after);
    const rungs = this.rungs.filter((h) => h > lo && h <= hi).length + (lo < this.t.ladder.rise && hi >= this.t.ladder.rise ? 1 : 0);
    const end = c.s >= this.ladderLength ? 'top' : c.s <= 0 && rate < 0 ? 'bottom' : null;
    return { end, rungs };
  }

  /** Where you are on the ladder's line. */
  climbPose(s: number): Pose {
    const [l0, l1] = this.ladLen;
    const k = finite(s) <= l0 ? 0 : 1;
    const f = clamp(k === 0 ? s / l0 : (s - l0) / l1, 0, 1);
    const [w0, h0] = this.lad[k];
    const [w1, h1] = this.lad[k + 1];
    const [x, z] = this.at(0, w0 + (w1 - w0) * f);
    return { x, z, feet: this.y + h0 + (h1 - h0) * f };
  }

  /** Onto the slide: on the platform, at its edge on the slide's side, within the slide's width and walking out onto it. */
  enter(x: number, z: number, feet: number, vx: number, vz: number): Slide | null {
    const [dv, dw] = this.local(x, z);
    const { platform: P, slide: S, w } = this.t;
    const out = vx * w[0] + vz * w[1];
    if (Math.abs(feet - (this.y + P.y1)) > 0.12 || Math.abs(dv) > S.half + 0.08 || dw < P.half - 0.3 || dw > P.half + 0.4 || out < 0.15) return null;
    return { kind: 'slide', u: 0, speed: clamp(out, 0.3, 2), side: dv, t: 0 };
  }

  /** The slide's whole middle line (m), its run-out included. */
  get slideLength(): number {
    return this.slLen[0] + this.slLen[1];
  }

  /**
   * A step down the slide: the speed from gravity along the slope less the friction, braking harder on the run-out.
   * True at its end (or where the run-out has stopped you): the ride is over.
   */
  slide(r: Slide, dt: number): boolean {
    let left = clamp(finite(dt), 0, MAX_DT);
    if (!Number.isFinite(r.u) || !Number.isFinite(r.speed) || !Number.isFinite(r.side)) Object.assign(r, { u: 0, speed: 0.3, side: 0 });
    while (left > 0) {
      const h = Math.min(STEP, left);
      left -= h;
      const out = r.u >= this.slLen[0];
      const [sin, cos] = this.slope[out ? 1 : 0];
      const a = G * sin - (out ? MU_OUT : MU) * G * cos;
      r.speed = clamp(r.speed + a * h, out ? 0 : 0.2, 12);
      r.u += r.speed * h;
      r.side *= Math.exp(-h * 5);
      r.t += h;
      if (r.u >= this.slideLength || (out && r.speed <= 0.05)) {
        r.u = Math.min(r.u, this.slideLength);
        return true;
      }
    }
    return false;
  }

  /** Where you sit on the slide (a slight sway from side to side), and the slope's angle there (rad, down). */
  slidePose(r: Slide): Pose & { slope: number; sway: number } {
    const [l0, l1] = this.slLen;
    const k = r.u <= l0 ? 0 : 1;
    const f = clamp(k === 0 ? r.u / l0 : (r.u - l0) / l1, 0, 1);
    const [w0, h0] = this.sl[k];
    const [w1, h1] = this.sl[k + 1];
    const sway = Math.sin(r.t * 6.5) * 0.035 * Math.min(1, r.speed / 2.5);
    const half = this.t.slide.half - 0.12;
    const [x, z] = this.at(clamp(r.side + sway, -half, half), w0 + (w1 - w0) * f);
    return { x, z, feet: this.y + h0 + (h1 - h0) * f, slope: Math.asin(this.slope[k][0]), sway };
  }

  /** Off the slide's end: the way it points and the speed you keep standing up (m/s across). */
  carry(r: Slide): [number, number] {
    const s = Math.min(CARRY.max, r.speed * CARRY.share);
    return [this.t.w[0] * s, this.t.w[1] * s];
  }
}
