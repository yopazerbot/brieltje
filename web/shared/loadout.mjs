// The guns a player starts with, shared by the server (which hands them out) and the page (playing alone): plain
// data and a plain function.
//
// In Action and Paintball everyone has every gun from the start: the pistol, the rifle, the shotgun and the sniper
// rifle, alone and together, at the first start and after every respawn (Yoshi, 15 Nov 2026: "geef mensen gewoon
// alle wapens bij de start"), and the laser rifle too (Yoshi, 21 Nov 2026: "Give laser gun to everyone, except in
// zombie"; in Paintball the light tagger). The bazooka is the admin's, and anyone's playing alone (`extra`). In the
// Zombies game everyone starts with the pistol and finds the rest: the guns lying on the map and the zombies' drops
// (Yoshi, 10 Nov 2026), the laser rifle a late wave's drop or the stall's dearest buy (shared/loot.mjs, shared/stall.mjs).

/** The long guns everyone carries outside the Zombies game, besides the pistol */
const LONG_GUNS = ['rifle', 'shotgun', 'sniper', 'laser'];

/** The guns a player has coming into play: the pistol, the long guns and `extra` (the admin's); in Zombies the pistol only. */
export function startingWeapons(extra = [], zombies = false) {
  return zombies ? ['pistol'] : ['pistol', ...LONG_GUNS, ...extra];
}
