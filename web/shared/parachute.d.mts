// Types for parachute.mjs.

export const DROP: {
  height: number;
  fall: number;
  deploy: number;
  glide: number;
  sink: number;
  turn: number;
  flareAt: number;
  maxMs: number;
  graceMs: number;
  slack: number;
  reach: number;
};

export function dropStart(x: number, z: number, yaw: number): { x: number; z: number };
