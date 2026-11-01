// Types for loot.mjs (the Zombies game's rewards, shared with the server).

import type { Nav, Zombie } from './zombies.mjs';

export type LootKind = 'ammo' | 'scope' | 'claymore';

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
};

export interface Kit {
  ammo: string[];
  scope: boolean;
  claymores: number;
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

export class Loot {
  constructor(nav: Nav, rand?: () => number);
  items: Map<number, Item>;
  mines: Map<number, Mine>;
  kits: Map<string, Kit>;
  kit(name: string): Kit;
  wave(): void;
  drop(z: Zombie, now: number, last?: boolean): Item | null;
  take(name: string, p: { x: number; y: number; z: number; w: string }, id: number, now: number): { kind: LootKind; w?: string; kit: Kit } | null;
  place(name: string, p: { x: number; y: number; z: number }, at: { x: number; y: number; z: number; yaw: number }, now: number): { mine?: Mine; why?: 'none' | 'max' | 'spot' };
  tick(now: number, zombies: Iterable<Zombie>): { gone: number[]; booms: { mine: Mine; ids: number[] }[] };
  view(): { items: [number, LootKind, number, number, number][]; mines: [number, number, number, number, number, string][] };
  clear(): void;
}
