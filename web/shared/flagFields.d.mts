// Types for flagFields.mjs (Steal the flag's fields, shared with the server).

import type { Bounds } from './bounds.mjs';

export type FlagTeam = 'blue' | 'red';

export interface FlagBase {
  /** Where the flag stands and its team scores: x, z, y (the ground) */
  stand: [number, number, number];
  /** Where its players start and come back: x, z, y */
  spawns: [number, number, number][];
}

export interface FlagVehicles {
  cars: { kind: string; x: number; y: number; z: number; yaw: number }[];
  bikes: { id: string; x: number; y: number; z: number; yaw: number }[];
}

export interface FlagField {
  id: 'compact' | 'village';
  /** The portal by red's base (src/i18n.ts portal.*) */
  red: string;
  bases: Record<FlagTeam, FlagBase>;
  edge: { from: [number, number]; to: [number, number]; half: number } | null;
  vehicles?: Record<FlagTeam, FlagVehicles> & { heli: { id: string; x: number; y: number; z: number; yaw: number } };
}

export const FLAG_TEAMS: FlagTeam[];
export const FLAG_COLORS: Record<FlagTeam, string>;
export const FIELDS: Record<'compact' | 'village', FlagField>;
export function fieldOf(id: unknown): FlagField;
export const FLAG_BIKES: Record<string, { team: FlagTeam; park: { x: number; y: number; z: number; yaw: number } }>;
export function fieldEdge(field: FlagField, edges: { map: Bounds }): Bounds;
