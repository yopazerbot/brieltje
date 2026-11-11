// The LAN night host's controls (server/host.mjs) against a throwaway game server (a build of this branch on this
// computer): the doors locked and a newcomer let in, an announcement, a freeze that holds players and stops their
// shots, bringing players to the host, muting, the chat off, the word filter on chat and on names, the evening's teams
// and their sides in the teams game, the programme with its countdown and a game's own length, the evening's
// scoreboard, a kick for the evening, and every action refused to anyone but the admin (a forged host action).
//
//   ADMIN_PASSWORD=... node tools/dev/host_ws_check.mjs --api http://localhost:8231
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { localOnly, options } from './cdp.mjs';

const o = options({ api: 'http://localhost:8231' });
localOnly(o.api); // it logs in as the admin, locks the doors and kicks: a throwaway server on this computer only
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
const act = async (b, cookie = adminCookie) => (await call('POST', '/api/host', b, cookie));
const view = async () => (await call('GET', '/api/host', null, adminCookie)).data;

/** A connection under a session cookie: its messages, and how it closed. */
const connect = async (name, cookie) => {
  const log = [];
  const ws = new WebSocket(`ws://${host}/ws?v=2`, { headers: { Cookie: cookie, Origin: o.api } });
  const c = { name, ws, log, closed: null, send: (m) => ws.send(JSON.stringify(m)), of: (t) => log.filter((m) => m.t === t) };
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    log.push(m);
    if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', n: m.n }));
  });
  ws.on('close', (code) => (c.closed = code));
  await new Promise((res) => (ws.on('open', res), ws.on('error', res), ws.on('close', res)));
  await sleep(500);
  return c;
};
const join = async (name) => {
  const { r, data } = await call('POST', '/api/join', { name, age: true });
  return r.ok ? cookieOf(r) : { error: data?.code };
};
const guest = async (name) => {
  const cookie = await join(name);
  return Object.assign(await connect(name, cookie), { cookie });
};
const at = (c, x, z) => c.send({ t: 'state', x, y: 0, z, yaw: 0, pitch: 0, armed: true, w: 'pistol' });

// Every guest here joins from this one address: its joining limit lifted first (as the in-game admin tab's button does).
const lift = () => call('POST', '/api/lockouts', {}, adminCookie);
await lift();
await act({ op: 'reset' });
await act({ op: 'lock', on: false });
await act({ op: 'teams', count: 0 });
await act({ op: 'limit', max: 32 });
const admin = await connect('admin', adminCookie);
at(admin, 4.5, 14);
const ann = await guest('ann');
const bob = await guest('bob');
ok('two guests and the host are in', !!ann.of('welcome').length && !!bob.of('welcome').length && !!admin.of('welcome').length);

// Not the admin: every host action refused (a forged action from a player's own session).
for (const b of [{ op: 'lock', on: true }, { op: 'freeze', on: true }, { op: 'announce', text: 'hi' }, { op: 'kick', name: 'bob' }]) {
  const { r } = await act(b, await join(`x${Math.random().toString(36).slice(2, 8)}`));
  ok(`a player's ${b.op} is refused`, r.status === 403, String(r.status));
}
const plain = await fetch(o.api + '/api/host', { method: 'POST', headers: { 'Content-Type': 'text/plain', Cookie: adminCookie }, body: '{"op":"lock","on":true}' });
ok('a cross-site form post (no Origin, not JSON) is refused', plain.status >= 400, String(plain.status));
ok('an unknown action is refused', (await act({ op: 'explode' })).r.status === 400);

// The doors.
await act({ op: 'lock', on: true });
const cid = await guest('cid');
ok('locked: a newcomer is told and kept out', !!cid.of('locked').length && cid.closed === 4005, String(cid.closed));
ok('the host sees them knocking', (await view()).knocking.includes('cid'));
ann.ws.close();
await sleep(400);
const annBack = await connect('ann', ann.cookie);
ok('one of tonight\'s players comes back in while locked', !!annBack.of('welcome').length, String(annBack.closed));
await act({ op: 'admit', name: 'cid' });
const cid2 = await connect('cid', cid.cookie);
ok('let in by the host: in', !!cid2.of('welcome').length);
await act({ op: 'lock', on: false });

// Announcements.
await act({ op: 'announce', text: 'Pizza is here, you shit', secs: 5 });
await sleep(300);
const a = bob.of('announce').at(-1);
ok('an announcement reaches everyone, filtered', a?.text === 'Pizza is here, you ****' && a?.ms === 5000, JSON.stringify(a));

// Freeze: held where they stood, no shots.
at(bob, 6, 10);
await sleep(300);
await act({ op: 'freeze', on: true, text: 'Rules!' });
await sleep(200);
ok('frozen: everyone is told, with the reason', bob.of('freeze').at(-1)?.on === true && bob.of('freeze').at(-1)?.text === 'Rules!');
for (let i = 0; i < 6; i++) {
  at(bob, 6 + i * 0.3, 10);
  await sleep(100);
}
bob.send({ t: 'shot', x: 6, y: 1.5, z: 10, w: 'pistol', tx: 4.5, ty: 1.5, tz: 14 });
await sleep(400);
const lateComer = await guest('dee');
ok('someone coming in while frozen is frozen too', dee(lateComer));
function dee(c) {
  return c.of('freeze').at(-1)?.on === true;
}
const seen = admin.log.filter((m) => m.t === 's').length;
ok('a frozen player\'s shot reaches nobody', !admin.of('shot').some((m) => m.name === 'bob'), String(seen));
await act({ op: 'freeze', on: false });
await sleep(200);
ok('let go: everyone is told', bob.of('freeze').at(-1)?.on === false);

// Bring.
const before = admin.of('respawn').length;
await act({ op: 'bring', name: '*' });
await sleep(300);
const brought = admin.of('respawn').slice(before);
ok('bring everyone: each comes to the host (as a respawn next to them)', brought.length >= 3 && brought.every((m) => Math.hypot(m.x - 4.5, m.z - 14) < 4), JSON.stringify(brought.map((m) => [m.name, m.x, m.z])));

// Chat: muted, off, filtered.
await act({ op: 'mute', name: 'bob', on: true });
await sleep(800);
bob.send({ t: 'chat', text: 'hello' });
await sleep(300);
ok('muted: their line reaches nobody, and they are told', !admin.of('chat').some((m) => m.from === 'bob') && bob.of('system').some((m) => m.code === 'youMuted'));
await act({ op: 'mute', name: 'bob', on: false });
await act({ op: 'chat', on: false });
await sleep(800);
cid2.send({ t: 'chat', text: 'anyone?' });
await sleep(300);
ok('chat off: a player\'s line reaches nobody', !admin.of('chat').some((m) => m.from === 'cid'));
await act({ op: 'chat', on: true });
await act({ op: 'words', list: ['broccoli'] });
await sleep(800);
cid2.send({ t: 'chat', text: 'I hate broccoli, kut' });
await sleep(300);
const line = admin.of('chat').find((m) => m.from === 'cid');
ok('the word filter stars out the list and the host\'s own words', line?.text === 'I hate ********, ***', JSON.stringify(line));
await lift();
ok('a rude guest name is refused', (await join('fuckface')).error === 'nameRude' && (await join('broccolifan')).error === 'nameRude');
ok('an innocent name is not (catering)', typeof (await join('catering')) === 'string');

// Teams: two for the evening, the teams game played by them.
await act({ op: 'teams', count: 2 });
await sleep(300);
let v = await view();
const sides = Object.fromEntries(v.players.filter((p) => p.team).map((p) => [p.name, p.team]));
ok('two teams: every player but the host on one, as even as can be', Object.keys(sides).length === 4 && Object.values(sides).filter((t) => t === 'blue').length === 2, JSON.stringify(sides));
ok('each player is told their team', bob.of('eveningteams').at(-1)?.teams?.bob === sides.bob);
const other = sides.bob === 'blue' ? 1 : 0;
await act({ op: 'move', name: 'bob', team: other });
v = await view();
ok('the host moves a player', v.players.find((p) => p.name === 'bob').team === (other ? 'orange' : 'blue'));
await act({ op: 'programme', list: [{ kind: 'teams', minutes: 2, goal: 7 }, { kind: 'tag', minutes: 1 }, { kind: 'nonsense' }] });
v = await view();
ok('the programme keeps the known games only', v.programme.length === 2 && v.programme[0].goal === 7);
const t0 = Date.now();
await act({ op: 'next' });
await sleep(300);
const cd = bob.of('announce').at(-1);
ok('next: a countdown on every screen', cd?.code === 'nextGame' && cd?.args?.kind === 'teams' && cd?.count === true);
await sleep(10_500);
const mode = bob.of('mode').at(-1)?.mode;
const mine = Object.fromEntries((await view()).players.filter((p) => p.team).map((p) => [p.name, p.team]));
const sideOk = mode && Object.entries(mode.teams ?? {}).every(([n, s]) => !mine[n] || (mine[n] === 'blue') === (s === 'house'));
ok('after ten seconds the teams game starts, with the evening\'s teams as its sides', mode?.kind === 'teams' && sideOk, JSON.stringify(mode?.teams));
ok('with the programme\'s goal and length', mode?.goal === 7 && mode.ms > 100_000 && mode.ms <= 120_000 - (Date.now() - t0 - 10_500) + 1000, `${mode?.goal} ${mode?.ms}`);
bob.send({ t: 'team', team: mode.teams.bob === 'house' ? 'bungalow' : 'house' });
await sleep(300);
ok('a player can\'t switch the host\'s teams', bob.of('system').some((m) => m.code === 'hostTeams'));
await act({ op: 'stop' });
await sleep(300);

// The evening's scoreboard: a stopped game gives nothing; a game of tag of one minute, played out, gives its points.
v = await view();
ok('a stopped game gives no points', v.board.games === 0, String(v.board.games));
await act({ op: 'start', kind: 'tag', minutes: 1 });
await sleep(10_500);
const tag = bob.of('mode').at(-1)?.mode;
ok('a game started from the host page runs, as long as asked', tag?.kind === 'tag' && tag.ms <= 60_000 && tag.ms > 55_000, String(tag?.ms));
await sleep(61_000);
v = await view();
const winner = bob.of('system').find((m) => m.code === 'tagWon')?.args?.name;
const pts = Object.fromEntries(v.board.players.map((p) => [p.name, p.points]));
ok('played out: one game on the evening\'s board, the winner 4 points, the others 1', v.board.games === 1 && pts[winner] === 4 && Object.entries(pts).every(([n, p]) => n === winner || p === 1), JSON.stringify(pts));
const teamSum = v.board.teams.reduce((s, t) => s + t.points, 0);
const onTeams = v.board.players.filter((p) => p.team).reduce((s, p) => s + p.points, 0);
ok('the teams\' totals are their players\' points', teamSum === onTeams, `${teamSum} ${onTeams}`);

// The kick for the evening.
await act({ op: 'kick', name: 'dee', evening: true });
await sleep(500);
ok('kicked for the evening: out', lateComer.closed === 4001, String(lateComer.closed));
ok('and refused when trying again', (await join('dee')).error !== undefined);

for (const c of [admin, annBack, bob, cid2]) c.ws.close();
await act({ op: 'teams', count: 0 });
await act({ op: 'words', list: [] });
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
