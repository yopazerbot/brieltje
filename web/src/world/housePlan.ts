import type { Opening, Prism } from './houseData';
import { BlockGrid, Houses, inside, isBrick, renderOf } from './houseKeys';
import { houseStyle, type PlinthKind } from './houseStyle';

/**
 * Where the open-data houses' details go, in numbers only (world/houseTrim.ts builds them; world/housePlan.test.mjs
 * checks them over the committed data): the band at the foot of each house wall.
 *
 * A plinth follows the ground along the wall, as real ones do: at every corner of the wall (and at points added where
 * the ground bends between corners) it stands its house's height above the ground there, so on a slope it slopes
 * with it instead of growing at the low end. It stays under the ground floor's window sills, and a house that stands
 * on a plinth in the data keeps its plain walls.
 */

export type GroundAt = (x: number, z: number) => number;

/** Visible height of a damp base: the darker foot fades out this far above the ground. */
export const DAMP_TOP = 0.7;
/** The least a band may show above the ground anywhere along its wall, or the wall gets none. */
const LEAST = 0.2;
/** Metres a band stays under the bottom of a ground-floor window (whose stone sill reaches 10 cm under it). */
const UNDER_SILL = 0.2;

export function area(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a / 2);
}

const boxOf = (ring: [number, number][]): [number, number, number, number] => [
  Math.min(...ring.map((q) => q[0])), Math.min(...ring.map((q) => q[1])), Math.max(...ring.map((q) => q[0])), Math.max(...ring.map((q) => q[1])),
];

/** Whether (x, z) lies inside a ring or within `d` of its edges. */
function nearRing(ring: [number, number][], x: number, z: number, d: number): boolean {
  if (inside(ring, x, z)) return true;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % ring.length];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    if (Math.hypot(ax + dx * t - x, az + dz * t - z) <= d) return true;
  }
  return false;
}

/**
 * Whether block q is a plinth of wall w in the data: it goes round three quarters or more of the wall's corners (within
 * 30 cm: a plinth often stands a few centimetres proud), is up to 3.5 m high, and either rises from the wall's foot to
 * below its top (a band round it) or stops at the wall's foot (a block under it).
 */
export function isPlinthOf(q: Prism, w: Prism): boolean {
  if (q === w || q.y1 - q.y0 > 3.5) return false;
  const band = Math.abs(q.y0 - w.y0) <= 0.3 && q.y1 < w.y1 - 0.3;
  const under = Math.abs(q.y1 - w.y0) <= 0.3;
  if (!band && !under) return false;
  const ring = w.p[0];
  const covered = ring.filter(([x, z]) => nearRing(q.p[0], x, z, 0.3)).length;
  return covered >= 0.75 * ring.length;
}

export interface BasePlan {
  /** The wall's outline with points added where the ground bends between its corners */
  ring: [number, number][];
  /** The plinth (none: a damp base) */
  kind: PlinthKind;
  /** Its colour (sRGB), or null for the wall's own brick darker (and for a damp base) */
  colour: string | null;
  /** Whether the plinth is rendered (paint, cement, tar), else as the wall */
  render: boolean;
  /** Height over the ground the band reaches, and the lowest and highest it may lie (model y) */
  h: number;
  floor: number;
  limit: number;
}

/** The band's top over ground g at a point of the wall. */
export const cutAt = (b: BasePlan, g: number): number => Math.min(b.limit, Math.max(b.floor, g + b.h));

/**
 * A ring with points added along its sides where the ground bends: the ground is sampled every half metre and the
 * fewest points kept that follow it within 4 cm (a straight line between them).
 */
function followGround(ring: [number, number][], groundAt: GroundAt): [number, number][] {
  const out: [number, number][] = [];
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.5));
    const pts = Array.from({ length: n + 1 }, (_, k): [number, number, number] => {
      const x = a[0] + ((b[0] - a[0]) * k) / n;
      const z = a[1] + ((b[1] - a[1]) * k) / n;
      return [x, z, groundAt(x, z)];
    });
    const keep = new Set([0, n]);
    const split = (s: number, e: number) => {
      let worst = -1;
      let most = 0.04;
      for (let k = s + 1; k < e; k++) {
        const off = Math.abs(pts[k][2] - (pts[s][2] + ((pts[e][2] - pts[s][2]) * (k - s)) / (e - s)));
        if (off > most) [worst, most] = [k, off];
      }
      if (worst < 0) return;
      keep.add(worst);
      split(s, worst);
      split(worst, e);
    };
    split(0, n);
    for (const k of [...keep].sort((x, y) => x - y)) if (k < n) out.push(k === 0 ? a : [pts[k][0], pts[k][1]]);
  });
  return out;
}

/** One block of a door's steps: from `from` to `to` metres out from the wall, its top and bottom heights. */
export interface StepBlock {
  from: number;
  to: number;
  top: number;
  bottom: number;
}

/** Steps: a riser at most this high, a tread this deep, the top step (at the threshold) this deep, at most this many risers. */
const RISER = 0.18;
const TREAD = 0.28;
const LANDING = 0.35;
const MOST_RISERS = 6;

/**
 * The bluestone steps under a door, 30 cm wider than it: one step up to 30 cm over the ground in front, else a short
 * flight of risers of up to 18 cm down to the ground (every block standing on the ground under it); none for a door
 * more than about 1.1 m up (not a door to the street) or where the flight would run into a wall.
 */
export function planSteps(o: Opening, houses: Houses, groundAt: GroundAt): StepBlock[] {
  if (o.k !== 'd') return [];
  const l = Math.hypot(o.n[0], o.n[1]) || 1;
  const [nx, nz] = [o.n[0] / l, o.n[1] / l];
  const [mx, mz] = [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2];
  const w = Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]) || 1;
  const [dx, dz] = [(o.b[0] - o.a[0]) / w, (o.b[1] - o.a[1]) / w];
  const half = w / 2 + 0.15;
  /** The lowest ground under the strip from `from` to `to` metres out (its corners and middle). */
  const under = (from: number, to: number) => Math.min(...[from, (from + to) / 2, to].flatMap((t) => [-1, 0, 1].map((s) => groundAt(mx + nx * t + dx * s * half, mz + nz * t + dz * s * half))));
  const y0 = o.y[0];
  let risers = 1;
  for (let k = 0; k < 2; k++) {
    const rise = y0 - under(0, LANDING + (risers - 1) * TREAD);
    if (rise < 0.06) return [];
    risers = rise <= 0.3 ? 1 : Math.ceil(rise / RISER);
  }
  if (risers > MOST_RISERS) return [];
  const depth = LANDING + (risers - 1) * TREAD;
  // The flight's far corners and middle must stand in the open.
  for (const s of [-1, 0, 1]) if (houses.wallsAt(mx + nx * (depth - 0.05) + dx * s * (half - 0.05), mz + nz * (depth - 0.05) + dz * s * (half - 0.05)).length) return [];
  const rise = y0 - under(0, depth);
  const out: StepBlock[] = [];
  for (let k = 0; k < risers; k++) {
    const from = k ? LANDING + (k - 1) * TREAD : 0;
    const to = LANDING + k * TREAD;
    out.push({ from, to, top: y0 - (k * rise) / risers, bottom: under(from, to) - 0.05 });
  }
  return out;
}

/**
 * The bases of the house walls of a whole set (the ring's or the village's): per wall block of a house (brick, 2.2 m
 * or more high, 12 m² or more, standing on the ground) a plinth of its house's style, or a damp base, following the
 * ground. None for a house standing on a plinth in the data, nor for a wall that stands off the ground somewhere, nor
 * where the ground floor's windows leave no room for one.
 */
export function planBases(prisms: Prism[], openings: Opening[], houses: Houses, groundAt: GroundAt): Map<Prism, BasePlan> {
  const bricks = new BlockGrid();
  for (const p of prisms) if (isBrick(p.m) && !p.d) bricks.add(p);
  const walls = prisms.filter((p) => isBrick(p.m) && !p.d && !p.lm && p.y1 - p.y0 >= 2.2 && area(p.p[0]) >= 12);
  // On the ground: its foot no more than 25 cm over the highest ground at its corners.
  const onGround = (p: Prism) => p.y0 <= Math.max(...p.p[0].map(([x, z]) => groundAt(x, z))) + 0.25;
  const plinthed = new Set<number>();
  for (const w of walls) {
    if (onGround(w) && bricks.inBox(boxOf(w.p[0])).some((q) => isPlinthOf(q, w))) plinthed.add(houses.keyOf(w));
  }
  // The lowest window bottom on each wall block (windows with a sill: not garden doors).
  const sill = new Map<Prism, number>();
  for (const o of openings) {
    if (o.k !== 'w' || o.y[1] - o.y[0] >= 1.9) continue;
    const l = Math.hypot(o.n[0], o.n[1]) || 1;
    const x = (o.a[0] + o.b[0]) / 2 - (o.n[0] / l) * 0.3;
    const z = (o.a[1] + o.b[1]) / 2 - (o.n[1] / l) * 0.3;
    const w = houses.wallAt(x, z, o.y[0])?.p;
    if (w) sill.set(w, Math.min(sill.get(w) ?? Infinity, o.y[0]));
  }
  const out = new Map<Prism, BasePlan>();
  for (const w of walls) {
    const key = houses.keyOf(w);
    if (plinthed.has(key) || !onGround(w)) continue;
    const ring = followGround(w.p[0], groundAt);
    const ground = ring.map(([x, z]) => groundAt(x, z));
    if (ground.some((g) => w.y0 > g + 0.3)) continue; // off the ground somewhere (on a terrace, over a dip): plain
    const plinth = houseStyle(key, w.m, renderOf(w.m, key) === 1).plinth;
    const limit = Math.min((sill.get(w) ?? Infinity) - UNDER_SILL, w.y1 - 1);
    const plan = (kind: PlinthKind, h: number): BasePlan => ({
      ring, kind, h, floor: w.y0 + 0.05, limit,
      colour: kind === 'none' ? null : plinth.colour, render: kind === 'none' ? false : plinth.render,
    });
    // A band must show LEAST everywhere; a damp base (a fade) 10 cm.
    const fits = (b: BasePlan) => ground.every((g) => cutAt(b, g) - g >= (b.kind === 'none' ? 0.1 : LEAST));
    let b = plan(plinth.kind, plinth.kind === 'none' ? DAMP_TOP : plinth.height);
    if (!fits(b) && b.kind !== 'none') b = plan('none', DAMP_TOP); // no room under the sills: a damp base
    if (fits(b)) out.set(w, b);
  }
  return out;
}
