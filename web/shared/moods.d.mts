export type Mood = 'sunny' | 'overcast' | 'rain' | 'night';
export const MOODS: readonly Mood[];
/** The mood everyone starts in. */
export const DEFAULT_MOOD: Mood;
/** Whether `m` is one of MOODS (a string, exactly). */
export function isMood(m: unknown): m is Mood;
