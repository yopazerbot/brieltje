// The weather and the time of day the world can be shown in (src/world/weather.ts draws them). Alone each player
// picks one in their settings; together the admin picks it for everyone and the server keeps it
// (server/game.mjs, the 'mood' message). The server takes only a name from CHOICES.
// A new mood is added to MOODS here (with its weight, length and rules below), then given its look in
// src/world/weather.ts and its name in src/i18n.ts ('mood.<name>').
//
// 'auto' (the default, Yoshi: "I also want the weather to automatically cycle, but don't rush it too much"): the
// moods follow each other by themselves, slowly. The order and the lengths come from a seed and a start time
// (MoodCycle): together the server's, so every page works out the same weather from the server's clock; alone the
// page's own.

export const MOODS = ['sunny', 'overcast', 'rain', 'dusk', 'night', 'snow'];

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
export const BLEND_MS = 60_000;
/** Milliseconds for the ground to dry to about a third after the rain. */
export const DRY_MS = 240_000;
/** Milliseconds for the snow to cover everything once it starts falling (on Auto). */
export const SNOW_BUILD_MS = 150_000;
/** Milliseconds for the snow lying to melt to about a third once it stops falling. */
export const SNOW_MELT_MS = 600_000;

/**
 * How often each mood comes, against the others, and how long it holds (minutes, from and to). Sunny weighs most.
 * The night comes only after dusk, so dusk's weight is the night's too. Snow only in winter (WINTER), and seldom.
 */
const WEIGHT = { sunny: 6, overcast: 3, rain: 2, dusk: 1.6, night: 1, snow: 1 };
// Every mood holds 5 minutes (Yoshi, 8 Nov 2026: "make weather change every 5 mins"); before, 10 to 40.
const MINUTES = { sunny: [5, 5], overcast: [5, 5], rain: [5, 5], dusk: [5, 5], night: [5, 5], snow: [5, 5] };
/**
 * Never straight from the one to the other. A day goes through dusk into the night, never straight from noon to night,
 * and the morning after comes grey (clouds, rain, in winter snow): never from the night straight back to sunny or dusk.
 * Snow falls from a grey sky: never straight out of the sun.
 */
const NEVER = { sunny: ['night', 'snow'], night: ['sunny', 'dusk'] };
/** Only after one of these: the night after dusk. */
const AFTER = { night: ['dusk'] };
/** Only to this: dusk always turns into the night. */
const ONLY = { dusk: ['night'] };

/**
 * Whether it is winter at `ms` by the Belgian date: December, January or February. Snow comes on Auto only then (the
 * server's date together, the page's alone); picked by hand, always.
 */
let month = null;
try {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Brussels', month: 'numeric' });
  month = (ms) => Number(f.format(ms));
} catch {
  month = (ms) => new Date(ms + 3_600_000).getUTCMonth() + 1; // no time zones here: Belgian winter time is near enough
}
export function winterAt(ms) {
  const m = month(ms);
  return m === 12 || m === 1 || m === 2;
}

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

/** The moods that may follow `now`: never the same again, never a jump the rules above forbid, snow only in winter. */
export function canFollow(now, winter) {
  return MOODS.filter((m) => m !== now && !(NEVER[now] ?? []).includes(m) && (!AFTER[m] || AFTER[m].includes(now))
    && (!ONLY[now] || ONLY[now].includes(m)) && (m !== 'snow' || winter));
}

/** The mood after `now`, the common ones more often. One draw whatever the choice, so the lengths stay in step. */
function pick(r, now, winter) {
  const can = canFollow(now, winter);
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
 * running `speed` times as fast. `winter`: snow may come (the date when it was made); `first`: the mood it starts in
 * (sunny, unless it was made again when the season turned: then the mood shown at that moment). MoodCycle reads the
 * cycle's clock (cycleTime).
 */
export function newCycle(seed, now, winter = false, first = DEFAULT_MOOD) {
  return { seed: seed >>> 0, at: now, tau: 0, speed: 1, winter: !!winter, first: isMood(first) ? first : DEFAULT_MOOD };
}

/** The cycle's own clock at `now`. */
export function cycleTime(c, now) {
  return c.tau + Math.max(0, now - c.at) * c.speed;
}

/** Whether `c` is a cycle's timing as the server sends it (an older server sends no `winter` or `first`). */
export function isCycle(c) {
  return !!c && typeof c === 'object' && Number.isInteger(c.seed) && c.seed >= 0 && c.seed < 2 ** 32 && Number.isFinite(c.at) && Number.isFinite(c.tau)
    && c.tau >= 0 && SPEEDS.includes(c.speed) && (c.winter === undefined || typeof c.winter === 'boolean') && (c.first === undefined || isMood(c.first));
}

/** The run of moods a cycle's timing gives (its seed, season and first mood), read on the cycle's own clock. */
export function runOf(c) {
  return new MoodCycle(c.seed, 0, { winter: !!c.winter, first: c.first });
}

/** Whether two cycles' timings give the same run of moods (only their clocks may differ). */
export function sameRun(a, b) {
  return !!a && !!b && a.seed === b.seed && !!a.winter === !!b.winter && (a.first ?? DEFAULT_MOOD) === (b.first ?? DEFAULT_MOOD);
}

/** The same cycle running at `speed` from `now` on (it goes on from where it is). */
export function withSpeed(c, now, speed) {
  return { ...c, at: now, tau: cycleTime(c, now), speed };
}

/**
 * The same cycle with the mood shown now ended: its clock jumps to where the blend into the next mood begins, so the
 * change starts now and takes its usual time. Null while a change is already under way (nothing to skip to).
 */
export function skipCycle(c, run, now) {
  const tau = cycleTime(c, now);
  const s = run.at(tau);
  if (s.blend > 0) return null;
  return { ...c, at: now, tau: Math.max(tau, s.until - BLEND_MS) };
}

/**
 * The season turned (`winter` now, by the date): a new cycle from `seed` that starts in the mood shown, so nothing
 * jumps, with snow now allowed or not. Null while that would show (a change under way, wet ground, snow lying): it is
 * tried again later.
 */
export function seasonCycle(c, run, now, winter, seed) {
  if (!!c.winter === !!winter) return null;
  const s = run.at(cycleTime(c, now));
  if (s.blend > 0 || s.wet > 0.02 || s.snow > 0.02) return null;
  return { ...newCycle(seed, now, winter, s.mood), speed: c.speed };
}

/**
 * The cycle of moods from `seed`, starting in `first` (sunny) at `start` (ms, the clock it is read with), with snow
 * only when `winter`. `at(t)` says what it is at time t: `mood` now, `next` after it, `blend` 0 to 1 towards it (the
 * last BLEND_MS of each mood, eased), `until` when `next` takes over, `progress` 0 to 1 through the mood (dusk
 * darkens with it), `wet` 0 to 1 (the rain's, ramping up as it comes and drying slowly after) and `snow` 0 to 1 (the
 * snow lying: building up while it falls, melting slowly after). Reading forward goes on from where it was; reading
 * back starts again from the start.
 */
export class MoodCycle {
  constructor(seed, start, { winter = false, first = DEFAULT_MOOD } = {}) {
    this.seed = seed >>> 0;
    this.start = start;
    this.winter = !!winter;
    this.first = isMood(first) ? first : DEFAULT_MOOD;
    this.reset();
  }

  reset() {
    this.r = random(this.seed);
    this.mood = this.first;
    this.from = this.start;
    this.length = span(this.r, this.mood);
    this.next = pick(this.r, this.mood, this.winter);
    this.rainEnd = -Infinity;
    // The snow: when it began to fall (the blend into it) and when it stopped (halfway through the blend out of it).
    this.snowFrom = this.mood === 'snow' ? this.from - BLEND_MS : -Infinity;
    this.snowStop = this.mood === 'snow' ? this.from + this.length - BLEND_MS / 2 : -Infinity;
    this.snowBase = 0; // what still lay when this snowfall began: it builds on that
  }

  /** The snow lying at `t` from the last snowfall that stopped before it (melting), or 0. */
  melted(t) {
    if (this.snowFrom === -Infinity || t < this.snowStop) return 0;
    const top = Math.min(1, this.snowBase + Math.min(1, Math.max(0, (this.snowStop - this.snowFrom) / SNOW_BUILD_MS)));
    return top * Math.exp(-(t - this.snowStop) / SNOW_MELT_MS);
  }

  at(t) {
    if (t < this.from) this.reset();
    t = Math.max(t, this.start);
    while (this.from + this.length <= t) {
      if (this.mood === 'rain') this.rainEnd = this.from + this.length;
      this.from += this.length;
      this.mood = this.next;
      this.length = span(this.r, this.mood);
      this.next = pick(this.r, this.mood, this.winter);
      if (this.mood === 'snow') {
        const begins = this.from - BLEND_MS;
        this.snowBase = this.melted(begins); // the next snow builds on what is left
        this.snowFrom = begins;
        this.snowStop = this.from + this.length - BLEND_MS / 2;
      }
    }
    const until = this.from + this.length;
    const x = Math.min(1, Math.max(0, (t - (until - BLEND_MS)) / BLEND_MS));
    const blend = x * x * (3 - 2 * x);
    const drying = t >= this.rainEnd ? Math.exp(-(t - this.rainEnd) / DRY_MS) : 0;
    const wet = this.mood === 'rain' ? 1 : Math.max(this.next === 'rain' ? blend : 0, drying);
    // Snow lying: up while it falls, then melting from what had built up; the next snow builds on what is left.
    const built = (from, to) => Math.min(1, Math.max(0, (to - from) / SNOW_BUILD_MS));
    let snow = 0;
    if (this.snowFrom === -Infinity) snow = 0; // no snow yet
    else if (t >= this.snowStop) snow = this.melted(t);
    else if (t >= this.snowFrom) snow = Math.min(1, this.snowBase + built(this.snowFrom, t));
    // Into the next snowfall: it begins on what still lies then, as it will once the mood has turned.
    if (this.next === 'snow' && t > until - BLEND_MS) snow = Math.min(1, this.melted(until - BLEND_MS) + built(until - BLEND_MS, t));
    const progress = Math.min(1, Math.max(0, (t - this.from) / this.length));
    return { mood: this.mood, next: this.next, blend, until, progress, wet, snow };
  }
}
