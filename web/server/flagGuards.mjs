// Guards for Steal the flag, a test tool for the host (Yoshi, 17 Nov 2026: "Let me as admin spawn npc defenders for
// each team that would walk around the base of a team and shoot at opponents. This to help test the team v team with a
// few friends."). The host page (web/public/admin/host/) sets per team 0 to 6 guards and one skill; off by default, kept
// in memory only, and settable before a game starts. They are there only while Steal the flag is played in the open
// world (never in a Zombies room or the duel's), and gone when it ends, is stopped or the count is 0.
//
// A guard is an entry in Game.players (`guard`: { team, i }, role 'guard') with a stub socket that sends nothing and is
// never joined, closed or read: the existing pipeline draws it as a player in its team's colour (the roster, the ticks,
// the kill feed, the map, the watch views), and hits on it go through the server's own hit path (Game.hit, Game.damage)
// with every gate a player's do. What treats a player as a person leaves it out:
// - its name ("Blue guard 1" ... "Red guard 6") can never be a username (server/auth.mjs NAME_RE: lowercase letters,
//   digits, - and _ only): nobody logs in, joins or plays as one, and no session or socket has it;
// - not counted for the caps (Game.full, Rooms.count), not in the host's people list or the admin's online list, never
//   dealt into the evening's teams, kicked or muted (refused: server/host.mjs, Game.kick);
// - nothing it does or suffers counts (Game.damage `real`): no stored stats, no score, no tag for the match's tie-break,
//   no evening points (Modes.finish clears the guards before the host's scoreboard is given out);
// - it never touches a flag (FlagGame.canTouch), never gets into a vehicle, takes a pickup, throws or uses a portal:
//   no message comes from it, and the server does none of that for it.
//
// What it does (all here, on the server's own clock):
// - walks a round of waypoints near its own stand (between NEAR and RING m), each on open ground in the Zombies grid of
//   that place (shared/zombies.mjs makeNav: walls, hedges, houses, the parked cars), outdoors, inside the field's edge,
//   off the school grounds, out of every private home, off the start places, the portals' pads and the bikes, each
//   stretch a straight line the grid finds open;
// - looks LOOK_MS apart for the nearest opponent it can see within SEE m (the grid's line of sight, the same as a
//   turret's or a zombie's: houses, walls and hedges stop it, glass doesn't), or an opponent's car or helicopter;
// - after its skill's reaction time, shoots the rifle at the rifle's own fire rate, magazine and reload, missing by its
//   skill's chance; a hit goes through Game.hit (or VehicleDamage.hit for a vehicle) like a player's would, so every
//   gate holds: the fire-rate clock, spawn protection, teammates, Game.calm (the school grounds, a drop), the homes'
//   sight (homeGate.mayHurt), seats, the round's end, the host's freeze (checked here first: Host.holds).
// - down: back at its base after the game's BACK_MS, on its round, with SAFE_MS of protection (Game.respawn).
//
// Guarded against: privilege misuse (only the admin's host page sets guards, through Host.act; `set` checks every field
// and its own rate), identity spoofing (the names above), hit forgery (a page's hit on a guard is checked as on a
// player; a guard's shots are the server's own) and score forgery (guards' tags count nowhere). Nothing is stored or
// logged.

import { readFileSync } from 'node:fs';
import { arenaOf } from '../shared/arenas.mjs';
import { FLAG_COLORS, FLAG_TEAMS } from '../shared/flagFields.mjs';
import { homeAt } from '../shared/homes.mjs';
import { PORTALS } from '../shared/portals.mjs';
import { PROTO } from '../shared/wire.mjs';
import { noShoot } from '../shared/zones.mjs';

const RIFLE = JSON.parse(readFileSync(new URL('../shared/weapons.json', import.meta.url), 'utf8')).rifle;

/** Guards a team at most. */
export const GUARD_MAX = 6;
/**
 * The skills: ms from first seeing someone to the first shot, the chance a shot misses, the chance a hit is to the head
 * (the rifle's head damage then; never on easy).
 */
export const SKILLS = Object.freeze({
  easy: Object.freeze({ react: 900, miss: 0.55, head: 0 }),
  normal: Object.freeze({ react: 550, miss: 0.35, head: 0.05 }),
  hard: Object.freeze({ react: 300, miss: 0.18, head: 0.12 }),
});
/** m from the stand: the round's waypoints lie between NEAR and RING. */
export const RING = 25;
export const NEAR = 5;
/** m a guard sees and shoots. */
export const SEE = 40;
/** m from a guard: seen whichever way it looks. Further off only within VIEW (radians) of where it looks. */
export const CLOSE = 8;
export const VIEW = (100 * Math.PI) / 180;
/** ms between two looks round (the sight checks), per guard. */
export const LOOK_MS = 250;
/** m/s a guard walks. */
export const WALK = 1.6;
/** ms between two changes from the host page. */
export const SET_MS = 200;
/** m a waypoint keeps from a start place, a portal's middle, a bike. */
const SPAWN_KEEP = 3;
const PORTAL_KEEP = 5;
const BIKE_KEEP = 1.3;
/** m the way between two waypoints keeps from the stand; the longest stretch. */
const STAND_KEEP = 3;
const LEG = 18;

const WORD = { blue: 'Blue', red: 'Red' };
/** A guard's name: what every page shows (src/i18n.ts playerName puts it in the page's language). */
export const guardName = (team, i) => `${WORD[team]} guard ${i}`;
export const GUARD_NAME = /^(Blue|Red) guard [1-6]$/;

/** A guard's socket: never open, so nothing is ever sent to it; nothing ever listens on it or closes it. */
const STUB = Object.freeze({ readyState: 3, OPEN: 1, CLOSED: 3, send() {}, close() {}, terminate() {}, on() {} });

const mono = () => Math.round(performance.now());
const hyp = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
/** Distance from (px, pz) to the stretch a-b. */
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l = dx * dx + dz * dz;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l)) : 0;
  return hyp(px, pz, ax + dx * t, az + dz * t);
}
/** The yaw facing from a towards b (a figure looks along -z turned by its yaw, as the page's). */
const yawTo = (dx, dz) => Math.atan2(-dx, -dz);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class FlagGuards {
  /** `game`: the Game (server/game.mjs); `rand`: for the tests. */
  constructor(game, { rand = Math.random } = {}) {
    this.game = game;
    this.rand = rand;
    /** What the host page set, per team. */
    this.want = { blue: { count: 0, skill: 'normal' }, red: { count: 0, skill: 'normal' } };
    /** name -> the guard's entry in game.players. */
    this.guards = new Map();
    /** The Steal the flag game the guards are in (server/flags.mjs FlagGame), and each base's round for it. */
    this.f = null;
    this.rounds = {};
    this.setAt = -Infinity;
  }

  /** How many guards there are now. */
  get size() {
    return this.guards.size;
  }

  /** Whether `name` is a guard's. */
  has(name) {
    return this.guards.has(name);
  }

  // ------------------------------------------------------------------ the host page

  /**
   * A change from the host page (server/host.mjs act, the admin only): { team: 'blue' | 'red', count: 0 to GUARD_MAX
   * (an integer), skill: one of SKILLS }. Anything else is refused whole; at most one change in SET_MS.
   */
  set(b, now = Date.now()) {
    if (this.game.room) return { error: 'Not here', code: 'badValue' };
    const team = b?.team;
    const count = b?.count;
    const skill = b?.skill;
    if ((team !== 'blue' && team !== 'red') || !Number.isInteger(count) || count < 0 || count > GUARD_MAX || typeof skill !== 'string' || !Object.hasOwn(SKILLS, skill)) {
      return { error: 'Out of range', code: 'badValue' };
    }
    if (now - this.setAt < SET_MS) return { error: 'Slow down', code: 'tooFast' };
    this.setAt = now;
    this.want[team] = { count, skill };
    return { ok: true };
  }

  /** What the host page shows: each team's setting and how many stand now. */
  view() {
    const out = { on: !!this.f, max: GUARD_MAX, skills: Object.keys(SKILLS) };
    for (const t of FLAG_TEAMS) out[t] = { ...this.want[t], here: [...this.guards.values()].filter((g) => g.guard.team === t).length };
    return out;
  }

  // ------------------------------------------------------------------ coming and going

  /** Every guard gone (the game ends, is stopped or another starts: server/modes.mjs). The settings stay. */
  clear() {
    const had = this.guards.size;
    for (const name of [...this.guards.keys()]) this.remove(name);
    if (had) this.game.broadcast({ t: 'scores', list: this.game.scoreList() }); // their rows off every scoreboard
    this.f = null;
    this.rounds = {};
  }

  remove(name) {
    const g = this.game;
    if (!this.guards.has(name)) return;
    this.guards.delete(name);
    if (g.players.get(name)?.guard) g.players.delete(name);
    if (this.f && Object.hasOwn(this.f.teams, name)) delete this.f.teams[name];
    g.broadcast({ t: 'leave', name });
  }

  /** Guard `i` of `team` comes in, on its round. False when it can't (no round at this base). */
  add(team, i, now) {
    const g = this.game;
    const name = guardName(team, i);
    if (g.players.has(name)) return false; // never: no username looks like this (NAME_RE)
    const round = this.roundOf(team);
    if (!round.points.length) return false;
    const t = mono();
    const rec = {
      ws: STUB, key: null, role: 'guard', guard: { team, i }, color: FLAG_COLORS[team],
      state: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, armed: true, flying: false, w: 'rifle', c: false, a: false },
      lastChat: 0, msgs: 0, window: 0, address: null, device: null,
      score: { kills: 0, deaths: 0, points: 0 }, hp: 100, alive: true, respawnAt: 0, protectedUntil: 0, nextHit: 0, weapons: new Set(), joinTime: now, spawned: false,
      nades: [], thrown: [],
      // The ticks' fields (Game.snapshot): read as a page of today's protocol that never answers a ping or falls silent.
      proto: PROTO, sight: false, stamp: t, fresh: true, warp: 0, sentKey: '', slot: (i * 3 + (team === 'red' ? 1 : 0)) % 20, full: false,
      states: 0, others: 0, pingN: 0, pingAt: 0, pingNext: Infinity, rtt: null, rttAvg: null, ctGap: null, ctAt: 0, heard: Infinity,
      movedAt: now, budget: 0.5, vbudget: 0.5,
      // Its own: the round, where it is on it, which way it goes, its gun and what it aims at.
      walk: { at: 0, to: -1, dir: i % 2 ? 1 : -1, wait: 0, t: now }, mine: -1, lookAt: now + ((i * 37) % LOOK_MS),
      target: null, fireAt: 0, nextShot: 0, mag: RIFLE.mag, reloadUntil: 0, shots: 0, backAt: 0,
    };
    g.players.set(name, rec);
    this.guards.set(name, rec);
    this.f.teams[name] = team;
    g.broadcast({ t: 'join', name, color: g.colorOf(name, rec) });
    const count = Math.max(1, this.want[team].count);
    this.place(name, rec, now, Math.floor(((i - 1) * round.points.length) / count) % round.points.length);
    return true;
  }

  /** Put guard `name` on waypoint `k` of its round (a respawn: health, protection, the gun), facing its stand. */
  place(name, rec, now, k = Math.floor(this.rand() * this.roundOf(rec.guard.team).points.length)) {
    const round = this.roundOf(rec.guard.team);
    const p = round.points[k];
    this.game.respawn(name, rec, now, { spawn: 0, x: p.x, y: p.y, z: p.z, face: round.stand });
    rec.mine = rec.warp; // its own move: not "moved by the server" (tick)
    Object.assign(rec.walk, { at: k, to: -1, wait: now + 500 + this.rand() * 1500, t: now });
    Object.assign(rec, { target: null, fireAt: 0, mag: RIFLE.mag, reloadUntil: 0, backAt: 0 });
    rec.state.a = false;
  }

  // ------------------------------------------------------------------ the rounds

  /**
   * Team `team`'s round in the game being played: its waypoints ({ x, y, z, a: the angle round the stand }) and which
   * of them a straight walk joins (`links`, indexes), worked out once a game from that place's Zombies grid.
   */
  roundOf(team) {
    if (this.rounds[team]) return this.rounds[team];
    const f = this.f;
    const field = f.field;
    const base = field.bases[team];
    const [sx, sz] = base.stand;
    const { nav } = this.game.zombieGround(arenaOf(team === 'blue' ? 'church' : field.red));
    const edge = f.edge;
    const bikes = Object.values(this.game.bikes).filter((k) => hyp(k.x, k.z, sx, sz) < RING + 10);
    const open = (x, z) => {
      if (!edge.inside(x, z) || (edge.depth && edge.depth(x, z) < 1.5)) return false;
      if (noShoot(x, z) || homeAt(x, z, nav.ground(x, z)) || !nav.walkable(x, z)) return false;
      return PORTALS.every((p) => hyp(p.x, p.z, x, z) >= PORTAL_KEEP) && bikes.every((k) => hyp(k.x, k.z, x, z) >= BIKE_KEEP);
    };
    const spots = nav.spawnSpots().filter((s) => {
      const d = hyp(s.x, s.z, sx, sz);
      return d >= NEAR && d <= RING && open(s.x, s.z) && base.spawns.every(([x, z]) => hyp(x, z, s.x, s.z) >= SPAWN_KEEP);
    });
    const leg = (a, b) => {
      const d = hyp(a.x, a.z, b.x, b.z);
      if (d > LEG || !nav.clear(a.x, a.z, b.x, b.z) || segDist(sx, sz, a.x, a.z, b.x, b.z) < STAND_KEEP) return false;
      for (let s = 1, n = Math.ceil(d); s < n; s++) if (!open(a.x + ((b.x - a.x) * s) / n, a.z + ((b.z - a.z) * s) / n)) return false;
      return true;
    };
    let best = { stand: [sx, sz], points: [], links: [], nav };
    // A ring of up to 12 waypoints, one a sector, at about `r` m from the stand; the largest part a walk joins.
    for (const r of [13, 10, 17, 8, 21]) {
      const pick = [];
      for (let sec = 0; sec < 12; sec++) {
        const lo = -Math.PI + (sec * Math.PI) / 6;
        const inSec = spots.filter((s) => {
          const a = Math.atan2(s.z - sz, s.x - sx);
          return a >= lo && a < lo + Math.PI / 6;
        });
        inSec.sort((p, q) => Math.abs(hyp(p.x, p.z, sx, sz) - r) - Math.abs(hyp(q.x, q.z, sx, sz) - r));
        if (inSec.length) pick.push(inSec[0]);
      }
      const links = pick.map(() => []);
      for (let a = 0; a < pick.length; a++) for (let b = a + 1; b < pick.length; b++) if (leg(pick[a], pick[b])) (links[a].push(b), links[b].push(a));
      // The largest part joined.
      const part = new Array(pick.length).fill(-1);
      let bestPart = -1, bestSize = 0;
      for (let s = 0, id = 0; s < pick.length; s++, id++) {
        if (part[s] >= 0) continue;
        const stack = [s];
        part[s] = id;
        let size = 0;
        while (stack.length) {
          const k = stack.pop();
          size++;
          for (const q of links[k]) if (part[q] < 0) (part[q] = id, stack.push(q));
        }
        if (size > bestSize) [bestPart, bestSize] = [id, size];
      }
      if (bestSize <= best.points.length) continue;
      const keep = pick.map((_, k) => k).filter((k) => part[k] === bestPart);
      const index = new Map(keep.map((k, j) => [k, j]));
      best = {
        stand: [sx, sz], nav,
        points: keep.map((k) => ({ x: pick[k].x, z: pick[k].z, y: Math.round(nav.ground(pick[k].x, pick[k].z) * 100) / 100, a: Math.atan2(pick[k].z - sz, pick[k].x - sx) })),
        links: keep.map((k) => links[k].filter((q) => index.has(q)).map((q) => index.get(q))),
      };
      if (bestSize >= 8) break;
    }
    // No round at all (never seen at the three bases): no guards for this team this game, said once.
    if (!best.points.length) console.log(JSON.stringify({ event: 'flag_guards_no_round', team, field: field.id }));
    this.rounds[team] = best;
    return best;
  }

  // ------------------------------------------------------------------ every tick

  /** Every tick (Game.tick): the guards the host asked for, each walking its round, looking and shooting. */
  tick(now) {
    const g = this.game;
    const f = g.room ? null : g.modes.flag;
    if (!f || g.modes.state.phase !== 'playing') {
      if (this.guards.size || this.f) this.clear();
      return;
    }
    if (f !== this.f) {
      this.clear();
      this.f = f;
    }
    let changed = false;
    for (const team of FLAG_TEAMS) {
      const none = this.rounds[team] && !this.rounds[team].points.length; // tried this game, no round: not again
      for (let i = 1; i <= GUARD_MAX; i++) {
        const name = guardName(team, i);
        const there = this.guards.has(name);
        if (i <= this.want[team].count && !there && !none) changed = this.add(team, i, now) || changed;
        else if (i > this.want[team].count && there) (this.remove(name), (changed = true));
      }
    }
    if (changed) {
      g.teamsChanged([], false); // everyone's colours and the scores, the guards' with them
      g.modes.send();
    }
    for (const [name, rec] of this.guards) this.step(name, rec, now);
  }

  step(name, rec, now) {
    const g = this.game;
    const dt = Math.min(0.2, Math.max(0, (now - rec.walk.t) / 1000));
    rec.walk.t = now;
    if (!rec.alive) {
      // Down: back on its round after the game's time (Game.damage set when), not at the base's start places (Game.tick).
      if (rec.respawnAt !== Infinity) [rec.backAt, rec.respawnAt] = [rec.respawnAt, Infinity];
      if (now >= rec.backAt && !g.roundOver) this.place(name, rec, now);
      return;
    }
    if (rec.warp !== rec.mine) return this.place(name, rec, now); // moved by the server (the host's bring, a new round): back on its round
    if (g.host?.holds(rec) || g.roundOver) {
      if (rec.target) this.drop(rec);
      return;
    }
    if (now >= rec.lookAt) {
      rec.lookAt = now + LOOK_MS;
      const seen = this.look(name, rec);
      const same = seen && rec.target && seen.kind === rec.target.kind && seen.id === rec.target.id;
      if (seen && !same) rec.fireAt = now + this.skill(rec).react;
      if (!seen && rec.target) this.drop(rec);
      rec.target = seen;
    }
    if (rec.target) this.shoot(name, rec, now);
    else this.patrol(rec, now, dt);
  }

  skill(rec) {
    return SKILLS[this.want[rec.guard.team].skill] ?? SKILLS.normal;
  }

  /** Walking its round: to the next waypoint along it (the way it goes), a short wait now and then. */
  patrol(rec, now, dt) {
    const round = this.roundOf(rec.guard.team);
    const s = rec.state;
    const w = rec.walk;
    s.a = false;
    if (now < w.wait) return;
    if (w.to < 0) {
      const links = round.links[w.at] ?? [];
      if (!links.length) return;
      const here = round.points[w.at].a;
      const ahead = links.map((q) => ({ q, step: wrap(round.points[q].a - here) * w.dir })).filter((e) => e.step > 0.05).sort((x, y) => x.step - y.step);
      if (!ahead.length || this.rand() < 0.1) w.dir = -w.dir;
      const next = ahead.length && this.rand() >= 0.1 ? ahead[0].q : links[Math.floor(this.rand() * links.length)];
      w.to = next;
    }
    const p = round.points[w.to];
    const dx = p.x - s.x, dz = p.z - s.z;
    const d = Math.hypot(dx, dz);
    const stepM = WALK * dt;
    s.yaw = w.yaw = yawTo(dx, dz);
    s.pitch = 0;
    if (d <= stepM) {
      Object.assign(s, { x: p.x, y: p.y, z: p.z });
      w.at = w.to;
      w.to = -1;
      if (this.rand() < 0.3) w.wait = now + 800 + this.rand() * 1800;
    } else {
      s.x += (dx / d) * stepM;
      s.z += (dz / d) * stepM;
      s.y = Math.round(round.nav.ground(s.x, s.z) * 100) / 100;
    }
    this.moved(rec);
  }

  moved(rec) {
    rec.stamp = Math.max(mono(), rec.stamp + 1);
    rec.fresh = true;
    rec.movedAt = Date.now();
  }

  /** Whether (x, z) is in the grid of the guard's place (outside it nothing is known of walls: never seen). */
  inGrid(nav, x, z) {
    return x > nav.x0 + nav.cell && z > nav.z0 + nav.cell && x < nav.x0 + (nav.nx - 1) * nav.cell && z < nav.z0 + (nav.nz - 1) * nav.cell;
  }

  /** Whether the guard sees the point (x, y, z), `d` m off: in its grid, in front of it (or close), nothing in between. */
  sees(rec, nav, x, y, z, d) {
    const s = rec.state;
    if (!this.inGrid(nav, x, z) || !this.inGrid(nav, s.x, s.z)) return false;
    if (d > CLOSE && !rec.target && Math.abs(wrap(yawTo(x - s.x, z - s.z) - s.yaw)) > VIEW) return false;
    return nav.reach(s.x, s.y + 1.6, s.z, x, y, z);
  }

  /**
   * The nearest opponent the guard sees within SEE: a player on foot ({ kind: 'player', id: name }) or a car or
   * helicopter an opponent sits in ({ kind: 'car' | 'heli', id }); null for none. Only what a hit could count on: the
   * checks Game.hit and VehicleDamage.hit make again at each shot.
   */
  look(name, rec) {
    const g = this.game;
    const round = this.roundOf(rec.guard.team);
    const nav = round.nav;
    const s = rec.state;
    if (g.calm(rec)) return null;
    let best = null;
    const now = Date.now();
    const consider = (kind, id) => {
      const at = this.fair(name, rec, kind, id, now);
      if (!at) return;
      const d = Math.hypot(at.x - s.x, at.y - (s.y + 1.6), at.z - s.z);
      if (d > SEE || (best && d >= best.d)) return;
      if (this.sees(rec, nav, at.x, at.y, at.z, d)) best = { kind, id, d };
    };
    for (const n of g.players.keys()) consider('player', n);
    if (g.vehicleDamage.live) {
      for (const v of Object.values(g.cars)) consider('car', v.id);
      for (const v of g.helis.machines.values()) consider('heli', v.id);
    }
    return best;
  }

  /**
   * Where the guard may aim at target `kind` `id` now (a player's chest, a vehicle's middle), or null when it may not:
   * an opponent, alive, armed, out of spawn protection, on foot, not calm (Game.calm), inside no home and in sight of the
   * guard as the homes see it (homeGate.mayHurt); a vehicle not out, with an opponent in it, none the guard may not hurt
   * (VehicleDamage hidden and mayDamage), not calm, not in a home's bands. Asked at each look and again before every aim
   * and every shot: a player who steps into a home between two looks is not followed, shot at or traced there.
   */
  fair(name, rec, kind, id, now) {
    const g = this.game;
    const enemy = rec.guard.team === 'blue' ? 'red' : 'blue';
    const teams = this.f.teams;
    const s = rec.state;
    let at = null;
    if (kind === 'player') {
      const q = g.players.get(id);
      if (!q || q.guard || teams[id] !== enemy || !q.alive || !q.state?.armed || now < q.protectedUntil || g.inCar(id) || g.calm(q) || g.gate.insideOf(q) || !g.gate.mayHurt(rec, q)) return null;
      at = { x: q.state.x, y: q.state.y + (q.state.c ? 0.7 : 1.1), z: q.state.z };
    } else {
      const vd = g.vehicleDamage;
      const v = vd.vehicle(kind, id);
      if (!v || !vd.live || !vd.riders(kind, v).some((r) => teams[r] === enemy) || vd.out(kind, id) || !vd.mayDamage(name, kind, v) || vd.calm(kind, v) || vd.hidden(rec, kind, v) || g.homeOf(kind, v)) return null;
      at = vd.middle(kind, v);
    }
    return Math.hypot(at.x - s.x, at.z - s.z) <= SEE + 5 ? at : null;
  }

  /** The target is no longer fair: dropped, the gun down, the view back along its round. */
  drop(rec) {
    const s = rec.state;
    rec.target = null;
    Object.assign(s, { a: false, pitch: 0, yaw: rec.walk.yaw ?? s.yaw });
    this.moved(rec);
  }

  /** Facing the target; after the reaction time a shot at the rifle's rate, reloading when the magazine is empty. */
  shoot(name, rec, now) {
    const g = this.game;
    const s = rec.state;
    const at = this.fair(name, rec, rec.target.kind, rec.target.id, now); // again before every aim and shot
    if (!at) return this.drop(rec);
    const ex = s.x, ey = s.y + 1.6, ez = s.z;
    const flat = Math.hypot(at.x - ex, at.z - ez);
    s.yaw = yawTo(at.x - ex, at.z - ez);
    s.pitch = Math.atan2(at.y - ey, flat);
    s.a = true;
    this.moved(rec);
    if (now < rec.fireAt || now < rec.nextShot) return;
    if (now < rec.reloadUntil) return;
    if (g.calm(rec) || g.host?.holds(rec)) return; // the predicate a player's shot asks (Game.calm), and the host's freeze
    rec.nextShot = now + RIFLE.delay * 1000;
    if (--rec.mag <= 0) [rec.mag, rec.reloadUntil] = [RIFLE.mag, now + RIFLE.reload * 1000];
    const sk = this.skill(rec);
    const miss = this.rand() < sk.miss;
    // Everyone hears and sees it as a player's shot; every third with a tracer (as the rifle's on a page), off to the
    // side on a miss.
    const shot = { t: 'shot', name, w: 'rifle', x: Math.round(ex * 100) / 100, y: Math.round(ey * 100) / 100, z: Math.round(ez * 100) / 100 };
    if (++rec.shots % 3 === 0) {
      const off = miss ? 0.6 + this.rand() : 0;
      const side = this.rand() < 0.5 ? -1 : 1;
      const tracer = { tx: Math.round((at.x + Math.cos(s.yaw) * off * side) * 100) / 100, ty: Math.round((at.y + (miss ? (this.rand() - 0.3) * 0.8 : 0)) * 100) / 100, tz: Math.round((at.z - Math.sin(s.yaw) * off * side) * 100) / 100 };
      if (!homeAt(tracer.tx, tracer.tz, tracer.ty)) Object.assign(shot, tracer); // never a streak ending inside a home
    }
    g.broadcastFrom(shot, rec, name);
    if (miss) return;
    const t = rec.target;
    if (t.kind === 'player') {
      const head = this.rand() < sk.head;
      g.hit(name, rec, t.id, 'rifle', head ? 0 : 1, head ? 1 : 0, now); // the server's own hit path, every gate a player's has
    } else g.vehicleDamage.hit(name, rec, { kind: t.kind, id: t.id, w: 'rifle', n: 1 }, now);
  }
}
