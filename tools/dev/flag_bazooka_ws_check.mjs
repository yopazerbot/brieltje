// Steal the flag's helicopters and bazookas (server/flags.mjs park, server/flagBazooka.mjs) against a throwaway game
// server (a build of this branch on this computer): four guests, two a side by the host's evening teams, and the admin.
// The compact field from the host's programme in the paint look: both machines at their spots (blue the church's on its
// deck, red the house's on Molenhoek's road), a red player walks to red's and gets a seat; a red player walks to blue's
// rack and gets nothing; a blue player walks into it and gets the launcher, their teammate a line, red none; three
// rockets go, a fourth is refused, the launcher is out of their hands and back on the rack 45 s later; the admin's own
// bazooka is out of their hands during the game and back after it; then the village field's machines at theirs.
//
//   ADMIN_PASSWORD=... node tools/dev/flag_bazooka_ws_check.mjs --api http://localhost:8473
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

const connect = async (name, cookie) => {
  const log = [];
  const ws = new WebSocket(`ws://${host}/ws?v=2`, { headers: { Cookie: cookie, Origin: o.api } });
  const c = { name, ws, log, at: null, w: 'pistol', send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)), of: (t) => log.filter((m) => m.t === t) };
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    log.push(m);
    if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', n: m.n }));
    if (m.t === 'respawn' && m.name === name && typeof m.x === 'number') c.at = { x: m.x, y: typeof m.y === 'number' ? m.y : c.at?.y ?? 0, z: m.z };
  });
  await new Promise((res) => (ws.on('open', res), ws.on('error', res)));
  await sleep(400);
  return c;
};
const guest = async (name) => {
  await call('POST', '/api/lockouts', {}, adminCookie);
  const { r, data } = await call('POST', '/api/join', { name, age: true });
  if (!r.ok) console.log(`     ${name} could not join: ${r.status} ${data?.code ?? ''}`);
  return connect(name, cookieOf(r));
};
const state = (c, p) => {
  c.at = { ...p };
  c.send({ t: 'state', x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), yaw: 0, pitch: 0, armed: true, w: c.w });
};
/** Walk `c` from where it is to (x, y, z) at `speed` m/s, ten steps a second. */
const walk = async (c, x, y, z, speed = 3.4) => {
  const from = { ...c.at };
  const n = Math.max(1, Math.ceil(Math.hypot(x - from.x, z - from.z) / (speed / 10)));
  for (let i = 1; i <= n; i++) {
    state(c, { x: from.x + ((x - from.x) * i) / n, y: from.y + ((y - from.y) * i) / n, z: from.z + ((z - from.z) * i) / n });
    await sleep(100);
  }
};
const lastMode = (c) => c.of('mode').at(-1)?.mode;
const weapons = (c) => c.of('weapons').at(-1)?.list ?? [];
/** Where `c`'s page has machine `id` last (the welcome's list, then every 'heli' message). */
const heliAt = (c, id) => [...(c.of('welcome').at(-1)?.helis ?? []).filter((h) => h.id === id), ...c.of('heli').map((m) => m.heli).filter((h) => h?.id === id)].at(-1);
const PADS = { church: { x: 512.54, z: -750.51 } }; // shared/heli.json's church machine

await call('POST', '/api/lockouts', {}, adminCookie);
await act({ op: 'reset' });
await act({ op: 'lock', on: false });
await act({ op: 'limit', max: 32 });
const admin = await connect('admin', adminCookie);
admin.send({ t: 'rules', heli: true });
state(admin, { x: 4.5, y: -0.1, z: 14 });
const run = Math.random().toString(36).slice(2, 6);
const names = ['a', 'b', 'c', 'd'].map((k) => `fz${k}${run}`);
const players = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await guest(n)])));
await act({ op: 'teams', count: 2 });
await sleep(500);
ok('four guests and the admin are in', names.every((n) => players[n].of('welcome').length) && !!admin.of('welcome').length);
ok('the admin starts with the bazooka', weapons(admin).includes('bazooka'), JSON.stringify(weapons(admin)));

// The compact field, from the programme, in the paint look.
await act({ op: 'start', kind: 'flag', place: 'compact', look: 'paint', minutes: 15 });
await sleep(11_500);
const v = lastMode(players[names[0]]);
ok('the compact field from the programme, look paint', v?.kind === 'flag' && v.flag?.field === 'compact' && v.look === 'paint');
ok('both racks on every page', v?.flag?.racks?.blue?.at === 'rack' && v.flag.racks.red?.at === 'rack', JSON.stringify(v?.flag?.racks));
const team = (n) => lastMode(players[names[0]])?.teams?.[n];
const blue = names.filter((n) => team(n) === 'blue').map((n) => players[n]);
const red = names.filter((n) => team(n) === 'red').map((n) => players[n]);
ok('two a side', blue.length === 2 && red.length === 2);
const [b1, b2] = blue;
const [r1, r2] = red;
await sleep(300);
ok('the admin\'s own bazooka is out of their hands', !weapons(admin).includes('bazooka'), JSON.stringify(weapons(admin)));
const church = heliAt(b1, 'church');
const house = heliAt(b1, 'house');
const spot = FIELDS.compact.heli.red;
ok('blue\'s helicopter on the church\'s deck', !!church && Math.hypot(church.x - PADS.church.x, church.z - PADS.church.z) < 1, church ? `${church.x}, ${church.z}` : 'none');
ok('red\'s helicopter on Molenhoek\'s road by its base', !!house && Math.hypot(house.x - spot.x, house.z - spot.z) < 0.5, house ? `${house.x}, ${house.y}, ${house.z}` : 'none');

// Red walks to its machine and gets in: a seat in the compact field, paint look.
await walk(r1, spot.x + 1.4, spot.y, spot.z);
r1.send({ t: 'heli', op: 'in', id: 'house' });
await sleep(800);
const seated = r1.of('heli').map((m) => m.heli).filter((h) => h?.id === 'house').at(-1);
ok('red gets a seat in its machine', !!seated?.seats?.includes(r1.name), JSON.stringify(seated?.seats));
ok('no refusal line', !r1.of('system').some((m) => ['gameNoHeli', 'flagHeli', 'heliOff', 'heliFight'].includes(m.code)), JSON.stringify(r1.of('system').map((m) => m.code)));
r1.send({ t: 'heli', op: 'out' });
await sleep(500);

// Red walks to blue's rack (the whole field, about a minute): nothing.
const [bx, bz, by] = FIELDS.compact.bases.blue.rack;
const t0 = Date.now();
await walk(r2, bx, by, bz);
await sleep(800);
console.log(`     red's walk to blue's rack took ${((Date.now() - t0) / 1000).toFixed(0)} s`);
ok('red at blue\'s rack: refused', !weapons(r2).includes('bazooka') && !r2.of('fbz').length && lastMode(b1)?.flag?.racks?.blue?.at === 'rack');
state(r2, { x: bx + 12, y: by, z: bz }); // out of the way
await sleep(300);

// Blue walks into its rack.
await walk(b1, bx + 0.3, by, bz);
await sleep(800);
ok('blue walks into its rack: the launcher', weapons(b1).includes('bazooka') && b1.of('fbz').some((m) => m.ev === 'taken' && m.name === b1.name), JSON.stringify(b1.of('fbz')));
ok('three rockets', b1.of('fbz').filter((m) => m.ev === 'left').at(-1)?.n === 3);
ok('their teammate gets the line', b2.of('fbz').some((m) => m.ev === 'taken' && m.name === b1.name && m.team === 'blue'));
ok('the other team gets none', !r1.of('fbz').length && !r2.of('fbz').length);
ok('the rack is out on every page', lastMode(r1)?.flag?.racks?.blue?.at === 'out');
// Three rockets, the reload between them; a fourth refused.
b1.w = 'bazooka';
state(b1, { ...b1.at, x: b1.at.x + 3 });
await sleep(200);
const rockets = () => b2.of('rocket').filter((m) => m.name === b1.name).length;
for (let i = 0; i < 4; i++) {
  b1.send({ t: 'rocket', tx: b1.at.x + 40, ty: b1.at.y + 2, tz: b1.at.z });
  await sleep(3200);
}
ok('three rockets went, the fourth was refused', rockets() === 3, String(rockets()));
ok('the rockets left counted down to none', JSON.stringify(b1.of('fbz').filter((m) => m.ev === 'left').map((m) => m.n)) === '[3,2,1,0]');
ok('the empty launcher is out of their hands', !weapons(b1).includes('bazooka'));
const away = lastMode(b2)?.flag?.racks?.blue;
ok('the rack counts down from 45 s', away?.at === 'out' && away.ms > 35_000 && away.ms <= 45_000, JSON.stringify(away));
b1.w = 'pistol';
state(b1, { ...b1.at, x: b1.at.x + 10 }); // off the rack
await sleep((away?.ms ?? 45_000) + 1500);
ok('back on the rack after 45 s', lastMode(b2)?.flag?.racks?.blue?.at === 'rack', JSON.stringify(lastMode(b2)?.flag?.racks));

await act({ op: 'stop' });
await sleep(800);
ok('stopped: the racks gone', !lastMode(b1)?.flag?.racks);
ok('the admin\'s own bazooka is back', weapons(admin).includes('bazooka'), JSON.stringify(weapons(admin)));
const home = heliAt(b1, 'house');
ok('red\'s machine back on the house\'s pad', !!home && Math.hypot(home.x - spot.x, home.z - spot.z) > 100);

// The village field, no look: both machines at theirs.
await act({ op: 'start', kind: 'flag', place: 'village', minutes: 15 });
await sleep(11_500);
const vspot = FIELDS.village.heli.red;
const vh = heliAt(b1, 'house');
const vc = heliAt(b1, 'church');
ok('village field: red\'s at the Sparrenhof, blue\'s on the church\'s deck', !!vh && Math.hypot(vh.x - vspot.x, vh.z - vspot.z) < 0.5 && !!vc && Math.hypot(vc.x - PADS.church.x, vc.z - PADS.church.z) < 1);
await act({ op: 'stop' });
await sleep(800);

for (const c of [admin, ...Object.values(players)]) c.ws.close();
await act({ op: 'teams', count: 0 });
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
