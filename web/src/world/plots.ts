import type { Opening, Prism } from './houseData';
import { BlockGrid, inside, stable } from './houseKeys';

/**
 * The plots in front of the village's generated houses, in numbers only (main.ts adds them to the village's covers
 * before they are claimed; world/plots.test.mjs checks them over the committed data). The data has paving where the
 * aerial photo saw it, but often not from the door to the road, and lawn up to every wall. Here, where a straight way
 * from a door to a street is free: a paved path 1.1 m wide; from a garage door a drive as wide as the door and 20 cm
 * each side; and on some houses a gravel strip at the foot of the walls that face a street over lawn.
 *
 * They are ground covers as the data's (world/groundLayers.ts claims them by rank after the data's own, so the data's
 * paving, the streets and the houses win every overlap): drawn only, in no collision, never seen by the server. Picked
 * by the house's key (its corner in model coordinates), so every player sees the same. The village only: the ring
 * round the home, the hand-built streets, the church, the school and the football ground keep theirs.
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
/** A way runs this far past the street's hard edge (m), so no grass shows between them. */
const INTO_STREET = 0.1;
/** A block whose top lies this close (m) under the ground or above it lies on the ground (a deck, a terrace). */
const GROUND_SLACK = 0.05;
/** The steps a way is walked in (m), from this far out from the wall. */
const STEP = 0.25;
const START = 0.3;
/** A tree this much beyond a way's half width (m) stops it; a pond's rim this much. */
const TREE_CLEAR = 0.6;
const POND_CLEAR = 0.5;
/** A block standing at the ground stops a way: from under this over the ground (m)... */
const STAND_LOW = 1.5;
/** ...to over this (a canopy overhead is no obstacle; a kerb or a low step is). */
const STAND_HIGH = 0.25;
/** The paths' and drives' surfaces by the house's key: warm pavers, light pavers, the rest gravel. */
const PAVE_WARM = 0.45;
const PAVE_LIGHT = 0.35;

/** A street's run (world/roadDetail.ts, data/roadDetail.json): stations x, z; half widths and aprons either side. */
export interface StreetRun {
  p: number[];
  w: number[];
  q: number[];
}

export interface PlotInput {
  /**
   * The village's blocks (walls, covers, hedges, fences, poles) with its road blocks: the streets in detail draw over
   * them (world/roadDetail.ts), and they still say where a street is.
   */
  prisms: Prism[];
  openings: Opening[];
  trees: { x: number; z: number; r: number }[];
  /** Ponds and ditches: their rims (only those with water stop a way) */
  dips: { rim: [number, number][]; water?: number }[];
  runs: StreetRun[];
  /** Letterboxes: x, z (data/roads.json) */
  boxes: [number, number, number][];
  /** The house wall blocks that stand on the ground (world/houseIndex.ts `bases`) */
  standing: Iterable<Prism>;
  /** The house whose walls stand round (x, z): its key */
  keyAt: (x: number, z: number) => number;
  /** Rings no plot goes into: the landmarks, the hand-built streets and homes, the football ground */
  keepOut: [number, number][][];
  groundAt: (x: number, z: number) => number;
  /** The covers the streets in detail draw over (their road and footpaths): a way ends where it meets one */
  streetCovers?: Prism[];
  /** How far a door's step reaches out from the wall (world/housePlan.ts `planSteps`): its path starts there */
  stepOf?: (o: Opening) => number;
}

export interface Plots {
  /** The covers to add, as the data's: { m, y0, y1, d, p } */
  covers: Prism[];
  paths: number;
  drives: number;
  strips: number;
  /** Each way's centre line from the wall to its end, and its half width (for the test) */
  ways: { from: [number, number]; to: [number, number]; half: number; kind: 'path' | 'drive' | 'strip' }[];
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

const isCover = (p: Prism) => p.d !== undefined && p.y1 <= 0;
const isWild = (p: Prism) => p.m.startsWith('field') || p.m === 'forest';
const PAVING = /^(pave_|gravel$|concrete$)/;

export function plotCovers(input: PlotInput): Plots {
  const { prisms, groundAt } = input;
  // The ground covers apart from what stands on the ground (walls, hedges, fences, poles, pool water).
  const covers = new BlockGrid();
  const upright = new BlockGrid();
  const streets = new BlockGrid(); // the village's road surface and the centre's clinkers
  for (const p of prisms) {
    (isCover(p) ? covers : upright).add(p);
    if (isCover(p) && (p.m === 'road' || p.m === 'pave_grey')) streets.add(p);
  }
  for (const p of input.streetCovers ?? []) streets.add(p);
  const trees = new Points(input.trees, (t) => [t.x, t.z]);
  const boxes = new Points(input.boxes, (b) => [b[0], b[1]]);
  // The streets' stations, each with its hard half width (carriageway and pavement or apron, the wider side).
  const stations: [number, number, number][] = [];
  for (const r of input.runs) {
    for (let k = 0; k < r.p.length / 2; k++) stations.push([r.p[2 * k], r.p[2 * k + 1], Math.max(r.w[2 * k] + (r.q?.[2 * k] ?? 0), r.w[2 * k + 1] + (r.q?.[2 * k + 1] ?? 0))]);
  }
  const near = new Points(stations, (s) => [s[0], s[1]]);
  const ponds = input.dips.filter((d) => d.water !== undefined).map((d) => ({ rim: d.rim, box: box(d.rim) }));
  const keep = input.keepOut.map((ring) => ({ ring, box: box(ring) }));
  const inBox = (b: number[], x: number, z: number, m: number) => x >= b[0] - m && x <= b[2] + m && z >= b[1] - m && z <= b[3] + m;
  const onStreet = (x: number, z: number) => near.some(x, z, ([sx, sz, w]) => Math.hypot(sx - x, sz - z) <= w);

  /**
   * Straight out from (x, z) along n, `half` either side: where it reaches a street (metres out, the lawn on the way,
   * the first paving crossed), or null where something stops it within `max`.
   */
  const way = (x: number, z: number, n: [number, number], half: number, max: number) => {
    const side: [number, number] = [-n[1], n[0]];
    // First where the centre line reaches a street, if it does within `max`; then what lies on the way there.
    const street = (t: number) => onStreet(x + n[0] * t, z + n[1] * t) || streets.at(x + n[0] * t, z + n[1] * t).length > 0;
    let end = -1;
    for (let t = START; t <= max && end < 0; t += STEP) if (street(t)) end = t;
    if (end < 0) return null;
    // The street's edge to a few centimetres.
    for (let lo = Math.max(START, end - STEP), k = 0; k < 4 && end > lo; k++) {
      const mid = (lo + end) / 2;
      if (street(mid)) end = mid;
      else lo = mid;
    }
    let lawn = 0;
    let paving: string | null = null;
    for (let t = START; t < end - 1e-6; t += STEP) {
      const [cx, cz] = [x + n[0] * t, z + n[1] * t];
      const y = groundAt(cx, cz);
      // On the centre line: the ground covers (lawn or paving crossed, a field or a wood) and the rings kept out; on the
      // centre and both edges: what stands.
      const under = covers.at(cx, cz);
      if (under.some(isWild)) return null;
      if (keep.some((k) => inBox(k.box, cx, cz, half) && (inside(k.ring, cx, cz) || toRing(k.ring, cx, cz) < half))) return null;
      if (!under.length) lawn += STEP;
      else if (!paving) paving = under.find((p) => PAVING.test(p.m))?.m ?? null;
      for (const s of [0, -half, half]) {
        for (const p of upright.at(cx + side[0] * s, cz + side[1] * s)) {
          if (p.d !== undefined) return null; // a hedge or a fence on the relief
          if (p.y0 < y + STAND_LOW && p.y1 > y + STAND_HIGH) return null; // a wall, pool water, a pole
          if (p.y0 < y + STAND_HIGH && p.y1 > y - GROUND_SLACK) return null; // a deck or terrace on the ground: something is there
        }
      }
      if (trees.some(cx, cz, (tr) => Math.hypot(tr.x - cx, tr.z - cz) < half + TREE_CLEAR)) return null;
      if (boxes.some(cx, cz, (b) => Math.hypot(b[0] - cx, b[1] - cz) < half)) return null;
      if (ponds.some((d) => inBox(d.box, cx, cz, half + POND_CLEAR) && (inside(d.rim, cx, cz) || toRing(d.rim, cx, cz) < half + POND_CLEAR))) return null;
    }
    return { end, lawn, paving };
  };

  const out: Prism[] = [];
  const ways: Plots['ways'] = [];
  const cover = (m: string, ring: [number, number][]): Prism => ({ m, y0: -0.15, y1: -0.075, d: 8, p: [ring] });
  const rect = (x: number, z: number, n: [number, number], half: number, from: number, to: number): [number, number][] => {
    const s = [-n[1], n[0]];
    return [
      [x + s[0] * half + n[0] * from, z + s[1] * half + n[1] * from],
      [x - s[0] * half + n[0] * from, z - s[1] * half + n[1] * from],
      [x - s[0] * half + n[0] * to, z - s[1] * half + n[1] * to],
      [x + s[0] * half + n[0] * to, z + s[1] * half + n[1] * to],
    ];
  };
  /** A house's paths and drives: pavers warm or light, or gravel. */
  const surface = (key: number) => {
    const h = stable(key, 73);
    return h < PAVE_WARM ? 'pave_warm' : h < PAVE_WARM + PAVE_LIGHT ? 'pave_light' : 'gravel';
  };

  // P1: front paths and drives.
  let paths = 0;
  let drives = 0;
  for (const o of input.openings) {
    if (o.k === 'w') continue;
    const l = Math.hypot(o.n[0], o.n[1]) || 1;
    const n: [number, number] = [o.n[0] / l, o.n[1] / l];
    const [mx, mz] = [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2];
    // A door on the ground floor only.
    if (o.y[0] - groundAt(mx, mz) > 0.6) continue;
    const drive = o.k === 'g';
    const half = drive ? Math.hypot(o.a[0] - o.b[0], o.a[1] - o.b[1]) / 2 + DRIVE_SIDE : PATH_HALF;
    const w = way(mx, mz, n, half, drive ? DRIVE_MAX : PATH_MAX);
    if (!w || w.lawn < MIN_LAWN) continue;
    const m = w.paving ?? surface(input.keyAt(mx - n[0] * 0.3, mz - n[1] * 0.3));
    out.push(cover(m, rect(mx, mz, n, half, input.stepOf?.(o) ?? 0, w.end + INTO_STREET)));
    ways.push({ from: [mx, mz], to: [mx + n[0] * w.end, mz + n[1] * w.end], half, kind: drive ? 'drive' : 'path' });
    if (drive) drives++;
    else paths++;
  }
  return { covers: out, paths, drives, strips: 0, ways };
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
