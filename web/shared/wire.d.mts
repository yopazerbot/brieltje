// Types for wire.mjs (the shared house's ticks, protocol 2).

export const PROTO: number;
export const TICK_MS: number;
export const FLAG: { armed: number; flying: number; crouch: number; car: number; alive: number; safe: number; chute: number; open: number; bike: number };

/** One entry of a tick's list, as it travels. */
export type Entry = unknown[];

/** A tick from the server. */
export interface Tick {
  t: 's';
  st: number;
  p?: Entry[];
  c?: Entry[];
  h?: Entry[];
  k?: Entry[];
  /** The helicopters (server/helis.mjs) */
  e?: Entry[];
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
  /** In a drop (shared/parachute.mjs) */
  chute: boolean;
  /** Its canopy is out (before it: the free fall) */
  open: boolean;
  /** On a bike (src/world/bike.ts) */
  bike: boolean;
  /** The gun at their eye: the figure aims, a sniper's scope glints */
  aim: boolean;
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

export interface BikeSample {
  id: string;
  age: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  rider: string | null;
  /** Knocked over by a car (shared/bikeKnock.mjs): 1 lying on its right side, -1 on its left, 0 standing */
  lie: number;
}

export interface HeliSample {
  id: string;
  age: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Pitch and roll (rad) */
  p: number;
  r: number;
  /** The rotor's speed, 0 to 1 */
  n: number;
  /** At rest, the pilot's word (only for how it looks): 0 or 1 */
  g: number;
  /** Who sits in each of the four seats (seat 0 flies) */
  seats: (string | null)[];
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
export function readBike(e: Entry): BikeSample;
export function heliFields(h: { x: number; y: number; z: number; yaw: number; p?: number; r?: number; n?: number; g?: number; seats?: (string | null)[] }): Entry;
export function readHeli(e: Entry): HeliSample;
export function readBrute(e: Entry): BruteSample;
