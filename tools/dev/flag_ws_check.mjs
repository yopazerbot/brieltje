// Steal the flag (server/flags.mjs) against a throwaway game server (a build of this branch on this computer): four
// guests, two a side by the host's evening teams, and the admin. The game starts from the menu's message and from the
// host's programme; every flag event comes from where the server has the players, never from a message: a forged
// capture and a team switch are refused; the admin brings a red player onto blue's stand and the flag is taken; the
// carrier is refused a trip from the chat and a helicopter seat; the carrier walks home and scores; a carrier who leaves
// drops it, blue touches it and it is home; a late joiner gets a team at its base; the village field parks its cars,
// bikes and (look 'real') red's helicopter, and takes them away when it is over.
//
//   ADMIN_PASSWORD=... node tools/dev/flag_ws_check.mjs --api http://localhost:8473
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { localOnly, options } from './cdp.mjs';
import { FIELDS } from '../../web/shared/flagFields.mjs';

const o = options({ api: 'http://localhost:8473' });
localOnly(o.api); // it logs in as the admin and starts games: a throwaway server on this computer only
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');
const host = new URL(o.api).host;
let failed = 0;
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
  if (!pass) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (method, path, body, cookie = '') => {
  const r = await fetch(o.api + path, { method, headers: { 'Content-Type': 'application/json', Origin: o.api, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  return { r, data: await r.json().catch(() => null) };
};
const cookieOf = (r) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const adminCookie = cookieOf((await call('POST', '/api/login', { username: 'admin', password })).r);
const act = async (b) => call('POST', '/api/host', b, adminCookie);

/** A connection: its messages, where the server last put it (`at`), and a walk there and back in honest steps. */
const connect = async (name, cookie) => {
  const log = [];
  const ws = new WebSocket(`ws://${host}/ws?v=2`, { headers: { Cookie: cookie, Origin: o.api } });
  const c = { name, ws, log, at: null, send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)), of: (t) => log.filter((m) => m.t === t) };
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    log.push(m);
    if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', n: m.n }));
    if (m.t === 'respawn' && m.name === name && typeof m.x === 'number') c.at = { x: m.x, y: typeof m.y === 'number' ? m.y : c.at?.y ?? 0, z: m.z };
    if (m.t === 'travel' && m.name === name && m.ok) c.at = null; // the trip's end: set by the caller
  });
  await new Promise((res) => (ws.on('open', res), ws.on('error', res)));
  await sleep(400);
  return c;
};
const guest = async (name) => {
  await call('POST', '/api/lockouts', {}, adminCookie); // every guest joins from this one address: its limit lifted
  const { r, data } = await call('POST', '/api/join', { name, age: true });
  if (!r.ok) console.log(`     ${name} could not join: ${r.status} ${data?.code ?? ''}`);
  return connect(name, cookieOf(r));
};
const state = (c, p) => {
  c.at = { ...p };
  c.send({ t: 'state', x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), yaw: 0, pitch: 0, armed: true, w: 'pistol' });
};
/** Walk `c` from where it is to (x, y, z) at `speed` m/s (a sprint is 3.5), ten steps a second. */
const walk = async (c, x, y, z, speed = 3.4) => {
  const from = { ...c.at };
  const n = Math.max(1, Math.ceil(Math.hypot(x - from.x, z - from.z) / (speed / 10)));
  for (let i = 1; i <= n; i++) {
    state(c, { x: from.x + ((x - from.x) * i) / n, y: from.y + ((y - from.y) * i) / n, z: from.z + ((z - from.z) * i) / n });
    await sleep(100);
  }
};
const flagEvents = (c) => c.of('flag').map((m) => `${m.ev}:${m.team}:${m.name}`);
const lastMode = (c) => c.of('mode').at(-1)?.mode;

await call('POST', '/api/lockouts', {}, adminCookie);
await act({ op: 'reset' });
await act({ op: 'lock', on: false });
await act({ op: 'limit', max: 32 });
const admin = await connect('admin', adminCookie);
admin.send({ t: 'rules', portals: true, travel: true, heli: true }); // the house rules a carrier's refusals are tested under
state(admin, { x: 4.5, y: -0.1, z: 14 });
const run = Math.random().toString(36).slice(2, 6); // a guest's name is kept for the day: fresh ones each run
const names = ['a', 'b', 'c', 'd'].map((k) => `fl${k}${run}`);
const players = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await guest(n)])));
await act({ op: 'teams', count: 2 });
await sleep(500);
const sides = admin.of('eveningteams').at(-1)?.teams ?? {};
ok('four guests and the admin are in', names.every((n) => players[n].of('welcome').length) && !!admin.of('welcome').length);

// Started from the menu (the admin's message): the compact field.
admin.send({ t: 'mode', kind: 'flag', place: 'compact' });
await sleep(1200);
const v = lastMode(players[names[0]]);
ok('the game is on for every page, with its field and both flags home', names.every((n) => lastMode(players[n])?.kind === 'flag') && v?.flag?.field === 'compact' && v.flag.flags.blue.at === 'home' && v.flag.flags.red.at === 'home');
const team = (n) => lastMode(players[names[0]])?.teams?.[n];
const blue = names.filter((n) => team(n) === 'blue');
const red = names.filter((n) => team(n) === 'red');
ok('two a side, as the host\'s evening teams (the first blue)', blue.length === 2 && red.length === 2 && names.every((n) => sides[n] === team(n)), JSON.stringify({ blue, red, sides }));
for (const n of names) {
  const [sx, sz] = FIELDS.compact.bases[team(n)].stand;
  const at = players[n].at;
  ok(`${n} starts at the ${team(n)} base`, !!at && Math.hypot(at.x - sx, at.z - sz) < 15, at ? `${at.x}, ${at.z}` : 'no respawn');
}
// Nobody claims a flag, or switches under the host's teams.
const [r1, r2] = red.map((n) => players[n]);
const [b1] = blue.map((n) => players[n]);
r1.send({ t: 'flag', ev: 'captured', team: 'blue' });
r1.send({ t: 'flag', op: 'take', team: 'blue' });
r1.send({ t: 'team', team: 'blue' });
await sleep(600);
ok('a forged capture or take changes nothing', !flagEvents(b1).length && lastMode(b1)?.score?.red === 0);
ok('switching team is refused under the host\'s teams', r1.of('system').some((m) => m.code === 'hostTeams') && team(r1.name) === 'red');

// The admin on blue's stand brings a red player: on the stand, they take the flag (the server's own positions).
const [bx, bz, by] = FIELDS.compact.bases.blue.stand;
admin.send({ t: 'travel', to: 'church', via: 'chat' });
await sleep(600);
const church = admin.of('travel').at(-1);
ok('the admin travels to the church', !!church?.ok);
state(admin, { x: 536.3, y: by, z: -771.6 });
await sleep(150);
for (let i = 1; i <= 6; i++) {
  state(admin, { x: 536.3 + ((bx - 536.3) * i) / 6, y: by, z: -771.6 + ((bz + 771.6) * i) / 6 });
  await sleep(120);
}
await act({ op: 'bring', name: r1.name });
await sleep(900);
ok('brought onto blue\'s stand, red takes the blue flag; every page is told', names.every((n) => flagEvents(players[n]).includes(`taken:blue:${r1.name}`)), JSON.stringify(flagEvents(b1)));
ok('the mode says who carries it', lastMode(b1)?.flag?.flags.blue.by === r1.name);
// The carrier: no trip from the chat, no portal, no helicopter.
r1.send({ t: 'travel', to: 'molenhoek', via: 'chat' });
r1.send({ t: 'heli', op: 'in', id: 'church' });
await sleep(700);
ok('the carrier is refused a trip from the chat, with a line', r1.of('travel').some((m) => !m.ok && m.code === 'flagTravel'));
ok('the carrier is refused a helicopter seat, with a line', r1.of('system').some((m) => m.code === 'flagHeli'));
// Home on foot, in honest steps: a capture, with red's own flag home.
const [rx, rz, ry] = FIELDS.compact.bases.red.stand;
const t0 = Date.now();
await walk(r1, rx, ry, rz);
await sleep(600);
console.log(`     the walk home took ${((Date.now() - t0) / 1000).toFixed(0)} s`);
ok('home at red\'s stand: captured, a point for red', flagEvents(b1).includes(`captured:blue:${r1.name}`) && lastMode(b1)?.score?.red === 1, JSON.stringify(lastMode(b1)?.score));
ok('the blue flag is back on its stand', lastMode(b1)?.flag?.flags.blue.at === 'home');

// A second red player takes it and leaves: it drops where they were; blue touches it and it is home.
await act({ op: 'bring', name: r2.name });
await sleep(900);
ok('the second red player takes it', flagEvents(b1).includes(`taken:blue:${r2.name}`));
// The admin plays too (on the smaller team, blue here): out of the way first, so the flag lies until blue comes.
const adminTeam = team('admin');
for (let i = 1; i <= 4; i++) {
  state(admin, { x: bx + 3 * i, y: by, z: bz });
  await sleep(120);
}
await sleep(300);
r2.ws.close();
await sleep(900);
const dropped = lastMode(b1)?.flag?.flags.blue;
ok('leaving the game drops it there', flagEvents(b1).includes(`dropped:blue:${r2.name}`) && dropped?.at === 'ground', JSON.stringify(dropped));
ok('on the ground, every page sees it go home by itself in 30 s', dropped?.ms > 28_000 && dropped.ms <= 30_000, String(dropped?.ms));
// Blue touches it (the blue player brought next to it by the admin, who is blue too here or stands off).
for (let i = 1; i <= 4; i++) {
  state(admin, { x: bx + 12 + ((dropped.x - bx - 12) * i) / 4, y: by, z: bz + ((dropped.z - bz) * i) / 4 });
  await sleep(120);
}
await act({ op: 'bring', name: b1.name });
await sleep(900);
const returner = flagEvents(b1).find((e) => e.startsWith('returned:blue:'))?.split(':')[2];
ok('blue touches its own flag on the ground: home at once', !!returner && (returner === b1.name || (returner === 'admin' && adminTeam === 'blue')) && lastMode(b1)?.flag?.flags.blue.at === 'home', JSON.stringify(flagEvents(b1).slice(-3)));
// A late joiner: a team, at its base.
const late = await guest(`fle${run}`);
await sleep(900);
const lt = lastMode(late)?.teams?.[late.name];
const [lx, lz] = lt ? FIELDS.compact.bases[lt].stand : [0, 0];
ok('a late joiner gets a team and starts at its base', !!lt && !!late.at && Math.hypot(late.at.x - lx, late.at.z - lz) < 15, `${lt} ${JSON.stringify(late.at)}`);
admin.send({ t: 'mode', kind: 'free' });
await sleep(800);
ok('stopped: free play again', lastMode(b1)?.kind === 'free');

// The village field from the host's programme, played for real: its cars, bikes and red's helicopter; gone after.
await act({ op: 'start', kind: 'flag', place: 'village', look: 'real', minutes: 15 });
await sleep(11_500);
const vv = lastMode(b1);
ok('the village field from the programme, 15 minutes, look real', vv?.kind === 'flag' && vv.flag?.field === 'village' && vv.look === 'real' && vv.ms > 14 * 60_000);
const teslas = b1.of('teslas').at(-1)?.list ?? [];
ok('its cars parked: three a side, in the team\'s colour', teslas.filter((c) => c.flag && c.kind === 'modelY-blue').length === 3 && teslas.filter((c) => c.flag && c.kind === 'modelY-red').length === 3);
ok('its bikes parked: nine a side', (vv.flag?.vehicles?.bikes ?? []).length === 18);
const heliSpot = FIELDS.village.vehicles.heli;
const heli = b1.of('heli').filter((m) => m.heli?.id === heliSpot.id).at(-1)?.heli;
ok('red\'s helicopter set down at the Sparrenhof', !!heli && Math.hypot(heli.x - heliSpot.x, heli.z - heliSpot.z) < 1, heli ? `${heli.x}, ${heli.z}` : 'none');
await act({ op: 'stop' });
await sleep(800);
const after = b1.of('teslas').at(-1)?.list ?? [];
const home = b1.of('heli').filter((m) => m.heli?.id === heliSpot.id).at(-1)?.heli;
ok('stopped: its cars gone, the helicopter back on its own pad', !after.some((c) => c.flag) && !!home && Math.hypot(home.x - heliSpot.x, home.z - heliSpot.z) > 100);

for (const c of [admin, late, ...Object.values(players)]) c.ws.close();
await act({ op: 'teams', count: 0 });
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
