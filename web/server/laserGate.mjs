// The laser rifle's pace, kept by the server (game.mjs asks before a laser 'shot' is passed on and before any hit with
// it counts: on a player, a zombie, the Brook Spirit, a vehicle, a strongman). Plain functions on the player's object.
//
// The page's gun (src/weapon.ts) fires once in `delay` s; each shot adds `beam.heat` (of 1); once `beam.wait` s have
// passed since the last shot it cools by `beam.cool` a second; at full heat it vents for `beam.vent` s and won't fire,
// and comes out of it at AFTER_VENT. Its cell holds `mag` shots (half as many again with the Zombies game's bigger ammo
// pack); swapping an empty one takes `reload` s, one with shots left 0.8 of that.
//
// The server plays the same gun by the same rules on its own clock, one pull of the trigger at a time. A pull is the
// 'shot' the page sends for the others' picture and at most one hit message (the beam ends on one thing): the page sends
// them in one go, a hit first or after, so a message joins the pull opened within PAIR_MS before it while that pull has
// no message of its kind yet; otherwise it is a new pull and must be one the gun could fire.
//
// Rate abuse: each pull gets a time on the gun's own schedule (`v`): the earliest the rules allow after the one before
// (the delay, the end of a vent, an empty cell's reload), or when it came if later. A pull that comes more than TOLERANCE
// ms before its earliest is refused and changes nothing. So the accepted pulls keep the gun's pace: a page that skips the
// vent or the reload is held to them, each pull at most TOLERANCE early on the schedule, a fixed credit that never adds
// up (it is less than one shot's delay). Network jitter up to TOLERANCE is absorbed: a late pull moves the schedule on,
// the next one on time is early on it by no more than that jitter.
// Where the server can't know what the page did, it gives the page the benefit, each time by a little that can't add up
// to more than a few percent of the gun's pace (the checks measure it: laserGate.test.mjs):
// - a swap with shots left: a gap TOLERANCE short of one fills the cell (a page that only paused is not held back);
// - a gap a vent long: the page may have vented where the server's heat stayed under full, so the heat is no more than
//   that vent leaves (a page that waits a vent's time without venting gains nothing: an honest one at that heat fires on
//   to full, vents and is as cool, with as many shots in the same time);
// - HEAT_SLACK: where the page cools (gaps longer than `wait`) the network's jitter can make the server's heat a little
//   higher than the page's, so it vents only past 1 + HEAT_SLACK (100 ms of jitter on a cooling gap). In the gun's fastest
//   fire (no cooling) the server vents after the very shot the page does; a page that times its shots to the slack gains
//   HEAT_SLACK / cool (0.1 s) of cooling a vent at most.
//
// The state lives with the player's guns: a new set of guns (a respawn, the Zombies game's start and end) is a fresh,
// cool gun with a full cell, as on the page. The gun made fresh without one (bought or found in the Zombies game, Attack
// and defend's ammo crate) is told with laserReset; a cell filled up without a reload (the Zombies game's ammo pack)
// with laserRefill.

/** ms: how early on the gun's schedule a pull may come (jitter); below the gun's delay */
export const TOLERANCE = 200;
/** ms: a hit and a 'shot' this close after the first message of a pull belong to it (one pull's messages leave at once) */
export const PAIR_MS = 200;
/** of 1: the heat the server allows over full before it vents (see the top) */
export const HEAT_SLACK = 0.04;
/** of 1: the gun's heat once a vent is over (src/weapon.ts cool) */
export const AFTER_VENT = 0.15;
/** A cell with shots left is swapped quicker: this share of the reload (src/weapon.ts reload) */
export const QUICK = 0.8;

/** The messages a pull of the laser rifle sends (game.mjs laserPace): the 'shot', and a hit on a player, zombies, the Brook Spirit, a vehicle or a strongman. */
export const LASER_MESSAGES = new Set(['shot', 'hit', 'zhit', 'sphit', 'vhit', 'clownhit']);

/**
 * Where a laser beam the others are shown ends: `t` ({ tx, ty, tz }, already finite and held to the map) brought back
 * along its line to `range` m from the shooter's eyes as the server has them (`s`: their state, y the feet), so a page
 * can't draw a beam longer than the gun's. The map is a box and the eyes are in it: the point stays in the map.
 */
export function laserEnd(t, s, range) {
  const ex = s.x, ey = s.y + 1.5, ez = s.z;
  const dx = t.tx - ex, dy = t.ty - ey, dz = t.tz - ez;
  const d = Math.hypot(dx, dy, dz);
  if (!(d > range)) return t;
  const k = range / d;
  const r2 = (v) => Math.round(v * 100) / 100;
  return { tx: r2(ex + dx * k), ty: r2(ey + dy * k), tz: r2(ez + dz * k) };
}

/** The gun's state for player `p`: fresh with each new set of guns. */
function stateOf(p, cap) {
  let s = p.laser;
  if (!s || s.set !== p.weapons) s = p.laser = { set: p.weapons, v: -Infinity, heat: 0, ventEnd: -Infinity, left: cap, cap, open: null };
  if (cap > s.cap) {
    s.left += cap - s.cap; // a bigger cell: the shots it adds
    s.cap = cap;
  }
  return s;
}

/** The heat with a vent that ends at `end`, at `t` (ms): falling to AFTER_VENT through the vent (as the page's), then cooling. */
const rested = (t, end, beam) => t < end
  ? AFTER_VENT + ((1 - AFTER_VENT) * (end - t)) / (beam.vent * 1000)
  : Math.max(0, AFTER_VENT - (beam.cool * (t - end)) / 1000);

/** The heat at schedule time `t` (ms) after the last pull; Infinity while it vents. */
function heatAt(s, t, beam) {
  if (s.ventEnd > s.v) return t < s.ventEnd ? Infinity : rested(t, s.ventEnd, beam);
  const cooling = (t - s.v) / 1000 - beam.wait;
  return cooling > 0 ? Math.max(0, s.heat - beam.cool * cooling) : s.heat;
}

/** A new pull at `now` on the gun `spec` (shared/weapons.json laser): true and on its schedule, or false and nothing changed. */
function fire(s, now, spec) {
  const beam = spec.beam;
  let earliest = s.v + spec.delay * 1000;
  if (s.ventEnd > s.v) earliest = Math.max(earliest, s.ventEnd);
  if (s.left <= 0) earliest = Math.max(earliest, s.v + spec.reload * 1000);
  if (!(earliest <= now + TOLERANCE)) return false;
  const v = Math.max(now, earliest);
  // A swap fits in the gap (within the tolerance): the cell is full again. An empty one takes the whole reload (earliest
  // has it); the schedule is not moved on for one with shots left (a page that only paused would be held back by it).
  const swap = (s.left <= 0 ? 1 : QUICK) * spec.reload * 1000;
  const left = s.left < s.cap && s.v + swap <= now + TOLERANCE ? s.cap : s.left;
  let h = heatAt(s, v, beam);
  if (!Number.isFinite(h)) return false; // (venting: earliest has it)
  // A vent (nearly) fits in the gap: the page may have vented where the server's heat stayed under full (it can't tell:
  // jitter, or its own guess at an earlier gap), so it is no hotter than that vent would leave it now (rested, still
  // venting off its last part when the pull is a little early). So the server's heat is never held above the page's for
  // long. A page that waits a vent's time without venting gains nothing by it: an honest one at that heat fires on to
  // full, vents and is as cool, with as many shots in the same time (the gun's burst is faster than its pace).
  const end = s.v + beam.vent * 1000;
  if (s.ventEnd <= s.v && end <= now + TOLERANCE) h = Math.min(h, rested(v, end, beam));
  const raw = h + beam.heat;
  s.v = v;
  s.left = left - 1;
  s.heat = Math.min(1, raw);
  s.ventEnd = raw >= 1 + HEAT_SLACK ? v + beam.vent * 1000 : -Infinity;
  return true;
}

/**
 * Player `p` (with `p.weapons`, the server's set of their guns) sends a laser message of `kind` ('shot' or 'hit') at
 * `now` (ms): whether the gun could have fired it. `cap`: the shots in their cell (shared/weapons.json mag, more with a
 * bigger ammo pack). The caller has checked that they carry the laser and hold it.
 */
export function laserPull(p, kind, now, spec, cap = spec.mag) {
  if (!p || (kind !== 'shot' && kind !== 'hit') || !Number.isFinite(now)) return false;
  const s = stateOf(p, cap);
  const o = s.open;
  if (o && now - o.at >= 0 && now - o.at <= PAIR_MS && !o[kind]) {
    o[kind] = true;
    return true;
  }
  if (!fire(s, now, spec)) return false;
  s.open = { at: now, shot: kind === 'shot', hit: kind === 'hit' };
  return true;
}

/** Player `p`'s gun is fresh: cool, not venting, its cell full (Attack and defend's ammo crate: the page's refill does the same). */
export function laserReset(p) {
  if (p) p.laser = null;
}

/** Player `p`'s cell is full now without a reload (`cap` shots: an ammo pack, the gun given, an ammo crate). */
export function laserRefill(p, cap) {
  if (!p?.laser || p.laser.set !== p.weapons) return; // a fresh gun has a full cell anyway
  p.laser.cap = cap;
  p.laser.left = cap;
}
