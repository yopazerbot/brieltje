// Types for wire.mjs (the shared house's ticks, protocol 2).

export const PROTO: number;
export const TICK_MS: number;
export const FLAG: { armed: number; flying: number; crouch: number; car: number; alive: number; safe: number };

/** One entry of a tick's list, as it travels. */
export type Entry = unknown[];

/** A tick from the server. */
export interface Tick {
  t: 's';
  st: number;
  p?: Entry[];
  c?: Entry[];
  h?: Entry[];
  b?: Entry[];
  z?: Entry[];
}

export interface PlayerSample {
  name: string;
  age: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  armed: boolean;
  flying: boolean;
  c: boolean;
  d: boolean;
  alive: boolean;
  safe: boolean;
  warp: number;
  w: string;
}

export interface CarSample {
  id: string;
  age: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  s: number;
  driver: string | null;
  passenger: string | null;
}

export interface HorseSample {
  i: number;
  age: number;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  jump: number;
  rider: string | null;
  parked: boolean;
}

export interface BruteSample {
  id: number;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  act: 'walk' | 'throw' | 'stomp';
  hp: number;
}

export type ZombieAct = 'walk' | 'attack' | 'hurt' | 'down';
export const ZOMBIE_ACTS: ZombieAct[];

export interface ZombieSample {
  id: number;
  x: number;
  z: number;
  yaw: number;
  act: ZombieAct;
  /** 0 to 3: the regular ones (shared/zombies.mjs VARIANTS; 1 the runners); 4: the big one */
  kind: number;
  hp: number;
  /** The floor it walks on (m); null from a server before it */
  y: number | null;
}

export function zombieEntry(z: { id: number; x: number; z: number; yaw: number; act: string; kind: number; hp: number; y?: number }): Entry;
export function readZombie(e: Entry): ZombieSample;
export function readPlayer(e: Entry): PlayerSample;
export function readCar(e: Entry): CarSample;
export function readHorse(e: Entry): HorseSample;
export function readBrute(e: Entry): BruteSample;
