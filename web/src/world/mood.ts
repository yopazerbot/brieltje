import { DEFAULT_MOOD, type Mood } from '../../shared/moods.mjs';

/**
 * The weather and time of day as shown now (world/weather.ts sets it), for the parts of the game that follow it:
 * the lit windows at night, the birds, the countryside's sounds. A module of its own with nothing in it but this
 * state, so reading it pulls in no graphics.
 *
 * `current`: the mood's name (shared/moods.mjs); `night`, `wet` and `overcast`: 0 to 1; `byAdmin`: whether the
 * admin chose it for everyone. Read it each frame, or be told with onMoodChange. Only world/weather.ts changes it.
 */
export const mood: { current: Mood; night: number; wet: number; overcast: number; byAdmin: boolean } = {
  current: DEFAULT_MOOD,
  night: 0,
  wet: 0,
  overcast: 0,
  byAdmin: false,
};

export type MoodState = Readonly<typeof mood>;

const listeners = new Set<(m: MoodState) => void>();

/** Be told each time the mood shown changes (once its sky is in). Returns a function that stops it. */
export function onMoodChange(fn: (m: MoodState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** world/weather.ts: the mood shown changed. */
export function moodChanged(next: typeof mood): void {
  Object.assign(mood, next);
  for (const fn of listeners) fn(mood);
}
