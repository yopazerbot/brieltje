import type { Prism } from './houseData';

/**
 * Which open-data house a wall block, a roof or an opening belongs to (world/facadeLook.ts re-exports all of it): walls
 * of the same brick that touch are one house, with a key from 0 to 1 fixed by the corner of its walls furthest west
 * (then north), so a house looks the same to every player on every visit. No imports, so node can test it (and the
 * parts built from it: world/houseStyle.test.mjs, world/wallPlan.test.mjs).
 */

/** A number from 0 to 1 that depends only on the numbers given. */
export function stable(...v: number[]): number {
  let h = 2166136261;
  for (const x of v) h = Math.imul(h ^ Math.round(x * 1000), 16777619) ^ (h >>> 13);
  return ((h >>> 0) % 100003) / 100003;
}

/** The neighbours' bricks (houseMeshes.ts's nb_ family), the walls of a house. */
const BRICK = /^nb_(red|brown|yellow|white|grey|dark)$/;
export const isBrick = (m: string): boolean => BRICK.test(m);

/** Whether a house's walls are rendered (1) or bare brick (0): about two in five white houses and one in eight yellow ones. */
export const renderOf = (m: string, key: number): number => ((m === 'nb_white' && key < 0.4) || (m === 'nb_yellow' && key < 0.12) ? 1 : 0);

/** Whether (x, z) lies inside a ring. */
export function inside(ring: [number, number][], x: number, z: number): boolean {
  let yes = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) yes = !yes;
  }
  return yes;
}

/** A point inside a ring (its middle if that is inside, else just inside one of its sides), for concave outlines. */
export function pointInside(ring: [number, number][]): [number, number] | null {
  const mx = ring.reduce((s, q) => s + q[0], 0) / ring.length;
  const mz = ring.reduce((s, q) => s + q[1], 0) / ring.length;
  if (inside(ring, mx, mz)) return [mx, mz];
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % ring.length];
    const l = Math.hypot(bx - ax, bz - az);
    if (l < 0.2) continue;
    for (const s of [0.2, -0.2]) {
      const x = (ax + bx) / 2 + (s * (bz - az)) / l;
      const z = (az + bz) / 2 - (s * (bx - ax)) / l;
      if (inside(ring, x, z)) return [x, z];
    }
  }
  return null;
}

const CELL = 10;

/** Blocks in cells of 10 m, to find those standing at a point quickly (in the order they were added). */
export class BlockGrid {
  private cells = new Map<string, number[]>();
  readonly list: { p: Prism; box: [number, number, number, number] }[] = [];

  add(p: Prism): void {
    const xs = p.p[0].map((q) => q[0]);
    const zs = p.p[0].map((q) => q[1]);
    const box: [number, number, number, number] = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
    const i = this.list.length;
    this.list.push({ p, box });
    for (let cx = Math.floor(box[0] / CELL); cx <= Math.floor(box[2] / CELL); cx++) {
      for (let cz = Math.floor(box[1] / CELL); cz <= Math.floor(box[3] / CELL); cz++) {
        const k = `${cx}|${cz}`;
        const c = this.cells.get(k);
        if (c) c.push(i);
        else this.cells.set(k, [i]);
      }
    }
  }

  /** The blocks whose outline holds (x, z). */
  at(x: number, z: number): Prism[] {
    const out: Prism[] = [];
    for (const i of this.cells.get(`${Math.floor(x / CELL)}|${Math.floor(z / CELL)}`) ?? []) {
      const { p, box } = this.list[i];
      if (x < box[0] || x > box[2] || z < box[1] || z > box[3] || !inside(p.p[0], x, z)) continue;
      out.push(p);
    }
    return out;
  }
}

export interface WallHit {
  key: number;
  m: string;
  p: Prism;
}

/**
 * The houses of a set of blocks (the ring's, or the village's: world/houseIndex.ts builds one for each set, so a house
 * split over two tiles is one house).
 */
export class Houses {
  private grid = new BlockGrid();
  private keys = new Map<Prism, number>();

  constructor(prisms: Prism[]) {
    const own = prisms.filter((p) => isBrick(p.m));
    const parent = own.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const corner = new Map<string, number>();
    own.forEach((p, i) => {
      for (const [x, z] of p.p[0]) {
        const at = `${p.m}|${Math.round(x * 20)}|${Math.round(z * 20)}`;
        const j = corner.get(at);
        if (j === undefined) corner.set(at, i);
        else parent[find(i)] = find(j);
      }
    });
    const first = new Map<number, [number, number]>();
    own.forEach((p, i) => {
      const r = find(i);
      for (const [x, z] of p.p[0]) {
        const f = first.get(r);
        if (!f || x < f[0] - 1e-6 || (Math.abs(x - f[0]) < 1e-6 && z < f[1])) first.set(r, [x, z]);
      }
    });
    own.forEach((p, i) => {
      const [x, z] = first.get(find(i))!;
      this.keys.set(p, stable(Math.round(x * 10) / 10, Math.round(z * 10) / 10, 29));
      this.grid.add(p);
    });
  }

  /** The key of the house a wall block belongs to. */
  keyOf(p: Prism): number {
    return this.keys.get(p) ?? stable(p.p[0][0][0], p.p[0][0][1], 29);
  }

  /** The key of the house whose walls stand round (x, z), preferring brick `m`; or one of the spot itself. */
  at(x: number, z: number, m?: string): number {
    const here = this.grid.at(x, z);
    // (As it always chose: with `m` and none of that brick, the last block found.)
    const found = m ? here.find((p) => p.m === m) ?? here[here.length - 1] : here[0];
    return found ? this.keyOf(found) : stable(Math.round(x), Math.round(z), 31);
  }

  /** Every wall block standing round (x, z). */
  wallsAt(x: number, z: number): WallHit[] {
    return this.grid.at(x, z).map((p) => ({ key: this.keyOf(p), m: p.m, p }));
  }

  /**
   * The wall block round (x, z): the one that reaches height `y` when given (a house is often blocks stacked on each
   * other), else the one nearest to it; null where no wall stands.
   */
  wallAt(x: number, z: number, y?: number): WallHit | null {
    const here = this.grid.at(x, z);
    if (!here.length) return null;
    let best = here[0];
    if (y !== undefined) {
      const off = (p: Prism) => (y < p.y0 ? p.y0 - y : y > p.y1 ? y - p.y1 : 0);
      for (const p of here) if (off(p) < off(best)) best = p;
    }
    return { key: this.keyOf(best), m: best.m, p: best };
  }

  /** Whether a wall block round (x, z) reaches height y. */
  holds(x: number, z: number, y: number): boolean {
    return this.grid.at(x, z).some((p) => p.y0 - 0.01 <= y && y <= p.y1 + 0.01);
  }
}
