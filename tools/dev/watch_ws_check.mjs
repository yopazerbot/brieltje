// Watching (src/watch.ts, server/game.mjs watcher) against a throwaway game server (a build of this branch on this
// computer): the admin's session may watch and is told everyone, every tick; a watcher is no player (not counted, not
// in the list, not seen); what it sends is dropped (a forged state, a chat line, a shot); a player's session may not
// watch (a wallhack); at most eight watch at once.
//
//   ADMIN_PASSWORD=... node tools/dev/watch_ws_check.mjs --api http://localhost:8231
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { localOnly, options } from './cdp.mjs';

const o = options({ api: 'http://localhost:8231' });
localOnly(o.api);
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');
const host = new URL(o.api).host;
let failed = 0;
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
  if (!pass) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookieOf = (r) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const post = (path, body, cookie = '') => fetch(o.api + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: o.api, Cookie: cookie }, body: JSON.stringify(body) });
const admin = cookieOf(await post('/api/login', { username: 'admin', password }));
await post('/api/lockouts', {}, admin);
const tag = Math.random().toString(36).slice(2, 5);

const open = (cookie, watch) => new Promise((resolve) => {
  const log = [];
  const ws = new WebSocket(`ws://${host}/ws?v=2${watch ? '&watch=1' : ''}`, { headers: { Cookie: cookie, Origin: o.api } });
  const c = { ws, log, refused: false, send: (m) => ws.send(JSON.stringify(m)), of: (t) => log.filter((m) => m.t === t) };
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    log.push(m);
    if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', n: m.n }));
  });
  ws.on('open', () => setTimeout(() => resolve(c), 500));
  ws.on('unexpected-response', () => {
    c.refused = true;
    resolve(c);
  });
  ws.on('error', () => {
    c.refused = true;
    resolve(c);
  });
});
const guest = async (name) => cookieOf(await post('/api/join', { name, age: true }));

const bobCookie = await guest(`bob${tag}`);
const bob = await open(bobCookie, false);
const ann = await open(await guest(`ann${tag}`), false);
for (let i = 0; i < 10; i++) {
  bob.send({ t: 'state', x: 4 + i * 0.2, y: 0, z: 14, yaw: 0, pitch: 0, armed: false, w: 'pistol' });
  await sleep(60);
}
const w = await open(admin, true);
await sleep(800);
const welcome = w.of('welcome')[0];
ok('the admin watches: told the world, as a watcher', welcome?.watch === true && welcome.role === 'watcher' && welcome.you === '' && welcome.players.some((p) => p.name === `bob${tag}`));
const seen = w.of('s').some((m) => (m.p ?? []).some((e) => e[0] === `bob${tag}`));
ok('a watcher gets every player in the ticks', seen);
const view = await (await fetch(o.api + '/api/host', { headers: { Cookie: admin } })).json();
ok('a watcher is no player (not in the list, not counted)', view.players.length === 2 && !view.players.some((p) => p.name === '' || p.role === 'watcher'), String(view.players.length));
ok('the players are not told of a watcher', !bob.of('join').some((m) => m.name === '' || m.name === 'admin'));

// What a watcher sends is dropped.
w.send({ t: 'state', x: 4, y: 0, z: 18, yaw: 0, pitch: 0, armed: true, w: 'pistol' });
w.send({ t: 'chat', text: 'hello from the watcher' });
w.send({ t: 'shot', x: 4, y: 1.5, z: 18, w: 'pistol', tx: 4, ty: 1.5, tz: 14 });
w.send({ t: 'rules', flying: false });
await sleep(600);
ok('a watcher\'s state, chat, shot and rules reach nobody', !bob.of('chat').length && !bob.of('shot').length && !bob.of('rules').length
  && !bob.of('s').some((m) => (m.p ?? []).some((e) => e[0] === '' || e[0] === 'admin')));

// Chat and the like from players reach the watcher.
ann.send({ t: 'chat', text: 'hi all' });
await sleep(400);
ok('a watcher hears the broadcasts (a chat line)', w.of('chat').some((m) => m.text === 'hi all'));

// Not the admin: refused.
const sneak = await open(bobCookie, true);
ok('a player\'s session may not watch', sneak.refused);
const nobody = await open('', true);
ok('no session may not watch', nobody.refused);

// At most eight.
const more = [];
for (let i = 0; i < 8; i++) more.push(await open(admin, true));
ok('at most eight watch at once', more.slice(0, 7).every((c) => !c.refused) && more[7].refused, more.map((c) => (c.refused ? 'x' : '.')).join(''));

for (const c of [bob, ann, w, ...more]) c.ws.close();
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
