import type { Opening, Prism } from './houseData';
import { BlockGrid, Houses, inside, isBrick, renderOf, stable } from './houseKeys';
import { houseStyle, type PlinthKind } from './houseStyle';

/**
 * Where the open-data houses' details go, in numbers only (world/houseTrim.ts and world/wallCut.ts build them;
 * world/housePlan.test.mjs checks them over the committed data): the band at the foot of each house wall, and the
 * windows and doors set back in their walls (planReveals).
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

/**
 * The sides of a flat roof's lid (an nb_roof block) that get its edge trim, by number (side i from corner i to i + 1):
 * not a side that meets another lid at about its height or a wall rising beside it (the trim would stand inside it).
 */
export function flatEdgeSides(p: Prism, lids: BlockGrid, houses: Houses): number[] {
  const ring = p.p[0];
  const out: number[] = [];
  const y = p.y1 - 0.06;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % ring.length];
    const l = Math.hypot(bx - ax, bz - az);
    if (l < 0.3) continue;
    let [nx, nz] = [(bz - az) / l, -(bx - ax) / l];
    const [mx, mz] = [(ax + bx) / 2, (az + bz) / 2];
    if (inside(ring, mx + nx * 0.05, mz + nz * 0.05)) [nx, nz] = [-nx, -nz]; // outward
    const [x, z] = [mx + nx * 0.15, mz + nz * 0.15];
    if (lids.at(x, z).some((q) => q !== p && q.y0 - 0.3 <= y && y <= q.y1 + 0.3)) continue;
    if (houses.holds(x, z, y)) continue;
    out.push(i);
  }
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

// ---- Windows and doors set back in their walls ----

/** A frame stands this far round its opening on every side (world/surroundings.ts `buildOpenings`): the hole is the frame's size. */
export const FRAME = 0.05;
/** From the wall's face back to the frame's face: 10 to 16 cm, by the house's key (the glass sits 8 mm in front of the frame). */
const REVEAL_MIN = 0.1;
const REVEAL_SPAN = 0.06;
/** The least wall kept between a hole and the end of its wall face (a corner, or a bend in the outline). */
const EDGE = 0.1;
/** The least wall kept between two holes. */
const GAP = 0.06;
/** The least a hole keeps off the line where a plinth or damp base meets the wall above (two rows of faces meet there). */
const ROW_GAP = 0.03;
/** Of a sill's ends (one in the middle of a narrow window), the share that has a faint rain streak under it. */
export const STREAK_SHARE = 0.7;

/** A corner of a wall face along the ground: s metres along it, its place on the plan, the plinth's cut there (null: no band). */
export interface FacePoint {
  s: number;
  x: number;
  z: number;
  cut: number | null;
}

/**
 * A faint rain streak under a window's sill: centred s metres along the face and `half` wide each way at its top, the
 * sill's underside, narrowing down to `bottom`; at the top of its middle the wall is `dark` darker (a share), at `mid`
 * a little over half that, nothing at its edges.
 */
export interface Streak {
  s: number;
  half: number;
  top: number;
  mid: number;
  bottom: number;
  dark: number;
}

/**
 * The hole in a wall face for an opening's frame: s0 to s1 along the face, y0 to y1 high, `depth` from the wall's face
 * back to the frame's. `at`, `d` and `n`: its middle on the face's plan, the way along the face and the way it looks, for
 * the frame to stand square in it.
 */
export interface Hole {
  o: Opening;
  s0: number;
  s1: number;
  y0: number;
  y1: number;
  depth: number;
  streaks: Streak[];
  at: [number, number];
  d: [number, number];
  n: [number, number];
}

/** One flat side of a wall block (sides of its outline in one line) with holes in it. */
export interface WallFace {
  wall: Prism;
  /** Its corners along the ground, by s from 0 */
  points: FacePoint[];
  /** The block's foot and top */
  foot: number;
  top: number;
  /** The way s runs (d x up = n) and the way the face looks */
  d: [number, number];
  n: [number, number];
  holes: Hole[];
}

export interface RevealPlan {
  /** The faces with holes, per wall block */
  faces: Map<Prism, WallFace[]>;
  /** Each opening that is set back, and its hole */
  holes: Map<Opening, Hole>;
}

/** A face's points at s, linear between them: `f` of each (x, z or cut). Both rows of a face work their shared line out by this. */
export function alongFace(points: FacePoint[], s: number, f: (p: FacePoint) => number): number {
  const k = Math.max(0, points.findIndex((q, i) => i > 0 && s <= q.s) - 1);
  const [p, q] = [points[k], points[Math.min(points.length - 1, k + 1)]];
  const t = q.s - p.s > 1e-9 ? (s - p.s) / (q.s - p.s) : 0;
  // At a point exactly its own value (a + (b - a) need not come out as b).
  return t <= 0 ? f(p) : t >= 1 ? f(q) : f(p) + (f(q) - f(p)) * t;
}

/**
 * An outline's runs of sides in line, by the number of their first side and how many: where a corner lies within a
 * millimetre of the line through its two neighbours (a band's outline has points added along a side), its two sides are
 * one run. Every side is in one run, so two openings on one face find the same.
 */
const runCache = new WeakMap<[number, number][], { first: number; count: number }[]>();

function runsOf(ring: [number, number][]): { first: number; count: number }[] {
  const n = ring.length;
  const joined = ring.map((_, i) => {
    const [a, b, c] = [ring[i], ring[(i + 1) % n], ring[(i + 2) % n]];
    const l = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (l < 1e-6) return false;
    const off = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / l;
    const ahead = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) >= 0;
    return off < 0.001 && ahead; // side i and side i + 1 in line
  });
  const start = ring.findIndex((_, i) => !joined[(i - 1 + n) % n]); // a side that starts a run
  if (start < 0) return [];
  const out: { first: number; count: number }[] = [];
  let i = start;
  let seen = 0;
  while (seen < n) {
    let count = 1;
    while (seen + count < n && joined[(i + count - 1) % n]) count++;
    out.push({ first: i, count });
    seen += count;
    i = (i + count) % n;
  }
  return out;
}

/**
 * The face of wall block `p` (drawn with outline `ring`: its base plan's when it has a band) that the point (x, z) lies
 * on, made once per run of sides in line (runsOf); none on a run that bends by more than a millimetre over its length.
 */
function faceAt(p: Prism, ring: [number, number][], base: BasePlan | undefined, x: number, z: number, made: Map<number, WallFace>, groundAt: GroundAt): WallFace | null {
  const n = ring.length;
  let best = -1;
  let dist = 0.05;
  for (let i = 0; i < n; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % n];
    const l2 = (bx - ax) ** 2 + (bz - az) ** 2;
    if (l2 < 1e-6) continue;
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / l2));
    const d = Math.hypot(ax + (bx - ax) * t - x, az + (bz - az) * t - z);
    if (d < dist) [best, dist] = [i, d];
  }
  if (best < 0) return null;
  let runs = runCache.get(ring);
  if (!runs) runCache.set(ring, (runs = runsOf(ring)));
  const run = runs.find((r) => (best - r.first + n) % n < r.count);
  if (!run) return null;
  const { first, count } = run;
  const known = made.get(first);
  if (known) return known;
  const verts: [number, number][] = [];
  for (let k = 0, i = first; k <= count; k++, i = (i + 1) % n) verts.push(ring[i]);
  // Along the run, from its first corner to its last; every corner within a millimetre of that line.
  const [ax, az] = verts[0];
  const [bx, bz] = verts[verts.length - 1];
  const l = Math.hypot(bx - ax, bz - az);
  if (l < 0.3) return null;
  const [tx, tz] = [(bx - ax) / l, (bz - az) / l];
  if (verts.some((v) => Math.abs((v[0] - ax) * -tz + (v[1] - az) * tx) >= 0.001)) return null;
  // Outward: away from the inside of the outline.
  let [nx, nz] = [-tz, tx];
  const [mx, mz] = [(ring[best][0] + ring[(best + 1) % n][0]) / 2, (ring[best][1] + ring[(best + 1) % n][1]) / 2];
  if (inside(p.p[0], mx + nx * 0.05, mz + nz * 0.05)) [nx, nz] = [-nx, -nz];
  const [dx, dz] = [nz, -nx];
  const s0 = Math.min(...verts.map(([vx, vz]) => vx * dx + vz * dz));
  const points = verts
    .map(([vx, vz]): FacePoint => ({ s: vx * dx + vz * dz - s0, x: vx, z: vz, cut: base ? cutAt(base, groundAt(vx, vz)) : null }))
    .sort((u, v) => u.s - v.s);
  // Repeated corners (a side of no length) would give two points at one s.
  const kept = points.filter((q, i) => i === 0 || q.s - points[i - 1].s > 1e-4);
  const face: WallFace = { wall: p, points: kept, foot: p.y0, top: p.y1, d: [dx, dz], n: [nx, nz], holes: [] };
  made.set(first, face);
  return face;
}

/**
 * Whether a hole from s0 to s1 and y0 to y1 keeps off the line where a face's band meets the wall above: wholly above it,
 * wholly below it, or (a door) across it from below the line to above it all the way.
 */
function clearOfCut(f: WallFace, s0: number, s1: number, y0: number, y1: number): boolean {
  if (f.points[0].cut === null) return true;
  const cut = (q: FacePoint) => q.cut!;
  const cuts = [alongFace(f.points, s0, cut), alongFace(f.points, s1, cut), ...f.points.filter((q) => q.s > s0 && q.s < s1).map(cut)];
  return cuts.every((c) => c <= y0 - ROW_GAP) || cuts.every((c) => c >= y1 + ROW_GAP) || cuts.every((c) => c >= y0 + ROW_GAP && c <= y1 - ROW_GAP);
}

/**
 * The faint rain streaks under a window's sill (not under a garden door, which has none): one under each end of the
 * sill of a window 70 cm wide or more (its hole), else one under its middle, on about seven in ten of those places; 18 to
 * 28 cm wide, 50 to 120 cm long, stopping 5 cm over the band at the foot of the wall, 30 cm over the ground and 30 cm
 * over an opening below (so short under most ground-floor windows, or none).
 */
function streaksUnder(f: WallFace, h: Hole, groundAt: GroundAt): Streak[] {
  const o = h.o;
  if (o.k !== 'w' || o.y[1] - o.y[0] >= 1.9) return [];
  const at = (s: number, g: (p: FacePoint) => number) => alongFace(f.points, s, g);
  const banded = f.points[0].cut !== null;
  if (banded && Math.max(at(h.s0, (p) => p.cut!), at(h.s1, (p) => p.cut!)) > h.y0) return []; // a window in the band
  const centres = h.s1 - h.s0 < 0.7 ? [(h.s0 + h.s1) / 2] : [h.s0 + 0.16, h.s1 - 0.16];
  const out: Streak[] = [];
  centres.forEach((s, k) => {
    const r = (j: number) => stable(o.a[0], o.a[1], o.y[0], k, j, 97);
    if (r(1) >= STREAK_SHARE) return;
    const half = Math.min(0.09 + 0.05 * r(2), (h.s1 - h.s0) / 2 - 0.02);
    let bottom = h.y0 - (0.5 + 0.7 * r(3));
    for (const e of [s - half, s, s + half]) {
      bottom = Math.max(bottom, Math.max(f.foot, groundAt(at(e, (p) => p.x), at(e, (p) => p.z))) + 0.3);
      if (banded) bottom = Math.max(bottom, at(e, (p) => p.cut!) + 0.05);
    }
    for (const g of f.holes) if (g !== h && g.y1 < h.y0 && g.s0 < s + half + 0.05 && s - half - 0.05 < g.s1) bottom = Math.max(bottom, g.y1 + 0.3);
    if (h.y0 - bottom < 0.2) return;
    out.push({ s, half, top: h.y0, mid: h.y0 - 0.4 * (h.y0 - bottom), bottom, dark: 0.18 + 0.08 * r(4) });
  });
  return out;
}

/**
 * The windows, doors and garage doors of a whole set that sit back in their walls, and the holes cut for them: an
 * opening on a face of its wall block (within 2 cm of it), its frame 10 cm or more from the face's ends, 5 cm over the
 * block's foot and 10 cm under its top, 6 cm or more from another hole, clear of the line where the wall's band meets
 * the wall above (or a door across it), with the block's own inside behind it as deep as the frame sits plus 10 cm and
 * no other wall block behind or in front of it. The rest stay on the wall's face, as they were. Each hole's frame sits
 * back by its house's depth, and a window's sill gets its streaks.
 */
export function planReveals(openings: Opening[], houses: Houses, bases: Map<Prism, BasePlan>, groundAt: GroundAt): RevealPlan {
  const made = new Map<Prism, Map<number, WallFace>>();
  const holes = new Map<Opening, Hole>();
  for (const o of openings) {
    const nl = Math.hypot(o.n[0], o.n[1]) || 1;
    const [onx, onz] = [o.n[0] / nl, o.n[1] / nl];
    const [mx, mz] = [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2];
    const hit = houses.wallAt(mx - onx * 0.3, mz - onz * 0.3, (o.y[0] + o.y[1]) / 2);
    if (!hit || hit.p.lm || hit.p.d) continue;
    const p = hit.p;
    const base = bases.get(p);
    let mine = made.get(p);
    if (!mine) made.set(p, (mine = new Map()));
    const f = faceAt(p, base ? base.ring : p.p[0], base, mx, mz, mine, groundAt);
    if (!f) continue;
    const [dx, dz] = f.d;
    const [nx, nz] = f.n;
    const O = f.points[0];
    const sOf = (v: [number, number]) => (v[0] - O.x) * dx + (v[1] - O.z) * dz;
    const off = (v: [number, number]) => (v[0] - O.x) * nx + (v[1] - O.z) * nz;
    if (Math.abs(off(o.a)) > 0.02 || Math.abs(off(o.b)) > 0.02 || onx * nx + onz * nz < 0.95) continue;
    const s0 = Math.min(sOf(o.a), sOf(o.b)) - FRAME;
    const s1 = Math.max(sOf(o.a), sOf(o.b)) + FRAME;
    const [y0, y1] = [o.y[0] - FRAME, o.y[1] + FRAME];
    if (s0 < EDGE || s1 > f.points[f.points.length - 1].s - EDGE || y0 < f.foot + 0.05 || y1 > f.top - EDGE) continue;
    if (!clearOfCut(f, s0, s1, y0, y1)) continue;
    if (f.holes.some((h) => h.s0 < s1 + GAP && s0 < h.s1 + GAP && h.y0 < y1 + GAP && y0 < h.y1 + GAP)) continue;
    const depth = REVEAL_MIN + REVEAL_SPAN * stable(houses.keyOf(p), 83);
    // The block's inside behind the hole, and nothing else behind or in front of it at its height.
    const clear = [s0 + 0.02, s1 - 0.02].every((s) => {
      const x = alongFace(f.points, s, (q) => q.x);
      const z = alongFace(f.points, s, (q) => q.z);
      const [bx, bz] = [x - nx * (depth + 0.1), z - nz * (depth + 0.1)];
      if (!inside(p.p[0], bx, bz) || p.p.slice(1).some((r) => inside(r, bx, bz))) return false;
      const overlaps = (q: Prism) => q.y0 < y1 && q.y1 > y0;
      if (houses.wallsAt(bx, bz).some((w) => w.p !== p && overlaps(w.p))) return false;
      return !houses.wallsAt(x + nx * 0.05, z + nz * 0.05).some((w) => overlaps(w.p));
    });
    if (!clear) continue;
    const s = (s0 + s1) / 2;
    const hole: Hole = { o, s0, s1, y0, y1, depth, streaks: [], at: [alongFace(f.points, s, (q) => q.x), alongFace(f.points, s, (q) => q.z)], d: f.d, n: f.n };
    f.holes.push(hole);
    holes.set(o, hole);
  }
  const faces = new Map<Prism, WallFace[]>();
  for (const [p, mine] of made) {
    const list = [...mine.values()].filter((f) => f.holes.length);
    for (const f of list) for (const h of f.holes) h.streaks = streaksUnder(f, h, groundAt);
    if (list.length) faces.set(p, list);
  }
  return { faces, holes };
}

