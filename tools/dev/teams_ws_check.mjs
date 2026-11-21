// The team deathmatch (server/modes.mjs kind 'teams') played through, as a game night's host runs it (server/host.mjs,
// POST /api/host), against a throwaway game server (a build of this branch on this computer): the admin, the hall
// screen (the admin's watch view) and at least eight guests.
//
// Part 1, the game at the two houses: started from the host's programme (its countdown) with the evening's two teams,
// and from the admin's in-game menu without teams dealt (it deals them). Checked: everyone at their own team's start,
// every gun counting (the laser rifle too), the spawn protection; a kill of the other team one for the killer's team (the
// sniper rifle, a grenade, the admin's bazooka), a teammate never hurt, your own grenade never you; a player down back
// at their own team's start after the wait; the score the same on every page, the hall screen and the host page; the
// goal reached ending it with the right winner and the evening's points; the clock ending it; the host's Stop; straight
// into another game leaving nothing behind; a late joiner on the smaller team at its start; a leaver and a reloaded page
// back on their team with the score intact (the page told where the server has them); a car taking damage and its
// wreck's kill counting; a helicopter boarded and its wreck's kill counting.
//
// Part 2, the host's choice of starts (server/teamStarts.mjs): a named place for each team (the church square, the
// school), shown in the programme with the distance; the host's own spot ("Blue starts here"), taken from where the
// server has the admin and never from the page (a forged x and z in the call change nothing); a spot inside a code-locked
// home refused with its code; a player's own call refused (403, and over the socket nothing); everyone at the chosen
// start, spread, facing open ground; back there after a death; the fight on the school grounds counting; the game called
// "Team against team" with the evening's names; the open map (no edge round the houses traps a team).
//
//   ADMIN_PASSWORD=... node tools/dev/teams_ws_check.mjs --api http://localhost:8430 [--players 8] [--part 1|2]
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { localOnly, options } from './cdp.mjs';
import SPAWNS from '../../web/shared/spawns.json' with { type: 'json' };
import CARS from '../../web/shared/car.json' with { type: 'json' };
import HELI from '../../web/shared/heli.json' with { type: 'json' };
import { PORTALS } from '../../web/shared/portals.mjs';

const o = options({ api: 'http://localhost:8430', players: '8', part: '' });
localOnly(o.api); // it logs in as the admin and starts games: a throwaway server on this computer only
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');
const host = new URL(o.api).host;
let failed = 0;
const faults = [];
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
  if (!pass) {
    failed++;
    faults.push(name);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (method, path, body, cookie = '') => {
  const r = await fetch(o.api + path, { method, headers: { 'Content-Type': 'application/json', Origin: o.api, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  return { r, data: await r.json().catch(() => null) };
};
const cookieOf = (r) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const adminCookie = cookieOf((await call('POST', '/api/login', { username: 'admin', password })).r);
/** One host call, a little apart from the last (the host's own page sends one at a time). */
const act = async (b, cookie = adminCookie) => {
  await sleep(150);
  return (await call('POST', '/api/host', b, cookie)).data;
};
const view = async () => (await call('GET', '/api/host', null, adminCookie)).data;
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** A page's connection: its messages, where the server put it (`at`), and (the hall screen) where everyone is. */
const connect = async (name, cookie, watch = false) => {
  const log = [];
  const ws = new WebSocket(`ws://${host}/ws?v=2${watch ? '&watch=1' : ''}`, { headers: { Cookie: cookie, Origin: o.api } });
  const c = { name, ws, log, at: null, cookie, w: 'sniper', seen: new Map(), send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)), of: (t) => log.filter((m) => m.t === t) };
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 'ping') return ws.send(JSON.stringify({ t: 'pong', n: m.n }));
    if (m.t === 's') {
      for (const e of m.p ?? []) c.seen.set(e[0], { x: e[2], y: e[3], z: e[4] });
      return;
    }
    log.push(m);
    if (m.t === 'welcome' && !c.name) c.name = m.you;
    if (m.t === 'respawn' && m.name === c.name) {
      // As the page does (src/main.ts respawnAt): at x, z when given (y and the way to face too), else at spawn point `spawn`.
      const s = SPAWNS[m.spawn] ?? SPAWNS[0];
      c.at = typeof m.x === 'number' ? { x: m.x, y: typeof m.y === 'number' ? m.y : s.y, z: m.z, fx: m.fx, fz: m.fz } : { x: s.x, y: s.y, z: s.z };
      c.respawns = (c.respawns ?? 0) + 1;
    }
    if (m.t === 'spawn' && m.ok === false) c.at = { x: m.x, y: c.at?.y ?? -0.1, z: m.z };
  });
  await new Promise((res) => (ws.on('open', res), ws.on('error', res)));
  await sleep(400);
  return c;
};
const guest = async (name) => {
  await call('POST', '/api/lockouts', {}, adminCookie); // every guest joins from this one address: its limit lifted
  const { r } = await call('POST', '/api/join', { name, age: true });
  const c = await connect(name, cookieOf(r));
  c.join = cookieOf(r);
  return c;
};
/** The page's state where it is, armed with its gun. */
const state = (c, extra = {}) => {
  if (!c.at || c.hold) return;
  c.send({ t: 'state', x: +c.at.x.toFixed(2), y: +c.at.y.toFixed(2), z: +c.at.z.toFixed(2), yaw: c.yaw ?? 0, pitch: 0, armed: true, w: c.w, ct: Date.now(), ...extra });
};
/**
 * Walk `c` towards (x, z) at a run for at most `secs`, twenty honest steps a second (4.4 m/s); round the main house's
 * east side when the way would cross it (nobody without its code walks through it: the server holds them at its wall).
 */
const HOUSE_BOX = [-0.6, 9.6, -3.2, 12.6]; // round the main house's bands (shared/homes.mjs), its porch included
const CORNERS = [[-1.6, -4.2], [10.6, -4.2], [10.6, 13.6], [-1.6, 13.6]];
const crosses = (a, b) => {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  for (let s = 0; s <= d; s += 0.3) {
    const x = a[0] + ((b[0] - a[0]) * s) / (d || 1);
    const z = a[1] + ((b[1] - a[1]) * s) / (d || 1);
    if (x > HOUSE_BOX[0] && x < HOUSE_BOX[1] && z > HOUSE_BOX[2] && z < HOUSE_BOX[3]) return true;
  }
  return false;
};
const len = (pts) => pts.slice(1).reduce((n, p, i) => n + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
const walk = async (c, x, z, secs = 30) => {
  const a = [c.at.x, c.at.z];
  const b = [x, z];
  let way = [b];
  if (crosses(a, b)) {
    // Round the house by one corner, or two: the shortest way that crosses it nowhere.
    const ways = [...CORNERS.map((k) => [k, b]), ...CORNERS.flatMap((k, i) => [[k, CORNERS[(i + 1) % 4], b], [k, CORNERS[(i + 3) % 4], b]])];
    way = ways.filter((w) => [a, ...w].slice(1).every((p, i) => !crosses([a, ...w][i], p))).sort((u, v) => len([a, ...u]) - len([a, ...v]))[0] ?? [b];
  }
  for (const [px, pz] of way) await line(c, px, pz, secs);
};
const line = async (c, x, z, secs) => {
  for (let i = 0; i < secs * 20; i++) {
    const d = dist(c.at, { x, z });
    if (d < 0.05) break;
    const step = Math.min(d, 0.22);
    c.at = { ...c.at, x: c.at.x + ((x - c.at.x) / d) * step, z: c.at.z + ((z - c.at.z) / d) * step };
    state(c);
    await sleep(50);
  }
  for (let i = 0; i < 4; i++) {
    state(c);
    await sleep(50);
  }
};
const lastMode = (c) => c.of('mode').at(-1)?.mode;
const run = Math.random().toString(36).slice(2, 5);
const N = Math.max(8, Number(o.players));

const admin = await connect('admin', adminCookie);
const rules0 = admin.of('welcome').at(-1)?.rules ?? {};
admin.send({ t: 'rules', parachute: false }); // the teams game's respawns by parachute: these pages have nobody to land them
admin.at = { x: 4.5, y: -0.1, z: 14 };
state(admin);
const hall = await connect('', adminCookie, true);
ok('the hall screen watches', hall.of('welcome').at(-1)?.watch === true);
await act({ op: 'reset' });
await act({ op: 'lock', on: false });
await act({ op: 'limit', max: 32 });
await act({ op: 'teams', count: 0 });
const players = [];
for (let i = 0; i < N; i++) players.push(await guest(`tm${String(i).padStart(2, '0')}${run}`));
for (const p of players) {
  p.at = { x: 4.5 + Math.random() * 4, y: -0.1, z: 16 + Math.random() * 4 };
  state(p);
}
ok(`${N} guests are in`, players.every((p) => p.of('welcome').length));
/** Everyone (the admin too) sends their state a few times a second: the server holds who is armed and where. */
const everyone = () => [admin, ...players];
const beat = setInterval(() => everyone().forEach((c) => state(c)), 300);

/** Where the server has `c` now (the hall screen's ticks). */
const where = (c) => hall.seen.get(c.name);
/** The game's team of `c` (the hall screen's copy). */
const teamOf = (c) => lastMode(hall)?.teams?.[c.name];
/** The starts the game plays from, each a list of points: the two houses' start places, or the chosen spots. */
const DEFAULT = { house: SPAWNS.filter((s) => s.team === 'house'), bungalow: SPAWNS.filter((s) => s.team === 'bungalow') };
let starts = DEFAULT;
let reach = 25; // m from a start's point: at it
const atStart = (c, team = teamOf(c)) => {
  const s = where(c);
  return !!s && !!team && starts[team].some((q) => dist(s, q) < reach) && !!c.at && dist(c.at, s) < 1;
};
const allAtStart = (label, list = players) => {
  const bad = list.filter((c) => !atStart(c));
  ok(`${label}: everyone at their own team's start, their page where the server has them`, !bad.length, bad.map((c) => `${c.name}:${teamOf(c)} ${JSON.stringify(where(c))} page ${JSON.stringify(c.at)}`).join(' | '));
};
/** Every page, the hall screen and the host page agree on the score. */
const scoresAgree = async (label) => {
  await sleep(400);
  const want = JSON.stringify(lastMode(hall)?.score);
  const v = await view();
  const bad = [admin, ...players].filter((c) => c.ws.readyState === 1 && JSON.stringify(lastMode(c)?.score) !== want);
  ok(`${label}: the score the same on every page, the hall screen and the host page (${want})`, !bad.length && JSON.stringify(v.mode.score) === want, bad.map((c) => `${c.name} ${JSON.stringify(lastMode(c)?.score)}`).join(' '));
};
/** The game starts: from the host's countdown (or at once), waited for on the hall screen. */
const started = async (is = (m) => m.kind === 'teams' && m.phase === 'playing') => {
  const from = Date.now();
  while (Date.now() - from < 25_000 && (!is(lastMode(hall) ?? {}) || (await view()).countdown)) await sleep(200); // the host's countdown over too
  await sleep(1500);
  return (Date.now() - from) / 1000;
};
/** Two players of the other team than `c`, and of its own. */
const foes = (c) => players.filter((p) => p !== c && teamOf(p) && teamOf(p) !== teamOf(c));
const mates = (c) => players.filter((p) => p !== c && teamOf(p) && teamOf(p) === teamOf(c));
/** `by` shoots `target` once with gun `w`; true when the server took it (`target` hurt or down). */
const shoot = async (by, target, w = 'sniper') => {
  by.w = w;
  state(by);
  await sleep(120);
  const h = target.of('hurt').length;
  const k = target.of('kill').filter((m) => m.victim === target.name).length;
  by.send({ t: 'hit', target: target.name, w, body: 1, head: 0 });
  await sleep(400);
  return target.of('hurt').length > h || target.of('kill').filter((m) => m.victim === target.name).length > k;
};
const downs = (c) => c.of('kill').filter((m) => m.victim === c.name);
/** Shooters to a spot in range of both starts (the server's hits reach 120 m), on foot. */
const midway = (a, b) => ({ x: a.x + (b.x - a.x) * 0.45, z: a.z + (b.z - a.z) * 0.45 });

async function partOne() {
  // ---- 1. From the host's programme, with the evening's two teams: Next, its countdown, then the game.
  ok('the host deals two teams', (await act({ op: 'teams', count: 2 }))?.ok === true);
  ok('the host plans the teams game', (await act({ op: 'programme', list: [{ kind: 'teams', minutes: 8, goal: 15 }, { kind: 'teams', minutes: 1, goal: 50 }] }))?.ok === true);
  await act({ op: 'rewind', index: 0 });
  ok('Next starts its countdown', (await act({ op: 'next' }))?.ok === true && (await view()).countdown?.kind === 'teams');
  const s1 = await started();
  console.log(`     on the hall screen ${s1.toFixed(1)} s after Next`);
  const m = lastMode(hall);
  ok('the teams game is on for every page and the hall screen', [admin, ...players].every((c) => lastMode(c)?.kind === 'teams' && lastMode(c)?.phase === 'playing'), JSON.stringify({ title: m?.title, colors: m?.colors, goal: m?.goal }));
  console.log(`     the game's title "${m?.title}", its colours ${JSON.stringify(m?.colors)}, its names ${JSON.stringify(m?.names ?? null)}, the start line: ${JSON.stringify(admin.of('system').filter((x) => /^teams/.test(x.code ?? '')).at(-1))}`);
  const v = await view();
  const evening = admin.of('eveningteams').at(-1)?.teams ?? {};
  const wrong = players.filter((p) => (teamOf(p) === 'house' ? 'blue' : 'red') !== evening[p.name]);
  ok('everyone plays for their evening team: blue at the house, red at the bungalow', !wrong.length, wrong.map((p) => `${p.name} ${teamOf(p)}/${evening[p.name]}`).join(' '));
  ok('the admin plays on a team too', !!teamOf(admin), teamOf(admin));
  await sleep(300);
  allAtStart('started from the programme');
  const spotsUsed = new Set(players.map((p) => `${where(p)?.x.toFixed(1)},${where(p)?.z.toFixed(1)}`)).size;
  console.log(`     ${players.length} players on ${spotsUsed} distinct places`);
  ok('the players of a team are spread, never two on one spot', spotsUsed === players.length, `${spotsUsed} places for ${players.length}`);
  ok('the score starts at 0 to 0', JSON.stringify(m?.score) === JSON.stringify({ house: 0, bungalow: 0 }) && v.mode.goal === 15, JSON.stringify(v.mode.score));

  // A shooter of the house's team halfway to the other start (the spawn protection is checked after a death, below).
  const [a] = players.filter((p) => teamOf(p) === 'house');
  const [b] = foes(a);
  await walk(a, ...Object.values(midway(where(a), where(b))), 30);
  // Every gun counts against the other team (out of protection by now): the pistol, the rifle, the shotgun, the laser.
  await sleep(500);
  const guns = [];
  for (const w of ['pistol', 'rifle', 'shotgun', 'laser']) {
    const t = players.find((p) => teamOf(p) !== teamOf(a) && p.of('kill').every((k) => k.victim !== p.name));
    guns.push([w, await shoot(a, t, w)]);
    await sleep(900);
  }
  ok('every gun hits the other team: the pistol, the rifle, the shotgun and the laser rifle', guns.every(([, x]) => x), JSON.stringify(guns));
  // A teammate is never hurt.
  ok('a teammate is never hurt', !(await shoot(a, mates(a)[0], 'sniper')));
  await sleep(1000);
  // A kill of the other team (the sniper rifle) counts one for the killer's team.
  const before = { ...lastMode(hall).score };
  const victim = foes(a)[1] ?? foes(a)[0];
  const t0 = Date.now();
  ok('the sniper rifle downs one of the other team', await shoot(a, victim, 'sniper') && downs(victim).length > 0);
  await sleep(300);
  const after = lastMode(hall).score;
  ok('the kill counts one for the killer\'s team, none for the other', after[teamOf(a)] === before[teamOf(a)] + 1 && after[teamOf(victim)] === before[teamOf(victim)], `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  await scoresAgree('after a kill');
  // Down: back at their own team's start after the wait (3 s), never at the other team's.
  const back0 = victim.respawns ?? 0;
  while (Date.now() - t0 < 6000 && (victim.respawns ?? 0) === back0) await sleep(100);
  const waited = (Date.now() - t0) / 1000;
  await sleep(300);
  ok(`the one down is back at their own team's start after ${waited.toFixed(1)} s`, (victim.respawns ?? 0) > back0 && atStart(victim) && waited >= 2.8, JSON.stringify(where(victim)));
  // Just back: protected for two seconds, then fair game.
  await sleep(1000);
  ok('just back, a hit counts for nothing (spawn protection)', !(await shoot(a, victim, 'pistol')));
  await sleep(2000);
  ok('two seconds later it counts', await shoot(a, victim, 'pistol'));
  await sleep(1000);

  // A grenade: thrown at a foe two metres off, it downs them; the thrower's team gets the point. Your own spares you.
  const nadeKill = async (by, target) => {
    // There honestly, on foot, from where they are: next to the target.
    const to = { x: where(target).x + 1.5, z: where(target).z };
    by.at = { ...where(by) };
    await walk(by, to.x, to.z, 60);
    const s = where(by);
    by.send({ t: 'nade', x: s.x, y: s.y + 1.5, z: s.z, vx: -1.5, vy: 1, vz: 0 });
    await sleep(2300);
    const ts = where(target);
    by.send({ t: 'boom', x: ts.x, y: ts.y + 0.9, z: ts.z, cover: [] });
    await sleep(500);
  };
  const g = a; // halfway already
  const gv = foes(g).find((p) => p !== victim) ?? foes(g)[0];
  const sc0 = { ...lastMode(hall).score };
  const d0 = downs(gv).length;
  const gd0 = downs(g).length;
  const b0 = g.of('blast').length;
  await nadeKill(g, gv);
  const nadeDowns = players.filter((p) => p.of('kill').some((k) => k.victim === p.name && k.w === 'grenade' && k.killer === g.name)).length;
  ok('a grenade downs one of the other team, a point the thrower\'s team\'s for each', downs(gv).length > d0 && downs(gv).at(-1)?.w === 'grenade' && lastMode(hall).score[teamOf(g)] === sc0[teamOf(g)] + nadeDowns, `${JSON.stringify(downs(gv).at(-1))} ${JSON.stringify(sc0)} -> ${JSON.stringify(lastMode(hall).score)}; blast ${JSON.stringify(g.of('blast').slice(b0))}; thrower ${JSON.stringify(where(g))} target ${JSON.stringify(where(gv))}`);
  ok('the thrower is not hurt by their own grenade', downs(g).length === gd0 && !g.of('hurt').some((h) => h.by === g.name));
  // The admin's bazooka (the admin has it): a rocket at a foe.
  const av = foes(admin)[0];
  await walk(admin, where(av).x + 8, where(av).z, 60);
  admin.w = 'bazooka';
  state(admin);
  await sleep(2500); // the foe out of any protection
  const sc1 = { ...lastMode(hall).score };
  const ad0 = downs(av).length;
  const ts = where(av);
  admin.send({ t: 'rocket', tx: ts.x, ty: ts.y + 0.9, tz: ts.z });
  await sleep(1200);
  const blasted = players.filter((p) => p.of('kill').some((k) => k.victim === p.name && k.w === 'bazooka' && k.killer === admin.name)).length;
  ok('the bazooka downs one of the other team (and any foe beside them), a point the admin\'s team\'s for each', downs(av).length > ad0 && downs(av).at(-1)?.w === 'bazooka' && lastMode(hall).score[teamOf(admin)] === sc1[teamOf(admin)] + blasted, `${teamOf(admin)} ${JSON.stringify(downs(av).at(-1))} ${JSON.stringify(sc1)} -> ${JSON.stringify(lastMode(hall).score)}`);
  admin.w = 'sniper';

  // A late joiner: the smaller team, at its start. A leaver and a reloaded page: back on their team, the score as it was.
  const late = await guest(`tmlate${run}`);
  late.at ??= { x: 4.5, y: -0.1, z: 19 }; // where the server put it (its respawn), else the lane
  players.push(late);
  await sleep(1200);
  const counts = (list) => list.reduce((c, p) => ((c[teamOf(p)] = (c[teamOf(p)] ?? 0) + 1), c), {});
  const n = counts(players.filter((p) => p !== late));
  ok('a late joiner goes to the smaller team (or either when level), at its start', !!teamOf(late) && (n.house === n.bungalow || n[teamOf(late)] < n[teamOf(late) === 'house' ? 'bungalow' : 'house']) && atStart(late), `${JSON.stringify(n)} -> ${teamOf(late)} ${JSON.stringify(where(late))}`);
  const ri = players.findIndex((p) => p !== a && teamOf(p) === 'bungalow'); // not the shooter: it fights on below
  const re = players[ri];
  const reTeam = teamOf(re);
  const reAt = { ...where(re) };
  const score0 = JSON.stringify(lastMode(hall).score);
  re.ws.close();
  await sleep(700);
  const back = await connect(re.name, re.join);
  back.join = re.join;
  back.at = { x: 4.5, y: -0.1, z: 19 }; // a reloaded page starts in the lane in front of the house (src/main.ts)
  players[ri] = back;
  await sleep(1000);
  const told = back.of('spawn').at(-1);
  ok('a reloaded page is back on its team, the score as it was', teamOf(back) === reTeam && JSON.stringify(lastMode(back)?.score) === score0, `${teamOf(back)} ${JSON.stringify(lastMode(back)?.score)}`);
  ok('and is told where the server has them (it starts in the lane otherwise)', !!told && told.ok === false && Math.hypot(told.x - reAt.x, told.z - reAt.z) < 1, JSON.stringify({ told, reAt }));
  if (!told) back.at = { ...reAt };
  const li = players.findIndex((p, i) => p !== a && i !== ri);
  const leaver = players[li];
  const lTeam = teamOf(leaver);
  leaver.ws.close();
  await sleep(1500);
  const lb = await connect(leaver.name, leaver.join);
  lb.join = leaver.join;
  lb.at = lb.of('spawn').at(-1) ? { x: lb.of('spawn').at(-1).x, y: -0.1, z: lb.of('spawn').at(-1).z } : { ...where(leaver) ?? { x: 4.5, y: -0.1, z: 19 } };
  players[li] = lb;
  await sleep(800);
  ok('a player who left and comes back is on their team again', teamOf(lb) === lTeam, `${lTeam} -> ${teamOf(lb)}`);

  // A car: a driver of the other team in the Tesla, honest rifle hits until it goes up; the kill and the point the shooter's.
  await carKill();
  // A helicopter: boarded in the teams game, then brought down with its rider.
  await heliKill();

  // The goal: the shooter's team on to 5, the game over with the right winner and the evening's points.
  const shooter = a;
  shooter.at = { ...where(shooter) };
  const want = teamOf(shooter);
  for (let i = 0; i < 40 && lastMode(hall).phase === 'playing'; i++) {
    const t = foes(shooter).filter((p) => p.ws.readyState === 1).sort((x, y) => dist(where(shooter), where(x)) - dist(where(shooter), where(y)))[i % 2];
    if (dist(where(shooter), where(t)) > 110) await walk(shooter, ...Object.values(midway(where(shooter), where(t))), 30);
    await sleep(1200);
    await shoot(shooter, t, 'sniper');
  }
  await sleep(800);
  const end = lastMode(hall);
  const line = hall.of('system').at(-1);
  ok('the goal reached ends it with the shooter\'s team the winner', end.phase === 'done' && end.resultCode === 'teamWon' && end.resultArgs?.team === (end.names?.[want] ?? want), JSON.stringify({ phase: end.phase, code: end.resultCode, args: end.resultArgs, result: end.result }));
  console.log(`     the result line: ${JSON.stringify(line)}`);
  const vb = (await view()).board;
  const winners = players.filter((p) => p.ws.readyState === 1 && teamOf(p) === want);
  const losers = players.filter((p) => p.ws.readyState === 1 && teamOf(p) && teamOf(p) !== want);
  const pts = (p) => vb.players.find((x) => x.name === p.name)?.points ?? 0;
  ok('the evening\'s points: 4 to each winner, 1 to each loser', winners.every((p) => pts(p) === 4) && losers.every((p) => pts(p) === 1), `${winners.map(pts).join(',')} / ${losers.map(pts).join(',')}`);
  console.log(`     the teams' totals: ${JSON.stringify(vb.teams.map((t) => [t.id, t.points]))}`);
  // Its result shown, then free play: everyone in their own colour.
  const f0 = Date.now();
  while (Date.now() - f0 < 15_000 && lastMode(hall).kind !== 'free') await sleep(200);
  ok('free play once its result has shown', lastMode(hall).kind === 'free');

  // ---- 2. The clock: the next one in the programme (a minute, goal 50) ends at time with the leader or a draw.
  ok('Next: the one-minute game', (await act({ op: 'next' }))?.ok === true);
  await started();
  allAtStart('the second game');
  const c0 = Date.now();
  while (Date.now() - c0 < 75_000 && lastMode(hall).phase === 'playing') await sleep(500);
  const tm = lastMode(hall);
  ok('the time running out ends it: a draw at 0 to 0', tm.phase === 'done' && tm.resultCode === 'teamsDraw', JSON.stringify({ code: tm.resultCode, args: tm.resultArgs }));
  await act({ op: 'stop' });
  await sleep(1000);

  // ---- 3. From the admin's in-game menu without teams dealt: it deals them (and they become the evening's).
  ok('the host sets no teams', (await act({ op: 'teams', count: 0 }))?.ok === true);
  admin.send({ t: 'mode', kind: 'teams' });
  await started();
  const dealt = counts(players);
  ok('started from the in-game menu without teams: everyone dealt, as evenly as can be', Math.abs((dealt.house ?? 0) - (dealt.bungalow ?? 0)) <= 1 && !dealt.undefined, JSON.stringify(dealt));
  const ev = (await view()).teams.count;
  ok('and the deal becomes the evening\'s two teams', ev === 2);
  allAtStart('started from the in-game menu');
  // The host's Stop ends it.
  ok('the host\'s Stop', (await act({ op: 'stop' }))?.ok === true);
  await sleep(1200);
  ok('Stop ends it: free play on every page and the hall screen', [hall, ...players].every((c) => c.ws.readyState !== 1 || lastMode(c)?.kind === 'free'));
  const colors = admin.of('colors').at(-1)?.list ?? [];
  const own = (p) => p.of('welcome').at(-1)?.color;
  const wrongC = players.filter((p) => p.ws.readyState === 1 && colors.find((c) => c.name === p.name)?.color !== own(p));
  ok('everyone back in their own colour', !wrongC.length, wrongC.map((p) => p.name).join(' '));
  // Straight into another game: the teams game started, then hide and seek over it.
  admin.send({ t: 'mode', kind: 'teams' });
  await started();
  admin.send({ t: 'mode', kind: 'tag' });
  await started((x) => x.kind === 'tag');
  const left = lastMode(hall);
  const colors2 = admin.of('colors').at(-1)?.list ?? [];
  ok('straight into another game leaves nothing behind: no teams, no score, own colours', left.kind === 'tag' && !left.teams && !left.score && players.every((p) => p.ws.readyState !== 1 || colors2.find((c) => c.name === p.name)?.color === own(p)), JSON.stringify({ teams: left.teams, score: left.score }));
  await act({ op: 'stop' });
  await sleep(1000);
}

/** A car's wreck in the teams game: a driver of the other team, the shooter behind the Tesla. */
async function carKill() {
  const PARK = CARS.cars.tesla.park;
  // A driver out of every fight (no seat within 10 s of a hit: game.mjs fightRefused): the one hurt longest ago.
  const calm = (p) => Math.max(0, ...p.log.map((m, i) => (m.t === 'hurt' || (m.t === 'kill' && m.victim === p.name) ? i : 0)));
  const dr = players.filter((p) => p.ws.readyState === 1 && teamOf(p) === 'bungalow').sort((x, y) => calm(x) - calm(y))[0];
  const gun = players.find((p) => p.ws.readyState === 1 && teamOf(p) === 'house');
  if (!dr || !gun) return ok('a driver and a shooter on opposite teams', false);
  dr.at = { ...where(dr) };
  gun.at = { ...where(gun) };
  await Promise.all([walk(dr, PARK.x - 1.5, PARK.z, 60), walk(gun, PARK.x, PARK.z + 12, 60)]);
  for (let i = 0; i < 12 && !dr.log.some((m) => m.t === 'car' && m.car?.driver === dr.name || m.t === 'car' && m.driver === dr.name); i++) {
    dr.send({ t: 'car', op: 'in', id: 'tesla' });
    await sleep(1000);
  }
  console.log(`     the driver's last car message: ${JSON.stringify(dr.of('car').at(-1))?.slice(0, 200)}`);
  gun.yaw = 0;
  gun.w = 'rifle';
  state(gun);
  const sc = { ...lastMode(hall).score };
  const k0 = downs(dr).length;
  let hits = 0;
  for (let i = 0; i < 60 && downs(dr).length === k0; i++) {
    state(gun);
    gun.send({ t: 'vhit', kind: 'car', id: 'tesla', w: 'rifle', n: 1 });
    hits += gun.of('vdmg').length ? 1 : 0;
    await sleep(110);
  }
  await sleep(600);
  ok('a car takes damage in the teams game', gun.of('vdmg').some((m) => m.id === 'tesla'));
  ok('its wreck downs the driver of the other team, the point the shooter\'s team\'s', downs(dr).length > k0 && downs(dr).at(-1)?.w === 'wreck' && lastMode(hall).score.house === sc.house + 1, `${JSON.stringify(downs(dr).at(-1))} ${JSON.stringify(sc)} -> ${JSON.stringify(lastMode(hall).score)}`);
  gun.yaw = 0;
  gun.w = 'sniper';
}

/** A helicopter in the teams game: boarded by a player, brought down by the other team. */
async function heliKill() {
  const pad = HELI.pads[0];
  const calm = (p) => Math.max(0, ...p.log.map((m, i) => (m.t === 'hurt' || (m.t === 'kill' && m.victim === p.name) ? i : 0)));
  const pilot = players.filter((p) => p.ws.readyState === 1 && teamOf(p) === 'bungalow').sort((x, y) => calm(x) - calm(y))[0] ?? players[0];
  const gun = players.find((p) => p.ws.readyState === 1 && teamOf(p) === 'house');
  pilot.at = { ...where(pilot) };
  gun.at = { ...where(gun) };
  const side = { x: pad.x + 1.5 * Math.cos(pad.yaw) - 0.4 * Math.sin(pad.yaw), z: pad.z - 1.5 * Math.sin(pad.yaw) - 0.4 * Math.cos(pad.yaw) };
  await Promise.all([walk(pilot, side.x, side.z, 60), walk(gun, pad.x, pad.z + 14, 60)]);
  const reached = dist(where(pilot), side) < 1;
  pilot.send({ t: 'heli', op: 'in', id: pad.id, seat: 0 });
  await sleep(700);
  const ans = pilot.of('heli').at(-1);
  const aboard = !!ans?.heli?.seats?.includes(pilot.name);
  ok('a helicopter can be boarded in the teams game', aboard, `${reached ? '' : `the pad out of reach (the server held them at ${JSON.stringify(where(pilot))}); `}${JSON.stringify({ code: pilot.of('system').at(-1)?.code ?? ans?.code, seats: ans?.heli?.seats })}`);
  if (!aboard) return ok('a helicopter\'s wreck downs its rider of the other team', false, 'not boarded');
  gun.yaw = 0;
  gun.w = 'rifle';
  const sc = { ...lastMode(hall).score };
  const k0 = downs(pilot).length;
  for (let i = 0; i < 80 && downs(pilot).length === k0; i++) {
    state(gun);
    gun.send({ t: 'vhit', kind: 'heli', id: pad.id, w: 'rifle', n: 1 });
    await sleep(110);
  }
  await sleep(600);
  ok('a helicopter\'s wreck downs its rider of the other team, the point the shooter\'s team\'s', downs(pilot).length > k0 && downs(pilot).at(-1)?.w === 'wreck' && lastMode(hall).score.house === sc.house + 1, `${JSON.stringify(downs(pilot).at(-1))} ${JSON.stringify(sc)} -> ${JSON.stringify(lastMode(hall).score)}`);
  gun.w = 'sniper';
}

/** The admin through a portal from the chat (the admin always may, outside a game), put where the server says. */
const trip = async (c, id) => {
  c.hold = true; // no state of the page's meanwhile: the server's place after the trip, its height too, is taken as it is
  const n = c.of('travel').length;
  c.send({ t: 'travel', to: id, via: 'chat' });
  await sleep(1500);
  const ok1 = c.of('travel').slice(n).at(-1);
  if (ok1?.ok && where(c)) c.at = { ...where(c) };
  c.hold = false;
  return !!ok1?.ok;
};

async function partTwo() {
  ok('the host deals two teams', (await act({ op: 'teams', count: 2 }))?.ok === true);
  const guestCookie = players[3].join;
  // ---- A player's own calls are refused: over the host's API (403) and over the socket (nothing changes, nothing told).
  const before = JSON.stringify((await view()).starts.now);
  const asGuest = await Promise.all([{ op: 'mark', team: 'blue' }, { op: 'starts', blue: 'church', red: 'school' }].map((b) => call('POST', '/api/host', b, guestCookie)));
  ok('a player\'s own call to set a start is refused (403)', asGuest.every((x) => x.r.status === 403), asGuest.map((x) => x.r.status).join(','));
  const g3 = players[3];
  const sys0 = g3.of('system').length;
  g3.send({ t: 'teamstart', team: 'blue' });
  await sleep(500);
  ok('a player\'s own socket message changes no start and tells them nothing', JSON.stringify((await view()).starts.now) === before && !g3.of('system').slice(sys0).some((m) => /^start|teamStart/.test(m.code ?? '')), before);

  // ---- A spot inside a code-locked home: refused with its code (the admin may stand in the main house; a team may not).
  admin.at = { ...where(admin) };
  await walk(admin, 4.5, 19, 60);
  await line(admin, 4.5, 7, 10); // in through the front: the admin may
  await sleep(400);
  const inHome = await act({ op: 'mark', team: 'red' });
  ok('the host\'s spot inside the main house is refused, with its code', inHome?.code === 'startHome', `${JSON.stringify(inHome)} at ${JSON.stringify(where(admin))}`);
  const sys1 = admin.of('system').length;
  admin.send({ t: 'teamstart', team: 'red' });
  await sleep(500);
  ok('the same from the in-game menu: refused, its code told to the admin\'s page alone', admin.of('system').slice(sys1).some((m) => m.code === 'startHome') && !players[0].of('system').some((m) => m.code === 'startHome'));
  await line(admin, 4.5, 19, 10);

  // ---- Named places: blue at the church square, red at the school; shown with the distance.
  ok('the host picks named places: blue at the church square, red at the school', (await act({ op: 'starts', blue: 'church', red: 'school' }))?.ok === true);
  let v = await view();
  ok('tonight\'s starts are kept and shown', v.starts.now.blue === 'church' && v.starts.now.red === 'school', JSON.stringify(v.starts.now));
  // ---- The host's own spot: at the school's playground, 12 m from its portal, a forged position in the call ignored.
  ok('the admin goes to the school (a trip from the chat)', await trip(admin, 'school'));
  await walk(admin, admin.at.x + 10, admin.at.z - 8, 10); // onto the open playground
  await sleep(500);
  const here = { ...where(admin) };
  const mk = await act({ op: 'mark', team: 'red', x: 4.5, z: 6, y: 0 });
  ok('"Red starts here": the spot where the server has the admin, never the call\'s', mk?.ok && Math.hypot(mk.mark.x - here.x, mk.mark.z - here.z) < 0.6 && mk.mark.near === 'school', `${JSON.stringify(mk)} admin ${JSON.stringify(here)}`);
  v = await view();
  ok('red\'s start is the new spot tonight', v.starts.now.red === mk?.mark?.id && v.starts.marks.some((m) => m.id === mk?.mark?.id));
  const plan = await act({ op: 'programme', list: [{ kind: 'teams', minutes: 3, goal: 30, blue: 'church', red: mk?.mark?.id }, { kind: 'teams', blue: 'atlantis', red: 'school' }] });
  v = await view();
  ok('the programme keeps the entry\'s starts, and leaves out one at an unknown place', plan?.ok && v.programme.length === 1 && v.programme[0].blue === 'church' && v.programme[0].red === mk?.mark?.id, JSON.stringify(v.programme));
  await act({ op: 'rewind', index: 0 });
  starts = {
    house: [START('church')],
    bungalow: [{ x: mk?.mark?.x, z: mk?.mark?.z }],
  };
  reach = 14;

  // ---- Next: the countdown says Team against team; then everyone at their own chosen start, spread, facing open ground.
  ok('Next starts its countdown', (await act({ op: 'next' }))?.ok === true);
  await sleep(600);
  ok('the countdown names it Team against team on every page', players.every((p) => p.of('announce').at(-1)?.args?.kind === 'teamvteam'), JSON.stringify(players[0].of('announce').at(-1)));
  await started();
  const m = lastMode(hall);
  ok('Team against team is on: its title, the evening\'s names, where each starts', m.title === 'Team against team' && m.open === true && m.names?.house === 'blue' && m.names?.bungalow === 'red' && m.starts?.house?.place === 'church' && m.starts?.bungalow?.spot === true && m.starts?.bungalow?.place === 'school', JSON.stringify({ title: m.title, names: m.names, starts: m.starts }));
  const startLine = hall.of('system').filter((x) => x.code === 'teamvteamStarted').at(-1);
  ok('one line names each team\'s start', startLine?.args?.place === 'church' && startLine?.args?.place2 === 'near.school' && startLine?.args?.team === 'blue', JSON.stringify(startLine));
  console.log(`     the start line: ${startLine?.text}`);
  await sleep(300);
  allAtStart('Team against team started', everyone());
  const places = new Set(everyone().map((c) => `${where(c)?.x},${where(c)?.z}`));
  ok('the players of a team are spread, never two on one place', places.size === everyone().length, `${places.size} for ${everyone().length}`);
  const faced = everyone().filter((c) => Number.isFinite(c.at?.fx) && Number.isFinite(c.at?.fz) && Math.hypot(c.at.fx - c.at.x, c.at.fz - c.at.z) > 5);
  ok('each told the way to face (open ground)', faced.length === everyone().length, `${faced.length} of ${everyone().length}`);
  console.log(`     the distance between the two starts: ${m.starts?.m} m`);

  // ---- The open map: nobody is held to the houses' edge; no trip during it.
  const trav = players[0];
  trav.send({ t: 'travel', to: 'football', via: 'chat' });
  await sleep(700);
  ok('no trip during it (the other team\'s start is reached on foot, by bike or by car)', trav.of('travel').at(-1)?.code === 'travelGame', JSON.stringify(trav.of('travel').at(-1)));
  ok('the open map: every player stays at their start far from the houses, none held to the edge round them', everyone().every((c) => Math.hypot(where(c).x - 40, where(c).z - 90) > 600));

  // ---- The fight on the school grounds counts (red's start is on them), a kill there one for blue; back at red's start.
  await sleep(1500);
  const shooter = players.find((p) => teamOf(p) === 'house');
  const target = players.find((p) => teamOf(p) === 'bungalow');
  shooter.at = { ...where(shooter) };
  await walk(shooter, where(target).x + 30, where(target).z + 10, 30);
  await sleep(500);
  const s0 = { ...lastMode(hall).score };
  ok('a hit on the school grounds counts in Team against team', await shoot(shooter, target, 'sniper'));
  await sleep(300);
  ok('the kill counts one for blue', lastMode(hall).score.house === s0.house + 1, `${JSON.stringify(s0)} -> ${JSON.stringify(lastMode(hall).score)}`);
  const r0 = target.respawns ?? 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 6000 && (target.respawns ?? 0) === r0) await sleep(100);
  await sleep(300);
  ok('the one down is back at red\'s own start, spread', atStart(target, 'bungalow') && !atStart(target, 'house'), JSON.stringify(where(target)));
  await scoresAgree('Team against team');
  // A late joiner: the smaller team, at its chosen start.
  const late = await guest(`tmlat2${run}`);
  late.at ??= { x: 4.5, y: -0.1, z: 19 };
  players.push(late);
  await sleep(1200);
  ok('a late joiner starts at their team\'s chosen start', atStart(late), `${teamOf(late)} ${JSON.stringify(where(late))}`);

  // ---- Stopped: the next game at the houses is House against bungalow again, its start line the old one.
  ok('the host\'s Stop', (await act({ op: 'stop' }))?.ok === true);
  await sleep(1200);
  ok('free play', lastMode(hall).kind === 'free');
  ok('the host sets the starts back to the two houses', (await act({ op: 'starts', blue: 'house', red: 'bungalow' }))?.ok === true);
}
const START = (id) => {
  const p = PORTALS.find((q) => q.id === id);
  return { x: p.out[0], z: p.out[1] };
};

try {
  if (o.part !== '2') await partOne();
  if (o.part !== '1') await partTwo();
} catch (e) {
  ok('the check ran through', false, String(e?.stack ?? e));
} finally {
  clearInterval(beat);
  admin.send({ t: 'rules', parachute: rules0.parachute !== false });
  await act({ op: 'stop' });
  await act({ op: 'reset' });
  await sleep(300);
  for (const c of [admin, hall, ...players]) c.ws.close();
}
console.log(failed ? `${failed} failed:\n  - ${faults.join('\n  - ')}` : 'all passed');
process.exit(failed ? 1 : 0);
