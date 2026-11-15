export const PUBLIC_WALK_INS: Record<'keet', { glass: number; doorGlass: number; size: number }>;
export const KEET_DOOR: RegExp;
export interface KeetDoor {
  id: string;
  name: string;
  open: boolean;
  y0: number;
  y1: number;
  panels: { a: [number, number]; b: [number, number]; glass?: boolean; glassNo?: number; [k: string]: unknown }[];
}
export interface KeetPrism {
  m: string;
  y0: number;
  y1: number;
  p: [number, number][][];
  n?: string;
  glass?: number;
}
export interface Keet {
  outline: [number, number][];
  /** Whether (x, z) lies inside the café's outline */
  contains(x: number, z: number): boolean;
  floor: number;
  doors: KeetDoor[];
  prisms: KeetPrism[];
  area: { minX: number; maxX: number; minZ: number; maxZ: number };
  doorIds: Set<string>;
  panes: number[];
  publicPane(i: unknown): boolean;
  spots: { name: string; x: number; z: number; y: number }[];
}
export function makeKeet(shell: unknown, rooms: unknown): Keet;
