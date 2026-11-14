// Something to do alone in the open world (src/world/goals.ts): garden gnomes to find (shared/gnomes.json) and timed
// routes (shared/routes.json). The rules in plain numbers and strings, without the page, so node tests them and a later
// server can use them: what this browser keeps (found gnomes, best times) read back safely, and a run along a route.

/** A best time is kept only from 3 s to an hour, in whole milliseconds. */
export const TIME_MIN = 3000;
export const TIME_MAX = 3600000;
/** A run stops after this long without a checkpoint. */
export const TIMEOUT_MS = 120000;
/** The longest step of one frame that keeps a run going (longer: a teleport, a portal, a respawn). */
export const STEP_MAX = { foot: 5, bike: 8, car: 20 };
/** The most items of a stored list that are looked at. */
const LIST_MAX = 200;

/** JSON from storage as a plain object of version 1, else null. */
function parse(text) {
  if (typeof text !== 'string' || text.length > 100000) return null;
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v) || v.v !== 1) return null;
  return v;
}

/** The found gnomes from storage text: only ids in `ids`, each once; `told`: the intro was shown. */
export function readFound(text, ids) {
  const out = { found: [], told: false };
  const v = parse(text);
  if (!v) return out;
  const known = new Set(ids);
  if (Array.isArray(v.found)) {
    const seen = new Set();
    for (const id of v.found.slice(0, LIST_MAX)) {
      if (typeof id === 'string' && known.has(id) && !seen.has(id)) {
        seen.add(id);
        out.found.push(id);
      }
    }
  }
  out.told = v.told === true;
  return out;
}

export function writeFound(found, told) {
  return JSON.stringify({ v: 1, found: [...found], told: told === true });
}

/** A time that may be kept: a finite number of ms from TIME_MIN to TIME_MAX, rounded; else null. */
export function cleanTime(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= TIME_MIN && ms <= TIME_MAX ? Math.round(ms) : null;
}

/** The best times from storage text: only keys in `keys` ("route@rev"), each a time cleanTime keeps. */
export function readBest(text, keys) {
  const best = {};
  const v = parse(text);
  if (!v || !v.best || typeof v.best !== 'object' || Array.isArray(v.best)) return best;
  for (const key of keys) {
    if (typeof key !== 'string' || !Object.hasOwn(v.best, key)) continue;
    const ms = cleanTime(v.best[key]);
    if (ms !== null) best[key] = ms;
  }
  return best;
}

export function writeBest(best) {
  const out = {};
  for (const [key, ms] of Object.entries(best)) {
    const t = cleanTime(ms);
    if (t !== null) out[key] = t;
  }
  return JSON.stringify({ v: 1, best: out });
}

/** The key a route's best time is kept under: a changed layout (a higher rev) starts fresh. */
export const bestKey = (route) => `${route.id}@${route.rev}`;

/** Whether the step from a to b comes within r of c. */
export function passes(ax, az, bx, bz, cx, cz, r) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let s = len2 > 0 ? ((cx - ax) * dx + (cz - az) * dz) / len2 : 0;
  s = Math.max(0, Math.min(1, s));
  return Math.hypot(ax + dx * s - cx, az + dz * s - cz) < r;
}

/** The points of a route in order: its checkpoints, then the gate again (the finish). */
export const pointsOf = (route) => [...route.checkpoints, route.gate];

/**
 * One frame of a run along `route`, the step from `from` to `to` ({ x, z }) moving `by` ('foot', 'bike', 'car' or null).
 * `run`: null, or { id, next (index into pointsOf), t0, last } (ms). Returns the run after it and what happened:
 * 'start' (through the gate, from outside it, in a step no longer than STEP_MAX, towards the first checkpoint, moving as the route asks), 'checkpoint',
 * 'finish' (with `time` in ms), 'stop' (moved another way, a step too long, or too long since the last point), or null.
 */
export function stepRun(run, route, from, to, by, nowMs) {
  const r = route.radius;
  const [gx, gz] = route.gate;
  if (!run || run.id !== route.id) {
    if (by !== route.by) return { run: null, event: null };
    if (Math.hypot(from.x - gx, from.z - gz) < r) return { run: null, event: null }; // already in it: go through it
    // A hop (a trip, a respawn, a teleport) is no way through it.
    if (!(Math.hypot(to.x - from.x, to.z - from.z) <= (STEP_MAX[route.by] ?? 5))) return { run: null, event: null };
    if (!passes(from.x, from.z, to.x, to.z, gx, gz, r)) return { run: null, event: null };
    const [fx, fz] = route.checkpoints[0];
    if ((to.x - from.x) * (fx - gx) + (to.z - from.z) * (fz - gz) <= 0) return { run: null, event: null }; // the wrong way
    return { run: { id: route.id, next: 0, t0: nowMs, last: nowMs }, event: 'start' };
  }
  const step = Math.hypot(to.x - from.x, to.z - from.z);
  if (by !== route.by || !(step <= (STEP_MAX[route.by] ?? 5)) || nowMs - run.last > TIMEOUT_MS) return { run: null, event: 'stop' };
  const points = pointsOf(route);
  const [px, pz] = points[run.next];
  if (!passes(from.x, from.z, to.x, to.z, px, pz, r)) return { run, event: null };
  if (run.next >= points.length - 1) return { run: null, event: 'finish', time: nowMs - run.t0 };
  return { run: { ...run, next: run.next + 1, last: nowMs }, event: 'checkpoint' };
}

/** A time as m:ss.d (`0:23.4`), with a decimal comma when `comma` (`1:07,4`). */
export function formatTime(ms, comma = false) {
  const tenths = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 100));
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  const d = tenths % 10;
  return `${m}:${String(s).padStart(2, '0')}${comma ? ',' : '.'}${d}`;
}
