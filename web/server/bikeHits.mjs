// A car that drives into a bike nobody rides knocks it over or throws it aside (shared/bikeKnock.mjs),
// decided here together. There is no message for it: the server finds the hit itself in the driver's
// states it already gets and checks (game.mjs `state`: the movement budget, the edge, the locked homes),
// with its own record of the car and of the bike, and works out the resting place itself. Every page
// is told the same place in a 'bike' message with `knock`, and a page that joins later gets the bike
// where it lies. What a page could forge:
// - a bike moved anywhere: no place is ever read from a page. A bike moves only where the server's car
//   passes over the server's bike, at most 8 m, to a place the server works out (`spotOk`);
// - knocking from across the map: the car's place is the driver's, held to the car's speed budget
//   before it gets here, and the sweep runs only from the car's last place to its new one, at most
//   half a second apart; the speed is worked out from those two places, at most the fastest car's;
// - a ridden bike, or its rider, knocked off: a ridden bike is never knocked (it stops the car, as a
//   player on foot does);
// - flooding: no new message; this runs in the state handler (30 a second at most), each bike knocked
//   at most every 400 ms, each driver at most 6 a second;
// - griefing by throwing a bike into a private home, onto a start place or a portal's pad, indoors, into
//   a pond or a wall: `spotOk` refuses all of them and the path ends before the first such step.
import { boxesOverlap, boxPoints } from '../shared/parking.mjs';
import { clearSpot, KNOCK, KNOCK_HOME_MS, knockBike, sweptHit } from '../shared/bikeKnock.mjs';

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
   * world: `solids` (shared/parking.mjs makeSolids), `indoors(x, z)`, `parked` (the street's parked cars'
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
  }

  /**
   * The driver `name` sent a state that moved their car from `before` ({ x, y, z, yaw, at: its stamp then })
   * to where it is now (the server's own, after its checks): any free bike its box passed over is knocked.
   */
  strike(name, player, car, before, now) {
    const g = this.game;
    if (g.room || g.modes?.zombies || car.driver !== name || !before) return;
    // The speed from the server's two places of the car over their two stamps: none when they are more than
    // half a second apart (a car that stood, a page that slept, a car the server moved); a gap shorter than
    // 20 ms counts as 20 ms (no speed made up by states sent close together), and never past the fastest car.
    const gap = (g.carAt[car.id] ?? 0) - before.at;
    if (!(before.at > 0) || !(gap > 0) || gap > 500) return;
    const dx = car.x - before.x;
    const dz = car.z - before.z;
    const d = Math.hypot(dx, dz);
    if (!Number.isFinite(d) || d === 0) return;
    const v = Math.min(KNOCK.top, d / (Math.max(gap, 20) / 1000));
    if (v < KNOCK.min) return;
    const recent = (player.bikeKnocks ?? []).filter((t) => now - t < 1000);
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
      if (now - (this.knocks.get(bike.id)?.at ?? -Infinity) < KNOCK.again) continue;
      const at = sweptHit(box, before, to, { x: bike.x, z: bike.z, yaw: bike.yaw, halfL, halfW });
      if (!at) continue;
      const rest = knockBike(bike, at, (dx / d) * v, (dz / d) * v, (x, z, yaw) => this.spotOk(x, z, yaw, car.id));
      if (!rest) continue;
      Object.assign(bike, { x: rest.x, y: this.env.ground(rest.x, rest.z), z: rest.z, yaw: rest.yaw, lie: rest.lie });
      this.knocks.set(bike.id, { at: now, home: now + this.homeMs });
      recent.push(now);
      g.bikeAt[bike.id] = this.env.mono();
      g.broadcast({ t: 'bike', bike, knock: { ms: rest.ms, v: Math.round(rest.v * 10) / 10 } });
    }
  }

  /** Someone got on `bike`: it stands up, and stays where they leave it (no way back to its spot). */
  mounted(bike) {
    bike.lie = 0;
    this.knocks.delete(bike.id);
  }

  /** Every tick: a knocked bike that has lain unused for homeMs goes back to its own spot, for everyone. */
  home(now) {
    for (const [id, k] of this.knocks) {
      if (now < k.home) continue;
      this.knocks.delete(id);
      const bike = this.game.bikes[id];
      const park = this.env.bikes.bikes[id]?.park;
      if (!bike || !park || bike.rider || !bike.lie) continue;
      Object.assign(bike, { x: park.x, y: park.y, z: park.z, yaw: park.yaw, lie: 0 });
      this.game.bikeAt[id] = this.env.mono();
      this.game.broadcast({ t: 'bike', bike, home: true });
    }
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
  spotOk(x, z, yaw, carId) {
    const e = this.env;
    const { halfL, halfW } = KNOCK;
    if (!(x >= e.area.x0 && x <= e.area.x1 && z >= e.area.z0 && z <= e.area.z1) || !Number.isFinite(yaw)) return false;
    if (!e.map.boxInside(x, z, yaw, halfL, halfW) || !this.game.fence().boxInside(x, z, yaw, halfL, halfW)) return false;
    const y = e.ground(x, z);
    if (!clearSpot(x, z, y, yaw)) return false;
    const points = boxPoints(x, z, yaw, halfL, halfW, 0.5);
    if (points.some(([px, pz]) => e.indoors(px, pz))) return false;
    if (points.some(([px, pz]) => this.dips.some((d) => px >= d.x0 && px <= d.x1 && pz >= d.z0 && pz <= d.z1 && inRing(px, pz, d.rim)))) return false;
    if (!e.solids.boxFree(x, z, yaw, halfL, halfW, y + 0.3, y + 1.0)) return false; // 0.3: kerbs and paving don't count, as for a car
    const box = { x, z, yaw, halfL, halfW };
    if (e.parked.some((p) => boxesOverlap(box, p))) return false;
    for (const c of Object.values(this.game.cars)) {
      const s = c.id === carId ? null : e.carSpec(c);
      if (s && boxesOverlap(box, { x: c.x, z: c.z, yaw: c.yaw, halfL: s.length / 2, halfW: s.width / 2 })) return false;
    }
    return true;
  }
}
