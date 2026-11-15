// A car that drives into a bike nobody rides (Yoshi, 15 Nov 2026: "driving the bikes should throw
// them away or turn them over, not stop the car"): slow, it tips over where it stands; faster, it is
// thrown ahead and to its own side, turning and rolling, and lies on its side. Plain functions, no
// three.js, shared by the page (src/world/bike.ts: alone the answer, together a guess at once) and the
// server (server/bikeHits.mjs: together the answer), so every page shows the same fall to the same place.
// A heading is the game's yaw (nose along -z, turned by yaw); a bike's right is (-fz, fx) of its nose.
import SPAWNS from './spawns.json' with { type: 'json' };
import { END_GARDEN, HOMES } from './homes.mjs';
import { boxDistance, boxesOverlap, clearOfPortals, makeSolids } from './parking.mjs';
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
  /**
   * Together, the car's speed for a throw (server/bikeHits.mjs): how far the server had it go over the last
   * `window` ms of its own clock, and at most `gain` m/s more than over the window before that (about 10 m/s2,
   * more than the car can speed up), so a sudden jump buys no throw
   */
  window: 300,
  gain: 3,
};

/**
 * ms: a knocked bike that lies unused goes back to its own spot after this long (alone on the page,
 * together the server decides). One a player rode and left stays where it was left, as before.
 */
export const KNOCK_HOME_MS = 5 * 60_000;

const angle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const finite = (...v) => v.every((n) => typeof n === 'number' && Number.isFinite(n));
/**
 * Where no bike may lie, as blocks between heights (shared/parking.mjs makeSolids): the code-locked homes' bands
 * (shared/homes.mjs) and the end house's garden, 1.5 m round its lawn's height. A lying bike's whole box is tested
 * against their outlines, not points on it.
 */
const KEEP_OUT = makeSolids([
  ...HOMES.flatMap((h) => h.bands.map((b) => ({ y0: b.y0, y1: b.y1, p: [b.ring] }))),
  { y0: END_GARDEN.y - 1.5, y1: END_GARDEN.y + 1.5, p: [END_GARDEN.ring] },
], () => 0);

/**
 * Where a bike (`bike`: x, z, yaw) knocked by a car at (`car`: x, z, where the two met) going (vx, vz)
 * comes to rest: { x, z, yaw, lie, ms, v, dist }, or null for a car under KNOCK.min. `lie` is the side
 * it lies on (1 its right, -1 its left): the side away from the car. `ms` how long its fall takes, `v`
 * the car's speed (at most KNOCK.top) and `dist` how far it went. `ok(x, z, yaw)` says where it may lie:
 * the path ends before the first place it may not. When the first step already may not, it tips over
 * where it stands, turned only if that turned pose may lie there too, else as it stood; and when even
 * that may not (a bike left hard against a wall, on a pad), null: it stays standing. Whatever comes
 * back has passed `ok`.
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
  let yaw = angle(bike.yaw + side * Math.min(2.6, 0.1 * v));
  let x = bike.x;
  let z = bike.z;
  let moved = false;
  const steps = Math.ceil(far / KNOCK.step - 1e-9);
  for (let i = 1; i <= steps; i++) {
    const d = Math.min(far, i * KNOCK.step);
    const px = bike.x + tx * d;
    const pz = bike.z + tz * d;
    if (!ok(px, pz, yaw)) break;
    x = px;
    z = pz;
    moved = true;
  }
  // Hemmed in: it tips over where it stands, turned if that may lie there, else as it stood, else not at all.
  if (!moved && !ok(x, z, yaw)) {
    if (!ok(x, z, bike.yaw)) return null;
    yaw = bike.yaw;
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
 * The page's guess and the server's answer (src/world/bike.ts). Where a fall ends: its `to`, with the
 * server's correction (`bend`) when it has one.
 */
export function fallEnd(fall) {
  const b = fall.bend;
  return { x: fall.to.x + (b ? b.dx : 0), z: fall.to.z + (b ? b.dz : 0), yaw: angle(fall.to.yaw + (b ? b.dyaw : 0)), lie: fall.to.lie };
}

/**
 * The server's place for a bike the page guessed a knock of (`told`: x, z, yaw, lie). `fall`: the page's fall
 * under way and how far it is (`u`, 0 to 1), or null when it has ended (`at`: where the bike is then). Returns
 * { bend } to make up the difference over the rest of the fall (the same side), 'there' when it lies where the
 * server has it already, or 'go' when it has to go there anew (the other side, or elsewhere after the fall).
 */
export function answerGuess(fall, u, at, told) {
  if (fall && fall.to.lie === told.lie) {
    return { bend: { dx: told.x - fall.to.x, dz: told.z - fall.to.z, dyaw: angle(told.yaw - fall.to.yaw), u: Math.min(1, Math.max(0, u)) } };
  }
  if (!fall && at.lie === told.lie && Math.hypot(told.x - at.x, told.z - at.z) < 0.05 && Math.abs(angle(told.yaw - at.yaw)) < 0.05) return 'there';
  return 'go';
}

/** How much of a bend shows at `u` of the fall: none before it came, all of it at the end, smoothly between. */
export function bendShare(bend, u) {
  if (!bend) return 0;
  const w = Math.min(1, Math.max(0, (u - bend.u) / Math.max(1e-3, 1 - bend.u)));
  return w * w * (3 - 2 * w);
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
  return KEEP_OUT.boxFree(x, z, yaw, KNOCK.halfL, KNOCK.halfW, y, y + 1); // its whole box, from the ground it lies on to 1 m up
}
