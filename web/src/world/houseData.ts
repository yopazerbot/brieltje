import raw from '../data/house.json';

/** A closed outline on the floor plan: [x, z] points in metres. */
export type Ring = [number, number][];

/**
 * One solid block: an outline (first ring, then any holes) extruded from y0 to y1.
 * The same blocks are used for drawing and for collision.
 */
export interface Prism {
  m: string;
  y0: number;
  y1: number;
  p: Ring[];
  n?: string;
  /** Frosted glass (bathroom, front door side panel) */
  matte?: boolean;
  /**
   * Out on the relief (a ground cover, hedge or fence): y0 and y1 are above the ground there, and
   * the browser cuts the shape along a grid of this many metres and lifts each corner onto it.
   */
  d?: number;
  /** Part of a landmark (the church), so a model can take its place */
  lm?: string;
  /** A field's crop as the farmers declare it this year (tools/crops.py), drawn in its rows (world/fields.ts) */
  c?: string;
  /** A field's rows: their direction (degrees from the x axis) and a number of its own (0 to 99), the same for all its pieces */
  r?: [number, number];
}

export interface Level {
  id: string;
  name: string;
  floor: number;
  ceiling: number;
}

export interface Room {
  level: string;
  name: string;
  /** Outline, then any holes */
  p: Ring[];
}

export interface DoorPanel {
  a: [number, number];
  b: [number, number];
  /** Shift sideways from the line a-b, in metres */
  offset: number;
  thickness: number;
  glass: boolean;
  /** How far the panel moves when the door is fully open (x, z); none for a fixed panel */
  slide?: [number, number];
  /** Swinging leaf: hinged at a, turns this many radians when fully open (sign: which side) */
  swing?: number;
  /** Outside door: which face is outside (1: the side the normal of a-b points to), brown there */
  outside?: 1 | -1;
  /** Frosted glass */
  matte?: boolean;
  /** Colour of a solid leaf, or of a glass leaf's frame (default white leaf, grey/brown frame) */
  color?: string;
  /** false: no handle (a flush pull) */
  handle?: boolean;
  /** A solid leaf in one of the house's surfaces (e.g. 'oak'), to match the joinery round it */
  surface?: string;
}

/** A shallow basin in the ground: the rim at ground level, the flat bottom `depth` lower, sloping sides between. */
export interface DipSpec {
  name: string;
  rim: [number, number][];
  bottom: [number, number][];
  depth: number;
  /** Water in it (a pond, a ditch), this far below the ground */
  water?: number;
  /** On the relief: the lowest ground round its rim (m above the flat ground); its bottom and water are measured from there */
  low?: number;
}

/** Built-in furniture (tools/old_house.py): drawn like the planner's pieces, at its own size, not movable. */
export interface FixtureSpec {
  item: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  size: [number, number, number];
}

/** A fixed model in the house (web/public/models/<model>.glb), its front facing +z before the turn. */
export interface PropSpec {
  model: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Blocks the way (its outline on the floor) */
  solid?: boolean;
  /** What a bullet hit on it looks and sounds like (a house material) */
  hit?: string;
}

export interface DoorSpec {
  id: string;
  name: string;
  level: string;
  y0: number;
  y1: number;
  panels: DoorPanel[];
  /** Standing open at the start (inside doors) */
  open?: boolean;
  /** Double-action: swings either way, away from whoever opens it */
  both?: boolean;
}

/** Around the plot (Flemish open data): pitched roofs of neighbouring houses and trees. */
/** Roof over a rectangle (4 corners): eaves at y, ridge along the long side at `ridge`. */
export interface RoofSpec {
  p: [number, number][];
  y: number;
  ridge: number;
  /**
   * gable (default): ridge along p[0]-p[1], gables at both ends. hip: the ends slope too. shed:
   * one slope, low at p[0]-p[1] (height y), high at p[3]-p[2] (height ridge), walls up to it.
   */
  shape?: 'gable' | 'hip' | 'shed';
  /** The corners are in order (p[0]-p[1] along the ridge, or the low side): don't turn them */
  fixed?: boolean;
  tiles?: string;
  gable?: string;
  /** Material of the walls below: the gables are drawn in the same brick */
  wall?: string;
  /** Colour of the underside (a room under the roof); without it both sides look the same */
  ceiling?: string;
  /** Ground under the walls, for the downpipes (default: 2.7 m below the eaves) */
  base?: number;
  /** Colour of the gutters and downpipes (default zinc grey) */
  gutter?: string;
  /**
   * Roof windows, in metres: `a` along the ridge from p[0] towards p[1], `b` across from the
   * p[0]-p[1] side (then p[0]-p[1] must be a long side as given).
   */
  windows?: { a: [number, number]; b: [number, number] }[];
  /** Windows in a gable: end 0 at p[0]-p[3], end 1 at p[1]-p[2]; `b` across, `y` heights */
  gableWindows?: { end: 0 | 1; b: [number, number]; y: [number, number] }[];
  /** Upright panels from a to b, y0 up to a sloping top (ya at a, yb at b), in the ceiling colour */
  panels?: { a: [number, number]; b: [number, number]; y0: number; ya: number; yb: number }[];
  /** Part of a landmark (the church) */
  lm?: string;
}

/**
 * A window ('w'), door ('d') or garage door ('g') on a neighbour's wall, from a to b on the
 * plan, facing n, between heights y; frame colour f, door colour c (tools/facades.py).
 */
export interface Opening {
  a: [number, number];
  b: [number, number];
  n: [number, number];
  y: [number, number];
  k: 'w' | 'd' | 'g';
  f: string;
  c?: string;
}

export interface Surroundings {
  roofs: RoofSpec[];
  /** Tree at (x, z) standing at y: height h, crown radius r */
  trees: { x: number; z: number; y: number; h: number; r: number }[];
  openings?: Opening[];
  /** Fence posts: x, z and height */
  posts?: [number, number, number][];
  /** Poles along the road (the poles themselves are prisms): the ground at their foot, lamp arm direction towards the road */
  /**
   * In Smetlede's centre `k`: a street lamp on a steel post (post), the striped one at the school's gate, or
   * a dark green lantern by the church tower; no cables to those.
   */
  poles?: { x: number; z: number; y?: number; arm: [number, number]; k?: 'post' | 'striped' | 'lantern' }[];
  /** Cables between poles: pairs of indices into `poles` */
  wires?: [number, number][];
  /** Solar panel arrays: corners (x, y, z) and how many panels across and up */
  solar?: { q: [number, number, number][]; n: [number, number]; flat?: boolean }[];
  /** The surroundings' blocks (walls, ground covers, hedges, fences), apart from the house's */
  prisms?: Prism[];
  /** The gardens mown in stripes and the meadows, for the grass (world/groundShade.ts) */
  grass?: GrassData;
}

/** The gardens mown in stripes and the meadows (tools/street.py). */
export interface GrassData {
  /** A garden's outline, its stripes' direction (degrees from the x axis) and width (m) */
  lawns: { a: number; w: number; p: Ring[] }[];
  /** Declared grassland, or fallow left alone (`k`: grass or fallow; rougher) */
  meadows: { k: string; p: Ring[] }[];
}

/**
 * A landmark built from the open data for now (the church): its GRB outline, the ground in its
 * middle and under its lowest corner, and its tower. Its blocks and roofs carry `lm`.
 */
export interface Landmark {
  name: string;
  p: [number, number][];
  base: number;
  ground: number;
  tower?: { p: [number, number][]; top: number; peak: number } | null;
}

/**
 * The village and the band to it (web/src/data/village.json), loaded once the start screen is up.
 * Its poles' numbers carry on after the ring's; its cables may join a pole of either.
 */
export interface VillageData extends Surroundings {
  dips: DipSpec[];
  groundCuts: { cells: number[]; tris: number[] };
  landmarks?: Landmark[];
  /** The outline of the area the world is built in (tools/neighbours.py's zone): the big map mutes what lies outside */
  area?: [number, number][];
}

export interface HouseData {
  source: string;
  levels: Level[];
  ground: number;
  spawn: { x: number; z: number; yaw: number };
  sun?: { dir: number[] };
  rooms: Room[];
  doors: DoorSpec[];
  props?: PropSpec[];
  fixtures?: FixtureSpec[];
  /** Dips in the ground (the garden's wadi): rim and bottom outlines with as many points each */
  dips?: DipSpec[];
  /** Where the dips cut the relief's ground (see world/terrain.ts) */
  groundCuts?: { cells: number[]; tris: number[] };
  surroundings?: Surroundings;
  prisms: Prism[];
}

export const house = raw as unknown as HouseData;
