// Cars and helicopters take damage, only while a team-against-team match is on (Game.modes.teamMatch; Yoshi, 16 Nov
// 2026: "cars and helicopters must take damage and be able to get destroyed in the team v team matches"). Outside it
// every vehicle is as before. Bikes and horses never take damage, and crashing does none.
//
// The server decides every hit (the numbers: shared/vehicleDamage.json):
// - a bullet: the page says only which vehicle its shot met, with which gun and how many pellets (`vhit`). The damage is
//   the gun's own (shared/weapons.json body), never a number from the page; the rest is checked as a hit on a player is
//   (Game.hit): a gun they carry and hold, alive and armed, not seated, off the school grounds, its fire rate on a clock
//   of its own, its pellet count, the vehicle within MAX_HIT_RANGE of where the server has them and in front of their
//   eyes (their yaw and pitch, within the vehicle's own size and aimSlack), and a vehicle they may see (not in a home
//   they may not see into). Against hit forgery: a page can at most send a hit its own player could have shot;
//   against flooding: the one clock of a player's hits (Game.hit's nextHit, 70% of the gun's delay), so one shot counts
//   once, on a player or on a vehicle, never on both; on top of the message guard;
// - a blast: the server's own rocket or grenade blast (Game.blast), by distance to the vehicle's box;
// - friendly fire: nobody damages a vehicle a teammate (or they themselves) sits in; an empty one anyone may;
// - the school grounds stay free of shooting: no damage at all while the vehicle or the shooter is on them (shot, blast,
//   and no burning there either);
// - the code-locked homes (server/homeGate.mjs): nobody damages a vehicle with someone in it they could not hurt
//   (gate.mayHurt, as Game.hit; for a blast Game.mayBlast), and a destroyed vehicle's riders go down only when a hit on
//   them could have counted (Game.hit's gates: armed, out of spawn protection, off the school grounds, mayHurt), else
//   they get out alive. Who destroyed it is told only to those who may see that player (Game.broadcastEvent).
// Stages: smoke under `smoke`, fire under `fire` (it then burns down by itself), at zero a wreck: everyone in it is put
// out and down, the kill the last attacker's (Game.damage, scored as any kill), and a blast like a grenade's round it
// (Game.blast, 'wreck'). A helicopter in the air falls. The wreck lies wreckMs, then is gone goneMs (at its parking
// place already, not drawn, nobody gets in), then it is back whole. The page shows it (src/world/vehicleWear.ts), as
// paint in the child-friendly look; the rules and numbers are the same.
import { readFileSync } from 'node:fs';
import { boxesOverlap } from '../shared/parking.mjs';
import { noShoot } from '../shared/zones.mjs';

const shared = (file) => JSON.parse(readFileSync(new URL(`../shared/${file}`, import.meta.url), 'utf8'));
export const VEHICLE = shared('vehicleDamage.json');

/** The stages a page is told (`st`): whole, smoking, burning, a wreck, gone (back whole later). */
export const STAGE = { whole: 0, smoke: 1, fire: 2, wreck: 3, gone: 4 };
const KINDS = new Set(['car', 'heli']);
const ID = /^[A-Za-z0-9_-]{1,32}$/;
const G = 9.81;

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class VehicleDamage {
  /**
   * `game`: the Game (server/game.mjs). `weapons`, `grenade`: shared/weapons.json and shared/grenade.json. `cars`:
   * shared/car.json (the parking places); `carSpec(car)`: a car's size; `heli`: shared/heli.json's size; `maxRange`: the
   * furthest a bullet hits (m); `mono()`: the ticks' clock (a moved vehicle's stamp).
   */
  constructor(game, { weapons, grenade, cars, carSpec, heli, maxRange, mono }) {
    Object.assign(this, { game, weapons, grenade, cars, carSpec, heli, maxRange, mono });
    /** `${kind}:${id}` -> { kind, id, hp, max, st, by, w, until, fall } for every vehicle not whole now. */
    this.recs = new Map();
    this.last = null;
  }

  /** Damage counts now: a team-against-team match is on. */
  get live() {
    return !!this.game.modes?.teamMatch;
  }

  /** The vehicle itself (a car of Game.cars, a machine of Helis), or null. */
  vehicle(kind, id) {
    if (kind === 'car') return Object.hasOwn(this.game.cars, id) ? this.game.cars[id] : null;
    if (kind === 'heli') return this.game.helis.machines.get(id) ?? null;
    return null;
  }

  /** Who sits in it. */
  riders(kind, v) {
    return (kind === 'car' ? [v.driver, v.passenger] : v.seats).filter((n) => typeof n === 'string');
  }

  /** A wreck, or gone: nobody gets in (Game's car and heli messages ask). */
  out(kind, id) {
    const r = this.recs.get(`${kind}:${id}`);
    return !!r && r.st >= STAGE.wreck;
  }

  /**
   * Its box in its own frame (m): ±hx across, z0 to z1 along (to the back), y0 to y1 over its y; and its middle there.
   * A car's nose is along -z turned by its yaw (shared/car.json); a helicopter's from its nose to its tail (heli.json).
   */
  box(kind, v) {
    if (kind === 'car') {
      const s = this.carSpec(v);
      return { hx: s.width / 2, z0: -s.length / 2, z1: s.length / 2, y0: 0, y1: s.height };
    }
    const h = this.heli;
    return { hx: h.stabiliser.halfX, z0: h.nose, z1: h.tail, y0: 0, y1: h.boom.y1 };
  }

  /** A world point in the vehicle's frame: [across, along (to the back), up]. */
  local(v, x, y, z) {
    const dx = x - v.x, dz = z - v.z;
    const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
    return [dx * c - dz * s, dx * s + dz * c, y - v.y];
  }

  /** How far a world point is from the vehicle's box (0 inside it). */
  reach(kind, v, x, y, z) {
    const b = this.box(kind, v);
    const [lx, lz, ly] = this.local(v, x, y, z);
    return Math.hypot(Math.max(0, Math.abs(lx) - b.hx), Math.max(0, b.z0 - lz, lz - b.z1), Math.max(0, b.y0 - ly, ly - b.y1));
  }

  /** The middle of its box in the world, and the radius round it that holds the box. */
  middle(kind, v) {
    const b = this.box(kind, v);
    const lz = (b.z0 + b.z1) / 2;
    const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
    return { x: v.x + lz * s, y: v.y + (b.y0 + b.y1) / 2, z: v.z + lz * c, r: Math.hypot(b.hx, (b.z1 - b.z0) / 2, (b.y1 - b.y0) / 2) };
  }

  rec(kind, id) {
    const key = `${kind}:${id}`;
    let r = this.recs.get(key);
    if (!r) {
      const max = VEHICLE.health[kind];
      r = { kind, id, hp: max, max, st: STAGE.whole, by: null, w: null, until: 0, fall: null, pct: 100 };
      this.recs.set(key, r);
    }
    return r;
  }

  /** Whether `name` may damage vehicle `v` now: never one they or a teammate sit in (Game.modes.friends). */
  mayDamage(name, kind, v) {
    return this.riders(kind, v).every((r) => r !== name && !this.game.modes.friends(name, r));
  }

  /** On the school grounds (shared/zones.mjs): its middle there. Nothing damages it there, and it doesn't burn. */
  calm(kind, v) {
    const mid = this.middle(kind, v);
    return noShoot(mid.x, mid.z);
  }

  /** Someone in it that `p` could not hurt (one of them inside a home the other may not see into, homeGate.mayHurt). */
  hidden(p, kind, v) {
    return this.riders(kind, v).some((n) => {
      const q = this.game.players.get(n);
      return !!q && !this.game.gate.mayHurt(p, q);
    });
  }

  /**
   * A `vhit` from a shooter's page: `m.kind` ('car' or 'heli'), `m.id`, `m.w` the gun, `m.n` the pellets that met it.
   * Every check a hit on a player has, the vehicle's own place for the range and the aim (see the file's head).
   */
  hit(name, p, m, now) {
    const g = this.game;
    if (!this.live || g.roundOver || g.room) return;
    if (!KINDS.has(m.kind) || typeof m.id !== 'string' || !ID.test(m.id) || typeof m.w !== 'string' || !Object.hasOwn(this.weapons, m.w)) return;
    const spec = this.weapons[m.w];
    if (spec.rocket || !Number.isInteger(m.n) || m.n < 1 || m.n > spec.pellets) return; // a rocket hurts through its blast
    const s = p.state;
    if (!s || !p.alive || !s.armed || !p.weapons?.has(m.w) || s.w !== m.w || g.inCar(name) || g.calm(p)) return;
    if (now < (p.nextHit || 0)) return; // the one clock of all hits (Game.hit): a shot counts once, on a player or a vehicle
    const v = this.vehicle(m.kind, m.id);
    if (!v || this.out(m.kind, m.id) || !g.seenBy(p, m.kind, v) || !this.mayDamage(name, m.kind, v)) return;
    if (this.calm(m.kind, v) || this.hidden(p, m.kind, v) || !this.aimedAt(p, m.kind, v)) return;
    p.nextHit = now + spec.delay * 700; // 70% of the fire delay, for network jitter (Game.hit's rule)
    p.protectedUntil = 0; // shooting ends your own spawn protection
    this.harm(m.kind, m.id, v, m.n * spec.body, name, m.w, now, g.sight(p)); // who could see whom at the shot (Game.sight)
  }

  /**
   * The shooter's eyes (where the server has them, their yaw and pitch) see the vehicle: its box within maxRange, and
   * the way they look within the vehicle's own size (as seen from there) and aimSlack of its middle.
   */
  aimedAt(p, kind, v) {
    const s = p.state;
    const eye = { x: s.x, y: s.y + (s.c ? 1.15 : 1.6), z: s.z };
    if (this.reach(kind, v, eye.x, eye.y, eye.z) > this.maxRange) return false;
    const mid = this.middle(kind, v);
    const d = Math.hypot(mid.x - eye.x, mid.y - eye.y, mid.z - eye.z);
    if (d <= mid.r) return true; // right by it
    const yaw = Number(s.yaw) || 0;
    const pitch = Number(s.pitch) || 0;
    const f = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    const dot = (f[0] * (mid.x - eye.x) + f[1] * (mid.y - eye.y) + f[2] * (mid.z - eye.z)) / d;
    return Math.acos(Math.max(-1, Math.min(1, dot))) <= Math.asin(Math.min(1, mid.r / d)) + VEHICLE.aimSlack;
  }

  /**
   * A rocket's or a grenade's blast of `name`'s at `at` (Game.blast, after it hurt the players): every vehicle whose box
   * is within its radius loses its blast damage times VEHICLE.blast, less with the distance. A destroyed vehicle's own
   * blast ('wreck') sets off the others as a grenade's would.
   */
  blast(name, at, w, now, act = null) {
    const g = this.game;
    const shooter = g.players.get(name);
    if (!this.live || g.roundOver || !shooter || g.calm(shooter)) return;
    const base = w === 'bazooka' ? this.weapons.bazooka.rocket : this.grenade;
    const k = VEHICLE.blast[w === 'bazooka' ? 'bazooka' : 'grenade'];
    for (const kind of KINDS) {
      const list = kind === 'car' ? Object.values(this.game.cars) : [...this.game.helis.machines.values()];
      for (const v of list) {
        if (this.out(kind, v.id) || !this.mayDamage(name, kind, v) || this.calm(kind, v) || !g.seenBy(shooter, kind, v)) continue;
        if (this.riders(kind, v).some((n) => g.players.has(n) && !g.mayBlast(shooter, g.players.get(n), n, at, act))) continue; // someone in it out of the blast's sight
        const d = this.reach(kind, v, at.x, at.y, at.z);
        if (d < base.radius) this.harm(kind, v.id, v, Math.round(base.damage * k * (1 - d / base.radius)), name, w, now, act);
      }
    }
  }

  /**
   * `amount` off vehicle `v`, by `name` with `w`: the stages it passes, and everyone told. `act`: who could see whom when it
   * was done (Game.sight: the home the attacker stood in, the players out of their sight), kept for its destruction.
   */
  harm(kind, id, v, amount, name, w, now, act = null) {
    if (amount <= 0) return;
    const r = this.rec(kind, id);
    if (r.st >= STAGE.wreck) return;
    r.hp = Math.max(0, r.hp - amount);
    r.by = name;
    r.w = w;
    r.act = act;
    this.staged(r, v, now);
  }

  /**
   * The stage its health is at; at zero it is destroyed. When its health (in whole percent) or its stage changed it is
   * told on the next tick, once however many hits came in between (tick: at most one `vdmg` a tick for each vehicle).
   */
  staged(r, v, now) {
    if (r.hp <= 0) return this.destroy(r, v, now);
    const st = r.hp < r.max * VEHICLE.fire ? STAGE.fire : r.hp < r.max * VEHICLE.smoke ? STAGE.smoke : STAGE.whole;
    const pct = Math.max(1, Math.ceil((r.hp / r.max) * 100));
    if (st === r.st && pct === r.pct) return;
    r.st = st;
    r.pct = pct;
    r.dirty = true;
  }

  /**
   * At zero: a wreck. Everyone in it is put out; the last attacker's foes among them are down, the kill theirs (and their
   * team's, as any kill: Game.damage). A teammate of theirs who got into a burning vehicle (or someone when the attacker
   * has left) gets out alive. Then a blast like a grenade's round it, and a helicopter in the air falls.
   */
  destroy(r, v, now) {
    const g = this.game;
    r.hp = 0;
    r.pct = 0;
    r.st = STAGE.wreck;
    r.until = now + VEHICLE.wreckMs;
    const shooter = r.by ? g.players.get(r.by) : null;
    const mid = this.middle(r.kind, v);
    const at = { x: Math.round(mid.x * 100) / 100, y: Math.round(mid.y * 100) / 100, z: Math.round(mid.z * 100) / 100 };
    for (const n of this.riders(r.kind, v)) {
      const q = g.players.get(n);
      if (this.downed(shooter, r, q, n, at, now)) g.damage(r.by, shooter, n, q, q.hp, false, 'wreck', now, (msg) => this.named(r, msg, 'killer', g.gate.insideOf(q)));
      else if (r.kind === 'car') g.releaseCar(n);
      else g.helis.putOut(n, now);
    }
    if (r.kind === 'car') {
      v.s = 0;
    } else {
      Object.assign(v, { n: 0, p: 0, r: 0, g: v.y - g.helis.floor(v.x, v.z) > 0.5 ? 0 : 1 });
      if (!v.g) r.fall = { v: 0 };
      g.helis.at[v.id] = this.mono();
    }
    r.dirty = false; // this one says it all
    this.named(r, { t: 'vdmg', k: r.kind, id: r.id, hp: 0, st: r.st, by: r.by ?? '', ...at }, 'by', g.homeOf(r.kind, v));
    if (r.by) g.blast(r.by, at, 'wreck', new Set(), r.act); // its blast with the act of the hit that did it (Game.mayBlast)
  }

  /**
   * A message naming the last attacker in `field` (the destruction's `by`, a rider's kill's `killer`), to everyone who may
   * see `home` (null: everyone), the name blanked ('') for those the attacker is hidden from now or was at the hit
   * (Game.broadcastEvent's and Game.mayBlast's rules with the hit's act: inside a home they may not see into, or out of
   * their sight then), so no message tells who is or was inside a home. The admin's watch views get it whole.
   */
  named(r, msg, field, home) {
    const g = this.game;
    const doer = r.by ? g.players.get(r.by) : null;
    const act = r.act;
    if (!act && (!doer || !g.gate.insideOf(doer))) return g.broadcastHome(msg, home);
    const full = JSON.stringify(msg);
    const blind = JSON.stringify({ ...msg, [field]: '' });
    for (const [n, q] of g.players) {
      if (q.ws.readyState !== q.ws.OPEN || (home && !g.gate.may(q, home))) continue;
      const hidden = (doer && g.gate.hides(doer, q)) || (act?.home && !g.gate.may(q, act.home)) || !!act?.unseen?.has(n);
      q.ws.send(hidden ? blind : full);
    }
    for (const w of g.watchers) if (w.ws.readyState === w.ws.OPEN) w.ws.send(full);
  }

  /**
   * Whether rider `q` (`n`) goes down with the wreck, the kill `by`'s: only when a hit of theirs on them could have counted
   * (Game.hit's gates): the attacker still here and off the school grounds, the rider alive, armed, not their teammate,
   * out of spawn protection and off the school grounds, neither out of the other's sight now nor when the hit was dealt
   * (Game.mayBlast with the hit's act, as a grenade's blast: homeGate.mayHurt, the home it came from, the unseen).
   */
  downed(shooter, r, q, n, at, now) {
    const g = this.game;
    const by = r.by;
    if (!shooter || !q?.alive || !q.state?.armed || n === by || g.modes.friends(by, n)) return false;
    if (now < (q.protectedUntil || 0) || g.calm(q) || g.calm(shooter)) return false;
    return g.mayBlast(shooter, q, n, at, r.act);
  }

  /** Everyone who may see it is told its health and stage (`extra` on its destruction: who, and where it went up). */
  tell(r, v, extra = {}) {
    this.game.broadcastThing({ t: 'vdmg', k: r.kind, id: r.id, hp: r.pct, st: r.st, ...extra }, r.kind, v);
  }

  /**
   * Back on its parking place, still and empty, when that place is clear: nobody on foot standing there and no other car
   * on it (a helicopter: Helis.home's own rule, nobody within 6 m of its pad). True when it went (or has no parking place:
   * a spawned Tesla stays where it lies); false: it waits, and the next tick tries again. `force` (the match is over):
   * a place not clear leaves it whole where it lies.
   */
  home(r, v, force = false) {
    const g = this.game;
    if (r.kind === 'heli') return g.helis.home(v, Date.now()) || force;
    const park = this.cars.cars[r.id]?.park;
    if (park && !this.clear(v, park)) return force;
    for (const n of this.riders('car', v)) g.releaseCar(n);
    if (park) Object.assign(v, { x: park.x, y: park.y, z: park.z, yaw: park.yaw });
    v.s = 0;
    g.carAt[r.id] = this.mono();
    g.broadcastThing({ t: 'car', car: v }, 'car', v);
    return true;
  }

  /** Car `v`'s parking place `park` is clear: no player on foot within its outline and 30 cm, no other car over it. */
  clear(v, park) {
    const g = this.game;
    const s = this.carSpec(v);
    const box = { x: park.x, z: park.z, yaw: park.yaw, halfL: s.length / 2 + 0.3, halfW: s.width / 2 + 0.3 };
    for (const [n, p] of g.players) {
      if (p.state && !g.inCar(n) && Math.abs(p.state.y - park.y) < 2.5 && boxesOverlap(box, { x: p.state.x, z: p.state.z, yaw: 0, halfL: 0.35, halfW: 0.35 })) return false;
    }
    for (const c of Object.values(g.cars)) {
      if (c === v) continue;
      const o = this.carSpec(c);
      if (Math.abs(c.y - park.y) < 2.5 && boxesOverlap(box, { x: c.x, z: c.z, yaw: c.yaw, halfL: o.length / 2, halfW: o.width / 2 })) return false;
    }
    return true;
  }

  /**
   * From the game's tick: a burning vehicle burns down, a destroyed helicopter falls, a wreck goes and comes back. Once
   * no team match is on, every vehicle is whole again at once (a wreck back at its parking place).
   */
  tick(now) {
    const dt = this.last === null ? 0 : Math.min(0.5, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    if (!this.recs.size) return;
    const live = this.live;
    for (const [key, r] of this.recs) {
      const v = this.vehicle(r.kind, r.id);
      if (!v) {
        this.recs.delete(key);
        continue;
      }
      if (!live) {
        if (r.st >= STAGE.wreck && !r.homed) this.home(r, v, true);
        this.recs.delete(key);
        this.tell({ ...r, pct: 100, st: STAGE.whole }, v);
        continue;
      }
      if (r.fall) this.fall(r, v, dt);
      if (r.st === STAGE.fire && !this.calm(r.kind, v)) {
        r.hp -= r.max * VEHICLE.burn * dt;
        this.staged(r, v, now);
      } else if (r.st === STAGE.wreck && now >= r.until) {
        // Gone: off its spot (the page draws it nowhere, with nothing to bump into) and to its parking place once clear.
        r.st = STAGE.gone;
        r.until = now + VEHICLE.goneMs;
        r.fall = null;
        r.homed = this.home(r, v);
        r.dirty = true;
      } else if (r.st === STAGE.gone) {
        if (!r.homed) r.homed = this.home(r, v);
        if (r.homed && now >= r.until) { // back whole only on its parking place, and not before its time
          this.recs.delete(key);
          this.tell({ ...r, pct: 100, st: STAGE.whole }, v);
          continue;
        }
      }
      if (r.dirty && this.recs.has(key)) {
        r.dirty = false;
        this.tell(r, v);
      }
    }
  }

  /** A destroyed helicopter drops to the server's floor under it (the relief: it knows no roofs). */
  fall(r, v, dt) {
    const floor = this.game.helis.floor(v.x, v.z);
    r.fall.v += G * dt;
    v.y = Math.max(floor, v.y - r.fall.v * dt);
    v.yaw = wrap(v.yaw + dt * 1.5); // it spins as it falls
    if (v.y <= floor) {
      v.g = 1;
      r.fall = null;
    }
    this.game.helis.at[v.id] = this.mono();
  }

  /** For a page that joins: every vehicle not whole now, as `vdmg` would tell it, those it may see. */
  view(p) {
    const out = [];
    for (const r of this.recs.values()) {
      const v = this.vehicle(r.kind, r.id);
      if (v && this.game.seenBy(p, r.kind, v)) out.push({ k: r.kind, id: r.id, hp: r.pct, st: r.st });
    }
    return out;
  }
}
