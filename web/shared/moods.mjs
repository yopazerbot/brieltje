// The weather and the time of day the world can be shown in (src/world/weather.ts draws them). Alone each player
// picks one in their settings; together the admin picks it for everyone and the server keeps it
// (server/game.mjs, the 'mood' message). The server takes only a name from CHOICES.
// A new mood (dusk, snow) is added to MOODS here (with its weight and length below), then given its look in
// src/world/weather.ts and its name in src/i18n.ts ('mood.<name>').
//
// 'auto' (the default, Yoshi: "I also want the weather to automatically cycle, but don't rush it too much"): the
// moods follow each other by themselves, slowly. The order and the lengths come from a seed and a start time
// (MoodCycle): together the server's, so every page works out the same weather from the server's clock; alone the
// page's own.

export const MOODS = ['sunny', 'overcast', 'rain', 'night'];

/** What can be chosen: a mood, or 'auto'. */
export const CHOICES = ['auto', ...MOODS];

/** The choice everyone starts with. */
export const DEFAULT_CHOICE = 'auto';

/** The mood the cycle starts in (the start screen's look). */
export const DEFAULT_MOOD = 'sunny';

/** Whether `m` is one of MOODS (a string, exactly). */
export function isMood(m) {
  return typeof m === 'string' && MOODS.includes(m);
}

/** Whether `c` is one of CHOICES (a string, exactly). */
export function isChoice(c) {
  return typeof c === 'string' && CHOICES.includes(c);
}

/** Milliseconds a change of mood takes in the cycle: the last part of each mood blends into the next. */
export const BLEND_MS = 150_000;
/** Milliseconds for the ground to dry to about a third after the rain. */
export const DRY_MS = 240_000;

/**
 * How often each mood comes, against the others, and how long it holds (minutes, from and to). Sunny weighs most:
 * after a night only clouds or rain may come, which would otherwise make overcast the most common.
 */
const WEIGHT = { sunny: 6, overcast: 3, rain: 2, night: 1.5 };
const MINUTES = { sunny: [20, 40], overcast: [20, 40], rain: [20, 40], night: [10, 20] };
/** Never straight from the one to the other: a sunny afternoon goes through clouds to the night, and back. */
const NEVER = { sunny: ['night'], night: ['sunny'] };

/** A small seeded random number generator (mulberry32): the same seed gives the same weather everywhere. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The mood after `now`: never the same again, never a jump NEVER forbids, the common ones more often. */
function pick(r, now) {
  const can = MOODS.filter((m) => m !== now && !(NEVER[now] ?? []).includes(m));
  const total = can.reduce((s, m) => s + WEIGHT[m], 0);
  let x = r() * total;
  for (const m of can) if ((x -= WEIGHT[m]) < 0) return m;
  return can[can.length - 1];
}

function span(r, m) {
  const [a, b] = MINUTES[m];
  return Math.round((a + r() * (b - a)) * 60_000);
}

/**
 * How fast the cycle may run (Yoshi: "Fast forward should also be possible for the admin in production"): as is, ten
 * times or sixty times as fast. Only these.
 */
export const SPEEDS = [1, 10, 60];

/**
 * A cycle's timing: its `seed`, and its own clock, `tau` ms at the moment `at` (ms on the clock it is read with),
 * running `speed` times as fast. MoodCycle reads the cycle's clock (cycleTime).
 */
export function newCycle(seed, now) {
  return { seed: seed >>> 0, at: now, tau: 0, speed: 1 };
}

/** The cycle's own clock at `now`. */
export function cycleTime(c, now) {
  return c.tau + Math.max(0, now - c.at) * c.speed;
}

/** Whether `c` is a cycle's timing as the server sends it. */
export function isCycle(c) {
  return !!c && typeof c === 'object' && Number.isInteger(c.seed) && c.seed >= 0 && c.seed < 2 ** 32 && Number.isFinite(c.at) && Number.isFinite(c.tau)
    && c.tau >= 0 && SPEEDS.includes(c.speed);
}

/** The same cycle running at `speed` from `now` on (it goes on from where it is). */
export function withSpeed(c, now, speed) {
  return { seed: c.seed, at: now, tau: cycleTime(c, now), speed };
}

/**
 * The same cycle with the mood shown now ended: its clock jumps to where the blend into the next mood begins, so the
 * change starts now and takes its usual time. Null while a change is already under way (nothing to skip to).
 */
export function skipCycle(c, run, now) {
  const tau = cycleTime(c, now);
  const s = run.at(tau);
  if (s.blend > 0) return null;
  return { seed: c.seed, at: now, tau: Math.max(tau, s.until - BLEND_MS), speed: c.speed };
}

/**
 * The cycle of moods from `seed`, starting sunny at `start` (ms, the clock it is read with). `at(t)` says what it is at
 * time t: `mood` now, `next` after it, `blend` 0 to 1 towards it (the last BLEND_MS of each mood, eased), `until` when
 * `next` takes over, and `wet` 0 to 1 (the rain's, ramping up as it comes and drying slowly after). Reading forward
 * goes on from where it was; reading back starts again from the start.
 */
export class MoodCycle {
  constructor(seed, start) {
    this.seed = seed >>> 0;
    this.start = start;
    this.reset();
  }

  reset() {
    this.r = random(this.seed);
    this.mood = DEFAULT_MOOD;
    this.from = this.start;
    this.length = span(this.r, this.mood);
    this.next = pick(this.r, this.mood);
    this.rainEnd = -Infinity;
  }

  at(t) {
    if (t < this.from) this.reset();
    t = Math.max(t, this.start);
    while (this.from + this.length <= t) {
      if (this.mood === 'rain') this.rainEnd = this.from + this.length;
      this.from += this.length;
      this.mood = this.next;
      this.length = span(this.r, this.mood);
      this.next = pick(this.r, this.mood);
    }
    const until = this.from + this.length;
    const x = Math.min(1, Math.max(0, (t - (until - BLEND_MS)) / BLEND_MS));
    const blend = x * x * (3 - 2 * x);
    const drying = t >= this.rainEnd ? Math.exp(-(t - this.rainEnd) / DRY_MS) : 0;
    const wet = this.mood === 'rain' ? 1 : Math.max(this.next === 'rain' ? blend : 0, drying);
    return { mood: this.mood, next: this.next, blend, until, wet };
  }
}
