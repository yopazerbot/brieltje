// Types for assaultFields.mjs (Attack and defend's fields, shared with the server).

import type { FlagField } from './flagFields.mjs';

export type CrateKind = 'ammo' | 'med' | 'bazooka' | 'sniper' | 'claymore' | 'turret';
/** x, z, y (the ground) */
export type Spot = [number, number, number];

export interface AssaultCamp {
  flag: Spot;
  /** The game's yaw facing the front (to the defenders), and facing along the camp */
  yaw: number;
  side: number;
  tents: Spot[];
  supply: Spot;
  crates: { kind: CrateKind; at: Spot }[];
  lamps: Spot[];
  spawns: Spot[];
  heli: Spot;
  truck: Spot;
  cars: Spot[];
}

export const ASSAULT: {
  readonly roundMs: number;
  readonly breakMs: number;
  readonly campR: number;
  readonly campRCar: number;
  readonly campHigh: number;
  readonly truckMin: number;
  readonly truckStillMs: number;
  readonly truckGoneMs: number;
  readonly reach: number;
  readonly rise: number;
  readonly vehicleReach: number;
  readonly wait: { readonly ammo: number; readonly med: number; readonly heavy: number; readonly trap: number };
  readonly heavyMax: number;
  readonly heavyBackMs: number;
  readonly rockets: number;
  readonly claymoresRound: number;
  readonly claymoresTake: number;
  readonly turretsRound: number;
  readonly turretRange: number;
  readonly turretEvery: number;
  readonly turretDamage: number;
  readonly turretRounds: number;
  readonly turretMiss: number;
  readonly mineBlast: number;
  readonly mineDamage: number;
  readonly rateMs: number;
};
export const CRATE_KINDS: readonly CrateKind[];
export const WAIT_OF: Readonly<Record<CrateKind, 'ammo' | 'med' | 'heavy' | 'trap'>>;
export const CAMP: Readonly<Record<string, unknown>>;
export const BASE_CRATES: readonly CrateKind[];
export const TRUCK: {
  readonly name: string;
  readonly model: string;
  readonly length: number;
  readonly width: number;
  readonly height: number;
  readonly maxSpeed: number;
  readonly reverseSpeed: number;
  readonly metal: number;
};
export const TRUCK_KINDS: readonly string[];
export function truckSpec(kind: unknown): typeof TRUCK | null;
export const ASSAULT_FIELDS: Record<'assaultChurch' | 'assaultSparrenhof', FlagField>;
export const ROUND_FIELDS: readonly ('assaultChurch' | 'assaultSparrenhof')[];
export function progressOf(field: FlagField, x: number, z: number): number;
