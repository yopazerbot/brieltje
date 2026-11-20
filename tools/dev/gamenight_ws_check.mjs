// A game night's team games played through, as the host runs them (server/host.mjs, POST /api/host), against a
// throwaway game server (a build of this branch on this computer): a dozen guests and the admin, the evening's two
// teams dealt by the host, and the hall screen (the admin's watch view, src/watch.ts) open all evening. Steal the flag
// from the programme's Next (its countdown, then everyone at their base), a player who leaves and one who reloads mid-
// round (told where the server has them, not moved), a late joiner (the smaller team, at its base), the host moving
// a player and swapping the sides, ending it early with Stop; then Attack and defend straight after, and a Steal the
// flag on the whole village after that. Checked at every step: everyone's team the same in the game, in the evening's
// teams and on the hall screen; every page told the same; nothing of one game left in the next (its parked vehicles,
// its guards, its teams' colours); the evening's points adding up (each team's total is its players' points while on
// it); the host's calls by name with capitals. The host's Stop during a countdown calls it off (in free play, and with
// a game on and the next one counting down): no game starts when it would have, every page's countdown goes, and a
// player's own call to the host's controls is refused.
//
// --stall: instead of the evening, how long the server is held in each game's countdown, at its start and stop (and
// Attack and defend's round change and end, played through with rounds of a minute), from the hall screen's ticks: the longest gap
// between two, less the tick's own 50 ms. Run it with --players 30 for a game night's hall; --only assault,zombies
// for some of the games.
//
//   ADMIN_PASSWORD=... node tools/dev/gamenight_ws_check.mjs --api http://localhost:8620 [--players 12] [--stall [--only kinds]]
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { localOnly, options } from './cdp.mjs';
import { FIELDS } from '../../web/shared/flagFields.mjs';

const o = options({ api: 'http://localhost:8620', players: '12', stall: false, only: '' });
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
/** One host call, a little apart from the last (the host's own page sends one at a time). */
const act = async (b) => {
  await sleep(150);
  const x = await call('POST', '/api/host', b, adminCookie);
  return x.data;
};
const view = async () => (await call('GET', '/api/host', null, adminCookie)).data;

/** A page's connection: its messages, and where the server last put it or told it it is (`at`). */
const connect = async (name, cookie, watch = false) => {
  const log = [];
  const ws = new WebSocket(`ws://${host}/ws?v=2${watch ? '&watch=1' : ''}`, { headers: { Cookie: cookie, Origin: o.api } });
  const c = { name, ws, log, at: null, cookie, seen: new Map(), bikes: new Map(), ticks: [], send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)), of: (t) => log.filter((m) => m.t === t) };
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 'ping') return ws.send(JSON.stringify({ t: 'pong', n: m.n }));
    if (m.t === 's') {
      if (watch) c.ticks.push(performance.now()); // when each tick came (--stall)
      for (const e of m.p ?? []) c.seen.set(e[0], { x: e[2], y: e[3], z: e[4] });
      for (const e of m.k ?? []) c.bikes.set(e[0], Date.now()); // when each bike was last in a tick
      return;
    }
    log.push(m);
    if (m.t === 'respawn' && m.name === name && typeof m.x === 'number') c.at = { x: m.x, y: typeof m.y === 'number' ? m.y : c.at?.y ?? 0, z: m.z };
    if (m.t === 'spawn' && m.ok === false) c.at = { x: m.x, y: c.at?.y ?? 0, z: m.z };
  });
  await new Promise((res) => (ws.on('open', res), ws.on('error', res)));
  await sleep(300);
  return c;
};
const guest = async (name) => {
  await call('POST', '/api/lockouts', {}, adminCookie); // every guest joins from this one address: its limit lifted
  const { r } = await call('POST', '/api/join', { name, age: true });
  const c = await connect(name, cookieOf(r));
  c.join = cookieOf(r);
  return c;
};
const state = (c, p) => {
  c.at = { ...p };
  c.send({ t: 'state', x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), yaw: 0, pitch: 0, armed: true, w: 'pistol' });
};
/** Walk `c` from where it is towards (x, z) for `secs` at a run, ten honest steps a second. */
const walk = async (c, x, z, secs) => {
  const from = { ...c.at };
  const d = Math.hypot(x - from.x, z - from.z);
  const n = Math.min(Math.ceil(d / 0.34), secs * 10);
  for (let i = 1; i <= n; i++) {
    state(c, { x: from.x + ((x - from.x) * 0.34 * i) / d, y: from.y, z: from.z + ((z - from.z) * 0.34 * i) / d });
    await sleep(100);
  }
};
const lastMode = (c) => c.of('mode').at(-1)?.mode;
/** The host's countdown (10 s), then the game on the hall screen: waited for (a loaded computer can be a few seconds late). */
const started = async (is) => {
  const from = Date.now();
  while (Date.now() - from < 25_000 && !is(lastMode(hall) ?? {})) await sleep(250);
  console.log(`     on the hall screen ${((Date.now() - from) / 1000).toFixed(1)} s after Next`);
  await sleep(1200); // and every page's copy
};
const run = Math.random().toString(36).slice(2, 5);
const N = Math.max(8, Number(o.players));

await act({ op: 'reset' });
await act({ op: 'lock', on: false });
await act({ op: 'limit', max: 32 });
await act({ op: 'programme', list: [{ kind: 'flag', place: 'compact', minutes: 6, look: 'paint' }, { kind: 'assault', minutes: 2, look: 'paint' }, { kind: 'flag', place: 'village', minutes: 3, look: 'real' }] });
await act({ op: 'rewind', index: 0 }); // from its first game (an earlier run left the programme done)
const admin = await connect('admin', adminCookie);
state(admin, { x: 4.5, y: -0.1, z: 14 });
const hall = await connect('hall', adminCookie, true);
ok('the hall screen watches', hall.of('welcome').at(-1)?.watch === true);
const players = [];
for (let i = 0; i < N; i++) players.push(await guest(`gn${String(i).padStart(2, '0')}${run}`));
for (const p of players) state(p, { x: 4.5 + Math.random() * 4, y: -0.1, z: 16 + Math.random() * 4 });
ok(`${N} guests are in`, players.every((p) => p.of('welcome').length));
ok('the host deals two teams', (await act({ op: 'teams', count: 2 }))?.ok === true);
await sleep(500);

/** Everyone's team agrees: the game's, the evening's (the host's view and every page's), the hall screen's. */
const teamsAgree = async (label, here = players) => {
  await sleep(700);
  const v = await view();
  const evening = admin.of('eveningteams').at(-1)?.teams ?? {};
  const game = lastMode(admin)?.teams ?? {};
  const hallGame = lastMode(hall)?.teams ?? {};
  const want = (n) => (v.players.find((p) => p.name === n)?.team ?? null);
  const bad = here.filter((p) => !(game[p.name] && game[p.name] === want(p.name) && evening[p.name] === want(p.name) && hallGame[p.name] === game[p.name] && lastMode(p)?.teams?.[p.name] === game[p.name]));
  ok(`${label}: every player's team the same in the game, the evening, their own page and the hall screen`, !bad.length, bad.map((p) => `${p.name}:${game[p.name]}/${evening[p.name]}/${want(p.name)}/${hallGame[p.name]}`).join(' '));
  const blue = here.filter((p) => game[p.name] === 'blue').length;
  return { blue, red: here.length - blue, game };
};
/** Everyone where the server has them, at their base after a (re)start of the field: within its spots' reach. */
const atBases = (label, field, game, swapped = false, here = players) => {
  const bad = here.filter((p) => {
    const side = swapped ? (game[p.name] === 'blue' ? 'red' : 'blue') : game[p.name];
    if (!FIELDS[field].bases[side]) return true; // on no team
    const [sx, sz] = FIELDS[field].bases[side].stand;
    const s = admin.seen.get(p.name);
    return !s || Math.hypot(s.x - sx, s.z - sz) > 40 || !p.at || Math.hypot(p.at.x - s.x, p.at.z - s.z) > 2;
  });
  ok(`${label}: everyone at their base, the page where the server has them`, !bad.length, bad.map((p) => `${p.name} ${JSON.stringify(admin.seen.get(p.name))} page ${JSON.stringify(p.at)}`).join(' | '));
};

// ---- --stall: each game started from the host's controls (its countdown, then the game), a little played, stopped.
if (o.stall) {
  const TICK = 50;
  /** The longest the server held its ticks back between `from` and `to` (performance.now()): the gap less a tick. */
  const held = (from, to) => {
    const t = hall.ticks.filter((x) => x >= from && x <= to);
    let worst = 0;
    for (let i = 1; i < t.length; i++) worst = Math.max(worst, t[i] - t[i - 1] - TICK);
    return Math.round(worst);
  };
  const rows = [];
  const lines = () => hall.of('system').map((m) => m.code);
  const games = [
    { kind: 'assault', minutes: 1, is: (m) => !!m.flag?.assault },
    { kind: 'flag', place: 'compact', is: (m) => m.kind === 'flag' && m.flag?.field === 'compact' },
    { kind: 'flag', place: 'village', is: (m) => m.kind === 'flag' && m.flag?.field === 'village' },
    { kind: 'hide', is: (m) => m.kind === 'hide' },
    { kind: 'tag', is: (m) => m.kind === 'tag' },
    { kind: 'zombies', place: 'house', is: (m) => m.kind === 'zombies' },
    { kind: 'teams', is: (m) => m.kind === 'teams' },
    { kind: 'treasure', is: (m) => m.kind === 'treasure' },
  ];
  for (const e of games) {
    const label = `${e.kind}${e.place ? ` ${e.place}` : ''}`;
    if (o.only && !o.only.split(',').includes(e.kind)) continue;
    const { is, ...entry } = e;
    const t0 = performance.now();
    console.log(`     ${label}: started at ${new Date().toISOString().slice(11, 23)}`); // to match a server's own log
    ok(`${label}: the host starts it`, (await act({ op: 'start', ...entry }))?.ok === true);
    await started(is);
    const row = { game: label, countdown: held(t0, t0 + 9000), start: held(t0 + 9000, performance.now()) };
    if (e.kind === 'assault') {
      // Played through: round 1's clock, the break, round 2's clock, the end (its result, then free play).
      const at = (code) => new Promise((res) => {
        const from = Date.now();
        const look = () => (lines().includes(code) || Date.now() - from > 200_000 ? res(performance.now()) : setTimeout(look, 100));
        look();
      });
      const brk = await at('assaultBreak');
      const r2 = await at('assaultRound2');
      const end = await Promise.race(['assaultTime', 'assaultOnly', 'assaultFar', 'assaultTags', 'assaultDraw'].map(at));
      await sleep(2000);
      Object.assign(row, { break: held(brk - 1500, brk + 1500), round2: held(r2 - 1500, r2 + 1500), end: held(end - 1500, end + 1500) });
      ok('Attack and defend played through: its break, its second round and its end', lines().includes('assaultRound2'));
    } else await sleep(3000); // a little played
    const s0 = performance.now();
    await act({ op: 'stop' });
    await sleep(2000);
    row.stop = held(s0, performance.now());
    rows.push(row);
    console.log(`     ${label}: held ${JSON.stringify(row)} ms`);
  }
  console.log(`     the longest hold in a countdown, at a start, a round change, an end or a stop, ${N + 1} players and the hall screen (ms):`);
  console.table(rows);
  const worst = Math.max(...rows.flatMap((r) => Object.values(r).filter((v) => typeof v === 'number')));
  ok('no countdown, start, round change, end or stop holds the server over 50 ms', worst <= 50, `${worst} ms`);
  for (const p of [admin, hall, ...players]) p.ws.close();
  await act({ op: 'reset' });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
}

// ---- The host's Stop during a countdown calls it off: nothing starts, every page's countdown goes. A player can't.
const COUNTDOWN = 10_000;
const calledOff = async (label, was) => {
  const modes = hall.of('mode').length;
  ok(`${label}: a player's own Stop or Cancel is refused, the countdown still on`, (await Promise.all(['stop', 'cancel'].map((op) => call('POST', '/api/host', { op }, players[1].join)))).every((x) => x.r.status === 403) && !!(await view()).countdown);
  ok(`${label}: the host's Stop`, (await act({ op: 'stop' }))?.ok === true);
  await sleep(500);
  const bar = players.filter((p) => { const a = p.of('announce').at(-1); return !a || a.ms || a.text; });
  ok(`${label}: the countdown is gone, on the host page and on every page (its bar away)`, (await view()).countdown === null && !bar.length, `${bar.length} still counting`);
  await sleep(COUNTDOWN + 1500);
  const now = lastMode(hall)?.kind ?? 'free';
  ok(`${label}: and no game starts when it would have: free play`, now === 'free' && hall.of('mode').length === modes + (was === 'free' ? 0 : 1), `${now}, ${hall.of('mode').length - modes} mode changes`);
};
ok('Next starts a countdown', (await act({ op: 'next' }))?.ok === true && (await view()).countdown?.kind === 'flag');
await sleep(1000);
await calledOff('in free play', 'free');
await act({ op: 'rewind', index: 0 }); // the called-off game is next again

// ---- Steal the flag from the programme: Next, its countdown of ten seconds, then the game.
ok('Next starts the programme\'s first game after its countdown', (await act({ op: 'next' }))?.ok === true && players.every((p) => p.of('announce').some((m) => m.code === 'nextGame')));
await started((m) => m.kind === 'flag' && m.flag?.field === 'compact');
ok('Steal the flag is on for every page and the hall screen', [...players, hall].every((p) => lastMode(p)?.kind === 'flag' && lastMode(p)?.flag?.field === 'compact'));
let t = await teamsAgree('flag started');
ok('the teams are level', Math.abs(t.blue - t.red) <= 1, `${t.blue} blue, ${t.red} red`);
await sleep(300);
atBases('flag started', 'compact', t.game);

// Everyone runs a few seconds towards the middle: the server takes honest moves (none held back).
const mid = (() => {
  const [a, b] = [FIELDS.compact.bases.blue.stand, FIELDS.compact.bases.red.stand];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
})();
await Promise.all(players.map((p) => walk(p, mid[0], mid[1], 3)));
await sleep(400);
const held = players.filter((p) => {
  const s = admin.seen.get(p.name);
  return !s || Math.hypot(s.x - p.at.x, s.z - p.at.z) > 0.6;
});
ok('honest runs are taken as they are by the server', !held.length, held.map((p) => `${p.name} page ${p.at.x.toFixed(1)},${p.at.z.toFixed(1)} server ${JSON.stringify(admin.seen.get(p.name))}`).join(' | '));

// A player leaves for good, another's page reloads (a new connection under the same session), mid-round.
const gone = players.pop();
gone.ws.close();
const re = players[0];
const where = { ...admin.seen.get(re.name) };
re.ws.close();
await sleep(600);
const back = await connect(re.name, re.join);
players[0] = back;
await sleep(800);
const told = back.of('spawn').at(-1);
ok('a reloaded page is told where the server has them (where they were), on its team', !!told && told.ok === false && Math.hypot(told.x - where.x, told.z - where.z) < 0.6 && lastMode(back)?.teams?.[back.name] === t.game[back.name], JSON.stringify({ told, where }));
ok('and is neither moved nor respawned for it', !back.of('respawn').some((m) => m.name === back.name));
// A late joiner: the smaller team, at its base.
const late = await guest(`gnlate${run}`);
players.push(late);
await sleep(900);
t = await teamsAgree('a leaver, a reload and a late joiner');
ok('the teams still level', Math.abs(t.blue - t.red) <= 1, `${t.blue} blue, ${t.red} red`);
const lt = t.game[late.name];
ok('the late joiner starts at its base', !!late.at && Math.hypot(late.at.x - FIELDS.compact.bases[lt].stand[0], late.at.z - FIELDS.compact.bases[lt].stand[1]) < 40, `${lt} ${JSON.stringify(late.at)}`);

// The host moves a player (by a name typed with capitals) and swaps the sides.
const mover = players[2];
const was = t.game[mover.name];
ok('the host moves a player, typed with capitals', (await act({ op: 'move', name: mover.name.toUpperCase(), team: was === 'blue' ? 1 : 0 }))?.ok === true);
t = await teamsAgree('after a move');
ok('the moved player is on the other team, at its base', t.game[mover.name] !== was && !!mover.at && Math.hypot(mover.at.x - FIELDS.compact.bases[t.game[mover.name]].stand[0], mover.at.z - FIELDS.compact.bases[t.game[mover.name]].stand[1]) < 40);
ok('the host swaps the sides', (await act({ op: 'swap' }))?.ok === true);
await sleep(900);
ok('every page and the hall screen see the sides swapped', [...players, hall].every((p) => lastMode(p)?.flag?.swapped === true));
atBases('after the swap', 'compact', t.game, true);
await Promise.all(players.map((p) => walk(p, mid[0], mid[1], 2)));
await sleep(400);
ok('after the swap honest runs are taken', players.every((p) => Math.hypot(admin.seen.get(p.name).x - p.at.x, admin.seen.get(p.name).z - p.at.z) < 0.6));

// Ended early by the host: free play, the field's vehicles gone, everyone in their own colours, the evening's points.
const fieldBikes = lastMode(admin)?.flag?.vehicles?.bikes ?? [];
const bikesDuring = fieldBikes.filter((id) => hall.bikes.has(id)).length;
const stopAt = Date.now();
ok('Stop ends it', (await act({ op: 'stop' }))?.ok === true);
await sleep(3500); // a whole keyframe: every thing still there is in a tick
ok('free play on every page and the hall screen', [...players, hall].every((p) => lastMode(p)?.kind === 'free'));
const bikesAfter = fieldBikes.filter((id) => hall.bikes.get(id) > stopAt + 1000).length;
ok('the field\'s parked bikes are gone: in no tick after Stop (the hall screen\'s)', bikesDuring > 0 && bikesAfter === 0, `${bikesDuring} -> ${bikesAfter}`);
const colors = admin.of('colors').at(-1)?.list ?? [];
const own = (p) => p.of('welcome').at(-1)?.color;
const wrong = players.filter((p) => colors.find((c) => c.name === p.name)?.color !== own(p));
ok('everyone back in their own colour', !wrong.length, wrong.map((p) => `${p.name} ${colors.find((c) => c.name === p.name)?.color} not ${own(p)}`).join(' '));
let v = await view();
const sum = (team) => v.board.players.filter((p) => p.team === team).reduce((a, p) => a + p.points, 0);
ok('a stopped game gives no points', v.board.games === 0 && v.board.players.every((p) => p.points === 0), `${v.board.games} games`);

// Attack and defend straight after (Next), then Steal the flag on the whole village.
ok('Next: Attack and defend', (await act({ op: 'next' }))?.ok === true);
await started((m) => m.kind === 'flag' && !!m.flag?.assault);
const notOn = [...players, hall].filter((p) => !(lastMode(p)?.kind === 'flag' && lastMode(p)?.flag?.assault));
ok('Attack and defend is on for every page and the hall screen', !notOn.length, `${notOn.length} not: ${notOn.slice(0, 3).map((p) => `${p.name} ${lastMode(p)?.kind}`).join(', ')}; lines ${JSON.stringify(admin.log.filter((m) => m.t === 'system' || m.t === 'announce').slice(-4).map((m) => m.code ?? m.text))}`);
t = await teamsAgree('Attack and defend');
// The host queues the next game while this one runs, then thinks better of it: Stop ends this one and calls that off.
ok('Next during Attack and defend starts the next one\'s countdown', (await act({ op: 'next' }))?.ok === true && (await view()).countdown?.kind === 'flag');
await sleep(1000);
await calledOff('with Attack and defend on', 'assault');
await act({ op: 'rewind', index: 2 });
ok('Next: Steal the flag on the whole village', (await act({ op: 'next' }))?.ok === true);
await started((m) => m.kind === 'flag' && m.flag?.field === 'village');
ok('the village field is on, its own field, both flags home, not swapped', [...players, hall].every((p) => lastMode(p)?.flag?.field === 'village' && !lastMode(p)?.flag?.swapped && lastMode(p)?.flag?.flags.blue.at === 'home' && !lastMode(p)?.flag?.assault));
ok('no captures or tags carried over', lastMode(admin)?.score?.blue === 0 && lastMode(admin)?.score?.red === 0 && lastMode(admin)?.flag?.tags?.blue === 0);
t = await teamsAgree('the village field');
atBases('the village field', 'village', t.game);
// Played to its end by the clock would take minutes: the host's Stop again, then the evening's board.
await act({ op: 'stop' });
await sleep(900);
v = await view();
ok('each team\'s total is what its players scored on it', v.board.teams.every((tm) => tm.points === sum(tm.id)), JSON.stringify(v.board.teams.map((tm) => [tm.id, tm.points, sum(tm.id)])));
ok('the programme is done', v.next === 3);
ok('every page got every mode change the hall screen got', players.slice(1, -1).every((p) => p.of('mode').length >= 1) && hall.of('mode').length >= 1);

for (const p of [admin, hall, ...players]) p.ws.close();
await act({ op: 'reset' });
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
