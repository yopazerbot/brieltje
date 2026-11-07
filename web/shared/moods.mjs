// The weather and the time of day the world can be shown in (src/world/weather.ts draws them). Alone each player
// picks one in their settings; together the admin picks it for everyone and the server keeps it
// (server/game.mjs, the 'mood' message). The server takes only a name from this list.
// A new mood (dusk, snow) is added at the end here, then given its look in src/world/weather.ts and its name in
// src/i18n.ts ('mood.<name>').

export const MOODS = ['sunny', 'overcast', 'rain', 'night'];

/** The mood everyone starts in. */
export const DEFAULT_MOOD = 'sunny';

/** Whether `m` is one of MOODS (a string, exactly). */
export function isMood(m) {
  return typeof m === 'string' && MOODS.includes(m);
}
