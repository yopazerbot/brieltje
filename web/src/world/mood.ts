import { DEFAULT_MOOD, type Mood } from '../../shared/moods.mjs';

/**
 * The weather and time of day as shown now (world/weather.ts sets it every frame), for the parts of the game that
 * follow it: the lit windows at night, the birds, the countryside's sounds. A module of its own with nothing in it
 * but this state, so reading it pulls in no graphics.
 *
 * - `current`: the mood that shows most now (shared/moods.mjs); `next`: the one it is turning into (the same when
 *   none), `blend` 0 to 1 how far.
 * - `night`, `wet`, `overcast`: 0 to 1, blended smoothly through every change (a change takes about two and a half
 *   minutes on Auto, a few seconds when a mood is picked). Read them each frame for a smooth fade. `night` also
 *   ramps up through dusk (the lamps and windows come on as it darkens).
 * - `snowing`: 0 to 1, how hard it snows (blended like the others); `snow`: 0 to 1, the snow lying, which builds up
 *   slowly while it snows and melts slowly after.
 * - `auto`: the weather changes by itself; `byAdmin`: the admin chose for everyone.
 *
 * onMoodChange tells when `current`, `auto` or `byAdmin` change. Only world/weather.ts changes this.
 */
export const mood: {
  current: Mood; next: Mood; blend: number; night: number; wet: number; overcast: number; snowing: number; snow: number; auto: boolean; byAdmin: boolean;
} = {
  current: DEFAULT_MOOD,
  next: DEFAULT_MOOD,
  blend: 0,
  night: 0,
  wet: 0,
  overcast: 0,
  snowing: 0,
  snow: 0,
  auto: true,
  byAdmin: false,
};

export type MoodState = Readonly<typeof mood>;

const listeners = new Set<(m: MoodState) => void>();

/** Be told each time the mood that shows most, or who chose it, changes. Returns a function that stops it. */
export function onMoodChange(fn: (m: MoodState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** world/weather.ts, each frame: the mood shown now; listeners are told when it changed. */
export function moodShown(next: typeof mood): void {
  const changed = next.current !== mood.current || next.auto !== mood.auto || next.byAdmin !== mood.byAdmin;
  Object.assign(mood, next);
  if (changed) for (const fn of listeners) fn(mood);
}
