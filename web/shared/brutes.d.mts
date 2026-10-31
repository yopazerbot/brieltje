// Types for brutes.mjs (the strongmen's fighting, shared with the server).

export interface Fight {
  hp: number;
  sight: number;
  leash: number;
  roam: number;
  roamRadius: number;
  chase: number;
  hand: number;
  throwMin: number;
  throwMax: number;
  throwEvery: number;
  windup: number;
  rockSpeed: number;
  rockRadius: number;
  rockDamage: number;
  stompRange: number;
  stompEvery: number;
  stompWindup: number;
  stompRadius: number;
  stompDamage: number;
}

export interface Spot {
  x: number;
  y: number;
  z: number;
}

export interface Brute {
  id: number;
  home: { x: number; z: number };
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  hp: number;
  act: 'walk' | 'throw' | 'stomp';
  until: number;
  aim: Spot | null;
  nextThrow: number;
  nextStomp: number;
  wander: { x: number; z: number };
}

export type BruteEvent =
  | { type: 'throw'; id: number; from: Spot; to: Spot; ms: number }
  | { type: 'stomp'; id: number; at: Spot };

export function newBrute(id: number, x: number, y: number, z: number, fight: Fight): Brute;
export function stepBrute(
  b: Brute,
  players: { name: string; x: number; y: number; z: number }[],
  now: number,
  dt: number,
  fight: Fight,
  free: (x: number, z: number) => boolean,
  rand?: () => number,
): BruteEvent[];
export function hurtBy(d: number, radius: number, damage: number): number;
export function bruteDamage(w: string, weapons: Record<string, { body: number; pellets: number }>): number;
