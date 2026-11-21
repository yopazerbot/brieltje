// What a driven car does to what it runs into, decided here: a parked car it hits is dented where it was hit. There is no
// message for it: the server finds the hit itself in the driver's states it already takes and checks (game.mjs
// `state`: the movement budget, the edge, the locked homes), with its own record of both cars, as server/bikeHits.mjs
// does for a bike. What a page could forge:
// - a dent on a car across the map: the hitting car's place is the driver's, held to the car's speed budget before it
//   gets here, and its box must come within PARK.gap of the parked car's box;
// - a big dent from a lurch: the speed comes from where the server had the car over the last PARK.window ms of its own
//   clock, at most PARK.gain more than over the window before (speedOf), at most PARK.top;
// - a dent on a car someone drives: only a car with no driver is dented here (a driven one dents itself, `dent`);
// - flooding: no new message; this runs in the state handler (30 a second at most), and the knocks of one crash within
//   PARK.again ms count as one hit (only what goes beyond the hardest so far), as on the page (world/carDamage.ts hit).
// The look goes out as the car's usual message through broadcastThing (nothing leaks from a private home).
//
// A hedge, a light fence or a young tree a car breaks (shared/smash.mjs) is a thing of the whole game: a gap changes
// where cars and walkers go. The driver's page reports it (`smash`: the piece's number, where along it, how wide),
// because only the page has the car's exact box against the piece at that frame; the server keeps the list of broken
// pieces (which, where, when), tells every page and every late joiner, and mends them. Its checks on the report:
// - state forgery (a gap where no car was): only the driver of a car; the piece must be in the shared list and of a kind
//   that breaks (not a wall, a gate, a post, a grown tree, nothing by a code-locked home); the server's own car, some
//   time in the last second, within SMASH.reach of the broken spot; the spot held to the piece and the width to the
//   kind's; the heading is the server's own record of the car, never the page's;
// - griefing by flattening the village from afar or from a standstill: the same reach, and the car's speed by the
//   server's clock (speedOf, as for a parked car's dent) at the kind's breaking speed a moment ago (80 % of it, for the
//   server's coarser view);
// - flooding: one report every SMASH.rate ms per player and SMASH.burst in SMASH.burstMs, at most SMASH.perPiece gaps
//   in one piece and SMASH.cap in the game; a refused report is answered to its page alone (it closes the gap it made
//   ahead), a malformed one not at all.
// The broken pieces mend after SMASH.mend when nobody is within SMASH.clear m of them (out of everyone's sight, as the big
// open-world games put broken things back), after SMASH.late anyway, all at once when a game starts and when the last
// player leaves. Nothing here changes the Zombies game's walking grids (server/navCache.mjs): zombies keep the hedges
// and fences whole, and no shot or hit reads the list.
import { boxesOverlap as overlap } from '../shared/parking.mjs';
import { gapPoint, SMASH } from '../shared/smash.mjs';

/** The page's numbers (src/world/carDamage.ts): zones round a car, steps of a zone's look, a hit's speeds (m/s). */
const ZONES = 8;
const STEP = 15;
const HIT_FROM = 2.5;
const HIT_FULL = 20;

/**
 * A parked car's dent: m the two boxes may be apart and still touch (a page stops its car a frame before the other's
 * box); ms of the server's clock a speed is taken over; m/s more than the window before it may be (no lurch); the most
 * (m/s, the fastest car's); ms within which the knocks of one crash are one hit; m apart in height for two cars to meet.
 */
export const PARK = { gap: 0.3, window: 300, gain: 3, top: 56, again: 600, height: 2 };

/** ms of a car's trail kept (speedOf looks back two windows and a little). */
const KEEP = 1500;

export class CarSmash {
  /**
   * `game`: the server/game.mjs Game (its cars, players, modes, broadcastThing, broadcast, send). `env`: `carSpec(car)`
   * (length, width, height) and `pieces` (shared/smash.mjs smashPieces).
   */
  constructor(game, env) {
    this.game = game;
    this.env = env;
    this.pieces = env.pieces ?? [];
    /** car id -> { driver, points: [{ t, x, z }] }: where the server had it, by its own clock */
    this.trails = new Map();
    /** parked car id -> { at, d }: its last hit (one crash's knocks are one hit) */
    this.hits = new Map();
    /** The broken pieces: [{ id, s, w, a, at }] (piece number, m along it, m wide, the car's heading, when) */
    this.gaps = [];
    /** A game on at the last tick (one starting mends everything) */
    this.wasOn = false;
    this.nextLook = 0;
  }

  /** The broken pieces as a page takes them (welcome, `smashed`): [id, s, w, a] each. */
  list() {
    return this.gaps.map((g) => [g.id, g.s, g.w, g.a]);
  }

  /**
   * `name`'s page reports that the car it drives broke piece `m.id` at `m.s` m along it, `m.w` m wide (shared/smash.mjs
   * gapWidth). Checked as the header says; told to everyone, or refused to that page alone.
   */
  smash(name, player, m, now) {
    const g = this.game;
    const car = g.carOf(name);
    if (!car || car.driver !== name) return;
    if (!Number.isInteger(m.id) || m.id < 0 || m.id >= this.pieces.length) return;
    const piece = this.pieces[m.id];
    const kind = piece.kind && SMASH[piece.kind];
    if (!kind) return;
    if (typeof m.s !== 'number' || typeof m.w !== 'number' || !Number.isFinite(m.s) || !Number.isFinite(m.w)) return;
    const s = Math.round(Math.max(-piece.half, Math.min(piece.half, m.s)) * 100) / 100;
    const w = piece.kind === 'sapling' ? 0 : Math.round(Math.max(kind.width, Math.min(kind.most, m.w)) * 100) / 100;
    const no = () => g.send(player.ws, { t: 'smash', id: m.id, s: m.s, w: m.w, no: true });
    // At most one report every SMASH.rate ms, SMASH.burst in SMASH.burstMs.
    if (now < (player.nextSmash ?? 0)) return no();
    player.nextSmash = now + SMASH.rate;
    player.smashes = (player.smashes ?? []).filter((t) => now - t < SMASH.burstMs && now >= t);
    if (player.smashes.length >= SMASH.burst) return no();
    player.smashes.push(now);
    // The server's car near the spot some time in the last second, and fast enough a moment ago.
    const [px, pz] = gapPoint(piece, s);
    const trail = this.trails.get(car.id);
    const recent = [{ x: car.x, z: car.z }, ...(trail?.driver === name ? trail.points.filter((p) => p.t >= now - 1000 && p.t <= now) : [])];
    if (!recent.some((p) => Math.hypot(p.x - px, p.z - pz) <= SMASH.reach)) return no();
    let v = 0;
    for (const back of [0, 150, 300, 450]) v = Math.max(v, this.speedOf(car, now - back).v);
    if (v < kind.min * 0.8) return no();
    // Already broken there (another car a moment before): that gap stands, this page closes its own. A piece gone too
    // often, or the game's list full: refused.
    const mine = this.gaps.filter((q) => q.id === m.id);
    if (piece.kind === 'sapling' ? mine.length : mine.some((q) => Math.abs(q.s - s) < (q.w + w) * 0.375)) return no();
    if (mine.length >= SMASH.perPiece || this.gaps.length >= SMASH.cap) return no();
    const gap = { id: m.id, s, w, a: Math.round((car.yaw ?? 0) * 100) / 100, at: now };
    this.gaps.push(gap);
    g.broadcast({ t: 'smash', id: gap.id, s: gap.s, w: gap.w, a: gap.a, by: name });
  }

  /**
   * Every tick: a game starting, or nobody left, mends everything; a piece broken SMASH.mend ago with nobody within
   * SMASH.clear m of it mends, one broken SMASH.late ago mends anyway. Told to every page.
   */
  tick(now) {
    const g = this.game;
    const on = !!g.modes?.active;
    const starting = on && !this.wasOn;
    this.wasOn = on;
    if (!this.gaps.length) return;
    if (starting || !g.players.size) {
      this.gaps = [];
      g.broadcast({ t: 'mend', all: true });
      return;
    }
    if (now < this.nextLook) return;
    this.nextLook = now + 2000;
    const people = [...g.players.values()].map((p) => p.state).filter(Boolean);
    const mended = this.gaps.filter((q) => {
      const age = now - q.at;
      if (age >= SMASH.late) return true;
      if (age < SMASH.mend) return false;
      const [x, z] = gapPoint(this.pieces[q.id], q.s);
      return !people.some((p) => Math.hypot(p.x - x, p.z - z) < SMASH.clear);
    });
    if (!mended.length) return;
    this.gaps = this.gaps.filter((q) => !mended.includes(q));
    g.broadcast({ t: 'mend', list: mended.map((q) => [q.id, q.s]) });
  }

  /**
   * The driver `name` sent a state that moved `car` to where it is now (the server's own place, after its checks),
   * at `now` (the server's clock, ms): its trail grows, and a parked car its box came against is dented.
   */
  moved(name, car, now) {
    if (car.driver !== name) return;
    let trail = this.trails.get(car.id);
    const last = trail?.points.at(-1);
    // A new driver, or the car somewhere else at once (a portal, the server putting it back): a trail of its own.
    if (!trail || trail.driver !== name || !last || Math.hypot(last.x - car.x, last.z - car.z) > 30) {
      trail = { driver: name, points: [{ t: -Infinity, x: car.x, z: car.z }] };
      this.trails.set(car.id, trail);
    } else trail.points.push({ t: now, x: car.x, z: car.z });
    const p = trail.points;
    while (p.length > 2 && p[1].t < now - KEEP) p.shift();
    this.dentParked(car, now);
  }

  /** Where the server had `car` at time `t` (between its two states round it; before the first, where it stood). */
  at(car, t) {
    const p = this.trails.get(car.id)?.points;
    if (!p?.length) return { x: car.x, z: car.z };
    let i = 0;
    while (i + 1 < p.length && p[i + 1].t <= t) i++;
    const q = p[i];
    const r = p[i + 1];
    if (!r || !Number.isFinite(q.t)) return q;
    const f = (t - q.t) / (r.t - q.t);
    return { x: q.x + (r.x - q.x) * f, z: q.z + (r.z - q.z) * f };
  }

  /**
   * `car`'s speed (m/s) over the PARK.window ms of the server's clock up to `end`, no more than PARK.gain over the
   * window before (a jump within the budget buys nothing), at most PARK.top; and the way it went (a unit vector).
   */
  speedOf(car, end) {
    const w = PARK.window;
    const a = this.at(car, end - 2 * w);
    const b = this.at(car, end - w);
    const c = this.at(car, end);
    const d = Math.hypot(c.x - b.x, c.z - b.z);
    const v = Math.min(PARK.top, d / (w / 1000), Math.hypot(b.x - a.x, b.z - a.z) / (w / 1000) + PARK.gain);
    return { v: Number.isFinite(v) ? v : 0, dx: d > 1e-6 ? (c.x - b.x) / d : 0, dz: d > 1e-6 ? (c.z - b.z) / d : 0 };
  }

  /** The car's box ({ x, z, yaw, halfL, halfW }) and its height, or null for a car with no model. */
  box(car) {
    const s = this.env.carSpec(car);
    return s ? { x: car.x, z: car.z, yaw: car.yaw, halfL: s.length / 2, halfW: s.width / 2, height: s.height } : null;
  }

  /**
   * A parked car (no driver) that `car`'s box has come against at speed: a dent where it was hit, by how fast `car`
   * came at it, in the page's own way (world/carDamage.ts hit: the zone at the point it was struck and its share of
   * the next, 1 - (1 - before)(1 - d)), told as the car's look.
   */
  dentParked(car, now) {
    const me = this.box(car);
    if (!me) return;
    let speed = null;
    for (const other of Object.values(this.game.cars)) {
      if (other === car || other.driver || Math.abs((other.y ?? 0) - (car.y ?? 0)) > PARK.height) continue;
      const box = this.box(other);
      if (!box || Math.hypot(box.x - me.x, box.z - me.z) > me.halfL + box.halfL + PARK.gap + 0.5 || !overlap(me, box, PARK.gap)) continue;
      speed ??= this.speedOf(car, now);
      // How fast it came at the parked car: its speed towards the other's middle (sliding past it dents little).
      const tx = box.x - me.x, tz = box.z - me.z, tl = Math.hypot(tx, tz) || 1;
      const v = speed.v * Math.max(0, (speed.dx * tx + speed.dz * tz) / tl);
      let d = Math.min(1, Math.max(0, (v - HIT_FROM) / (HIT_FULL - HIT_FROM)));
      const last = this.hits.get(other.id);
      if (last && now - last.at < PARK.again && now >= last.at) {
        if (d <= last.d) continue;
        [d, last.d] = [d - last.d, d];
      } else this.hits.set(other.id, { at: now, d });
      if (!(d > 0.002)) continue;
      // Where it was struck: the point of its box nearest the hitting car's middle, on its own model (x right, z back).
      const fx = -Math.sin(box.yaw), fz = -Math.cos(box.yaw);
      const dx = me.x - box.x, dz = me.z - box.z;
      const mx = Math.max(-box.halfW, Math.min(box.halfW, -dx * fz + dz * fx));
      const mz = Math.max(-box.halfL, Math.min(box.halfL, -(dx * fx + dz * fz)));
      if (this.dent(other, mx, mz, d)) this.game.broadcastThing({ t: 'car', car: other }, 'car', other);
    }
  }

  /** Dent `car` by `d` (0 to 1) at (x, z) on its model; true when its look changed. */
  dent(car, x, z, d) {
    const halfW = (this.env.carSpec(car)?.width ?? 2) / 2, halfL = (this.env.carSpec(car)?.length ?? 4.7) / 2;
    let k = Math.atan2(x / halfW, -z / halfL) / (Math.PI / 4);
    if (k < 0) k += ZONES;
    const a = Math.floor(k) % ZONES;
    const f = k - Math.floor(k);
    const dm = Array.isArray(car.dm) && car.dm.length === ZONES + 1 ? car.dm.slice() : new Array(ZONES + 1).fill(0);
    for (const [zone, w] of [[a, 1 - f], [(a + 1) % ZONES, f]]) {
      const before = dm[zone] / STEP;
      dm[zone] = Math.min(STEP, Math.round((1 - (1 - before) * (1 - d * w)) * STEP));
    }
    if (car.dm && dm.every((v, i) => v === car.dm[i])) return false;
    if (!car.dm && dm.every((v) => v === 0)) return false;
    car.dm = dm;
    return true;
  }
}
