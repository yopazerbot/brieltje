/**
 * Where the villagers walk and cycle (web/src/data/villagers.json, made by tools/villager_paths.py from the
 * public road data): lines along the pavements and the edges of the country roads, footpaths, the ways
 * between them (crossings and junctions), one-way lines for cyclists on the right, the benches and the busier
 * places. This module only holds them and answers questions about them; world/villagers.ts moves the people.
 */

export interface PathData {
  walks: number[][];
  wkind: number[];
  links: number[][];
  bikes: number[][];
  bkind: number[];
  bnext: number[][][];
  seats: number[][];
  hubs: number[][];
  hubspots: number[][];
}

/** A spot on a line and the way the line runs there. */
export interface At {
  x: number;
  z: number;
  dx: number;
  dz: number;
}

/** A polyline with its distance at each point. */
export class Line {
  readonly x: Float32Array;
  readonly z: Float32Array;
  readonly s: Float32Array;
  readonly length: number;

  constructor(flat: number[]) {
    const n = flat.length / 2;
    this.x = new Float32Array(n);
    this.z = new Float32Array(n);
    this.s = new Float32Array(n);
    let s = 0;
    for (let i = 0; i < n; i++) {
      this.x[i] = flat[2 * i];
      this.z[i] = flat[2 * i + 1];
      if (i) s += Math.hypot(this.x[i] - this.x[i - 1], this.z[i] - this.z[i - 1]);
      this.s[i] = s;
    }
    this.length = s;
  }

  get count(): number {
    return this.x.length;
  }

  /** The segment that holds distance s (its first point's index). */
  seg(s: number): number {
    let lo = 0;
    let hi = this.s.length - 2;
    if (hi <= 0) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.s[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** The point at distance s (clamped to the line) and the line's direction there. */
  at(s: number, out: At): At {
    const n = this.s.length;
    if (n < 2) {
      out.x = this.x[0];
      out.z = this.z[0];
      out.dx = 0;
      out.dz = 1;
      return out;
    }
    const c = Math.max(0, Math.min(this.length, s));
    const i = this.seg(c);
    const L = this.s[i + 1] - this.s[i] || 1;
    const t = (c - this.s[i]) / L;
    const dx = (this.x[i + 1] - this.x[i]) / L;
    const dz = (this.z[i + 1] - this.z[i]) / L;
    out.x = this.x[i] + (this.x[i + 1] - this.x[i]) * t;
    out.z = this.z[i] + (this.z[i + 1] - this.z[i]) * t;
    out.dx = dx;
    out.dz = dz;
    return out;
  }
}

export interface Link {
  /** The line and point it leads to */
  to: number;
  idx: number;
  /** It crosses a carriageway */
  road: boolean;
}

/** A spot of a line in the grid: the line, how far along, the line's kind. */
interface Spot {
  line: number;
  s: number;
  w: number;
}

const CELL = 16; // m
const SPOT_EVERY = 6; // m between a line's spots in the grid
/** How much each kind of walk is used: the village's pavements, a country road's edge, a footpath. */
const WALK_WEIGHT = [1, 0.3, 0.45];
const BIKE_WEIGHT = [1, 0.6];
const key = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);

export class Paths {
  readonly walks: Line[];
  readonly wkind: number[];
  readonly bikes: Line[];
  readonly bkind: number[];
  /** Per bike line, where it may go on from its end: [line, point] */
  readonly bnext: number[][][];
  /** x, z, facing (heading), seat height */
  readonly seats: [number, number, number, number][];
  /** x, z, radius, kind (0 the church square, 1 the school, 2 the café) */
  readonly hubs: [number, number, number, number][];
  /** Per hub, the spots on its public paving where people may stand about (x, z, ...) */
  readonly hubSpots: number[][];
  private links = new Map<number, Link[]>();
  private walkGrid = new Map<number, Spot[]>();
  private bikeGrid = new Map<number, Spot[]>();

  constructor(d: PathData) {
    this.walks = d.walks.map((p) => new Line(p));
    this.wkind = d.wkind;
    this.bikes = d.bikes.map((p) => new Line(p));
    this.bkind = d.bkind;
    this.bnext = d.bnext;
    this.seats = d.seats as [number, number, number, number][];
    this.hubs = d.hubs as [number, number, number, number][];
    this.hubSpots = d.hubspots ?? [];
    for (const [a, ai, b, bi, road] of d.links) {
      this.addLink(a, ai, { to: b, idx: bi, road: !!road });
      this.addLink(b, bi, { to: a, idx: ai, road: !!road });
    }
    const hubBoost = (x: number, z: number) => {
      let w = 1;
      for (const [hx, hz, r] of this.hubs) {
        const d = Math.hypot(x - hx, z - hz);
        if (d < r * 2.5) w += 2 * (1 - d / (r * 2.5));
      }
      return w;
    };
    const fill = (lines: Line[], kinds: number[], weights: number[], grid: Map<number, Spot[]>) => {
      lines.forEach((l, i) => {
        for (let s = Math.min(2, l.length / 2); s < l.length; s += SPOT_EVERY) {
          const p = l.at(s, { x: 0, z: 0, dx: 0, dz: 0 });
          const k = key(Math.floor(p.x / CELL), Math.floor(p.z / CELL));
          const list = grid.get(k) ?? [];
          list.push({ line: i, s, w: weights[kinds[i]] * hubBoost(p.x, p.z) });
          grid.set(k, list);
        }
      });
    };
    fill(this.walks, this.wkind, WALK_WEIGHT, this.walkGrid);
    fill(this.bikes, this.bkind, BIKE_WEIGHT, this.bikeGrid);
  }

  private addLink(line: number, idx: number, l: Link): void {
    const k = line * 65536 + idx;
    const list = this.links.get(k) ?? [];
    list.push(l);
    this.links.set(k, list);
  }

  /** The ways off line `line` at its point `idx` (none: an empty list). */
  linksAt(line: number, idx: number): Link[] {
    return this.links.get(line * 65536 + idx) ?? NONE;
  }

  /**
   * A random spot on a walk (or bike) line between rMin and rMax from (x, z), the busier lines more often;
   * `ok` may turn a spot down (seen from the player, not free). Null when none was found in a few tries.
   */
  sample(x: number, z: number, rMin: number, rMax: number, bikes: boolean, ok: (line: number, s: number, px: number, pz: number) => boolean): { line: number; s: number } | null {
    const grid = bikes ? this.bikeGrid : this.walkGrid;
    const lines = bikes ? this.bikes : this.walks;
    const p: At = { x: 0, z: 0, dx: 0, dz: 0 };
    for (let tries = 0; tries < 24; tries++) {
      // A point in the ring, evenly over its area, then a spot in its cell.
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(rMin * rMin + Math.random() * (rMax * rMax - rMin * rMin));
      const cx = Math.floor((x + Math.cos(a) * r) / CELL);
      const cz = Math.floor((z + Math.sin(a) * r) / CELL);
      const list = grid.get(key(cx, cz));
      if (!list?.length) continue;
      const spot = list[Math.floor(Math.random() * list.length)];
      if (Math.random() * 3 > spot.w) continue;
      const s = Math.max(0.5, Math.min(lines[spot.line].length - 0.5, spot.s + (Math.random() - 0.5) * SPOT_EVERY));
      lines[spot.line].at(s, p);
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < rMin || d > rMax) continue;
      if (!ok(spot.line, s, p.x, p.z)) continue;
      return { line: spot.line, s };
    }
    return null;
  }

  /** The nearest spot on any walk line within `r` m of (x, z), or null. */
  nearestWalk(x: number, z: number, r: number): { line: number; s: number; d: number } | null {
    let best: { line: number; s: number; d: number } | null = null;
    const n = Math.ceil(r / CELL);
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const seen = new Set<number>();
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        for (const spot of this.walkGrid.get(key(cx + i, cz + j)) ?? []) {
          if (seen.has(spot.line)) continue;
          seen.add(spot.line);
          const hit = closest(this.walks[spot.line], x, z);
          if (hit.d < r && (!best || hit.d < best.d)) best = { line: spot.line, s: hit.s, d: hit.d };
        }
      }
    }
    return best;
  }
}

const NONE: Link[] = [];

/** The point of a line nearest (x, z): how far along it and how far off. */
export function closest(l: Line, x: number, z: number): { s: number; d: number } {
  let best = { s: 0, d: Infinity };
  for (let i = 0; i < l.count - 1; i++) {
    const ax = l.x[i];
    const az = l.z[i];
    const ex = l.x[i + 1] - ax;
    const ez = l.z[i + 1] - az;
    const L2 = ex * ex + ez * ez || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2));
    const d = Math.hypot(ax + ex * t - x, az + ez * t - z);
    if (d < best.d) best = { s: l.s[i] + t * Math.sqrt(L2), d };
  }
  return best;
}
