// Types for zombies.mjs (the Zombies game's horde, shared with the server).

import type { Bounds } from './bounds.mjs';

export const VARIANTS: string[];
export const BIG: number;
export const ZOMBIE: {
  cell: number;
  firstBreak: number;
  break: number;
  maxAlive: number;
  radius: number;
  bigRadius: number;
  attackFrom: number;
  reach: number;
  bigFrom: number;
  bigReach: number;
  impact: number;
  attackMs: number;
  bigImpact: number;
  bigAttackMs: number;
  swipeEvery: number;
  bigEvery: number;
  shield: number;
  hurtMs: number;
  downMs: number;
  straight: number;
  fieldReach: number;
  fieldEvery: number;
  spawnMin: number;
  spawnBest: number;
  spawnMax: number;
};

export function waveSize(n: number, players: number): number;
export function bigOf(n: number): number;
export function aliveCap(players: number): number;
export function zombieStats(n: number, big: boolean, jitter?: number): { speed: number; hp: number; damage: number };
export function spawnEvery(n: number): number;

interface Prism {
  p: number[][][];
  y0: number;
  y1: number;
  d?: number;
  n?: string;
}

export function makeIndoors(prisms: Prism[]): (x: number, z: number) => boolean;

export interface Nav {
  cell: number;
  x0: number;
  z0: number;
  nx: number;
  nz: number;
  walkable(x: number, z: number): boolean;
  clear(ax: number, az: number, bx: number, bz: number, sight?: boolean): boolean;
  field(sources: { x: number; z: number }[], until?: { x: number; z: number }[] | null): void;
  distance(x: number, z: number): number;
  joined(x: number, z: number, tx: number, tz: number): boolean;
  next(x: number, z: number): { x: number; z: number } | null;
  edgeSpots(ring: number[][], step?: number, inset?: number): { x: number; z: number }[];
}

export function makeNav(o: {
  prisms: Prism[];
  height: (x: number, z: number) => number;
  edge: Bounds;
  indoors?: (x: number, z: number) => boolean;
  boxes?: { x: number; z: number; yaw: number; halfL: number; halfW: number }[];
}): Nav;

export type ZombieAct = 'walk' | 'attack' | 'hurt' | 'down';

export interface Zombie {
  id: number;
  /** 0 to 3 a regular one (VARIANTS), 4 the big one */
  kind: number;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  top: number;
  hp: number;
  max: number;
  damage: number;
  act: ZombieAct;
  actAt: number;
  until: number;
  struck: boolean;
  next: number;
  downAt: number;
  target: string | null;
}

export interface HordePlayer {
  name: string;
  x: number;
  y: number;
  z: number;
  alive: boolean;
  fighter: boolean;
  safe: boolean;
}

export type HordeEvent =
  | { type: 'wave'; wave: number; count: number; big: boolean }
  | { type: 'spawn'; id: number }
  | { type: 'swipe'; id: number; name: string; damage: number }
  | { type: 'cleared'; wave: number }
  | { type: 'gone'; ids: number[] }
  | { type: 'over'; wave: number };

export class Horde {
  constructor(nav: Nav, spots: { x: number; z: number }[], o?: { height?: (x: number, z: number) => number; home?: { x: number; z: number }; rand?: () => number });
  phase: 'break' | 'wave' | 'over';
  wave: number;
  until: number;
  toSpawn: number;
  bigs: number;
  cap: number;
  zombies: Map<number, Zombie>;
  beaten: Record<string, number>;
  readonly left: number;
  readonly bigWave: boolean;
  start(now: number): void;
  tick(now: number, dt: number, players: HordePlayer[]): HordeEvent[];
  hit(id: number, amount: number, by: string, now: number): 'down' | 'hurt' | null;
  blast(x: number, z: number, radius: number, amount: number, by: string, now: number): [number, 'down' | 'hurt'][];
}
