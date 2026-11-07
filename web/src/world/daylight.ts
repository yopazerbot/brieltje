import { mood } from './mood';

/**
 * How much of the day's light the things that light themselves should show (smoke, dust, butterflies, the
 * parachute's own glow): 1 in the sun, about a tenth at night, a little less under a grey sky (world/mood.ts).
 * Things that really glow (fire, sparks, portals, screens, lamps) don't use it.
 */
export function daylight(): number {
  return (1 - 0.9 * mood.night) * (1 - 0.25 * mood.overcast);
}
