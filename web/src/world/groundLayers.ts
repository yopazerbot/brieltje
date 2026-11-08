/**
 * One owner for every spot of hard ground. The village's covers (open data), the streets in detail (world/roadDetail.ts)
 * and our models' forecourts, squares and yards each lie a few centimetres over the grass, so where two of them overlap
 * on the plan they lie at nearly the same height: the depth buffer can't tell them apart, and they flicker in jagged
 * triangles, the more the further off (Yoshi, 8 Nov 2026, at the Sparrenhof's forecourt: "I want this better on the
 * entire map"). Each surface's triangles are first claimed here on the plan with a rank, then each surface is cut, while
 * it is built, to what no surface that beats it claims: one surface left per spot, the same on every device.
 *
 * A surface beats another by its rank (RANK below: our models over the streets in detail, the carriageway over the
 * pavement over the paving over the gravel over the fields), and between two of one rank the one claimed first wins;
 * between two with heights (our models' own surfaces, world/modelGround.ts) the higher one, at each spot, as the depth
 * buffer would show them if it could tell them apart. The cut pieces stay on the triangle's own plane, so the heights
 * stay as they were: no step and no gap where it is cut.
 *
 * Plain arithmetic on the plan (x, z), no three.js, so node tests it (groundLayers.test.mjs).
 */

/** A point on the plan: x, z. */
export type Pt = [number, number];

/**
 * The ranks, highest first. Our models' ground: they are made for their spot, in detail. The streets' paint gives way
 * only to them. The streets in detail: the school's plateau and the bays over the carriageway, which lies over the
 * pavements, then the footpaths and the open data's low blocks (a stone terrace, a pool). Then the open data's covers
 * by what lies on top in a village: road over paving over gravel over yard over field. The verges of the streets in
 * detail (their gravel shoulders and the worn fringe into the grass) are where the grass comes up to the road, so any
 * paving of the open data there (a drive) wins over them.
 */
export const RANK = {
  model: 9,
  paint: 8.9,
  plateau: 8.5,
  carriageway: 8,
  pavement: 7,
  footpath: 6,
  block: 6,
  road: 5,
  clinker: 5,
  paving: 4,
  gravel: 3.5,
  verge: 3,
  track: 2,
  field: 1,
} as const;

/** The open data's covers (village.json, the ring's) by material: their rank. */
const COVERS: Record<string, number> = {
  road: RANK.road,
  pave_grey: RANK.clinker,
  concrete: RANK.paving,
  pave_light: RANK.paving,
  pave_warm: RANK.paving,
  pave_walk: RANK.paving,
  forecourt: RANK.paving,
  gravel: RANK.gravel,
  track: RANK.track,
  field_soil: RANK.field,
  field_dark: RANK.field,
  field_crop: RANK.field,
  forest: RANK.field,
  // The football ground's car park and lane (world/footballGround.ts), laid as the village's covers
  rd_asphalt: RANK.road,
  rd_concrete: RANK.road,
};

/** The rank of an open-data cover of material `m`, or undefined for what isn't a ground cover. */
export function coverRank(m: string): number | undefined {
  return m.startsWith('pf:') ? RANK.carriageway : COVERS[m];
}

/** m: a piece that overlaps another by less than this (they touch along an edge) isn't cut */
const EPS = 1e-3;
/** m: the squares the claims are found by */
const CELL = 4;
/** m: two surfaces with heights (a model's) beat each other only where they lie this close one over the other */
export const GAP = 0.08;
/** m: two surfaces with heights closer than this lie in one plane: the one claimed first keeps the spot */
const TIE = 0.002;

/** Twice the signed area of a polygon on the plan (positive: counter-clockwise seen with x right and z up). */
export function area2(poly: Pt[]): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return s;
}

/** The part of a convex polygon where d(p) = nx * x + nz * z + c is at most 0 (Sutherland-Hodgman, one side). */
function keepBelow(poly: Pt[], nx: number, nz: number, c: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[(i + poly.length - 1) % poly.length];
    const b = poly[i];
    const da = nx * a[0] + nz * a[1] + c;
    const db = nx * b[0] + nz * b[1] + c;
    if (da <= 0 !== db <= 0) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    if (db <= 0) out.push(b);
  }
  return out;
}

/** Whether two convex polygons overlap by more than EPS (separating axes): those that only touch along an edge don't. */
export function overlaps(p: Pt[], q: Pt[]): boolean {
  return !separates(p, q) && !separates(q, p);
}

/** Whether an edge of convex polygon a has all of b outside it or within EPS inside (overlaps). */
function separates(a: Pt[], b: Pt[]): boolean {
  const turn = area2(a) < 0 ? -1 : 1;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    // The edge's outward normal (of length len), and how far the other polygon reaches inside it.
    const nx = (a[i][1] - a[j][1]) * turn;
    const nz = -(a[i][0] - a[j][0]) * turn;
    const len = Math.sqrt(nx * nx + nz * nz);
    if (len < 1e-12) continue;
    const c = -(nx * a[j][0] + nz * a[j][1]);
    let deepest = Infinity;
    for (let k = 0; k < b.length; k++) {
      const d = nx * b[k][0] + nz * b[k][1] + c;
      if (d < deepest) deepest = d;
    }
    if (deepest > -EPS * len) return true;
  }
  return false;
}

/**
 * A convex polygon less a triangle: the convex pieces of it outside the triangle, each turned as the polygon is. A
 * sliver outside the triangle thinner than EPS goes with the triangle.
 */
export function minus(p: Pt[], t: Pt[]): Pt[][] {
  const turn = Math.sign(area2(t)) || 1;
  const out: Pt[][] = [];
  let rest = p;
  for (let i = 0, j = t.length - 1; i < t.length && rest.length >= 3; j = i++) {
    // d > 0 outside this edge of the triangle.
    let nx = (t[i][1] - t[j][1]) * turn;
    let nz = -(t[i][0] - t[j][0]) * turn;
    const len = Math.hypot(nx, nz);
    if (len < 1e-12) continue;
    nx /= len;
    nz /= len;
    const c = -(nx * t[j][0] + nz * t[j][1]);
    const outside = keepBelow(rest, -nx, -nz, -c);
    if (outside.length >= 3 && outside.some((v) => nx * v[0] + nz * v[1] + c > EPS) && Math.abs(area2(outside)) > 1e-8) out.push(outside);
    rest = keepBelow(rest, nx, nz, c);
  }
  return out;
}

/** Development only: ?nolayers leaves every surface whole, as before, for comparing looks and cost. */
const OFF = !!import.meta.env?.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).has('nolayers');

/** A typed array of `size` numbers that starts with a's. */
function room<T extends Float64Array | Uint32Array | Uint8Array>(a: T, size: number): T {
  const b = new (a.constructor as new (n: number) => T)(size);
  b.set(a);
  return b;
}

/**
 * The claims: triangles on the plan, each with its rank and group, found by the squares they lie over. Kept in typed
 * arrays (some 300,000 claims for the whole map: as plain lists they held about 46 MB), and let go once the map is built
 * (release).
 */
export class GroundLayers {
  private n = 0;
  /** Each claim's corners on the plan: x, z three times */
  private pts = new Float64Array(0);
  private ranks = new Float64Array(0);
  private groupOf = new Float64Array(0);
  /** Each claim's box on the plan: x0, z0, x1, z1 */
  private boxes = new Float64Array(0);
  /** A claim's plane, y = a x + b z + c (NaN: a claim without heights, that beats by the plan alone) */
  private planes = new Float64Array(0);
  /** Beats only surfaces of its own rank (a model's surface above its ground: a step, a sill, a raised floor): 1 */
  private own = new Uint8Array(0);
  private cells = new Map<number, number[]>();
  /** The squares claimed in since their lists were last sorted (strongest first: cut stops at the first that can't beat) */
  private unsorted = new Set<number[]>();
  private seen = new Uint32Array(0);
  private stamp = 0;
  private groups = 0;

  /** How many triangles are claimed. */
  get size(): number {
    return this.n;
  }

  /**
   * Let go of every claim but those whose box on the plan meets one of `keep` ([x0, z0, x1, z1]): once the map is built
   * only what is built later still cuts (the homes' insides, near the homes). A cut that lies wholly in a kept box comes
   * out as before. Their order (and so which of one rank wins) stays as it was.
   */
  release(keep: [number, number, number, number][] = []): void {
    const b = this.boxes;
    const kept: number[] = [];
    for (let i = 0; i < this.n; i++) {
      if (keep.some(([x0, z0, x1, z1]) => b[4 * i] <= x1 && b[4 * i + 2] >= x0 && b[4 * i + 1] <= z1 && b[4 * i + 3] >= z0)) kept.push(i);
    }
    const old = { pts: this.pts, ranks: this.ranks, groupOf: this.groupOf, boxes: b, planes: this.planes, own: this.own };
    const m = kept.length;
    this.n = 0;
    this.pts = new Float64Array(6 * m);
    this.ranks = new Float64Array(m);
    this.groupOf = new Float64Array(m);
    this.boxes = new Float64Array(4 * m);
    this.planes = new Float64Array(3 * m);
    this.own = new Uint8Array(m);
    this.seen = new Uint32Array(m);
    this.cells = new Map();
    this.unsorted.clear();
    for (const i of kept) {
      const j = this.n;
      this.pts.set(old.pts.subarray(6 * i, 6 * i + 6), 6 * j);
      this.boxes.set(old.boxes.subarray(4 * i, 4 * i + 4), 4 * j);
      this.planes.set(old.planes.subarray(3 * i, 3 * i + 3), 3 * j);
      this.ranks[j] = old.ranks[i];
      this.groupOf[j] = old.groupOf[i];
      this.own[j] = old.own[i];
      this.n++;
      this.index(j);
    }
  }

  /** The claims from number `from` on (up to `n`), as copies (for the ground's worker, world/groundCutter.ts). */
  claimsFrom(from: number, n = this.n): Claims {
    return {
      pts: this.pts.slice(6 * from, 6 * n),
      ranks: this.ranks.slice(from, n),
      groupOf: this.groupOf.slice(from, n),
      planes: this.planes.slice(3 * from, 3 * n),
      own: this.own.slice(from, n),
    };
  }

  /** Claims from another set (claimsFrom), after its own: the same as claimed here one by one. */
  addClaims(c: Claims): void {
    const k = c.ranks.length;
    const n = this.n + k;
    if (n > this.seen.length) {
      const m = n + 1024;
      this.pts = room(this.pts, 6 * m);
      this.ranks = room(this.ranks, m);
      this.groupOf = room(this.groupOf, m);
      this.boxes = room(this.boxes, 4 * m);
      this.planes = room(this.planes, 3 * m);
      this.own = room(this.own, m);
      this.seen = room(this.seen, m);
    }
    const i0 = this.n;
    this.pts.set(c.pts, 6 * i0);
    this.ranks.set(c.ranks, i0);
    this.groupOf.set(c.groupOf, i0);
    this.planes.set(c.planes, 3 * i0);
    this.own.set(c.own, i0);
    const p = this.pts;
    const b = this.boxes;
    for (let i = i0; i < n; i++) {
      b[4 * i] = Math.min(p[6 * i], p[6 * i + 2], p[6 * i + 4]);
      b[4 * i + 1] = Math.min(p[6 * i + 1], p[6 * i + 3], p[6 * i + 5]);
      b[4 * i + 2] = Math.max(p[6 * i], p[6 * i + 2], p[6 * i + 4]);
      b[4 * i + 3] = Math.max(p[6 * i + 1], p[6 * i + 3], p[6 * i + 5]);
      this.index(i);
    }
    this.n = n;
  }

  /** Put claim i in the lists of the squares its box lies over. */
  private index(i: number): void {
    const b = this.boxes;
    for (let cx = Math.floor(b[4 * i] / CELL); cx <= Math.floor(b[4 * i + 2] / CELL); cx++) {
      for (let cz = Math.floor(b[4 * i + 1] / CELL); cz <= Math.floor(b[4 * i + 3] / CELL); cz++) {
        const key = cx * 100003 + cz;
        let list = this.cells.get(key);
        if (list) list.push(i);
        else this.cells.set(key, (list = [i]));
        this.unsorted.add(list);
      }
    }
  }

  /** A new group (or `n` in a row, the first returned): its claims beat those of the groups after it, of the same rank. */
  group(n = 1): number {
    const first = this.groups;
    this.groups += n;
    return first;
  }

  /**
   * Claim a triangle on the plan for a surface of `rank` and `group`. With its corners' heights `ys` it beats (and is
   * beaten by) others with heights only where the two lie within GAP of each other; `ownRank`: it beats only surfaces
   * of its own rank.
   */
  claim(t: Pt[], rank: number, group: number, ys?: number[], ownRank = false): void {
    const [a, b, c] = t;
    // The lowest rank beats nothing: no need to find it.
    if (OFF || rank <= RANK.field || Math.abs(area2(t)) < 1e-8) return;
    const i = this.n++;
    if (i >= this.seen.length) {
      // Every list grown together, by claims (each by its own numbers a claim), to the same room.
      const m = Math.ceil(i * 1.5) + 1024;
      this.pts = room(this.pts, 6 * m);
      this.ranks = room(this.ranks, m);
      this.groupOf = room(this.groupOf, m);
      this.boxes = room(this.boxes, 4 * m);
      this.planes = room(this.planes, 3 * m);
      this.own = room(this.own, m);
      this.seen = room(this.seen, m);
    }
    const p = this.pts;
    p[6 * i] = a[0];
    p[6 * i + 1] = a[1];
    p[6 * i + 2] = b[0];
    p[6 * i + 3] = b[1];
    p[6 * i + 4] = c[0];
    p[6 * i + 5] = c[1];
    this.ranks[i] = rank;
    this.groupOf[i] = group;
    const [pa, pb, pc] = ys ? plane(t, ys) : [NaN, NaN, NaN];
    this.planes[3 * i] = pa;
    this.planes[3 * i + 1] = pb;
    this.planes[3 * i + 2] = pc;
    this.own[i] = ownRank ? 1 : 0;
    this.boxes[4 * i] = Math.min(a[0], b[0], c[0]);
    this.boxes[4 * i + 1] = Math.min(a[1], b[1], c[1]);
    this.boxes[4 * i + 2] = Math.max(a[0], b[0], c[0]);
    this.boxes[4 * i + 3] = Math.max(a[1], b[1], c[1]);
    this.index(i);
  }

  /**
   * What is left of a convex polygon of a surface of `rank` and `group` once every claim that beats it is cut away:
   * convex pieces, turned as it is. Untouched, the polygon itself comes back (the same array), alone.
   */
  cut(poly: Pt[], rank: number, group: number, ys?: number[]): Pt[][] {
    const mine = ys ? plane(poly, ys) : null;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of poly) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    if (this.unsorted.size) {
      const { ranks, groupOf } = this;
      for (const list of this.unsorted) list.sort((i, j) => ranks[j] - ranks[i] || groupOf[i] - groupOf[j]);
      this.unsorted.clear();
    }
    const stamp = ++this.stamp;
    const { ranks, groupOf, boxes: b, seen, own } = this;
    let pieces: Pt[][] = [poly];
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const list = this.cells.get(cx * 100003 + cz);
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const i = list[k];
          const r = ranks[i];
          // Strongest first: from here on none beats it (but of two with heights, the higher one does, wherever it is).
          if (r < rank || (r === rank && groupOf[i] >= group && !mine)) break;
          // Its box first (most fail it), then whether it was met in another square already.
          if (b[4 * i] > x1 - EPS || b[4 * i + 2] < x0 + EPS || b[4 * i + 1] > z1 - EPS || b[4 * i + 3] < z0 + EPS) continue;
          if (seen[i] === stamp) continue;
          seen[i] = stamp;
          if (r !== rank && own[i]) continue;
          const heights = mine && !Number.isNaN(this.planes[3 * i]);
          // A neighbour of the same mesh or strip: two triangles with a side in common, on either side of it.
          if (pieces.length === 1 && pieces[0] === poly && poly.length === 3 && this.besides(poly, i)) continue;
          const p = this.pts;
          let t: Pt[] = [[p[6 * i], p[6 * i + 1]], [p[6 * i + 2], p[6 * i + 3]], [p[6 * i + 4], p[6 * i + 5]]];
          if (heights) {
            // Of two with heights, each spot goes to the higher, as the depth buffer would give it if it could tell
            // them apart: the claim beats this surface where it lies over it, by up to GAP (further up it is a bench
            // or a roof, not ground lying on ground), and where the two are one plane, if it came first.
            const q = this.planes;
            const da = q[3 * i] - mine![0];
            const db = q[3 * i + 1] - mine![1];
            const dc = q[3 * i + 2] - mine![2];
            const low = r > rank || this.groupOf[i] < group ? -TIE : TIE;
            t = keepBelow(keepBelow(t, -da, -db, low - dc), da, db, dc - GAP);
            if (t.length < 3 || Math.abs(area2(t)) < 1e-8) continue;
          } else if (r === rank && this.groupOf[i] >= group) continue;
          const next: Pt[][] = [];
          for (const piece of pieces) {
            if (overlaps(piece, t)) next.push(...minus(piece, t));
            else next.push(piece);
          }
          pieces = next;
          if (!pieces.length) return pieces;
        }
      }
    }
    return pieces;
  }

  /** Whether the triangle t and claim i have two corners in common and their third corners lie on either side. */
  private besides(t: Pt[], i: number): boolean {
    const p = this.pts;
    let shared = 0;
    let free = -1;
    let other = -1;
    for (let k = 0; k < 3; k++) {
      let hit = -1;
      for (let m = 0; m < 3; m++) if (t[k][0] === p[6 * i + 2 * m] && t[k][1] === p[6 * i + 2 * m + 1]) hit = m;
      if (hit >= 0) shared++;
      else free = k;
    }
    if (shared !== 2) return false;
    for (let m = 0; m < 3; m++) {
      const x = p[6 * i + 2 * m];
      const z = p[6 * i + 2 * m + 1];
      if (!(t[0][0] === x && t[0][1] === z) && !(t[1][0] === x && t[1][1] === z) && !(t[2][0] === x && t[2][1] === z)) other = m;
    }
    const a = t[(free + 1) % 3];
    const b = t[(free + 2) % 3];
    const side = (x: number, z: number) => (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]);
    return side(t[free][0], t[free][1]) * side(p[6 * i + 2 * other], p[6 * i + 2 * other + 1]) < 0;
  }
}

/** The plane y = a x + b z + c through a polygon's first three corners (on the plan) at heights ys. */
export function plane(t: Pt[], ys: number[]): [number, number, number] {
  const [[ax, az], [bx, bz], [cx, cz]] = t;
  const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
  if (Math.abs(det) < 1e-12) return [0, 0, (ys[0] + ys[1] + ys[2]) / 3];
  const a = ((ys[1] - ys[0]) * (cz - az) - (ys[2] - ys[0]) * (bz - az)) / det;
  const b = ((ys[2] - ys[0]) * (bx - ax) - (ys[1] - ys[0]) * (cx - ax)) / det;
  return [a, b, ys[0] - a * ax - b * az];
}

/** Run a job made of steps (a generator that yields between them) to its end at once. */
export function runNow<T>(job: Generator<void | Promise<unknown>, T>): T {
  for (;;) {
    const r = job.next();
    if (r.done) return r.value;
    if (r.value) throw new Error('runNow: a job that waits'); // one that waits for the ground's worker runs with runSoon
  }
}

/**
 * Run a job made of steps between frames: `between` is awaited each time `slice` ms of work have gone by, so the game
 * goes on drawing while the village is built (it comes in after play has begun). A step may give a promise: the job
 * goes on once it is settled (the ground's worker, world/groundCutter.ts), and the page does other work meanwhile.
 */
export async function runSoon<T>(job: Generator<void | Promise<unknown>, T>, between: () => Promise<unknown>, slice = 40): Promise<T> {
  let start = performance.now();
  for (;;) {
    const r = job.next();
    if (r.done) return r.value;
    if (r.value) {
      await r.value;
      start = performance.now();
    } else if (performance.now() - start > slice) {
      await between();
      start = performance.now();
    }
  }
}

/** The page's one set of claims: the ring's, the village's and the models'. */
export const groundLayers = new GroundLayers();

/** The open-data covers claimed (houseMeshes.ts drapedGeometry cuts each by its own rank and group). */
const claimed = new WeakMap<object, [number, number]>();

/** A cover's rank and group, if it was claimed. */
export function claimOf(cover: object): [number, number] | undefined {
  return claimed.get(cover);
}

/** Remember a cover's rank and group (claimCovers in houseMeshes.ts, the fills in roadDetail.ts). */
export function markClaimed(cover: object, rank: number, group: number): void {
  claimed.set(cover, [rank, group]);
}

/** A convex polygon clipped to a box (Sutherland-Hodgman). */
export function clipToBox(poly: [number, number][], x0: number, z0: number, x1: number, z1: number): [number, number][] {
  let pts = clipSide(poly, 0, x0, 1);
  if (pts.length >= 3) pts = clipSide(pts, 0, x1, -1);
  if (pts.length >= 3) pts = clipSide(pts, 1, z0, 1);
  if (pts.length >= 3) pts = clipSide(pts, 1, z1, -1);
  return pts.length < 3 ? [] : pts;
}

/**
 * One side of clipToBox: keep where coordinate k is at least `bound` (dir 1) or at most it (dir -1). Written out
 * without closures (it runs for every piece of every cover at load), the arithmetic as it was.
 */
function clipSide(pts: [number, number][], k: 0 | 1, bound: number, dir: 1 | -1): [number, number][] {
  const o = 1 - k;
  const out: [number, number][] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n];
    const b = pts[i];
    const inA = dir > 0 ? a[k] >= bound : a[k] <= bound;
    const inB = dir > 0 ? b[k] >= bound : b[k] <= bound;
    if (inA !== inB) {
      const c: [number, number] = [0, 0];
      c[k] = bound;
      c[o] = a[o] + ((bound - a[k]) / (b[k] - a[k])) * (b[o] - a[o]);
      out.push(c);
    }
    if (inB) out.push(b);
  }
  return out;
}

/** Keep one side of a terrain cell's diagonal, so paving follows both ground triangles. */
export function clipDiagonal(poly: [number, number][], gx: number, gz: number, side: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[(i + poly.length - 1) % poly.length], b = poly[i];
    const da = ((a[0] - gx) - (a[1] - gz)) * side;
    const db = ((b[0] - gx) - (b[1] - gz)) * side;
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    if (db >= 0) out.push(b);
  }
  return out;
}

/** A cover's grid (world/houseMeshes.ts drapedGeometry): the terrain's corner and its squares' size. */
export interface CoverGrid {
  x0: number;
  z0: number;
  step: number;
}

/**
 * The pieces a draped cover's top is built of, in the order drapedGeometry builds them: each triangle `t` of its outline
 * (number `fi`) cut along a grid of `cell` metres laid on the terrain's (and along the squares' diagonals when
 * `precise`). `each` gets every piece of three corners or more.
 */
export function coverPieces(tris: [number, number][][], cell: number, precise: boolean, grid: CoverGrid, each: (piece: [number, number][], fi: number) => void): void {
  for (let fi = 0; fi < tris.length; fi++) {
    const t = tris[fi];
    const xs = t.map((v) => v[0]);
    const zs = t.map((v) => v[1]);
    // On the terrain's grid lines, so the pieces' corners lie on the ground's own corners where they can.
    const gx0 = grid.x0 + Math.floor((Math.min(...xs) - grid.x0) / cell) * cell;
    const gz0 = grid.z0 + Math.floor((Math.min(...zs) - grid.z0) / cell) * cell;
    for (let gx = gx0; gx < Math.max(...xs); gx += cell) {
      for (let gz = gz0; gz < Math.max(...zs); gz += cell) {
        const piece = clipToBox(t, gx, gz, gx + cell, gz + cell);
        if (!precise) {
          if (piece.length >= 3) each(piece, fi);
          continue;
        }
        for (const side of [1, -1]) {
          const half = clipDiagonal(piece, gx, gz, side);
          if (half.length >= 3) each(half, fi);
        }
      }
    }
  }
}

/** Barycentric weights of (x, z) in the triangle t. */
export function weightsIn(t: Pt[], x: number, z: number): [number, number, number] {
  const [[ax, az], [bx, bz], [cx, cz]] = t;
  const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
  const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
  return [l1, l2, 1 - l1 - l2];
}

/** A run of claims in typed arrays (GroundLayers claimsFrom, addClaims): corners, ranks, groups, planes, own-rank flags. */
export interface Claims {
  pts: Float64Array;
  ranks: Float64Array;
  groupOf: Float64Array;
  planes: Float64Array;
  own: Uint8Array;
}

/** A polygon to cut: its corners, the surface's rank and group, and its corners' heights (for a model's own surface). */
export interface CutAsk {
  t: Pt[];
  rank: number;
  group: number;
  ys?: number[];
}

/** Polygons to cut, in one list of numbers: for each its corner count, rank, group, whether it has heights, corners, heights. */
export function packAsks(asks: CutAsk[]): Float64Array {
  let size = 0;
  for (const a of asks) size += 4 + a.t.length * (a.ys ? 3 : 2);
  const out = new Float64Array(size);
  let o = 0;
  for (const a of asks) {
    out[o++] = a.t.length;
    out[o++] = a.rank;
    out[o++] = a.group;
    out[o++] = a.ys ? 1 : 0;
    for (const [x, z] of a.t) {
      out[o++] = x;
      out[o++] = z;
    }
    if (a.ys) for (let k = 0; k < a.t.length; k++) out[o++] = a.ys[k];
  }
  return out;
}

/** A cut's outcome into a list of numbers: -1 for the polygon untouched, else the count of pieces and each piece's corners. */
function putCut(out: number[], poly: Pt[], pieces: Pt[][]): void {
  if (pieces.length === 1 && pieces[0] === poly) {
    out.push(-1);
    return;
  }
  out.push(pieces.length);
  for (const piece of pieces) {
    out.push(piece.length);
    for (const [x, z] of piece) out.push(x, z);
  }
}

/** Cut every polygon of a packed list (packAsks) by `layers`, in order: their outcomes in one list (read with Cuts). */
export function cutAsks(layers: GroundLayers, asks: Float64Array): Float64Array {
  const out: number[] = [];
  for (let o = 0; o < asks.length; ) {
    const n = asks[o];
    const rank = asks[o + 1];
    const group = asks[o + 2];
    const heights = asks[o + 3] === 1;
    o += 4;
    const t: Pt[] = [];
    for (let k = 0; k < n; k++, o += 2) t.push([asks[o], asks[o + 1]]);
    let ys: number[] | undefined;
    if (heights) {
      ys = Array.from(asks.subarray(o, o + n));
      o += n;
    }
    putCut(out, t, layers.cut(t, rank, group, ys));
  }
  return Float64Array.from(out);
}

/** A draped cover to cut (world/houseMeshes.ts drapedGeometry): its outline's triangles and how it is cut. */
export interface CoverAsk {
  tris: Pt[][];
  cell: number;
  precise: boolean;
  rank: number;
  /** Its first triangle's group (each triangle of its outline has its own, one after another) */
  group: number;
}

/** Covers to cut, in one list of numbers: the grid, then for each its triangle count, cell, precise, rank, group, triangles. */
export function packCovers(covers: CoverAsk[], grid: CoverGrid): Float64Array {
  let size = 3;
  for (const c of covers) size += 5 + 6 * c.tris.length;
  const out = new Float64Array(size);
  out[0] = grid.x0;
  out[1] = grid.z0;
  out[2] = grid.step;
  let o = 3;
  for (const c of covers) {
    out[o++] = c.tris.length;
    out[o++] = c.cell;
    out[o++] = c.precise ? 1 : 0;
    out[o++] = c.rank;
    out[o++] = c.group;
    for (const t of c.tris) {
      for (const [x, z] of t) {
        out[o++] = x;
        out[o++] = z;
      }
    }
  }
  return out;
}

/**
 * Every piece of every packed cover (packCovers) cut by `layers`, as drapedGeometry cuts them: the outcomes in one
 * list, and where each cover's begin in it.
 */
export function cutCovers(layers: GroundLayers, covers: Float64Array): { out: Float64Array; starts: Float64Array } {
  const grid = { x0: covers[0], z0: covers[1], step: covers[2] };
  const out: number[] = [];
  const starts: number[] = [];
  for (let o = 3; o < covers.length; ) {
    const n = covers[o];
    const cell = covers[o + 1];
    const precise = covers[o + 2] === 1;
    const rank = covers[o + 3];
    const group = covers[o + 4];
    o += 5;
    const tris: Pt[][] = [];
    for (let k = 0; k < n; k++, o += 6) tris.push([[covers[o], covers[o + 1]], [covers[o + 2], covers[o + 3]], [covers[o + 4], covers[o + 5]]]);
    starts.push(out.length);
    coverPieces(tris, cell, precise, grid, (h, fi) => putCut(out, h, layers.cut(h, rank, group + fi)));
  }
  return { out: Float64Array.from(out), starts: Float64Array.from(starts) };
}

/** Reads cut outcomes (cutAsks, cutCovers) one by one, for the polygons in the order they were asked. */
export class Cuts {
  private out: Float64Array;
  private at: number;
  private end: number;

  constructor(out: Float64Array, at = 0, end = out.length) {
    this.out = out;
    this.at = at;
    this.end = end;
  }

  /** The pieces of the next polygon `poly` (the same as asked): [poly] itself when it was left whole. */
  next(poly: Pt[]): Pt[][] {
    const o = this.out;
    if (this.at >= this.end) throw new Error('ground cuts: more pieces asked for than were cut');
    const count = o[this.at++];
    if (count === -1) return [poly];
    const pieces: Pt[][] = [];
    for (let p = 0; p < count; p++) {
      const n = o[this.at++];
      const piece: Pt[] = [];
      for (let k = 0; k < n; k++, this.at += 2) piece.push([o[this.at], o[this.at + 1]]);
      pieces.push(piece);
    }
    return pieces;
  }

  /** At the end: every outcome read (else the asks and the build went different ways). */
  done(): void {
    if (this.at !== this.end) throw new Error('ground cuts: fewer pieces asked for than were cut');
  }
}

/** Covers whose cuts were worked out ahead (world/groundCutter.ts), until they are built. */
const coverCuts = new WeakMap<object, Cuts>();

/** Give a cover its cuts worked out ahead: drapedGeometry reads them instead of cutting. */
export function setCoverCuts(cover: object, cuts: Cuts): void {
  coverCuts.set(cover, cuts);
}

/** A cover's cuts worked out ahead, once (a later build of it cuts again). */
export function takeCoverCuts(cover: object): Cuts | undefined {
  const c = coverCuts.get(cover);
  coverCuts.delete(cover);
  return c;
}
