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
//   against flooding: one hit per gun's delay (70% of it, for jitter, as for players), on top of the message guard;
// - a blast: the server's own rocket or grenade blast (Game.blast), by distance to the vehicle's box;
// - friendly fire: nobody damages a vehicle a teammate (or they themselves) sits in; an empty one anyone may.
// Stages: smoke under `smoke`, fire under `fire` (it then burns down by itself), at zero a wreck: everyone in it is put
// out and down, the kill the last attacker's (Game.damage, scored as any kill), and a blast like a grenade's round it
// (Game.blast, 'wreck'). A helicopter in the air falls. The wreck lies wreckMs, then is gone goneMs (at its parking
// place already, not drawn, nobody gets in), then it is back whole. The page shows it (src/world/vehicleWear.ts), as
// paint in the child-friendly look; the rules and numbers are the same.
import { readFileSync } from 'node:fs';

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
    if (now < (p.nextVHit || 0)) return;
    const v = this.vehicle(m.kind, m.id);
    if (!v || this.out(m.kind, m.id) || !g.seenBy(p, m.kind, v) || !this.mayDamage(name, m.kind, v)) return;
    if (!this.aimedAt(p, m.kind, v)) return;
    p.nextVHit = now + spec.delay * 700; // 70% of the fire delay, for network jitter (Game.hit's rule)
    p.protectedUntil = 0; // shooting ends your own spawn protection
    this.harm(m.kind, m.id, v, m.n * spec.body, name, m.w, now);
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
  blast(name, at, w, now) {
    if (!this.live || this.game.roundOver) return;
    const base = w === 'bazooka' ? this.weapons.bazooka.rocket : this.grenade;
    const k = VEHICLE.blast[w === 'bazooka' ? 'bazooka' : 'grenade'];
    for (const kind of KINDS) {
      const list = kind === 'car' ? Object.values(this.game.cars) : [...this.game.helis.machines.values()];
      for (const v of list) {
        if (this.out(kind, v.id) || !this.mayDamage(name, kind, v)) continue;
        const d = this.reach(kind, v, at.x, at.y, at.z);
        if (d < base.radius) this.harm(kind, v.id, v, Math.round(base.damage * k * (1 - d / base.radius)), name, w, now);
      }
    }
  }

  /** `amount` off vehicle `v`, by `name` with `w`: the stages it passes, and everyone told. */
  harm(kind, id, v, amount, name, w, now) {
    if (amount <= 0) return;
    const r = this.rec(kind, id);
    if (r.st >= STAGE.wreck) return;
    r.hp = Math.max(0, r.hp - amount);
    r.by = name;
    r.w = w;
    this.staged(r, v, now);
  }

  /** The stage its health is at; at zero it is destroyed. Told when its health (in whole percent) or its stage changed. */
  staged(r, v, now) {
    if (r.hp <= 0) return this.destroy(r, v, now);
    const st = r.hp < r.max * VEHICLE.fire ? STAGE.fire : r.hp < r.max * VEHICLE.smoke ? STAGE.smoke : STAGE.whole;
    const pct = Math.max(1, Math.ceil((r.hp / r.max) * 100));
    if (st === r.st && pct === r.pct) return;
    r.st = st;
    r.pct = pct;
    this.tell(r, v);
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
    for (const n of this.riders(r.kind, v)) {
      const q = g.players.get(n);
      if (shooter && q?.alive && n !== r.by && !g.modes.friends(r.by, n)) g.damage(r.by, shooter, n, q, q.hp, false, 'wreck', now);
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
    const mid = this.middle(r.kind, v);
    this.tell(r, v, { by: r.by ?? '', x: Math.round(mid.x * 100) / 100, y: Math.round(mid.y * 100) / 100, z: Math.round(mid.z * 100) / 100 });
    if (r.by) g.blast(r.by, { x: mid.x, y: mid.y, z: mid.z }, 'wreck');
  }

  /** Everyone who may see it is told its health and stage (`extra` on its destruction: who, and where it went up). */
  tell(r, v, extra = {}) {
    this.game.broadcastThing({ t: 'vdmg', k: r.kind, id: r.id, hp: r.pct, st: r.st, ...extra }, r.kind, v);
  }

  /** Back on its parking place, still and empty (a placed Tesla has none here: it stays where it lies). */
  home(r, v) {
    const g = this.game;
    if (r.kind === 'heli') return g.helis.park(v, Date.now());
    for (const n of this.riders('car', v)) g.releaseCar(n);
    const park = this.cars.cars[r.id]?.park;
    if (park) Object.assign(v, { x: park.x, y: park.y, z: park.z, yaw: park.yaw });
    v.s = 0;
    g.carAt[r.id] = this.mono();
    g.broadcastThing({ t: 'car', car: v }, 'car', v);
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
        if (r.st >= STAGE.wreck) this.home(r, v);
        this.recs.delete(key);
        this.tell({ ...r, pct: 100, st: STAGE.whole }, v);
        continue;
      }
      if (r.fall) this.fall(r, v, dt);
      if (r.st === STAGE.fire) {
        r.hp -= r.max * VEHICLE.burn * dt;
        this.staged(r, v, now);
      } else if (r.st === STAGE.wreck && now >= r.until) {
        r.st = STAGE.gone;
        r.until = now + VEHICLE.goneMs;
        r.fall = null;
        this.home(r, v);
        this.tell(r, v);
      } else if (r.st === STAGE.gone && now >= r.until) {
        this.recs.delete(key);
        this.tell({ ...r, pct: 100, st: STAGE.whole }, v);
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
