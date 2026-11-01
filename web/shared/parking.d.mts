/** A rectangle seen from above: its middle, heading (the game's yaw), half length and half width. */
export interface Box {
  x: number;
  z: number;
  yaw: number;
  halfL: number;
  halfW: number;
}

export function boxCorners(cx: number, cz: number, yaw: number, halfL: number, halfW: number): [number, number][];
export function boxPoints(cx: number, cz: number, yaw: number, halfL: number, halfW: number, step?: number, inset?: number): [number, number][];
export function boxesOverlap(p: Box, q: Box, gap?: number): boolean;
export function boxDistance(box: Box, x: number, z: number): number;
export function clearOfPortals(box: Box, portals: readonly { x: number; z: number; out: readonly number[]; car: readonly number[] }[], reach: number): boolean;
export function makeSolids(
  prisms: { y0: number; y1: number; d?: unknown; p: number[][][] }[],
  height: (x: number, z: number) => number,
): { boxFree(cx: number, cz: number, yaw: number, halfL: number, halfW: number, y0: number, y1: number): boolean };
export function makeIndoors(prisms: { n?: string; p: number[][][] }[], rooms: string[]): (x: number, z: number) => boolean;
