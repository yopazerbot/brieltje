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
//  4. the pace of each step: one longer than the normal budget for that way stops the run, or starts none (the admin's
//     fast walking never sets a time);
//  5. the pace of the whole run: its own path (the server's positions, step by step) over its time, no faster on average
//     than the way's honest top (`avg`): what the budget's room for jitter could add is refused. Lag moves when states
//     arrive, not the path, so a bad connection is not refused for it; only the start can shift, by the budget's stored
//     half second at most. And no finish under the route's floor (server/floors.mjs: the tightest line through the rings
//     at the page's own top speed, pull, brakes and grip);
//  6. on the ground: feet more than ABOVE_MAX m over the ground stop the run;
//  7. walls: by bike and by car a step whose line crosses the village's blocks (shared/parking.mjs) stops the run. On
//     foot the page lets a walker through a few places where the server's blocks do not (by the walking route's second
//     and third checkpoints), so the metres through blocks are counted and a run with more than WALL_FOOT_M is refused;
//  8. the time is the server's monotonic clock at the arrival of the two states, in whole ms.
//
// The boards (server/store.mjs) are for accounts and the admin's reserved names; tonight's tables (the host's big screen)
// hold every name that played, guests too, in memory until the host resets the evening or the server restarts. A way
// not in `allTime` counts for tonight only (a route whose floor is not shown to be solid yet).
// No sockets and no store of its own: the game gives it `store`, `tell` (a message to one player) and `changed` (a board
// changed: the caches go).

import { readFileSync } from 'node:fs';
import { bestKey, cleanTime, passes, pointsOf, stepRun } from '../shared/goals.mjs';
import { floors } from './floors.mjs';

/** Route and gnome ids: short, plain (they are keys in the store and in messages). */
const ID = /^[a-z0-9]{1,12}$/;
const WAYS = ['foot', 'bike', 'car'];
const MAX_ROUTES = 20;
const MAX_GNOMES = 200;
/** Feet more than this over the ground (m) stop a run: flying without the flag, a helicopter. */
export const ABOVE_MAX = 3;
/**
 * On foot, the most metres of a run whose line crosses the server's blocks (rule 7). Honest walks by the page round the
 * walking route in a session crossed 0.15 m (by its second checkpoint); its tightest line through the houses 3.75 m.
 */
export const WALL_FOOT_M = 1;
/** The step's line checked against the blocks: this wide (half, m), this high over the feet (m). */
const LINE_HALF_W = 0.05;
const LINE_Y0 = 0.5;
const LINE_Y1 = 1.5;
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

export class GoalTracker {
  /**
   * `pace`: the game's speed budget per way of moving (m/s, with its room for jitter); `avg`: the most a whole run may
   * average per way (m/s); `models`: for the floors (server/floors.mjs: { bike: { pedal, max }, car: { top } });
   * `ground(x, z)`: the ground's height; `lineFree(cx, cz, yaw, halfL, halfW, y0, y1)`: a box clear of the blocks;
   * `allTime`: the ways whose runs go on the all-time boards (the others: tonight only); `store()`: the store; `clock()`:
   * ms, monotonic; `tell(name, message)`; `changed()`; `onBoard(role)`: whether that role is on the all-time boards.
   */
  constructor({ routes, gnomes, reach, ground, lineFree, pace, avg, models, allTime = WAYS, store, clock, tell, changed, onBoard }) {
    this.routes = routes.map((r) => ({ ...r, key: bestKey(r) }));
    this.gnomes = gnomes;
    this.reach = reach + GNOME_SLACK;
    this.ground = ground;
    this.lineFree = lineFree;
    this.store = typeof store === 'function' ? store : () => store;
    this.clock = clock;
    this.tell = tell;
    this.changed = changed;
    this.onBoard = onBoard;
    this.pace = pace;
    this.avg = avg;
    this.allTime = new Set(allTime);
    // The budget's most (as the game's: half a second's worth and half a metre) and the longest step a run keeps (a metre more).
    this.cap = Object.fromEntries(WAYS.map((w) => [w, pace[w] * 0.5 + 0.5]));
    this.stepMax = Object.fromEntries(WAYS.map((w) => [w, this.cap[w] + 1]));
    this.floors = floors(this.routes, { height: ground, ...models });
    this.floor = Object.fromEntries(Object.entries(this.floors).map(([id, f]) => [id, f.ms]));
    this.byWay = Object.fromEntries(WAYS.map((w) => [w, this.routes.filter((r) => r.by === w)]));
    // Where each gnome stands: its floor, else the ground.
    this.gnomeY = gnomes.map((g) => (g.y !== null ? g.y : ground(g.x, g.z)));
    this.gnomeIds = new Set(gnomes.map((g) => g.id));
    this.players = new Map(); // name -> what the tracker knows of them (see joined)
    this.resetTonight();
  }

  /** Someone joined: a fresh start (the first step is no step), and an account's found gnomes from the store, once. */
  async joined(name, role) {
    const p = { role, seen: false, x: 0, z: 0, budget: 0.5, run: null, route: null, dist: 0, blocked: 0, found: new Set() };
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
   * `gapMs`: since the state before; `seek`: gnomes may be found on it (alive, not flying, not in a drop, no party game
   * or freeze).
   */
  moved(name, prev, next, by, { gapMs, seek }) {
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
    const step = Math.hypot(next.x - prev.x, next.z - prev.z);
    // Rule 4: the normal budget for that way, refilled as the game's (the admin's own fast budget is not this one).
    let fast = false;
    if (by) {
      p.budget = Math.min(this.cap[by], p.budget + (this.pace[by] * Math.max(0, gapMs)) / 1000);
      fast = step > p.budget + EPS;
      p.budget = Math.max(0, p.budget - step);
    }
    if (seek) this.seek(name, p, prev, next);
    this.race(name, p, prev, next, by, step, fast);
  }

  /** Rule 6: on the ground. */
  grounded(next) {
    return next.y - this.ground(next.x, next.z) <= ABOVE_MAX;
  }

  /** Rule 7: the step's line, 0.5 to 1.5 m over the feet, clear of the blocks. */
  clear(prev, next, step) {
    if (step < 0.01) return true;
    const yaw = Math.atan2(-(next.x - prev.x), -(next.z - prev.z));
    const lo = Math.min(prev.y, next.y), hi = Math.max(prev.y, next.y);
    return this.lineFree((prev.x + next.x) / 2, (prev.z + next.z) / 2, yaw, step / 2, LINE_HALF_W, lo + LINE_Y0, hi + LINE_Y1);
  }

  race(name, p, prev, next, by, step, fast) {
    if (p.run) {
      const route = p.route;
      if (by !== route.by || fast || !this.grounded(next)) {
        p.run = null;
        return;
      }
      if (!this.clear(prev, next, step)) {
        if (by !== 'foot') {
          p.run = null;
          return;
        }
        p.blocked += step;
      }
      p.dist += step;
      const r = stepRun(p.run, route, prev, next, by, this.clock(), this.stepMax[by]);
      p.run = r.run;
      if (r.event === 'finish') this.finish(name, p, route, r.time);
      return;
    }
    if (!by || fast || !this.grounded(next)) return;
    for (const route of this.byWay[by]) {
      // Most steps are nowhere near a gate: nothing more is worked out for them.
      if (!passes(prev.x, prev.z, next.x, next.z, route.gate[0], route.gate[1], route.radius)) continue;
      const r = stepRun(null, route, prev, next, by, this.clock(), this.stepMax[by]);
      if (r.event !== 'start') continue;
      const through = !this.clear(prev, next, step);
      if (through && by !== 'foot') return;
      Object.assign(p, { run: r.run, route, dist: 0, blocked: through ? step : 0 });
      return;
    }
  }

  /** Why a finish of `ms` over `dist` m (`blocked` of them through blocks) on `route` is refused, or null. */
  refuse(route, ms, dist, blocked) {
    if (ms < this.floor[route.id]) return 'floor';
    if (dist / (ms / 1000) > this.avg[route.by]) return 'pace';
    if (blocked > WALL_FOOT_M) return 'walls';
    return null;
  }

  /** A run finished: kept when it is a time the game keeps and no rule refuses it (rules 5 and 7). */
  finish(name, p, route, time) {
    const ms = cleanTime(time);
    if (ms === null || this.refuse(route, ms, p.dist, p.blocked)) return;
    const night = this.tonightRace(name, route.id, ms);
    if (!this.onBoard(p.role) || !this.allTime.has(route.by)) {
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
    const night = this.tonightGnome(name, id); // tonight's count for this name, when this gnome is new to it tonight
    if (!this.onBoard(p.role)) {
      if (night) this.tell(name, { t: 'gnome', n: night, tonight: true });
      return;
    }
    if (p.found.has(id)) return;
    p.found.add(id); // in memory: the store is written once per new gnome (and the store keeps one row per name and gnome)
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

  /**
   * Gnome `id` found tonight by `name`: the name's count tonight when it is new to it, else 0. Kept per name, never per
   * connection (a reconnect or a second socket finds nothing twice), so a count is at most the number of gnomes.
   */
  tonightGnome(name, id) {
    if (!this.gnomeIds.has(id) || !this.tonightName(name)) return 0;
    const row = this.night.gnomes.get(name) ?? { ids: new Set(), at: 0 };
    if (row.ids.has(id)) return 0;
    row.ids.add(id);
    row.at = this.clock();
    this.night.gnomes.set(name, row);
    return row.ids.size;
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
    const gnomes = [...this.night.gnomes].sort((a, b) => b[1].ids.size - a[1].ids.size || a[1].at - b[1].at).slice(0, TONIGHT_TOP).map(([name, v]) => ({ name, n: v.ids.size }));
    return { races, gnomes };
  }

  /** The host's Reset (server/host.mjs): a new evening. */
  resetTonight() {
    this.night = { names: new Set(), races: Object.create(null), gnomes: new Map() };
  }
}
