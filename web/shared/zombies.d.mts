// Types for zombies.mjs (the Zombies game's horde, shared with the server).

import type { Bounds } from './bounds.mjs';

export const VARIANTS: string[];
export const BIG: number;
/** The runners' kind (the teen in the hoodie) */
export const RUNNER: number;
export const ZOMBIE: {
  cell: number;
  fine: number;
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
  spawnFar: number;
  spawnMax: number;
  runFrom: number;
  runShare: number;
  runGrow: number;
  runMax: number;
  runSpeed: number;
  runTop: number;
  perchWarn: number;
  perchMs: number;
  shoveMs: number;
  shoveFor: number;
};

export function waveSize(n: number, players: number): number;
export function bigOf(n: number): number;
export function aliveCap(players: number): number;
export function runnersOf(n: number, size: number): number;
export function zombieStats(n: number, big: boolean, jitter?: number, runner?: boolean): { speed: number; hp: number; damage: number };
export function spawnEvery(n: number): number;

interface Prism {
  p: number[][][];
  y0: number;
  y1: number;
  d?: number | boolean;
  n?: string;
  m?: string;
}

interface DoorSpec {
  id: string;
  y0: number;
  y1: number;
  open?: boolean;
  both?: boolean;
  panels: { a: number[]; b: number[]; offset?: number; thickness?: number; glass?: boolean; swing?: number; slide?: number[] }[];
}

export interface Area {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export function houseAreas(prisms: Prism[], pad?: number): Area[];

/** Where zombies come out: a spot on the open ground and its node. */
export interface Spot {
  x: number;
  z: number;
  node: number;
}

export interface Seed {
  node: number;
  /** m from the node's square to the player */
  gap: number;
  x: number;
  z: number;
}

export interface Nav {
  cell: number;
  x0: number;
  z0: number;
  nx: number;
  nz: number;
  nodes: number;
  outdoor: number;
  ground(x: number, z: number): number;
  walkable(x: number, z: number): boolean;
  inHouse(x: number, z: number): boolean;
  clear(ax: number, az: number, bx: number, bz: number, sight?: boolean): boolean;
  locate(x: number, y: number, z: number, up?: number): number;
  seed(x: number, y: number, z: number, accept?: ((node: number, x: number, z: number, gap: number) => boolean) | null): Seed | null;
  step(k: number, x: number, z: number): number;
  y(k: number, x?: number, z?: number): number;
  px(k: number): number;
  pz(k: number): number;
  open(k: number): boolean;
  field(sources: number[], until?: number[] | null): void;
  distance(k: number): number;
  region(k: number): number;
  readonly version: number;
  joined(a: number, b: number): boolean;
  next(k: number): number;
  walk(k: number, ax: number, az: number, bx: number, bz: number): number;
  reach(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean;
  setPanes(list: Iterable<number>): void;
  spawnSpots(): Spot[];
  floors(): { x: number; z: number; y: number; open: boolean; links: number; node: number }[];
}

export function makeNav(o: {
  prisms: Prism[];
  height: (x: number, z: number) => number;
  base?: number;
  edge: Bounds;
  boxes?: { x: number; z: number; yaw: number; halfL: number; halfW: number }[];
  areas?: Area[];
  doors?: DoorSpec[];
  shut?: boolean;
  panes?: number;
}): Nav;

export type ZombieAct = 'walk' | 'attack' | 'hurt' | 'down';

export interface Zombie {
  id: number;
  /** 0 to 3 a regular one (VARIANTS; RUNNER the runners), 4 the big one */
  kind: number;
  x: number;
  /** The floor it walks on, and its node on the grid */
  y: number;
  node: number;
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
  | { type: 'wave'; wave: number; count: number; big: boolean; bigs: number; runners: number }
  | { type: 'spawn'; id: number }
  | { type: 'runners' }
  | { type: 'swipe'; id: number; name: string; damage: number }
  | { type: 'door'; id: string; dir: number }
  | { type: 'perch'; name: string; ms: number }
  | { type: 'perchOut'; name: string }
  | { type: 'cleared'; wave: number }
  | { type: 'gone'; ids: number[] }
  | { type: 'over'; wave: number };

export class Horde {
  constructor(nav: Nav, spots: Spot[], o?: { home?: { x: number; z: number }; rand?: () => number; doors?: DoorSpec[]; doorOpen?: (id: string) => boolean });
  nav: Nav;
  phase: 'break' | 'wave' | 'over';
  wave: number;
  until: number;
  toSpawn: number;
  runners: number;
  bigs: number;
  cap: number;
  zombies: Map<number, Zombie>;
  beaten: Record<string, number>;
  readonly left: number;
  readonly bigWave: boolean;
  start(now: number): void;
  tick(now: number, dt: number, players: HordePlayer[]): HordeEvent[];
  hit(id: number, amount: number, by: string, now: number): 'down' | 'hurt' | null;
  blast(x: number, z: number, radius: number, amount: number, by: string, now: number, y?: number | null): [number, 'down' | 'hurt'][];
  reachOf(p: { x: number; y: number; z: number }): (Seed & { ok: boolean }) | null;
}
