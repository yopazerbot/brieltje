// Types for cats.mjs (the cats' walks, shared with the server).

/** shared/cats.json */
export interface CatData {
  respawnSeconds: number;
  speed: number;
  pause: number;
  /** Each cat's loop: its corners as [x, z] */
  cats: number[][][];
}

export const CAT_SLACK: number;

export function catWalk(cats: CatData, i: number, t: number): { x: number; z: number; heading: number; walking: boolean };

export function catWithin(cats: CatData, i: number, t: number, x: number, y: number, z: number, reach: number, floor: (x: number, z: number) => number): boolean;
