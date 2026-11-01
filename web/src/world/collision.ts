import type { Bounds } from '../../shared/bounds.mjs';
import type { Prism, Ring } from './houseData';
import { terrain } from './terrain';

interface Solid {
  /** Switched off, e.g. a broken window */
  off?: boolean;
  y0: number;
  y1: number;
  /** On the relief: y0 and y1 are above the ground wherever it is asked about */
  lift?: boolean;
  rings: Ring[];
  name?: string;
  /** Material, e.g. floor_wood (decides the footstep sound) */
  mat?: string;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface Point {
  x: number;
  y: number;
  z: number;
}

export interface Ground {
  y: number;
  name?: string;
  mat?: string;
}

/** Even-odd test across the outline and its holes. */
function inside(x: number, z: number, rings: Ring[]): boolean {
  let hit = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i];
      const [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    }
  }
  return hit;
}

function closestOnRings(x: number, z: number, rings: Ring[]): [number, number] {
  let best = Infinity;
  let bx = x;
  let bz = z;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, az] = ring[j];
      const [cx, cz] = ring[i];
      const ex = cx - ax;
      const ez = cz - az;
      const len2 = ex * ex + ez * ez;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2)) : 0;
      const px = ax + ex * t;
      const pz = az + ez * t;
      const d = (px - x) ** 2 + (pz - z) ** 2;
      if (d < best) {
        best = d;
        bx = px;
        bz = pz;
      }
    }
  }
  return [bx, bz];
}

/** Whether segments a-b and c-d cross. */
function crosses(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const side = (p: [number, number], q: [number, number], r: [number, number]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return side(c, d, a) * side(c, d, b) < 0 && side(a, b, c) * side(a, b, d) < 0;
}

/** Metres: the side of a square of the grid that finds the blocks near a point. */
const CELL = 16;
const cellOf = (v: number) => Math.floor(v / CELL);
const cellKey = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);

/**
 * Collision against the house blocks. The player is a vertical capsule:
 * a circle on the plan, from (feet + stepUp) to (feet + height). Blocks whose
 * top is within stepUp of the feet are treated as floor you can step onto.
 *
 * The blocks (the house's, then the surroundings', then the village's when it has come) are
 * sorted into a grid of CELL-metre squares, so a question about a spot only looks at the blocks
 * near it: with the village there are about 6,500.
 */
export class World {
  private solids: Solid[] = [];
  /** Block numbers per square of the grid. */
  private grid = new Map<number, number[]>();
  /** Per block: the last search that found it (no block twice in one answer). */
  private seen = new Uint32Array(0);
  private search = 0;
  /** Moving parts such as door panels, keyed by name; updated while they move. */
  private moving = new Map<string, Solid>();

  private dips: { rim: Ring; bottom: Ring; depth: number; low: number; minX: number; maxX: number; minZ: number; maxZ: number }[] = [];

  /**
   * The edge of the game (shared/bounds.mjs): the outline nobody walks, rides or drives past (main.ts
   * sets the big one, or the one round the two houses while a game in the house runs), and the
   * ceiling for flying, in metres above the ground under you. Null and Infinity: no edge.
   */
  bounds: Bounds | null = null;
  ceiling = Infinity;

  /** `prisms`: the house's blocks (their numbers are the house data's: broken windows use them). */
  constructor(prisms: Prism[], private baseGround: number) {
    this.addPrisms(prisms);
  }

  /** More blocks after the ones there are (the surroundings, the village); returns the first one's number. */
  addPrisms(prisms: Prism[]): number {
    const first = this.solids.length;
    for (const p of prisms) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [x, z] of p.p[0]) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
      const index = this.solids.length;
      this.solids.push({ y0: p.y0, y1: p.y1, lift: !!p.d, rings: p.p, name: p.n, mat: p.m, minX, maxX, minZ, maxZ });
      for (let i = cellOf(minX); i <= cellOf(maxX); i++) {
        for (let j = cellOf(minZ); j <= cellOf(maxZ); j++) {
          const k = cellKey(i, j);
          const list = this.grid.get(k);
          if (list) list.push(index);
          else this.grid.set(k, [index]);
        }
      }
    }
    const seen = new Uint32Array(this.solids.length);
    seen.set(this.seen);
    this.seen = seen;
    return first;
  }

  /** The blocks whose squares overlap a rectangle on the plan, in their order in the data. */
  private near(minX: number, minZ: number, maxX: number, maxZ: number): number[] {
    const i0 = cellOf(minX), i1 = cellOf(maxX), j0 = cellOf(minZ), j1 = cellOf(maxZ);
    if (i0 === i1 && j0 === j1) return this.grid.get(cellKey(i0, j0)) ?? [];
    const out: number[] = [];
    const stamp = ++this.search;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (const k of this.grid.get(cellKey(i, j)) ?? []) {
          if (this.seen[k] === stamp) continue;
          this.seen[k] = stamp;
          out.push(k);
        }
      }
    }
    return out.sort((a, b) => a - b);
  }

  /** The blocks in the square of the grid that holds (x, z). */
  private at(x: number, z: number): number[] {
    return this.grid.get(cellKey(cellOf(x), cellOf(z))) ?? [];
  }

  /** A block's underside and top at (x, z): out on the relief they follow the ground. */
  private lo(s: Solid, x: number, z: number): number {
    return s.lift ? s.y0 + terrain.height(x, z) : s.y0;
  }

  private hi(s: Solid, x: number, z: number): number {
    return s.lift ? s.y1 + terrain.height(x, z) : s.y1;
  }

  /** Switch a block (by its number in the house data) off or back on: broken windows. */
  setSolid(index: number, on: boolean): void {
    const s = this.solids[index];
    if (s) s.off = !on;
  }

  /** Set (or with null, remove) a moving solid: a flat outline between two heights. */
  setMoving(key: string, ring: Ring | null, y0 = 0, y1 = 0): void {
    if (!ring) {
      this.moving.delete(key);
      return;
    }
    const xs = ring.map((v) => v[0]);
    const zs = ring.map((v) => v[1]);
    this.moving.set(key, { y0, y1, rings: [ring], minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) });
  }

  /** Lowest underside between fromY and toY above a circle at (x, z), or null when the way up is clear. */
  ceilingAbove(x: number, z: number, radius: number, fromY: number, toY: number): number | null {
    let best: number | null = null;
    for (const k of this.near(x - radius, z - radius, x + radius, z + radius)) {
      const s = this.solids[k];
      if (s.off || x + radius < s.minX || x - radius > s.maxX || z + radius < s.minZ || z - radius > s.maxZ) continue;
      const under = this.lo(s, x, z);
      if (under < fromY - 0.02 || under > toY) continue;
      const [cx, cz] = closestOnRings(x, z, s.rings);
      if (inside(x, z, s.rings) || Math.hypot(x - cx, z - cz) < radius * 0.7) {
        if (best === null || under < best) best = under;
      }
    }
    return best;
  }

  /** Dips in the ground (the garden's wadi). */
  setDips(dips: { rim: [number, number][]; bottom: [number, number][]; depth: number; low?: number }[]): void {
    this.dips = [];
    this.addDips(dips);
  }

  /** More dips (the village's ponds). */
  addDips(dips: { rim: [number, number][]; bottom: [number, number][]; depth: number; low?: number }[]): void {
    this.dips = this.dips.concat(dips.map((d) => {
      const xs = d.rim.map((v) => v[0]);
      const zs = d.rim.map((v) => v[1]);
      return { rim: d.rim, bottom: d.bottom, depth: d.depth, low: d.low ?? 0, minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
    }));
  }

  /**
   * The bare ground: the relief (flat round the plot), except in a dip: its sides slope 1:1
   * down to its flat bottom, `depth` below the lowest ground round its rim.
   */
  private baseAt(x: number, z: number): number {
    const ground = this.baseGround + terrain.height(x, z);
    for (const d of this.dips) {
      if (x < d.minX || x > d.maxX || z < d.minZ || z > d.maxZ || !inside(x, z, [d.rim])) continue;
      const bottom = this.baseGround + d.low - d.depth;
      if (inside(x, z, [d.bottom])) return bottom;
      const [cx, cz] = closestOnRings(x, z, [d.rim]);
      return ground - (ground - bottom) * Math.min(1, Math.hypot(x - cx, z - cz) / d.depth);
    }
    return ground;
  }

  /** Keep a circle (the player) inside the edge of the game, sliding along it as along a wall; true when it pushed. */
  keepIn(pos: { x: number; z: number }, radius: number): boolean {
    return !!this.bounds?.keepIn(pos, radius);
  }

  /**
   * Whether a rectangle (a car, a horse) may go to (cx, cz, yaw) as far as the edge of the game goes:
   * inside it, or, for one already over it (the game's area shrank round it), at least further in
   * than where it is (`from`).
   */
  boxInBounds(cx: number, cz: number, yaw: number, halfL: number, halfW: number, from: { x: number; z: number; yaw: number }): boolean {
    const b = this.bounds;
    if (!b || b.boxInside(cx, cz, yaw, halfL, halfW)) return true;
    if (b.boxInside(from.x, from.z, from.yaw, halfL, halfW)) return false; // the usual case: against the edge
    return b.depth(cx, cz) > b.depth(from.x, from.z);
  }

  /** The highest anyone flies at (x, z): `ceiling` above the bare ground there. */
  skyAt(x: number, z: number): number {
    return this.baseGround + terrain.height(x, z) + this.ceiling;
  }

  groundAt(x: number, z: number, feet: number, stepUp: number): Ground {
    const g: Ground = { y: this.baseAt(x, z), name: 'Garden' };
    for (const k of this.at(x, z)) {
      const s = this.solids[k];
      if (s.off || x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ) continue;
      const top = this.hi(s, x, z);
      if (top > feet + stepUp || top <= g.y) continue;
      if (inside(x, z, s.rings)) {
        g.y = top;
        g.name = s.name;
        g.mat = s.mat;
      }
    }
    return g;
  }

  /**
   * A small ball (radius r) moving from a to b: the block it runs into (its number in the
   * house data; -1 the ground, -2 a moving part) and the outward side it hits, or null.
   * A top counts when the ball came from above, an underside from below, otherwise the
   * side of the outline nearest to where it came from.
   */
  collide(a: Point, b: Point, r: number): { index: number; nx: number; ny: number; nz: number } | null {
    if (b.y - r < this.baseAt(b.x, b.z)) return { index: -1, nx: 0, ny: 1, nz: 0 };
    const test = (s: Solid, index: number) => {
      if (s.off || b.x + r < s.minX || b.x - r > s.maxX || b.z + r < s.minZ || b.z - r > s.maxZ) return null;
      const y0 = this.lo(s, b.x, b.z);
      const y1 = this.hi(s, b.x, b.z);
      if (b.y + r <= y0 || b.y - r >= y1) return null;
      if (!inside(b.x, b.z, s.rings)) {
        const [cx, cz] = closestOnRings(b.x, b.z, s.rings);
        if (Math.hypot(b.x - cx, b.z - cz) >= r) return null;
      }
      if (a.y - r >= y1 - 1e-4) return { index, nx: 0, ny: 1, nz: 0 };
      if (a.y + r <= y0 + 1e-4) return { index, nx: 0, ny: -1, nz: 0 };
      const [cx, cz] = closestOnRings(a.x, a.z, s.rings);
      let nx = a.x - cx;
      let nz = a.z - cz;
      let d = Math.hypot(nx, nz);
      if (d < 1e-6) [nx, nz, d] = [a.x - b.x, a.z - b.z, Math.hypot(a.x - b.x, a.z - b.z) || 1];
      const out = inside(a.x, a.z, s.rings) ? -1 : 1;
      return { index, nx: (out * nx) / d, ny: 0, nz: (out * nz) / d };
    };
    for (const i of this.near(b.x - r, b.z - r, b.x + r, b.z + r)) {
      const hit = test(this.solids[i], i);
      if (hit) return hit;
    }
    for (const s of this.moving.values()) {
      const hit = test(s, -2);
      if (hit) return hit;
    }
    return null;
  }

  /** Whether a block stands between a and b (checked every `step`, 10 cm): a blast does not go through walls. */
  blocked(a: Point, b: Point, step = 0.1): boolean {
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const moving = [...this.moving.values()];
    const hit = (s: Solid, x: number, y: number, z: number) =>
      !(s.off || x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ || y <= this.lo(s, x, z) || y >= this.hi(s, x, z)) && inside(x, z, s.rings);
    for (let t = step; t < len; t += step) {
      const k = t / len;
      const x = a.x + (b.x - a.x) * k;
      const y = a.y + (b.y - a.y) * k;
      const z = a.z + (b.z - a.z) * k;
      for (const i of this.at(x, z)) if (hit(this.solids[i], x, y, z)) return true;
      for (const s of moving) if (hit(s, x, y, z)) return true;
    }
    return false;
  }

  /**
   * Whether a rectangle on the plan (the car: its middle, heading, half length and half
   * width) is clear of every block between y0 and y1. The moving part `skip` (the car
   * itself) doesn't count.
   */
  boxFree(cx: number, cz: number, yaw: number, halfL: number, halfW: number, y0: number, y1: number, skip?: string): boolean {
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const box = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]): [number, number] => [cx + fx * halfL * a - fz * halfW * b, cz + fz * halfL * a + fx * halfW * b]);
    const xs = box.map((v) => v[0]);
    const zs = box.map((v) => v[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const inBox = (x: number, z: number) => {
      const dx = x - cx;
      const dz = z - cz;
      return Math.abs(dx * fx + dz * fz) <= halfL && Math.abs(-dx * fz + dz * fx) <= halfW;
    };
    const hits = (s: Solid) => {
      if (s.off || s.maxX < minX || s.minX > maxX || s.maxZ < minZ || s.minZ > maxZ) return false;
      if (this.hi(s, cx, cz) <= y0 || this.lo(s, cx, cz) >= y1) return false;
      if (box.some(([x, z]) => inside(x, z, s.rings))) return true;
      for (const ring of s.rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          if (inBox(ring[i][0], ring[i][1])) return true;
          for (let k = 0, l = 3; k < 4; l = k++) if (crosses(ring[j], ring[i], box[l], box[k])) return true;
        }
      }
      return false;
    };
    for (const i of this.near(minX, minZ, maxX, maxZ)) if (hits(this.solids[i])) return false;
    for (const [key, s] of this.moving) if (key !== skip && hits(s)) return false;
    return true;
  }

  /** How far from a towards b (0..1) the way is clear, checked every 20 cm: the car's camera stays out of walls. */
  clearance(a: Point, b: Point, skip?: string): number {
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const moving = [...this.moving].filter(([key]) => key !== skip).map(([, s]) => s);
    const hit = (s: Solid, x: number, y: number, z: number) =>
      !(s.off || x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ || y <= this.lo(s, x, z) || y >= this.hi(s, x, z)) && inside(x, z, s.rings);
    for (let t = 0.2; t < len; t += 0.2) {
      const k = t / len;
      const x = a.x + (b.x - a.x) * k;
      const y = a.y + (b.y - a.y) * k;
      const z = a.z + (b.z - a.z) * k;
      if (this.at(x, z).some((i) => hit(this.solids[i], x, y, z)) || moving.some((s) => hit(s, x, y, z))) return Math.max(0, t - 0.2) / len;
    }
    return 1;
  }

  /** Push a circle at (pos.x, pos.z) out of every block in the body's height band. */
  resolve(pos: { x: number; z: number }, feet: number, radius: number, stepUp: number, height: number): void {
    const lo = feet + stepUp;
    const hi = feet + height;
    const moving = [...this.moving.values()];
    for (let iter = 0; iter < 4; iter++) {
      let moved = false;
      const near = this.near(pos.x - radius, pos.z - radius, pos.x + radius, pos.z + radius).map((i) => this.solids[i]);
      for (const s of near.concat(moving)) {
        if (s.off || pos.x + radius < s.minX || pos.x - radius > s.maxX || pos.z + radius < s.minZ || pos.z - radius > s.maxZ) continue;
        if (this.hi(s, pos.x, pos.z) <= lo || this.lo(s, pos.x, pos.z) >= hi) continue;
        const [cx, cz] = closestOnRings(pos.x, pos.z, s.rings);
        const dx = pos.x - cx;
        const dz = pos.z - cz;
        const d = Math.hypot(dx, dz);
        if (inside(pos.x, pos.z, s.rings)) {
          // Centre ended up inside a block: leave through the nearest edge.
          const nx = d > 1e-6 ? -dx / d : 1;
          const nz = d > 1e-6 ? -dz / d : 0;
          pos.x = cx + nx * radius;
          pos.z = cz + nz * radius;
          moved = true;
        } else if (d < radius) {
          const nx = d > 1e-6 ? dx / d : 1;
          const nz = d > 1e-6 ? dz / d : 0;
          pos.x = cx + nx * radius;
          pos.z = cz + nz * radius;
          moved = true;
        }
      }
      if (!moved) break;
    }
  }
}
