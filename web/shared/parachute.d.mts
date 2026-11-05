// Types for parachute.mjs.

export const DROP: {
  height: number;
  fallDown: number;
  trackDown: number;
  diveDown: number;
  track: number;
  backDrift: number;
  slide: number;
  diveForward: number;
  fallEase: number;
  minFall: number;
  openAt: number;
  deploy: number;
  open: number;
  brake: number;
  glide: number;
  sink: number;
  glideFast: number;
  sinkFast: number;
  glideSlow: number;
  sinkSlow: number;
  turn: number;
  flareAt: number;
  flareGlide: number;
  flareSink: number;
  across: number;
  maxMs: number;
  graceMs: number;
  hoverMs: number;
  hoverMin: number;
  reach: number;
  time: number;
};

/** A drop in flight: seconds since it began, since its canopy began to open (null: free fall), its velocity, its height. */
export interface DropFlight {
  t: number;
  open: number | null;
  vx: number;
  vz: number;
  vy: number;
  air: number;
}

export interface DropInput {
  moveX?: number;
  moveY?: number;
  dive?: boolean;
  open?: boolean;
}

export function dropWant(s: DropFlight, input: DropInput): { forward: number; side: number; down: number };
export function dropStep(s: DropFlight, input: DropInput, yaw: number, dt: number): void;
export function fly(
  dt?: number,
  options?: { height?: number; input?: DropInput; openAt?: number; turn?: number },
): {
  reach: number;
  side: number;
  time: number;
  down: number;
  across: number;
  slowest: number;
  path: { t: number; y: number; x: number; side: number; open: number | null }[];
};
export function dropStart(x: number, z: number, yaw: number): { x: number; z: number };
export const HOME_DROP: { x: number; z: number; yaw: number };
