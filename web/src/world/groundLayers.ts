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

/** The claims: triangles on the plan, each with its rank and group, found by the squares they lie over. */
export class GroundLayers {
  private pts: number[] = [];
  private ranks: number[] = [];
  private groupOf: number[] = [];
  private boxes: number[] = [];
  /** A claim's plane, y = a x + b z + c (NaN: a claim without heights, that beats by the plan alone) */
  private planes: number[] = [];
  /** Beats only surfaces of its own rank (a model's surface above its ground: a step, a sill, a raised floor) */
  private own: boolean[] = [];
  private cells = new Map<number, number[]>();
  /** The squares claimed in since their lists were last sorted (strongest first: cut stops at the first that can't beat) */
  private unsorted = new Set<number[]>();
  private seen: number[] = [];
  private stamp = 0;
  private groups = 0;

  /** How many triangles are claimed. */
  get size(): number {
    return this.ranks.length;
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
    const i = this.ranks.length;
    this.pts.push(a[0], a[1], b[0], b[1], c[0], c[1]);
    this.ranks.push(rank);
    this.groupOf.push(group);
    if (ys) {
      const [pa, pb, pc] = plane(t, ys);
      this.planes.push(pa, pb, pc);
    } else this.planes.push(NaN, NaN, NaN);
    this.own.push(ownRank);
    const x0 = Math.min(a[0], b[0], c[0]);
    const x1 = Math.max(a[0], b[0], c[0]);
    const z0 = Math.min(a[1], b[1], c[1]);
    const z1 = Math.max(a[1], b[1], c[1]);
    this.boxes.push(x0, z0, x1, z1);
    this.seen.push(0);
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const key = cx * 100003 + cz;
        let list = this.cells.get(key);
        if (list) list.push(i);
        else this.cells.set(key, (list = [i]));
        this.unsorted.add(list);
      }
    }
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
    let pieces: Pt[][] = [poly];
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const list = this.cells.get(cx * 100003 + cz);
        if (!list) continue;
        for (const i of list) {
          const r = this.ranks[i];
          // Strongest first: from here on none beats it (but of two with heights, the higher one does, wherever it is).
          if (r < rank || (r === rank && this.groupOf[i] >= group && !mine)) break;
          if (this.seen[i] === stamp) continue;
          this.seen[i] = stamp;
          if (r !== rank && this.own[i]) continue;
          const b = this.boxes;
          if (b[4 * i] > x1 - EPS || b[4 * i + 2] < x0 + EPS || b[4 * i + 1] > z1 - EPS || b[4 * i + 3] < z0 + EPS) continue;
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
export function runNow<T>(job: Generator<void, T>): T {
  for (;;) {
    const r = job.next();
    if (r.done) return r.value;
  }
}

/**
 * Run a job made of steps between frames: `between` is awaited each time `slice` ms of work have gone by, so the game
 * goes on drawing while the village is built (it comes in after play has begun).
 */
export async function runSoon<T>(job: Generator<void, T>, between: () => Promise<unknown>, slice = 40): Promise<T> {
  let start = performance.now();
  for (;;) {
    const r = job.next();
    if (r.done) return r.value;
    if (performance.now() - start > slice) {
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

/** Barycentric weights of (x, z) in the triangle t. */
export function weightsIn(t: Pt[], x: number, z: number): [number, number, number] {
  const [[ax, az], [bx, bz], [cx, cz]] = t;
  const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
  const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
  return [l1, l2, 1 - l1 - l2];
}
