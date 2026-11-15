// Types for heli.mjs.

export const HELI: {
  ROTOR_R: number; ROTOR_Y: number; SPOOL_UP: number; SPOOL_DOWN: number; LIFT_RPM: number; START_HOLD: number; STOP_HOLD: number;
  THRUST_MAX: number; COLL_RATE: number; LEVER_LOW: number; TILT: number; BANK: number; ATT_FREQ: number; ATT_DAMP: number;
  DRAG_FWD: number; DRAG_SIDE: number; DRAG_UP: number; DRAG_LIN: number;
  V_TOP: number; V_SLOW: number; V_CAP: number; CLIMB_MAX: number; SINK: number; SINK_CAP: number;
  VS_RESP: number; HOLD_GAIN: number; SPEED_GAIN: number; POS_GAIN: number;
  YAW_SLOW: number; YAW_FAST: number; YAW_BLEND0: number; YAW_BLEND1: number; YAW_RESP: number; YAW_STOP: number; TURN_SLOW: number;
  GE_GAIN: number; GE_HEIGHT: number; GE_FADE: number; ETL_GAIN: number; ETL_V0: number; ETL_V1: number;
  WIND_PUSH: number; CEIL_FADE: number; EDGE_PAD: number;
  LAND_SOFT: number; LAND_HARD: number; LAND_SKID: number; LAND_TILT: number; SLOPE_SLIDE: number; SLOPE_MAX: number;
  DOWN_TIME: number; DOWN_SINK: number; REST: number; RIDGE: number; STRIKES: number; STRIKE_WINDOW: number; STRIKE_HARD: number; BODY_HARD: number; STEP_UP: number;
  CAM_DIST: number; CAM_SPEED: number; CAM_UP: number; CAM_SIDE: number; CAM_PITCH: number; CAM_FOLLOW: number; CAM_LAND: [number, number];
  MAGNET_R: number; MAGNET_H: number; MAGNET_V: number;
};

export const SKIDS: [number, number][];

export const EV: { SETTLE: number; BOUNCE: number; BUMP: number; START: number; STOP: number; LIFTOFF: number; CEILING: number; EDGE: number };

/** A machine's flight state (heliStart). */
export interface HeliState {
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  /** rad, the game's heading (forward is -sin, -cos) */
  yaw: number;
  /** rad, positive nose down */
  pitch: number;
  /** rad, positive right side down */
  roll: number;
  pitchRate: number; rollRate: number;
  /** rad/s, d(yaw)/dt (positive turning left) */
  yawRate: number;
  /** 0 to 1 of full speed */
  rotor: number;
  /** the lever, 0 to 1 */
  coll: number;
  engine: boolean;
  ground: boolean;
  /** s left before it can start again after a bump */
  down: number;
  holdY: number; holdX: number; holdZ: number; holding: boolean; heightHeld: boolean; startHeld: number; stopHeld: number;
  /** s it has been at rest (the time down counts from REST) */
  still: number;
  /** the page's walls hold it up this step (resting on its boom or cabin): set by world/heli.ts */
  held: boolean;
  /** m over the floor below */
  h: number;
  floor: number;
  shake: number;
  /** the rotor's thrust in g */
  thrust: number;
  /** what happened since the caller last cleared it (EV) */
  ev: number;
  /** how hard the last touch or bump was (m/s) */
  hit: number;
  atEdge: boolean;
  atCeiling: boolean;
}

export interface HeliInput {
  fwd?: number;
  side?: number;
  /** > 0 to the right */
  turn?: number;
  lift?: number;
}

export interface HeliEnv {
  /** The floor's height at (x, z): the highest under `top` */
  ground: (x: number, z: number, top: number) => number;
  ceiling: number;
  wind?: [number, number] | number[];
  edge?: { x: number; z: number; nx: number; nz: number } | null;
  /** `long`: a deck with a line (the church's): its pull also turns the nose along `yaw` or the other way round. */
  pad?: { x: number; y: number; z: number; yaw?: number; long?: boolean } | null;
}

export function heliStart(at?: { x?: number; y?: number; z?: number; yaw?: number }): HeliState;
export function heliPlace(s: HeliState, x: number, y: number, z: number, yaw: number, rotor?: number): HeliState;
export function heliBump(s: HeliState, speed?: number): HeliState;
export function heliStep(s: HeliState, input: HeliInput, env: HeliEnv, dt: number): HeliState;
export function heliFly(s: HeliState, input: HeliInput, env: HeliEnv, dt: number): HeliState;
/** Where you stand after getting out, or null (stay aboard): see heli.mjs. */
export function heliExit(s: HeliState, steps: [number, number][], ground: (x: number, z: number, top: number) => number, free: (x: number, z: number, feet: number) => boolean): { x: number; y: number; z: number } | null;
/** The sizes heliJump and heliGap read (heli.json's `size`). */
export interface HeliSize {
  cabin: { halfX: number; z0: number; z1: number; y0: number; y1: number };
  skidX: number;
  boom: { halfX: number; z0: number; z1: number; y0: number; y1: number };
  stabiliser: { halfX: number; z0: number; z1: number; y0: number; y1: number };
  rotor: { y: number; r: number };
  steps: number[][];
}
export function heliToWorld(s: HeliState, x: number, y: number, z: number): { x: number; y: number; z: number };
export function heliToBody(s: HeliState, x: number, y: number, z: number): { x: number; y: number; z: number };
/** Where a jump starts: the feet's place, the side (1 right, -1 left), the step out's direction across. */
export function heliJump(s: HeliState, size: HeliSize): { x: number; y: number; z: number; side: number; push: [number, number] };
export const JUMP_CLEAR: number;
export function heliGap(s: HeliState, size: HeliSize, x: number, feet: number, z: number, r?: number, height?: number): number;
export const AWAY: { keep: number; home: number; latest: number };
export function awayKeep(s: HeliState): { fwd: number; side: number };
export function awayInput(t: number, keep: { fwd: number; side: number }): HeliInput;
