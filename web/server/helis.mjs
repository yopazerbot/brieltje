// The helicopters in the shared house (shared/heli.json: the machines and their pads; shared/heli.mjs: the flight). The
// server owns every machine: its four seats (seat 0 flies, three passengers behind), who boards and who leaves, every
// pose its pilot's page reports, and the flights home. The pilot's page flies (shared/heli.mjs heliStep, as a car's
// driver drives) and reports the machine's pose in its ordinary state message; the server holds every claim to what the
// flight model can do. Nothing here is stored or logged: a restart puts every machine on its pad.
//
// Guarded against (the attack table: DECISIONS.md, "The helicopter together"):
// - seat forgery: a page never names a seat; the server gives the first free one, seat 0 first, on its own positions
//   (reach to the cabin's box in the machine's frame), one vehicle a player, a known id only (a Map: no `__proto__`);
// - position forgery and speed hacks: only the pilot's state moves a machine, held to three budgets from the flight's
//   own caps (HELI: across, up, down) and a turn budget, the tilt clamped, never under the server's floor; the edge and
//   the ceiling as for everyone (Game.fenceIn); a passenger's own position is never taken: they are where the machine is;
// - carrying someone into a code-locked home: a machine is never inside one, whoever flies it (five points of the
//   cabin at three heights against homeAt, every step; a breach puts the step back), code or no code, the admin too;
// - kidnapping: `out` is always granted, any seat, any height; a machine with nobody at the stick high up for
//   PILOTLESS_MS puts everyone out and goes home;
// - fighting from a seat or being hit in one: Game.inCar answers for a machine, one early gate in Game.handle drops
//   every fighting and taking message from a seat, and Game.blast skips those aboard;
// - flooding and replay: one 300 ms gate shared with the cars, horses and bikes; every op acts on the present state,
//   so a repeated one finds the seat already changed;
// - many machines: only heli.json makes them; no message does.
// Not checked, on purpose: walls other than the homes'. The server has none for cars or walkers either, and nothing
// counts from a seat (no hit, pickup, tag or timed route), so flying through a barn gains nothing.
import { readFileSync } from 'node:fs';
import { HELI } from '../shared/heli.mjs';
import { homeAt } from '../shared/homes.mjs';
import { HOME_DROP } from '../shared/parachute.mjs';
import { PORTALS } from '../shared/portals.mjs';
import { STALL_SPOTS } from '../shared/stall.mjs';

const shared = (file) => JSON.parse(readFileSync(new URL(`../shared/${file}`, import.meta.url), 'utf8'));
const DATA = shared('heli.json');
const SPAWNS = shared('spawns.json');

/** m/s across for a pilot: the flight's cap over the ground, with room for network jitter (as a car's 1.2). */
export const HELI_SPEED = HELI.V_CAP * 1.2;
/** m/s up for a pilot: the fastest climb, with room for jitter; a budget of its own (Helis.climb). */
export const HELI_UP = HELI.CLIMB_MAX * 1.3;
/** m/s down for a pilot: the fastest sink, with room for jitter. */
export const HELI_DOWN = HELI.SINK_CAP * 1.3;
/** rad/s of heading for a pilot: twice the hover's full turn (the fastest honest turn, shared/heli.mjs heliStep), one second stored. */
export const HELI_TURN = HELI.YAW_SLOW * 2;
/** rad: the most pitch or roll a pilot's state may report. */
export const HELI_TILT = 0.9;
/** ms high up with nobody at the stick before everyone aboard is put out and the machine goes home. */
export const PILOTLESS_MS = 20_000;
/** ms empty on a spot others need (a start place, a portal, the stall) before it goes home. */
export const IN_THE_WAY_MS = 20_000;
/** ms empty anywhere but a pad before it goes home. */
export const IDLE_MS = 300_000;
/** m: the most a reported position may differ from the one taken before the pilot's page is told the server's (`fix`). */
const FIX_M = 3;
/** ms between two `fix` messages to one pilot. */
const FIX_MS = 1000;

const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

const CABIN = DATA.size.cabin;
/** The cabin's five points in the model's frame (x right, z back), tested against the homes at three heights. */
const CABIN_POINTS = [[0, 0], [0, CABIN.z0], [0, CABIN.z1], [CABIN.halfX, -0.7], [-CABIN.halfX, -0.7]];
const CABIN_HEIGHTS = [0, 0.3, 1.5];
/** Where a machine counts as on a pad: the pads that are built (a `planned` one is not a pad yet). */
const PADS = DATA.pads.filter((q) => !q.planned);
/** The spots others need, [x, z]: the start places, each portal's pad and where you come out of it (on foot and by car), the house's start, the stalls. */
const NEEDED = [
  ...SPAWNS.map((s) => [s.x, s.z]),
  ...PORTALS.flatMap((q) => [[q.x, q.z], [q.out[0], q.out[1]], [q.car[0], q.car[1]]]),
  [HOME_DROP.x, HOME_DROP.z],
  ...STALL_SPOTS.map(([, x, z]) => [x, z]),
];

export class Helis {
  /**
   * `game`: the Game (server/game.mjs). `ground(x, z)`: the server's floor (the relief); `mono()`: the ticks' clock;
   * `calmMs`: how long after being hit nobody boards (no escaping a fight, as with /parachute).
   */
  constructor(game, { ground, mono, calmMs }) {
    this.game = game;
    this.ground = ground;
    this.mono = mono;
    this.calmMs = calmMs;
    /** id -> the machine as everyone may see it: { id, x, y, z, yaw, p, r, n, g, seats }. None in a Zombies room. */
    this.machines = new Map();
    /** id -> what only the server keeps: its park, since when nobody flies or sits in it, its recent poses. */
    this.inner = new Map();
    /** id -> when its pose was taken (the ticks' clock, ms). */
    this.at = {};
    const now = Date.now();
    for (const d of game.room ? [] : DATA.machines) {
      const h = { id: d.id, x: d.park.x, y: d.park.y, z: d.park.z, yaw: d.park.yaw, p: 0, r: 0, n: 0, g: 1, seats: [null, null, null, null] };
      this.machines.set(d.id, h);
      this.inner.set(d.id, { park: d.park, noPilotAt: null, emptyAt: now, trail: [] });
      this.at[d.id] = 0;
    }
  }

  /** The machine a player sits in, or null. The way to ask "is this player aboard a helicopter" (the state's checks, trackers). */
  of(name) {
    if (typeof name !== 'string') return null;
    for (const h of this.machines.values()) if (h.seats.includes(name)) return h;
    return null;
  }

  /** The machines as everyone may see them (welcome, the `heli` message): copies, nothing the server keeps for itself. */
  view() {
    return [...this.machines.values()].map((h) => this.pub(h));
  }

  pub(h) {
    return { id: h.id, x: h.x, y: h.y, z: h.z, yaw: h.yaw, p: h.p, r: h.r, n: h.n, g: h.g, seats: [...h.seats] };
  }

  /** Everyone is told the machine as it is now (a seat changed); `extra`: { home: 1 } on a flight home. */
  tell(h, extra = {}) {
    this.game.broadcastThing({ t: 'heli', heli: this.pub(h), ...extra }, 'heli', h); // one standing inside a home: only to those with its right (Game.homeOf)
  }

  /** The server's floor under (x, z): the relief. It knows no roofs, so nothing is decided from "on the ground". */
  floor(x, z) {
    return this.ground(x, z);
  }

  /** Within 3 m across and 1.5 m in height of a built pad. */
  atPad(h) {
    return PADS.some((q) => Math.hypot(h.x - q.x, h.z - q.z) <= 3 && Math.abs(h.y - q.y) <= 1.5);
  }

  /** More than 3 m over the server's floor, and not on a pad. */
  high(h) {
    return h.y - this.floor(h.x, h.z) > 3 && !this.atPad(h);
  }

  /** Its taken pose moved less than 1.5 m over the last 500 ms, or nobody flies it: a machine one may board. */
  slow(h, now) {
    if (!h.seats[0]) return true;
    const trail = this.prune(h, now);
    return trail.every((q) => Math.hypot(q.x - h.x, q.y - h.y, q.z - h.z) < 1.5);
  }

  /** Its poses of the last 500 ms, with the newest one from before them (where it was half a second ago). */
  prune(h, now) {
    const s = this.inner.get(h.id);
    const old = s.trail.findLastIndex((q) => now - q.t > 500);
    if (old > 0) s.trail = s.trail.slice(old);
    return s.trail;
  }

  /** How far a point is from the cabin's box (±skidX wide, cabin.z0 to cabin.z1 long) in the machine's frame (m, across). */
  reach(h, x, z) {
    const dx = x - h.x, dz = z - h.z;
    const c = Math.cos(h.yaw), s = Math.sin(h.yaw);
    const lx = dx * c - dz * s; // to the right
    const lz = dx * s + dz * c; // to the back
    return Math.hypot(Math.max(0, Math.abs(lx) - DATA.size.skidX), Math.max(0, CABIN.z0 - lz, lz - CABIN.z1));
  }

  /** Whether any of the cabin's points at pose (x, y, z, yaw) lies inside a code-locked home (shared/homes.mjs homeAt). */
  inHome(x, y, z, yaw) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (const [lx, lz] of CABIN_POINTS) {
      const px = x + lx * c + lz * s, pz = z - lx * s + lz * c;
      for (const dy of CABIN_HEIGHTS) if (homeAt(px, pz, y + dy)) return true;
    }
    return false;
  }

  /**
   * A `heli` message (Game.handle has let it through the 300 ms gate shared with the cars, horses and bikes):
   * `op` 'in' with a machine's `id`, 'out', 'fly' (take the stick from a passenger seat), 'jump'. Any other op: nothing.
   */
  ask(name, p, m, now) {
    if (m.op === 'in') return this.board(name, p, m.id, now);
    if (m.op === 'out') return this.out(name, now);
    if (m.op === 'jump') return this.jump(name, p, now);
    if (m.op === 'fly') return this.take(name, p, now);
  }

  /**
   * Boarding, in this order: a known id; no Zombies, no game, no room; the admin's rule on; not hit in the last calmMs;
   * then (silently) alive, in no car and on no horse, bike or machine, not flying, not in a drop, not held by the host;
   * the machine not moving; close to its cabin on the server's positions; a free seat, seat 0 first. Every refusal
   * tells the asker alone the machine as it is, so its page stops waiting.
   */
  board(name, p, id, now) {
    const g = this.game;
    if (typeof id !== 'string' || !this.machines.has(id)) return;
    const h = this.machines.get(id);
    if (!g.seenBy(p, 'heli', h)) return; // standing inside a home they may not see into: not through its wall, and not a word
    const no = (code, text) => {
      if (code) g.send(p.ws, { t: 'system', text, code });
      g.send(p.ws, { t: 'heli', heli: this.pub(h) });
    };
    if (g.modes.zombies) return no('zNoHeli', 'No flying during Zombies.');
    if (g.fenced()) return no('gameNoHeli', 'No helicopter during a game.');
    if (!g.rules.heli) return no('heliOff', 'The admin has turned the helicopter off.');
    if (now - (p.hurtAt ?? -Infinity) < this.calmMs) return no('heliFight', "You can't get in right after being hit.");
    const st = p.state;
    if (!p.alive || !st || g.carOf(name) || g.horseOf(name) || g.bikeOf(name) || this.of(name) || st.flying || g.dropping(p, now) || g.host?.holds(p)) return no();
    if (!this.slow(h, now)) return no();
    if (this.reach(h, st.x, st.z) > DATA.reach + 1 || Math.abs(st.y - h.y) > 1.5) return no();
    const seat = h.seats.indexOf(null);
    if (seat < 0) return no();
    this.enter(name, p, h, seat, now);
  }

  /** Into seat `seat`: the player is where the machine is from now on, their budgets start again. */
  enter(name, p, h, seat, now) {
    h.seats[seat] = name;
    Object.assign(p.state, { x: h.x, y: h.y, z: h.z, flying: false, c: false, a: false, d: true });
    p.budget = p.vbudget = 0.5;
    p.movedAt = now;
    if (seat === 0) this.stick(p, h, now);
    this.inner.get(h.id).emptyAt = null;
    this.game.moved(p);
    this.tell(h);
  }

  /** At the stick: the climb and turn budgets start small, the machine has a pilot again. */
  stick(p, h, now) {
    p.heliUp = 0.5;
    p.heliTurn = 0.5;
    p.nextFix = 0;
    const s = this.inner.get(h.id);
    s.noPilotAt = null;
    s.trail = [{ x: h.x, y: h.y, z: h.z, t: now }]; // its moves start again with this pilot, from here
  }

  /** Out, by the player's own wish: always granted, any seat, any height (nobody is carried off). */
  out(name, now) {
    this.release(name, now);
  }

  /** A jump with a parachute: package D gives it its drop. Until then a plain `out`, in this one place. */
  jump(name, p, now) {
    this.out(name, now);
  }

  /** From a passenger seat to the stick, when nobody flies it: alive, not held by the host, no game, the rule on. */
  take(name, p, now) {
    const g = this.game;
    const h = this.of(name);
    if (!h) return;
    const seat = h.seats.indexOf(name);
    if (seat < 1 || h.seats[0] || !p.alive || g.host?.holds(p) || g.fenced() || !g.rules.heli) return;
    h.seats[seat] = null;
    h.seats[0] = name;
    Object.assign(p.state, { x: h.x, y: h.y, z: h.z });
    p.budget = p.vbudget = 0.5;
    p.movedAt = now;
    this.stick(p, h, now);
    this.tell(h);
  }

  /**
   * A player leaves their seat (out, a disconnect, a death, a respawn, a gathering): they stand where the machine is
   * (`ground`: on the floor under it, for a connection that ends: a reconnect is checked from there), with walking's
   * budgets again. A pilot leaving leaves the machine where it is, without motion.
   */
  release(name, now, ground = false) {
    const h = this.of(name);
    if (!h) return;
    const seat = h.seats.indexOf(name);
    h.seats[seat] = null;
    const p = this.game.players.get(name);
    if (p?.state) {
      Object.assign(p.state, { x: h.x, y: ground ? this.floor(h.x, h.z) : h.y, z: h.z, d: false });
      p.budget = p.vbudget = 0.5;
      p.movedAt = now;
    }
    const s = this.inner.get(h.id);
    if (seat === 0) s.noPilotAt = now;
    if (h.seats.every((n) => !n)) s.emptyAt = now;
    this.tell(h);
  }

  /** The server puts a player out (nobody at the stick for too long, a game starting, the rule off). Package D gives it a parachute. */
  putOut(name, now) {
    this.release(name, now);
  }

  /** A passenger's state: their own position is never taken, they are where the machine is (looking round stays theirs). */
  pin(h, next) {
    Object.assign(next, { x: h.x, y: h.y, z: h.z });
  }

  /** What is left of the pilot's climb budget after going up by `dy` (refilled at HELI_UP, half a second stored): the rise allowed. */
  climb(p, dy, secs) {
    const left = Math.min(HELI_UP * 0.5 + 0.5, (p.heliUp ?? 0.5) + HELI_UP * Math.max(0, secs));
    const up = Math.max(0, Math.min(dy, left));
    p.heliUp = left - up;
    return dy > 0 ? up : dy;
  }

  /** The machine's new heading from the pilot's `yaw`: the change the short way round, within the turn budget. */
  turn(p, h, yaw, secs) {
    const left = Math.min(HELI_TURN, (p.heliTurn ?? 0.5) + HELI_TURN * Math.max(0, secs));
    const want = wrap(yaw - h.yaw);
    const step = Math.max(-left, Math.min(left, want));
    p.heliTurn = left - Math.abs(step);
    return wrap(h.yaw + step);
  }

  /**
   * The pilot's step after the budgets and the edge: never more than a metre under the server's floor, and never with
   * the cabin inside a code-locked home (for every pilot, the code's and the admin's too: nobody is carried in). A
   * breach puts the whole step back. True when it did.
   */
  pose(h, prev, next) {
    next.y = Math.max(next.y, this.floor(next.x, next.z) - 1);
    if (!this.inHome(next.x, next.y, next.z, next.yaw)) return false;
    Object.assign(next, { x: prev.x, y: prev.y, z: prev.z, yaw: h.yaw });
    return true;
  }

  /**
   * The pilot's step was taken (`next`, the state as kept; `sent`, where the page said): the machine takes the pose, its
   * tilt (±HELI_TILT), rotor (0 to 1) and rest (0 or 1) from the pilot's state only; everyone else aboard is where it is.
   * When the server changed the step by more than FIX_M, the pilot's page is told the server's pose (`fix`, at most once
   * every FIX_MS).
   */
  moved(name, p, h, next, m, sent, now) {
    Object.assign(h, {
      x: next.x, y: next.y, z: next.z, yaw: wrap(next.yaw),
      p: num(m.hp, -HELI_TILT, HELI_TILT), r: num(m.hr, -HELI_TILT, HELI_TILT), n: num(m.hn, 0, 1), g: m.hg ? 1 : 0,
    });
    this.at[h.id] = p.stamp;
    for (const other of h.seats) {
      if (!other || other === name) continue;
      const q = this.game.players.get(other);
      if (q?.state) Object.assign(q.state, { x: h.x, y: h.y, z: h.z });
    }
    const s = this.inner.get(h.id);
    s.trail.push({ x: h.x, y: h.y, z: h.z, t: now });
    this.prune(h, now);
    if (s.trail.length > 40) s.trail.shift(); // at most 30 states a second get here
    if (Math.hypot(sent.x - next.x, sent.y - next.y, sent.z - next.z) > FIX_M && now >= (p.nextFix || 0)) {
      p.nextFix = now + FIX_MS;
      this.game.send(p.ws, { t: 'heli', heli: this.pub(h), fix: 1 });
    }
  }

  /**
   * From the game's tick: a game running (or a room) or the rule off empties every machine and sends it home; high up
   * with nobody at the stick for PILOTLESS_MS puts everyone out and sends it home; empty on a spot others need for
   * IN_THE_WAY_MS, or anywhere but a pad for IDLE_MS, it goes home.
   */
  tick(now) {
    const g = this.game;
    if (g.fenced() || !g.rules.heli) return this.clear(now);
    for (const h of this.machines.values()) {
      const s = this.inner.get(h.id);
      const empty = h.seats.every((n) => !n);
      if (!h.seats[0] && this.high(h) && now - (s.noPilotAt ?? now) >= PILOTLESS_MS) {
        for (const n of h.seats) if (n) this.putOut(n, now);
        this.home(h, now);
      } else if (empty && !this.atPad(h)) {
        const idle = now - (s.emptyAt ?? now);
        if (idle >= IDLE_MS || (idle >= IN_THE_WAY_MS && NEEDED.some(([x, z]) => Math.hypot(h.x - x, h.z - z) <= 8))) this.home(h, now);
      }
    }
  }

  /** Everyone out and every machine not on its pad home, at once (a game starts, the rule goes off). */
  clear(now) {
    for (const h of this.machines.values()) {
      for (const n of h.seats) if (n) this.putOut(n, now);
      if (!this.atPad(h)) this.home(h, now, true);
    }
  }

  /**
   * Back on its park spot, still, its seats empty. Unless `force`, it waits while somebody not aboard stands within 6 m
   * of that spot (the next tick tries again). True when it went.
   */
  home(h, now, force = false) {
    const s = this.inner.get(h.id);
    const { x, y, z, yaw } = s.park;
    if (!force) {
      for (const [n, q] of this.game.players) {
        const st = q.state;
        if (st && !this.of(n) && Math.hypot(st.x - x, st.z - z) <= 6 && Math.abs(st.y - y) < 4) return false;
      }
    }
    for (const n of h.seats) if (n) this.release(n, now);
    Object.assign(h, { x, y, z, yaw, p: 0, r: 0, n: 0, g: 1 });
    s.noPilotAt = null;
    s.emptyAt = now;
    s.trail = [];
    this.at[h.id] = this.mono();
    this.tell(h, { home: 1 });
    return true;
  }
}
