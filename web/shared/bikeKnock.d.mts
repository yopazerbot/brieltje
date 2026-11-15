import type { Box } from './parking.mjs';

export const KNOCK: {
  min: number;
  tip: number;
  near: number;
  top: number;
  base: number;
  per: number;
  far: number;
  aside: number;
  step: number;
  lie: number;
  halfL: number;
  halfW: number;
  height: number;
  sweep: number;
  spawn: number;
  again: number;
  most: number;
  keep: number;
  loss: number;
  window: number;
  gain: number;
};
export const KNOCK_HOME_MS: number;

/** Where a knocked bike comes to rest. */
export interface Knocked {
  x: number;
  z: number;
  yaw: number;
  /** 1: on its right side, -1: on its left */
  lie: 1 | -1;
  /** ms its fall takes */
  ms: number;
  /** m/s: the car's speed */
  v: number;
  /** m it went */
  dist: number;
}

/** The server's correction of the page's guess, made up from `u` of the fall on. */
export interface Bend {
  dx: number;
  dz: number;
  dyaw: number;
  u: number;
}

export interface Fall {
  from: { x: number; z: number; yaw: number; lean: number };
  /** `lie` 0: back up on its wheels */
  to: { x: number; z: number; yaw: number; lie: number };
  v: number;
  bend?: Bend | null;
}

export interface Place {
  x: number;
  z: number;
  yaw: number;
  lie: number;
}

export interface Tumble {
  x: number;
  z: number;
  yaw: number;
  lean: number;
  hop: number;
}

export function knockBike(
  bike: { x: number; z: number; yaw: number },
  car: { x: number; z: number },
  vx: number,
  vz: number,
  ok: (x: number, z: number, yaw: number) => boolean,
): Knocked | null;
export function tumblePose(fall: Fall, u: number, out?: Partial<Tumble>): Tumble;
export function fallEnd(fall: Fall): Place;
export function answerGuess(fall: Fall | null, u: number, at: Place, told: Place): { bend: Bend } | 'there' | 'go';
export function bendShare(bend: Bend | null | undefined, u: number): number;
export function sweptHit(
  car: { halfL: number; halfW: number },
  from: { x: number; z: number; yaw: number },
  to: { x: number; z: number; yaw: number },
  bike: Box,
): Box | null;
export function clearSpot(x: number, z: number, y: number, yaw: number): boolean;
