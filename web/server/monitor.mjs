// How the server itself is doing, for the host's screen during a LAN night (Yoshi, 11 Nov 2026: "implement some stats about
// the actual server performance/load/ etc to monitor resources during the game"). Nothing about any player: only the
// server's own process and computer, counted in memory, a sample every five seconds for the last fifteen minutes.
//
// - The game's tick (server/game.mjs, 20 a second): how long each takes, against its 50 ms. Past that, everyone stutters.
// - The event loop: how late timers fire (its lag) and how busy it is (utilisation). A busy loop answers everyone late.
// - The process's share of the processor (100 % = one core: the game runs on one) and its memory.
// - The network: messages in and out a second, and what goes out (kilobytes and megabits a second): Wi-Fi at a venue has
//   its limits.
// - The computer: its cores, free memory and load (the load is 0 on Windows, which doesn't report it).
// - Who is connected: players together, watch views, Zombies rooms; and their pings (lowest, middle, highest).

import os from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const EVERY_MS = 5000;
const KEEP = 180; // samples: fifteen minutes

class Monitor {
  constructor() {
    this.lag = monitorEventLoopDelay({ resolution: 10 });
    this.lag.enable();
    this.cpu = process.cpuUsage();
    this.at = performance.now();
    this.elu = performance.eventLoopUtilization();
    this.started = Date.now();
    this.ticks = { n: 0, sum: 0, max: 0 };
    this.net = { in: 0, inBytes: 0, out: 0, outBytes: 0 };
    this.samples = [];
    /** Who is connected and their pings, given by server.mjs (rooms.mjs and the games). */
    this.people = () => ({ players: 0, watchers: 0, rooms: 0, pings: [] });
    setInterval(() => this.sample(), EVERY_MS).unref();
  }

  /** A tick of a game took `ms`. */
  tick(ms) {
    this.ticks.n++;
    this.ticks.sum += ms;
    if (ms > this.ticks.max) this.ticks.max = ms;
  }

  /** A message came in (its length). */
  in(bytes) {
    this.net.in++;
    this.net.inBytes += bytes;
  }

  /** A message went out to `count` pages (its length each). */
  out(bytes, count = 1) {
    this.net.out += count;
    this.net.outBytes += bytes * count;
  }

  sample() {
    const now = performance.now();
    const secs = (now - this.at) / 1000 || 1;
    const cpu = process.cpuUsage(this.cpu);
    const elu = performance.eventLoopUtilization(this.elu);
    const mem = process.memoryUsage();
    const people = this.people();
    const pings = people.pings.filter((p) => typeof p === 'number').sort((a, b) => a - b);
    const s = {
      at: Date.now(),
      cpu: Math.round(((cpu.user + cpu.system) / 1000 / (secs * 1000)) * 1000) / 10, // % of one core
      loop: Math.round(elu.utilization * 1000) / 10, // % of the time the event loop was busy
      lagMs: Math.round(this.lag.percentile(99) / 1e5) / 10, // the 99th percentile, ms
      tickMs: this.ticks.n ? Math.round((this.ticks.sum / this.ticks.n) * 100) / 100 : 0,
      tickMaxMs: Math.round(this.ticks.max * 10) / 10,
      memMB: Math.round(mem.rss / 1048576),
      heapMB: Math.round(mem.heapUsed / 1048576),
      inPerSec: Math.round(this.net.in / secs),
      outPerSec: Math.round(this.net.out / secs),
      kbOutPerSec: Math.round(this.net.outBytes / 1024 / secs),
      mbitOut: Math.round(((this.net.outBytes * 8) / 1e6 / secs) * 100) / 100,
      players: people.players,
      watchers: people.watchers,
      rooms: people.rooms,
      pingLow: pings.length ? pings[0] : null,
      pingMid: pings.length ? pings[pings.length >> 1] : null,
      pingHigh: pings.length ? pings[pings.length - 1] : null,
      sysFreeMB: Math.round(os.freemem() / 1048576),
      sysLoad: Math.round(os.loadavg()[0] * 100) / 100,
    };
    this.samples.push(s);
    if (this.samples.length > KEEP) this.samples.shift();
    this.at = now;
    this.cpu = process.cpuUsage();
    this.elu = performance.eventLoopUtilization();
    this.lag.reset();
    this.ticks = { n: 0, sum: 0, max: 0 };
    this.net = { in: 0, inBytes: 0, out: 0, outBytes: 0 };
    return s;
  }

  /** For the host's screen: the computer, the latest sample and the last fifteen minutes. */
  view() {
    return {
      every: EVERY_MS,
      uptimeS: Math.round((Date.now() - this.started) / 1000),
      node: process.version,
      cores: os.availableParallelism?.() ?? os.cpus().length,
      sysTotalMB: Math.round(os.totalmem() / 1048576),
      platform: `${os.type()} ${os.arch()}`,
      inDocker: process.env.container === 'docker' || existsDockerEnv(),
      tickBudgetMs: 50,
      samples: this.samples,
    };
  }
}

/** In a container: Linux, with its host name the container's id (Docker's default). */
function existsDockerEnv() {
  try {
    return os.platform() === 'linux' && !!process.env.HOSTNAME && /^[0-9a-f]{12}$/.test(process.env.HOSTNAME);
  } catch {
    return false;
  }
}

export const monitor = new Monitor();
