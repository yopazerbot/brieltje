import type { Bounds } from '../../shared/bounds.mjs';
import { bankAt, bankOf, type Bank, type BankPoint } from './bankShape';
import type { DipSpec, Prism, Ring } from './houseData';
import { climb, RoofField } from './roofField';
import { terrain } from './terrain';

/** A dip as the data has it (houseData.ts DipSpec); a pond or ditch has water, and a name. */
type DipLike = { rim: [number, number][]; bottom: [number, number][]; depth: number; low?: number; water?: number; name?: string };

interface Solid {
  /** Switched off, e.g. a broken window */
  off?: boolean;
  /** A shell block's key (Prism.k), for an inside to take its place (World.replaceKeyed) */
  key?: string;
  y0: number;
  y1: number;
  /** On the relief: y0 and y1 are above the ground wherever it is asked about */
  lift?: boolean;
  rings: Ring[];
  name?: string;
  /** Material, e.g. floor_wood (decides the footstep sound) */
  mat?: string;
  /** Never a floor or a ceiling: a tree's trunk (shared/trees.mjs), which stops you but nobody stands on */
  noFloor?: boolean;
  /** Not drawn: a model of ours stands for it, so its top goes no higher than the model's drawn roof (World.capBlock) */
  modelled?: boolean;
  /** Its top as capped once the model's roof is in: one height for the whole block, so it never moves under a body */
  cap?: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** As a car meets it (boxFree `give`), made the first time it is asked */
  brush?: Brush;
  /** A piece a car can break (shared/smash.mjs, world/breakage.ts): its number in the shared list */
  piece?: number;
  /** A part of a broken block (World.split): the block's number */
  partOf?: number;
}

/**
 * A block as a car meets it (world/carDamage.ts: a hedge it may push into): its material and name, how thick it is
 * (m: twice its area over its outline's length, about the width of a long thin block), its middle, and whether a point
 * is in it.
 */
export interface Brush {
  readonly mat?: string;
  readonly name?: string;
  readonly thick: number;
  readonly cx: number;
  readonly cz: number;
  /** A piece a car can break (world/breakage.ts): its number in the shared list (shared/smash.mjs) */
  readonly piece?: number;
  has(x: number, z: number): boolean;
}

function brushOf(s: Solid): Brush {
  if (s.brush) return s.brush;
  const ring = s.rings[0];
  let area = 0;
  let edge = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    edge += Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]);
  }
  const thick = edge > 0 ? Math.abs(area) / edge : 0; // (area/2) * 2 / edge
  return (s.brush = { mat: s.mat, name: s.name, thick, cx: (s.minX + s.maxX) / 2, cz: (s.minZ + s.maxZ) / 2, piece: s.piece, has: (x, z) => inside(x, z, s.rings) });
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
  /** A drawn roof (world/roofField.ts), not a block (a block of the house material `roof` is a block) */
  drawn?: boolean;
}

/** Even-odd test across the outline and its holes. */
function inside(x: number, z: number, rings: Ring[]): boolean {
  // Plain index loops, no destructuring: asked for every metre under every roof at the start, an iterator or a small
  // array per point made hundreds of megabytes of garbage there.
  let hit = false;
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const pi = ring[i];
      const pj = ring[j];
      const xi = pi[0];
      const zi = pi[1];
      const xj = pj[0];
      const zj = pj[1];
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
/**
 * Garden fences (wire mesh on concrete posts, 1.05 or 1.3 m) are low enough to jump over (Yoshi): their block stops
 * at FENCE_HOP over its foot, within a jump's reach (half a metre up, then a half-metre step). Taller fences, walls and
 * hedges keep their height. Only walking changes: the zombies' paths (shared/zombies.mjs) keep the fences whole.
 */
const FENCE_HOP = 0.95;
const FENCE_LOW = 1.4;
const hopOver = (p: Prism): number => (p.m === 'fence' && p.y1 - p.y0 <= FENCE_LOW ? Math.min(p.y1, p.y0 + FENCE_HOP) : p.y1);

const CELL = 16;
const cellOf = (v: number) => Math.floor(v / CELL);
/**
 * Metres over the ground: a drawn roof lower than this is air (world/roofField.ts), so no car, bike, horse, villager or
 * walker goes up an eave that comes down by the ground (a house in a dip, a shed's back on a bank). A metre and a margin
 * for a kerb or paving beside it: a horse on a 0.3 m kerb asks for floors up to 0.9 m over its feet.
 */
const ROOF_LOW = 1.3;
/** Metres: a roof's solid stops a walker only when it reaches more than this into the top of the body (a brush of the hair does not). */
const HEAD_ROOM = 0.15;
/** Metres: a walker steps onto a drawn roof up to this more than its own step (an eave by a terrace, 6 cm over a step). */
const ROOF_STEP = 0.1;
/** Metres over its ground under which a block that stood higher is never capped (World.capBlock): it stays a wall. */
const CAP_LOW = 2.0;
/** Metres over its ground from which a block is a building a roof's solid reaches down to (World.roofHere). */
const BUILDING_OVER = 2.0;
/** The most a body is pushed off a roof's side in one step (m: World.roofPush). */
const PUSH = 0.08;
/** The four sides a body's edge is tried on against a roof (World.roofPush). */
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
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
  private walkingBarriers = new Map<string, Solid>();
  /** Pane number (Prism.glass) -> block number */
  private panes = new Map<number, number>();

  private dips: { rim: Ring; bottom: Ring; depth: number; low: number; bank: Bank | null; minX: number; maxX: number; minZ: number; maxZ: number }[] = [];
  private readonly bankPoint: BankPoint = { y: 0, level: 0, inset: 0 };

  /**
   * The edge of the game (shared/bounds.mjs): the outline nobody walks, rides or drives past (main.ts
   * sets the big one, or the one round the two houses while a game in the house runs), and the
   * ceiling for flying, in metres above the ground under you. Null and Infinity: no edge.
   */
  bounds: Bounds | null = null;
  ceiling = Infinity;

  /**
   * `prisms`: the house's blocks (their numbers are the house data's: broken windows use them). `roofs`: the drawn roofs
   * (world/roofField.ts), a floor from above and solid under, filled as the tiles and models come.
   */
  constructor(prisms: Prism[], private baseGround: number, readonly roofs = new RoofField()) {
    this.addPrisms(prisms);
  }

  /**
   * More blocks after the ones there are (the surroundings, the village); returns the first one's number. `modelled`:
   * those not drawn because a model of ours stands for them (their tops go no higher than its drawn roof).
   */
  addPrisms(prisms: Prism[], modelled?: (p: Prism) => boolean): number {
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
      this.solids.push({ y0: p.y0, y1: hopOver(p), lift: !!p.d, rings: p.p, name: p.n, mat: p.m, key: p.k, noFloor: p.n === 'trunk', modelled: modelled?.(p), minX, maxX, minZ, maxZ });
      if (p.m === 'glass' && Number.isInteger(p.glass)) this.panes.set(p.glass!, index);
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
    if (s.cap !== undefined) return s.cap;
    return s.lift ? s.y1 + terrain.height(x, z) : s.y1;
  }

  /** The lowest a drawn roof counts from at (x, z): ROOF_LOW over the ground (an eave by the ground is no ramp up). */
  private roofLow(x: number, z: number): number {
    return this.baseGround + terrain.height(x, z) + ROOF_LOW;
  }

  /**
   * The building standing at (x, z) for a model's roof over it (world/modelRoofs.ts): the number of the highest block
   * there reaching more than `over` over the ground there, or -1.
   */
  buildingAt(x: number, z: number, over: number): number {
    let best = -1;
    let bestTop = this.baseGround + terrain.height(x, z) + over;
    for (const k of this.at(x, z)) {
      const s = this.solids[k];
      if (s.off || s.noFloor || x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ) continue;
      const top = s.lift ? s.y1 + terrain.height(x, z) : s.y1;
      if (top > bestTop && inside(x, z, s.rings)) [best, bestTop] = [k, top];
    }
    return best;
  }

  /** Whether block `index` is one a model stands for (not drawn), whose top a model's roof may cap. */
  modelledBlock(index: number): boolean {
    const s = this.solids[index];
    return !!s?.modelled && !s.lift;
  }

  /** The blocks a model stands for whose boxes overlap a rectangle on the plan, by number. */
  modelledIn(minX: number, minZ: number, maxX: number, maxZ: number): number[] {
    return this.near(minX, minZ, maxX, maxZ).filter((i) => {
      const s = this.solids[i];
      return s.modelled && !s.lift && !s.off && s.maxX >= minX && s.minX <= maxX && s.maxZ >= minZ && s.minZ <= maxZ;
    });
  }

  /** Block `index`'s corners on the plan and the middle of its box: a block is in a place if any of them is. */
  blockPoints(index: number): [number, number][] {
    const s = this.solids[index];
    return [[(s.minX + s.maxX) / 2, (s.minZ + s.maxZ) / 2], ...s.rings.flat().map((p) => [p[0], p[1]] as [number, number])];
  }

  /** How many metre-wide columns block `index` is looked at in (roofOver). */
  columns(index: number): number {
    const s = this.solids[index];
    return Math.max(0, Math.ceil(s.maxX - s.minX - 0.5));
  }

  /**
   * The lowest of `roof` (a model's own) over block `index`, looked at every metre in its columns `from` to `from + n`
   * (column 0 its corners as well, 5 cm in towards its middle: a narrow block between the grid's points, an eave's lowest
   * corner), or Infinity: capBlock caps it at the lowest of all its columns (world/modelRoofs.ts, a few at a time).
   */
  roofOver(roof: RoofField, index: number, from: number, n: number): number {
    const s = this.solids[index];
    let low = Infinity;
    for (let c = from, x = s.minX + 0.5 + from; c < from + n && x < s.maxX; c++, x += 1) {
      for (let z = s.minZ + 0.5; z < s.maxZ; z += 1) {
        if (inside(x, z, s.rings) && roof.sample(x, z, this.roofLow(x, z))) low = Math.min(low, roof.top);
      }
    }
    if (from > 0) return low;
    const [mx, mz] = [(s.minX + s.maxX) / 2, (s.minZ + s.maxZ) / 2];
    for (const ring of s.rings) {
      for (const [px, pz] of ring) {
        const d = Math.hypot(mx - px, mz - pz) || 1;
        const x = px + ((mx - px) / d) * 0.05, z = pz + ((mz - pz) / d) * 0.05;
        if (roof.sample(x, z, this.roofLow(x, z))) low = Math.min(low, roof.top);
      }
    }
    return low;
  }

  /** Block `index`'s top as it stands: capped, or its own; NaN if switched off (gone for standing over the roof). */
  blockTopOf(index: number): number {
    const s = this.solids[index];
    return s.off ? NaN : (s.cap ?? s.y1);
  }

  /**
   * Cap a block a model stands for at `y`: the lowest of the model's drawn roof over it (world/modelRoofs.ts), set
   * once that roof is in. One height for the whole block, never raised, so a block never changes height under a body
   * (a top that followed the roof under each point threw a body stepping off a low roof inside the block).
   */
  capBlock(index: number, y: number): void {
    const s = this.solids[index];
    if (!s?.modelled || s.lift) return;
    // A block standing on its ground that stood over CAP_LOW stays at least that high: a wall a walker does not get onto
    // (not a lid, whose bottom is up on the house).
    const ground = this.baseGround + Math.max(...this.blockPoints(index).map(([x, z]) => terrain.height(x, z))); // its highest corner
    if (s.y0 < ground + 0.5) y = Math.max(y, Math.min(s.y1, ground + CAP_LOW));
    if (!(y < Math.min(s.y1, s.cap ?? Infinity))) return;
    // Wholly over the roof (a lid stacked on a lower block): gone, so no floor stands on air there.
    if (y <= s.y0 + 0.01) s.off = true;
    else s.cap = y;
  }

  /** Switch a block (by its number in the house data) off or back on: broken windows. */
  setSolid(index: number, on: boolean): void {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= this.solids.length) return;
    const s = this.solids[index];
    if (s) s.off = !on;
  }

  /** Switch a house pane (by its number, Prism.glass) off or back on: a broken window. */
  setPane(number: number, on: boolean): void {
    const index = this.panes.get(number);
    if (index !== undefined) this.setSolid(index, on);
  }

  /** Mark block `index` as piece `piece` a car can break (world/breakage.ts): a Brush of it says so. */
  tagPiece(index: number, piece: number): void {
    const s = this.solids[index];
    if (!s) return;
    s.piece = piece;
    s.brush = undefined;
  }

  /**
   * Block `index` broken (world/breakage.ts): it goes, and what stands of it (`rings`, on the plan) takes its place, as
   * blocks of the same material, heights and piece. Returns the parts' numbers, for `unsplit`.
   */
  split(index: number, rings: Ring[]): number[] {
    const s = this.solids[index];
    if (!s) return [];
    s.off = true;
    if (!rings.length) return [];
    const first = this.addPrisms(rings.map((ring) => ({ m: s.mat ?? '', y0: s.y0, y1: s.y1, p: [ring], n: s.name, d: s.lift ? 1 : undefined }) as Prism));
    const parts = rings.map((_, i) => first + i);
    for (const k of parts) {
      this.solids[k].piece = s.piece;
      this.solids[k].partOf = index;
    }
    return parts;
  }

  /** Block `index` whole again: its parts (`split`) gone from the grid for good, itself back. */
  unsplit(index: number, parts: number[]): void {
    for (const k of parts) {
      const s = this.solids[k];
      if (!s || s.partOf !== index) continue;
      s.off = true;
      for (let i = cellOf(s.minX); i <= cellOf(s.maxX); i++) {
        for (let j = cellOf(s.minZ); j <= cellOf(s.maxZ); j++) {
          const list = this.grid.get(cellKey(i, j));
          const at = list?.indexOf(k) ?? -1;
          if (at >= 0) list!.splice(at, 1);
        }
      }
    }
    const s = this.solids[index];
    if (s) s.off = false;
  }

  /** Switch off the shell blocks with these keys: an inside brings blocks of its own in their place. */
  replaceKeyed(keys: string[]): void {
    for (const s of this.solids) if (s.key !== undefined && keys.includes(s.key)) s.off = true;
  }

  /** Set (or with null, remove) a moving solid: a flat outline between two heights. */
  setMoving(key: string, ring: Ring | null, y0 = 0, y1 = 0, walkingOnly = false): void {
    const solids = walkingOnly ? this.walkingBarriers : this.moving;
    if (!ring) {
      solids.delete(key);
      return;
    }
    const xs = ring.map((v) => v[0]);
    const zs = ring.map((v) => v[1]);
    solids.set(key, { y0, y1, rings: [ring], minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) });
  }

  /** Lowest underside between fromY and toY above a circle at (x, z), or null when the way up is clear. */
  ceilingAbove(x: number, z: number, radius: number, fromY: number, toY: number): number | null {
    let best: number | null = null;
    for (const k of this.near(x - radius, z - radius, x + radius, z + radius)) {
      const s = this.solids[k];
      if (s.off || s.noFloor || x + radius < s.minX || x - radius > s.maxX || z + radius < s.minZ || z - radius > s.maxZ) continue;
      const under = this.lo(s, x, z);
      if (under < fromY - 0.02 || under > toY) continue;
      const [cx, cz] = closestOnRings(x, z, s.rings);
      if (inside(x, z, s.rings) || Math.hypot(x - cx, z - cz) < radius * 0.7) {
        if (best === null || under < best) best = under;
      }
    }
    // Under a building's roof: what is solid under it (an open slab, an overhang's or a shelter's, the head passes).
    const r = this.roofs;
    if (this.roofHere(x, z) && !r.open && r.bottom >= fromY - 0.02 && r.bottom <= toY && (best === null || r.bottom < best)) best = r.bottom;
    return best;
  }

  /** Dips in the ground (the garden's wadi). */
  setDips(dips: DipLike[]): void {
    this.dips = [];
    this.addDips(dips);
  }

  /** More dips (the village's ponds). */
  addDips(dips: DipLike[]): void {
    this.dips = this.dips.concat(dips.map((d) => {
      const xs = d.rim.map((v) => v[0]);
      const zs = d.rim.map((v) => v[1]);
      // A pond's or ditch's banks: walked as drawn (world/bankShape.ts).
      const bank = d.water && d.name ? bankOf(d as DipSpec, this.baseGround, terrain.height) : null;
      return { rim: d.rim, bottom: d.bottom, depth: d.depth, low: d.low ?? 0, bank, minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
    }));
  }

  /**
   * The bare ground: the relief (flat round the plot), except in a dip: a pond's or ditch's banks as drawn, or a dry
   * dip's sides sloping 1:1 down to its flat bottom, `depth` below the lowest ground round its rim.
   */
  private baseAt(x: number, z: number): number {
    const ground = this.baseGround + terrain.height(x, z);
    for (const d of this.dips) {
      if (x < d.minX || x > d.maxX || z < d.minZ || z > d.maxZ || !inside(x, z, [d.rim])) continue;
      if (d.bank) return bankAt(d.bank, x, z, this.bankPoint)?.y ?? ground; // just on the rim: the relief
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
      if (s.off || s.noFloor || x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ) continue;
      const top = this.hi(s, x, z);
      if (top > feet + stepUp || top <= g.y) continue;
      if (inside(x, z, s.rings)) {
        g.y = top;
        g.name = s.name;
        g.mat = s.mat;
      }
    }
    // A drawn roof (world/roofField.ts) within a step. Asked from below one (feet inside its solid, a helicopter's hub
    // under it), the floor under is the answer: the way out of a roof is the player's own (World.roofOut).
    const r = this.roofs;
    if (r.sample(x, z, this.roofLow(x, z)) && r.top <= feet + stepUp && r.top > g.y) {
      g.y = r.top;
      g.name = undefined;
      g.mat = 'roof';
      g.drawn = true;
    }
    return g;
  }

  /**
   * The way out for a body whose feet are inside a roof's solid at (x, z) (put there, or a model's roof came in round
   * it): that roof's surface, where the solid is one that would stop it walking in (a building's roof, a chimney);
   * else null. Under a roof that does not stop a walker (an overhang over open ground) the body stays on its own floor.
   */
  roofOut(x: number, z: number, feet: number, stepUp: number): number | null {
    const r = this.roofs;
    if (!this.roofHere(x, z) || r.open || r.top <= feet + stepUp || feet < r.bottom - 0.01) return null;
    const top = r.top;
    return r.closed || this.walled(x, z, r.bottom) ? top : null;
  }

  /**
   * Whether a drawn roof stops a body (feet to feet + height) whose middle walks to (x, z): a roof more than a step up
   * with its solid in the body's height (a gable rising over a lower roof, a dormer, a chimney, a low eave). Slopes,
   * ridges and valleys are walked. world/roofField.ts.
   */
  roofBlocks(x: number, z: number, feet: number, stepUp: number, height: number): boolean {
    const r = this.roofs;
    return this.roofHere(x, z) && !r.open && r.top > feet + stepUp + ROOF_STEP && r.bottom < feet + height - HEAD_ROOM && (r.closed || this.walled(x, z, r.bottom));
  }

  /**
   * Sample the drawn roofs at (x, z) (`roofs` holds the answer), a solid reaching down to the top of the building under
   * that very point as well: a roof's triangle takes its depth from the buildings under its corners, and a lower block
   * (an annex, the house under a model's thick walls) can lie under its middle. A slab over a building is solid to it.
   */
  private roofHere(x: number, z: number): boolean {
    const r = this.roofs;
    if (!r.sample(x, z, this.roofLow(x, z))) return false;
    const list = this.at(x, z);
    const here = (s: Solid) => !s.off && !s.noFloor && x >= s.minX && x <= s.maxX && z >= s.minZ && z <= s.maxZ && inside(x, z, s.rings);
    // Down through the blocks hanging from the solid (an upper storey's block over a lower one capped under it).
    let from = r.bottom;
    for (let more = true; more; ) {
      more = false;
      for (const k of list) {
        const s = this.solids[k];
        if (this.hi(s, x, z) >= from - 0.01 && this.lo(s, x, z) < from - 0.01 && here(s)) {
          from = this.lo(s, x, z);
          more = true;
        }
      }
    }
    // The floor under those.
    let best = -Infinity;
    let capped = false;
    for (const k of list) {
      const s = this.solids[k];
      const top = this.hi(s, x, z);
      if (top <= from + 0.01 && top > best && here(s)) [best, capped] = [top, s.cap !== undefined];
    }
    // A building: a block a model's roof capped (whatever its height), or one reaching BUILDING_OVER over the ground.
    if (best < r.bottom && (capped || best > this.baseGround + terrain.height(x, z) + BUILDING_OVER)) {
      r.bottom = best;
      r.open = false; // a slab over a building after all (its corners stood past the walls)
    }
    return true;
  }

  /**
   * Whether a wall stands under a roof's solid at (x, z): a block there reaching up to within 0.3 m of it (`bottom`). A
   * roof stops a walker from the side only as part of a closed building; over open ground (outside its walls, a
   * recess, a car port) the head passes, as when roofs were drawn only.
   */
  private walled(x: number, z: number, bottom: number): boolean {
    for (const k of this.at(x, z)) {
      const s = this.solids[k];
      if (s.off || s.noFloor || x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ) continue;
      if (this.hi(s, x, z) >= bottom - 0.3 && this.lo(s, x, z) <= bottom && inside(x, z, s.rings)) return true;
    }
    return false;
  }

  /**
   * The slope of the drawn roof at (x, z), in degrees (0 flat), or null where none (a helicopter refuses a steep one).
   * Its normal, if wanted: (-gx, 1, -gz) normalised, from `roofs.gx` and `roofs.gz` after this call.
   */
  roofSlope(x: number, z: number): number | null {
    return this.roofs.slope(x, z, this.roofLow(x, z));
  }

  /**
   * The part of a step (dx, dz) from (x, z) a body standing on a roof takes, into `out`: the part along the roof's
   * contour (level along it: in a valley, round a ridge) and down it whole, the part straight up it cut by the roof's own
   * steepest slope: full pace to 35 degrees, less and less up to 60, none steeper (world/roofField.ts climb), whatever
   * the way of the step, so no zigzag or walk across climbs a steep roof faster than straight up. Off the roofs, whole.
   */
  roofStep(x: number, z: number, dx: number, dz: number, out: { x: number; z: number }): { x: number; z: number } {
    out.x = dx;
    out.z = dz;
    const r = this.roofs;
    if (Math.hypot(dx, dz) < 1e-9 || !r.sample(x, z, this.roofLow(x, z))) return out;
    const steepest = Math.hypot(r.gx, r.gz);
    if (steepest < 1e-6) return out;
    const ux = r.gx / steepest, uz = r.gz / steepest; // straight up the roof
    const up = dx * ux + dz * uz;
    if (up <= 0) return out;
    const lose = up * (1 - climb(steepest));
    out.x = dx - ux * lose;
    out.z = dz - uz * lose;
    return out;
  }

  /**
   * Push a circle (the body) off the sides of drawn roofs rising more than a step and a half beside it, as `resolve`
   * does off blocks, but gently: its edge, tried on four sides, backs off 2 cm at a time, at most PUSH a step (a body
   * standing against a gable is eased off it over a few steps, never thrown). True when it pushed.
   */
  roofPush(pos: { x: number; z: number }, feet: number, radius: number, stepUp: number, height: number): boolean {
    let moved = 0;
    if (this.roofBlocks(pos.x, pos.z, feet, stepUp, height)) return false; // inside one already: lifted out, not pushed
    for (const [dx, dz] of SIDES) {
      while (moved < PUSH && this.roofBlocks(pos.x + dx * radius, pos.z + dz * radius, feet, stepUp + 0.5 - ROOF_STEP, height)) { // a step and a half, as ever
        // Never with its middle into a block (a lower block beside a valley between roofs): there it stays.
        if (this.touching(pos.x - dx * 0.02, pos.z - dz * 0.02, feet + stepUp, feet + height, 0) !== null) break;
        pos.x -= dx * 0.02;
        pos.z -= dz * 0.02;
        moved += 0.02;
      }
    }
    return moved > 0;
  }

  /**
   * A small ball (radius r) moving from a to b: the block it runs into (its number in the
   * house data; -1 the ground, -2 a moving part, -3 a drawn roof) and the outward side it hits, or null.
   * A top counts when the ball came from above, an underside from below, otherwise the
   * side of the outline nearest to where it came from.
   */
  collide(a: Point, b: Point, r: number, fixedOnly = false): { index: number; nx: number; ny: number; nz: number } | null {
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
    // A drawn roof (-3): its slope from above, its underside from below, else the way the ball came.
    const roof = this.roofs;
    if (this.roofHere(b.x, b.z) && b.y - r < roof.top && b.y + r > roof.bottom) {
      const { top, bottom, gx, gz } = roof;
      if (a.y - r >= top + gx * (a.x - b.x) + gz * (a.z - b.z) - 1e-4) {
        const n = Math.hypot(gx, 1, gz);
        return { index: -3, nx: -gx / n, ny: 1 / n, nz: -gz / n };
      }
      if (a.y + r <= bottom + 1e-4) return { index: -3, nx: 0, ny: -1, nz: 0 };
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d > 1e-6) return { index: -3, nx: (a.x - b.x) / d, ny: 0, nz: (a.z - b.z) / d };
      return { index: -3, nx: 0, ny: 1, nz: 0 };
    }
    if (fixedOnly) return null; // the street's loose things (world/looseProps.ts): not trapped in the car that hit them
    for (const s of this.moving.values()) {
      const hit = test(s, -2);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * What stands at a spot on the plan between two heights, within `r` of (x, z): its material and name,
   * or the key of a moving part (a car: car-<id>; not `skip`, the car asking). Null for nothing. For how a crash looks and sounds.
   */
  touching(x: number, z: number, y0: number, y1: number, r: number, skip?: string): { mat?: string; name?: string; key?: string } | null {
    const test = (s: Solid) => {
      if (s.off || x + r < s.minX || x - r > s.maxX || z + r < s.minZ || z - r > s.maxZ) return false;
      if (this.hi(s, x, z) <= y0 || this.lo(s, x, z) >= y1) return false;
      if (inside(x, z, s.rings)) return true;
      const [cx, cz] = closestOnRings(x, z, s.rings);
      return Math.hypot(x - cx, z - cz) < r;
    };
    for (const [key, s] of this.moving) if (key !== skip && test(s)) return { key };
    for (const i of this.near(x - r, z - r, x + r, z + r)) {
      const s = this.solids[i];
      if (test(s)) return { mat: s.mat, name: s.name };
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
   * itself) doesn't count. A fixed block that `give` lets in (a hedge, world/carDamage.ts) doesn't stop it either: it
   * goes into `met`.
   */
  boxFree(cx: number, cz: number, yaw: number, halfL: number, halfW: number, y0: number, y1: number, skip?: string, give?: (b: Brush) => boolean, met?: Brush[]): boolean {
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
    for (const i of this.near(minX, minZ, maxX, maxZ)) {
      const s = this.solids[i];
      if (!hits(s)) continue;
      if (!give?.(brushOf(s))) return false;
      met?.push(brushOf(s));
    }
    for (const [key, s] of this.moving) if (key !== skip && hits(s)) return false;
    return true;
  }

  /**
   * How far from a towards b (0..1) the way is clear, checked every 20 cm: the car's camera stays out of walls. A block
   * that `give` lets through (the hedge a car is pushing through, world/carDamage.ts) doesn't count.
   */
  clearance(a: Point, b: Point, skip?: string, give?: (b: Brush) => boolean): number {
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const moving = [...this.moving].filter(([key]) => key !== skip).map(([, s]) => s);
    const hit = (s: Solid, x: number, y: number, z: number) =>
      !(s.off || x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ || y <= this.lo(s, x, z) || y >= this.hi(s, x, z)) && inside(x, z, s.rings) && !give?.(brushOf(s));
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
    const moving = [...this.moving.values(), ...this.walkingBarriers.values()];
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
