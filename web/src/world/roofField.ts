/**
 * The drawn roofs as floors and solids (world/collision.ts asks): over a building the floor from above is the highest
 * drawn roof surface, and what lies under it is solid. Filled from the triangles as they are drawn (world/surroundings.ts
 * for the open-data houses after the roof planner, world/modelRoofs.ts for our models), so the collision follows
 * whatever the roofs look like, now and later.
 *
 * Each triangle that faces up (slopes up to about 78 degrees) is kept with its plane: a question takes the highest
 * triangle over the point, exact on every slope, ridge, valley and step between two roofs (a grid of heights would round
 * those off). Under that surface it is solid down to `under` (the eaves: the walls' blocks take over below them), and
 * under an overhang a slab of SLAB metres, so walking under the eaves, a porch or a car port stays free.
 *
 * The triangles of each batch (a roof, a model's mesh) are kept in groups of GROUP metres, each with its box, and the
 * groups are found through squares of CELL metres: a question looks at a few boxes and a few triangles.
 */

/** Metres: the side of a square of the index (as world/collision.ts's grid of blocks). */
const CELL = 16;
/** Metres: the triangles of a batch are grouped by the square of this side their middle lies in. */
const GROUP = 4;
/** Floats per triangle: x0, z0, the plan's inverse (4), y0, dy/dx, dy/dz, under. */
const STRIDE = 10;
/** Metres: how thick a roof is where nothing stands under it (an overhang). */
export const SLAB = 0.2;
/** A triangle counts when its normal is at least this far up (cos 78 degrees): roofs, not walls. */
const UP = 0.2;
/** Barycentric slack, so no crack opens between two triangles of one slope (a millimetre or so: no more than that past an edge). */
const PAD = 1e-4;

/**
 * Whether a triangle faces up enough to be a roof: not a wall or a gable, and not on edge. `both`: either way round (a
 * surface drawn from both sides), else only wound to face up (counter-clockwise from above, as three.js's front faces:
 * a ceiling or a soffit, seen only from below, is no roof).
 */
export function facesUp(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, both = true): boolean {
  const ax = x1 - x0, ay = y1 - y0, az = z1 - z0;
  const bx = x2 - x0, by = y2 - y0, bz = z2 - z0;
  const det = ax * bz - az * bx; // the plan's area, doubled (minus the normal's y)
  return Math.abs(det) > 1e-6 && (both || det < 0) && Math.abs(det) >= UP * Math.hypot(ay * bz - az * by, det, ax * by - ay * bx);
}

const cellOf = (v: number) => Math.floor(v / CELL);
const keyOf = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);

/** A Float32Array that grows. */
function room(a: Float32Array<ArrayBuffer>, need: number): Float32Array<ArrayBuffer> {
  if (a.length >= need) return a;
  const more = new Float32Array(Math.max(need, a.length * 2));
  more.set(a);
  return more;
}

export class RoofField {
  /** The triangles, STRIDE floats each. */
  private t = new Float32Array(STRIDE * 4096);
  private n = 0;
  /** The groups: their boxes (min x, min z, max x, max z) and their triangles (first, end). */
  private box = new Float32Array(4 * 1024);
  private range = new Int32Array(2 * 1024);
  private groups = 0;
  private cells = new Map<number, number[]>();
  /** After a `sample` that found a roof: the drawn surface there, the bottom of what is solid under it, its slope. */
  top = 0;
  bottom = 0;
  gx = 0;
  gz = 0;

  /** Triangles kept. */
  get count(): number {
    return this.n;
  }

  /** Bytes the triangles, the groups and their index take (an index entry 4 bytes, a square's list about 40). */
  get bytes(): number {
    let entries = 0;
    for (const list of this.cells.values()) entries += list.length;
    return this.n * STRIDE * 4 + this.groups * 24 + entries * 4 + this.cells.size * 40;
  }

  /**
   * One batch of triangles as drawn (x, y, z of three corners each, world metres; `index`, if given, picks the corners),
   * under each of which it is solid down to `under` (the roof's eaves, per triangle if a list; Infinity: a slab only).
   * Those facing sideways (walls, gables) are left out. Returns how many were kept.
   */
  add(pos: ArrayLike<number>, under: number | ArrayLike<number>, index?: ArrayLike<number> | null): number {
    const corners = index ? index.length : Math.floor(pos.length / 3);
    const first = this.n;
    for (let k = 0; k + 2 < corners; k += 3) {
      const a = (index ? index[k] : k) * 3;
      const b = (index ? index[k + 1] : k + 1) * 3;
      const c = (index ? index[k + 2] : k + 2) * 3;
      this.one(pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2], pos[c], pos[c + 1], pos[c + 2], typeof under === 'number' ? under : under[k / 3]);
    }
    if (this.n > first) this.group(first, this.n);
    return this.n - first;
  }

  private one(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, under: number): void {
    if (!facesUp(x0, y0, z0, x1, y1, z1, x2, y2, z2)) return;
    const ax = x1 - x0, ay = y1 - y0, az = z1 - z0;
    const bx = x2 - x0, by = y2 - y0, bz = z2 - z0;
    const det = ax * bz - az * bx;
    this.t = room(this.t, (this.n + 1) * STRIDE);
    const t = this.t;
    const o = this.n++ * STRIDE;
    // (u, v) = M (dx, dz): the corners' weights; the height y0 + u ay + v by, a plane in dx and dz.
    const m00 = bz / det, m01 = -bx / det, m10 = -az / det, m11 = ax / det;
    t[o] = x0;
    t[o + 1] = z0;
    t[o + 2] = m00;
    t[o + 3] = m01;
    t[o + 4] = m10;
    t[o + 5] = m11;
    t[o + 6] = y0;
    t[o + 7] = ay * m00 + by * m10;
    t[o + 8] = ay * m01 + by * m11;
    t[o + 9] = under;
  }

  /** Triangles first..end-1 sorted into groups by where their middles lie, each group's box into the index. */
  private group(first: number, end: number): void {
    const t = this.t;
    // A triangle's corners back from its plan: x1 = x0 + ax, where (ax, az) is the inverse's first column inverted.
    const corners = (i: number): number[] => {
      const o = i * STRIDE;
      const [m00, m01, m10, m11] = [t[o + 2], t[o + 3], t[o + 4], t[o + 5]];
      const det = m00 * m11 - m01 * m10;
      // M = inverse of [[ax, bx], [az, bz]]: so [[ax, bx], [az, bz]] = inverse of M.
      const ax = m11 / det, bx = -m01 / det, az = -m10 / det, bz = m00 / det;
      return [t[o], t[o + 1], t[o] + ax, t[o + 1] + az, t[o] + bx, t[o + 1] + bz];
    };
    const order: { i: number; key: number; c: number[] }[] = [];
    for (let i = first; i < end; i++) {
      const c = corners(i);
      const key = keyOf(Math.floor((c[0] + c[2] + c[4]) / 3 / GROUP), Math.floor((c[1] + c[3] + c[5]) / 3 / GROUP));
      order.push({ i, key, c });
    }
    order.sort((p, q) => p.key - q.key || p.i - q.i);
    const copy = t.slice(first * STRIDE, end * STRIDE);
    order.forEach((e, k) => t.set(copy.subarray((e.i - first) * STRIDE, (e.i - first + 1) * STRIDE), (first + k) * STRIDE));
    for (let k = 0; k < order.length; ) {
      let m = k;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (; m < order.length && order[m].key === order[k].key; m++) {
        const c = order[m].c;
        x0 = Math.min(x0, c[0], c[2], c[4]);
        x1 = Math.max(x1, c[0], c[2], c[4]);
        z0 = Math.min(z0, c[1], c[3], c[5]);
        z1 = Math.max(z1, c[1], c[3], c[5]);
      }
      const g = this.groups++;
      if (this.box.length < this.groups * 4) {
        this.box = room(this.box, this.groups * 8);
        const r = new Int32Array(this.groups * 4);
        r.set(this.range);
        this.range = r;
      }
      this.box.set([x0 - 0.01, z0 - 0.01, x1 + 0.01, z1 + 0.01], g * 4);
      this.range[g * 2] = first + k;
      this.range[g * 2 + 1] = first + m;
      for (let i = cellOf(x0); i <= cellOf(x1); i++) {
        for (let j = cellOf(z0); j <= cellOf(z1); j++) {
          const key = keyOf(i, j);
          const list = this.cells.get(key);
          if (list) list.push(g);
          else this.cells.set(key, [g]);
        }
      }
      k = m;
    }
  }

  /**
   * Whether a roof is drawn over (x, z), its surface at `low` or higher (lower down it counts as air: an eave by the
   * ground is no ramp up for a car, a horse or a walker); if so `top`, `bottom`, `gx` and `gz` say where and how it lies.
   */
  sample(x: number, z: number, low = -Infinity): boolean {
    const list = this.cells.get(keyOf(cellOf(x), cellOf(z)));
    if (!list) return false;
    const t = this.t;
    const box = this.box;
    let best = -Infinity;
    let at = -1;
    for (let k = 0; k < list.length; k++) {
      const g = list[k] * 4;
      if (x < box[g] || z < box[g + 1] || x > box[g + 2] || z > box[g + 3]) continue;
      const end = this.range[list[k] * 2 + 1] * STRIDE;
      for (let o = this.range[list[k] * 2] * STRIDE; o < end; o += STRIDE) {
        const dx = x - t[o];
        const dz = z - t[o + 1];
        const u = t[o + 2] * dx + t[o + 3] * dz;
        if (u < -PAD) continue;
        const v = t[o + 4] * dx + t[o + 5] * dz;
        if (v < -PAD || u + v > 1 + PAD) continue;
        const y = t[o + 6] + t[o + 7] * dx + t[o + 8] * dz;
        if (y > best) {
          best = y;
          at = o;
        }
      }
    }
    if (at < 0 || best < low) return false;
    this.top = best;
    this.bottom = Math.min(best - SLAB, t[at + 9]);
    this.gx = t[at + 7];
    this.gz = t[at + 8];
    return true;
  }

  /**
   * The floor a body with its feet at `feet` stands on at (x, z) from the roofs, or null: the roof when it is within a
   * step (`stepUp`) of the feet, or when the feet are inside what is solid under it (landed, put or pushed there: up
   * onto the roof is the way out).
   */
  floor(x: number, z: number, feet: number, stepUp: number, low = -Infinity): number | null {
    if (!this.sample(x, z, low)) return null;
    return this.top <= feet + stepUp || feet >= this.bottom ? this.top : null;
  }

  /**
   * Whether a roof stops a body (feet to feet + height) walking to (x, z): its surface more than a step over the feet,
   * and what is solid under it reaching down into the body's height. (A body already inside, put there, is let out:
   * the player walks freely from such a spot, and `floor` lifts feet inside it onto the roof.)
   */
  blocks(x: number, z: number, feet: number, stepUp: number, height: number, low = -Infinity): boolean {
    if (!this.sample(x, z, low)) return false;
    return this.top > feet + stepUp && this.bottom < feet + height;
  }
}
