// How long the game server is held at once, measured inside it: preloaded into a throwaway server on this computer
// (never Railway), it times every callback the server runs (a timer, a message, a request: node:async_hooks before and
// after) and writes each one over HOLD_MIN_MS (default 2) to HOLD_FILE as a line of JSON: { t: when it ended (ms since
// 1970), ms: how long it ran, type }. A tick of the server's own is measured exactly so, whatever the timer's steps on
// this computer (Windows: often 15 ms). tools/dev/gamenight_ws_check.mjs --holds <file> reads it.
// HOLD_PROFILE_S: also a CPU profile of the server's first so many seconds, written next to HOLD_FILE (.cpuprofile).
//
//   HOLD_FILE=<scratch>/holds.jsonl PORT=8870 ADMIN_PASSWORD=... node --import ./tools/dev/holdWatch.mjs web/server.mjs
import { createHook } from 'node:async_hooks';
import { appendFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { performance } from 'node:perf_hooks';

const file = process.env.HOLD_FILE;
if (!file) throw new Error('HOLD_FILE is not set');
const min = Number(process.env.HOLD_MIN_MS) || 2;
writeFileSync(file, '');
let depth = 0;
let from = 0;
let type = '';
const types = new Map(); // async id -> its type
let lines = [];
createHook({
  init(id, t) {
    types.set(id, t);
  },
  destroy(id) {
    types.delete(id);
  },
  before(id) {
    if (depth++ === 0) {
      from = performance.now();
      type = types.get(id) ?? '?';
    }
  },
  after() {
    if (--depth !== 0) return;
    const ms = performance.now() - from;
    if (ms >= min) lines.push(JSON.stringify({ t: Date.now(), ms: Math.round(ms * 10) / 10, type }));
  },
}).enable();
// Written once a second, outside any measured callback's own time (its own write is a few hundred bytes).
setInterval(() => {
  if (!lines.length) return;
  appendFileSync(file, lines.join('\n') + '\n');
  lines = [];
}, 1000).unref();

const secs = Number(process.env.HOLD_PROFILE_S);
if (secs > 0) {
  const s = new Session();
  s.connect();
  s.post('Profiler.enable', () => s.post('Profiler.start', () => {
    setTimeout(() => s.post('Profiler.stop', (err, r) => {
      if (!err) writeFileSync(file.replace(/\.jsonl?$/, '') + '.cpuprofile', JSON.stringify(r.profile));
    }), secs * 1000).unref();
  }));
}
