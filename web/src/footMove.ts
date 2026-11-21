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
 * - The full sprint only forward (the tactical sprint in recent Call of Duty games; Warzone cut its sideways and
 *   backwards sprint): within 45 degrees of straight ahead, eased over the next 45 down to 70 % of it (`sprintShare`).
 */

/** The build-up and the stop at walking pace (m/s2 and 1/s; for another pace times as much as it is faster). */
export const START = { a: 5.68, k: 2.03 };
export const STOP = { a: 7.57, k: 2.7 };
/** The pace the rates are for (m/s): walking. */
export const PACE = 1.4;
/**
 * Sideways and backwards: this share of the sprint's extra over walking. 0.5: 70 % of the full sprint, 2.45 m/s. A
 * walker zombie (shared/zombies.mjs) goes 0.65 m/s in the first wave and 0.06 more each wave up to 2.3, each 10 %
 * either way, and 18 % more for 4 s after it hears a shot: backing away while shooting gets you clear of them until
 * about wave 22, when the fastest stirred walkers keep up. A runner (3.0 to 3.4) catches you backing away; turning
 * round and sprinting (3.5) still gets away from every zombie.
 */
export const SIDE = 0.5;

/** Of the sprint's extra pace, how much the keys or the stick get going this way: 1 within 45 degrees of ahead, eased over the next 45 down to SIDE. */
export function sprintShare(moveX: number, moveY: number): number {
  const mag = Math.hypot(moveX, moveY);
  if (mag < 1e-6) return 1;
  const off = Math.acos(Math.max(-1, Math.min(1, moveY / mag))); // 0 straight ahead .. pi straight back
  const t = Math.max(0, Math.min(1, (off - Math.PI / 4) / (Math.PI / 4) - 1e-9));
  return 1 - (1 - SIDE) * t * t * (3 - 2 * t);
}

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
