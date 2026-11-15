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
  jumpFree: number;
  jumpClear: number;
  jumpClearMin: number;
  jumpSink: number;
  jumpPush: number;
  jumpDrop: number;
  jumpMin: number;
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
  /** After a jump: the canopy opens by itself this many seconds in (jumpStart) */
  openAfter?: number;
  /** After a jump: the canopy opens at DROP.openAt only from this many seconds in */
  openSoon?: number;
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
  options?: { height?: number; input?: DropInput; openAt?: number; turn?: number; jump?: boolean; forward?: number; down?: number; soon?: number },
): {
  reach: number;
  side: number;
  time: number;
  down: number;
  across: number;
  slowest: number;
  path: { t: number; y: number; x: number; side: number; open: number | null }[];
  landing: number;
  openedAt: number | null;
};
export function jumpStart(vx: number, vz: number, vy: number, push?: [number, number], air?: number): { vx: number; vz: number; vy: number; openAfter: number; openSoon: number };
export function dropStart(x: number, z: number, yaw: number): { x: number; z: number };
export function dropFrom(x: number, z: number, yaw: number, inside: (x: number, z: number) => boolean): { x: number; z: number };
export const HOME_DROP: { x: number; z: number; yaw: number };
