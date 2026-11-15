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

export interface Fall {
  from: { x: number; z: number; yaw: number; lean: number };
  to: { x: number; z: number; yaw: number; lie: number };
  v: number;
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
export function sweptHit(
  car: { halfL: number; halfW: number },
  from: { x: number; z: number; yaw: number },
  to: { x: number; z: number; yaw: number },
  bike: Box,
): Box | null;
export function clearSpot(x: number, z: number, y: number, yaw: number): boolean;
