import type { Opening, Prism, RoofSpec } from './houseData';
import { BlockGrid, Houses, inside, isBrick, renderOf, stable } from './houseKeys';
import { houseStyle, type PlinthKind } from './houseStyle';

/**
 * Where the open-data houses' details go, in numbers only (world/houseTrim.ts and world/wallCut.ts build them;
 * world/housePlan.test.mjs checks them over the committed data): the band at the foot of each house wall, the windows
 * and doors set back in their walls (planReveals) and the downpipes of the flat roofs (planDownpipes).
 *
 * A plinth follows the ground along the wall, as real ones do: at every corner of the wall (and at points added where
 * the ground bends between corners) it stands its house's height above the ground there, so on a slope it slopes
 * with it instead of growing at the low end. It stays under the ground floor's window sills, and a house that stands
 * on a plinth in the data keeps its plain walls.
 */

export type GroundAt = (x: number, z: number) => number;

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
  /** The plinth */
  kind: Exclude<PlinthKind, 'none'>;
  /** Its colour (sRGB), or null for the wall's own brick darker */
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
 * or more high, 12 m² or more, standing on the ground) a plinth of its house's style, if it has one, following the
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
    // No plinth: the wall goes down to the ground as it is. It used to darken towards the foot (a damp base), which
    // read as dirt (Yoshi, 18 Nov 2026: "Do it all but not this: dirty band at the bottom of the wall").
    if (plinth.kind === 'none') continue;
    const limit = Math.min((sill.get(w) ?? Infinity) - UNDER_SILL, w.y1 - 1);
    const b: BasePlan = { ring, kind: plinth.kind, h: plinth.height, floor: w.y0 + 0.05, limit, colour: plinth.colour, render: plinth.render };
    // A band must show LEAST everywhere; where the sills leave no room for that, the wall stays plain.
    if (ground.every((g) => cutAt(b, g) - g >= LEAST)) out.set(w, b);
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

// ---- What the eaves' soffits stay over ----

/**
 * The highest frame top (an opening's top plus its frame) of the openings along a wall line, a to b on the plan, whose
 * middle lies within 35 cm of it, among those with their top between y0 and y1; -Infinity if none. For a roof's boxed
 * eaves (world/houseTrim.ts `roofEdges`): the soffit runs level from the fascia's foot to the wall unless a window there
 * reaches higher, then it rises to clear it.
 */
export type OpeningTop = (a: [number, number], b: [number, number], y0: number, y1: number) => number;

export function planOpeningTops(openings: Opening[]): OpeningTop {
  const grid = new BlockGrid();
  const ofBlock = new Map<Prism, Opening>();
  for (const o of openings) {
    const q: Prism = { m: 'opening', y0: o.y[0], y1: o.y[1], p: [[o.a, o.b, [o.a[0] + 1e-3, o.a[1] + 1e-3]]] };
    ofBlock.set(q, o);
    grid.add(q);
  }
  return (a, b, y0, y1) => {
    const [dx, dz] = [b[0] - a[0], b[1] - a[1]];
    const l2 = dx * dx + dz * dz || 1;
    let top = -Infinity;
    const box: [number, number, number, number] = [Math.min(a[0], b[0]) - 0.4, Math.min(a[1], b[1]) - 0.4, Math.max(a[0], b[0]) + 0.4, Math.max(a[1], b[1]) + 0.4];
    for (const q of grid.inBox(box)) {
      const o = ofBlock.get(q)!;
      const t2 = o.y[1] + FRAME;
      if (t2 < y0 || t2 > y1) continue;
      const [mx, mz] = [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2];
      const t = Math.max(0, Math.min(1, ((mx - a[0]) * dx + (mz - a[1]) * dz) / l2));
      if (Math.hypot(a[0] + dx * t - mx, a[1] + dz * t - mz) <= 0.35) top = Math.max(top, t2);
    }
    return top;
  };
}

// ---- Openings that stand out of their walls ----

/** An opening may reach this far (m) over the top of what stands behind it (its frame's own thickness, rounding). */
export const OPENING_SLACK = 0.05;

/**
 * A roof's height over (x, z) as world/surroundings.ts draws it, or null where the point is not over the walls' part of
 * its rectangle (the overhang left out). Its corners as world/houseTrim.ts `roofFrame` turns them (c[0]-c[1] a long
 * side unless the data fixes them); a hip's ends slope as its sides do.
 */
export function roofOver(r: RoofSpec, x: number, z: number): number | null {
  const c = r.p.slice();
  const d = (i: number, j: number) => Math.hypot(c[j][0] - c[i][0], c[j][1] - c[i][1]);
  if (!r.fixed && !r.windows && !r.gableWindows && d(0, 1) < d(1, 2)) c.push(c.shift()!);
  const L = d(0, 1);
  const W = d(0, 3);
  if (L < 1e-6 || W < 1e-6) return null;
  const [ax, az] = [(c[1][0] - c[0][0]) / L, (c[1][1] - c[0][1]) / L];
  const [bx, bz] = [(c[3][0] - c[0][0]) / W, (c[3][1] - c[0][1]) / W];
  const a = (x - c[0][0]) * ax + (z - c[0][1]) * az;
  const b = (x - c[0][0]) * bx + (z - c[0][1]) * bz;
  if (a < 0 || a > L || b < 0 || b > W) return null;
  const o = 0.3;
  if (r.closed) {
    const { at, far } = r.closed;
    return b <= at ? r.y + ((r.ridge - r.y) * b) / Math.max(0.01, at) : far + ((r.ridge - far) * (W - b)) / Math.max(0.01, W - at);
  }
  if (r.shape === 'shed') return r.y + ((r.ridge - r.y) * b) / Math.max(0.5, W);
  const eave = r.y - 0.15;
  let t = (Math.min(b, W - b) + o) / (W / 2 + o);
  if (r.shape === 'hip') t = Math.min(t, (Math.min(a, L - a) + o) / (W / 2 + o));
  return eave + Math.min(1, t) * (r.ridge - eave);
}

/**
 * The openings that would stand out of their house: whose top is over everything behind them (the top of the wall
 * blocks there, or the roof drawn over them: a gable end's triangle, a single slope's end walls) or whose foot is under
 * the walls' foot. The data puts a house's rows of windows on all its walls from its tallest part, so a low part (a
 * bungalow's wing, a garage, a back room under a flat roof) had upper windows floating over its roof. Looked at 30 cm
 * behind the opening's middle and both its ends; where no wall stands behind any of them it is kept (nothing to judge
 * by). `roofs`: the roofs as drawn (world/roofPlan.ts). These are left out of everything (frames, glass, holes, trims).
 */
export function planFloating(openings: Opening[], houses: Houses, roofs: RoofSpec[]): Set<Opening> {
  const grid = new BlockGrid();
  const roofOf = new Map<Prism, RoofSpec>();
  for (const r of roofs) {
    const q: Prism = { m: 'roof', y0: r.y, y1: r.ridge, p: [r.p] };
    roofOf.set(q, r);
    grid.add(q);
  }
  const out = new Set<Opening>();
  for (const o of openings) {
    const l = Math.hypot(o.n[0], o.n[1]) || 1;
    const [nx, nz] = [o.n[0] / l, o.n[1] / l];
    const w = Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]);
    const [dx, dz] = w > 1e-6 ? [(o.b[0] - o.a[0]) / w, (o.b[1] - o.a[1]) / w] : [0, 0];
    const inset = Math.min(0.15, w / 2);
    let judged = false;
    let fits = true;
    for (const s of [w / 2, inset, w - inset]) {
      const x = o.a[0] + dx * s - nx * 0.3;
      const z = o.a[1] + dz * s - nz * 0.3;
      const walls = houses.wallsAt(x, z);
      if (!walls.length) continue;
      judged = true;
      let top = Math.max(...walls.map((p) => p.p.y1));
      const foot = Math.min(...walls.map((p) => p.p.y0));
      for (const q of grid.at(x, z)) {
        const y = roofOver(roofOf.get(q)!, x, z);
        if (y !== null && y > top) top = y;
      }
      if (o.y[1] > top + OPENING_SLACK || o.y[0] < foot - OPENING_SLACK) {
        fits = false;
        break;
      }
    }
    if (judged && !fits) out.add(o);
  }
  return out;
}

// ---- Downpipes from the flat roofs ----

/** Of the flat roofs on a house (12 m² or more), the share with a downpipe at a corner. */
export const DOWNPIPE_SHARE = 0.85;

/**
 * A downpipe: its middle on the plan, the wall's outside (n) and the way along it (d), from `top` (the top of its head)
 * down to `bottom`; `spout`: out through the roof's edge into its head (a wall flush with the edge), else the head
 * stands under the roof reaching out over the wall.
 */
export interface Downpipe {
  x: number;
  z: number;
  n: [number, number];
  d: [number, number];
  top: number;
  bottom: number;
  spout: boolean;
}

/**
 * A downpipe for each flat roof's lid (an nb_roof block) on a house, on most of them: down a wall under one of the
 * lid's free sides (flatEdgeSides), flush with it or set back up to 40 cm, 25 cm from one of the side's ends, 3 cm off
 * the wall, from the roof's edge to the ground; not where an opening of the wall is within 30 cm, nor where anything
 * stands in its way.
 */
export function planDownpipes(prisms: Prism[], openings: Opening[], houses: Houses, lids: BlockGrid, groundAt: GroundAt): Map<Prism, Downpipe> {
  const near = new BlockGrid(); // the openings, as thin blocks, to find those round a point
  const ofBlock = new Map<Prism, Opening>();
  for (const o of openings) {
    const q: Prism = { m: 'opening', y0: o.y[0], y1: o.y[1], p: [[o.a, o.b, [o.a[0] + 1e-3, o.a[1] + 1e-3]]] };
    ofBlock.set(q, o);
    near.add(q);
  }
  const out = new Map<Prism, Downpipe>();
  for (const p of prisms) {
    if (p.m !== 'nb_roof' || p.lm || p.d || area(p.p[0]) < 12) continue;
    const ring = p.p[0];
    const key = stable(ring[0][0], ring[0][1], 89);
    if (key >= DOWNPIPE_SHARE) continue;
    const sides = flatEdgeSides(p, lids, houses);
    const places: { at: [number, number]; n: [number, number]; d: [number, number] }[] = [];
    for (const i of sides) {
      const [ax, az] = ring[i];
      const [bx, bz] = ring[(i + 1) % ring.length];
      const l = Math.hypot(bx - ax, bz - az);
      if (l < 2) continue;
      const [tx, tz] = [(bx - ax) / l, (bz - az) / l];
      let n: [number, number] = [-tz, tx];
      if (inside(ring, (ax + bx) / 2 + n[0] * 0.05, (az + bz) / 2 + n[1] * 0.05)) n = [tz, -tx];
      places.push({ at: [ax + tx * 0.25, az + tz * 0.25], n, d: [tx, tz] }, { at: [bx - tx * 0.25, bz - tz * 0.25], n, d: [tx, tz] });
    }
    // Tried in an order of the lid's own.
    places.sort((u, v) => stable(u.at[0], u.at[1], 89) - stable(v.at[0], v.at[1], 89));
    for (const { at, n, d } of places) {
      const ground = groundAt(at[0], at[1]);
      const heights = [0.15, 0.5, 0.85].map((t) => ground + 0.3 + (p.y0 - 0.1 - ground - 0.3) * t);
      // The wall under the edge, all the way down: flush with it, or set back under it by up to 40 cm.
      const holds = (k: number) => heights.every((y) => houses.holds(at[0] - n[0] * k, at[1] - n[1] * k, y));
      let inset = -1;
      for (let k = 0.02; k <= 0.42 && inset < 0; k += 0.02) if (holds(k)) inset = k - 0.02;
      if (inset < 0 || !holds(inset + 0.1)) continue;
      // The pipe 3 cm off the wall; under a roof that reaches out over the wall its head stays under the edge.
      const [x, z] = [at[0] + n[0] * (0.07 - inset), at[1] + n[1] * (0.07 - inset)];
      const bottom = groundAt(x, z) - 0.05;
      const top = inset > 0.03 ? p.y0 - 0.02 : p.y1 - 0.12;
      if (top - bottom < 1.5 || houses.wallsAt(x, z).some((w) => w.p.y1 > bottom + 0.1)) continue;
      if (lids.at(x, z).some((q) => q !== p && q.y1 > bottom + 0.1 && q.y0 < top)) continue;
      const box: [number, number, number, number] = [x - 0.4, z - 0.4, x + 0.4, z + 0.4];
      const busy = near.inBox(box).some((q) => {
        const o = ofBlock.get(q)!;
        const t = Math.max(0, Math.min(1, ((x - o.a[0]) * (o.b[0] - o.a[0]) + (z - o.a[1]) * (o.b[1] - o.a[1])) / ((o.b[0] - o.a[0]) ** 2 + (o.b[1] - o.a[1]) ** 2 || 1)));
        return Math.hypot(o.a[0] + (o.b[0] - o.a[0]) * t - x, o.a[1] + (o.b[1] - o.a[1]) * t - z) < 0.3 + 0.07 && o.y[0] < top;
      });
      if (busy) continue;
      out.set(p, { x, z, n, d, top, bottom, spout: inset <= 0.03 });
      break;
    }
  }
  return out;
}
