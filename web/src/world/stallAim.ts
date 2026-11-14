import { STALL, type StallSpot } from '../../shared/stall.mjs';

/**
 * Which thing on the Zombies stall's table you face (world/stall.ts): plain geometry, no three.js, so the checks
 * (stallAim.test.mjs) run it as the game does.
 *
 * The stall's local frame: the origin on the ground under the table's middle, the front along -z, the table along x.
 * - Only from in front of the table or behind it, within its length and a little more (TABLE_HALF + BEYOND). From an
 *   end the six things lie in a row along your view, within a few degrees of each other, and a hair of turning would
 *   flip between them: nothing is offered there.
 * - A thing is the one you face when your view passes within AIM_M of it at its distance (as an angle, AIM_MIN to
 *   AIM_MAX): wide when you stand at the table, narrow from 2.5 m, so the offer ends a little past the outer things.
 * - The nearest angle wins; two within TIE of each other, the nearer thing.
 */

/** Where each thing lies on the table, in STALL.items order: from the buyer's left (+x) to right (m, local). */
export const ITEM_X: readonly number[] = STALL.items.map((_, i) => 1.0 - 0.4 * i);
export const ITEM_Z = -0.05;
/** m: half the table's length, and how far past its end you still stand "in front" */
export const TABLE_HALF = 1.2;
export const BEYOND = 0.1;
/** m: half the table's depth (you can't stand in it: the walking barrier) */
const TABLE_DEPTH = 0.4;
/** m: how far your view may pass beside a thing and still be on it, at its distance */
export const AIM_M = 0.25;
/** rad: the least and the most that comes to (the least: at 2.5 m; the most: right at the table) */
export const AIM_MIN = 0.1;
export const AIM_MAX = 0.35;
/** rad: two things this close in angle: the nearer one */
const TIE = 0.01;

/** The world (x, z) of thing `i` on the stall at `s`, turned by its yaw as three.js turns the group. */
export function itemAt(s: StallSpot, i: number): { x: number; z: number } {
  const cos = Math.cos(s.yaw), sin = Math.sin(s.yaw);
  return { x: s.x + ITEM_X[i] * cos + ITEM_Z * sin, z: s.z - ITEM_X[i] * sin + ITEM_Z * cos };
}

/**
 * The index (STALL.items order) of the thing you face standing at (x, z) and looking along `yaw` (the game's: 0
 * looks along -z) at the stall `s`, or -1: none (too far, at an end of the table, or looking past them all).
 */
export function stallPick(s: StallSpot, x: number, z: number, yaw: number): number {
  const dx = x - s.x, dz = z - s.z;
  if (!(Math.hypot(dx, dz) <= STALL.near)) return -1;
  const cos = Math.cos(s.yaw), sin = Math.sin(s.yaw);
  const lx = dx * cos - dz * sin; // along the table
  const lz = dx * sin + dz * cos; // in front (-) or behind (+)
  if (Math.abs(lx) > TABLE_HALF + BEYOND || Math.abs(lz) < TABLE_DEPTH) return -1;
  // Your view must cross the row of things on the table, not beside it: so the offer ends at the table's end.
  const vx = -Math.sin(yaw - s.yaw), vz = -Math.cos(yaw - s.yaw); // the view in the stall's frame
  const t = (ITEM_Z - lz) / vz;
  if (!(t > 0) || Math.abs(lx + vx * t) > TABLE_HALF + BEYOND) return -1;
  let best = -1, bestA = Infinity, bestD = Infinity;
  for (let i = 0; i < ITEM_X.length; i++) {
    const it = itemAt(s, i);
    const dist = Math.hypot(it.x - x, it.z - z);
    let d = Math.atan2(-(it.x - x), -(it.z - z)) - yaw; // the yaw that looks at it, less yours
    d = Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
    if (d > Math.min(AIM_MAX, Math.max(AIM_MIN, Math.atan2(AIM_M, dist)))) continue;
    if (d < bestA - TIE || (d <= bestA + TIE && dist < bestD)) {
      best = i;
      bestA = d;
      bestD = dist;
    }
  }
  return best;
}
