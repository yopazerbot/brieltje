import { TICK_MS } from '../../shared/wire.mjs';

/**
 * Drawing the others smoothly (shared/wire.mjs). Everything another page or the server moves (the
 * players, the cars they drive, the horses they ride, the strongmen) is drawn a little in the past,
 * between two of the states the server sent, on the server's clock. So it moves at an even pace
 * however unevenly the packets come, stops where it stopped and turns where it turned.
 *
 * The clock (`netClock`): each tick carries the server's time. The page keeps the smallest gap seen
 * between that and its own clock over the last few seconds (the tick that came quickest) and draws
 * `delay` ms behind it. The delay is what the ticks need: one tick's wait, how much later than the
 * quickest they come, and how old the new states in them are (a player's page sends 20 a second),
 * each as 9 ticks in 10 have it (the rare worse one is bridged by carrying on, below), so about two
 * ticks (100 to 130 ms) on a steady connection, more while the network jitters. It changes gently:
 * the drawing time runs at most 15% faster or slower.
 *
 * A track (`Track`): one thing's states with their times, interpolated at the drawing time. When the
 * newest is older than that (a late packet) it carries on at its last speed for EXTRA ms, then slows
 * to a stop over about EASE ms more (on WebSocket a lost packet holds up the ones behind it for about
 * a quarter of a second, then they all come at once); when the next state comes, the difference is
 * taken out over about 0.1 s instead of in one jump. A teleport (respawn, portal) or a reconnect
 * starts a track again.
 */

const WINDOW = 4000; // ms of ticks the gap and the delay look back over
const EXTRA = 100; // ms a thing carries on past its newest state at its full speed...
const EASE = 100; // ...then slowing to a stop over about this long (a lost packet holds the ones behind it for ~250 ms)
const SETTLE = 80; // ms over which a correction fades

/** The value 9 in 10 are at or under. */
function p90(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(0.9 * (s.length - 1))];
}

export class NetClock {
  /** Goes up on every new connection (perhaps a restarted server with a new clock): tracks start again. */
  epoch = 0;
  /** The time to draw at (the server's clock, ms), set each frame by `frame`; NaN before the first tick. */
  time = NaN;
  /** The delay aimed at (ms), and what it is made of, for the diagnostics. */
  delay = 2 * TICK_MS;
  late = 0;
  age = 0;
  /** Ticks in the last second */
  rate = 0;
  private gaps: { at: number; v: number; stalled: boolean }[] = [];
  private ages: { at: number; v: number }[] = [];
  private best = NaN; // the quickest gap: the server's clock minus this page's
  private st = NaN; // the last tick's time
  private tickAge = 0; // the oldest new state in it
  private shift = NaN; // drawing time minus local time
  private frameAt = 0;

  /** A new connection: forget the old server's clock. */
  reset(): void {
    this.epoch++;
    this.gaps = [];
    this.ages = [];
    this.best = this.st = this.shift = this.time = NaN;
  }

  /**
   * A tick: the server's time `st`, come in at `local` (performance.now()). Ticks read just after the
   * page stood still (a long frame: loading, building a shader) only came late to it, not over the
   * network, and the ones queued behind them are all there: their lateness doesn't count. Nor does
   * that of the ticks before one that came much quicker than all of them: those waited behind the
   * page's own work (just after joining, while everything loads), or took a slower route.
   */
  tick(st: number, local: number): void {
    if (!Number.isNaN(this.st)) this.ages.push({ at: local, v: this.tickAge });
    this.st = st;
    this.tickAge = 0;
    const gap = st - local;
    if (gap - this.best > 50) this.gaps = [];
    this.gaps.push({ at: local, v: gap, stalled: local - this.frameAt > 80 });
    while (this.gaps[0].at < local - WINDOW) this.gaps.shift();
    while (this.ages.length && this.ages[0].at < local - WINDOW) this.ages.shift();
    this.rate = this.gaps.filter((g) => g.at > local - 1000).length;
    let best = -Infinity;
    for (const g of this.gaps) best = Math.max(best, g.v);
    this.best = best;
    this.late = p90(this.gaps.filter((g) => !g.stalled).map((g) => best - g.v));
    this.age = p90(this.ages.map((a) => a.v));
    this.delay = Math.min(400, Math.max(90, TICK_MS + this.late + this.age + 10));
  }

  /** A track got a new state taken at `t` (in the last tick): how old it was when it came. */
  seen(t: number): void {
    const age = this.st - t;
    if (age >= 0 && age < 400) this.tickAge = Math.max(this.tickAge, age);
  }

  /** Every frame: the drawing time, moved gently towards where it should be. */
  frame(local: number): void {
    const dt = Math.max(0, local - this.frameAt);
    this.frameAt = local;
    if (Number.isNaN(this.best)) return;
    const want = this.best - this.delay;
    if (Number.isNaN(this.shift) || Math.abs(want - this.shift) > 500) this.shift = want;
    else this.shift += Math.max(-0.15 * dt, Math.min(0.15 * dt, want - this.shift));
    this.time = local + this.shift;
  }
}

export const netClock = new NetClock();

interface Sample<T> {
  t: number;
  v: number[];
  d: T;
  /** It doesn't move on from here (a parked car): never carried on past it */
  still: boolean;
}

const turn = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a)); // from a to b the short way

export class Track<T> {
  private buf: Sample<T>[] = [];
  private epoch = -1;
  private corr: number[];
  private lastR = NaN;
  private lastRaw: number[];
  private newestAtLast = -Infinity;
  private grew = false;
  private tmp: number[];
  /** The data of the state drawn by the last `at` */
  shown: T | undefined;

  /**
   * `angles`: which of the values are angles (they go the short way round); `jump`: a move this far
   * (m, in x and z, the first two position values `xz` picks) between two states is a teleport.
   */
  constructor(private angles: readonly boolean[], private jump: number, private xz: readonly [number, number] = [0, 2]) {
    this.corr = angles.map(() => 0);
    this.lastRaw = angles.map(() => 0);
    this.tmp = angles.map(() => 0);
  }

  get size(): number {
    return this.epoch === netClock.epoch ? this.buf.length : 0;
  }

  clear(): void {
    this.buf = [];
    this.corr.fill(0);
    this.lastR = NaN;
  }

  /** A state at the server's time `t`. `reset`: start again from it (a teleport). `still`: it stays here. */
  push(t: number, v: number[], d: T, reset = false, still = false): void {
    if (this.epoch !== netClock.epoch) {
      this.epoch = netClock.epoch;
      this.clear();
    }
    const buf = this.buf;
    const last = buf[buf.length - 1];
    const [i, k] = this.xz;
    if (reset || !last || Math.hypot(v[i] - last.v[i], v[k] - last.v[k]) > this.jump) {
      this.clear();
      this.buf.push({ t, v, d, still });
      return;
    }
    if (t <= last.t) {
      // Not newer (a keyframe's copy): only the same moment again updates it.
      if (t === last.t) Object.assign(last, { v, d, still });
      this.grew = true;
      return;
    }
    // After a pause (it stood still, or it is new): it stood until just before this state, rather
    // than creeping all the way from the last one.
    const prev = buf[buf.length - 2];
    if (t - last.t > 150 && (last.still || !prev || prev.v.every((x, j) => x === last.v[j]))) {
      buf.push({ t: Math.max(last.t + 1, t - TICK_MS), v: last.v, d: last.d, still: last.still });
    }
    buf.push({ t, v, d, still });
    if (buf.length > 64) buf.shift();
    this.grew = true;
    netClock.seen(t);
  }

  /** It didn't change up to `t` (a strongman left out of a tick). */
  hold(t: number): void {
    const last = this.buf[this.buf.length - 1];
    if (this.epoch === netClock.epoch && last && t > last.t) this.push(t, last.v, last.d, false, last.still);
  }

  /** Where it is at the drawing time `r`, into `out`; false when there is nothing to draw (yet). */
  at(r: number, out: number[]): boolean {
    if (!this.size || Number.isNaN(r)) return false;
    // A state that came since the last frame moved where it should have been then (it was carrying
    // on past the newest): fade the difference out rather than jump.
    if (this.grew && !Number.isNaN(this.lastR) && this.lastR > this.newestAtLast) {
      this.raw(this.lastR, this.tmp);
      for (let j = 0; j < out.length; j++) this.corr[j] += this.angles[j] ? turn(this.tmp[j], this.lastRaw[j]) : this.lastRaw[j] - this.tmp[j];
    }
    this.grew = false;
    const buf = this.buf;
    while (buf.length > 2 && buf[1].t <= r) buf.shift();
    this.raw(r, out);
    const fade = Number.isNaN(this.lastR) ? 0 : Math.exp(-Math.max(0, r - this.lastR) / SETTLE);
    const [i, k] = this.xz;
    if (Math.hypot(this.corr[i], this.corr[k]) > 3) this.corr.fill(0); // too far to glide: just be there
    this.lastR = r;
    this.newestAtLast = buf[buf.length - 1].t;
    for (let j = 0; j < out.length; j++) {
      this.lastRaw[j] = out[j];
      this.corr[j] *= fade;
      out[j] += this.corr[j];
    }
    return true;
  }

  /** The states interpolated at `r`, carried on a little past the newest. */
  private raw(r: number, out: number[]): void {
    const buf = this.buf;
    const n = buf.length;
    let a = buf[0];
    let b = buf[0];
    let f = 0;
    if (r <= buf[0].t || n === 1) {
      this.shown = a.d;
    } else if (r >= buf[n - 1].t) {
      a = buf[n - 2];
      b = buf[n - 1];
      const span = b.t - a.t;
      this.shown = b.d;
      // Late: on at its last speed for a moment, then slowing until it stands.
      const late = r - b.t;
      const carry = late <= EXTRA ? late : EXTRA + EASE * (1 - Math.exp(-(late - EXTRA) / EASE));
      f = !b.still && span > 0 && span <= 250 ? 1 + carry / span : 1;
    } else {
      let j = 0;
      while (buf[j + 1].t <= r) j++;
      a = buf[j];
      b = buf[j + 1];
      f = (r - a.t) / (b.t - a.t);
      this.shown = a.d;
    }
    for (let j = 0; j < out.length; j++) out[j] = this.angles[j] ? a.v[j] + turn(a.v[j], b.v[j]) * f : a.v[j] + (b.v[j] - a.v[j]) * f;
  }
}
