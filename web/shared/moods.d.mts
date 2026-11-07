export type Mood = 'sunny' | 'overcast' | 'rain' | 'dusk' | 'night' | 'snow';
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
export const SNOW_BUILD_MS: number;
export const SNOW_MELT_MS: number;
/** Whether `m` is one of MOODS (a string, exactly). */
export function isMood(m: unknown): m is Mood;
/** Whether `c` is one of CHOICES (a string, exactly). */
export function isChoice(c: unknown): c is Choice;
/** Whether it is winter at `ms` by the Belgian date (December to February): snow may come on Auto. */
export function winterAt(ms: number): boolean;
/** The moods that may follow `now` in the cycle. */
export function canFollow(now: Mood, winter: boolean): Mood[];
/** How fast the cycle may run. */
export const SPEEDS: readonly number[];
/** A cycle's timing: its seed, and its own clock `tau` (ms) at `at`, running `speed` times as fast; its season and first mood. */
export interface Cycle {
  seed: number;
  at: number;
  tau: number;
  speed: number;
  /** Snow may come (an older server sends none: no snow) */
  winter?: boolean;
  /** The mood it starts in (none: sunny) */
  first?: Mood;
}
export function newCycle(seed: number, now: number, winter?: boolean, first?: Mood): Cycle;
export function cycleTime(c: Cycle, now: number): number;
/** Whether `c` is a cycle's timing as the server sends it. */
export function isCycle(c: unknown): c is Cycle;
/** The run of moods a cycle's timing gives. */
export function runOf(c: Cycle): MoodCycle;
/** Whether two cycles' timings give the same run of moods. */
export function sameRun(a: Cycle | null | undefined, b: Cycle | null | undefined): boolean;
export function withSpeed(c: Cycle, now: number, speed: number): Cycle;
/** The cycle with the mood shown now ended (its blend into the next starts now); null while a change is under way. */
export function skipCycle(c: Cycle, run: MoodCycle, now: number): Cycle | null;
/** A new cycle for the season that turned, starting in the mood shown; null while that would show. */
export function seasonCycle(c: Cycle, run: MoodCycle, now: number, winter: boolean, seed: number): Cycle | null;
export interface CycleState {
  mood: Mood;
  next: Mood;
  /** 0 to 1 towards `next` */
  blend: number;
  /** When `next` takes over (the cycle's clock, ms) */
  until: number;
  /** 0 to 1 through `mood` */
  progress: number;
  /** 0 to 1 */
  wet: number;
  /** 0 to 1: the snow lying */
  snow: number;
}
export class MoodCycle {
  constructor(seed: number, start: number, options?: { winter?: boolean; first?: Mood });
  readonly seed: number;
  readonly start: number;
  at(t: number): CycleState;
}
