export interface Band {
  ring: [number, number][];
  y0: number;
  y1: number;
  box: [number, number, number, number];
}
export interface Home {
  id: string;
  bands: Band[];
  box: [number, number, number, number];
  /** Where a home without a portal puts out whoever has no right to it: [x, z, yaw] */
  out?: [number, number, number];
}
export const HOME_ID: RegExp;
export const HOMES: Home[];
/** The end house's garden: its lawn's ring and height */
export const END_GARDEN: { y: number; ring: [number, number][] };
export const WALK_IN_GLASS: number;
export const DOOR_GLASS: number;
export const END_DOOR_GLASS: number;
export const PANE_LIMIT: number;
/** The houses walked into: their windows' and door glass's first numbers, each range `size` long */
export const WALK_INS: Record<'molenhoek_end' | 'kapellenhoek_home', { glass: number; doorGlass: number; size: number }>;
export function registerDoors(home: string, ids: string[]): void;
export function findHome(id: unknown, list?: Home[]): Home | null;
export function homeAt(x: number, z: number, y: number): string | null;
export function bandsOf(id: string): Band[];
export function distanceToHome(id: string, x: number, z: number, y0?: number, y1?: number): number;
export function homeOfDoor(id: unknown): string | null;
export function makePaneHomes(data: { prisms: { m?: string; y0?: number; y1?: number; glass?: number; p?: number[][][] }[]; doors: { id: string; panels?: { glass?: boolean; glassNo?: number }[] }[] }): ((i: number) => string | null) & { has(i: number): boolean };
export function inEndGarden(x: number, z: number, y: number): boolean;
export function barrierHeights(y0: number, y1: number, stepUp: number, height: number): [number, number];
