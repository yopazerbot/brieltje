// A car that drives into a bike nobody rides knocks it over or throws it aside (shared/bikeKnock.mjs),
// decided here together. There is no message for it: the server finds the hit itself in the driver's
// states it already gets and checks (game.mjs `state`: the movement budget, the edge, the locked homes),
// with its own record of the car and of the bike, and works out the resting place itself. Every page
// is told the same place in a 'bike' message with `knock`, and a page that joins later gets the bike
// where it lies. What a page could forge:
// - a bike moved anywhere: no place is ever read from a page. A bike moves only where the server's car
//   passes over the server's bike, at most 8 m, to a place the server works out (`spotOk`);
// - knocking from across the map: the car's place is the driver's, held to the car's speed budget
//   before it gets here, and the sweep runs only from the car's last place to its new one;
// - a big throw from a lurch: the speed comes from where the server had the car over the last 300 ms of
//   its own clock, at most 3 m/s more than over the 300 ms before (speedOf); no page's time is used;
// - knocking from inside or through a wall the server knows: the car's box must be clear of the server's
//   blocks all the way from its last place to where it met the bike (carClear). What remains: between two
//   states the car's way is a straight line the server checks for nothing else, and within the speed
//   budget a driver can push bikes about, 8 m at a time;
// - keeping a row empty: the way back to its spot counts from the first knock, a later one doesn't restart it;
// - a ridden bike, or its rider, knocked off: a ridden bike is never knocked (it stops the car, as a
//   player on foot does);
// - flooding: no new message; this runs in the state handler (30 a second at most), each bike knocked
//   at most every 400 ms, each driver at most 6 a second;
// - griefing by throwing a bike into a private home, onto a start place or a portal's pad, indoors, into
//   a pond or a wall: `spotOk` refuses all of them and the path ends before the first such step.
import { boxDistance, boxesOverlap, boxPoints } from '../shared/parking.mjs';
import { clearSpot, KNOCK, KNOCK_HOME_MS, knockBike, sweptHit } from '../shared/bikeKnock.mjs';

/** ms: a bike due back on its spot while something stands there tries again this much later */
const HOME_RETRY_MS = 3000;

/** Even-odd test of a point against an outline. */
function inRing(x, z, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

export class BikeHits {
  /**
   * `game`: the server/game.mjs Game (its bikes, cars, edge, broadcast). `env`: what the server knows of the
   * world: `solids` (shared/parking.mjs makeSolids), `indoors(x, z)` and `inside` (the indoor floors as blocks: a
   * box against their outlines, shared/parking.mjs indoorBlocks), `parked` (the street's parked cars'
   * boxes), `dips` (the house's and the village's ponds and ditches: their rims), `ground(x, z)`, `area`
   * (x0, x1, z0, z1), `map` (the whole edge of the game), `carSpec(car)`, `mono()` (the tick clock).
   */
  constructor(game, env) {
    this.game = game;
    this.env = env;
    this.dips = (env.dips ?? []).filter((d) => Array.isArray(d?.rim) && d.rim.length > 2).map((d) => {
      const xs = d.rim.map((v) => v[0]);
      const zs = d.rim.map((v) => v[1]);
      return { rim: d.rim, x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
    });
    /** bike id -> { at: when it was last knocked (ms), home: when it goes back to its spot if it still lies unused } */
    this.knocks = new Map();
    /** ms (KNOCK_HOME_MS): the tests shorten it */
    this.homeMs = KNOCK_HOME_MS;
    /** car id -> { driver, points: [{ t, x, z, yaw }] }: where the server had it, by its own clock (speedOf) */
    this.trails = new Map();
  }

  /**
   * The driver `name` sent a state that moved their car from `before` ({ x, y, z, yaw }: the server's place of it
   * before) to where it is now (the server's own, after its checks): any free bike its box came onto is knocked.
   * All times are the server's own clock (`env.mono`), never a page's.
   */
  strike(name, player, car, before) {
    const g = this.game;
    if (g.room || g.modes?.zombies || car.driver !== name || !before) return;
    const now = this.env.mono();
    const v = this.speedOf(car, name, before, now);
    const dx = car.x - before.x;
    const dz = car.z - before.z;
    const d = Math.hypot(dx, dz);
    if (!(d > 0) || !(v >= KNOCK.min)) return;
    const recent = (player.bikeKnocks ?? []).filter((t) => now - t < 1000 && now - t >= 0);
    player.bikeKnocks = recent;
    if (recent.length >= KNOCK.most) return;
    const spec = this.env.carSpec(car);
    if (!spec) return;
    const box = { halfL: spec.length / 2, halfW: spec.width / 2 };
    const to = { x: car.x, z: car.z, yaw: car.yaw };
    const { halfL, halfW } = this.bikeBox();
    for (const bike of Object.values(g.bikes)) {
      if (bike.rider || recent.length >= KNOCK.most) continue;
      if (Math.abs(bike.y - car.y) > KNOCK.height) continue;
      const last = this.knocks.get(bike.id)?.at;
      if (last !== undefined && now - last < KNOCK.again && now - last >= 0) continue;
      const at = sweptHit(box, before, to, { x: bike.x, z: bike.z, yaw: bike.yaw, halfL, halfW });
      if (!at || !this.carClear(spec, [...this.trails.get(car.id).points.slice(0, -1), at])) continue;
      // The parked cars near it, once for the whole throw (each step of the path asks about them).
      const parked = this.env.parked.filter((p) => Math.abs(p.x - bike.x) < KNOCK.far + 6 && Math.abs(p.z - bike.z) < KNOCK.far + 6);
      const rest = knockBike(bike, at, (dx / d) * v, (dz / d) * v, (x, z, yaw) => this.spotOk(x, z, yaw, car.id, parked));
      if (!rest) continue;
      Object.assign(bike, { x: rest.x, y: this.env.ground(rest.x, rest.z), z: rest.z, yaw: rest.yaw, lie: rest.lie });
      // Its way back to its spot counts from the first knock since it stood there or was ridden: a later one doesn't restart it.
      const home = this.knocks.get(bike.id)?.home;
      this.knocks.set(bike.id, { at: now, home: home ?? now + this.homeMs });
      recent.push(now);
      g.bikeAt[bike.id] = now;
      g.broadcastThing({ t: 'bike', bike, knock: { ms: rest.ms, v: Math.round(rest.v * 10) / 10 } }, 'bike', bike); // inside a home: only to those who may see in (Game.homeOf)
    }
  }

  /**
   * The car's speed for a throw (m/s): how far the server had the car go over the last KNOCK.window ms of its own
   * clock, and no more than KNOCK.gain over its speed in the window before that, so a jump within the movement budget
   * (from a standstill, the first state at the wheel, states squeezed together) buys no throw; at most the fastest car's.
   * The places are kept per car as the server took them (`trails`), started again for a new driver or a car the
   * server moved elsewhere (a portal, a placed car moved).
   */
  speedOf(car, name, before, now) {
    let trail = this.trails.get(car.id);
    const last = trail?.points.at(-1);
    if (!trail || trail.driver !== name || !last || Math.hypot(last.x - before.x, last.z - before.z) > 0.01) {
      trail = { driver: name, points: [{ t: -Infinity, x: before.x, z: before.z, yaw: before.yaw }] }; // it stood there until now
      this.trails.set(car.id, trail);
    }
    const p = trail.points;
    p.push({ t: now, x: car.x, z: car.z, yaw: car.yaw });
    const w = KNOCK.window;
    while (p.length > 2 && p[1].t <= now - 2 * w) p.shift(); // the newest before the two windows stays: where it was then
    // Where the server had the car at time t: between its two states round t (a jump after a silence is spread over the
    // silence, which only lowers the speed); before the first, where it stood.
    const at = (t) => {
      let i = 0;
      while (i + 1 < p.length && p[i + 1].t <= t) i++;
      const q = p[i];
      const r = p[i + 1];
      if (!r || !Number.isFinite(q.t)) return q;
      const f = (t - q.t) / (r.t - q.t);
      return { x: q.x + (r.x - q.x) * f, z: q.z + (r.z - q.z) * f };
    };
    const a = at(now - 2 * w);
    const b = at(now - w);
    const c = p.at(-1);
    const recent = Math.hypot(c.x - b.x, c.z - b.z) / (w / 1000);
    const before2 = Math.hypot(b.x - a.x, b.z - a.z) / (w / 1000);
    const v = Math.min(KNOCK.top, recent, before2 + KNOCK.gain);
    return Number.isFinite(v) ? v : 0;
  }

  /**
   * Whether the car's box was clear of every wall, hedge, fence and house the server knows (`solids`, as for a placed
   * car: kerbs and paving under 0.3 m don't count) all along `path`: the places the server had it over the last two
   * speed windows (speedOf), ending where it met the bike, in the sweep's steps, its heading turning between them as
   * the sweep's does. A car can't knock a bike from inside a wall or just after going through one. Heights from the
   * server's ground, not the page's.
   */
  carClear(spec, path) {
    const halfL = spec.length / 2;
    const halfW = spec.width / 2;
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1];
      const b = path[k];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / KNOCK.sweep));
      const turn = Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw));
      for (let i = k === 1 ? 0 : 1; i <= n; i++) {
        const f = i / n;
        const x = a.x + (b.x - a.x) * f;
        const z = a.z + (b.z - a.z) * f;
        const y = this.env.ground(x, z);
        if (!this.env.solids.boxFree(x, z, a.yaw + turn * f, halfL, halfW, y + 0.3, y + spec.height)) return false;
      }
    }
    return true;
  }

  /** Someone got on `bike`: it stands up, and stays where they leave it (no way back to its spot). */
  mounted(bike) {
    bike.lie = 0;
    this.knocks.delete(bike.id);
  }

  /**
   * Every tick: a knocked bike that has lain unused since its first knock for homeMs goes back to its own spot, for
   * everyone; while a car, a player or another bike stands on the spot it waits and tries again every few seconds.
   */
  home() {
    const now = this.env.mono();
    for (const [id, k] of this.knocks) {
      if (now < k.home) continue;
      const bike = this.game.bikes[id];
      const park = this.env.bikes.bikes[id]?.park;
      if (!bike || !park || bike.rider || !bike.lie) {
        this.knocks.delete(id);
        continue;
      }
      if (this.taken(id, park)) {
        k.home = now + HOME_RETRY_MS;
        continue;
      }
      this.knocks.delete(id);
      Object.assign(bike, { x: park.x, y: park.y, z: park.z, yaw: park.yaw, lie: 0 });
      this.game.bikeAt[id] = now;
      this.game.broadcastThing({ t: 'bike', bike, home: true }, 'bike', bike);
    }
  }

  /** Whether a car of the game, a player or another bike stands on bike `id`'s spot `park`. */
  taken(id, park) {
    const { halfL, halfW } = this.bikeBox();
    const box = { x: park.x, z: park.z, yaw: park.yaw, halfL, halfW };
    for (const c of Object.values(this.game.cars)) {
      const s = this.env.carSpec(c);
      if (s && Math.abs(c.y - park.y) < 2 && boxesOverlap(box, { x: c.x, z: c.z, yaw: c.yaw, halfL: s.length / 2, halfW: s.width / 2 }, 0.2)) return true;
    }
    for (const p of this.game.players.values()) {
      const st = p.state;
      if (st && Math.abs(st.y - park.y) < 2 && boxDistance(box, st.x, st.z) < 0.5) return true;
    }
    for (const k of Object.values(this.game.bikes)) {
      if (k.id !== id && Math.abs(k.y - park.y) < 2 && boxesOverlap(box, { x: k.x, z: k.z, yaw: k.yaw, halfL, halfW })) return true;
    }
    return false;
  }

  /** A lying bike's box (shared/bikeKnock.mjs KNOCK), and the standing bike's for the hit. */
  bikeBox() {
    return { halfL: this.env.bikes.length / 2, halfW: this.env.bikes.width / 2 };
  }

  /**
   * Whether a knocked bike may lie at (x, z) turned `yaw`, as far as the server knows the world: inside the
   * server's area, the whole edge of the game and the edge that holds now; off the portals, the start places
   * and out of the locked homes and the end house's garden (shared/bikeKnock.mjs clearSpot); outdoors; not
   * in a pond, a ditch or the garden's dip; clear of walls, hedges, fences and houses; not on a car parked
   * in the street or another car of the game (the one that hit it drives on).
   */
  spotOk(x, z, yaw, carId, parked = this.env.parked) {
    const e = this.env;
    const { halfL, halfW } = KNOCK;
    if (!(x >= e.area.x0 && x <= e.area.x1 && z >= e.area.z0 && z <= e.area.z1) || !Number.isFinite(yaw)) return false;
    if (!e.map.boxInside(x, z, yaw, halfL, halfW) || !this.game.fence().boxInside(x, z, yaw, halfL, halfW)) return false;
    const y = e.ground(x, z);
    if (!clearSpot(x, z, y, yaw)) return false;
    const points = boxPoints(x, z, yaw, halfL, halfW, 0.5);
    if (e.inside ? !e.inside.boxFree(x, z, yaw, halfL, halfW, 0, 1) : points.some(([px, pz]) => e.indoors(px, pz))) return false; // `inside`: the whole box
    if (points.some(([px, pz]) => this.dips.some((d) => px >= d.x0 && px <= d.x1 && pz >= d.z0 && pz <= d.z1 && inRing(px, pz, d.rim)))) return false;
    if (!e.solids.boxFree(x, z, yaw, halfL, halfW, y + 0.3, y + 1.0)) return false; // 0.3: kerbs and paving don't count, as for a car
    const box = { x, z, yaw, halfL, halfW };
    if (parked.some((p) => boxesOverlap(box, p))) return false; // `parked`: those near the bike (strike filters them once)
    for (const c of Object.values(this.game.cars)) {
      const s = c.id === carId ? null : e.carSpec(c);
      if (s && boxesOverlap(box, { x: c.x, z: c.z, yaw: c.yaw, halfL: s.length / 2, halfW: s.width / 2 })) return false;
    }
    return true;
  }
}
