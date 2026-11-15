import type * as THREE from 'three';

/**
 * Which way the view looks, flat on the ground: the minimap's up (ui/minimap.ts). A yaw as the game's
 * (three.js's): 0 looks along -z, a quarter turn (+π/2) along -x. Taken from the camera that draws the
 * frame, so it holds however you move: on foot, from the car's or the bike's camera behind (looking round
 * too), from the saddle, in the drop filmed from behind, in the watch view.
 */

/** Below this much of the view on the ground (|forward| flat: about 75° down or up) the camera's top edge helps out. */
const STEEP = 0.25;
/** A change smaller than this between two draws (rad, 3°) goes half way: a blast's shake doesn't wiggle the map; a turn isn't held back. */
const SMALL = 0.05;

/**
 * The heading from the camera's forward (`fx`, `fy`, `fz`) and the flat part of its top edge (`ux`, `uz`).
 * Looking (nearly) straight down, the forward has no way on the ground left; the top edge then points the way
 * the camera faces (looking up, the other way), so it takes over, blended in so nothing jumps. Only there
 * does the view's roll count (the car's lean). Nothing to go by (straight down and rolled over, or NaN): `last`.
 */
export function viewHeading(fx: number, fy: number, fz: number, ux: number, uz: number, last: number): number {
  const flat = Math.hypot(fx, fz);
  const up = Math.hypot(ux, uz);
  const w = Math.min(1, flat / STEEP);
  const s = (fy < 0 ? 1 : -1) * (1 - w) / (up || 1);
  const x = (w ? (fx / flat) * w : 0) + ux * s;
  const z = (w ? (fz / flat) * w : 0) + uz * s;
  if (!(Math.hypot(x, z) > 1e-6)) return last;
  return Math.atan2(-x, -z);
}

/** From the heading drawn last (`from`) to the camera's (`to`): a small change half way, a larger one at once. */
export function easeHeading(from: number, to: number): number {
  if (!Number.isFinite(from)) return to;
  const d = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  if (Math.abs(d) >= SMALL) return to;
  const half = from + d / 2;
  return Math.atan2(Math.sin(half), Math.cos(half));
}

/** The heading of `camera` now, eased from `drawn` (the heading drawn last, NaN at first). No allocation: it reads the camera's matrix. */
export function cameraHeading(camera: THREE.Camera, drawn: number): number {
  camera.updateWorldMatrix(true, false);
  const e = camera.matrixWorld.elements; // by column: 4..6 the camera's up, 8..10 its back (it looks along -z)
  return easeHeading(drawn, viewHeading(-e[8], -e[9], -e[10], e[4], e[6], Number.isFinite(drawn) ? drawn : 0));
}
