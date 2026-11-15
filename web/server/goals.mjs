// The timed routes and the garden gnomes as the server sees them (Yoshi, 15 Nov 2026: "klassement moet alles tonen, ook
// de races enzo"). Playing together, the server times the routes and notes the gnomes itself, from the positions it
// already holds for each player (server/game.mjs state: cut to a speed budget per way of moving, fenced in, kept out of
// the locked homes) and with its own clock. A page sends nothing for this: no message carries a time or a gnome, so there
// is nothing to forge or replay. The rules of a run are shared/goals.mjs stepRun's, with the server's own stops on top:
//
//  1. the order: through the gate from outside it, every checkpoint in order, the gate again (stepRun);
//  2. the way of moving is the server's (its own driver and rider lists, never the page's word); a change stops the run;
//  3. no hops: when a player's last position is not where the tracker last saw them, something else moved them (a
//     portal, chat travel, a spawn, a respawn, a party game's gather, the host's bring): the run stops, and that step
//     passes no gate and finds no gnome;
//  4. a steady start: a run starts only on a state that came within START_GAP_MS of the one before and was not cut;
//  5. the pace: a step longer than the normal budget for that way stops the run (the admin's fast walking never sets a
//     time); a finish faster than the route's shortest line at the top speed of that way is refused;
//  6. on the ground: feet more than ABOVE_MAX m over the ground stop the run;
//  7. the time is the server's monotonic clock at the arrival of the two states, in whole ms.
//
// The plan had one more: the step's line clear of the village's blocks (shared/parking.mjs). It stopped an honest walk
// by the page round the walking route (between its second and third checkpoints the page lets you through where the
// server's blocks do not), so it is left out: as before, the server checks no walls for players. A line through the
// houses is still held by the budget and the shortest time (rule 5).
//
// The boards (server/store.mjs) are for accounts and the admin's reserved names; tonight's tables (the host's big screen)
// hold every name that played, guests too, in memory until the host resets the evening or the server restarts.
// No sockets and no store of its own: the game gives it `store`, `tell` (a message to one player) and `changed` (a board
// changed: the caches go).

import { readFileSync } from 'node:fs';
import { bestKey, cleanTime, passes, pointsOf, stepRun } from '../shared/goals.mjs';

/** Route and gnome ids: short, plain (they are keys in the store and in messages). */
const ID = /^[a-z0-9]{1,12}$/;
const WAYS = ['foot', 'bike', 'car'];
const MAX_ROUTES = 20;
const MAX_GNOMES = 200;
/** A run starts only on a state this soon after the one before (ms): a burst of held-back states gains at most this. */
export const START_GAP_MS = 200;
/** Feet more than this over the ground (m) stop a run: flying without the flag, a helicopter. */
export const ABOVE_MAX = 3;
/** A gnome is found when the step's line comes this much closer than the page's reach (m), the feet this near its height. */
const GNOME_SLACK = 0.5;
const GNOME_DY = 2;
/** Tonight's tables hold at most this many names. */
export const TONIGHT_MAX = 300;
/** Tonight's lists: this many rows each. */
const TONIGHT_TOP = 5;
/** A little room for rounding between the game's budget and ours (m). */
const EPS = 0.01;

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const pair = (p) => Array.isArray(p) && p.length === 2 && fin(p[0]) && fin(p[1]);

/**
 * The routes and the gnomes from their JSON (shared/routes.json, shared/gnomes.json), checked: ids as ID, finite numbers,
 * a known way of moving, at most MAX_ROUTES routes and MAX_GNOMES gnomes. Anything else is left out.
 */
export function loadGoals(routesJson, gnomesJson) {
  const routes = [];
  for (const r of (Array.isArray(routesJson?.routes) ? routesJson.routes : []).slice(0, MAX_ROUTES)) {
    if (!r || typeof r.id !== 'string' || !ID.test(r.id) || !Number.isInteger(r.rev) || r.rev < 0 || !WAYS.includes(r.by)) continue;
    if (!fin(r.radius) || r.radius <= 0 || !pair(r.gate) || !Array.isArray(r.checkpoints) || !r.checkpoints.length || !r.checkpoints.every(pair)) continue;
    if (routes.some((x) => x.id === r.id)) continue;
    routes.push({ id: r.id, rev: r.rev, by: r.by, radius: r.radius, gate: [r.gate[0], r.gate[1]], checkpoints: r.checkpoints.map((p) => [p[0], p[1]]) });
  }
  const gnomes = [];
  for (const g of (Array.isArray(gnomesJson?.gnomes) ? gnomesJson.gnomes : []).slice(0, MAX_GNOMES)) {
    if (!g || typeof g.id !== 'string' || !ID.test(g.id) || !fin(g.x) || !fin(g.z) || (g.y !== undefined && !fin(g.y))) continue;
    if (gnomes.some((x) => x.id === g.id)) continue;
    gnomes.push({ id: g.id, x: g.x, z: g.z, y: g.y ?? null });
  }
  const reach = fin(gnomesJson?.reach) && gnomesJson.reach > 0 && gnomesJson.reach < 10 ? gnomesJson.reach : 1.5;
  return { routes, gnomes, reach };
}

/** The game's routes and gnomes (the same files the page's bundle has, so the server leaks nothing by reading them). */
export function readGoals() {
  const read = (file) => JSON.parse(readFileSync(new URL(`../shared/${file}`, import.meta.url), 'utf8'));
  return loadGoals(read('routes.json'), read('gnomes.json'));
}

/** The shortest a route can be ridden: its line from point to point, less the radius at both ends of every leg (m). */
export function shortest(route) {
  const pts = [route.gate, ...pointsOf(route)];
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return Math.max(0, len - 2 * route.radius * (pts.length - 1));
}

export class GoalTracker {
  /**
   * `pace`: the game's speed budget per way of moving (m/s, with its room for jitter); `top`: the real top speed of each
   * way (m/s, for the shortest time); `ground(x, z)`: the ground's height; `store()`: the store; `clock()`: ms, monotonic;
   * `tell(name, message)`; `changed()`; `onBoard(role)`: whether that role is on the all-time boards.
   */
  constructor({ routes, gnomes, reach, ground, pace, top, store, clock, tell, changed, onBoard }) {
    this.routes = routes.map((r) => ({ ...r, key: bestKey(r) }));
    this.gnomes = gnomes;
    this.reach = reach + GNOME_SLACK;
    this.ground = ground;
    this.store = typeof store === 'function' ? store : () => store;
    this.clock = clock;
    this.tell = tell;
    this.changed = changed;
    this.onBoard = onBoard;
    this.pace = pace;
    // The budget's most (as the game's: half a second's worth and half a metre) and the longest step a run keeps (a metre more).
    this.cap = Object.fromEntries(WAYS.map((w) => [w, pace[w] * 0.5 + 0.5]));
    this.stepMax = Object.fromEntries(WAYS.map((w) => [w, this.cap[w] + 1]));
    this.floor = Object.fromEntries(this.routes.map((r) => [r.id, Math.ceil((shortest(r) / top[r.by]) * 1000)]));
    this.byWay = Object.fromEntries(WAYS.map((w) => [w, this.routes.filter((r) => r.by === w)]));
    // Where each gnome stands: its floor, else the ground.
    this.gnomeY = gnomes.map((g) => (g.y !== null ? g.y : ground(g.x, g.z)));
    this.gnomeIds = new Set(gnomes.map((g) => g.id));
    this.players = new Map(); // name -> what the tracker knows of them (see joined)
    this.resetTonight();
  }

  /** Someone joined: a fresh start (the first step is no step), and an account's found gnomes from the store, once. */
  async joined(name, role) {
    const p = { role, seen: false, x: 0, z: 0, budget: 0.5, run: null, route: null, found: new Set(), tonight: new Set() };
    this.players.set(name, p);
    if (!this.onBoard(role)) return;
    try {
      const ids = (await this.store()?.gnomesOf?.(name)) ?? [];
      for (const id of ids) if (this.gnomeIds.has(id)) p.found.add(id);
    } catch (e) {
      console.error('gnomes not read', String(e));
    }
  }

  left(name) {
    this.players.delete(name);
  }

  /**
   * A state taken (server/game.mjs, straight after the server's own checks): the step from `prev` to `next`, the server's
   * positions. `by`: 'foot', 'bike', 'car' or null (a passenger, on a horse, flying, in a drop, down, a party game, frozen);
   * `gapMs`: since the state before; `cut`: the game held this step to its budget; `seek`: gnomes may be found on it
   * (alive, not flying, not in a drop, no party game or freeze).
   */
  moved(name, prev, next, by, { gapMs, cut, seek }) {
    const p = this.players.get(name);
    if (!p || !prev || !next) return;
    const hop = !p.seen || prev.x !== p.x || prev.z !== p.z;
    p.seen = true;
    p.x = next.x;
    p.z = next.z;
    if (hop) {
      p.run = null; // rule 3: moved by something else
      return;
    }
    const dx = next.x - prev.x, dz = next.z - prev.z;
    const step = Math.hypot(dx, dz);
    // Rule 5: the normal budget for that way, refilled as the game's (the admin's own fast budget is not this one).
    let fast = false;
    if (by) {
      p.budget = Math.min(this.cap[by], p.budget + this.pace[by] * Math.max(0, gapMs) / 1000);
      fast = step > p.budget + EPS;
      p.budget = Math.max(0, p.budget - step);
    }
    if (seek) this.seek(name, p, prev, next);
    this.race(name, p, prev, next, by, fast, gapMs, cut);
  }

  /** Rule 6: on the ground. */
  grounded(next) {
    return next.y - this.ground(next.x, next.z) <= ABOVE_MAX;
  }

  race(name, p, prev, next, by, fast, gapMs, cut) {
    if (p.run) {
      const route = p.route;
      if (by !== route.by || fast || !this.grounded(next)) {
        p.run = null;
        return;
      }
      const r = stepRun(p.run, route, prev, next, by, this.clock(), this.stepMax[by]);
      p.run = r.run;
      if (r.event === 'finish') this.finish(name, p, route, r.time);
      return;
    }
    // Rule 4: a steady start, at the normal pace.
    if (!by || fast || cut || !(gapMs <= START_GAP_MS)) return;
    for (const route of this.byWay[by]) {
      // Most steps are nowhere near a gate: nothing more is worked out for them.
      if (!passes(prev.x, prev.z, next.x, next.z, route.gate[0], route.gate[1], route.radius)) continue;
      if (!this.grounded(next)) continue;
      const r = stepRun(null, route, prev, next, by, this.clock(), this.stepMax[by]);
      if (r.event === 'start') {
        p.run = r.run;
        p.route = route;
        return;
      }
    }
  }

  /** A run finished: kept when it is no faster than the route allows (rule 5) and a time the game keeps at all. */
  finish(name, p, route, time) {
    const ms = cleanTime(time);
    if (ms === null || ms < this.floor[route.id]) return;
    const night = this.tonightRace(name, route.id, ms);
    if (!this.onBoard(p.role)) {
      if (night) this.tell(name, { t: 'race', id: route.id, ms, best: night.best, place: night.best ? night.place : null, tonight: true });
      return;
    }
    const store = this.store();
    const saved = store?.saveRaceTime?.(name, route.key, ms);
    if (!saved) return;
    saved
      .then(async (better) => {
        const place = better ? await store.racePlace(route.key, ms) : null;
        if (better) this.changed?.();
        this.tell(name, { t: 'race', id: route.id, ms, best: !!better, place, tonight: false });
      })
      .catch((e) => console.error('race time failed', String(e)));
  }

  /** The gnomes the step's line comes within reach of, at the feet's height (on foot, in a car, on a bike or a horse). */
  seek(name, p, prev, next) {
    const r = this.reach;
    const x0 = Math.min(prev.x, next.x) - r, x1 = Math.max(prev.x, next.x) + r;
    const z0 = Math.min(prev.z, next.z) - r, z1 = Math.max(prev.z, next.z) + r;
    for (let i = 0; i < this.gnomes.length; i++) {
      const g = this.gnomes[i];
      if (g.x < x0 || g.x > x1 || g.z < z0 || g.z > z1) continue;
      if (Math.abs(next.y - this.gnomeY[i]) > GNOME_DY) continue;
      if (!passes(prev.x, prev.z, next.x, next.z, g.x, g.z, r)) continue;
      this.found(name, p, g.id);
    }
  }

  found(name, p, id) {
    const night = !p.tonight.has(id) && this.tonightGnome(name);
    if (night) p.tonight.add(id);
    if (!this.onBoard(p.role)) {
      if (night) this.tell(name, { t: 'gnome', n: p.tonight.size, tonight: true });
      return;
    }
    if (p.found.has(id)) return;
    p.found.add(id); // in memory: the store is written once per new gnome
    const saved = this.store()?.saveGnome?.(name, id);
    if (!saved) return;
    saved
      .then((added) => {
        if (!added) return;
        this.changed?.();
        this.tell(name, { t: 'gnome', n: p.found.size, tonight: false });
      })
      .catch((e) => console.error('gnome failed', String(e)));
  }

  // ------------------------------------------------------------------ tonight (the host's big screen)

  /** A name on tonight's tables: already there, or room for one more. */
  tonightName(name) {
    if (this.night.names.has(name)) return true;
    if (this.night.names.size >= TONIGHT_MAX) return false;
    this.night.names.add(name);
    return true;
  }

  /** A finish tonight: { best, place } when the name is on tonight's tables, else null. */
  tonightRace(name, id, ms) {
    if (!this.tonightName(name)) return null;
    const list = (this.night.races[id] ??= new Map());
    const old = list.get(name);
    const best = !old || ms < old.ms;
    if (best) list.set(name, { ms, at: this.clock() });
    let place = 1;
    for (const [other, v] of list) if (other !== name && v.ms < ms) place++;
    return { best, place };
  }

  /** A gnome found tonight (each counts once a name and evening): whether it counted. */
  tonightGnome(name) {
    if (!this.tonightName(name)) return false;
    const old = this.night.gnomes.get(name);
    this.night.gnomes.set(name, { n: (old?.n ?? 0) + 1, at: this.clock() });
    return true;
  }

  /** Tonight's best: each route's quickest names, and who found the most gnomes (the first to that many first). */
  tonight() {
    const races = {};
    for (const route of this.routes) {
      const list = this.night.races[route.id];
      races[route.id] = list
        ? [...list].sort((a, b) => a[1].ms - b[1].ms || a[1].at - b[1].at).slice(0, TONIGHT_TOP).map(([name, v]) => ({ name, ms: v.ms }))
        : [];
    }
    const gnomes = [...this.night.gnomes].sort((a, b) => b[1].n - a[1].n || a[1].at - b[1].at).slice(0, TONIGHT_TOP).map(([name, v]) => ({ name, n: v.n }));
    return { races, gnomes };
  }

  /** The host's Reset (server/host.mjs): a new evening. */
  resetTonight() {
    this.night = { names: new Set(), races: Object.create(null), gnomes: new Map() };
    for (const p of this.players.values()) p.tonight.clear();
  }
}
