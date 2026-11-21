// The game server's own numbers for Prometheus (Yoshi, 21 Nov 2026: "build the hybrid setup with Grafana"), for the
// LAN night's monitoring (lan/compose.yaml, profile `monitor`; lan/monitor/). Written by hand in Prometheus's text
// exposition format 0.0.4 (prometheus.io/docs/instrumenting/exposition_formats): no package.
//
// What is counted: the game's ticks and the event loop, who is connected (counts only), the messages by type, the
// bytes, the games on, the process (memory, CPU, garbage collection), the HTTP answers, and the connections' round
// trips as a group (server/linkQuality.mjs). Every hook is a counter or a number kept in place: nothing grows with the
// players, and a scrape walks the games (at most a handful) and counts, never a player's details.
//
// Labels come only from the small fixed lists below, never from a page: a message type a page made up counts as
// 'other'. No name, address, session or text is in any metric or label.
//
// Where: a listener of its own, never the game's port, and only when METRICS_PORT is set (lan/compose.yaml sets it
// inside the compose network for Prometheus; brieltje.be doesn't, so nothing listens there). Bound to METRICS_HOST
// (default 127.0.0.1). It answers GET /metrics and nothing else: no CORS, a Host that is a name with a dot is refused
// (DNS rebinding from a page in a browser on this computer), and the text is built at most once per CACHE_MS however
// often it is asked (a scrape flood costs no more than one build every 250 ms).

import { createServer } from 'node:http';
import { constants, monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';

/** The messages the game handles (server/game.mjs handle: `m.t === '...'`); anything else a page sends is 'other'. */
export const MESSAGE_TYPES = [
  'asup', 'bell', 'bike', 'boom', 'car', 'cat', 'chat', 'chute', 'claymore', 'clown', 'clownhit', 'coin', 'crack', 'dent',
  'door', 'furn', 'gl', 'glass', 'heli', 'hit', 'horse', 'kick', 'kickball', 'mode', 'mood', 'moodskip', 'moodspeed',
  'nade', 'newround', 'pickup', 'placement', 'pong', 'rally', 'repair', 'revive', 'rocket', 'rules', 'shot', 'smash',
  'spawn', 'sphit', 'stakes', 'state', 'tag', 'team', 'teamstart', 'tesla', 'travel', 'turret', 'unstuck', 'vhit', 'vil', 'zbuy',
  'zhit', 'zitem', 'zwave',
];
/** Where a game is: the open world (the house), a players' Zombies room, one of the Zombies duel's two rooms. */
export const PLACES = ['house', 'room', 'duel'];
/** The games (server/modes.mjs KINDS; Attack and defend is Steal the flag's kind with its own place). */
export const KINDS = ['hide', 'tag', 'treasure', 'teams', 'flag', 'assault', 'zombies', 'other'];
/** Their phases (server/modes.mjs, shared/zombies.mjs Horde). */
export const PHASES = ['hiding', 'seeking', 'playing', 'break', 'wave', 'done', 'other'];
export const VEHICLES = ['car', 'bike', 'horse', 'heli'];
/** Why a WebSocket closed: the page left (1000, 1001, 1005), the server's own close (4000 to 4999: moved, kicked, full), or lost. */
export const CLOSES = ['normal', 'server', 'lost'];
export const STATUS = ['1xx', '2xx', '3xx', '4xx', '5xx'];
export const GC_KINDS = ['minor', 'major', 'incremental', 'weakcb'];
const GC_OF = {
  [constants.NODE_PERFORMANCE_GC_MINOR]: 'minor', [constants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental', [constants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakcb',
};
/** The tick's histogram (seconds): its 50 ms budget and the steps a player starts to feel. */
const TICK_BUCKETS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.03, 0.04, 0.05, 0.075, 0.1, 0.25];
export const CACHE_MS = 250;
const RING = 4096; // ticks kept for the window's p99 (20 a second per game: Prometheus asks every 2 s)
/** A Host header the listener answers: an IP address, or one name without a dot (localhost, the compose service `game`). */
const HOST_OK = /^(?:[a-z0-9_-]{1,63}|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]{2,45}\])(?::\d{1,5})?$/i;
export const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

const zeros = (list) => Object.fromEntries(list.map((k) => [k, 0]));
const pick = (v, list) => (list.includes(v) ? v : list[list.length - 1]);
/** A label value: always from a fixed list here, escaped all the same (\, " and line feeds) as the format asks. */
const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const num = (v) => (Number.isFinite(v) ? String(Math.round(v * 1e9) / 1e9) : '0');
/** The nearest-rank percentile `p` (0 to 1) of sorted numbers. */
const rank = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] : 0);

export function closeKind(code) {
  if (code === 1000 || code === 1001 || code === 1005) return 'normal'; // a close frame from the page (1005: without a code)
  if (code >= 4000 && code <= 4999) return 'server';
  return 'lost'; // 1006 (no close frame: the network dropped, or the server let a silent page go) and errors
}

export class Metrics {
  constructor({ now = () => performance.now() } = {}) {
    this.now = now;
    this.started = Date.now();
    this.source = { rooms: null, links: null };
    this.ticks = { n: 0, sum: 0, max: 0, over30: 0, over50: 0, total: 0, totalSum: 0, buckets: TICK_BUCKETS.map(() => 0) };
    this.ring = new Float64Array(RING);
    this.ringN = 0; // ticks in this window (the ring holds the last RING of them)
    this.msgs = zeros(MESSAGE_TYPES);
    this.msgs.other = 0;
    this.dropped = 0;
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.msgsOut = 0;
    this.wsOpen = 0;
    this.wsClose = zeros(CLOSES);
    this.http = zeros(STATUS);
    this.staticBytes = 0;
    this.gc = { n: zeros(GC_KINDS), s: zeros(GC_KINDS), max: 0 };
    this.builds = 0;
    this.buildS = 0;
    this.cached = null;
    this.cachedAt = 0;
    this.loop = null;
    this.elu = null;
  }

  /** What is counted at a scrape: the games (server/rooms.mjs) and the connections' round trips (server/linkQuality.mjs). */
  attach(source) {
    Object.assign(this.source, source);
  }

  /** The listener is on: the event loop's delay and the garbage collections are measured from now. */
  start() {
    if (this.loop) return;
    this.loop = monitorEventLoopDelay({ resolution: 10 });
    this.loop.enable();
    this.elu = performance.eventLoopUtilization();
    this.observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const k = GC_OF[e.detail?.kind] ?? 'minor';
        this.gc.n[k]++;
        this.gc.s[k] += e.duration / 1000;
        if (e.duration > this.gc.max) this.gc.max = e.duration;
      }
    });
    this.observer.observe({ entryTypes: ['gc'] });
  }

  stop() {
    this.loop?.disable();
    this.observer?.disconnect();
    this.loop = null;
  }

  // The hooks (server/game.mjs, server.mjs): a few additions each, nothing kept per player.

  /** A game's tick took `ms`. */
  tick(ms) {
    const t = this.ticks;
    t.n++;
    t.sum += ms;
    t.total++;
    t.totalSum += ms;
    if (ms > t.max) t.max = ms;
    if (ms > 30) t.over30++;
    if (ms > 50) t.over50++;
    const s = ms / 1000;
    const i = TICK_BUCKETS.findIndex((b) => s <= b);
    if (i >= 0) t.buckets[i]++;
    this.ring[this.ringN++ % RING] = ms;
  }

  /** A message from a page passed the rate limits: counted by its type from the fixed list. */
  message(type) {
    this.msgs[typeof type === 'string' && Object.hasOwn(this.msgs, type) ? type : 'other']++;
  }

  /** A message dropped by a per-connection rate limit (server/game.mjs handle). */
  drop() {
    this.dropped++;
  }

  in(bytes) {
    this.bytesIn += bytes;
  }

  /** A message sent to `count` pages (its length each). */
  out(bytes, count = 1) {
    this.bytesOut += bytes * count;
    this.msgsOut += count;
  }

  wsOpened() {
    this.wsOpen++;
  }

  wsClosed(code) {
    this.wsClose[closeKind(code)]++;
  }

  /** An HTTP request (server.mjs): its answer's class, and the bytes of a static file sent whole. */
  request(req, res) {
    const sock = req.socket;
    const from = sock?.bytesWritten ?? 0; // a kept-alive socket's earlier answers are not this one's
    res.once('finish', () => {
      const c = Math.floor(res.statusCode / 100);
      if (c >= 1 && c <= 5) this.http[`${c}xx`]++;
      if (res.statusCode === 200 && req.method === 'GET' && !String(req.url).startsWith('/api/')) this.staticBytes += Math.max(0, (sock?.bytesWritten ?? from) - from);
    });
  }

  // A scrape.

  /** The text, built at most once per CACHE_MS. */
  text() {
    const t = this.now();
    if (this.cached !== null && t - this.cachedAt < CACHE_MS) return this.cached;
    const t0 = performance.now();
    this.cached = this.build();
    this.cachedAt = t;
    this.builds++;
    this.buildS = (performance.now() - t0) / 1000;
    return this.cached;
  }

  /** The games now: players and rooms per place, watchers, the games on, zombies up, vehicles in use. Counts only. */
  world() {
    const w = { players: zeros(PLACES), rooms: zeros(PLACES), watchers: 0, on: new Map(), zombies: zeros(PLACES), vehicles: zeros(VEHICLES) };
    for (const g of this.source.rooms?.games() ?? []) {
      const place = g.room ? (g.room.duel ? 'duel' : 'room') : 'house';
      w.rooms[place]++;
      w.players[place] += g.players.size - (g.flagGuards?.size ?? 0); // not Steal the flag's guards (server/flagGuards.mjs)
      w.watchers += g.watchers?.size ?? 0;
      const s = g.modes?.state;
      if (s && s.kind !== 'free') {
        const key = `${place}\n${pick(s.kind === 'flag' && s.f?.assault ? 'assault' : s.kind, KINDS)}\n${pick(s.phase, PHASES)}`;
        w.on.set(key, (w.on.get(key) ?? 0) + 1);
        if (s.kind === 'zombies') for (const z of s.z?.horde?.zombies?.values() ?? []) if (z.act !== 'down') w.zombies[place]++;
      }
      for (const c of Object.values(g.cars ?? {})) if (c.driver) w.vehicles.car++;
      for (const b of Object.values(g.bikes ?? {})) if (b.rider) w.vehicles.bike++;
      for (const h of g.horses ?? []) if (h.rider) w.vehicles.horse++;
      for (const h of g.helis?.machines?.values() ?? []) if (h.seats?.some(Boolean)) w.vehicles.heli++;
    }
    return w;
  }

  build() {
    const out = [];
    const fam = (name, type, help, samples) => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, v] of samples) {
        const l = labels ? `{${Object.entries(labels).map(([k, x]) => `${k}="${esc(x)}"`).join(',')}}` : '';
        out.push(`${name}${l} ${num(v)}`);
      }
    };
    const one = (v) => [[null, v]];
    const by = (label, obj) => Object.entries(obj).map(([k, v]) => [{ [label]: k }, v]);

    // The tick: this window (since the last scrape) and every tick since the start.
    const t = this.ticks;
    const n = Math.min(this.ringN, RING);
    const window = Array.from(this.ring.subarray(0, n)).sort((a, b) => a - b);
    fam('brieltje_tick_seconds', 'gauge', 'A game tick\'s duration since the last scrape (budget 0.05).', [
      [{ stat: 'mean' }, t.n ? t.sum / t.n / 1000 : 0], [{ stat: 'p99' }, rank(window, 0.99) / 1000], [{ stat: 'max' }, t.max / 1000]]);
    fam('brieltje_ticks_slow_total', 'counter', 'Ticks over 30 ms and over 50 ms (the budget).', [[{ over: '30ms' }, t.over30], [{ over: '50ms' }, t.over50]]);
    out.push('# HELP brieltje_tick_duration_seconds Every game tick\'s duration.', '# TYPE brieltje_tick_duration_seconds histogram');
    let acc = 0;
    TICK_BUCKETS.forEach((b, i) => out.push(`brieltje_tick_duration_seconds_bucket{le="${b}"} ${(acc += t.buckets[i])}`));
    out.push(`brieltje_tick_duration_seconds_bucket{le="+Inf"} ${t.total}`, `brieltje_tick_duration_seconds_sum ${num(t.totalSum / 1000)}`, `brieltje_tick_duration_seconds_count ${t.total}`);

    // The event loop: how late it runs callbacks, and how busy it is.
    const h = this.loop;
    const has = h && h.count > 0;
    fam('brieltje_event_loop_delay_seconds', 'gauge', 'How late the event loop ran a timer, since the last scrape.', [
      [{ stat: 'mean' }, has ? h.mean / 1e9 : 0], [{ stat: 'p99' }, has ? h.percentile(99) / 1e9 : 0], [{ stat: 'max' }, has ? h.max / 1e9 : 0]]);
    let elu = 0;
    if (this.elu) {
      const now = performance.eventLoopUtilization();
      elu = performance.eventLoopUtilization(now, this.elu).utilization;
      this.elu = now;
    }
    fam('brieltje_event_loop_utilization', 'gauge', 'Share of the time the event loop was busy since the last scrape (0 to 1).', one(elu));

    // Who is connected, and the games on.
    let w;
    try {
      w = this.world();
    } catch (e) {
      w = null;
      console.error(JSON.stringify({ event: 'metrics_world_failed', error: String(e).slice(0, 200) }));
    }
    if (w) {
      fam('brieltje_players', 'gauge', 'Players connected, by place.', by('place', w.players));
      fam('brieltje_games', 'gauge', 'Games running (the house, players\' rooms, the duel\'s rooms).', by('place', w.rooms));
      fam('brieltje_watchers', 'gauge', 'The admin\'s watch views open.', one(w.watchers));
      fam('brieltje_game_on', 'gauge', 'A game being played, by place, kind and phase (absent in free play).',
        [...w.on].map(([k, v]) => { const [place, kind, phase] = k.split('\n'); return [{ place, kind, phase }, v]; }));
      fam('brieltje_zombies_up', 'gauge', 'Zombies standing, by place.', by('place', w.zombies));
      fam('brieltje_vehicles_in_use', 'gauge', 'Vehicles with someone on or in them.', by('kind', w.vehicles));
    }
    fam('brieltje_ws_opened_total', 'counter', 'WebSocket connections opened.', one(this.wsOpen));
    fam('brieltje_ws_closed_total', 'counter', 'WebSocket connections closed, by why (normal, server, lost).', by('why', this.wsClose));
    const g = this.source.links?.group() ?? null;
    fam('brieltje_reconnects_total', 'counter', 'A player back after their connection was lost.', one(g?.reconnects ?? 0));

    // The connections' round trips (WebSocket ping frames every 2 s), over the players.
    fam('brieltje_link_rtt_seconds', 'gauge', 'The players\' latest round trip: median, 95th percentile and max.', [
      [{ stat: 'median' }, (g?.median ?? 0) / 1000], [{ stat: 'p95' }, (g?.p95 ?? 0) / 1000], [{ stat: 'max' }, (g?.max ?? 0) / 1000]]);
    fam('brieltje_link_slow_players', 'gauge', 'Players whose latest round trip is over 150 ms.', one(g?.slow ?? 0));
    fam('brieltje_link_measured_players', 'gauge', 'Players with a round trip measured.', one(g?.measured ?? 0));
    fam('brieltje_link_pongs_missed_total', 'counter', 'Pings a page did not answer before the next.', one(g?.missed ?? 0));

    // Messages and bytes.
    fam('brieltje_messages_in_total', 'counter', 'Messages from pages that passed the rate limits, by type.', by('type', this.msgs));
    fam('brieltje_messages_dropped_total', 'counter', 'Messages dropped by the per-connection rate limits.', one(this.dropped));
    fam('brieltje_messages_out_total', 'counter', 'Messages sent to pages (one per page).', one(this.msgsOut));
    fam('brieltje_bytes_in_total', 'counter', 'Bytes of messages from pages.', one(this.bytesIn));
    fam('brieltje_bytes_out_total', 'counter', 'Characters of messages to pages (JSON: about a byte each).', one(this.bytesOut));

    // HTTP.
    fam('brieltje_http_requests_total', 'counter', 'HTTP answers, by status class.', by('code', this.http));
    fam('brieltje_static_bytes_total', 'counter', 'Bytes of the game\'s files sent (pages, scripts, models, textures).', one(this.staticBytes));

    // The process.
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    fam('process_resident_memory_bytes', 'gauge', 'Resident memory.', one(mem.rss));
    fam('brieltje_heap_used_bytes', 'gauge', 'JavaScript heap in use.', one(mem.heapUsed));
    fam('brieltje_heap_total_bytes', 'gauge', 'JavaScript heap reserved.', one(mem.heapTotal));
    fam('brieltje_external_bytes', 'gauge', 'Memory outside the heap (buffers).', one(mem.external));
    fam('brieltje_array_buffers_bytes', 'gauge', 'ArrayBuffers and Buffers.', one(mem.arrayBuffers));
    fam('process_cpu_user_seconds_total', 'counter', 'CPU time in user mode.', one(cpu.user / 1e6));
    fam('process_cpu_system_seconds_total', 'counter', 'CPU time in system mode.', one(cpu.system / 1e6));
    fam('brieltje_gc_total', 'counter', 'Garbage collections, by kind.', by('kind', this.gc.n));
    fam('brieltje_gc_seconds_total', 'counter', 'Time in garbage collection, by kind.', by('kind', this.gc.s));
    fam('brieltje_gc_pause_max_seconds', 'gauge', 'The longest garbage collection since the last scrape.', one(this.gc.max / 1000));
    fam('process_start_time_seconds', 'gauge', 'When the process started (seconds since 1970).', one(Math.floor(this.started / 1000)));
    fam('brieltje_uptime_seconds', 'gauge', 'Seconds since the process started.', one((Date.now() - this.started) / 1000));
    fam('brieltje_metrics_build_seconds', 'gauge', 'How long the previous build of this text took.', one(this.buildS));
    fam('brieltje_metrics_builds_total', 'counter', 'Builds of this text.', one(this.builds));

    // The window starts again.
    t.n = t.sum = t.max = 0;
    this.ringN = 0;
    this.gc.max = 0;
    h?.reset();
    return out.join('\n') + '\n';
  }
}

export const metrics = new Metrics();

/** The listener's answer: GET /metrics, or a short refusal. Never CORS headers; never anything of the game's own. */
export function metricsHandler(m = metrics) {
  return (req, res) => {
    const reply = (status, body, extra = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(body), ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (!HOST_OK.test(String(req.headers.host ?? ''))) return reply(403, 'Forbidden\n', { Connection: 'close' });
    if (req.url !== '/metrics') return reply(404, 'Not found\n', { Connection: 'close' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405, 'Method not allowed\n', { Allow: 'GET, HEAD', Connection: 'close' });
    reply(200, m.text(), { 'Content-Type': CONTENT_TYPE });
  };
}

/** A listener for the metrics, not yet listening: small limits, as nobody but Prometheus should talk to it. */
export function metricsServer(m = metrics) {
  const server = createServer({ maxHeaderSize: 4096, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 5000 }, metricsHandler(m));
  server.maxConnections = 16;
  server.maxRequestsPerSocket = 100;
  // A port in use or a bad address: said once, and the game plays on without metrics.
  server.on('error', (e) => console.error(JSON.stringify({ event: 'metrics_listen_failed', error: String(e).slice(0, 200) })));
  return server;
}

/** Off unless METRICS_PORT is a port; then on METRICS_HOST (default 127.0.0.1). The listener, or null. */
export function startMetrics(env = process.env, m = metrics) {
  const raw = env.METRICS_PORT;
  const port = Number(raw);
  if (!raw || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = env.METRICS_HOST || '127.0.0.1';
  m.start();
  const server = metricsServer(m);
  server.listen(port, host, () => console.log(JSON.stringify({ event: 'metrics_started', port, host })));
  return server;
}
