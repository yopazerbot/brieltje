// The weapons a player chooses to start with in Action and Paintball, shared by the server (which
// checks the choice and hands the guns out) and the page (the picker, src/ui/loadout.ts, and playing
// alone): plain data and plain functions.
//
// Everyone carries the pistol. On top of it a player picks up to LOADOUT.most of the long guns. The
// other guns still lie on the map to be found, and so does the one you didn't pick. In the Zombies
// game nobody's choice counts: everyone starts with the pistol and finds the rest (Yoshi, 10 Nov 2026).
//
// A choice counts from the next time you come into play, or at once while you haven't fired since
// you came in: nobody swaps guns in the middle of a fight.

export const LOADOUT = {
  /** The guns that can be chosen, in the picker's order */
  choices: ['rifle', 'shotgun', 'sniper'],
  /** How many of them at most */
  most: 2,
  /** What a player gets who never chose */
  first: ['rifle'],
};

/**
 * A choice as it may be used, whatever was sent: the known guns only, each once, in the order given,
 * LOADOUT.most at most. Anything else (not a list, other things in it) gives what is left, down to nothing.
 */
export function cleanPick(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const w of list.slice(0, 8)) {
    if (typeof w === 'string' && LOADOUT.choices.includes(w) && !out.includes(w)) out.push(w);
    if (out.length >= LOADOUT.most) break;
  }
  return out;
}

/** The guns a player has coming into play: the pistol, what they chose and `extra` (the admin's); in Zombies the pistol only. */
export function startingWeapons(pick, extra = [], zombies = false) {
  return zombies ? ['pistol'] : ['pistol', ...extra, ...cleanPick(pick)];
}
