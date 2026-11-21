// The zombie grids' part that never changes per place, kept on the server (shared/zombies.mjs navBase): the ground,
// the blocks, the houses' floors and their links of each Zombies place (shared/arenas.mjs ARENAS). A game's grid is made
// on it at its start with the cars where they stand then (navOn): a few ms instead of 10 to 45 (with 30 players more),
// by any route (the host's countdown, the admin's menu, a duel room, Steal the flag's guards, Attack and defend's traps).
//
// - Kept: one per place of the list given (the seven places), never more; a place not on it is made and not kept.
// - Shared: one place's part serves every game at once, the main game's and each room's (a duel's two halves). It is
//   only read: every game's grid copies what it changes (its cars, its panes, its distances), so one game never
//   changes another's grid.
// - Warmed: at the server's start (server.mjs), every place's part made over its first seconds, in slices of a few ms
//   with a pause between, so the first game of the evening starts no slower than the third and the health check
//   answers meanwhile. A start before its place is warm finishes that place's part there and then, as before.
import { performance } from 'node:perf_hooks';
import { navBaseSteps, navOn } from '../shared/zombies.mjs';

/** ms: the most one slice of the warm-up works before it lets the server go on */
export const SLICE_MS = 4;
/** ms: the pause between two slices */
export const GAP_MS = 15;

export class NavCache {
  /**
   * `arenas`: the places whose part is kept. `keyOf(arena)`: which part it takes (two places on one grid, home and the
   * bungalow on the party area's, share one). `optsOf(arena)`: makeNav's arguments but the cars for that place
   * (game.mjs), the same every time and the same for places of one key.
   */
  constructor(arenas, keyOf, optsOf, spotsOf = (arena, spots) => spots) {
    this.ids = new Set(arenas.map(keyOf));
    this.places = new Set(arenas);
    this.keyOf = keyOf;
    this.optsOf = optsOf;
    this.spotsOf = spotsOf;
    this.bases = new Map();
    this.pending = new Map(); // key -> its part being made by the warm-up (a generator part way)
    this.woods = new Map(); // place id -> where its horde comes out on its grid with no car (spots)
    this.timer = null;
  }

  /**
   * Where the horde comes out on a game's grid `nav` at `arena`: `spotsOf(arena, nav.spawnSpots())` (game.mjs:
   * shared/arenas.mjs arenaSpots), the same list. In a wood (the Sparrenhof) that looks at every spot, 5 to 9 ms a
   * start; it keeps a spot or not by where it is alone, and a car only takes spots away. So it is worked out once on
   * the place's grid with no car, and a game's are those of that list still among its own spots, as copies. A car on
   * one of them (it would never park so deep in a wood): worked out over its spots, as before.
   */
  spots(arena, nav) {
    const all = nav.spawnSpots();
    if (!this.places.has(arena) || !this.bases.has(this.keyOf(arena))) return this.spotsOf(arena, all);
    const w = this.woodOf(arena);
    if (w.same) return all; // arenaSpots gives them back as they are (not in a wood)
    const here = new Set(all.map((s) => s.node));
    const kept = w.spots.filter((s) => here.has(s.node));
    return kept.length === w.spots.length ? kept.map((s) => ({ ...s })) : this.spotsOf(arena, all);
  }

  /** A kept place's spots on its grid with no car (spots): `same` when spotsOf gives the list back as it is. */
  woodOf(arena) {
    if (!this.woods.has(arena.id)) {
      const free = navOn(this.base(arena), []).spawnSpots();
      const spots = this.spotsOf(arena, free);
      this.woods.set(arena.id, spots === free ? { same: true } : { same: false, spots });
    }
    return this.woods.get(arena.id);
  }

  /** The part of `arena`'s grid that never changes: kept, or made now (and kept when the place is on the list). */
  base(arena) {
    const id = this.keyOf(arena);
    if (!this.places.has(arena) || !this.ids.has(id)) return run(this.steps(arena));
    if (!this.bases.has(id)) this.bases.set(id, run(this.pending.get(id) ?? this.steps(arena)));
    this.pending.delete(id);
    return this.bases.get(id);
  }

  /** A game's grid at `arena` with the cars of `boxes` where they stand (shared/zombies.mjs navOn): its own. */
  nav(arena, boxes = []) {
    return navOn(this.base(arena), boxes);
  }

  /** A place's part in steps: its arguments (the village's ground, made once per place in game.mjs), then the grid's. */
  * steps(arena) {
    const opts = this.optsOf(arena);
    yield;
    return yield* navBaseSteps(opts);
  }

  /**
   * Every place of `arenas` made in slices (SLICE_MS, GAP_MS apart), those not kept yet, one after the other, then
   * each one's spots with no car (woodOf). `done()` when all are made. Called while one runs: nothing more.
   */
  warm(arenas, { slice = SLICE_MS, gap = GAP_MS, done = () => {} } = {}) {
    if (this.timer) return;
    const todo = new Map(); // key -> its first place
    for (const a of arenas) if (this.places.has(a) && !todo.has(this.keyOf(a))) todo.set(this.keyOf(a), a);
    const work = (function* (cache) {
      for (const [key, a] of todo) {
        if (!cache.bases.has(key)) {
          if (!cache.pending.has(key)) cache.pending.set(key, cache.steps(a));
          const it = cache.pending.get(key);
          for (;;) {
            if (cache.bases.has(key)) break; // a start finished it meanwhile
            const r = it.next();
            if (r.done) {
              cache.bases.set(key, r.value);
              cache.pending.delete(key);
              break;
            }
            yield;
          }
          yield;
        }
      }
      // Each place's spots with no car (spots), which makes a game's grid on each once too: its code warm as well.
      for (const a of arenas) {
        if (!cache.places.has(a) || cache.woods.has(a.id)) continue;
        cache.woodOf(a);
        yield;
      }
    })(this);
    this.held = []; // how long each slice held the server (ms), for the checks
    const tick = () => {
      const t0 = performance.now();
      for (;;) {
        const end = work.next().done;
        if (end || performance.now() - t0 >= slice) {
          this.held.push(performance.now() - t0);
          if (!end) break;
          this.timer = null;
          return done();
        }
      }
      this.timer = setTimeout(tick, gap);
      this.timer.unref?.();
    };
    this.timer = setTimeout(tick, gap);
    this.timer.unref?.();
  }

  /** The warm-up stopped (tests). */
  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** How many bytes the kept parts' arrays take (the checks). */
  bytes() {
    let sum = 0;
    for (const b of this.bases.values()) {
      for (const v of Object.values(b)) if (ArrayBuffer.isView(v)) sum += v.byteLength;
      for (const v of Object.values(b.links)) if (ArrayBuffer.isView(v)) sum += v.byteLength;
      sum += (b.paned.length + b.blkPane.length) * 8;
    }
    return sum;
  }
}

/** A generator run to its end: what it returns. */
function run(it) {
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}
