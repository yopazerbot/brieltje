// Types for parachute.mjs.

export const DROP: {
  height: number;
  fall: number;
  terminal: number;
  deploy: number;
  open: number;
  brake: number;
  glide: number;
  sink: number;
  turn: number;
  flareAt: number;
  flareGlide: number;
  flareSink: number;
  maxMs: number;
  graceMs: number;
  reach: number;
  time: number;
};

export function dropSink(t: number, air: number, vy: number, dt: number): number;
export function dropGlide(t: number, air: number, push?: number): number;
export function fly(dt?: number, height?: number): { reach: number; time: number; down: number; across: number; path: { t: number; y: number; x: number }[] };
export function dropSince(fallen: number): number;
export function dropStart(x: number, z: number, yaw: number): { x: number; z: number };
export const HOME_DROP: { x: number; z: number; yaw: number };
