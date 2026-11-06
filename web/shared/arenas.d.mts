// Types for arenas.mjs (where the Zombies game is played, shared with the server).

import type { Bounds } from './bounds.mjs';

export interface Arena {
  id: string;
  /** At home: where the horde heads with nobody to chase */
  home?: [number, number];
  /** In Smetlede: the middle of its circle and its radius (m) */
  center?: [number, number];
  radius?: number;
}

export const ARENAS: Arena[];
export function arenaOf(id: string | undefined | null): Arena;
export function portalOf(a: Arena): { id: string; name: string; x: number; z: number; yaw: number; out: number[]; car: number[] } | undefined;
export function arenaEdge(a: Arena, edges: { map: Bounds; party: Bounds }): Bounds;
export function arenaHome(a: Arena): { x: number; z: number };
export function arenaPrisms<P extends { p: number[][][] }>(prisms: P[], edge: Bounds): P[];
