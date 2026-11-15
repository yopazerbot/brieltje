import type { Opening, Prism } from './houseData';
import { BlockGrid, inside, stable } from './houseKeys';

/**
 * The plots in front of the village's generated houses, in numbers only (world/villagePlots.ts gathers what they need
 * and main.ts adds them to the village's covers before they are claimed; world/plots.test.mjs checks them). The data has
 * paving where the aerial photo saw it, but often lawn from the door to the road. Here, where a straight way from a door
 * to a street is free: a paved path 1.1 m wide; from a garage door a drive as wide as the door and 20 cm each side.
 *
 * They are ground covers as the data's (world/groundLayers.ts claims them by rank after the data's own, so the data's
 * paving, the streets and the houses win every overlap): drawn only, in no collision, never seen by the server. Picked
 * by the house's key (its corner in model coordinates), so every player sees the same. The village only, and none near
 * our models: the ring round the home, the hand-built streets and homes, the church, the school and the football ground
 * keep theirs.
 */

/** A path's half width (m). */
const PATH_HALF = 0.55;
/** The longest way from a door to a street (m), and from a garage door. */
const PATH_MAX = 14;
const DRIVE_MAX = 16;
/** A drive reaches this far either side of its garage door (m). */
const DRIVE_SIDE = 0.2;
/** Less lawn than this (m) on the way: the data's paving is there already, no path. */
const MIN_LAWN = 0.5;
/** A way runs this far into the street's drawn hard edge (m), under its edge, so no grass shows between them. */
const INTO_STREET = 0.05;
/** A way that meets its street at less than this (degrees) is left out: it would run along it. */
const MIN_ANGLE = 45;
/** A block whose top lies this close (m) under the ground or above it lies on the ground (a deck, a terrace). */
const GROUND_SLACK = 0.05;
/** The steps a way is walked in (m), from this far out from the wall. */
const STEP = 0.25;
const START = 0.3;
/** What stands by a way is cleared by this much (m) beyond its half width: a tree by more, a pond's rim so far. */
const CLEAR = 0.2;
const TREE_CLEAR = 0.6;
const POND_CLEAR = 0.5;
/** No way starts or runs within this much (m) of a house or street one of our models stands for. */
const MODEL_CLEAR = 12;
/** A block standing at the ground stops a way: from under this over the ground (m) (a canopy overhead is no obstacle). */
const STAND_LOW = 1.5;
/** The paths' and drives' surfaces by the house's key: warm pavers, light pavers, the rest gravel. */
const PAVE_WARM = 0.45;
const PAVE_LIGHT = 0.35;
/** A parked car's half length and half width (m), as the traffic parks them. */
const CAR_HALF: [number, number] = [2.45, 1];

/** A street's run (world/roadDetail.ts, data/roadDetail.json): stations x, z; half widths and aprons either side. */
export interface StreetRun {
  p: number[];
  /** Per station the carriageway's half width to the + side of its normal, then the - side */
  w: number[];
  /** Per station and side the pavement's or the paved apron's width beyond it */
  q: number[];
}

export interface PlotInput {
  /** The village's blocks (walls, covers, hedges, fences, poles), as the tiles draw them */
  prisms: Prism[];
  openings: Opening[];
  trees: { x: number; z: number; r: number }[];
  /** Ponds and ditches: their rims (only those with water stop a way) */
  dips: { rim: [number, number][]; water?: number }[];
  runs: StreetRun[];
  /** Small things standing about, each x, z and a radius (m): letterboxes, signs, posts, poles, bikes, shelters */
  things: [number, number, number][];
  /** Parked cars: x, z, yaw (nose along -z turned by yaw) */
  cars: [number, number, number][];
  /** The house whose walls stand round (x, z): its key */
  keyAt: (x: number, z: number) => number;
  /** Rings no way goes into: the landmarks, the football ground */
  keepOut: [number, number][][];
  /** Rings no way comes within MODEL_CLEAR of: the houses and streets our models stand for, their open ground */
  models: [number, number][][];
  groundAt: (x: number, z: number) => number;
  /** How far a door's step reaches out from the wall (world/housePlan.ts `planSteps`): its path starts there */
  stepOf?: (o: Opening) => number;
}

export interface Plots {
  /** The covers to add, as the data's: { m, y0, y1, d, p } */
  covers: Prism[];
  paths: number;
  drives: number;
  /** Each way: its door's middle, its outline (as its cover), its direction and half width (for the test) */
  ways: { from: [number, number]; ring: [number, number][]; n: [number, number]; half: number; kind: 'path' | 'drive' }[];
}

const CELL = 10;
const cellKey = (cx: number, cz: number) => (cx + 32768) * 65536 + cz + 32768;

/** Points in cells of CELL metres. */
class Points<T> {
  private cells = new Map<number, T[]>();
  constructor(list: T[], at: (t: T) => [number, number]) {
    for (const t of list) {
      const [x, z] = at(t);
      const k = cellKey(Math.floor(x / CELL), Math.floor(z / CELL));
      const c = this.cells.get(k);
      if (c) c.push(t);
      else this.cells.set(k, [t]);
    }
  }
  /** Whether one in the 3 by 3 cells round (x, z) passes `test`. */
  some(x: number, z: number, test: (t: T) => boolean): boolean {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const c = this.cells.get(cellKey(cx + i, cz + j));
        if (c) for (const t of c) if (test(t)) return true;
      }
    }
    return false;
  }
}

/**
 * Ground covers in cells of CELL metres, as world/houseKeys.ts `BlockGrid`, for long outlines (a whole street's road, a
 * field): each outline's edges are kept in bands of BAND metres across z, so a point is tested against the few edges of
 * its band, not the hundreds of the whole outline.
 */
const BAND = 2;
class Surfaces {
  private cells = new Map<number, number[]>();
  private list: { p: Prism; box: number[]; bands: Map<number, number[]> }[] = [];
  add(p: Prism): void {
    const ring = p.p[0];
    const b = box(ring);
    const bands = new Map<number, number[]>();
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const z0 = Math.min(ring[i][1], ring[j][1]);
      const z1 = Math.max(ring[i][1], ring[j][1]);
      for (let k = Math.floor(z0 / BAND); k <= Math.floor(z1 / BAND); k++) {
        const e = bands.get(k);
        if (e) e.push(i);
        else bands.set(k, [i]);
      }
    }
    const n = this.list.length;
    this.list.push({ p, box: b, bands });
    for (let cx = Math.floor(b[0] / CELL); cx <= Math.floor(b[2] / CELL); cx++) {
      for (let cz = Math.floor(b[1] / CELL); cz <= Math.floor(b[3] / CELL); cz++) {
        const k = cellKey(cx, cz);
        const c = this.cells.get(k);
        if (c) c.push(n);
        else this.cells.set(k, [n]);
      }
    }
  }
  /** The covers whose outline holds (x, z). */
  at(x: number, z: number): Prism[] {
    const out: Prism[] = [];
    for (const n of this.cells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL))) ?? []) {
      const { p, box: b, bands } = this.list[n];
      if (x < b[0] || x > b[2] || z < b[1] || z > b[3]) continue;
      const ring = p.p[0];
      let yes = false;
      for (const i of bands.get(Math.floor(z / BAND)) ?? []) {
        const j = i === 0 ? ring.length - 1 : i - 1;
        const [xi, zi] = ring[i];
        const [xj, zj] = ring[j];
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) yes = !yes;
      }
      if (yes) out.push(p);
    }
    return out;
  }
}

/**
 * The streets as their detail draws them (world/roadDetail.ts): each run's segments between stations, with the hard
 * width (carriageway and pavement or paved apron) of each side at each end. A point is on a street when it lies within
 * that side's hard width of a segment.
 */
class Streets {
  /** Each side's hard strip between two stations, as drawn: a quad, and the run's direction there */
  private quads: { ring: [number, number][]; box: number[]; dir: [number, number] }[] = [];
  private cells = new Map<number, number[]>();
  constructor(runs: StreetRun[]) {
    for (const r of runs) {
      const n = r.p.length / 2;
      const x = (k: number) => r.p[2 * k];
      const z = (k: number) => r.p[2 * k + 1];
      // The normals as world/roadDetail.ts `Frame` has them: along the line from two stations back to two on.
      const normal = (k: number): [number, number] => {
        const [a, b] = [Math.max(0, k - 2), Math.min(n - 1, k + 2)];
        const [tx, tz] = [x(b) - x(a), z(b) - z(a)];
        const l = Math.hypot(tx, tz) || 1;
        return [-tz / l, tx / l];
      };
      for (let k = 0; k < n - 1; k++) {
        const len = Math.hypot(x(k + 1) - x(k), z(k + 1) - z(k));
        if (len < 1e-6) continue;
        const dir: [number, number] = [(x(k + 1) - x(k)) / len, (z(k + 1) - z(k)) / len];
        const [n0, n1] = [normal(k), normal(k + 1)];
        // The + side (the normal's), then the - side: carriageway and pavement or apron.
        for (const [s, i] of [[1, 0], [-1, 1]]) {
          const e0 = s * (r.w[2 * k + i] + (r.q[2 * k + i] ?? 0));
          const e1 = s * (r.w[2 * k + 2 + i] + (r.q[2 * k + 2 + i] ?? 0));
          const ring: [number, number][] = [[x(k), z(k)], [x(k + 1), z(k + 1)], [x(k + 1) + n1[0] * e1, z(k + 1) + n1[1] * e1], [x(k) + n0[0] * e0, z(k) + n0[1] * e0]];
          const b = box(ring);
          const q = this.quads.length;
          this.quads.push({ ring, box: b, dir });
          for (let cx = Math.floor(b[0] / CELL); cx <= Math.floor(b[2] / CELL); cx++) {
            for (let cz = Math.floor(b[1] / CELL); cz <= Math.floor(b[3] / CELL); cz++) {
              const key = cellKey(cx, cz);
              const c = this.cells.get(key);
              if (c) c.push(q);
              else this.cells.set(key, [q]);
            }
          }
        }
      }
    }
  }
  /** The run's direction (unit) where (x, z) lies on a street's hard strip, or null off the streets. */
  at(x: number, z: number): [number, number] | null {
    for (const q of this.cells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL))) ?? []) {
      const { ring, box: b, dir } = this.quads[q];
      if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && inside(ring, x, z)) return dir;
    }
    return null;
  }
}

/** The distance from (x, z) to a ring's edge. */
function toRing(ring: [number, number][], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[j];
    const [bx, bz] = ring[i];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  return best;
}

/** Whether two rings overlap (a corner of one inside the other, or two edges crossing). */
function overlaps(a: [number, number][], b: [number, number][]): boolean {
  if (a.some(([x, z]) => inside(b, x, z)) || b.some(([x, z]) => inside(a, x, z))) return true;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    for (let k = 0, l = b.length - 1; k < b.length; l = k++) {
      const [p, q, r, s] = [a[j], a[i], b[l], b[k]];
      const d1 = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      const d2 = (q[0] - p[0]) * (s[1] - p[1]) - (q[1] - p[1]) * (s[0] - p[0]);
      const d3 = (s[0] - r[0]) * (p[1] - r[1]) - (s[1] - r[1]) * (p[0] - r[0]);
      const d4 = (s[0] - r[0]) * (q[1] - r[1]) - (s[1] - r[1]) * (q[0] - r[0]);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return false;
}

function box(ring: [number, number][]): number[] {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const [x, z] of ring) {
    x0 = Math.min(x0, x);
    z0 = Math.min(z0, z);
    x1 = Math.max(x1, x);
    z1 = Math.max(z1, z);
  }
  return [x0, z0, x1, z1];
}

const isCover = (p: Prism) => p.d !== undefined && p.y1 <= 0;
const isWild = (p: Prism) => p.m.startsWith('field') || p.m === 'forest';
const PAVING = /^(pave_|gravel$|concrete$)/;

/** The plots, all at once (world/plots.test.mjs). */
export function plotCovers(input: PlotInput): Plots {
  const steps = plotSteps(input);
  let r = steps.next();
  while (!r.done) r = steps.next();
  return r.value;
}

/**
 * The plots, in slices: the generator yields between doors, so the page can let a frame through now and then
 * (world/villagePlots.ts), and returns them at the end.
 */
export function* plotSteps(input: PlotInput, slice = 40): Generator<void, Plots> {
  const { prisms, groundAt } = input;
  // The ground covers apart from what stands on the ground (walls, hedges, fences, poles, pool water).
  const covers = new Surfaces();
  const upright = new BlockGrid();
  const roads = new Surfaces(); // the village's road surface where its streets have no detail
  for (const p of prisms) {
    if (!isCover(p)) upright.add(p);
    else {
      covers.add(p);
      if (p.m === 'road' || p.m === 'pave_grey') roads.add(p);
    }
  }
  yield;
  const streets = new Streets(input.runs);
  const trees = new Points(input.trees, (t) => [t.x, t.z]);
  const things = new Points(input.things, (b) => [b[0], b[1]]);
  const cars = new Points(input.cars, (c) => [c[0], c[1]]);
  const ponds = input.dips.filter((d) => d.water !== undefined).map((d) => ({ rim: d.rim, box: box(d.rim) }));
  const keep = input.keepOut.map((ring) => ({ ring, box: box(ring) }));
  const models = input.models.map((ring) => ({ ring, box: box(ring) }));
  const inBox = (b: number[], x: number, z: number, m: number) => x >= b[0] - m && x <= b[2] + m && z >= b[1] - m && z <= b[3] + m;
  /** On a street at (x, z): its direction, or null. */
  const street = (x: number, z: number): [number, number] | null => {
    const s = streets.at(x, z);
    if (s) return s;
    const road = roads.at(x, z)[0];
    if (!road) return null;
    // The village's road surface: its long side's direction.
    const ring = road.p[0];
    let best: [number, number] = [1, 0];
    let longest = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const l = Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]);
      if (l > longest && toRing([ring[j], ring[i]], x, z) < 8) {
        longest = l;
        best = [(ring[i][0] - ring[j][0]) / l, (ring[i][1] - ring[j][1]) / l];
      }
    }
    return best;
  };

  /** Along the line from (x, z) in direction n: how far to the street's edge (to a centimetre), or -1 within `max`. */
  const edge = (x: number, z: number, n: [number, number], max: number): number => {
    let end = -1;
    for (let t = START; t <= max && end < 0; t += STEP) if (street(x + n[0] * t, z + n[1] * t)) end = t;
    if (end < 0) return -1;
    let lo = Math.max(0, end - STEP);
    for (let k = 0; k < 5; k++) {
      const mid = (lo + end) / 2;
      if (street(x + n[0] * mid, z + n[1] * mid)) end = mid;
      else lo = mid;
    }
    return end;
  };

  /**
   * Straight out from (x, z) along n, `half` either side: its outline to the street's edge (each side cut where it meets
   * the edge), the lawn on the way and the first paving crossed; or null where it doesn't get there free.
   */
  const way = (x: number, z: number, n: [number, number], half: number, max: number, from: number) => {
    const side: [number, number] = [-n[1], n[0]];
    // A house or street of our models near the door: none.
    if (models.some((m) => inBox(m.box, x, z, MODEL_CLEAR) && (inside(m.ring, x, z) || toRing(m.ring, x, z) < MODEL_CLEAR))) return null;
    const end = edge(x, z, n, max);
    if (end < 0) return null;
    // The street's direction where the way meets it: at too flat an angle the way would run along it.
    const dir = street(x + n[0] * (end + 0.02), z + n[1] * (end + 0.02));
    if (!dir || Math.abs(dir[0] * n[1] - dir[1] * n[0]) < Math.sin((MIN_ANGLE * Math.PI) / 180)) return null;
    // Each side to its own meeting with the edge.
    const ends: number[] = [];
    for (const s of [half, -half]) {
      const e = edge(x + side[0] * s, z + side[1] * s, n, max + 2 * half);
      if (e < 0) return null;
      ends.push(e + INTO_STREET);
    }
    // The end along the street's edge: as slanted as the street meets it at most (another street, a bend: none).
    if (Math.abs(ends[0] - ends[1]) > 2 * half / Math.tan((MIN_ANGLE * Math.PI) / 180)) return null;
    const ring: [number, number][] = [
      [x + side[0] * half + n[0] * from, z + side[1] * half + n[1] * from],
      [x - side[0] * half + n[0] * from, z - side[1] * half + n[1] * from],
      [x - side[0] * half + n[0] * ends[1], z - side[1] * half + n[1] * ends[1]],
      [x + side[0] * half + n[0] * ends[0], z + side[1] * half + n[1] * ends[0]],
    ];
    // What stands on the way or within CLEAR of it (its outline, a little wider): walls, hedges, fences, decks, poles.
    const wide: [number, number][] = [
      [x + side[0] * (half + CLEAR) + n[0] * START, z + side[1] * (half + CLEAR) + n[1] * START],
      [x - side[0] * (half + CLEAR) + n[0] * START, z - side[1] * (half + CLEAR) + n[1] * START],
      [x - side[0] * (half + CLEAR) + n[0] * ends[1], z - side[1] * (half + CLEAR) + n[1] * ends[1]],
      [x + side[0] * (half + CLEAR) + n[0] * ends[0], z + side[1] * (half + CLEAR) + n[1] * ends[0]],
    ];
    const b = box(wide);
    for (const p of upright.inBox([b[0], b[1], b[2], b[3]])) {
      if (!overlaps(wide, p.p[0])) continue;
      if (p.d !== undefined) return null; // a hedge or a fence on the relief
      const [cx, cz] = p.p[0][0];
      const y = groundAt(cx, cz);
      if (p.y0 < y + STAND_LOW && p.y1 > y - GROUND_SLACK) return null; // a wall, a deck, pool water, a pole
    }
    // On the centre line: the ground covers (lawn or paving crossed, a field or a wood); along it the rings kept out,
    // trees, small things, parked cars and ponds.
    let lawn = 0;
    let paving: string | null = null;
    const last = Math.min(ends[0], ends[1]) - INTO_STREET;
    for (let t = START; t < last; t += STEP) {
      const [cx, cz] = [x + n[0] * t, z + n[1] * t];
      const under = covers.at(cx, cz);
      if (under.some(isWild)) return null;
      if (!under.length) lawn += STEP;
      else if (!paving) paving = under.find((p) => PAVING.test(p.m))?.m ?? null;
      if (keep.some((k) => inBox(k.box, cx, cz, half) && (inside(k.ring, cx, cz) || toRing(k.ring, cx, cz) < half))) return null;
      if (models.some((m) => inBox(m.box, cx, cz, MODEL_CLEAR) && (inside(m.ring, cx, cz) || toRing(m.ring, cx, cz) < MODEL_CLEAR))) return null;
      if (trees.some(cx, cz, (tr) => Math.hypot(tr.x - cx, tr.z - cz) < half + TREE_CLEAR)) return null;
      if (things.some(cx, cz, (th) => Math.hypot(th[0] - cx, th[1] - cz) < half + th[2] + CLEAR)) return null;
      if (cars.some(cx, cz, (c) => {
        // In the car's frame (nose along -z turned by its yaw).
        const [dx, dz] = [cx - c[0], cz - c[1]];
        const along = dx * -Math.sin(c[2]) + dz * -Math.cos(c[2]);
        const across = dx * Math.cos(c[2]) - dz * Math.sin(c[2]);
        return Math.abs(along) < CAR_HALF[0] + half + CLEAR && Math.abs(across) < CAR_HALF[1] + half + CLEAR;
      })) return null;
      if (ponds.some((d) => inBox(d.box, cx, cz, half + POND_CLEAR) && (inside(d.rim, cx, cz) || toRing(d.rim, cx, cz) < half + POND_CLEAR))) return null;
    }
    return { ring, lawn, paving };
  };

  const out: Prism[] = [];
  const ways: Plots['ways'] = [];
  const cover = (m: string, ring: [number, number][]): Prism => ({ m, y0: -0.15, y1: -0.075, d: 8, p: [ring] });
  /** A house's paths and drives: pavers warm or light, or gravel; one surface per house. */
  const surfaceOf = new Map<number, string>();
  const surface = (key: number, crossed: string | null) => {
    let m = surfaceOf.get(key);
    if (!m) {
      const h = stable(key, 73);
      m = crossed ?? (h < PAVE_WARM ? 'pave_warm' : h < PAVE_WARM + PAVE_LIGHT ? 'pave_light' : 'gravel');
      surfaceOf.set(key, m);
    }
    return m;
  };

  // Front paths and drives, in the openings' order (the same on every page).
  let paths = 0;
  let drives = 0;
  let done = 0;
  for (const o of input.openings) {
    if (o.k === 'w') continue;
    if (++done % slice === 0) yield;
    const l = Math.hypot(o.n[0], o.n[1]) || 1;
    const n: [number, number] = [o.n[0] / l, o.n[1] / l];
    const [mx, mz] = [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2];
    // A door on the ground floor only.
    if (o.y[0] - groundAt(mx, mz) > 0.6) continue;
    const drive = o.k === 'g';
    const half = drive ? Math.hypot(o.a[0] - o.b[0], o.a[1] - o.b[1]) / 2 + DRIVE_SIDE : PATH_HALF;
    const w = way(mx, mz, n, half, drive ? DRIVE_MAX : PATH_MAX, drive ? 0 : input.stepOf?.(o) ?? 0);
    if (!w || w.lawn < MIN_LAWN) continue;
    out.push(cover(surface(input.keyAt(mx - n[0] * 0.3, mz - n[1] * 0.3), w.paving), w.ring));
    ways.push({ from: [mx, mz], ring: w.ring, n, half, kind: drive ? 'drive' : 'path' });
    if (drive) drives++;
    else paths++;
  }
  return { covers: out, paths, drives, ways };
}
