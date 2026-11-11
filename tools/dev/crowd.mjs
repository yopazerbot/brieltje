// A full house against a throwaway game server (a build of this branch on this computer): N guests join and walk in
// circles round the house, each sending its state 20 times a second as a page does, for a while. Prints what each one
// receives (messages and kilobytes a second) and, given the server's process id, the server's share of one core.
// For the LAN night's limit (server/game.mjs MAX_PLAYERS; Yoshi, 11 Nov 2026: about 30 people).
//
//   node tools/dev/crowd.mjs --api http://localhost:8231 --n 31 --secs 30 [--pid 1234]
//
// Names are crowd00, crowd01...; TAG=b in the environment makes them crowdb00... (a guest's name stays taken for the day).
import { execFileSync } from 'node:child_process';
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { localOnly, options } from './cdp.mjs';

const o = options({ api: 'http://localhost:8231', n: '31', secs: '30', pid: '' });
localOnly(o.api);
const host = new URL(o.api).host;
const N = Number(o.n);
const SECS = Number(o.secs);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookieOf = (r) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

/** The server's CPU seconds so far (Windows: PowerShell; elsewhere: ps). */
const cpu = (pid) => {
  if (!pid) return null;
  if (process.platform === 'win32') return Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).CPU`]).toString().trim().replace(',', '.'));
  const [m, s] = execFileSync('ps', ['-o', 'cputime=', '-p', String(pid)]).toString().trim().split(':').slice(-2).map(Number);
  return m * 60 + s;
};

const bots = [];
for (let i = 0; i < N; i++) {
  const name = `crowd${process.env.TAG ?? ''}${String(i).padStart(2, '0')}`;
  const r = await fetch(`${o.api}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: o.api }, body: JSON.stringify({ name, age: true }) });
  if (!r.ok) throw new Error(`${name} could not join: ${r.status} ${await r.text()}`);
  const ws = new WebSocket(`ws://${host}/ws?v=2`, { headers: { Cookie: cookieOf(r), Origin: o.api } });
  const bot = { name, ws, bytes: 0, msgs: 0, closed: null };
  ws.on('message', (d) => {
    bot.bytes += d.length;
    bot.msgs++;
    const m = JSON.parse(String(d));
    if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', n: m.n }));
  });
  ws.on('close', (code) => (bot.closed = code));
  await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)));
  bots.push(bot);
}
console.log(`${bots.length} joined`);
await sleep(1500);
for (const b of bots) b.bytes = b.msgs = 0;
const cpu0 = cpu(o.pid);
const t0 = performance.now();
// Walking in circles of 6 to 14 m round the house's lawn, each at its own pace, 20 states a second.
const timer = setInterval(() => {
  const t = (performance.now() - t0) / 1000;
  bots.forEach((b, i) => {
    if (b.ws.readyState !== WebSocket.OPEN) return;
    const r = 6 + (i % 5) * 2;
    const a = t * (0.3 + (i % 7) * 0.02) + i;
    b.ws.send(JSON.stringify({ t: 'state', x: 4.5 + Math.sin(a) * r, y: 0, z: 18 + Math.cos(a) * r, yaw: a, pitch: 0, armed: i % 2 === 0, w: 'pistol' }));
  });
}, 50);
await sleep(SECS * 1000);
clearInterval(timer);
const secs = (performance.now() - t0) / 1000;
const cpu1 = cpu(o.pid);
const kb = bots.map((b) => b.bytes / 1024 / secs);
const msgs = bots.map((b) => b.msgs / secs);
const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
console.log(`each receives ${avg(msgs).toFixed(1)} messages and ${avg(kb).toFixed(1)} KB a second (most ${Math.max(...kb).toFixed(1)} KB)`);
console.log(`all together ${(avg(kb) * bots.length * 8 / 1024).toFixed(2)} Mbit/s out of the server`);
if (cpu0 !== null) console.log(`server: ${(((cpu1 - cpu0) / secs) * 100).toFixed(1)} % of one core`);
const dropped = bots.filter((b) => b.closed !== null);
console.log(dropped.length ? `closed: ${dropped.map((b) => `${b.name} ${b.closed}`).join(', ')}` : 'none dropped');
for (const b of bots) b.ws.close();
await sleep(300);
process.exit(0);
