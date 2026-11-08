// Two players against a throwaway game server: one has no right to the main house, one has typed its code (and the admin
// is the third). The check logs every WebSocket message and proves that the one without the right is never sent anything
// of the inside: furniture, door states, broken panes. Also the inside endpoint: refused without the grant, served with it.
//
//   ADMIN_PASSWORD=... node tools/dev/homes_ws_check.mjs --api http://localhost:8450
//
// Needs the private data on the server (web/.private/ on this PC): the check says so and stops without it.
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { localOnly, options } from './cdp.mjs';

const o = options({ api: 'http://localhost:8450' });
localOnly(o.api); // it makes the main house's code: a throwaway server on this computer only
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');
const host = new URL(o.api).host;
let failed = 0;
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
  if (!pass) failed++;
};
const call = async (method, path, body, cookie = '') => {
  const r = await fetch(o.api + path, { method, headers: { 'Content-Type': 'application/json', Origin: o.api, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  return { r, data: await r.json().catch(() => null) };
};
const cookieOf = (r) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

const admin = cookieOf((await call('POST', '/api/login', { username: 'admin', password })).r);
const code = (await call('POST', '/api/admin/homes/house/code', {}, admin)).data.code;
const insidePack = await call('GET', '/api/home/house/inside', undefined, admin);
ok('the admin gets the inside', insidePack.r.status === 200, `${insidePack.r.status}`);
if (insidePack.r.status !== 200) {
  console.log('no private data on this server: nothing more to check');
  process.exit(1);
}
const pack = insidePack.data;
const insideDoor = pack.doors[0].id;
const insidePane = pack.prisms.find((p) => p.m === 'glass')?.glass ?? pack.doors.flatMap((d) => d.panels).find((p) => p.glassNo)?.glassNo;

const guest = async (name) => {
  const j = await call('POST', '/api/join', { name, age: true });
  const cookie = cookieOf(j.r);
  const log = [];
  const ws = new WebSocket(`ws://${host}/ws?v=4`, { headers: { Cookie: cookie, Origin: o.api } });
  ws.on('message', (d) => log.push(JSON.parse(String(d))));
  await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)));
  await new Promise((r) => setTimeout(r, 800));
  return { name, cookie, ws, log, send: (m) => ws.send(JSON.stringify(m)) };
};
const a = await guest('Alice'); // no right
const b = await guest('Bob'); // types the code
const welcomeA = a.log.find((m) => m.t === 'welcome');
const welcomeB0 = b.log.find((m) => m.t === 'welcome');
ok('both joined', !!welcomeA && !!welcomeB0);

const inside = (m) => (m.t === 'door' && m.id === insideDoor) || (m.t === 'glass' && m.i === insidePane) || m.t === 'inside' || (m.t === 'furn' && m.op === 'put');
ok('a: no inside door state in the welcome', !Object.keys(welcomeA.doors).includes(insideDoor));
// The admin's own welcome has every piece: connect it and compare.
const root = await (async () => {
  const log = [];
  const ws = new WebSocket(`ws://${host}/ws?v=4`, { headers: { Cookie: admin, Origin: o.api } });
  ws.on('message', (d) => log.push(JSON.parse(String(d))));
  await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)));
  await new Promise((r) => setTimeout(r, 800));
  return { ws, log };
})();
const all = root.log.find((m) => m.t === 'welcome').furniture.length;
ok('a: furniture held back (inside pieces are not in its welcome)', welcomeA.furniture.length < all, `${welcomeA.furniture.length} of ${all}`);

// Bob has no right yet: his door and glass messages are ignored, nothing is sent to anyone.
b.send({ t: 'door', id: insideDoor, open: true, dir: 1 });
b.send({ t: 'glass', i: insidePane });
await new Promise((r) => setTimeout(r, 500));
ok('without the right a door or pane message does nothing', !a.log.some(inside) && !root.log.some(inside));
const early = await call('GET', '/api/home/house/inside', undefined, b.cookie);
ok('GET inside is refused without the grant', early.r.status === 403 && !JSON.stringify(early.data).includes('prisms'));

// Bob types the right code: the grant, the pack, and one 'inside' message with the state.
const unlock = await call('POST', '/api/home/unlock', { id: 'house', code }, b.cookie);
ok('the right code answers with the inside', unlock.r.status === 200 && Array.isArray(unlock.data.inside?.prisms));
ok('the answer is never cached', /no-store/.test(unlock.r.headers.get('cache-control')) && /private/.test(unlock.r.headers.get('cache-control')));
await new Promise((r) => setTimeout(r, 500));
ok('b is told the state of the inside once', b.log.filter((m) => m.t === 'inside').length === 1);
ok('GET inside works with the grant', (await call('GET', '/api/home/house/inside', undefined, b.cookie)).r.status === 200);
ok('and still not for a', (await call('GET', '/api/home/house/inside', undefined, a.cookie)).r.status === 403);

// Now Bob opens an inside door and breaks an inside pane: the admin hears, Alice does not.
b.send({ t: 'door', id: insideDoor, open: true, dir: 1 });
await new Promise((r) => setTimeout(r, 300));
b.send({ t: 'glass', i: insidePane });
await new Promise((r) => setTimeout(r, 600));
ok('the admin hears the inside door and pane', root.log.some((m) => m.t === 'door' && m.id === insideDoor) && root.log.some((m) => m.t === 'glass' && m.i === insidePane));
ok('a hears nothing of the inside', !a.log.some(inside), JSON.stringify(a.log.filter(inside).slice(0, 2)));
const door2 = a.log.filter((m) => m.t === 'door' || m.t === 'glass').length;
ok('(a was told no door or glass message at all)', door2 === 0);
// The party games still start with the new house data: the admin starts Teams, then Zombies at the house.
for (const kind of ['teams', 'zombies']) {
  root.log.length = 0;
  root.ws.send(JSON.stringify({ t: 'mode', kind, place: 'house' }));
  await new Promise((r) => setTimeout(r, 1500));
  ok(`the ${kind} game started`, root.log.some((m) => m.t === 'mode' && m.mode?.kind === kind), `${root.log.length} messages`);
  root.ws.send(JSON.stringify({ t: 'mode', kind: 'free' }));
  await new Promise((r) => setTimeout(r, 500));
}
// A third connection of Alice's later (a rejoin): the welcome still holds nothing inside, Bob's does.
a.ws.close();
b.ws.close();
root.ws.close();
const a2 = await guest('Alice2');
const w2 = a2.log.find((m) => m.t === 'welcome');
ok('a new page without the right: no inside door and no broken inside pane in its welcome', !Object.keys(w2.doors).includes(insideDoor) && !w2.broken.includes(insidePane));
a2.ws.close();
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
