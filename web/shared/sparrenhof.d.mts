// Types for sparrenhof.mjs (the café Sparrenhof's blocks and stairs, and the wood round it).
import type { Prism } from '../src/world/houseData';
import type { Area, Spot } from './zombies.mjs';

type Point = { x: number; y: number; z: number };
export interface Cafe {
  prisms: Prism[];
  /** The café's outlines on the plan: the open data's standing blocks in them make way for its own */
  outlines: number[][][];
  clear: number[][][];
  area: Area;
  stairs: { id: string; foot: Point; top: Point; risers: number; rise: number; going: number }[];
  roofs: { id: string; at: Point }[];
}
export function makeCafe(data: unknown, ground: number): Cafe;
export function cafePrisms(prisms: Prism[], cafe: Cafe): Prism[];
export function woodTrunks(trees: { x: number; z: number }[], cafe: Cafe, box: { minX: number; maxX: number; minZ: number; maxZ: number }): Prism[];
export const WOOD_DEPTH: number;
export function woodSpots(spots: Spot[], prisms: Prism[], cafe: Cafe): (Spot & { wood: true })[];
