// Types for stall.mjs (the Zombies game's coins and stall, shared with the server).

import type { Kit, Loot, LootKind } from './loot.mjs';

export type StallKind = 'medkit' | 'nades' | 'claymore' | 'armor' | 'gun' | 'turret' | 'laser';

export const STALL: {
  readonly kill: { readonly walker: number; readonly runner: number; readonly big: number };
  readonly bonus: number;
  readonly bonusStep: number;
  readonly bonusMax: number;
  readonly downShare: number;
  readonly max: number;
  readonly steps: number;
  readonly near: number;
  readonly reach: number;
  readonly rise: number;
  readonly box: { readonly halfL: number; readonly halfW: number };
  readonly items: readonly (readonly [StallKind, number, number])[];
};

export type StallSpot = { readonly x: number; readonly z: number; readonly yaw: number };
export type StallAt = { x: number; y: number; z: number };

export const STALL_SPOTS: readonly (readonly [string, number, number, number])[];
export function stallSpot(id: unknown): StallSpot | null;
export function stallBox(id: unknown): { x: number; z: number; yaw: number; halfL: number; halfW: number } | null;
export function stallReach(p: { x: number; y: number; z: number } | null | undefined, at: StallAt | null | undefined): boolean;

export function sold(kind: unknown): kind is StallKind;
export function priceOf(kind: unknown, bought: number): number;
export function bonusOf(wave: number): number;

export type StallView = { c: number; n: number[] };

export class Stall {
  coins: Map<string, number>;
  bought: Map<string, number[]>;
  of(name: string): number;
  add(name: string, n: number): void;
  earn(name: string, zombieKind: number): number;
  cleared(standing: string[], down: string[], wave: number): Map<string, number>;
  forget(name: string): void;
  view(name: string): StallView;
  buy(
    loot: Loot,
    name: string,
    p: { x: number; y: number; z: number; w: string; hp?: number; guns?: string[] },
    kind: unknown,
    phase: string,
    now: number,
    at: StallAt | null | undefined,
  ): { got: { kind: LootKind; w?: string; heal?: number; kit: Kit }; price: number; why?: undefined } | { why: 'kind' | 'shut' | 'far' | 'short' | 'full'; got?: undefined; price?: undefined };
}
