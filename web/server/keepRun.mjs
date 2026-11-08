// "Keep this run" (Yoshi, 8 Nov 2026): a guest who played Zombies together and reached a good wave can make an
// account within KEEP_MS and have that run on the board.
//
// - What is kept: the guest's last finished run, as the server recorded it (server/zombies.mjs over: the place,
//   the wave, the zombies they beat, the team's size). Never a value from the page.
// - Keyed by the guest's session (its key, a hash of the HttpOnly cookie's random token: server/auth.mjs keyOf).
//   Only a request carrying that same session cookie can see it or claim it (server/accounts.mjs register).
// - Claimed once, then forgotten. Forgotten anyway after KEEP_MS, and on logging out (server.mjs). A session
//   that ended otherwise (kicked, expired) can't be presented any more, and its run goes within KEEP_MS.
// - In memory only, never in the store: a restart forgets every one. At most MAX at once (the oldest go).

export const KEEP_MS = 10 * 60_000;
export const KEEP_MIN_WAVE = 3; // a "good wave": below it the end screen offers nothing
const MAX = 2000;

export class GuestRuns {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.runs = new Map(); // session key -> { place, wave, kills, team, until }
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref?.();
  }

  /**
   * A finished run for the guest session `key`: it replaces their earlier one. Only whole numbers in range, a
   * place id, and a wave of KEEP_MIN_WAVE or more; anything else is not kept.
   */
  offer(key, { place, wave, kills, team }) {
    if (typeof key !== 'string' || !key) return false;
    if (typeof place !== 'string' || !/^[a-z][a-z0-9_]{0,30}$/.test(place)) return false;
    const whole = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;
    if (!whole(wave, 10_000) || !whole(kills, 1_000_000) || !whole(team, 64) || wave < KEEP_MIN_WAVE || team < 1) return false;
    this.runs.delete(key); // to the end of the order: the oldest go first
    this.runs.set(key, { place, wave, kills, team, until: this.now() + KEEP_MS });
    while (this.runs.size > MAX) this.runs.delete(this.runs.keys().next().value);
    return true;
  }

  /** The run waiting for `key` (with `ms` left), or null. Doesn't claim it. */
  peek(key) {
    const r = this.runs.get(key);
    if (!r) return null;
    const ms = r.until - this.now();
    if (ms <= 0) {
      this.runs.delete(key);
      return null;
    }
    return { place: r.place, wave: r.wave, kills: r.kills, team: r.team, ms };
  }

  /** Claim the run for `key`: given once, then gone. */
  take(key) {
    const r = this.peek(key);
    this.runs.delete(key);
    return r;
  }

  drop(key) {
    this.runs.delete(key);
  }

  sweep() {
    const now = this.now();
    for (const [k, r] of this.runs) if (r.until <= now) this.runs.delete(k);
  }

  close() {
    clearInterval(this.timer);
  }
}
