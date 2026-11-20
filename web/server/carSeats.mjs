// The cars' seats on the server (game.mjs keeps the cars: who drives, who rides along, where each stands). A car has a
// driver and one passenger; the driver's state is the car's pose (as before), and from here on everyone in a car is where
// the car is. A bike's rider is the bike, so nobody is pinned to one, but a saddle is held to the same refused set.
//
// Guarded against (the attack table: DECISIONS.md, "A car's passenger sits in the car"):
// - position forgery and a speed hack through a seat: a passenger's own x, y, z are never taken; their state is the car's
//   centre (as an honest passenger's page sends it), and the driver's every step takes the passenger along. Before, a
//   passenger moved by itself at the car's speed budget while counting as in the car;
// - carrying someone into a code-locked home: the driver's step is put back when the car would take a passenger into a
//   home they have no right to (as the passenger's own steps were before), whoever drives;
// - leaping out: on getting out (and on a death, a respawn, a game's gathering, the car taken away; a disconnect leaves them
//   at the car's centre for a reconnect) the server puts them beside the car by the page's own rule (their door, else the other side, behind, in front), never into a wall
//   the server knows, a code-locked home without the right or outside the edge; else at the car's centre, and a centre in
//   such a home puts them out of it (Game.putOut). Their movement budgets start again from there; nobody gets into a car
//   standing where they may not stand (Game.enterCar);
// - taking and hurting from a seat or a saddle: one early gate in Game.handle drops SEAT_REFUSED from a car or a bike
//   (pickups, coins, tags, cats, villagers, clowns, the football, the Zombies game's things, every shot and blast, doors).
//   Being tagged in a car stays possible: the party games' rules ("whoever is it tags someone else") hold, and a car is no
//   hiding place. Hits and blasts agree: nobody in a car, on a bike or in a helicopter is hurt by either (Game.inCar).
// Every other type is let through (SEAT_ALLOWED), each with its own checks; server/carSeats.test.mjs fails when a type
// Game.handle reads is in neither list.
import { homeAt } from '../shared/homes.mjs';

/** What nobody sends from a car's seat or a bike's saddle: everything that takes, collects, tags, hurts, shoots or opens. */
export const SEAT_REFUSED = new Set([
  'hit', 'vhit', 'rocket', 'nade', 'boom', 'shot', 'crack', 'glass', 'vil', 'cat', 'clownhit',
  'zhit', 'zitem', 'zbuy', 'revive', 'claymore', 'turret', 'stakes', 'placement',
  'pickup', 'coin', 'tag', 'kickball', 'door', 'asup', 'sphit', 'gl',
]);

/**
 * Let through from a seat, each to its own checks: moving and the vehicles (state; car out; horse, bike and helicopter,
 * whose getting on refuses anyone in a car; bell, only a bike's rider), talking (chat, pong, rally), trips and start
 * places (travel: only the driver takes the car through; spawn, chute, unstuck refuse a seat and answer), the admin's
 * powers and the building tools (repair, furn, tesla, clown, mode, zwave, team, newround, rules, mood, moodskip,
 * moodspeed, kick).
 */
export const SEAT_ALLOWED = [
  'state', 'car', 'horse', 'bike', 'heli', 'bell', 'chat', 'pong', 'rally', 'travel', 'spawn', 'chute', 'unstuck',
  'repair', 'furn', 'tesla', 'clown', 'mode', 'zwave', 'team', 'newround', 'rules', 'mood', 'moodskip', 'moodspeed', 'kick',
];

export class CarSeats {
  /**
   * `game`: the Game (server/game.mjs). `spec(car)`: the car's model (its length and width). `free(x, z, y0, y1)`: no wall
   * the server knows in a standing person's box there (the page's own test for an exit spot).
   */
  constructor(game, { spec, free }) {
    this.game = game;
    this.spec = spec;
    this.free = free;
  }

  /** In a car's seat or on a bike's saddle (Game.handle asks only for a type in SEAT_REFUSED). */
  seated(name) {
    return !!this.game.carOf(name) || !!this.game.bikeOf(name);
  }

  /** A passenger's state: their own position is never taken, they are where the car is (looking round stays theirs). */
  pin(car, next) {
    next.x = car.x;
    next.y = car.y;
    next.z = car.z;
  }

  /**
   * The driver's step `prev` to `next` (after the budgets, the edge and the driver's own home gate), before the car takes
   * it: never into a code-locked home its passenger has no right to (the step is put back, in place). A passenger found
   * inside one already (their right ended while the car stood in it) is put out there, as a walker would be. Then the
   * passenger goes along.
   */
  carry(car, prev, next, now) {
    const g = this.game;
    const q = car.passenger ? g.players.get(car.passenger) : null;
    if (!q?.state) return;
    const barred = g.gate.keepOut(q, prev, next);
    if (barred?.put) {
      g.releaseCar(car.passenger);
      g.putOut(q, q.state, barred.home, now);
      return;
    }
    Object.assign(q.state, { x: next.x, y: next.y, z: next.z });
  }

  /**
   * Where `p` stands after leaving `car` (`passenger`: from the passenger's seat): the page's own rule (world/car.ts
   * exitSpot), by their door (the driver's on the left, the passenger's on the right), else the other side, behind or in
   * front; the first with no wall the server knows, inside the edge and not in a code-locked home without the right.
   * None: the car's centre (where a driver's state always was).
   */
  exitSpot(p, car, passenger) {
    const g = this.game;
    const spec = this.spec(car);
    const halfW = (spec?.width ?? 2) / 2, halfL = (spec?.length ?? 4.7) / 2;
    const fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
    const side = passenger ? halfW + 0.45 : -(halfW + 0.45);
    const fence = g.fence();
    for (const [s, ahead] of [[side, 0.3], [-side, 0.3], [0, -(halfL + 0.5)], [0, halfL + 0.5]]) {
      const x = car.x + fx * ahead - fz * s, z = car.z + fz * ahead + fx * s;
      if (fence.inside(x, z) && g.gate.mayStand(p, x, car.y, z) && this.free(x, z, car.y + 0.5, car.y + 1.8)) return { x, y: car.y, z };
    }
    return { x: car.x, y: car.y, z: car.z };
  }

  /**
   * `name` leaves `car` (Game.releaseCar, before the seat is emptied): out beside it (exitSpot), on foot, the movement
   * budgets started again there, so nothing stored lets them leap. A connection already gone has no state to move. Where
   * they end up is asked of the homes once more: the car's centre (the fallback) may lie in a code-locked home they have
   * no right to (a car left there by a code's holder), and then they are put out of it at once (Game.putOut), as a walker
   * whose right ended would be.
   */
  out(name, car) {
    const g = this.game;
    const p = g.players.get(name);
    if (!p?.state) return;
    Object.assign(p.state, this.exitSpot(p, car, car.passenger === name), { d: false, s: 0 });
    p.budget = p.vbudget = 0.5;
    p.movedAt = Date.now();
    const home = homeAt(p.state.x, p.state.z, p.state.y);
    if (home && !g.gate.may(p, home)) g.putOut(p, p.state, home, p.movedAt);
  }
}
