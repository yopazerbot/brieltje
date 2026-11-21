// The players' network addresses on the host page (server/host.mjs connectionOf, GET /api/host?addresses=1), against a
// throwaway game server on this computer: a few guests join with forged X-Forwarded-For, X-Real-IP and CF-Connecting-IP
// headers on their WebSocket, and the hall screen's watch view is open. Checked: GET /api/host is refused without a
// session (401) and for a guest (403), also with ?addresses=1; the admin's plain view (the one the watch page reads) and
// the admin panel's list (GET /api/players) carry no address; the admin's ?addresses=1 view has each guest's address,
// the one the connection really came from and never a forged one; no player's page and no watch view was sent an
// address. --front: the players come in through a reverse proxy there (Caddy, as lan/ runs it, with the server started
// with TRUST_PROXY=1), and the address must be the one this computer connects to the proxy from. --spread (without
// --front): the guests come in by this computer's different addresses (127.0.0.1, ::1, its network cards' IPv4), so
// the host page shows different ones. --hold <s>: the guests stay connected that long at the end (for pictures).
//
//   ADMIN_PASSWORD=... node tools/dev/host_addresses_check.mjs --api http://localhost:8460 [--front http://<this computer's address>:<port> | --spread] [--players 3] [--hold 0]
import { networkInterfaces } from 'node:os';
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { localOnly, options } from './cdp.mjs';

const o = options({ api: 'http://localhost:8460', front: '', spread: false, players: '3', hold: '0' });
localOnly(o.api); // it logs in as the admin: a throwaway server on this computer only
const cards = Object.values(networkInterfaces()).flat().filter((a) => !a.internal && a.family === 'IPv4').map((a) => a.address);
if (o.front && !['localhost', '127.0.0.1', '[::1]', ...cards].includes(new URL(o.front).hostname)) throw new Error('--front must be this computer');
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');
const port = new URL(o.api).port;
// Where each guest comes in.
const doors = o.front ? [o.front] : o.spread ? [`http://127.0.0.1:${port}`, `http://[::1]:${port}`, ...cards.map((a) => `http://${a}:${port}`)] : [o.api];
const FORGED = { 'X-Forwarded-For': '203.0.113.66', 'X-Real-IP': '203.0.113.68', 'CF-Connecting-IP': '203.0.113.69' };
const forged = (s) => /203\.0\.113\./.test(s);

let failed = 0;
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
  if (!pass) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (method, path, body, cookie = '', at = o.api) => {
  const r = await fetch(at + path, { method, headers: { 'Content-Type': 'application/json', Origin: at, Cookie: cookie, ...FORGED }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { r, data, text };
};
const cookieOf = (r) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const adminCookie = cookieOf((await call('POST', '/api/login', { username: 'admin', password })).r);
ok('the admin logged in', !!adminCookie);

/** A page's connection through `base`, with forged headers: every message it is sent, as text. */
const connect = async (cookie, watch = false, base = o.api) => {
  const got = [];
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?v=2${watch ? '&watch=1' : ''}`, { headers: { Cookie: cookie, Origin: base, ...FORGED } });
  ws.on('message', (d) => {
    const s = String(d);
    got.push(s);
    try {
      const m = JSON.parse(s);
      if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', n: m.n }));
    } catch {
      // a binary tick
    }
  });
  await new Promise((res) => (ws.on('open', res), ws.on('error', res)));
  return { ws, got };
};
const run = Math.random().toString(36).slice(2, 5);
const pages = [];
for (let i = 0; i < Math.max(1, Number(o.players)); i++) {
  await call('POST', '/api/lockouts', {}, adminCookie); // every guest joins from this one computer: its limit lifted
  const name = `ip${run}${i}`;
  const door = doors[i % doors.length];
  const { r } = await call('POST', '/api/join', { name, age: true }, '', door);
  const cookie = cookieOf(r);
  pages.push({ name, cookie, door, ...(await connect(cookie, false, door)) });
}
const watch = await connect(adminCookie, true);
await sleep(1500);

// Who may ask.
ok('no session: refused', (await call('GET', '/api/host')).r.status === 401);
ok('no session, ?addresses=1: refused', (await call('GET', '/api/host?addresses=1')).r.status === 401);
const asGuest = await call('GET', '/api/host?addresses=1', null, pages[0].cookie);
ok('a guest: refused', (await call('GET', '/api/host', null, pages[0].cookie)).r.status === 403);
ok('a guest, ?addresses=1: refused, no address in the answer', asGuest.r.status === 403 && !('players' in (asGuest.data ?? {})), `(${asGuest.r.status})`);

// What the admin sees.
const plain = await call('GET', '/api/host', null, adminCookie);
const people = (v) => [...(v?.players ?? []), ...(v?.away ?? [])];
ok('the plain view (the watch page reads it): no address', people(plain.data).length > 0 && people(plain.data).every((p) => !('ip' in p)) && !forged(plain.text));
const roster = await call('GET', '/api/players', null, adminCookie);
ok('the admin panel\'s list: no address', !forged(roster.text) && (roster.data?.players ?? []).every((p) => !('ip' in p)));
const full = await call('GET', '/api/host?addresses=1', null, adminCookie);
const mine = people(full.data).filter((p) => pages.some((g) => g.name === p.name));
/** Whether `ip` is the address a connection to `door` comes from: the door's own (this computer), localhost any loopback. */
const from = (ip, door) => {
  const h = new URL(door).hostname.replace(/^\[|\]$/g, '');
  return h === 'localhost' ? ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip) : ip === h || ip === `::ffff:${h}`;
};
ok('the host\'s view: every guest with an address', mine.length === pages.length && mine.every((p) => typeof p.ip === 'string' && p.ip), `(${mine.map((p) => p.ip).join(', ')})`);
ok('the address is where the connection came from, never a forged one', !forged(full.text) && pages.every((g) => from(mine.find((p) => p.name === g.name)?.ip, g.door)));
ok('with since when', mine.every((p) => Number.isFinite(p.since) && p.since <= Date.now() && Date.now() - p.since < 120_000));

// What the pages were sent.
const seen = [...new Set(mine.map((p) => p.ip))];
const leaked = (got) => got.filter((s) => forged(s) || seen.some((ip) => s.includes(ip)));
ok('no player\'s page was sent an address', pages.every((g) => g.got.length > 2 && !leaked(g.got).length), `(${pages.map((g) => g.got.length).join('/')} messages)`);
ok('the watch view was sent no address', watch.got.length > 2 && !leaked(watch.got).length, `(${watch.got.length} messages)`);

if (Number(o.hold) > 0) {
  console.log(`     holding the guests ${o.hold} s`);
  await sleep(Number(o.hold) * 1000);
}
for (const g of [...pages, watch]) g.ws.close();
await sleep(300);
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
