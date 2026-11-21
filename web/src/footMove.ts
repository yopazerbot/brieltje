/**
 * How your speed on foot follows the keys or the stick (player.ts), so a body has a little weight (Yoshi, 21 Nov 2026:
 * "Can the physics improve ...", then "Do what u think is best"). Big shooters give the walker a short build-up and a
 * quicker stop (Unreal's walking braking is a fixed slowing plus friction; Source's ground friction does the same).
 *
 * - The build-up: the speed still to come in shrinks at a fixed rate plus a share of itself (`START`): walking pace in
 *   0.2 s, a full sprint from standing in 0.4 s, and then it is there, with no long tail. A stop the same way, quicker
 *   (`STOP`): 0.15 s from walking, 0.3 s from a sprint. The fixed part brings it to exactly nought: nobody slides.
 * - Turning: the part of your speed across where the keys now go stops as a stop does, while the part along them
 *   builds up (going the other way you push off as you stop): at walking pace a turn is as crisp as before, at a
 *   sprint it takes a few tenths of a second.
 * - Never faster than the larger of where you were and where the keys go: never past today's top speed.
 */

/** The build-up and the stop at walking pace (m/s2 and 1/s; for another pace times as much as it is faster). */
export const START = { a: 5.68, k: 2.03 };
export const STOP = { a: 7.57, k: 2.7 };
/** The pace the rates are for (m/s): walking. */
export const PACE = 1.4;

/** `gap` m/s still to go after `dt` s, shrinking at `a` plus `k` times itself (worked out exactly: any frame rate). */
function close(gap: number, a: number, k: number, dt: number): number {
  if (gap <= 0) return 0;
  const c = a / k;
  return Math.max(0, (gap + c) * Math.exp(-k * dt) - c);
}

/**
 * Your speed `v` (m/s across the ground, changed in place) after `dt` s, going for `tx, tz`. `scale`: how many times
 * walking pace the rates are for (walking speed and the admin's turbo).
 */
export function footStep(v: { x: number; z: number }, tx: number, tz: number, dt: number, scale: number): void {
  const want = Math.hypot(tx, tz);
  const was = Math.hypot(v.x, v.z);
  const ux = want > 1e-9 ? tx / want : 0;
  const uz = want > 1e-9 ? tz / want : 0;
  let along = v.x * ux + v.z * uz;
  const px = v.x - along * ux;
  const pz = v.z - along * uz;
  // Across the way you want to go: stopped as a stop is.
  const across = Math.hypot(px, pz);
  const keep = across > 1e-9 ? close(across, STOP.a * scale, STOP.k, dt) / across : 0;
  // Along it: built up to the pace, or slowed to it (going the other way, slowed to nought first, pushing off as you
  // stop: a stop's and a start's rate together).
  if (along < 0) along = -close(-along, (STOP.a + START.a) * scale, STOP.k, dt);
  else if (along < want) along = want - close(want - along, START.a * scale, START.k, dt);
  else along = want + close(along - want, STOP.a * scale, STOP.k, dt);
  v.x = px * keep + along * ux;
  v.z = pz * keep + along * uz;
  const top = Math.max(want, was);
  const now = Math.hypot(v.x, v.z);
  if (now > top) {
    v.x *= top / now;
    v.z *= top / now;
  }
}
