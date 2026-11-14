export const VKIND: { man: 0; woman: 1; elder: 2; teen: 3; child: 4; cyclist: 5; dog: 6 };
export const VILLAGER_DOWN_S: number;
export const VILLAGER_PAINT_S: number;
export const VILLAGER_HIT_MAX: number;
export const VILLAGER_HIT_MS: number;
export const VILLAGER_RANGE: number;
export const HUB_PEOPLE: number;

/** The paths the villagers go by (src/data/villagers.json). */
export interface VillagerPaths {
  walks: number[][];
  wkind: number[];
  links: number[][];
  bikes: number[][];
  bkind: number[];
  bnext: number[][][];
  /** x, z, facing, seat height */
  seats: number[][];
  /** x, z, radius, kind */
  hubs: number[][];
  hubspots: number[][];
}

/** One villager: who it is and the way it goes. Its number (`id`) is its place in the list. */
export interface VillagerDef {
  id: number;
  kind: number;
  role: 'walk' | 'ride' | 'sit' | 'hub' | 'follow';
  /** What it is out for: walker, elder, teen, jog, family, dog, chat, cyclist, sit, hub */
  what: string;
  /** 0 to 1: when fewer are out (night, rain, a slow device), those with the lowest stay */
  rank: number;
  pace: number;
  seed: number;
  jog: boolean;
  /** Holds a dog's lead */
  lead: boolean;
  /** Walks with a child */
  guards: boolean;
  talks: boolean;
  /** The one it walks beside (-1 none) */
  leader: number;
  seat: number;
  hub: number;
  /** Not there at all (a busy place without spots) */
  gone: boolean;
  /** May be hit: never a child, a dog or someone with a child */
  shootable: boolean;
  /** A circle it never leaves */
  cx: number;
  cz: number;
  r: number;
}

export interface VillagerSet {
  list: VillagerDef[];
  hubBase: number;
  hubs: number[][];
  seats: number[][];
}

export interface VillagerPose {
  x: number;
  z: number;
  yaw: number;
  hx: number;
  hz: number;
  speed: number;
  here: boolean;
  road: boolean;
  sit: boolean;
  talk: boolean;
}

export function dice(seed: number): () => number;
export function buildVillagers(data: VillagerPaths): VillagerSet;
export function rebuildHub(set: VillagerSet, h: number, spots: number[]): void;
export function villagerPose(set: VillagerSet, i: number, t: number, out: VillagerPose): VillagerPose;
export function villagerHittable(set: VillagerSet, i: number, t: number, px: number, pz: number, reach: number): boolean;
