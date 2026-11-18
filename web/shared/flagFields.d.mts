// Types for flagFields.mjs (Steal the flag's fields, shared with the server).

import type { Bounds } from './bounds.mjs';
import type { AssaultCamp, CrateKind } from './assaultFields.mjs';

export type FlagTeam = 'blue' | 'red';

export interface FlagBase {
  /** Where the flag stands and its team scores: x, z, y (the ground) */
  stand: [number, number, number];
  /** Where its players start and come back: x, z, y */
  spawns: [number, number, number][];
  /** The team's bazooka rack (server/flagBazooka.mjs): x, z, y (the ground), yaw (its front to the stand) */
  rack: [number, number, number, number];
}

export interface FlagVehicles {
  cars: { kind: string; x: number; y: number; z: number; yaw: number }[];
  bikes: { id: string; x: number; y: number; z: number; yaw: number }[];
}

/** Attack and defend's own part of a field (shared/assaultFields.mjs) */
export interface AssaultPart {
  camp: AssaultCamp;
  /** The spawn truck's car id */
  truck: string;
  /** The defenders' crates */
  crates: { kind: CrateKind; at: [number, number, number] }[];
}

export interface FlagField {
  id: 'compact' | 'village' | 'assaultChurch' | 'assaultSparrenhof';
  /** The portal by red's base (src/i18n.ts portal.*) */
  red: string;
  bases: Record<FlagTeam, FlagBase>;
  edge: { from: [number, number]; to: [number, number]; half: number } | null;
  vehicles?: Record<FlagTeam, FlagVehicles>;
  /** The village's own vehicles out of play while the game runs (shared/car.json and bike.json ids) */
  off?: { cars: string[]; bikes: string[] };
  /** Each team's helicopter (shared/heli.json's id): on its own pad, or set down at x, y, z, yaw for the game */
  heli: Record<FlagTeam, { id: string; x?: number; y?: number; z?: number; yaw?: number }>;
  /** Attack and defend's fields only */
  assault?: AssaultPart;
}

export const FLAG_TEAMS: FlagTeam[];
export const FLAG_COLORS: Record<FlagTeam, string>;
export const FIELDS: Record<FlagField['id'], FlagField>;
export function fieldOf(id: unknown): FlagField;
export function baseOf(field: FlagField, team: FlagTeam, swapped?: boolean): FlagBase;
export function vehicleTeam(field: FlagField, kind: string, id: string, swapped?: boolean): FlagTeam | null;
export const FLAG_BIKES: Record<string, { team: FlagTeam; park: { x: number; y: number; z: number; yaw: number } }>;
export function fieldEdge(field: FlagField, edges: { map: Bounds }): Bounds;
