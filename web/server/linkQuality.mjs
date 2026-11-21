// Each player's connection, for the host on a LAN night (Yoshi, 21 Nov 2026: "great observability"): every PING_MS a
// WebSocket ping frame to each player's page, which the browser answers by itself (no page code), and per connection,
// in memory only:
//
// - the round trip: the last, a smoothed mean (as TCP's: 1/8 of each new one) and the jitter (as RTP's, RFC 3550: the
//   mean change between two round trips, 1/16 of each new one);
// - the pings it did not answer before the next one;
// - per name, this evening: the reconnects (back after the connection was lost) and the connections lost.
//
// It measures the network only (and Caddy in front): the game's own ping (server/game.mjs pings) is answered by the
// page's code, so it also holds a busy phone's frame; the two side by side tell "the Wi-Fi" from "the phone".
//
// A pong counts only when it carries the ping's own random payload, and only once: a page (or a script) can't make
// its round trip look shorter, and unasked pongs are ignored. An entry is a few numbers, whatever a page does, and it
// goes with its connection's close; the names of the evening are capped at MAX_NAMES. Nothing here is written down
// or sent anywhere: link(name) is for the host's page, group() for the metrics (server/metrics.mjs), counts only.

import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { closeKind } from './metrics.mjs';

export const PING_MS = 2000;
export const SLOW_MS = 150;
export const MAX_NAMES = 1000;
/** A ping unanswered this long when the name connects again: the old connection was gone (a reconnect, not a move). */
const STALE_MS = 1500;

const round = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : null);

export class LinkQuality {
  constructor({ now = () => performance.now(), every = PING_MS, timer = true, payload = () => randomBytes(4) } = {}) {
    this.now = now;
    this.every = every;
    this.auto = timer;
    this.payload = payload;
    this.conns = new Map(); // name -> the connection playing as that name now
    this.names = new Map(); // name -> { reconnects, lost, gone } this evening (MAX_NAMES at most)
    this.missed = 0;
    this.reconnects = 0;
    this.timer = null;
  }

  /** A player's connection (server/game.mjs join). */
  add(ws, name) {
    const now = this.now();
    let rec = this.names.get(name);
    if (!rec && this.names.size < MAX_NAMES) this.names.set(name, (rec = { reconnects: 0, lost: 0, gone: false }));
    // Back after a lost connection: the last one closed as lost, or is still open but had stopped answering (the page
    // noticed first). A move to a room or a reload has a healthy connection behind it, so it isn't counted.
    const old = this.conns.get(name);
    const stale = old && (old.streak > 0 || (old.payload && now - old.at > STALE_MS));
    if (rec?.gone || stale) {
      this.reconnects++;
      if (rec) rec.reconnects++;
    }
    if (rec) rec.gone = false;
    const e = { ws, name, rec, at: 0, payload: null, last: null, mean: null, jitter: 0, missed: 0, streak: 0, pongs: 0 };
    this.conns.set(name, e);
    ws.on('pong', (data) => this.pong(e, data));
    ws.on('close', (code) => this.closed(e, code)); // once: closed() forgets the entry
    if (this.auto && !this.timer) this.timer = setInterval(() => this.ping(), this.every).unref();
  }

  closed(e, code) {
    if (this.conns.get(e.name) !== e) return; // replaced by a newer connection of the same name
    this.conns.delete(e.name);
    if (closeKind(code) === 'lost' && e.rec) {
      e.rec.lost++;
      e.rec.gone = true;
    }
    if (!this.conns.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** A ping to every connection; the one before, if still unanswered, is missed. */
  ping() {
    const now = this.now();
    for (const e of this.conns.values()) {
      if (e.ws.readyState !== e.ws.OPEN) continue;
      if (e.payload) {
        e.missed++;
        e.streak++;
        this.missed++;
      }
      e.payload = this.payload();
      e.at = now;
      try {
        e.ws.ping(e.payload);
      } catch {
        // closing: its 'close' tidies up
      }
    }
  }

  pong(e, data) {
    if (!e.payload || !Buffer.isBuffer(data) || !data.equals(e.payload)) return;
    const rtt = this.now() - e.at;
    e.payload = null;
    e.streak = 0;
    e.pongs++;
    if (e.last !== null) e.jitter += (Math.abs(rtt - e.last) - e.jitter) / 16;
    e.mean = e.mean === null ? rtt : e.mean + (rtt - e.mean) / 8;
    e.last = rtt;
  }

  /** One player's connection for the host's page (ms), or null for a name not seen this evening. */
  link(name) {
    const e = this.conns.get(name);
    const rec = this.names.get(name);
    if (!e && !rec) return null;
    return {
      connected: !!e, rtt: round(e?.last), mean: round(e?.mean), jitter: e && e.pongs > 1 ? round(e.jitter) : null,
      missed: e?.missed ?? 0, waiting: !!e?.payload && this.now() - e.at > this.every, reconnects: rec?.reconnects ?? 0, lost: rec?.lost ?? 0,
    };
  }

  /** The players together (ms): the latest round trips' median, 95th percentile and max, how many are slow; the totals. */
  group() {
    const rtts = [];
    for (const e of this.conns.values()) if (e.last !== null) rtts.push(e.last);
    rtts.sort((a, b) => a - b);
    const at = (p) => (rtts.length ? rtts[Math.min(rtts.length - 1, Math.max(0, Math.ceil(p * rtts.length) - 1))] : 0);
    return {
      measured: rtts.length, median: at(0.5), p95: at(0.95), max: rtts.length ? rtts[rtts.length - 1] : 0,
      slow: rtts.filter((r) => r > SLOW_MS).length, missed: this.missed, reconnects: this.reconnects,
    };
  }
}

export const links = new LinkQuality();
