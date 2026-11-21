// Who has a bad connection on the host page (server/hostLink.mjs, GET /api/host?links=1), against a throwaway game server
// on this computer. Scripted guests join, each with a connection of its own kind, made in this script:
//
//   good     answers everything at once
//   fair     answers the WebSocket pings 80 ms late (and the game's)
//   poor     170 ms late
//   bad      400 ms late
//   jitter   0 to 200 ms late, at random
//   device   answers the WebSocket pings at once but the game's 160 ms late (a phone whose frames are long)
//   wifi     stops reading for 5 s every 10 s (bad Wi-Fi: both kinds of ping wait)
//   never    never answers a WebSocket ping (the game's at once)
//
// A browser answers WebSocket pings by itself and no page script can delay that: this Node client turns the automatic
// answer off (ws's autoPong) to play a slow network, and answers the game's own ping late to play a slow device.
// Checked: GET /api/host?links=1 is refused without a session (401) and for a guest (403); the plain view (the watch
// page reads it) carries nothing of the connections; the admin's ?links=1 view grades each kind as expected.
// --hold <s>: the guests stay connected that long at the end (for pictures of the host page). --kinds a,b,c: which.
//
//   ADMIN_PASSWORD=... node tools/dev/host_links_check.mjs --api http://localhost:8580 [--hold 0] [--wait 16]
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { localOnly, options } from './cdp.mjs';

const o = options({ api: 'http://localhost:8580', hold: '0', wait: '16', kinds: 'good,fair,poor,bad,jitter,device,wifi,never' });
localOnly(o.api); // it logs in as the admin: a throwaway server on this computer only
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');

// Each kind: how late it answers the WebSocket's pings (ms, null: never) and the game's; and what the host should see.
const KINDS = {
  good: { ws: () => 0, game: 0, want: (l) => l.grade === 0 && l.slow === 'none' },
  fair: { ws: () => 80, game: 80, want: (l) => l.grade === 1 },
  poor: { ws: () => 170, game: 170, want: (l) => l.grade === 2 && l.slow === 'network' },
  bad: { ws: () => 400, game: 400, want: (l) => l.grade === 3 && l.slow === 'network' },
  // The jitter is smoothed by 1/16 a ping (RFC 3550): it takes about a minute to reach its full size, the mean less.
  jitter: { ws: () => Math.random() * 200, game: 0, want: (l) => l.grade >= 1 && l.jitter > 10 },
  device: { ws: () => 0, game: 160, want: (l) => l.grade === 0 && l.slow === 'device' },
  wifi: { ws: () => 0, game: 0, pause: true, want: (l) => l.grade >= 2 && l.missed >= 1 },
  never: { ws: () => null, game: 0, want: (l) => l.grade === 3 && l.rtt === null },
};
const kinds = o.kinds.split(',').filter((k) => KINDS[k]);

let failed = 0;
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
  if (!pass) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (method, path, body, cookie = '') => {
  const r = await fetch(o.api + path, { method, headers: { 'Content-Type': 'application/json', Origin: o.api, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
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

/** A guest's page of `kind`: its WebSocket pings and the game's answered as that kind does. */
const connect = async (cookie, kind) => {
  const k = KINDS[kind];
  const ws = new WebSocket(`${o.api.replace(/^http/, 'ws')}/ws?v=2`, { headers: { Cookie: cookie, Origin: o.api }, autoPong: false });
  ws.on('ping', (data) => {
    const ms = k.ws();
    if (ms === null) return;
    setTimeout(() => ws.readyState === ws.OPEN && ws.pong(data), ms);
  });
  ws.on('message', (d) => {
    try {
      const m = JSON.parse(String(d));
      if (m.t === 'ping') setTimeout(() => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'pong', n: m.n })), k.game);
    } catch {
      // a binary tick
    }
  });
  await new Promise((res) => (ws.on('open', res), ws.on('error', res)));
  let timer = null;
  if (k.pause) {
    // Bad Wi-Fi: nothing read for 5 s of every 10 (what comes in waits, the pings too).
    timer = setInterval(() => {
      ws.pause();
      setTimeout(() => ws.resume(), 5000);
    }, 10_000);
    timer.unref();
  }
  return { ws, stop: () => clearInterval(timer) };
};

const run = Math.random().toString(36).slice(2, 5);
const pages = [];
for (const kind of kinds) {
  await call('POST', '/api/lockouts', {}, adminCookie); // every guest joins from this one computer: its limit lifted
  const name = `${kind}${run}`;
  const { r } = await call('POST', '/api/join', { name, age: true }, '');
  const cookie = cookieOf(r);
  pages.push({ name, kind, cookie, ...(await connect(cookie, kind)) });
}
console.log(`     ${pages.length} guests in, waiting ${o.wait} s for their pings`);
await sleep(Number(o.wait) * 1000);

// Who may ask.
ok('no session, ?links=1: refused', (await call('GET', '/api/host?links=1')).r.status === 401);
const asGuest = await call('GET', '/api/host?links=1', null, pages[0].cookie);
ok('a guest, ?links=1: refused, nothing in the answer', asGuest.r.status === 403 && !('players' in (asGuest.data ?? {})), `(${asGuest.r.status})`);

// What the admin sees.
const people = (v) => [...(v?.players ?? []), ...(v?.away ?? [])];
const plain = await call('GET', '/api/host', null, adminCookie);
ok('the plain view (the watch page reads it): no connection numbers', people(plain.data).length > 0 && people(plain.data).every((p) => !('link' in p)) && !('load' in plain.data) && !/"(jitter|reconnects)"/.test(plain.text));
const full = await call('GET', '/api/host?links=1', null, adminCookie);
ok('the host\'s view: the server\'s own state', typeof full.data?.load?.busy === 'boolean', `(busy: ${full.data?.load?.busy})`);
for (const g of pages) {
  const l = people(full.data).find((p) => p.name === g.name)?.link;
  const say = l ? `grade ${l.grade} · ${l.rtt ?? '–'} ms now · mean ${l.mean ?? '–'} · jitter ${l.jitter ?? '–'} · missed ${l.missed} · game ${l.ping ?? '–'} ms · ${l.slow}` : 'nothing';
  ok(`${g.kind.padEnd(6)} shows as expected`, !!l && KINDS[g.kind].want(l), `(${say})`);
}

if (Number(o.hold) > 0) {
  console.log(`     holding the guests ${o.hold} s`);
  await sleep(Number(o.hold) * 1000);
}
for (const g of pages) {
  g.stop();
  g.ws.terminate();
}
await sleep(300);
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
