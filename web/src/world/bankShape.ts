import type { DipSpec } from './houseData';

/**
 * The shape of a pond's or ditch's banks and the level of its water, worked out once on the page from its rim
 * (the data's outline, which never moves: the ground is cut along it, and the server keeps bikes out of it).
 * Shared by the drawn banks and water (world/banks.ts), the walked floor (world/collision.ts) and the water you
 * wade in (world/water.ts): all three read the same triangles, so nobody floats over or sinks into a bank.
 *
 * The rim is split at its two furthest points into two banks, and the banks are paired point by point along
 * the water (the pairing with the shortest crossings in all), so each pair is a cross-section. Across each one a
 * row of points, close together near the banks and wider apart in the middle; their heights come from a profile:
 *
 * - a rounded shoulder where the lawn rolls over at the rim, then a steeper bank down to the water;
 * - under the water a gentle shelf easing into a flat bed (a pond's 1 m down, a ditch's about half a metre);
 * - the slope, the shoulder and the shelf's width wander along the bank (smooth noise from the position, the same
 *   for everyone), and the bank above the water has small lumps.
 *
 * The level: a pond's 0.2 m under the lowest ground round its rim. A ditch's at each cross-section 0.3 m under
 * the lower of its two banks there, never running uphill along the ditch (the water flows towards its lower end)
 * and smoothed, so a ditch on sloping ground falls gently as a creek does, and stays near its banks all along.
 */

/** How far under the lowest bank the water lies (m): a pond's, a ditch's. */
const POND_FREEBOARD = 0.2;
const DITCH_FREEBOARD = 0.3;
/** Across a cross-section: the points' distances from each bank (m), as far as the middle. */
const ACROSS = [0, 0.1, 0.24, 0.42, 0.66, 0.96, 1.35, 1.85, 2.5, 3.3, 4.3, 5.6, 7.2, 9.2, 11.6, 14.5];
/** Rim edges longer than this (m) are split, so no cross-section is far from the next. */
const LONGEST_EDGE = 1.3;
/** Samples along each crossing at most, to find how far its points are from the banks. */
const CHORD = 24;
/** And at least one every this many metres (m), at least six. */
const CHORD_STEP = 0.3;

export interface Bank {
  pond: boolean;
  /** Cross-sections, and points across each: point (j, k) is number j * across + k. */
  stations: number;
  across: number;
  x: Float32Array;
  z: Float32Array;
  /** The ground there (m, as the world's heights) */
  y: Float32Array;
  /** The water's level at its cross-section */
  level: Float32Array;
  /** How far in from the rim (m) */
  inset: Float32Array;
  /** Metres along a ditch from its upper end, and across it (m, signed); 0 in a pond */
  along: Float32Array;
  side: Float32Array;
  /** Downstream along a ditch (a unit vector in x and z), 0 in a pond */
  dirX: Float32Array;
  dirZ: Float32Array;
  /** How fast a ditch's water flows (m/s), 0 in a pond */
  flow: number;
  /** Every triangle (three point numbers each, facing up), and those with water over any corner */
  tris: Uint32Array;
  wet: Uint32Array;
  /** Where the water meets the bank: down one bank and back up the other */
  line: [number, number][];
  /** The lowest level, and the deepest the drawn bed gets under it (m) */
  lowLevel: number;
  bedDepth: number;
  /** How far in from the rim the bed reaches its full depth (m): a pond deepens on past it (world/water.ts) */
  shelf: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Triangles by 2 m square, for finding the one under a point */
  cell: number;
  nx: number;
  nz: number;
  start: Uint32Array;
  list: Uint32Array;
}

/** A height from 0 to 1 that wanders smoothly over the ground (`size` metres between its hills). */
export function softNoise(x: number, z: number, size: number, seed = 0): number {
  const fx = x / size + seed * 17.13;
  const fz = z / size - seed * 9.71;
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  const hash = (a: number, b: number) => {
    const s = Math.sin(a * 127.1 + b * 311.7 + seed * 74.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const su = u * u * (3 - 2 * u);
  const sv = v * v * (3 - 2 * v);
  const a = hash(i, j) + (hash(i + 1, j) - hash(i, j)) * su;
  const b = hash(i, j + 1) + (hash(i + 1, j + 1) - hash(i, j + 1)) * su;
  return a + (b - a) * sv;
}

/** A smooth maximum: as max(a, b), rounded over `k` where they meet. */
function smax(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + (h * h * k) / 4;
}

/** A bank as a polyline, with its segments by 2 m square, for how far a point is from it. */
class Chain {
  private readonly x0: number;
  private readonly z0: number;
  private readonly nx: number;
  private readonly nz: number;
  private readonly start: Uint32Array;
  private readonly list: Uint32Array;
  private static readonly CELL = 2;
  readonly xs: number[];
  readonly zs: number[];

  constructor(xs: number[], zs: number[]) {
    this.xs = xs;
    this.zs = zs;
    const C = Chain.CELL;
    this.x0 = Math.min(...xs) - C;
    this.z0 = Math.min(...zs) - C;
    this.nx = Math.ceil((Math.max(...xs) + C - this.x0) / C);
    this.nz = Math.ceil((Math.max(...zs) + C - this.z0) / C);
    const buckets: number[][] = Array.from({ length: this.nx * this.nz }, () => []);
    for (let i = 1; i < xs.length; i++) {
      const i0 = Math.floor((Math.min(xs[i - 1], xs[i]) - this.x0) / C);
      const i1 = Math.floor((Math.max(xs[i - 1], xs[i]) - this.x0) / C);
      const j0 = Math.floor((Math.min(zs[i - 1], zs[i]) - this.z0) / C);
      const j1 = Math.floor((Math.max(zs[i - 1], zs[i]) - this.z0) / C);
      for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) buckets[j * this.nx + k].push(i);
    }
    this.start = new Uint32Array(buckets.length + 1);
    for (let c = 0; c < buckets.length; c++) this.start[c + 1] = this.start[c] + buckets[c].length;
    this.list = new Uint32Array(this.start[buckets.length]);
    for (let c = 0; c < buckets.length; c++) this.list.set(buckets[c], this.start[c]);
  }

  /** How far (x, z) is from the polyline: the squares round it ring by ring, until no nearer segment can be left. */
  distance(x: number, z: number): number {
    const C = Chain.CELL;
    const ci = Math.floor((x - this.x0) / C);
    const cj = Math.floor((z - this.z0) / C);
    const { xs, zs } = this;
    let best = Infinity;
    const most = Math.max(this.nx, this.nz);
    for (let r = 0; r <= most; r++) {
      for (let j = cj - r; j <= cj + r; j++) {
        if (j < 0 || j >= this.nz) continue;
        // The ring's top and bottom rows whole, its other rows at their two ends only.
        const step = r > 0 && j !== cj - r && j !== cj + r ? 2 * r : 1;
        for (let i = ci - r; i <= ci + r; i += step) {
          if (i < 0 || i >= this.nx) continue;
          const c = j * this.nx + i;
          for (let s = this.start[c]; s < this.start[c + 1]; s++) {
            const n = this.list[s];
            const ax = xs[n - 1];
            const az = zs[n - 1];
            const dx = xs[n] - ax;
            const dz = zs[n] - az;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
            const ex = x - ax - t * dx;
            const ez = z - az - t * dz;
            const d = ex * ex + ez * ez;
            if (d < best) best = d;
          }
        }
      }
      // Everything not yet looked at is at least r squares away.
      if (best <= (r * C) ** 2) break;
    }
    return Math.sqrt(best);
  }
}

/** The rim with its long edges split (every point of it stays on the outline). */
function splitRim(rim: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < rim.length; i++) {
    const [ax, az] = rim[i];
    const [bx, bz] = rim[(i + 1) % rim.length];
    const parts = Math.ceil(Math.hypot(bx - ax, bz - az) / LONGEST_EDGE);
    for (let p = 0; p < parts; p++) out.push([ax + ((bx - ax) * p) / parts, az + ((bz - az) * p) / parts]);
  }
  return out;
}

/** Whether points lie inside a ring: a raster of it (half-metre squares), filled once. */
function insideTest(ring: [number, number][]): (x: number, z: number) => boolean {
  const cell = 0.4;
  const xs = ring.map((p) => p[0]);
  const zs = ring.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const z0 = Math.min(...zs);
  const nx = Math.ceil((Math.max(...xs) - x0) / cell) + 1;
  const nz = Math.ceil((Math.max(...zs) - z0) / cell) + 1;
  const fill = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    const z = z0 + (j + 0.5) * cell;
    const cuts: number[] = [];
    for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
      const [ax, az] = ring[k];
      const [bx, bz] = ring[i];
      if (az > z !== bz > z) cuts.push(ax + ((z - az) / (bz - az)) * (bx - ax));
    }
    cuts.sort((a, b) => a - b);
    for (let c = 0; c + 1 < cuts.length; c += 2) {
      const i0 = Math.max(0, Math.ceil((cuts[c] - x0) / cell - 0.5));
      const i1 = Math.min(nx - 1, Math.floor((cuts[c + 1] - x0) / cell - 0.5));
      for (let i = i0; i <= i1; i++) fill[j * nx + i] = 1;
    }
  }
  return (x, z) => {
    const i = Math.floor((x - x0) / cell);
    const j = Math.floor((z - z0) / cell);
    return i >= 0 && j >= 0 && i < nx && j < nz && fill[j * nx + i] === 1;
  };
}

/**
 * Pair the points of two banks (both from one end to the other) with the shortest crossings in all, avoiding
 * crossings that leave the water's outline (round a bend or a corner).
 */
function pairBanks(a: [number, number][], b: [number, number][], inside: (x: number, z: number) => boolean): [number, number][] {
  const na = a.length;
  const nb = b.length;
  const cost = new Float64Array(na * nb);
  const span = new Float64Array(na * nb);
  const rowMin = new Float64Array(na).fill(Infinity);
  const colMin = new Float64Array(nb).fill(Infinity);
  for (let i = 0; i < na; i++) {
    for (let j = 0; j < nb; j++) {
      const d = Math.sqrt((a[i][0] - b[j][0]) ** 2 + (a[i][1] - b[j][1]) ** 2);
      span[i * nb + j] = d;
      rowMin[i] = Math.min(rowMin[i], d);
      colMin[j] = Math.min(colMin[j], d);
    }
  }
  const out = (i: number, j: number, t: number) => !inside(a[i][0] + (b[j][0] - a[i][0]) * t, a[i][1] + (b[j][1] - a[i][1]) * t);
  for (let i = 0; i < na; i++) {
    for (let j = 0; j < nb; j++) {
      let d = span[i * nb + j];
      // Only a crossing that could be chosen (not much longer than the shortest from either end) is looked along.
      if (d > 1.2 && d < 2 * Math.min(rowMin[i], colMin[j]) + 2) d += 100 * (+out(i, j, 0.25) + +out(i, j, 0.5) + +out(i, j, 0.75));
      let before = i === 0 && j === 0 ? 0 : Infinity;
      if (i > 0) before = Math.min(before, cost[(i - 1) * nb + j]);
      if (j > 0) before = Math.min(before, cost[i * nb + j - 1]);
      if (i > 0 && j > 0) before = Math.min(before, cost[(i - 1) * nb + j - 1]);
      cost[i * nb + j] = before + d;
    }
  }
  const path: [number, number][] = [[na - 1, nb - 1]];
  let i = na - 1;
  let j = nb - 1;
  while (i > 0 || j > 0) {
    let bi = i - 1;
    let bj = j - 1;
    let best = i > 0 && j > 0 ? cost[(i - 1) * nb + j - 1] : Infinity;
    if (i > 0 && cost[(i - 1) * nb + j] < best) [bi, bj, best] = [i - 1, j, cost[(i - 1) * nb + j]];
    if (j > 0 && cost[i * nb + j - 1] < best) [bi, bj, best] = [i, j - 1, cost[i * nb + j - 1]];
    i = bi;
    j = bj;
    path.push([i, j]);
  }
  return path.reverse();
}

const made = new WeakMap<DipSpec, { ground: number; bank: Bank | null }>();

/**
 * The banks and water of a pond or ditch (`ground`: the world's flat ground, `height`: the relief above it), made
 * once and shared. Null for a dip without water (the garden's wadi keeps its plain slopes).
 */
export function bankOf(d: DipSpec, ground: number, height: (x: number, z: number) => number): Bank | null {
  const seen = made.get(d);
  if (seen && seen.ground === ground) return seen.bank;
  const bank = d.water && d.rim.length >= 3 && d.rim.length === d.bottom.length ? makeBank(d, ground, height) : null;
  made.set(d, { ground, bank });
  return bank;
}

function makeBank(d: DipSpec, ground: number, height: (x: number, z: number) => number): Bank {
  const pond = d.name === 'pond';
  const rim = splitRim(d.rim);
  const n = rim.length;
  // Its two furthest points: the ends of a ditch, or of a pond's longest crossing.
  let e0 = 0;
  let e1 = 1;
  let far = -1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dd = (rim[i][0] - rim[j][0]) ** 2 + (rim[i][1] - rim[j][1]) ** 2;
      if (dd > far) [far, e0, e1] = [dd, i, j];
    }
  }
  const bankA: [number, number][] = [];
  for (let i = e0; ; i = (i + 1) % n) {
    bankA.push(rim[i]);
    if (i === e1) break;
  }
  const bankB: [number, number][] = [];
  for (let i = e0; ; i = (i - 1 + n) % n) {
    bankB.push(rim[i]);
    if (i === e1) break;
  }
  const ax = bankA.map((p) => p[0]);
  const az = bankA.map((p) => p[1]);
  const bx = bankB.map((p) => p[0]);
  const bz = bankB.map((p) => p[1]);
  const chainA = new Chain(ax, az);
  const chainB = new Chain(bx, bz);
  const pairs = pairBanks(bankA, bankB, insideTest(d.rim));
  const S = pairs.length;

  // The mean width (m), as the data has it: twice the area over the length round.
  let area = 0;
  let round = 0;
  for (let i = 0; i < d.rim.length; i++) {
    const [px, pz] = d.rim[i];
    const [qx, qz] = d.rim[(i + 1) % d.rim.length];
    area += px * qz - qx * pz;
    round += Math.hypot(qx - px, qz - pz);
  }
  const width = (2 * Math.abs(area / 2)) / round;
  // The bed: a pond's a metre under its water, reached 2.2 m in; a ditch's half a metre or less, over most of its half.
  const bedDepth = pond ? 1.0 : Math.min(0.55, Math.max(0.35, 0.25 + 0.3 * d.depth));
  const shelf = pond ? Math.min(2.2, 0.35 * width) : Math.min(1.4, Math.max(0.5, 0.4 * width));
  const slope = pond ? 0.85 : 1.0;
  const shoulder = pond ? 0.35 : 0.25;

  // Each cross-section: its banks' tops, its middle, its length along.
  const topA = new Float64Array(S);
  const topB = new Float64Array(S);
  const midX = new Float64Array(S);
  const midZ = new Float64Array(S);
  const along = new Float64Array(S);
  let widest = 0;
  for (let j = 0; j < S; j++) {
    const [ia, ib] = pairs[j];
    topA[j] = ground + height(ax[ia], az[ia]);
    topB[j] = ground + height(bx[ib], bz[ib]);
    midX[j] = (ax[ia] + bx[ib]) / 2;
    midZ[j] = (az[ia] + bz[ib]) / 2;
    if (j > 0) along[j] = along[j - 1] + Math.hypot(midX[j] - midX[j - 1], midZ[j] - midZ[j - 1]);
    widest = Math.max(widest, Math.hypot(ax[ia] - bx[ib], az[ia] - bz[ib]));
  }
  const length = along[S - 1] || 1;

  // The level at each cross-section.
  const level = new Float64Array(S);
  let flow = 0;
  if (pond) {
    let low = Infinity;
    for (let j = 0; j < S; j++) low = Math.min(low, topA[j], topB[j]);
    level.fill(low - POND_FREEBOARD);
  } else {
    // The lower bank, the lowest within 2 m along (a dip in one bank shows in the water a little before and after).
    const lower = new Float64Array(S);
    for (let j = 0; j < S; j++) {
      let m = Infinity;
      for (let q = j; q >= 0 && along[j] - along[q] <= 2; q--) m = Math.min(m, topA[q], topB[q]);
      for (let q = j + 1; q < S && along[q] - along[j] <= 2; q++) m = Math.min(m, topA[q], topB[q]);
      lower[j] = m;
    }
    // Downstream: towards the end whose banks are lower. From the upper end, never higher than anything upstream.
    const share = Math.max(1, Math.round(S * 0.15));
    let first = 0;
    let last = 0;
    for (let q = 0; q < share; q++) {
      first += lower[q];
      last += lower[S - 1 - q];
    }
    const down = last <= first; // flowing from station 0 to the last
    const order = Array.from({ length: S }, (_, q) => (down ? q : S - 1 - q));
    const fall = new Float64Array(S);
    let m = Infinity;
    for (const q of order) fall[q] = m = Math.min(m, lower[q]);
    // Smoothed over 3 m either way; the mean of a falling line still falls, and taking the lower keeps it under the banks.
    for (let j = 0; j < S; j++) {
      let sum = 0;
      let w = 0;
      for (let q = 0; q < S; q++) {
        const dd = Math.abs(along[q] - along[j]);
        if (dd > 3) continue;
        const ww = 1 - dd / 3.2;
        sum += fall[q] * ww;
        w += ww;
      }
      level[j] = Math.min(sum / w, fall[j]) - DITCH_FREEBOARD;
    }
    // Rounding could leave a step uphill of a hair: keep it falling.
    let prev = Infinity;
    for (const q of order) prev = level[q] = Math.min(prev, level[q]);
    if (!down) for (let j = 0; j < S; j++) along[j] = length - along[j];
    const drop = Math.abs(level[0] - level[S - 1]);
    flow = Math.min(0.3, 0.12 + (drop / length) * 15);
  }

  // The points across each cross-section: from bank A to the middle and on to bank B.
  let m = 1;
  while (m < ACROSS.length && ACROSS[m] < widest / 2) m++;
  const K = 2 * m + 1;
  const N = S * K;
  const X = new Float32Array(N);
  const Z = new Float32Array(N);
  const Y = new Float32Array(N);
  const L = new Float32Array(N);
  const IN = new Float32Array(N);
  const AL = new Float32Array(N);
  const SD = new Float32Array(N);
  const DX = new Float32Array(N);
  const DZ = new Float32Array(N);
  for (let j = 0; j < S; j++) {
    const [ia, ib] = pairs[j];
    const pax = ax[ia];
    const paz = az[ia];
    const cx = bx[ib] - pax;
    const cz = bz[ib] - paz;
    const c = Math.hypot(cx, cz);
    // Downstream here, and which way across counts as positive (to its left).
    let tx = 0;
    let tz = 0;
    if (!pond) {
      const p = Math.max(0, j - 2);
      const q = Math.min(S - 1, j + 2);
      tx = midX[q] - midX[p];
      tz = midZ[q] - midZ[p];
      const t = Math.hypot(tx, tz) || 1;
      tx /= t;
      tz /= t;
      if (along[q] < along[p]) {
        tx = -tx;
        tz = -tz;
      }
    }
    const leftward = cx * -tz + cz * tx >= 0 ? 1 : -1;
    // Along the crossing, how far it is from the nearer bank; each row of points at its own distance from the bank,
    // so the rows follow the bank even where a crossing runs slanting (at the ends).
    const samples = Math.max(6, Math.min(CHORD, Math.ceil(c / CHORD_STEP)));
    const far = new Float64Array(samples + 1);
    let top = 0;
    for (let s = 0; s <= samples; s++) {
      const t = s / samples;
      const px = pax + cx * t;
      const pz = paz + cz * t;
      far[s] = s === 0 || s === samples ? 0 : Math.min(chainA.distance(px, pz), chainB.distance(px, pz));
      if (far[s] > far[top]) top = s;
    }
    const tTop = top / samples;
    const reach = (want: number, fromA: boolean): number => {
      if (want >= far[top]) return tTop;
      for (let s = fromA ? 0 : samples; fromA ? s < top : s > top; s += fromA ? 1 : -1) {
        const n = s + (fromA ? 1 : -1);
        if (far[n] >= want) return (s + ((want - far[s]) / (far[n] - far[s] || 1)) * (n - s)) / samples;
      }
      return tTop;
    };
    for (let k = 0; k < K; k++) {
      const t = k === 0 ? 0 : k === K - 1 ? 1 : k < m ? reach(ACROSS[k], true) : k === m ? tTop : reach(ACROSS[K - 1 - k], false);
      const fromA = t * c;
      const v = j * K + k;
      X[v] = pax + cx * t;
      Z[v] = paz + cz * t;
      L[v] = level[j];
      AL[v] = along[j];
      SD[v] = (fromA - c / 2) * leftward;
      DX[v] = tx;
      DZ[v] = tz;
    }
  }

  // The heights: each bank's profile down to the shared bed, the higher of the two (each bank holds its own half).
  for (let v = 0; v < N; v++) {
    const k = v % K;
    const j = (v - k) / K;
    const x = X[v];
    const z = Z[v];
    if (k === 0 || k === K - 1) {
      // On the rim: the relief itself, as the cut ground beside it.
      Y[v] = ground + height(x, z);
      IN[v] = 0;
      continue;
    }
    const sa = chainA.distance(x, z);
    const sb = chainB.distance(x, z);
    const w = sa + sb;
    const n1 = softNoise(x, z, 5.5, 1);
    const n2 = softNoise(x, z, 3.2, 2);
    const profile = (s: number, top: number): number => {
      const half = Math.max(w / 2, 0.05);
      const reach = Math.min(shelf * (0.8 + 0.4 * n2), half);
      const deep = Math.min(bedDepth, 0.12 + 0.4 * w);
      const lip = 0.08;
      const u = Math.min(1, s / reach);
      const bed = level[j] + lip - (deep + lip) * (1 - (1 - u) * (1 - u));
      const r = shoulder * (0.7 + 0.6 * n2);
      // Steep enough to be under the bed by the middle, so the two banks meet on it.
      const need = top - (level[j] - deep) + 0.1;
      const k2 = Math.max(slope * (0.75 + 0.5 * n1), need / Math.max(Math.sqrt(half * half + r * r) - r, 1e-3));
      const bank = top - k2 * (Math.sqrt(s * s + r * r) - r);
      return smax(bank, bed, 0.12);
    };
    let y = Math.max(profile(sa, topA[j]), profile(sb, topB[j]));
    // Small lumps on the bank above the water, none on the rim.
    const above = y - level[j];
    if (above > 0) y += (softNoise(x, z, 1.3, 3) - 0.5) * 0.05 * Math.min(1, Math.min(sa, sb) / 0.3) * Math.min(1, above / 0.1);
    Y[v] = y;
    IN[v] = Math.min(sa, sb);
  }

  // Triangles, facing up; the slivers where a bank point is shared are left out.
  const tris: number[] = [];
  const wet: number[] = [];
  const add = (a: number, b: number, c: number) => {
    const cross = (X[b] - X[a]) * (Z[c] - Z[a]) - (Z[b] - Z[a]) * (X[c] - X[a]);
    if (Math.abs(cross) < 1e-7) return;
    const t = cross < 0 ? [a, b, c] : [a, c, b];
    tris.push(...t);
    if (L[a] - Y[a] > -0.01 || L[b] - Y[b] > -0.01 || L[c] - Y[c] > -0.01) wet.push(...t);
  };
  for (let j = 0; j + 1 < S; j++) {
    for (let k = 0; k + 1 < K; k++) {
      const p = j * K + k;
      const q = (j + 1) * K + k;
      add(p, q, p + 1);
      add(p + 1, q, q + 1);
    }
  }

  // Where the water meets each bank, for anything that wants the outline of the water.
  const lineA: [number, number][] = [];
  const lineB: [number, number][] = [];
  for (let j = 0; j < S; j++) {
    const at = (from: number, step: number): [number, number] | null => {
      for (let k = from; k !== m; k += step) {
        const p = j * K + k;
        const q = p + step;
        const dp = L[p] - Y[p];
        const dq = L[q] - Y[q];
        if (dp <= 0 && dq > 0) {
          const t = -dp / (dq - dp);
          return [X[p] + (X[q] - X[p]) * t, Z[p] + (Z[q] - Z[p]) * t];
        }
      }
      return null;
    };
    const a = at(0, 1);
    const b = at(K - 1, -1);
    if (a) lineA.push(a);
    if (b) lineB.push(b);
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let v = 0; v < N; v++) {
    minX = Math.min(minX, X[v]);
    maxX = Math.max(maxX, X[v]);
    minZ = Math.min(minZ, Z[v]);
    maxZ = Math.max(maxZ, Z[v]);
  }
  const cell = 2;
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell));
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / cell));
  const buckets: number[][] = Array.from({ length: nx * nz }, () => []);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t];
    const b = tris[t + 1];
    const c = tris[t + 2];
    const i0 = Math.max(0, Math.floor((Math.min(X[a], X[b], X[c]) - minX) / cell));
    const i1 = Math.min(nx - 1, Math.floor((Math.max(X[a], X[b], X[c]) - minX) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(Z[a], Z[b], Z[c]) - minZ) / cell));
    const j1 = Math.min(nz - 1, Math.floor((Math.max(Z[a], Z[b], Z[c]) - minZ) / cell));
    for (let jj = j0; jj <= j1; jj++) for (let ii = i0; ii <= i1; ii++) buckets[jj * nx + ii].push(t);
  }
  const start = new Uint32Array(nx * nz + 1);
  for (let c = 0; c < buckets.length; c++) start[c + 1] = start[c] + buckets[c].length;
  const list = new Uint32Array(start[nx * nz]);
  for (let c = 0; c < buckets.length; c++) list.set(buckets[c], start[c]);

  let lowLevel = Infinity;
  for (let j = 0; j < S; j++) lowLevel = Math.min(lowLevel, level[j]);
  return {
    pond,
    stations: S,
    across: K,
    x: X,
    z: Z,
    y: Y,
    level: L,
    inset: IN,
    along: AL,
    side: SD,
    dirX: DX,
    dirZ: DZ,
    flow,
    tris: new Uint32Array(tris),
    wet: new Uint32Array(wet),
    line: [...lineA, ...lineB.reverse()],
    lowLevel,
    bedDepth,
    shelf,
    minX,
    maxX,
    minZ,
    maxZ,
    cell,
    nx,
    nz,
    start,
    list,
  };
}

/** What lies at (x, z) in a bank: the ground, the water's level and how far in from the rim; null outside its rim. */
export interface BankPoint {
  y: number;
  level: number;
  inset: number;
}

/** The bank's surface at (x, z), read off its triangles (as drawn); null outside the rim. */
export function bankAt(b: Bank, x: number, z: number, out: BankPoint = { y: 0, level: 0, inset: 0 }): BankPoint | null {
  if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return null;
  const i = Math.min(b.nx - 1, Math.floor((x - b.minX) / b.cell));
  const j = Math.min(b.nz - 1, Math.floor((z - b.minZ) / b.cell));
  const c = j * b.nx + i;
  const { x: X, z: Z, tris } = b;
  for (let s = b.start[c]; s < b.start[c + 1]; s++) {
    const t = b.list[s];
    const p = tris[t];
    const q = tris[t + 1];
    const r = tris[t + 2];
    const d = (Z[q] - Z[r]) * (X[p] - X[r]) + (X[r] - X[q]) * (Z[p] - Z[r]);
    if (d === 0) continue;
    const u = ((Z[q] - Z[r]) * (x - X[r]) + (X[r] - X[q]) * (z - Z[r])) / d;
    const v = ((Z[r] - Z[p]) * (x - X[r]) + (X[p] - X[r]) * (z - Z[r])) / d;
    const w = 1 - u - v;
    if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
    out.y = u * b.y[p] + v * b.y[q] + w * b.y[r];
    out.level = u * b.level[p] + v * b.level[q] + w * b.level[r];
    out.inset = u * b.inset[p] + v * b.inset[q] + w * b.inset[r];
    return out;
  }
  return null;
}
