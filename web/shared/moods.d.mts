export type Mood = 'sunny' | 'overcast' | 'rain' | 'night';
export type Choice = 'auto' | Mood;
export const MOODS: readonly Mood[];
/** What can be chosen: a mood, or 'auto'. */
export const CHOICES: readonly Choice[];
/** The choice everyone starts with. */
export const DEFAULT_CHOICE: Choice;
/** The mood the cycle starts in. */
export const DEFAULT_MOOD: Mood;
export const BLEND_MS: number;
export const DRY_MS: number;
/** Whether `m` is one of MOODS (a string, exactly). */
export function isMood(m: unknown): m is Mood;
/** Whether `c` is one of CHOICES (a string, exactly). */
export function isChoice(c: unknown): c is Choice;
/** How fast the cycle may run. */
export const SPEEDS: readonly number[];
/** A cycle's timing: its seed, and its own clock `tau` (ms) at `at`, running `speed` times as fast. */
export interface Cycle {
  seed: number;
  at: number;
  tau: number;
  speed: number;
}
export function newCycle(seed: number, now: number): Cycle;
export function cycleTime(c: Cycle, now: number): number;
/** Whether `c` is a cycle's timing as the server sends it. */
export function isCycle(c: unknown): c is Cycle;
export function withSpeed(c: Cycle, now: number, speed: number): Cycle;
/** The cycle with the mood shown now ended (its blend into the next starts now); null while a change is under way. */
export function skipCycle(c: Cycle, run: MoodCycle, now: number): Cycle | null;
export interface CycleState {
  mood: Mood;
  next: Mood;
  /** 0 to 1 towards `next` */
  blend: number;
  /** When `next` takes over (the cycle's clock, ms) */
  until: number;
  /** 0 to 1 */
  wet: number;
}
export class MoodCycle {
  constructor(seed: number, start: number);
  readonly seed: number;
  readonly start: number;
  at(t: number): CycleState;
}
