// The weather for everyone against a throwaway game server (a build of this branch): the admin picks dusk and snow
// and every player is told, with the cycle (its season too); a player who is not the admin is refused (a forged admin
// message), as is a flood of choices and anything off the list; a player who joins later is told the choice.
//
//   ADMIN_PASSWORD=... node tools/dev/mood_ws_check.mjs --api http://localhost:8420
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { isCycle, winterAt } from '../../web/shared/moods.mjs';
import { options } from './cdp.mjs';

const o = options({ api: 'http://localhost:8420' });
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
const connect = async (name, cookie) => {
  const log = [];
  const ws = new WebSocket(`ws://${host}/ws?v=2`, { headers: { Cookie: cookie, Origin: o.api } });
  ws.on('message', (d) => log.push(JSON.parse(String(d))));
  await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)));
  await sleep(600);
  return { name, ws, log, send: (m) => ws.send(JSON.stringify(m)), moods: () => log.filter((m) => m.t === 'mood') };
};
const guest = async (name) => connect(name, cookieOf((await call('POST', '/api/join', { name, age: true })).r));

const admin = await connect('admin', adminCookie);
const bob = await guest('Bob');
const welcome = bob.log.find((m) => m.t === 'welcome');
ok('the welcome has the choice and the cycle, with its season by the server\'s date', welcome?.mood === 'auto' && isCycle(welcome?.moodCycle?.cycle)
  && welcome.moodCycle.cycle.winter === winterAt(Date.now()), JSON.stringify(welcome?.moodCycle?.cycle));

for (const mood of ['dusk', 'snow']) {
  const before = bob.moods().length;
  admin.send({ t: 'mood', mood });
  await sleep(500);
  const got = bob.moods().slice(before);
  ok(`the admin picks ${mood}: the other player is told, with who`, got.length === 1 && got[0].mood === mood && got[0].by === 'admin' && got[0].op === 'set');
  await sleep(1100); // one choice a second
}

// Not the admin: a forged admin message, with or without a forged role, changes nothing and tells nobody.
let before = admin.moods().length;
for (const m of [{ t: 'mood', mood: 'night' }, { t: 'mood', mood: 'dusk', role: 'admin' }, { t: 'moodskip' }, { t: 'moodspeed', speed: 60 }]) bob.send(m);
await sleep(700);
ok('a player who is not the admin is refused (dusk, night, skip, pace)', admin.moods().length === before);

// Off the list and a flood: one change at most.
before = bob.moods().length;
for (const mood of ['Dusk', 'SNOW', 'winter', '__proto__', ' snow']) admin.send({ t: 'mood', mood });
await sleep(700);
ok('names off the list are refused', bob.moods().length === before);
await sleep(1100);
for (let i = 0; i < 12; i++) admin.send({ t: 'mood', mood: i % 2 ? 'dusk' : 'night' });
await sleep(700);
ok('a flood of choices changes it once', bob.moods().length === before + 1 && bob.moods().at(-1).mood === 'night');

// A player who joins later is told it.
await sleep(1100);
admin.send({ t: 'mood', mood: 'snow' });
await sleep(500);
const carol = await guest('Carol');
const late = carol.log.find((m) => m.t === 'welcome');
ok('a player who joins later is told the choice', late?.mood === 'snow');

// Back to Auto for whoever looks next.
await sleep(1100);
admin.send({ t: 'mood', mood: 'auto' });
await sleep(400);
for (const c of [admin, bob, carol]) c.ws.close();
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
