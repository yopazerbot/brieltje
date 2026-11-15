// The boards of the routes and the gnomes against a throwaway game server (a build of this branch, server/goals.mjs):
// an account walks the walking route at running pace, twenty states a second, and is on GET /api/boards with the
// server's time, within a tenth of a second of this script's own stopwatch (the same rules on the positions it sent,
// its own clock); a guest walks it too and is on tonight's board only (GET /api/host). Then every forgery the boards
// could be abused with must count nothing: a page's own race and gnome messages, a trip through the portals mid-run
// (chat travel), the route on a bike, flying, a skipped checkpoint, running at twice the pace; a straight line through
// the houses gets no time under the route's floor (the server checks no walls for players). A gnome counts once. The Zombies board, the fights' totals and the host's board answer as before.
// The account is deleted at the end.
//
//   ADMIN_PASSWORD=... node tools/dev/boards_ws_check.mjs --api http://localhost:8437
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { stepRun } from '../../web/shared/goals.mjs';
import { makeTerrain } from '../../web/shared/terrain.mjs';
import BIKES from '../../web/shared/bike.json' with { type: 'json' };
import { localOnly, options } from './cdp.mjs';

const o = options({ api: 'http://localhost:8437' });
localOnly(o.api); // it logs in as the admin, makes an account and joins players: a throwaway server on this computer only
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
const TERRAIN = makeTerrain(JSON.parse(readFileSync(new URL('../../web/shared/terrain.json', import.meta.url), 'utf8')));
const GROUND = JSON.parse(readFileSync(new URL('../../web/src/data/house_shell.json', import.meta.url), 'utf8')).ground;
const ground = (x, z) => GROUND + TERRAIN.height(x, z);
const FOOT = JSON.parse(readFileSync(new URL('../../web/shared/routes.json', import.meta.url), 'utf8')).routes.find((r) => r.id === 'foot');
const RUN = 3.5; // m/s: running at the real pace (the server allows 1.3 times that for jitter)
/** Where chat travel to the church puts you (shared/portals.mjs church.out). */
const CHURCH = [536.3, -771.6];
/**
 * The walking route on foot, kept clear of the village's walls (worked out over 0.5 m cells against the server's blocks):
 * 8 m before the gate, the gate, the checkpoints in order with the corners round the houses, the gate again.
 */
const LAP = [[539.47, -769.59], [542, -762], [547, -747], [539.5, -735], [540.5, -739], [532.5, -747.5], [527, -752], [514.5, -769.5], [519.5, -782], [519.5, -781], [521.5, -779.5], [527, -777], [542, -762]];

const admin = cookieOf((await call('POST', '/api/login', { username: 'admin', password })).r);
const tag = randomBytes(3).toString('hex');
const accountName = `brd${tag}`;
const reg = await call('POST', '/api/account/register', { username: accountName, email: `${accountName}@example.org`, password: randomBytes(12).toString('base64url'), age: true });
ok('a throwaway account', reg.r.ok, String(reg.data?.code ?? ''));
const accountCookie = cookieOf(reg.r);
const guestJoin = await call('POST', '/api/join', { name: `Gst${tag}`, age: true });
const guestCookie = cookieOf(guestJoin.r);

async function player(cookie) {
  const log = [];
  const ws = new WebSocket(`ws://${host}/ws?v=2`, { headers: { Cookie: cookie, Origin: o.api } });
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    log.push(m);
    if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', n: m.n })); // or the server drops a silent page
  });
  await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)));
  await sleep(600);
  const me = { cookie, ws, log, x: 0, y: 0, z: 0, flying: false, send: (m) => ws.send(JSON.stringify(m)) };
  me.name = log.find((m) => m.t === 'welcome')?.you;
  me.state = (extra = {}) => me.send({ t: 'state', x: me.x, y: me.y, z: me.z, yaw: 0, pitch: 0, armed: false, w: 'pistol', flying: me.flying, ct: Date.now(), ...extra });
  /** To the church by the chat (a trip the server makes), then standing there a moment. */
  me.church = async () => {
    me.send({ t: 'travel', to: 'church', via: 'chat' });
    await sleep(1700); // a trip at most every 1.5 s
    [me.x, me.z] = CHURCH;
    me.y = ground(me.x, me.z);
    for (let i = 0; i < 5; i++) (me.state(), await sleep(50));
  };
  /** Along `points` at `speed` m/s, twenty states a second; `watch`: the stopwatch (the route's rules on what we sent). */
  me.walk = async (points, speed, { extra = {}, watch = null, y = 0 } = {}) => {
    for (const [x, z] of points) {
      for (;;) {
        const d = Math.hypot(x - me.x, z - me.z);
        const step = Math.min(d, speed / 20);
        const from = { x: me.x, z: me.z };
        if (d > 1e-6) {
          me.x += ((x - me.x) / d) * step;
          me.z += ((z - me.z) / d) * step;
        }
        me.y = ground(me.x, me.z) + y;
        me.state(extra);
        const sent = performance.now();
        if (watch) {
          const r = stepRun(watch.run, FOOT, from, { x: me.x, z: me.z }, 'foot', sent, 100);
          watch.run = r.run;
          if (r.event === 'start') watch.gap = Math.round(sent - (me.sentAt ?? sent)); // the server starts a run only within 200 ms
          if (r.event === 'finish') watch.ms = r.time;
        }
        me.sentAt = sent;
        await sleep(50);
        if (d <= step) break;
      }
    }
  };
  /** The server's race messages from index `from` on, after waiting a moment for one. */
  me.races = async (from, wait = 1500) => {
    await sleep(wait);
    return log.slice(from).filter((m) => m.t === 'race');
  };
  return me;
}

const acc = await player(accountCookie);
const gst = await player(guestCookie);
ok('both joined', !!acc.name && !!gst.name, `${acc.name}, ${gst.name}`);

// ---- an honest lap by the account
await acc.church();
await acc.walk([LAP[0]], RUN);
await sleep(300);
let mark = acc.log.length;
const watch = { run: null, ms: null };
await acc.walk(LAP.slice(1), RUN, { watch });
let got = await acc.races(mark);
ok('the account\'s lap: the server tells it its time', got.length === 1 && got[0].id === 'foot' && got[0].best === true && got[0].tonight === false && got[0].place === 1, JSON.stringify(got));
const serverMs = got[0]?.ms;
ok('the server\'s time is within a tenth of a second of the stopwatch', watch.ms !== null && Math.abs(serverMs - watch.ms) <= 100, `server ${serverMs} ms, stopwatch ${Math.round(watch.ms)} ms, the gap at the gate ${watch.gap} ms`);
let boards = (await call('GET', '/api/boards')).data;
ok('the account is on /api/boards with that time', boards?.races?.foot?.some((r) => r.username === acc.name && r.ms === serverMs), JSON.stringify(boards?.races?.foot?.slice(0, 3)));
const answer = await fetch(`${o.api}/api/boards`);
ok('/api/boards is no-store, not compressed', /no-store/.test(answer.headers.get('cache-control') ?? '') && !answer.headers.get('content-encoding'), `${answer.headers.get('cache-control')} ${answer.headers.get('content-encoding') ?? ''}`);
const mine = (await call('GET', '/api/boards/mine', null, accountCookie)).data;
ok('/api/boards/mine gives the account its own line', mine?.races?.foot?.ms === serverMs && mine.races.foot.place >= 1, JSON.stringify(mine));
ok('/api/boards/mine without a session is 401', (await call('GET', '/api/boards/mine')).r.status === 401);

// ---- an honest lap by the guest: tonight only
await gst.church();
await gst.walk([LAP[0]], RUN);
await sleep(300);
mark = gst.log.length;
const gw = { run: null, ms: null, gap: null };
await gst.walk(LAP.slice(1), RUN, { watch: gw });
got = await gst.races(mark);
ok('the guest\'s lap counts for tonight', got.length === 1 && got[0].tonight === true, `${JSON.stringify(got)}; stopwatch ${Math.round(gw.ms)} ms, the gap at the gate ${gw.gap} ms`);
boards = (await call('GET', '/api/boards')).data;
ok('the guest is not on /api/boards', !JSON.stringify(boards).includes(gst.name));
ok('/api/boards/mine for a guest is {}', JSON.stringify((await call('GET', '/api/boards/mine', null, guestCookie)).data) === '{}');
let night = (await call('GET', '/api/host', null, admin)).data?.board;
ok('both on tonight\'s board (the host\'s)', night?.races?.foot?.some((r) => r.name === gst.name) && night.races.foot.some((r) => r.name === acc.name), JSON.stringify(night?.races?.foot));

// ---- forgeries: none may give a time
mark = acc.log.length;
acc.send({ t: 'race', id: 'foot', ms: 4000, best: true });
acc.send({ t: 'gnome', id: 'g10' });
acc.send({ t: 'gnome', n: 30 });
await sleep(400);
// A trip mid-run: through the gate, two checkpoints, then the chat's trip to the church, then on round the rest.
await acc.church();
await acc.walk(LAP.slice(0, 4), RUN);
await acc.church();
await acc.walk(LAP.slice(4), RUN);
const travelled = await acc.races(mark, 800);
// Flying (the flag, the rule on by default): the whole lap.
await acc.church();
await acc.walk(LAP, RUN, { extra: { flying: true } });
const flew = await acc.races(mark, 800);
// A skipped checkpoint: the fifth left out (the straight line from the fourth to the sixth passes 6 m from it).
await acc.church();
await acc.walk([...LAP.slice(0, 8), ...LAP.slice(11)], RUN);
const skipped = await acc.races(mark, 800);
// Straight through the houses from the second checkpoint to the third: the server checks no walls for players (the
// plan's rule against it stopped honest walks by the page), so this may count, but never under the route's floor.
await acc.church();
let at = acc.log.length;
await acc.walk([...LAP.slice(0, 4), LAP[6], ...LAP.slice(7)], RUN);
const walls = await acc.races(at, 800);
// Twice the pace: the server holds every step to its budget, so nothing gets round faster than 1.3 times a run.
await acc.church();
at = acc.log.length;
await acc.walk(LAP, RUN * 2);
await sleep(2500); // the server's place catches up with ours
const fast = await acc.races(at, 800);
ok('a page\'s own race and gnome messages count nothing', !acc.log.slice(mark).some((m) => m.t === 'gnome'));
ok('a trip mid-run: no time', travelled.length === 0, JSON.stringify(travelled));
ok('flying: no time', flew.length === 0, JSON.stringify(flew));
ok('a skipped checkpoint: no time', skipped.length === 0, JSON.stringify(skipped));
ok('a line through the houses: no time under the floor (21.2 s)', walls.every((m) => m.ms >= 21_200), JSON.stringify(walls));
const fastMs = fast.at(-1)?.ms;
ok('twice the pace: no time faster than the budget allows', fast.length === 0 || fastMs >= serverMs / 1.3 - 200, `${fast.length} times${fastMs ? `, ${fastMs} ms against ${serverMs} at a run` : ''}`);

// The route on a bike: getting on by the church's rack, riding the lap (a bike is not this route's way).
const bike = BIKES.bikes.church1.park;
await acc.church();
await acc.walk([[bike.x + 1, bike.z]], RUN);
await sleep(300);
acc.send({ t: 'bike', op: 'on', id: 'church1' });
await sleep(500);
const onBike = acc.log.some((m) => m.t === 'bike' && m.bike?.id === 'church1' && m.bike.rider === acc.name);
[acc.x, acc.z] = [bike.x, bike.z];
const before = acc.log.length;
await acc.walk([LAP[0], ...LAP], 6);
const biked = await acc.races(before, 800);
ok('on a bike round the walking route: no time', onBike && biked.length === 0, `on the bike ${onBike}, ${biked.length} times`);
acc.send({ t: 'bike', op: 'off', id: 'church1' });
await sleep(400);

// ---- a gnome counts once (g10, by the walking route's gate)
await acc.church();
mark = acc.log.length;
await acc.walk([[542, -764], [548.5, -761], [542, -764], [548.5, -761]], RUN);
await sleep(800);
const gnomes = acc.log.slice(mark).filter((m) => m.t === 'gnome');
ok('a gnome walked up to counts once', gnomes.length === 1 && gnomes[0].n === 1 && gnomes[0].tonight === false, JSON.stringify(gnomes));
boards = (await call('GET', '/api/boards')).data;
ok('and is on the gnome board', boards?.gnomes?.some((r) => r.username === acc.name && r.n === 1) && boards.gnomeTotal === 30, JSON.stringify(boards?.gnomes));

// ---- the other boards as before
const scores = await call('GET', '/api/scores');
ok('the Zombies board answers', scores.r.ok && Array.isArray(scores.data?.rows));
const fights = await call('GET', '/api/leaderboard', null, accountCookie);
ok('the fights\' totals answer', fights.r.ok && Array.isArray(fights.data?.rows));
night = (await call('GET', '/api/host', null, admin)).data?.board;
ok('the host\'s board keeps its points, teams and games', Array.isArray(night?.players) && Array.isArray(night?.teams) && typeof night?.games === 'number' && Array.isArray(night?.gnomes));
const big = await fetch(`${o.api}/admin/scores/`);
ok('/admin/scores is served', big.ok);
// The host's Reset empties tonight's races and gnomes.
await call('POST', '/api/host', { op: 'reset' }, admin);
night = (await call('GET', '/api/host', null, admin)).data?.board;
ok('the host\'s Reset empties tonight\'s races and gnomes', night?.races?.foot?.length === 0 && night?.gnomes?.length === 0, JSON.stringify({ races: night?.races, gnomes: night?.gnomes }));

// ---- the admin's removal, then the account goes (and its rows with it)
const removed = await call('POST', '/api/admin/boards', { op: 'remove', name: acc.name, board: 'gnomes' }, admin);
ok('the admin removes the account\'s gnomes', removed.r.ok && removed.data?.removed === 1, JSON.stringify(removed.data));
const cross = await fetch(`${o.api}/api/admin/boards`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: admin }, body: JSON.stringify({ op: 'remove', name: acc.name, board: 'race' }) });
ok('from another origin: refused', cross.status === 403);
const asForm = await fetch(`${o.api}/api/admin/boards`, { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: o.api, Cookie: admin }, body: JSON.stringify({ op: 'remove', name: acc.name, board: 'race' }) });
ok('as a simple (form-like) request: refused', asForm.status === 415);
const notPanel = await call('POST', '/api/admin/boards', { op: 'remove', name: acc.name, board: 'race' }, accountCookie);
ok('an account\'s session: refused', notPanel.r.status === 401 || notPanel.r.status === 403, String(notPanel.r.status));
for (const p of [acc, gst]) p.ws.close();
await sleep(300);
const del = await call('POST', '/api/admin/accounts', { op: 'delete', name: accountName }, admin);
boards = (await call('GET', '/api/boards')).data;
ok('the account deleted, its time gone from the board', del.r.ok && !JSON.stringify(boards).includes(accountName), JSON.stringify(del.data));
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
