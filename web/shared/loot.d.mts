// Types for loot.mjs (the Zombies game's rewards, shared with the server).

import type { Nav, Zombie } from './zombies.mjs';

export type LootKind = 'ammo' | 'scope' | 'claymore' | 'stakes' | 'turret';

export const LOOT: {
  chance: number;
  runnerChance: number;
  bigChance: number;
  weights: [LootKind, number][];
  lying: number;
  life: number;
  reach: number;
  rise: number;
  bigMag: number;
  scoped: string[];
  carry: number;
  placed: number;
  placeReach: number;
  placeRise: number;
  apart: number;
  armMs: number;
  trigger: number;
  cone: number;
  blast: number;
  blastCone: number;
  close: number;
  damage: number;
  bundle: number;
  stakesCarry: number;
  stakesPlaced: number;
  stakesAll: number;
  stakesApart: number;
  stakeGap: number;
  stakeHalf: number;
  front: number;
  back: number;
  slow: number;
  bigSlow: number;
  slowMs: number;
  hold: number;
  bigWear: number;
  turretsAll: number;
  turretArm: number;
  turretRange: number;
  turretRounds: number;
  turretEvery: number;
  turretDamage: number;
  turretTurn: number;
  turretCone: number;
};

export interface Kit {
  ammo: string[];
  scope: boolean;
  claymores: number;
  /** Rows of stakes carried */
  stakes: number;
  /** A turret carried (0 or 1) */
  turrets: number;
}

export interface Item {
  id: number;
  kind: LootKind;
  x: number;
  y: number;
  z: number;
  until: number;
}

export interface Mine {
  id: number;
  owner: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  armedAt: number;
}

/** A row of stakes: its middle, facing (the way the stakes lean), m along it each side, wear, stakes standing, zombies in it. */
export interface Row {
  id: number;
  owner: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  a: number;
  b: number;
  wear: number;
  up: number;
  in: Set<number>;
}

/** A turret up: where it stands, its yaw as set up and where it aims now, its rounds, its next shot (ms) and the zombie it shoots. */
export interface Turret {
  id: number;
  owner: string;
  x: number;
  y: number;
  z: number;
  set: number;
  yaw: number;
  armedAt: number;
  rounds: number;
  next: number;
  target: number;
  at: number;
}

type At = { x: number; y: number; z: number; yaw: number };

export class Loot {
  constructor(nav: Nav, rand?: () => number);
  items: Map<number, Item>;
  mines: Map<number, Mine>;
  rows: Map<number, Row>;
  turrets: Map<number, Turret>;
  kits: Map<string, Kit>;
  kit(name: string): Kit;
  wave(): void;
  drop(z: Zombie, now: number, last?: boolean, fighters?: string[]): Item[];
  take(name: string, p: { x: number; y: number; z: number; w: string }, id: number, now: number): { kind: LootKind; w?: string; kit: Kit } | null;
  place(name: string, p: { x: number; y: number; z: number }, at: At, now: number): { mine?: Mine; why?: 'none' | 'max' | 'spot' };
  spot(p: { x: number; y: number; z: number }, at: At): (At & { node: number }) | null;
  placeStakes(name: string, p: { x: number; y: number; z: number }, at: At): { row?: Row; why?: 'none' | 'max' | 'spot' };
  preview(kind: 'claymore' | 'stakes' | 'turret', name: string, p: { x: number; y: number; z: number }, at: At, now: number): { ok: boolean; why?: 'none' | 'max' | 'all' | 'spot'; a?: number; b?: number };
  placeTurret(name: string, p: { x: number; y: number; z: number }, at: At, now: number): { turret?: Turret; why?: 'none' | 'max' | 'all' | 'spot' };
  sees(t: Turret, q: Zombie): number;
  tick(now: number, zombies: Iterable<Zombie>): { gone: number[]; booms: { mine: Mine; ids: number[] }[]; broke: Row[]; worn: boolean; shots: { turret: Turret; id: number }[]; spent: Turret[] };
  view(): {
    items: [number, LootKind, number, number, number][];
    mines: [number, number, number, number, number, string][];
    stakes: [number, number, number, number, number, number, number, number, string][];
    turrets: [number, number, number, number, number, string][];
  };
  clear(): void;
}
