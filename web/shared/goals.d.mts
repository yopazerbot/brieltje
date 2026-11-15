export type By = 'foot' | 'bike' | 'car';

export interface Route {
  id: string;
  /** Raised when the layout changes, so older best times do not count */
  rev: number;
  by: By;
  /** How close (m) counts as through a gate or a checkpoint */
  radius: number;
  colour: string;
  gate: [number, number];
  checkpoints: [number, number][];
}

export interface Run {
  id: string;
  /** Index into pointsOf(route) of the point to reach next */
  next: number;
  /** ms at the start and at the last point */
  t0: number;
  last: number;
}

export type RunEvent = 'start' | 'checkpoint' | 'finish' | 'stop' | null;

export const TIME_MIN: number;
export const TIME_MAX: number;
export const TIMEOUT_MS: number;
export const STEP_MAX: Record<By, number>;
export function readFound(text: unknown, ids: readonly string[]): { found: string[]; told: boolean };
export function writeFound(found: Iterable<string>, told: boolean): string;
export function cleanTime(ms: unknown): number | null;
export function readBest(text: unknown, keys: readonly string[]): Record<string, number>;
export function writeBest(best: Record<string, number>): string;
export function bestKey(route: { id: string; rev: number }): string;
export function passes(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, r: number): boolean;
export function pointsOf(route: Route): [number, number][];
export function stepRun(
  run: Run | null,
  route: Route,
  from: { x: number; z: number },
  to: { x: number; z: number },
  by: By | null,
  nowMs: number,
  /** The longest step that keeps a run going (m); STEP_MAX[route.by] when left out */
  stepMax?: number,
): { run: Run | null; event: RunEvent; time?: number };
export function formatTime(ms: number, comma?: boolean): string;

export interface Race {
  armed: string | null;
  done: number;
  by: By | null;
  offer: string | null;
  offerLeft: number;
  visit: boolean;
  at: { x: number; z: number } | null;
}
export const OFFER_MS: number;
export const OFFER_NEAR: number;
export const OFFER_AWAY: number;
export const DONE_MS: number;
export function newRace(): Race;
export function startable(race: Race, routes: readonly Route[], by: By | null): Route | null;
export function stepRace(
  race: Race,
  routes: readonly Route[],
  me: { x: number; z: number; by: By | null },
  pressed: boolean,
  nowMs: number,
  shownMs?: number,
): { race: Race; event: 'armed' | 'stopped' | 'ended' | null; why?: 'key' | 'left' };
export function finishRace(race: Race, nowMs: number): Race;
export function dropRace(race: Race): Race;
