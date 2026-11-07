// Types for ball.mjs (the football, shared with the server).

export const BALL: {
  r: number;
  g: number;
  drag: number;
  roll: number;
  ground: number;
  settle: number;
  scrub: number;
  wall: number;
  net: number;
  body: number;
  sleepSpeed: number;
  sleepAfter: number;
  maxSpeed: number;
  maxStep: number;
  netted: number;
};

export const KICK: {
  reach: number;
  low: number;
  high: number;
  soft: number;
  hard: number;
  run: number;
  aim: number;
  maxLift: number;
  every: number;
};

export const BODY: { r: number; height: number; maxSpeed: number };

export interface PitchSpec {
  id: string;
  outline: [number, number][];
  lift: number;
  goals: { id: string; at: [number, number]; inward: [number, number]; half: number; height: number; depth: number; post: number }[];
  home: [number, number];
  posts: [number, number, number, number][];
  bars: number[][];
  panels: number[][];
  near: number;
}

export const PITCHES: PitchSpec[];

export interface Goal {
  id: string;
  /** The mouth's middle (x, z) */
  mx: number;
  mz: number;
  /** Into the goal (unit) */
  nx: number;
  nz: number;
  /** Along the mouth (unit) */
  ux: number;
  uz: number;
  half: number;
  height: number;
  depth: number;
  /** The ground it stands on */
  y: number;
}

export interface Pitch {
  id: string;
  ring: [number, number][];
  walls: { ax: number; az: number; bx: number; bz: number }[];
  posts: { x: number; z: number; r: number; y0: number; y1: number }[];
  bars: { a: number[]; b: number[]; r: number }[];
  panels: { a: number[]; b: number[]; c: number[]; bounce: number }[];
  goals: Goal[];
  ground(x: number, z: number): number;
  home: { x: number; z: number };
  near: number;
  box: { minX: number; minZ: number; maxX: number; maxZ: number };
}

export interface Ball {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  asleep: boolean;
  still: number;
  /** Seconds left in the net after a goal */
  netted: number;
  /** Goals per goal of the pitch */
  score: number[];
  /** Who touched it last */
  last: string;
}

export interface Mover {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  feet: number;
  name?: string;
}

export type BallEvent =
  | { kind: 'goal'; goal: number }
  | { kind: 'home' }
  | { kind: 'bounce'; speed: number; post?: boolean }
  | { kind: 'touch'; name: string };

export function makePitch(spec: PitchSpec, height: (x: number, z: number) => number): Pitch;
export function insidePitch(pitch: Pitch, x: number, z: number): boolean;
export function newBall(pitch: Pitch): Ball;
export function toHome(ball: Ball, pitch: Pitch): Ball;
export function stepBall(ball: Ball, pitch: Pitch, dt: number, movers?: Mover[]): BallEvent[];
export function inReach(ball: Ball, x: number, feet: number, z: number, slack?: number): boolean;
export function kickFrom(yaw: number, pitch: number, speed: number): [number, number, number];
export function fairKick(v: unknown, max: number): [number, number, number] | null;
export function kickBall(ball: Ball, v: [number, number, number], by?: string): boolean;
