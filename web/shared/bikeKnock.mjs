// A car that drives into a bike nobody rides (Yoshi, 15 Nov 2026: "driving the bikes should throw
// them away or turn them over, not stop the car"): slow, it tips over where it stands; faster, it is
// thrown ahead and to its own side, turning and rolling, and lies on its side. Plain functions, no
// three.js, shared by the page (src/world/bike.ts: alone the answer, together a guess at once) and the
// server (server/bikeHits.mjs: together the answer), so every page shows the same fall to the same place.
// A heading is the game's yaw (nose along -z, turned by yaw); a bike's right is (-fz, fx) of its nose.
import SPAWNS from './spawns.json' with { type: 'json' };
import { homeAt, inEndGarden } from './homes.mjs';
import { boxCorners, boxDistance, boxesOverlap, clearOfPortals } from './parking.mjs';
import { PORTALS, REACH } from './portals.mjs';

/** The numbers of a knock (m, m/s, rad, ms). */
export const KNOCK = {
  /** m/s: a car slower than this knocks nothing (a car standing on a bike) */
  min: 0.5,
  /** m/s (about 10 km/h): slower than this the bike only tips over, `near` m away */
  tip: 3,
  near: 0.4,
  /** m/s: no faster than the fastest car (shared/car.json), whatever the speed works out at */
  top: 55.6,
  /** m: thrown base + per * v, at most far (3 m at 40 km/h, 6.7 m at 100 km/h) */
  base: 0.6,
  per: 0.22,
  far: 8,
  /** rad: thrown this far aside of the car's way, to the side the bike was on */
  aside: (25 * Math.PI) / 180,
  /** m: the path is walked in steps this long, and ends before the first place it may not lie */
  step: 0.25,
  /** rad: lying on its side */
  lie: 1.45,
  /** m: a lying bike's box (half its length, half its width) for where it may lie */
  halfL: 0.8,
  halfW: 0.4,
  /** m: the car and the bike this close in height, or it passes over or under it */
  height: 1.5,
  /** m: the car's box is moved along in steps this long against the bike's */
  sweep: 0.5,
  /** m: no closer than this to a start place (shared/spawns.json) */
  spawn: 2,
  /** ms: a bike is knocked again at most this often; a driver knocks at most `most` a second */
  again: 400,
  most: 6,
  /** the car keeps this much of its speed, and loses at least `loss` m/s */
  keep: 0.97,
  loss: 0.3,
};

/**
 * ms: a knocked bike that lies unused goes back to its own spot after this long (alone on the page,
 * together the server decides). One a player rode and left stays where it was left, as before.
 */
export const KNOCK_HOME_MS = 5 * 60_000;

const angle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const finite = (...v) => v.every((n) => typeof n === 'number' && Number.isFinite(n));

/**
 * Where a bike (`bike`: x, z, yaw) knocked by a car at (`car`: x, z, where the two met) going (vx, vz)
 * comes to rest: { x, z, yaw, lie, ms, v, dist }, or null for a car under KNOCK.min. `lie` is the side
 * it lies on (1 its right, -1 its left): the side away from the car. `ms` how long its fall takes, `v`
 * the car's speed (at most KNOCK.top) and `dist` how far it went. `ok(x, z, yaw)` says where it may lie:
 * the path ends before the first place it may not, and it tips over where it stands when the first
 * step already may not.
 */
export function knockBike(bike, car, vx, vz, ok) {
  if (!bike || !car || !finite(bike.x, bike.z, bike.yaw, car.x, car.z, vx, vz)) return null;
  const speed = Math.hypot(vx, vz);
  if (!(speed >= KNOCK.min)) return null;
  const v = Math.min(KNOCK.top, speed);
  const dx = vx / speed;
  const dz = vz / speed;
  // The car's right on the plan is (-dz, dx); dead ahead counts as on the right.
  const rx = -dz;
  const rz = dx;
  const side = (bike.x - car.x) * rx + (bike.z - car.z) * rz < 0 ? -1 : 1;
  const far = v < KNOCK.tip ? KNOCK.near : Math.min(KNOCK.far, KNOCK.base + KNOCK.per * v);
  const c = Math.cos(KNOCK.aside);
  const s = Math.sin(KNOCK.aside) * side;
  const tx = dx * c + rx * s;
  const tz = dz * c + rz * s;
  const yaw = angle(bike.yaw + side * Math.min(2.6, 0.1 * v));
  let x = bike.x;
  let z = bike.z;
  const steps = Math.ceil(far / KNOCK.step - 1e-9);
  for (let i = 1; i <= steps; i++) {
    const d = Math.min(far, i * KNOCK.step);
    const px = bike.x + tx * d;
    const pz = bike.z + tz * d;
    if (!ok(px, pz, yaw)) break;
    x = px;
    z = pz;
  }
  // It falls the way it was thrown: onto its right when that points along the throw.
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const lie = tx * -fz + tz * fx < 0 ? -1 : 1;
  const dist = Math.hypot(x - bike.x, z - bike.z);
  return { x, z, yaw, lie, ms: Math.round(350 + 110 * dist), v, dist };
}

/**
 * A falling bike's pose at `u` (0 to 1 of its fall): along the line from `from` to `to`, slowing down;
 * when thrown, a hop of up to 0.8 m and one roll on the way past 3 m; the heading turning; the lean
 * going over to `to.lie` * KNOCK.lie. `fall`: { from: { x, z, yaw, lean }, to: { x, z, yaw, lie }, v }.
 * Every page draws the same; the page adds its ground under it. Into `out`: { x, z, yaw, lean, hop }.
 */
export function tumblePose(fall, u, out = {}) {
  const t = Math.min(1, Math.max(0, finite(u) ? u : 1));
  const { from, to } = fall;
  const dist = Math.hypot(to.x - from.x, to.z - from.z);
  const thrown = dist > KNOCK.near + 0.05;
  const p = 1 - (1 - t) ** 2;
  out.x = from.x + (to.x - from.x) * p;
  out.z = from.z + (to.z - from.z) * p;
  out.yaw = angle(from.yaw + angle(to.yaw - from.yaw) * p);
  // Thrown: in the air the first 70 % of the time, then it slides; tipped over, it stays on the ground.
  out.hop = thrown ? Math.min(0.8, 0.03 * (fall.v || 0)) * Math.sin(Math.PI * Math.min(1, t / 0.7)) : 0;
  const end = to.lie * KNOCK.lie + (dist > 3 ? to.lie * 2 * Math.PI : 0);
  const q = Math.min(1, t / 0.8);
  out.lean = from.lean + (end - from.lean) * (thrown ? q * q * (3 - 2 * q) : q * q); // tipped: slow, then faster, as it topples
  return out;
}

/**
 * Whether a car's box (`car`: halfL, halfW) moved from `from` to `to` (x, z, yaw) meets a bike's box
 * (`bike`: x, z, yaw, halfL, halfW): checked every KNOCK.sweep m, so a fast car does not jump over
 * one between two updates. The car's place where they first meet, or null; null too when the car is
 * on it already at `from` (it stands on it, or rolls on over one it just tipped over: once is enough).
 */
export function sweptHit(car, from, to, bike) {
  if (!finite(from.x, from.z, from.yaw, to.x, to.z, to.yaw, bike.x, bike.z, bike.yaw)) return null;
  const d = Math.hypot(to.x - from.x, to.z - from.z);
  // Too far from the whole way to meet it: a few sums instead of the boxes.
  const reach = Math.hypot(car.halfL, car.halfW) + Math.hypot(bike.halfL, bike.halfW);
  const mx = (from.x + to.x) / 2;
  const mz = (from.z + to.z) / 2;
  if (Math.hypot(bike.x - mx, bike.z - mz) > d / 2 + reach) return null;
  const n = Math.max(1, Math.ceil(d / KNOCK.sweep));
  const turn = angle(to.yaw - from.yaw);
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const at = { x: from.x + (to.x - from.x) * f, z: from.z + (to.z - from.z) * f, yaw: from.yaw + turn * f, halfL: car.halfL, halfW: car.halfW };
    if (boxesOverlap(at, bike)) return i === 0 ? null : at;
  }
  return null;
}

/**
 * The part of where a bike may lie that the page and the server know alike (each adds its walls, edge,
 * indoors and water): its box at (x, z, yaw) on the ground at y off the portals' pads and their spots,
 * KNOCK.spawn m from every start place, and out of the code-locked homes (their bands) and the end
 * house's garden (shared/homes.mjs).
 */
export function clearSpot(x, z, y, yaw) {
  if (!finite(x, z, y, yaw)) return false;
  const box = { x, z, yaw, halfL: KNOCK.halfL, halfW: KNOCK.halfW };
  if (!clearOfPortals(box, PORTALS, REACH)) return false;
  if (SPAWNS.some((s) => boxDistance(box, s.x, s.z) < KNOCK.spawn)) return false;
  for (const [px, pz] of [[x, z], ...boxCorners(x, z, yaw, KNOCK.halfL, KNOCK.halfW)]) {
    if (homeAt(px, pz, y + 0.3) || homeAt(px, pz, y + 1) || inEndGarden(px, pz, y)) return false;
  }
  return true;
}
