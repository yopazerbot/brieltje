// Steal the flag's guards (server/flagGuards.mjs) against a throwaway game server (a build of this branch on this
// computer): the admin and two guests, one a side. A guest's page can't set guards, the admin's forged values are
// refused; on each field the admin sets three guards a team, every page sees them join in their team's colour; the admin
// walks to each base in turn and brings the other team's guest there: the guest shoots a guard down through the hit
// path, the guard is back 5 s later, and the guards' fire takes the guest's health; the guards go when the game stops.
//
//   ADMIN_PASSWORD=... node tools/dev/guards_ws_check.mjs --api http://localhost:8473
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
  const c = { name, ws, log, at: null, send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)), of: (t) => log.filter((m) => m.t === t) };
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
let guestCookie = '';
const guest = async (name) => {
  await call('POST', '/api/lockouts', {}, adminCookie);
  const { r, data } = await call('POST', '/api/join', { name, age: true });
  if (!r.ok) console.log(`     ${name} could not join: ${r.status} ${data?.code ?? ''}`);
  guestCookie ||= cookieOf(r);
  return connect(name, cookieOf(r));
};
const state = (c, p, w = 'rifle', flying = false) => {
  c.at = { ...p };
  c.send({ t: 'state', x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), yaw: 0, pitch: 0, armed: true, w, flying });
};
/** The admin (allowed to move very fast, and to fly over the hills on the way) goes to (x, y, z) in steps of 20 m, ten a second. */
const fly = async (c, x, y, z) => {
  const from = { ...c.at };
  const n = Math.max(1, Math.ceil(Math.hypot(x - from.x, z - from.z) / 20));
  for (let i = 1; i <= n; i++) {
    state(c, { x: from.x + ((x - from.x) * i) / n, y: from.y + ((y - from.y) * i) / n + (i < n ? 15 : 0), z: from.z + ((z - from.z) * i) / n }, 'pistol', i < n);
    await sleep(100);
  }
  await sleep(200);
  state(c, { x, y, z }, 'pistol');
};
const lastMode = (c) => c.of('mode').at(-1)?.mode;
const until = async (f, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (f()) return true;
  return f();
};

await call('POST', '/api/lockouts', {}, adminCookie);
await act({ op: 'reset' });
await act({ op: 'lock', on: false });
await act({ op: 'teams', count: 0 });
const admin = await connect('admin', adminCookie);
state(admin, { x: 4.5, y: -0.1, z: 14 }, 'pistol');
const run = Math.random().toString(36).slice(2, 6);
const g1 = await guest(`ga${run}`);
const g2 = await guest(`gb${run}`);
ok('two guests and the admin are in', !!g1.of('welcome').length && !!g2.of('welcome').length && !!admin.of('welcome').length);

// Only the admin, only sound values.
const asGuest = await call('POST', '/api/host', { op: 'guards', team: 'blue', count: 6, skill: 'hard' }, guestCookie);
ok('a guest\'s page can\'t set guards', asGuest.r.status === 401 || asGuest.r.status === 403, String(asGuest.r.status));
const anon = await call('POST', '/api/host', { op: 'guards', team: 'blue', count: 6, skill: 'hard' });
ok('nor can a page without a session', anon.r.status === 401 || anon.r.status === 403, String(anon.r.status));
g1.send({ t: 'guards', team: 'blue', count: 6, skill: 'hard' }); // no such message from a page
let refused = 0;
for (const b of [{ team: '__proto__', count: 1, skill: 'easy' }, { team: 'blue', count: 1.5, skill: 'easy' }, { team: 'blue', count: '3', skill: 'easy' }, { team: 'blue', count: -1, skill: 'easy' },
  { team: 'blue', count: 7, skill: 'easy' }, { team: 'blue', count: [3], skill: 'easy' }, { team: 'blue', count: 3, skill: 'expert' }, { team: ['red'], count: 3, skill: 'easy' }]) {
  const { r, data } = await act({ op: 'guards', ...b });
  if (r.status === 400 && data?.code === 'badValue') refused++;
  await sleep(220);
}
ok('the admin\'s forged values are refused', refused === 8, `${refused} of 8`);
const before = (await call('GET', '/api/host', null, adminCookie)).data?.guards;
ok('still off: none set', before?.blue?.count === 0 && before?.red?.count === 0, JSON.stringify(before));

for (const field of ['compact', 'village']) {
  await act({ op: 'guards', team: 'blue', count: 3, skill: 'easy' });
  await sleep(250);
  await act({ op: 'guards', team: 'red', count: 3, skill: 'easy' });
  await sleep(250);
  admin.send({ t: 'mode', kind: 'flag', place: field });
  await sleep(1500);
  const teams = lastMode(g1)?.teams ?? {};
  const names = ['Blue guard 1', 'Blue guard 2', 'Blue guard 3', 'Red guard 1', 'Red guard 2', 'Red guard 3'];
  ok(`${field}: six guards join, every page told`, names.every((n) => g1.of('join').some((m) => m.name === n) && g2.of('join').some((m) => m.name === n)));
  const colors = g1.of('colors').at(-1)?.list ?? [];
  ok(`${field}: in their team's colour, on their team`, names.every((n) => colors.find((c) => c.name === n)?.color === (n.startsWith('Blue') ? '#4fa3e0' : '#e5484d') && teams[n] === (n.startsWith('Blue') ? 'blue' : 'red')), JSON.stringify(colors.filter((c) => / guard /.test(c.name))));
  const hv = (await call('GET', '/api/host', null, adminCookie)).data;
  ok(`${field}: not among the host's people, counted on their own`, !hv.players.some((p) => / guard /.test(p.name)) && hv.guards.blue.here === 3 && hv.guards.red.here === 3);
  const roster = (await call('GET', '/api/players', null, adminCookie)).data?.players ?? [];
  ok(`${field}: not in the admin's online list`, !roster.some((p) => / guard /.test(p.name)));
  await sleep(3200); // the guards' protection over

  for (const base of ['blue', 'red']) {
    const visitor = [g1, g2].find((c) => teams[c.name] && teams[c.name] !== base);
    if (!visitor) {
      ok(`${field}: a guest on the team against ${base}`, false, JSON.stringify(teams));
      continue;
    }
    const b = FIELDS[field].bases[base];
    const [sx, sz, sy] = b.spawns[0];
    await fly(admin, sx, sy, sz);
    await sleep(300);
    const guard = `${base === 'blue' ? 'Blue' : 'Red'} guard 1`;
    const k0 = visitor.log.length;
    await act({ op: 'bring', name: visitor.name });
    await until(() => visitor.log.slice(k0).some((m) => m.t === 'respawn' && m.name === visitor.name), 3000);
    state(visitor, visitor.at);
    // Shoot guard 1 down: four rifle hits, the rifle's clock between them.
    for (let i = 0; i < 4; i++) {
      visitor.send({ t: 'hit', target: guard, w: 'rifle', body: 1, head: 0 });
      await sleep(160);
    }
    const down = await until(() => visitor.log.slice(k0).some((m) => m.t === 'kill' && m.victim === guard && m.killer === visitor.name), 2000);
    ok(`${field} at ${base}'s base: ${visitor.name} shoots ${guard} down`, down);
    const tk = Date.now();
    const back = await until(() => visitor.log.slice(k0).some((m) => m.t === 'respawn' && m.name === guard), 8000);
    ok(`${field} at ${base}'s base: ${guard} is back`, back, back ? `after ${((Date.now() - tk) / 1000).toFixed(1)} s` : '');
    // The guards' fire (standing still, armed, in their sight): health lost, by a guard.
    const hurt = await until(() => visitor.log.slice(k0).some((m) => (m.t === 'hurt' && / guard /.test(m.by)) || (m.t === 'kill' && m.victim === visitor.name && / guard /.test(m.killer))), 10_000);
    const by = visitor.log.slice(k0).find((m) => m.t === 'hurt' && / guard /.test(m.by))?.by;
    ok(`${field} at ${base}'s base: the guards' fire takes ${visitor.name}'s health`, hurt, by ? `first hit by ${by}` : `at ${Math.round(Math.hypot(visitor.at.x - b.stand[0], visitor.at.z - b.stand[1]))} m from the stand`);
    ok(`${field} at ${base}'s base: everyone hears the guards' shots`, admin.log.slice(-400).some((m) => m.t === 'shot' && / guard /.test(m.name) && m.w === 'rifle'));
    await sleep(6000); // back at its own base
  }
  const k1 = g1.log.length;
  admin.send({ t: 'mode', kind: 'free' });
  await sleep(1200);
  ok(`${field}: the game stopped, the guards leave`, names.every((n) => g1.log.slice(k1).some((m) => m.t === 'leave' && m.name === n)));
  await sleep(5500); // the next start is not refused as too soon
}
await act({ op: 'guards', team: 'blue', count: 0, skill: 'normal' });
await sleep(250);
await act({ op: 'guards', team: 'red', count: 0, skill: 'normal' });
for (const c of [admin, g1, g2]) c.ws.close();
await sleep(300);
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
