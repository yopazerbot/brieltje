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
}
export const HOME_ID: RegExp;
export const HOMES: Home[];
export const WALK_IN_GLASS: number;
export const DOOR_GLASS: number;
export const END_DOOR_GLASS: number;
export const PANE_LIMIT: number;
export function registerDoors(home: string, ids: string[]): void;
export function findHome(id: unknown, list?: Home[]): Home | null;
export function homeAt(x: number, z: number, y: number): string | null;
export function bandsOf(id: string): Band[];
export function distanceToHome(id: string, x: number, z: number, y0?: number, y1?: number): number;
export function homeOfDoor(id: unknown): string | null;
export function makePaneHomes(data: { prisms: { m?: string; y0?: number; y1?: number; glass?: number; p?: number[][][] }[]; doors: { id: string; panels?: { glass?: boolean; glassNo?: number }[] }[] }): ((i: number) => string | null) & { has(i: number): boolean };
export function inEndGarden(x: number, z: number, y: number): boolean;
export function barrierHeights(y0: number, y1: number, stepUp: number, height: number): [number, number];
