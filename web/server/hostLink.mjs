// Who has a bad connection, for the host page on a LAN night (server/host.mjs view, web/public/admin/host/): each
// player's numbers from server/linkQuality.mjs (WebSocket pings, answered by the browser itself: the network) beside the
// game's own ping (server/game.mjs pings, answered by the page's code: the network and the device), one of four grades,
// and which of the two is slow. Nothing new is measured, kept or logged: this only reads what is there, for the admin's
// GET /api/host?links=1 (never the plain view the hall screen's watch page reads).
//
// The grades (as a phone's signal: four bars good, three fair, two poor, one bad), from the round trip's smoothed mean:
// - good under GOOD_MS and steady (jitter under JITTER_FAIR);
// - fair under FAIR_MS, or jitter from JITTER_FAIR;
// - poor under POOR_MS, or jitter from JITTER_POOR, or the last round trip from POOR_MS, or a ping missed in the last
//   minute, or one unanswered now, or back after a lost connection less than a minute ago;
// - bad from POOR_MS, or MISSED_BAD pings missed in the last minute, or no answer at all yet while one is overdue.
// Teams' own targets are 100 ms and 30 ms jitter (60 ms and 15 ms at best); a local network should do far better.
//
// When the server itself is late (its event loop's delay or a tick far over its 50 ms: server/monitor.mjs, the host
// page's side strip), every round trip it measures carries that delay: it is taken off before grading, and a missed
// ping counts against nobody while the server was too late (LOST_LAG_MS) to have heard its answer.

import { links } from './linkQuality.mjs';
import { monitor } from './monitor.mjs';

export const GOOD_MS = 60;
export const FAIR_MS = 120;
export const POOR_MS = 250;
export const JITTER_FAIR = 30;
export const JITTER_POOR = 50;
export const MISSED_BAD = 3;
/** Back after a lost connection this recently: at least poor. */
export const BACK_MS = 60_000;
/**
 * The game's ping this much later than the network's: the device is slow. A message waits for the page's main thread,
 * and 50 ms is the web's own long task (the Long Tasks API): a phone at 30 to 60 frames a second adds well under it.
 */
export const DEVICE_MS = 50;
/** The server is busy from this event-loop delay (ms, the 99th percentile, the side strip's "Delays" turns busy here)... */
export const BUSY_LAG_MS = 50;
/** ...or from a tick this long (twice its 50 ms). */
export const BUSY_TICK_MS = 100;
/** A pong has PING_MS (2 s) to come back: with the server this late, a miss may be the server's own. */
export const LOST_LAG_MS = 1000;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const less = (v, d) => (v === null ? null : Math.max(0, v - d));

/** How late the server is now (its latest sample, server/monitor.mjs): busy or not, and the delay (ms) taken off. */
export function serverLoad(sample = monitor.samples.at(-1)) {
  const lag = num(sample?.lagMs) ?? 0;
  const tick = num(sample?.tickMaxMs) ?? 0;
  const busy = lag >= BUSY_LAG_MS || tick >= BUSY_TICK_MS;
  return { busy, lagMs: lag, delay: busy ? Math.max(lag, tick) : 0 };
}

/**
 * One player's connection: the numbers (ms) and its grade (0 good, 1 fair, 2 poor, 3 bad; null while the first
 * answer is awaited) and `slow`: 'network', 'device', 'both' or 'none' (null without a grade). `ping` is the game's own
 * (smoothed, game.mjs), `since` when this connection began (Date.now ms), `link` server/linkQuality.mjs link(name),
 * `recent` its pings missed in the last minute.
 */
export function judge({ link, recent = 0, ping = null, since = null, load = { busy: false, lagMs: 0, delay: 0 }, now = Date.now() }) {
  const d = load.delay;
  const deaf = load.lagMs >= LOST_LAG_MS; // the server too late to have heard the answers: no miss is the player's
  const out = {
    rtt: num(link?.rtt), mean: num(link?.mean), jitter: num(link?.jitter), missed: link ? recent : 0, waiting: !!link?.waiting,
    reconnects: link?.reconnects ?? 0, since, ping: num(ping) === null ? null : Math.round(ping), grade: null, slow: null,
  };
  if (!link) return out;
  const missed = deaf ? 0 : out.missed;
  const waiting = !deaf && out.waiting;
  const mean = less(out.mean, d);
  if (mean === null) {
    // Never answered yet: bad once a ping is overdue or one was missed, else still measuring.
    if (waiting || missed) out.grade = 3;
  } else {
    let g = mean < GOOD_MS ? 0 : mean < FAIR_MS ? 1 : mean < POOR_MS ? 2 : 3;
    const jitter = less(out.jitter, d) ?? 0;
    if (jitter >= JITTER_POOR) g = Math.max(g, 2);
    else if (jitter >= JITTER_FAIR) g = Math.max(g, 1);
    if ((less(out.rtt, d) ?? 0) >= POOR_MS) g = Math.max(g, 2);
    if (missed >= MISSED_BAD) g = 3;
    else if (missed || waiting) g = Math.max(g, 2);
    if (out.reconnects && since !== null && now - since < BACK_MS) g = Math.max(g, 2);
    out.grade = g;
  }
  if (out.grade === null) return out;
  const page = less(out.ping, d);
  const device = page !== null && mean !== null && page - mean >= DEVICE_MS;
  out.slow = out.grade >= 2 ? (device ? 'both' : 'network') : device ? 'device' : 'none';
  return out;
}

/** The host view's `link` for a player (server/host.mjs person): `p` the game's player, as connectionOf reads it. */
export function linkOf(name, p, load, now = Date.now()) {
  return judge({ link: links.link(name), recent: links.recent(name), ping: p.rttAvg, since: p.joinTime ?? null, load, now });
}
