// Types for trees.mjs (the trees' trunks as blocks).
import type { Prism } from '../src/world/houseData';

/** A tree as the data has it: where it stands (y: its foot, in the game's heights), how tall it is and its crown's radius (m) */
export interface TreeSpot {
  x: number;
  y: number;
  z: number;
  h: number;
  r?: number;
}
export const ZOMBIE_TRUNK_TOP: number;
export function trunkRadius(h: number): number;
export function trunkHeight(t: TreeSpot): number;
export function trunkPrisms(trees: readonly TreeSpot[], top?: number): Prism[];
export function zombieTrunks(trees: readonly TreeSpot[], box: { minX: number; maxX: number; minZ: number; maxZ: number }): Prism[];
