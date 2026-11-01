export interface BoundsData {
  /** Metres above the ground under you: the highest you can fly */
  ceiling: number;
  /** The outline for normal play, model [x, z] */
  map: number[][];
  /** The outline while a game in the house runs */
  party: number[][];
}

export interface EdgePoint {
  x: number;
  z: number;
  /** How far from the point asked about */
  d: number;
  /** The edge's inward direction */
  nx: number;
  nz: number;
}

export interface Bounds {
  ring: number[][];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  inside(x: number, z: number): boolean;
  /** The nearest point on the edge within `reach` m (every edge when Infinity), or null. */
  nearest(x: number, z: number, reach?: number): EdgePoint | null;
  /** Metres from the edge: positive inside, negative outside. */
  depth(x: number, z: number): number;
  /** Keep a circle of radius r (at most 4 m) inside, at least r from the edge, moving `pos`; true when it moved. */
  keepIn(pos: { x: number; z: number }, r: number): boolean;
  /** Whether a rectangle (middle, heading as the game's yaw, half length, half width) has its corners inside. */
  boxInside(cx: number, cz: number, yaw: number, halfL: number, halfW: number): boolean;
  /** A point outside put on the nearest point `margin` m inside; null when none was found. */
  putBack(x: number, z: number, margin?: number): { x: number; z: number; moved: boolean } | null;
}

export function makeBounds(ring: number[][]): Bounds;
export function loadBounds(data: BoundsData): { map: Bounds; party: Bounds; ceiling: number };
