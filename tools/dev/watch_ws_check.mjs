// Watching (src/watch.ts, server/game.mjs watcher) against a throwaway game server (a build of this branch on this
// computer): the admin's session may watch and is told everyone, every tick; a watcher is no player (not counted, not
// in the list, not seen); what it sends is dropped (a forged state, a chat line, a shot); a player's session may not
// watch (a wallhack); at most eight watch at once. The hall screen in the host's Zombies duel: the admin's watcher asks
// for a team's room by its side (&duel=blue|red) and is let in there only; it is not counted there either, what it sends
// is dropped, and the duel's end sends it back to the open world.
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
  const ws = new WebSocket(`${o.api.startsWith('https') ? 'wss' : 'ws'}://${host}/ws?v=2${watch ? '&watch=1' : ''}`, { headers: { Cookie: cookie, Origin: o.api } });
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

// The hall screen in the Zombies duel (server/duel.mjs): the admin's watcher asks for a team's room by its side.
for (const c of more) c.ws.close();
for (const c of [bob, ann]) c.ws.close();
await sleep(500);
/** A guest's page that connects again when the server moves it (4006, into the duel) or its room goes (4004). */
const player = (cookie) => {
  const p = { log: [], welcomes: [], ws: null, stopped: false, of: (t) => p.log.filter((m) => m.t === t) };
  const connect = () => {
    const ws = new WebSocket(`ws://${host}/ws?v=2`, { headers: { Cookie: cookie, Origin: o.api } });
    p.ws = ws;
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.t === 'ping') return ws.send(JSON.stringify({ t: 'pong', n: m.n }));
      if (m.t === 's') return;
      p.log.push(m);
      if (m.t === 'welcome') p.welcomes.push(m.room ?? null);
    });
    ws.on('close', (code) => !p.stopped && (code === 4004 || code === 4006) && connect());
    ws.on('error', () => {});
  };
  connect();
  return p;
};
const hostAct = async (b) => (await post('/api/host', b, admin)).json();
const blueName = `bl${tag}`, redName = `rd${tag}`;
const cb = await guest(blueName);
const pb = player(cb);
const pr = player(await guest(redName));
await sleep(800);
await hostAct({ op: 'teams', count: 2 });
const started = await hostAct({ op: 'start', kind: 'duel', duel: 'warmup', minutes: 1 });
ok('the host starts a Zombies duel', !!started?.ok, JSON.stringify(started));
for (let i = 0; i < 40 && !(pb.welcomes.at(-1)?.duel && pr.welcomes.at(-1)?.duel); i++) await sleep(500);
const sideOf = (p) => p.welcomes.at(-1)?.duel;
ok('both guests are in their team\'s room', !!sideOf(pb) && !!sideOf(pr) && sideOf(pb) !== sideOf(pr), `${sideOf(pb)} ${sideOf(pr)}`);
const inBlue = sideOf(pb) === 'blue' ? pb : pr;
const [blueOne, redOne] = sideOf(pb) === 'blue' ? [blueName, redName] : [redName, blueName];
const watchAt = (cookie, q, headers = { Cookie: cookie, Origin: o.api }) => new Promise((resolve) => {
  const c = { log: [], refused: false, closed: null, of: (t) => c.log.filter((m) => m.t === t), send: (m) => c.ws.send(JSON.stringify(m)) };
  c.ws = new WebSocket(`ws://${host}/ws?v=2&watch=1${q}`, { headers });
  c.ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    c.log.push(m);
    if (m.t === 'ping') c.ws.send(JSON.stringify({ t: 'pong', n: m.n }));
  });
  c.ws.on('open', () => setTimeout(() => resolve(c), 600));
  c.ws.on('close', (code) => (c.closed = code));
  c.ws.on('unexpected-response', () => ((c.refused = true), resolve(c)));
  c.ws.on('error', () => ((c.refused = true), resolve(c)));
});
const wb = await watchAt(admin, '&duel=blue');
const wr = await watchAt(admin, '&duel=red');
const wbw = wb.of('welcome')[0];
ok("the admin watches blue's room: told so, with blue's player", wbw?.watch === true && wbw.room?.duel === 'blue' && wbw.players.some((p) => p.name === blueOne) && !wbw.players.some((p) => p.name === redOne));
ok("and red's room", wr.of('welcome')[0]?.room?.duel === 'red' && wr.of('welcome')[0].players.some((p) => p.name === redOne));
await sleep(700);
ok("a duel room's watcher gets its players in the ticks", wb.of('s').some((m) => (m.p ?? []).some((e) => e[0] === blueOne)));
ok('a player\'s session may not watch a duel room (on a team or not)', (await watchAt(cb, '&duel=red')).refused && (await watchAt(cb, '&duel=blue')).refused && (await watchAt(await guest(`nw${tag}`), '&duel=blue')).refused);
ok('no session may not watch a duel room', (await watchAt('', '&duel=blue')).refused);
ok("another site's page may not (cross-site WebSocket hijacking)", (await watchAt(admin, '&duel=blue', { Cookie: admin, Origin: 'https://evil.example' })).refused);
const hv = await (await fetch(o.api + '/api/host', { headers: { Cookie: admin } })).json();
ok('a duel room\'s watcher is not counted (the duel\'s line, the host\'s list)', hv.duel?.sides?.every((s) => s.players === 1) && hv.inDuel?.length === 2 && hv.inDuel.every((p) => [blueName, redName].includes(p.name)), JSON.stringify(hv.inDuel?.map((p) => p.name)));
const roster = await (await fetch(o.api + '/api/players', { headers: { Cookie: admin } })).json();
ok('nor in the admin\'s player list', !roster.players.some((p) => p.name === '' || p.name === 'admin'));
// What it sends is dropped there too.
wb.send({ t: 'chat', text: 'watcher in the duel' });
wb.send({ t: 'state', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, armed: true, w: 'pistol' });
wb.send({ t: 'shot', x: 0, y: 1.5, z: 0, w: 'pistol', tx: 1, ty: 1.5, tz: 1 });
await sleep(600);
ok("a duel room's watcher's chat, state and shot reach nobody", !inBlue.of('chat').some((m) => m.text === 'watcher in the duel') && !inBlue.of('shot').length);
// The duel ends: its rooms close and so do their watchers (4004); asked again with the same address, the open world.
await hostAct({ op: 'stop' });
for (let i = 0; i < 30 && wb.closed === null; i++) await sleep(500);
ok("the duel's end closes its rooms' watchers (back to the open world)", wb.closed === 4004 && wr.closed === 4004, `${wb.closed} ${wr.closed}`);
const back = await watchAt(admin, '&duel=blue');
ok('no duel on: the same address watches the open world', !back.refused && back.of('welcome')[0]?.room === null);
for (const c of [wb, wr, back]) c.ws.close();
for (const p of [pb, pr]) (p.stopped = true), p.ws.close();
await hostAct({ op: 'teams', count: 0 });

// The admin's session ends (a logout): its watch views close within a second or so.
let closed = null;
w.ws.on('close', (code) => (closed = code));
const other = cookieOf(await post('/api/login', { username: 'admin', password })); // the check goes on with a second session
await post('/api/logout', {}, admin);
await sleep(1800);
ok('a watch view closes once the admin\'s session ends', closed === 4002, String(closed));
const after = await open(admin, true);
ok('and the ended session can\'t watch again', after.refused);
await post('/api/logout', {}, other);

for (const c of [bob, ann, w, after]) c.ws.close();
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
