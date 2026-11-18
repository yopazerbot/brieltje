// A whole game night under load: simulated players against a throwaway game server (a build of this branch on this
// computer, started by this tool on a port of its own), through the evening's programme, and whether the server holds.
//
// The evening, each part shortened to --minutes: free play; the Zombies duel's warm-up (look paint, its clock shortened
// with the server's own test setting DUEL_TEST_MINUTE_MS); Steal the flag on the compact field (paint); Steal the flag on
// the whole village (real: the cars, bikes and helicopters parked at the bases); the Zombies duel's final (real, stopped
// by the host after --minutes). The admin's watch views are open all evening, as the hall screen has them (--watchers).
//
// The players behave like players, since the server's cost follows what they do; each is simple and follows its own
// seeded dice (--seed). They walk and sprint along the roads within the server's movement budgets, look round, come down
// by parachute after a death in free play, shoot at each other at a person's rate (a 'shot' for every bullet, a 'hit'
// for those that land, never at a teammate, a protected player or across the school grounds), throw a grenade now and
// then, get into cars and onto bikes and drive them, and one a side flies a helicopter round when the game allows it.
// In Steal the flag they attack, defend or hold the middle, take the other team's flag by walking into it and carry it
// home, bring their own back from the ground and chase a carrier. In the duel they shoot the zombies (and step back
// from them) so the waves go on.
//
// What it reports, per part of the evening and overall: the server's tick time per game (average, 95th and 99th
// percentile, worst) and how busy the one thread is in each 50 ms (all games and every message together, against the
// tick's 50 ms), the event loop's delay, the processor (100 % = one core), memory at the start and end of each part
// (after a garbage collection: growth from part to part is a leak), bytes a second to each player and in all, messages a
// second each way, dropped or refused connections, honest messages the server did not take (a move put back, a hit not
// counted, a seat refused: a bot or a rule is wrong), and errors in the server's log. The tool's own processor use is
// shown too: it runs on the same computer.
//
// The server runs in a child process of this tool (this file with --serve): the build's own server.mjs, with timers
// round each game's tick and message handling, nothing of the game changed. The one exception, only with --lift-cap:
// the open world's limit of 32 players is lifted in that process, to measure what more would cost (without it the rest
// is turned away, "The house is full"). The duel takes at most 20 a team (server/duel.mjs): with more, the rest sit it out
// (their pages closed) and come back after it, as the host would have to do. Its admin password is made here, never shown. Its data goes to web/.data of this
// checkout (the test guests); when that folder was not there before, it is removed at the end. Nothing leaves this
// computer, and no setting of the real server is read (DATABASE_URL and the Railway ones are left out).
//
//   cd web && npm run build
//   node tools/dev/night_load.mjs [--players 30] [--minutes 3] [--port 8611] [--watchers 4] [--seed 1]
//        [--phases free,warmup,compact,village,final] [--lift-cap] [--json results.json] [--prof <folder>]
// --phases assault: Attack and defend's two rounds (half the minutes each), the bots attacking from the camp or defending.
// --prof: the server's processor profile (node --cpu-prof) into that folder, to find a slow path.
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

if (process.argv.includes('--serve')) await serve();
else await main();

// ------------------------------------------------------------------------------------------------ the server's side

/**
 * The game server as it is (web/server.mjs), with a stopwatch round each game's tick (per game: the open world, each
 * room) and round each message's handling, the event loop's delay, the processor and memory. The tool asks over the
 * child's channel: 'stats' (the window since the last ask, then a fresh one), 'gc' (memory after a collection), 'exit'.
 */
async function serve() {
  const { monitor } = await import('../../web/server/monitor.mjs');
  const { Game } = await import('../../web/server/game.mjs');
  const cap = Number(process.env.NIGHT_LOAD_CAP) || 0;
  if (cap > 0) {
    const full = Game.prototype.full;
    Game.prototype.full = function (role) {
      return this.room ? full.call(this, role) : this.players.size >= cap;
    };
  }
  const eld = monitorEventLoopDelay({ resolution: 2 });
  eld.enable();
  const fresh = () => ({ at: performance.now(), cpu: process.cpuUsage(), elu: performance.eventLoopUtilization(), ticks: {}, period: {}, busy: new Map(), handleMs: 0, handled: 0, in: 0, inBytes: 0, out: 0, outBytes: 0 });
  let w = fresh();
  const lastStart = new WeakMap();
  const busy = (t0, ms) => {
    const b = Math.floor(t0 / 50);
    w.busy.set(b, (w.busy.get(b) ?? 0) + ms);
  };
  const tick = Game.prototype.tick;
  Game.prototype.tick = function () {
    const t0 = performance.now();
    try {
      return tick.call(this);
    } finally {
      const ms = performance.now() - t0;
      const label = this.room ? `room ${this.room.duel || 'of players'}` : 'world';
      (w.ticks[label] ??= []).push(ms);
      const prev = lastStart.get(this);
      if (prev !== undefined) (w.period[label] ??= []).push(t0 - prev);
      lastStart.set(this, t0);
      busy(t0, ms);
    }
  };
  const handle = Game.prototype.handle;
  Game.prototype.handle = function (...a) {
    const t0 = performance.now();
    try {
      return handle.apply(this, a);
    } finally {
      const ms = performance.now() - t0;
      w.handleMs += ms;
      w.handled++;
      busy(t0, ms);
    }
  };
  const mIn = monitor.in.bind(monitor);
  const mOut = monitor.out.bind(monitor);
  monitor.in = (bytes) => {
    w.in++;
    w.inBytes += bytes;
    mIn(bytes);
  };
  monitor.out = (bytes, count = 1) => {
    w.out += count;
    w.outBytes += bytes * count;
    mOut(bytes, count);
  };
  const mem = () => {
    const m = process.memoryUsage();
    return { rssMB: mb(m.rss), heapMB: mb(m.heapUsed), heapTotalMB: mb(m.heapTotal), externalMB: mb(m.external) };
  };
  process.on('message', (q) => {
    if (q?.cmd === 'stats') {
      const now = performance.now();
      const secs = (now - w.at) / 1000;
      const cpu = process.cpuUsage(w.cpu);
      const elu = performance.eventLoopUtilization(w.elu);
      const windows = Math.max(1, Math.floor(secs * 20));
      const busyAll = [...w.busy.values()];
      while (busyAll.length < windows) busyAll.push(0);
      const ticks = Object.fromEntries(Object.entries(w.ticks).map(([k, v]) => [k, spread(v)]));
      const period = Object.fromEntries(Object.entries(w.period).map(([k, v]) => [k, spread(v)]));
      const r = {
        id: q.id, secs, ticks, period, busy: spread(busyAll),
        eld: { p50: eld.percentile(50) / 1e6, p99: eld.percentile(99) / 1e6, max: eld.max / 1e6 },
        cpu: ((cpu.user + cpu.system) / 1000 / (secs * 1000)) * 100, elu: elu.utilization * 100,
        handled: w.handled, handleMs: w.handleMs, in: w.in, inBytes: w.inBytes, out: w.out, outBytes: w.outBytes, mem: mem(),
      };
      eld.reset();
      w = fresh();
      process.send(r);
    } else if (q?.cmd === 'gc') {
      global.gc?.();
      global.gc?.();
      process.send({ id: q.id, mem: mem() });
    } else if (q?.cmd === 'exit') process.exit(0);
  });
  process.on('disconnect', () => process.exit(0)); // the tool is gone (stopped, or it crashed): no server left behind
  await import('../../web/server.mjs');
}

/** Average, 50th, 95th and 99th percentile and the worst of a list of numbers. */
function spread(list) {
  if (!list.length) return { n: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const s = Float64Array.from(list).sort();
  const at = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  let sum = 0;
  for (const v of s) sum += v;
  return { n: s.length, avg: sum / s.length, p50: at(50), p95: at(95), p99: at(99), max: s[s.length - 1] };
}

function mb(bytes) {
  return Math.round((bytes / 1048576) * 10) / 10;
}

// ------------------------------------------------------------------------------------------------ the evening

async function main() {
  const { localOnly, options } = await import('./cdp.mjs');
  const { makeTerrain } = await import('../../web/shared/terrain.mjs');
  const { makeRoads } = await import('../../web/shared/roadPath.mjs');
  const { FIELDS, baseOf } = await import('../../web/shared/flagFields.mjs');
  const { noShoot } = await import('../../web/shared/zones.mjs');
  const { FLAG } = await import('../../web/shared/wire.mjs');
  const { DROP } = await import('../../web/shared/parachute.mjs');
  const { homeAt } = await import('../../web/shared/homes.mjs');

  const o = options({ players: '30', minutes: '3', port: '8611', watchers: '4', seed: '1', phases: 'free,warmup,compact,village,final', 'lift-cap': false, json: '', prof: '' });
  const PLAYERS = Math.max(4, Math.min(60, Number(o.players) || 30));
  const PHASE_S = Math.max(30, (Number(o.minutes) || 3) * 60);
  const PORT = Number(o.port) || 8611;
  if (PORT === 5173 || PORT === 8080) throw new Error('5173 and 8080 stay free: pick a port of your own');
  const api = `http://localhost:${PORT}`;
  localOnly(api);
  const PHASES = o.phases.split(',').map((s) => s.trim()).filter(Boolean);
  const SEED = Number(o.seed) || 1;
  const data = (f) => JSON.parse(readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8'));
  const SPAWNS = data('shared/spawns.json');
  const TERRAIN = makeTerrain(data('shared/terrain.json'));
  const GRAPH = data('src/data/streets.json').graph;
  const ROADS = makeRoads(GRAPH);
  const WEAPONS = data('shared/weapons.json');
  const GRENADE = data('shared/grenade.json');
  const CARS = data('shared/car.json');
  const BIKES = data('shared/bike.json');
  const HELI = data('shared/heli.json');
  /** The ground out of doors, as the server has it (HOUSE.ground + the relief). */
  const ground = (x, z) => -0.1 + TERRAIN.height(x, z);
  /** Road points round the house for free play's walks (within 280 m). */
  const NEAR = GRAPH.points.filter(([x, z]) => Math.hypot(x, z) < 280);
  const RUN = 3.4; // m/s: a sprint (the server allows 4.55 on foot)
  const WALK = 1.4;
  const CAR_V = 14; // m/s along the roads (the server allows 66)
  const BIKE_V = 7; // m/s (the server allows 13)
  const HELI_V = 25; // m/s across (the server allows 62), 5 up (11.7), 4 down (18.2), 1.2 rad/s turning (2.8)

  // The minute of the warm-up's clock: ten of its minutes in --minutes (the server takes 1 to 59 s; else a real minute).
  const warmMinutes = 10;
  const minuteMs = Math.round((PHASE_S * 1000) / warmMinutes);
  const testMinute = minuteMs >= 1000 && minuteMs < 60_000;

  // --- what is counted, per part of the evening
  const fresh = (name) => ({
    name, t0: performance.now(), tool: process.cpuUsage(), types: {}, sent: {}, watchBytes: 0, watchMsgs: 0,
    drops: [], refusedConnect: [], full: 0, codes: {}, moves: { checked: 0, off: 0, samples: [] },
    hits: { sent: 0, ok: 0, nade: 0 }, nades: { thrown: 0, blasts: 0 }, zhits: 0, zdowns: 0, vhits: 0,
    seats: { asked: 0, got: 0, refused: {}, gaveUp: {} }, flags: {}, waves: {}, kills: 0,
  });
  let cur = fresh('start');
  const phaseName = () => cur.name;
  const bots = [];
  const watchers = [];
  const byName = new Map();
  const seenSt = new Map();
  let loop = null;

  // --- the server
  const dataDir = fileURLToPath(new URL('../../web/.data/', import.meta.url));
  const hadData = existsSync(dataDir);
  const password = randomBytes(18).toString('base64url');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DATABASE_URL|PG|RAILWAY_|NODE_ENV$|STATS_SECRET$|PRIVATE_DATA_KEY$|ADMIN_)/.test(k)));
  Object.assign(env, { PORT: String(PORT), ADMIN_PASSWORD: password, ...(testMinute ? { DUEL_TEST_MINUTE_MS: String(minuteMs) } : {}), ...(o['lift-cap'] ? { NIGHT_LOAD_CAP: String(PLAYERS + 4) } : {}) });
  const execArgv = ['--expose-gc', ...(o.prof ? ['--cpu-prof', '--cpu-prof-dir', o.prof] : [])];
  const child = fork(fileURLToPath(import.meta.url), ['--serve'], { env, execArgv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  console.log(`server: process ${child.pid} on port ${PORT}${o['lift-cap'] ? `, the open world's limit lifted to ${PLAYERS + 4} in this process only` : ''}`);
  const log = { lines: 0, errors: [], events: {} };
  let ready = null;
  const started = new Promise((r) => (ready = r));
  const onLine = (line, err) => {
    if (!line.trim()) return;
    log.lines++;
    let ev = null;
    try {
      ev = JSON.parse(line).event ?? null;
    } catch {
      // not a JSON line
    }
    if (ev === 'started') ready();
    if (ev) log.events[ev] = (log.events[ev] ?? 0) + 1;
    if (err || /error|failed|exception|unhandled/i.test(line)) log.errors.push(`[${phaseName()}] ${line.slice(0, 300)}`);
  };
  for (const [stream, err] of [[child.stdout, false], [child.stderr, true]]) {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) onLine(l, err);
    });
  }
  let exited = false;
  child.on('exit', (code) => {
    exited = true;
    if (!stopping) console.log(`the server stopped by itself (exit ${code})`);
  });
  let stopping = false;
  let asks = 0;
  const ask = (cmd) => new Promise((resolve) => {
    const id = ++asks;
    const on = (m) => {
      if (m?.id !== id) return;
      child.off('message', on);
      resolve(m);
    };
    child.on('message', on);
    child.send({ cmd, id });
  });
  const cleanup = async () => {
    stopping = true;
    if (loop) clearInterval(loop);
    for (const b of bots) b.stop();
    for (const v of watchers) v.stop();
    if (!exited) {
      child.send({ cmd: 'exit' });
      await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5000)]);
      if (!exited) child.kill();
    }
    if (!hadData) rmSync(dataDir, { recursive: true, force: true });
  };
  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(130);
  });
  await Promise.race([started, sleep(30_000)]);
  if (exited) throw new Error('the server did not start');

  // --- the admin
  const call = async (method, path, body, cookie = '') => {
    const r = await fetch(api + path, { method, headers: { 'Content-Type': 'application/json', Origin: api, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    return { r, data: await r.json().catch(() => null) };
  };
  const cookieOf = (r) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const adminCookie = cookieOf((await call('POST', '/api/login', { username: 'admin', password })).r);
  const act = async (b) => (await call('POST', '/api/host', b, adminCookie)).data;
  const view = async () => (await call('GET', '/api/host', null, adminCookie)).data;
  await call('POST', '/api/lockouts', {}, adminCookie);
  await act({ op: 'reset' });
  await act({ op: 'lock', on: false });
  await act({ op: 'limit', max: 32 });
  await act({ op: 'teams', count: 0 });
  // The floor on this computer: the server with nobody in it for ten seconds (Windows' timers alone make some delay).
  await ask('stats');
  await sleep(10_000);
  const idle = await ask('stats');
  console.log(`idle server: loop delay p50 ${f1(idle.eld.p50)} / p99 ${f1(idle.eld.p99)} / worst ${f1(idle.eld.max)} ms, cpu ${f1(idle.cpu)} %, world tick p99 ${f2(idle.ticks.world?.p99)} ms`);

  /** A move as the server took it (a player's entry in a tick) against what that bot sent: put back means refused. */
  const checkMove = (st, e) => {
    const bot = byName.get(e[0]);
    if (!bot || seenSt.get(e[0]) === st) return;
    seenSt.set(e[0], st);
    const f = Number(e[7]) || 0;
    if (!(f & FLAG.alive) || f & (FLAG.car | FLAG.chute | FLAG.bike)) return;
    if (!bot.alive || bot.seat || bot.drop || bot.task?.asked || performance.now() < bot.settle) return;
    const d = bot.nearestSent(e[2], e[3], e[4]);
    if (d === null) return;
    cur.moves.checked++;
    if (d > 0.35) {
      cur.moves.off++;
      if (cur.moves.samples.length < 6) cur.moves.samples.push(`${bot.name} (${bot.doing()}) at ${e[2]}, ${e[3]}, ${e[4]}: ${d.toFixed(2)} m from what it sent`);
    }
  };

  // --- a bot
  const rngOf = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const host = new URL(api).host;
  const other = (t) => (t === 'blue' ? 'red' : 'blue');
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const yawTo = (dx, dz) => Math.atan2(-dx, -dz); // the game's heading: forward is (-sin yaw, -cos yaw)
  /** Cut the last `m` metres off a path that starts at `from`. */
  const shorten = (path, from, m) => {
    let left = m;
    while (path.length && left > 0) {
      const b = path.at(-1);
      const a = path.length > 1 ? path.at(-2) : from;
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d <= left) {
        path.pop();
        left -= d;
      } else {
        path[path.length - 1] = [b[0] + ((a[0] - b[0]) * left) / d, b[1] + ((a[1] - b[1]) * left) / d];
        left = 0;
      }
    }
    if (!path.length) path.push([from[0], from[1]]);
  };
  const routeCache = new Map();
  const route = (from, to) => {
    const key = `${Math.round(from[0] / 5)},${Math.round(from[1] / 5)}>${Math.round(to[0] / 5)},${Math.round(to[1] / 5)}`;
    if (!routeCache.has(key)) routeCache.set(key, ROADS.route(from, to).line.map((p) => [p[0], p[1]]));
    const line = routeCache.get(key).slice(1, -1);
    return [...line, to];
  };

  class Bot {
    constructor(i, name, cookie) {
      Object.assign(this, { i, name, cookie, rng: rngOf(SEED * 7919 + i), room: '', ws: null, stopped: false, team: null, duel: null });
      Object.assign(this, { pos: null, yaw: 0, pitch: 0, alive: true, hp: 100, weapons: ['pistol'], w: 'pistol', hold: 0, settle: 0 });
      Object.assign(this, { path: null, speed: RUN, goal: null, task: null, seat: null, drop: null, flight: null, lastVehicle: null });
      Object.assign(this, { lastFight: -1e9, lastNade: -1e9, nextNade: performance.now() + 15_000 + this.rng() * 30_000, nextShot: 0, burst: 0, holdFire: 0, boom: null, nextThink: 0 });
      Object.assign(this, { mode: { kind: 'free' }, ring: [], sentKey: '', sentAt: 0, lastBlast: new Map(), anchor: null });
      this.role = ['foot', 'foot', 'driver', 'foot', 'biker', 'foot', 'foot', 'foot', 'foot', 'foot'][i % 10];
      if (i === 5) this.role = 'pilot';
      this.world();
      this.connect();
    }

    world() {
      this.seen = { players: new Map(), cars: new Map(), bikes: new Map(), helis: new Map(), zombies: new Map() };
    }

    doing() {
      return this.seat ? `in ${this.seat.kind} ${this.seat.id}` : this.drop ? 'in a drop' : this.task ? `to ${this.task.kind} ${this.task.id}` : `${this.mode.kind}/${this.role}`;
    }

    connect() {
      const ws = new WebSocket(`ws://${host}/ws?v=2${this.room ? `&room=${encodeURIComponent(this.room)}` : ''}`, { headers: { Cookie: this.cookie, Origin: api } });
      this.ws = ws;
      ws.on('message', (d) => this.onMessage(d));
      ws.on('unexpected-response', (_req, res) => {
        cur.refusedConnect.push(`${this.name}: HTTP ${res.statusCode}`);
        setTimeout(() => !this.stopped && this.connect(), 3000);
      });
      ws.on('close', (code) => {
        if (this.stopped || ws !== this.ws) return;
        if (code === 4004 || code === 4006) { // moved into a duel room or out of it (src/net/client.ts)
          this.room = '';
          return this.connect();
        }
        if (code === 4003) cur.refusedConnect.push(`${this.name}: full (4003)`);
        else cur.drops.push(`${this.name}: ${code}`);
        setTimeout(() => !this.stopped && this.connect(), 1000);
      });
      ws.on('error', () => {});
    }

    send(m) {
      if (this.ws?.readyState !== 1) return;
      cur.sent[m.t] = (cur.sent[m.t] ?? 0) + 1;
      this.ws.send(JSON.stringify(m));
    }

    stop() {
      this.stopped = true;
      this.ws?.close();
    }

    /** Off for a while (sitting the duel out), then back as a page that connects again. */
    pause() {
      this.paused = true;
      this.stop();
    }

    resume() {
      if (!this.paused) return;
      this.paused = false;
      this.stopped = false;
      this.connect();
    }

    /** How far (m) the nearest of the last three seconds' positions sent is from (x, y, z), or null when none. */
    nearestSent(x, y, z) {
      let best = null;
      for (const [, px, py, pz] of this.ring) {
        const d = Math.hypot(px - x, (py - y) * 0.5, pz - z);
        if (best === null || d < best) best = d;
      }
      return best;
    }

    onMessage(raw) {
      const bytes = raw.length;
      const m = JSON.parse(String(raw));
      const ty = (cur.types[m.t] ??= { n: 0, bytes: 0 });
      ty.n++;
      ty.bytes += bytes;
      const now = performance.now();
      switch (m.t) {
        case 'ping':
          return this.send({ t: 'pong', n: m.n });
        case 's':
          return this.tick(m);
        case 'welcome':
          this.world();
          this.duel = m.room?.duel ?? null;
          this.carrying = null;
          this.hold = now + 2500; // until the server says where it put us (a respawn), or 2.5 s: where we were
          this.seat = this.task = this.flight = this.drop = null;
          this.path = null;
          this.anchor = null;
          if (!this.pos) this.pos = { x: SPAWNS[0].x, y: SPAWNS[0].y, z: SPAWNS[0].z };
          this.ring = [];
          return;
        case 'weapons':
          this.weapons = Array.isArray(m.list) ? m.list : ['pistol'];
          return;
        case 'eveningteams':
          this.team = m.teams?.[this.name] ?? this.team;
          return;
        case 'mode':
          this.mode = m.mode ?? { kind: 'free' };
          if (this.mode.teams?.[this.name]) this.team = this.mode.teams[this.name];
          return;
        case 'full':
          cur.full++;
          return;
        case 'homelock': // walked into a code-locked home: a bot's path is wrong
          cur.codes.homelock = (cur.codes.homelock ?? 0) + 1;
          this.path = null;
          return;
        case 'system':
          cur.codes[m.code ?? '?'] = (cur.codes[m.code ?? '?'] ?? 0) + 1;
          this.lastCode = m.code;
          return;
        case 'respawn':
          if (m.name !== this.name) return;
          return this.respawned(m, now);
        case 'hurt':
          this.hp = m.hp;
          this.lastFight = now;
          if (byName.has(m.by)) {
            if (now - (this.lastBlast.get(m.by) ?? -1e9) < 400) cur.hits.nade++;
            else cur.hits.ok++;
          }
          if (m.hp <= 0) this.alive = false; // down in the Zombies game
          return;
        case 'kill':
          if (m.victim === this.name) {
            this.alive = false;
            this.seat = this.task = this.flight = this.carrying = null;
            this.path = null;
            if (byName.has(m.killer)) (m.w === 'grenade' ? cur.hits.nade++ : cur.hits.ok++);
          }
          if (this.i === firstIn(this)) cur.kills++;
          return;
        case 'revived':
          if (m.name === this.name) {
            this.alive = true;
            this.settle = now + 1500;
          }
          return;
        case 'blast':
          if (m.by) this.lastBlast.set(m.by, now);
          if (m.by && byName.has(m.by) && this.i === firstIn(this)) cur.nades.blasts++;
          return;
        case 'round':
          this.holdFire = now + (Number(m.ms) || 8000) + 500;
          return;
        case 'flag':
          if (this.i === firstIn(this)) cur.flags[m.ev] = (cur.flags[m.ev] ?? 0) + 1;
          if (m.name === this.name) this.carrying = m.ev === 'taken' ? m.team : null;
          return;
        case 'duel':
          if (m.duel?.sides) for (const s of m.duel.sides) cur.waves[s.team] = Math.max(cur.waves[s.team] ?? 0, s.wave ?? 0);
          return;
        case 'zgone':
          for (const id of m.ids ?? []) this.seen.zombies.delete(id);
          return;
        case 'zdown':
          this.seen.zombies.delete(m.id);
          if (m.by === this.name) cur.zdowns++;
          return;
        case 'teslas':
          for (const c of m.list ?? []) if (!this.seen.cars.has(c.id)) this.seen.cars.set(c.id, { x: c.x, y: c.y, z: c.z, yaw: c.yaw, driver: null, passenger: null });
          return;
        case 'car':
          return this.thing('car', m.car, m.car?.driver === this.name || m.car?.passenger === this.name);
        case 'bike':
          return this.thing('bike', m.bike, m.bike?.rider === this.name);
        case 'heli':
          return this.thing('heli', m.heli, Array.isArray(m.heli?.seats) && m.heli.seats.includes(this.name));
        default:
      }
    }

    /** A car, bike or helicopter as the server says it is: our seat granted, refused or taken away. */
    thing(kind, v, mine) {
      if (!v?.id) return;
      const map = kind === 'car' ? this.seen.cars : kind === 'bike' ? this.seen.bikes : this.seen.helis;
      map.set(v.id, { ...map.get(v.id), x: v.x, y: v.y, z: v.z, yaw: v.yaw, driver: v.driver ?? null, rider: v.rider ?? null, seats: v.seats, g: v.g });
      const now = performance.now();
      if (this.task?.asked && this.task.kind === kind && this.task.id === v.id) {
        if (mine) {
          cur.seats.got++;
          const t = this.task;
          this.seat = { kind, id: v.id };
          this.lastVehicle = { kind, id: v.id };
          this.pos = { x: v.x, y: v.y, z: v.z };
          this.yaw = v.yaw ?? this.yaw;
          this.task = null;
          this.path = null;
          if (kind === 'heli') this.flight = { stage: 'spin', t: 0, y0: v.y, n: 0 };
          else {
            // Where to drive: 25 m short of the other team's stand, home with the flag, or somewhere round the house.
            const [x, z] = t.then ?? t.home ?? NEAR[Math.floor(this.rng() * NEAR.length)];
            this.path = route([v.x, v.z], [x, z]);
            if (t.then) shorten(this.path, [v.x, v.z], 25);
            this.goal = [x, z];
          }
        } else this.refused(`${kind}: ${this.lastCode ?? 'no seat'}`, true);
        return;
      }
      if (this.seat?.kind === kind && this.seat.id === v.id && !mine) { // put out by the server (a wreck, a game starting)
        this.seat = this.flight = null;
        this.pos = { x: v.x, y: kind === 'heli' ? v.y : v.y, z: v.z };
        this.path = null;
        this.settle = now + 2000;
      }
    }

    /** No seat: refused by the server (`server`), or the bot gave up on its own (it could not reach it). */
    refused(why, server = false) {
      const list = server ? cur.seats.refused : cur.seats.gaveUp;
      list[why] = (list[why] ?? 0) + 1;
      this.task = null;
      this.path = null;
      this.noVehicleUntil = performance.now() + 8000;
    }

    respawned(m, now) {
      this.alive = true;
      this.hp = 100;
      this.seat = this.task = this.flight = this.carrying = this.packAt = null;
      this.path = null;
      this.hold = 0;
      this.settle = now + 1500;
      this.ring = [];
      this.anchor = null;
      const spot = SPAWNS[m.spawn];
      const tx = typeof m.x === 'number' ? m.x : spot?.x ?? this.pos?.x ?? 0;
      const tz = typeof m.z === 'number' ? m.z : spot?.z ?? this.pos?.z ?? 0;
      const ty = typeof m.y === 'number' ? m.y : spot && typeof m.x !== 'number' ? spot.y : ground(tx, tz);
      if (m.drop) {
        this.pos = { x: m.sx, y: ty + DROP.height, z: m.sz };
        this.drop = { tx, tz, open: false };
      } else {
        this.drop = null;
        this.pos = { x: tx, y: ty, z: tz };
        if (typeof m.fx === 'number') this.yaw = yawTo(m.fx - tx, m.fz - tz);
      }
    }

    tick(m) {
      const s = this.seen;
      for (const e of m.p ?? []) {
        s.players.set(e[0], { x: e[2], y: e[3], z: e[4], f: Number(e[7]) || 0 });
        checkMove(m.st, e);
      }
      for (const n of m.o ?? []) s.players.delete(n);
      for (const e of m.c ?? []) s.cars.set(e[0], { x: e[2], y: e[3], z: e[4], yaw: e[5], driver: e[7] ?? null, passenger: e[8] ?? null });
      for (const e of m.k ?? []) s.bikes.set(e[0], { x: e[2], y: e[3], z: e[4], yaw: e[5], rider: e[6] ?? null });
      for (const e of m.e ?? []) s.helis.set(e[0], { x: e[2], y: e[3], z: e[4], yaw: e[5], g: e[9], seats: e.slice(10, 14) });
      for (const e of m.z ?? []) s.zombies.set(e[0], { x: e[1], z: e[2], act: ['walk', 'attack', 'hurt', 'down'][(Number(e[4]) || 0) % 4], hp: e[5], y: e[6] ?? 0 });
      if (m.g) for (const [k, list] of Object.entries(m.g)) {
        const map = { c: s.cars, k: s.bikes, e: s.helis, z: s.zombies }[k];
        if (map) for (const id of list) map.delete(id);
      }
    }

    // ---- what to do

    /** Twenty times a second: move, shoot, and tell the server (as a page does: 20 states a second while anything changes). */
    step(now, dt) {
      if (!this.pos || this.ws?.readyState !== 1 || now < this.hold) return;
      if (this.boom && now >= this.boom.at) {
        this.send({ t: 'boom', x: r2(this.boom.x), y: r2(this.boom.y), z: r2(this.boom.z) });
        this.boom = null;
      }
      if (!this.alive) return this.state(now);
      if (this.drop) this.falling(dt);
      else if (this.seat?.kind === 'heli') this.flying(now, dt);
      else {
        if (now >= this.nextThink) {
          this.nextThink = now + 250 + this.rng() * 150;
          this.think(now);
        }
        this.walk(dt);
        if (!this.seat) this.fight(now);
        else this.target = null;
      }
      this.state(now);
    }

    state(now) {
      const p = this.pos;
      const base = { t: 'state', x: r2(p.x), y: r2(p.y), z: r2(p.z), yaw: r3(wrap(this.yaw)), pitch: r3(this.pitch), flying: false, c: false };
      let m;
      if (this.seat?.kind === 'car') m = { ...base, pitch: 0, d: true, s: 0 };
      else if (this.seat?.kind === 'heli' && this.flight) {
        const f = this.flight;
        m = { ...base, pitch: 0, d: true, hp: r3(f.tilt ?? 0), hr: 0, hn: r2(f.n), hg: f.rest ? 1 : 0 };
      } else if (this.drop) m = { ...base, pc: 1, ...(this.drop.open ? { po: 1 } : {}) };
      else m = base;
      Object.assign(m, { armed: true, w: this.w });
      const key = JSON.stringify(m);
      if (key === this.sentKey && now - this.sentAt < 300) return;
      this.sentKey = key;
      this.sentAt = now;
      this.send({ ...m, ct: Math.round(now) });
      this.ring.push([now, m.x, m.y, m.z]);
      while (this.ring.length && now - this.ring[0][0] > 3000) this.ring.shift();
    }

    /** A parachute after a death in free play: the free fall, the canopy at 45 m, towards the place given. */
    falling(dt) {
      const p = this.pos;
      const g = ground(p.x, p.z);
      const over = p.y - g;
      if (over < 45) this.drop.open = true;
      const down = this.drop.open ? 4.5 : 10.5;
      const dx = this.drop.tx - p.x, dz = this.drop.tz - p.z;
      const d = Math.hypot(dx, dz);
      const across = Math.min(d, 5 * dt);
      if (d > 0.01) {
        p.x += (dx / d) * across;
        p.z += (dz / d) * across;
        this.yaw = yawTo(dx, dz);
      }
      p.y = Math.max(g, p.y - down * dt);
      if (p.y <= g + 0.01) {
        this.drop = null;
        this.settle = performance.now() + 1500;
      }
    }

    /** At the stick: spin up, climb, out and back along `flight.way`, down onto where it took off, spin down, out. */
    flying(now, dt) {
      const f = this.flight;
      const p = this.pos;
      f.t += dt;
      f.tilt = 0;
      if (f.stage === 'spin') {
        f.rest = true;
        f.n = Math.min(1, f.n + dt / 2.5);
        if (f.n >= 1) {
          f.stage = 'climb';
          f.way = this.flightWay();
        }
      } else if (f.stage === 'climb' || f.stage === 'cruise') {
        f.rest = false;
        const [tx, tz] = f.way[0];
        const cruiseY = Math.max(f.y0, ground(p.x, p.z)) + 45;
        p.y = Math.min(cruiseY, p.y + 5 * dt);
        if (p.y >= cruiseY - 0.5) f.stage = 'cruise';
        if (f.stage === 'cruise') {
          const want = yawTo(tx - p.x, tz - p.z);
          const turn = Math.max(-1.2 * dt, Math.min(1.2 * dt, wrap(want - this.yaw)));
          this.yaw = wrap(this.yaw + turn);
          const aligned = Math.abs(wrap(want - this.yaw)) < 0.3;
          const d = Math.hypot(tx - p.x, tz - p.z);
          const v = Math.min(aligned ? HELI_V : 3, d / Math.max(dt, 0.01));
          p.x += -Math.sin(this.yaw) * v * dt;
          p.z += -Math.cos(this.yaw) * v * dt;
          f.tilt = aligned ? 0.12 : 0;
          if (d < 3) {
            f.way.shift();
            if (!f.way.length) f.stage = 'down';
          }
        }
      } else if (f.stage === 'down') {
        p.y = Math.max(f.y0, p.y - 4 * dt);
        if (p.y <= f.y0 + 0.01) {
          f.stage = 'rest';
          f.t = 0;
        }
      } else if (f.stage === 'rest') {
        f.rest = true;
        f.n = Math.max(0, f.n - dt / 2);
        if (f.n <= 0 && f.t > 2) {
          this.send({ t: 'heli', op: 'out' });
          this.seat = this.flight = null;
          this.settle = now + 2000;
          this.role = 'foot';
        }
      }
    }

    /** Where a flight goes: towards the other team's base and back in Steal the flag, else round a road point near the pad. */
    flightWay() {
      const p = this.pos;
      const home = [p.x, p.z];
      if (this.mode.kind === 'flag' && this.team) {
        const [ex, ez] = baseOf(FIELDS[this.mode.flag?.field ?? 'village'], other(this.team), !!this.mode.flag?.swapped).stand; // the sides swapped too
        return [[p.x + (ex - p.x) * 0.5, p.z + (ez - p.z) * 0.5], home];
      }
      const far = NEAR.filter(([x, z]) => Math.hypot(x - p.x, z - p.z) > 150);
      const [x, z] = far[Math.floor(this.rng() * far.length)] ?? [p.x + 150, p.z];
      return [[x, z], home];
    }

    /** Along the path at `speed`, on the ground (on foot, on a bike, at the wheel). */
    walk(dt) {
      const p = this.pos;
      const speed = this.seat?.kind === 'car' ? CAR_V : this.seat?.kind === 'bike' ? BIKE_V : this.speed;
      let left = speed * dt;
      while (left > 0 && this.path?.length) {
        const [tx, tz] = this.path[0];
        const dx = tx - p.x, dz = tz - p.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.01) this.heading = yawTo(dx, dz);
        // A wall of a code-locked home ahead (its inside is no way through, as on a page): round it, or another way.
        const step = Math.min(d, Math.max(left, 0.6));
        if (d > 0.01 && homeAt(p.x + (dx / d) * step, p.z + (dz / d) * step, p.y + 0.1) && !homeAt(p.x, p.z, p.y + 0.1)) {
          if (!this.detour(dx / d, dz / d)) this.path = null;
          break;
        }
        if (d <= left) {
          p.x = tx;
          p.z = tz;
          left -= d;
          this.path.shift();
        } else {
          p.x += (dx / d) * left;
          p.z += (dz / d) * left;
          left = 0;
        }
      }
      if (this.path && !this.path.length) this.path = null;
      const g = ground(p.x, p.z);
      // Off a raised pad, or back in the air (server/duel.mjs back): down at a walker's pace, but onto a code-locked home's
      // roof, never through it (the server keeps a step into its inside where it was).
      const down = p.y > g + 0.05 ? Math.max(g, p.y - 8 * dt) : g;
      if (!(down < p.y && homeAt(p.x, p.z, down + 0.1) && !homeAt(p.x, p.z, p.y + 0.1))) p.y = down;
      if (!this.target) {
        this.yaw = this.heading ?? this.yaw;
        if (this.rng() < 0.03) this.look = (this.rng() - 0.5) * 1.2; // looking round
        this.yaw += (this.look ?? 0) * 0.3;
        this.pitch = Math.sin(performance.now() / 1700 + this.i) * 0.08;
      }
    }

    /** A waypoint to the side (60 or 100 degrees, 6 m), clear of every home, put in front of the path; false when none. */
    detour(ux, uz) {
      const p = this.pos;
      if ((this.detours = (this.detours ?? 0) + 1) > 12) return (this.detours = 0), false;
      for (const a of [1.05, -1.05, 1.75, -1.75]) {
        const c = Math.cos(a), s = Math.sin(a);
        const x = p.x + (ux * c - uz * s) * 6, z = p.z + (ux * s + uz * c) * 6;
        let clear = true;
        for (let k = 1; k <= 6 && clear; k++) clear = !homeAt(p.x + ((x - p.x) * k) / 6, p.z + ((z - p.z) * k) / 6, p.y + 0.1);
        if (clear) {
          this.path.unshift([x, z]);
          return true;
        }
      }
      return false;
    }

    goTo(x, z, speed = RUN) {
      this.detours = 0;
      const p = this.pos;
      this.goal = [x, z];
      this.speed = speed;
      this.path = Math.hypot(x - p.x, z - p.z) < 40 ? [[x, z]] : route([p.x, p.z], [x, z]);
    }

    calm(now) {
      return now - this.lastFight > 11_000 && now - this.lastNade > 7000 && now > (this.noVehicleUntil ?? 0);
    }

    /** A few times a second: where to go, by the game on now. */
    think(now) {
      if (this.duel) return this.thinkDuel(now);
      if (this.task) return this.boarding(now);
      if (this.seat) {
        if (!this.path) this.getOut(now);
        return;
      }
      if (this.mode.kind === 'flag' && this.team && this.mode.flag) return this.thinkFlag(now);
      this.thinkFree(now);
    }

    thinkFree(now) {
      const p = this.pos;
      if (this.path) return;
      if (this.role === 'driver' && this.calm(now) && this.rng() < 0.5 && this.board('car', 120)) return;
      if (this.role === 'biker' && this.calm(now) && this.rng() < 0.5 && this.board('bike', 120)) return;
      if (this.role === 'pilot' && this.calm(now) && this.board('heli', 400)) return;
      const [x, z] = NEAR[Math.floor(this.rng() * NEAR.length)];
      if (Math.hypot(x - p.x, z - p.z) > 20) this.goTo(x, z, this.rng() < 0.7 ? RUN : WALK);
    }

    /** Walk to the nearest free car, bike or helicopter within `reach` m and ask for its seat. */
    board(kind, reach, id = null) {
      const p = this.pos;
      const map = kind === 'car' ? this.seen.cars : kind === 'bike' ? this.seen.bikes : this.seen.helis;
      let best = null;
      for (const [vid, v] of map) {
        if (id && vid !== id) continue;
        const free = kind === 'car' ? !v.driver : kind === 'bike' ? !v.rider : !(v.seats ?? []).some(Boolean) && v.g === 1;
        const d = Math.hypot(v.x - p.x, v.z - p.z);
        // Only one standing on the ground (the church's helicopter waits on a raised pad: a bot doesn't climb to it).
        const raised = v.y - ground(v.x, v.z) > 1.2;
        if (free && !raised && d < reach && (!best || d < best.d)) best = { vid, v, d };
      }
      if (!best) return false;
      this.task = { kind, id: best.vid, until: performance.now() + 90_000 };
      return true;
    }

    /** Where to stand to get in: by a car's door, a bike's side, a helicopter's step. */
    door(kind, v) {
      const fx = -Math.sin(v.yaw ?? 0), fz = -Math.cos(v.yaw ?? 0);
      const side = kind === 'car' ? -1.4 : kind === 'bike' ? -0.8 : 1.3;
      const ahead = kind === 'heli' ? 0.4 : 0.3;
      return [v.x + fx * ahead - fz * side, v.z + fz * ahead + fx * side];
    }

    boarding(now) {
      const t = this.task;
      const map = t.kind === 'car' ? this.seen.cars : t.kind === 'bike' ? this.seen.bikes : this.seen.helis;
      const v = map.get(t.id);
      if (t.asked) {
        if (now - t.asked > 2000) this.refused(`${t.kind}: no answer`, true);
        return;
      }
      if (!v || now > t.until || (t.kind === 'car' ? v.driver : t.kind === 'bike' ? v.rider : (v.seats ?? []).some(Boolean))) {
        this.task = null; // someone else was quicker
        this.path = null;
        return;
      }
      const [x, z] = this.door(t.kind, v);
      const p = this.pos;
      if (Math.hypot(x - p.x, z - p.z) > 0.6 || Math.abs(v.y - p.y) > 1.2) {
        if (!this.path || Math.hypot(this.goal[0] - x, this.goal[1] - z) > 1) this.goTo(x, z, RUN);
        if (Math.hypot(x - p.x, z - p.z) < 3 && Math.abs(v.y - p.y) > 1.2) this.refused(`${t.kind}: out of reach (raised)`);
        return;
      }
      if (!this.calm(now)) return; // not right after a fight: wait by it
      cur.seats.asked++;
      t.asked = now;
      this.lastCode = null;
      this.send(t.kind === 'car' ? { t: 'car', op: 'in', id: t.id } : t.kind === 'bike' ? { t: 'bike', op: 'on', id: t.id } : { t: 'heli', op: 'in', id: t.id });
    }

    getOut(now) {
      const s = this.seat;
      if (s.kind === 'car') {
        this.send({ t: 'car', op: 'out' });
        const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
        const side = -(0.96 + 0.45);
        this.pos = { x: this.pos.x + fx * 0.3 - fz * side, y: this.pos.y, z: this.pos.z + fz * 0.3 + fx * side };
      } else if (s.kind === 'bike') this.send({ t: 'bike', op: 'off' });
      this.seat = null;
      this.settle = now + 1500;
    }

    thinkFlag(now) {
      const p = this.pos;
      const f = this.mode.flag;
      const field = FIELDS[f.field] ?? FIELDS.compact;
      const mine = baseOf(field, this.team, !!f.swapped).stand; // the bases as the game has them (the host's swap)
      const theirs = baseOf(field, other(this.team), !!f.swapped).stand;
      const own = f.flags?.[this.team] ?? {};
      const enemyFlag = f.flags?.[other(this.team)] ?? {};
      const carrying = enemyFlag.by === this.name || this.carrying === other(this.team);
      const k = this.k ?? 0;
      if (!this.flagRole) {
        // By place in the team: in the village three drivers, nine on bikes, one pilot; else most attack (with fewer the
        // defenders shoot every one of them down before the stand), some hold the middle, a few defend.
        const foot = ['attack', 'mid', 'attack', 'defend', 'attack'];
        this.flagRole = field.vehicles ? (k < 3 ? 'driver' : k < 12 ? 'biker' : k === 12 ? 'pilot' : foot[k % 5]) : foot[k % 5];
      }
      const far = (x, z) => Math.hypot(x - p.x, z - p.z);
      const go = (x, z, speed = RUN) => {
        if (!this.goal || Math.hypot(this.goal[0] - x, this.goal[1] - z) > 4 || !this.path) this.goTo(x, z, speed);
      };
      if (carrying) {
        // Home: by the vehicle we came in, when near and allowed; else on foot.
        const lv = this.lastVehicle;
        const map = lv?.kind === 'car' ? this.seen.cars : lv?.kind === 'bike' ? this.seen.bikes : null;
        const v = map?.get(lv.id);
        if (!this.seat && v && !v.driver && !v.rider && far(v.x, v.z) < 40 && far(mine[0], mine[1]) > 200 && this.calm(now) && !this.task) {
          this.task = { kind: lv.kind, id: lv.id, until: now + 20_000, home: [mine[0], mine[1]] };
          return;
        }
        return go(mine[0], mine[1]);
      }
      if (this.seat) return; // on the way: getting out at the end of the path (think)
      if (own.at === 'ground' && (this.flagRole !== 'attack' || far(own.x, own.z) < 80)) return go(own.x, own.z);
      if (own.at === 'carried' || own.by) {
        const c = this.seen.players.get(own.by);
        if (c && far(c.x, c.z) < 150 && this.flagRole !== 'attack') return go(c.x, c.z);
      }
      if (enemyFlag.at === 'ground' && far(enemyFlag.x, enemyFlag.z) < 150) return go(enemyFlag.x, enemyFlag.z);
      const role = this.flagRole;
      if ((role === 'driver' || role === 'biker' || role === 'pilot') && !this.usedVehicle) {
        this.usedVehicle = true;
        const kind = role === 'driver' ? 'car' : role === 'biker' ? 'bike' : 'heli';
        const id = role === 'driver' ? `f${this.team[0]}${k + 1}` : role === 'biker' ? `flag${this.team === 'blue' ? 'B' : 'R'}${k - 2}` : this.team === 'blue' ? 'church' : 'house';
        if (this.board(kind, 200, id)) {
          // At the wheel or on the saddle: to 25 m short of the other team's stand.
          this.task.then = theirs;
          return;
        }
      }
      if (role === 'defend') {
        if (!this.path) {
          const a = this.rng() * Math.PI * 2, r = 6 + this.rng() * 14;
          go(mine[0] + Math.cos(a) * r, mine[1] + Math.sin(a) * r, this.rng() < 0.5 ? WALK : RUN);
        }
        return;
      }
      if (role === 'mid') {
        if (!this.path) {
          const t = 0.15 + this.rng() * 0.25; // the middle on our own side of it
          const a = this.rng() * Math.PI * 2;
          go(mine[0] + (theirs[0] - mine[0]) * t + Math.cos(a) * 8, mine[1] + (theirs[1] - mine[1]) * t + Math.sin(a) * 8, this.rng() < 0.5 ? WALK : RUN);
        }
        return;
      }
      // Attackers leave their base together, as a team does: four of them (or after 20 s waiting), not one at a time into
      // the other team's fire.
      if (role === 'attack' && far(mine[0], mine[1]) < 25) {
        this.packAt ??= now;
        const pack = bots.filter((b) => b.team === this.team && b.alive && b.flagRole === 'attack' && b.pos && Math.hypot(b.pos.x - mine[0], b.pos.z - mine[1]) < 25).length;
        if (pack < 4 && now - this.packAt < 20_000) {
          if (!this.path) go(mine[0] + (this.rng() - 0.5) * 16, mine[1] + (this.rng() - 0.5) * 16, WALK);
          return;
        }
      } else this.packAt = null;
      go(theirs[0], theirs[1]); // attack, and the drivers and riders once out
    }

    thinkDuel(now) {
      const p = this.pos;
      if (!this.anchor) this.anchor = { x: p.x, z: p.z };
      const z = this.nearestZombie(40);
      if (z && z.d < 4) {
        // Step back from it, staying near where we came in.
        const ax = p.x - z.x, az = p.z - z.z;
        let x = p.x + (ax / (z.d || 1)) * 5, zz = p.z + (az / (z.d || 1)) * 5;
        const fromA = Math.hypot(x - this.anchor.x, zz - this.anchor.z);
        if (fromA > 12) [x, zz] = [this.anchor.x + ((x - this.anchor.x) * 12) / fromA, this.anchor.z + ((zz - this.anchor.z) * 12) / fromA];
        this.goTo(x, zz, RUN);
        return;
      }
      if (!this.path) {
        const a = this.rng() * Math.PI * 2, r = this.rng() * 8;
        this.goTo(this.anchor.x + Math.cos(a) * r, this.anchor.z + Math.sin(a) * r, this.rng() < 0.6 ? WALK : RUN);
      }
    }

    nearestZombie(reach) {
      const p = this.pos;
      let best = null;
      for (const [id, z] of this.seen.zombies) {
        if (z.act === 'down' || z.hp <= 0) continue;
        const d = Math.hypot(z.x - p.x, z.z - p.z);
        if (d < reach && Math.abs((z.y ?? 0) - p.y) < 3 && (!best || d < best.d)) best = { id, ...z, d };
      }
      return best;
    }

    /**
     * Someone to shoot: the nearest enemy within `reach` m (25: in a village the houses and hedges hide the rest) that the
     * server says is alive, unprotected and on foot.
     */
    enemy(reach = 25) {
      const p = this.pos;
      if (noShoot(p.x, p.z)) return null;
      const flag = this.mode.kind === 'flag' ? this.mode.teams ?? {} : null;
      let best = null;
      for (const [name, q] of this.seen.players) {
        if (!byName.has(name) || name === this.name) continue;
        if (!(q.f & FLAG.alive) || q.f & (FLAG.safe | FLAG.car | FLAG.bike | FLAG.chute)) continue;
        if (flag && (!flag[name] || flag[name] === this.team)) continue;
        const d = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
        if (d < reach && (!best || d < best.d) && !noShoot(q.x, q.z)) best = { name, ...q, d };
      }
      return best;
    }

    /** Shooting as a person does: bursts at the gun's rate, pauses, misses; now and then a grenade. */
    fight(now) {
      if (this.drop || now < this.holdFire || now < this.settle - 1000) return (this.target = null);
      const p = this.pos;
      const zombies = !!this.duel;
      if (zombies) {
        this.w = this.weapons.includes('rifle') ? 'rifle' : 'pistol';
        const z = this.nearestZombie(35);
        this.target = z;
        if (!z) return;
        this.face(z.x, (z.y ?? 0) + 1.2, z.z);
        if (now < this.nextShot) return;
        this.shoot(now, z.x, (z.y ?? 0) + 1.2, z.z);
        if (this.rng() < 0.65) {
          const head = this.rng() < 0.15;
          this.send({ t: 'zhit', w: this.w, hits: [[z.id, head ? 0 : 1, head ? 1 : 0]] });
          cur.zhits++;
        }
        if (now > this.nextNade) this.nadeAtZombies(now);
        return;
      }
      if (this.mode.kind === 'free' || this.mode.kind === 'flag') this.w = this.weapons.includes('rifle') ? 'rifle' : 'pistol';
      // An attacker (or the carrier) sprints for it and shoots only at someone right by them.
      const runner = this.mode.kind === 'flag' && (this.flagRole === 'attack' || this.carrying);
      const e = this.enemy(runner ? 8 : 25);
      this.target = e;
      if (!e) return;
      this.face(e.x, e.y + 1.2, e.z);
      if (now > this.nextNade && e.d > 8 && e.d < 25 && now - this.lastNade > 16_000) return this.nade(now, e.x, e.y, e.z);
      if (now < this.nextShot) return;
      this.shoot(now, e.x, e.y + 1.2, e.z);
      // A child's aim: about one in four close by, one in twenty far off (better aim and nobody lives long enough to reach
      // the other team's stand).
      const chance = Math.max(0.05, 0.25 - e.d * 0.006);
      if (this.rng() < chance) {
        const head = this.rng() < 0.08;
        this.send({ t: 'hit', target: e.name, w: this.w, body: head ? 0 : 1, head: head ? 1 : 0 });
        cur.hits.sent++;
        this.lastFight = now;
      }
    }

    face(x, y, z) {
      const p = this.pos;
      this.yaw = yawTo(x - p.x, z - p.z);
      this.pitch = Math.atan2(y - (p.y + 1.5), Math.hypot(x - p.x, z - p.z));
    }

    shoot(now, tx, ty, tz) {
      const spec = WEAPONS[this.w];
      const p = this.pos;
      this.state(now); // the aim first, as a page's state goes before its shot
      const tracer = this.w === 'rifle' && this.burst % 3 === 0 ? { tx: r2(tx), ty: r2(ty), tz: r2(tz) } : {};
      this.send({ t: 'shot', w: this.w, x: r2(p.x), y: r2(p.y + 1.5), z: r2(p.z), ...tracer });
      this.burst++;
      const auto = spec.auto;
      if (this.burst >= (auto ? 3 + Math.floor(this.rng() * 5) : 1 + Math.floor(this.rng() * 3))) {
        this.burst = 0;
        this.nextShot = now + 600 + this.rng() * 1400; // a pause: aiming again, moving, reloading
      } else this.nextShot = now + spec.delay * 1000 * (auto ? 1.1 : 1.8 + this.rng());
    }

    nade(now, x, y, z) {
      const p = this.pos;
      const dx = x - p.x, dz = z - p.z;
      const d = Math.hypot(dx, dz) || 1;
      const v = GRENADE.speed;
      this.send({ t: 'nade', x: r2(p.x), y: r2(p.y + 1.5), z: r2(p.z), vx: r2((dx / d) * v * 0.85), vy: r2(v * 0.45), vz: r2((dz / d) * v * 0.85) });
      cur.nades.thrown++;
      this.lastNade = now;
      this.lastFight = now;
      this.nextNade = now + 40_000 + this.rng() * 60_000; // one every minute or so
      const a = this.rng() * Math.PI * 2, off = 2 + this.rng() * 3; // a throw lands 2 to 5 m from where it was aimed
      const bx = p.x + dx * 0.9 + Math.cos(a) * off, bz = p.z + dz * 0.9 + Math.sin(a) * off;
      this.boom = { at: now + GRENADE.fuse * 1000 + 50, x: bx, y: ground(bx, bz) + 0.2, z: bz };
    }

    nadeAtZombies(now) {
      const p = this.pos;
      const near = [...this.seen.zombies.values()].filter((z) => z.act !== 'down' && Math.hypot(z.x - p.x, z.z - p.z) < 14);
      if (near.length < 3) return;
      const x = near.reduce((s, z) => s + z.x, 0) / near.length;
      const z = near.reduce((s, q) => s + q.z, 0) / near.length;
      this.nade(now, x, p.y, z);
    }
  }
  /** The first bot of the same room (one count per event, not one per bot that hears of it). */
  const firstIn = (bot) => {
    for (const b of bots) if (b.duel === bot.duel && b.ws?.readyState === 1) return b.i;
    return bot.i;
  };
  const r2 = (v) => Math.round(v * 100) / 100;
  const r3 = (v) => Math.round(v * 1000) / 1000;

  // --- the admin's watch views (src/watch.ts): everyone, every tick
  class Watcher {
    constructor(i) {
      this.i = i;
      this.stopped = false;
      this.connect();
    }

    connect() {
      const ws = new WebSocket(`ws://${host}/ws?v=2&watch=1`, { headers: { Cookie: adminCookie, Origin: api } });
      this.ws = ws;
      ws.on('message', (d) => {
        cur.watchBytes += d.length;
        cur.watchMsgs++;
        if (d.length < 80 && String(d).includes('"ping"')) return ws.send(JSON.stringify({ t: 'pong', n: JSON.parse(String(d)).n }));
        if (this.i === 0 && d[2] === 0x74 && d[6] === 0x73) { // {"t":"s": the first watcher checks every move
          const m = JSON.parse(String(d));
          for (const e of m.p ?? []) checkMove(m.st, e);
        }
      });
      ws.on('unexpected-response', (_q, res) => cur.refusedConnect.push(`watch ${this.i}: HTTP ${res.statusCode}`));
      ws.on('close', (code) => {
        if (this.stopped || ws !== this.ws) return;
        cur.drops.push(`watch ${this.i}: ${code}`);
        setTimeout(() => !this.stopped && this.connect(), 1000);
      });
      ws.on('error', () => {});
    }

    stop() {
      this.stopped = true;
      this.ws?.close();
    }
  }

  // --- join
  const tag = Math.random().toString(36).slice(2, 5);
  for (let i = 0; i < PLAYERS; i++) {
    if (i % 8 === 0) await call('POST', '/api/lockouts', {}, adminCookie); // every guest joins from this one address
    const { r, data: d } = await call('POST', '/api/join', { name: `nl${tag}${i}`, age: true });
    if (!r.ok) {
      console.log(`  guest ${i} could not join: ${r.status} ${d?.code ?? ''}`);
      continue;
    }
    const b = new Bot(i, `nl${tag}${i}`, cookieOf(r));
    bots.push(b);
    byName.set(b.name, b);
    await sleep(40);
  }
  await sleep(2000);
  await act({ op: 'teams', count: 2 }); // the evening's blue and red, shuffled
  await sleep(800);
  for (const t of ['blue', 'red']) bots.filter((b) => b.team === t).forEach((b, k) => (b.k = k));
  console.log(`${bots.length} players in (${bots.filter((b) => b.team === 'blue').length} blue, ${bots.filter((b) => b.team === 'red').length} red), ${Number(o.watchers) || 0} watch views`);
  for (let i = 0; i < (Number(o.watchers) || 0); i++) watchers.push(new Watcher(i));
  let last = performance.now();
  loop = setInterval(() => {
    const now = performance.now();
    const dt = Math.min(0.2, (now - last) / 1000);
    last = now;
    let on = 0;
    for (const b of bots) {
      b.step(now, dt);
      if (b.ws?.readyState === 1) on++;
    }
    cur.connected = Math.max(cur.connected ?? 0, on);
  }, 50);

  // --- the parts of the evening
  const results = [];
  const everyoneBack = () => bots.every((b) => !b.duel);
  const wait = async (what, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if (await what()) return true;
    return false;
  };
  /** The duel takes at most 20 a team (server/duel.mjs DUEL_PLAYERS): the rest sit it out, as the host would have them. */
  const sitOut = () => {
    const out = [];
    for (const t of ['blue', 'red']) out.push(...bots.filter((b) => b.team === t).slice(20));
    for (const b of out) b.pause();
    if (out.length) console.log(`  ${out.length} players sit the duel out (at most 20 a team)`);
    return out;
  };
  const RUNS = {
    free: { label: 'Free play', run: () => sleep(PHASE_S * 1000) },
    warmup: {
      label: 'Zombies duel, warm-up (paint)',
      run: async () => {
        const out = sitOut();
        await sleep(out.length ? 1500 : 0);
        const r = await act({ op: 'start', kind: 'duel', duel: 'warmup', minutes: testMinute ? warmMinutes : Math.max(1, Math.min(30, Math.round(PHASE_S / 60))), look: 'paint' });
        if (!r?.ok) console.log(`  the warm-up did not start: ${JSON.stringify(r)}`);
        await sleep(16_000 + PHASE_S * 1000);
        await wait(async () => everyoneBack(), 40_000);
        for (const b of out) b.resume();
      },
    },
    compact: { label: 'Steal the flag, compact (paint)', run: () => flag('compact', 'paint') },
    village: { label: 'Steal the flag, village (real)', run: () => flag('village', 'real') },
    // Attack and defend (server/assault.mjs): its two rounds in the phase's time, each half of it (at least a minute).
    assault: {
      label: 'Attack and defend, two rounds (real)',
      run: async () => {
        const half = Math.max(1, Math.round(PHASE_S / 120));
        const r = await act({ op: 'start', kind: 'assault', defend: 'blue', look: 'real', minutes: half });
        if (!r?.ok) console.log(`  attack and defend did not start: ${JSON.stringify(r)}`);
        await sleep(11_000 + 2 * half * 60_000 + 25_000);
        const v = await view();
        if (v?.mode?.kind !== 'free' && v?.mode?.phase !== 'done') await act({ op: 'stop' });
        await sleep(3000);
        for (const b of bots) Object.assign(b, { flagRole: null, usedVehicle: false, lastVehicle: null });
      },
    },
    final: {
      label: 'Zombies duel, final (real)',
      run: async () => {
        const out = sitOut();
        await sleep(out.length ? 1500 : 0);
        const r = await act({ op: 'start', kind: 'duel', duel: 'final', look: 'real' });
        if (!r?.ok) console.log(`  the final did not start: ${JSON.stringify(r)}`);
        await sleep(16_000 + PHASE_S * 1000);
        const v = await view();
        if (v?.duel && v.duel.phase !== 'done') await act({ op: 'stop' });
        await wait(async () => everyoneBack(), 30_000);
        for (const b of out) b.resume();
      },
    },
  };
  async function flag(place, look) {
    const r = await act({ op: 'start', kind: 'flag', place, look, minutes: Math.max(1, Math.ceil(PHASE_S / 60)) });
    if (!r?.ok) console.log(`  the flag game did not start: ${JSON.stringify(r)}`);
    await sleep(11_000 + PHASE_S * 1000);
    await act({ op: 'stop' });
    await sleep(3000);
    for (const b of bots) Object.assign(b, { flagRole: null, usedVehicle: false, lastVehicle: null });
  }

  await sleep(3000);
  await ask('stats'); // a fresh window
  for (const id of PHASES) {
    const p = RUNS[id];
    if (!p) {
      console.log(`  no such part: ${id}`);
      continue;
    }
    const before = (await ask('gc')).mem;
    await ask('stats');
    cur = fresh(id);
    console.log(`${new Date().toLocaleTimeString()}  ${p.label}`);
    await p.run();
    const server = await ask('stats');
    const tool = process.cpuUsage(cur.tool);
    const after = (await ask('gc')).mem;
    const secs = (performance.now() - cur.t0) / 1000;
    results.push({ id, label: p.label, secs, server, before, after, client: cur, toolCpu: ((tool.user + tool.system) / 1000 / (secs * 1000)) * 100, players: cur.connected || bots.length });
    summarise(results.at(-1));
    await sleep(4000);
  }

  // --- the report
  report(results);
  if (o.json) writeFileSync(o.json, JSON.stringify({ players: bots.length, phaseSeconds: PHASE_S, results, log }, null, 1));
  await cleanup();
  console.log(`server stopped${hadData ? '; the test guests stay in web/.data (it was there before)' : '; web/.data removed (it was made by this run)'}`);
  process.exit(0);

  function summarise(r) {
    const s = r.server;
    const w = s.ticks.world ?? spread([]);
    console.log(`  world tick ${f1(w.avg)} / ${f1(w.p99)} / ${f1(w.max)} ms (avg / p99 / worst), busy p99 ${f1(s.busy.p99)} ms of 50, loop delay p99 ${f1(s.eld.p99)} ms, cpu ${f0(s.cpu)} %, out ${f0(s.outBytes / 1024 / s.secs)} kB/s, drops ${r.client.drops.length}`);
  }

  function report(list) {
    const line = (cells, widths) => cells.map((c, i) => String(c).padStart(widths[i])).join('  ');
    console.log('\n=== The server through the evening (' + bots.length + ' players, ' + watchers.length + ' watch views, each part ' + Math.round(PHASE_S / 60 * 10) / 10 + ' min plus its countdown) ===');
    console.log('The processor and graphics chip are shared with other agents: figures wander between runs.\n');
    const W1 = [32, 7, 7, 7, 7, 7, 7, 7, 6, 6];
    console.log(line(['part', 'secs', 'tick', 'p95', 'p99', 'worst', 'busy99', 'busyMax', 'loop99', 'cpu%'], W1));
    for (const r of list) {
      const s = r.server;
      for (const [label, t] of Object.entries(s.ticks)) {
        const b = label === 'world' ? [f1(s.busy.p99), f1(s.busy.max), f1(s.eld.p99), f0(s.cpu)] : ['', '', '', ''];
        console.log(line([label === 'world' ? r.label : `  ${label}`, label === 'world' ? f0(r.secs) : '', f2(t.avg), f1(t.p95), f1(t.p99), f1(t.max), ...b], W1));
      }
    }
    console.log('(tick: one game\'s tick, ms; busy: all games and every message together in each 50 ms window; loop: the event loop\'s delay, ms; cpu: of one core)');
    const W2 = [32, 8, 8, 9, 9, 9, 8, 8, 8];
    console.log('\n' + line(['part', 'rss MB', 'heap MB', 'kB/s/pl', 'MB/s out', 'watch kB/s', 'msg in/s', 'out/s', 'tool cpu'], W2));
    for (const r of list) {
      const s = r.server;
      const toPlayers = Object.values(r.client.types).reduce((a, t) => a + t.bytes, 0);
      console.log(line([r.label, `${f0(r.before.rssMB)}>${f0(r.after.rssMB)}`, `${f1(r.before.heapMB)}>${f1(r.after.heapMB)}`, f1(toPlayers / 1024 / r.secs / Math.max(1, r.players)), f2(s.outBytes / 1048576 / s.secs), f1(r.client.watchBytes / 1024 / r.secs), f0(s.in / s.secs), f0(s.out / s.secs), `${f0(r.toolCpu)}%`], W2));
    }
    console.log('(heap after a garbage collection at the start and the end of each part; kB/s/pl: what one player\'s page receives; MB/s out: all the server sent)');
    for (const r of list) {
      const c = r.client;
      console.log(`\n-- ${r.label}`);
      const top = Object.entries(c.types).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8);
      console.log(`  to the players, by message: ${top.map(([t, v]) => `${t} ${f0(v.bytes / 1024 / r.secs)} kB/s (${f0(v.n / r.secs)}/s)`).join(', ')}`);
      console.log(`  from the players: ${Object.entries(c.sent).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${f1(n / r.secs)}/s`).join(', ')}`);
      console.log(`  hits sent ${c.hits.sent}, counted ${c.hits.ok} (${c.hits.sent ? f0((100 * c.hits.ok) / c.hits.sent) : '-'} %), grenade hurts ${c.hits.nade}; grenades ${c.nades.thrown}, blasts ${c.nades.blasts}; kills ${c.kills}; zombie hits ${c.zhits}, zombies beaten ${c.zdowns}; waves ${JSON.stringify(c.waves)}`);
      console.log(`  flag events ${JSON.stringify(c.flags)}; seats asked ${c.seats.asked}, got ${c.seats.got}, refused by the server ${JSON.stringify(c.seats.refused)}, given up by the bot ${JSON.stringify(c.seats.gaveUp)}`);
      console.log(`  moves checked ${c.moves.checked}, not taken as sent ${c.moves.off}${c.moves.samples.length ? `: ${c.moves.samples.join('; ')}` : ''}`);
      console.log(`  dropped connections ${c.drops.length}${c.drops.length ? ` (${c.drops.slice(0, 8).join(', ')})` : ''}; refused ${c.refusedConnect.length}${c.refusedConnect.length ? ` (${c.refusedConnect.slice(0, 8).join(', ')})` : ''}; 'full' ${c.full}`);
      const codes = Object.entries(c.codes).sort((a, b) => b[1] - a[1]).slice(0, 12);
      if (codes.length) console.log(`  lines from the server (code: times heard): ${codes.map(([k, n]) => `${k} ${n}`).join(', ')}`);
    }
    console.log(`\nserver log: ${log.lines} lines, ${log.errors.length} errors${log.errors.length ? ':' : ''}`);
    for (const e of log.errors.slice(0, 10)) console.log(`  ${e}`);
    // The verdict, against the tick's 50 ms.
    const worst = list.reduce((a, r) => (r.server.busy.p99 > (a?.server.busy.p99 ?? -1) ? r : a), null);
    if (!worst) return;
    const maxTick = Math.max(...list.flatMap((r) => Object.values(r.server.ticks).map((t) => t.max)));
    const drops = list.reduce((n, r) => n + r.client.drops.length + r.client.refusedConnect.length, 0);
    const busy = worst.server.busy.p99;
    const peakCpu = Math.max(...list.map((r) => r.server.cpu));
    const peakOut = Math.max(...list.map((r) => (r.server.outBytes * 8) / 1e6 / r.server.secs));
    // The processor's share is the server's own work; the times are wall clock, and on a shared computer they also count
    // the moments another program had the processor. Both have to be within budget.
    const holds = busy < 50 && peakCpu < 50 && !drops;
    console.log(`\nverdict: ${bots.length} players ${holds ? 'hold' : 'do NOT hold'}. The server's own work peaks at ${f0(peakCpu)} % of one core (${f0(100 - peakCpu)} % left). In the busiest part (${worst.label}) 99 of every 100 ticks' 50 ms windows are done within ${f1(busy)} ms (wall clock, ${f0(100 - (busy / 50) * 100)} % left); the worst single tick took ${f1(maxTick)} ms; ${drops} dropped or refused connections.`);
    console.log(`         peak out ${f1(peakOut)} Mbit/s (the network to the players has to carry that, plus the pages' own downloads).`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function f0(v) {
  return Number.isFinite(v) ? Math.round(v).toString() : '-';
}
function f1(v) {
  return Number.isFinite(v) ? v.toFixed(1) : '-';
}
function f2(v) {
  return Number.isFinite(v) ? v.toFixed(2) : '-';
}
