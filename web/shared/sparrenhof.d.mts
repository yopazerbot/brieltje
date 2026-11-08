// Types for sparrenhof.mjs (the café Sparrenhof's blocks and stairs, the tree huts, and the wood round it).
import type { Prism } from '../src/world/houseData';
import type { Area, Spot } from './zombies.mjs';

type Point = { x: number; y: number; z: number };
type Stair = { id: string; foot: Point; top: Point; risers: number; rise: number; going: number };
/** A tree hut in the wood (tools/tree_huts.py): its trees, floors (the platform first), stairs, finer grid and footprint */
export interface TreeHut {
  id: string;
  trees: number[][];
  floors: Point[];
  stairs: Stair[];
  area: Area;
  footprint: number[][];
}
export interface Cafe {
  prisms: Prism[];
  /** The café's outlines on the plan: the open data's standing blocks in them make way for its own */
  outlines: number[][][];
  clear: number[][][];
  area: Area;
  /** The zombies' finer grids: the café's, then each hut's */
  areas: Area[];
  stairs: Stair[];
  roofs: { id: string; at: Point }[];
  huts: TreeHut[];
}
export function makeCafe(data: unknown, ground: number, huts?: unknown): Cafe;
export function cafePrisms(prisms: Prism[], cafe: Cafe): Prism[];
export function woodTrunks(trees: { x: number; z: number }[], cafe: Cafe, box: { minX: number; maxX: number; minZ: number; maxZ: number }): Prism[];
export const WOOD_DEPTH: number;
export const HUT_KEEP: number;
export function woodSpots(spots: Spot[], prisms: Prism[], cafe: Cafe): (Spot & { wood: true })[];
