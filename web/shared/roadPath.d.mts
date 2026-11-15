export type P = [number, number];

export const STRAIGHT_UNDER: number;
export const DETOUR_MAX: number;
export function makeRoads(graph: { points: P[]; edges: P[] }): {
  nearest(x: number, z: number): { a: number; b: number; p: P; d: number };
  route(from: P, to: P): { line: P[]; length: number; roads: boolean };
};
export function onLine(line: readonly P[], x: number, z: number): { i: number; p: P; d: number };
export function lengthOf(line: readonly P[]): number;
