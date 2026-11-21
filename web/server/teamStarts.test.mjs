import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Game } from './game.mjs';
import { HOMES, distanceToHome, homeAt, END_GARDEN } from '../shared/homes.mjs';
import { MIN_ROOM, START_PLACES } from './teamStarts.mjs';

// The teams game's starts (server/teamStarts.mjs, server/host.mjs mark and teamStarts): every named place has room for a
// team, outside every locked home; the host's own spot is checked where the server has the admin (a forged position in
// the call changes nothing), refused inside a home, its garden, the water, outside the map or off the ground; a player's
// own call changes nothing; the game played from them puts each team at its start, spread, back there after a death,
// on the open map with no trip, under the evening's names.

const houseData = (f) => JSON.parse(readFileSync(new URL(`../src/data/${f}`, import.meta.url), 'utf8'));

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const store = { addStats: async () => {}, setMeta: async () => {}, getMeta: async () => null };
  const game = new Game({ session: () => null, store, log: () => {} }, [], null);
  for (const t of game.timers) clearInterval(t);
  game.auth = { ...game.auth, store, session: () => null, log: () => {}, addressOf: () => '127.0.0.1' };
  const all = [];
  const sent = new Map();
  game.broadcast = (m) => all.push(structuredClone(m));
  game.send = (ws, m) => sent.get(ws?.name)?.push(structuredClone(m));
  game.stampState = () => {};
  const join = (name, role = 'player') => {
    sent.set(name, []);
    const ws = { name, readyState: 1, OPEN: 1, send() {}, on: () => {}, close: () => {} };
    game.join(ws, { username: name, role, key: `k-${name}` }, { headers: {}, socket: {} });
    return game.players.get(name);
  };
  const stand = (p, x, z, y = game.standAt(x, z).y) => Object.assign(p.state, { x, y, z });
  return { game, join, all, sent, stand, tick: (ms) => (clock += ms) };
}

const outsideHomes = (s) => !homeAt(s.x, s.z, s.y) && HOMES.every((h) => distanceToHome(h.id, s.x, s.z, s.y - 1, s.y + 2.5) > 1.4);

test('every named place has room for a team, every place out of the locked homes, on the map, apart, facing somewhere', () => {
  const { game } = setup();
  for (const id of START_PLACES.keys()) {
    const r = game.teamStarts.place(id);
    assert.ok(r.ok, id);
    assert.ok(r.spots.length >= 16, `${id}: ${r.spots.length} places`);
    for (const s of r.spots) {
      assert.ok(outsideHomes(s), `${id}: ${JSON.stringify(s)} by a home`);
      assert.ok(game.standAt(s.x, s.z).ok, `${id}: free ground`);
      assert.ok(Number.isFinite(s.face[0]) && Number.isFinite(s.face[1]) && Math.hypot(s.face[0] - s.x, s.face[1] - s.z) > 9, `${id}: faces somewhere`);
    }
    const keys = new Set(r.spots.map((s) => `${s.x},${s.z}`));
    assert.equal(keys.size, r.spots.length, `${id}: no two on one place`);
  }
});

test('the host\'s own spot: refused inside a home, its garden, the water, indoors, off the ground and outside the map', () => {
  const { game } = setup();
  const ts = game.teamStarts;
  const ground = (x, z) => game.standAt(x, z).y;
  assert.equal(ts.check(4.5, 0.05, 6).code, 'startHome', 'in the main house');
  assert.equal(ts.check(85, 0.4, 190).code, 'startHome', 'in the bungalow');
  assert.equal(ts.check(1510, END_GARDEN.y, -352).code, 'startHome', 'in the end house\'s walled garden');
  assert.equal(ts.check(5000, 0, 5000).code, 'startOutside', 'outside the map');
  assert.equal(ts.check(NaN, 0, 1).code, 'startOutside');
  const [cx, cz] = [536.3, -771.6]; // the church square
  assert.equal(ts.check(cx, ground(cx, cz) + 12, cz).code, 'startGround', 'in the air');
  const wet = [...(houseData('house_shell.json').dips ?? []), ...(houseData('village.json').dips ?? [])].filter((d) => d.water !== undefined);
  const inside = wet.map((d) => {
    const x = d.rim.reduce((a, v) => a + v[0], 0) / d.rim.length;
    const z = d.rim.reduce((a, v) => a + v[1], 0) / d.rim.length;
    return { x, z };
  }).find((p) => ts.water(p.x, p.z));
  assert.ok(inside, 'a pond to stand in');
  assert.equal(ts.check(inside.x, ground(inside.x, inside.z), inside.z).code, 'startWater', 'in a pond');
  const ok = ts.check(cx, ground(cx, cz), cz);
  assert.ok(ok.ok && ok.spots.length >= MIN_ROOM, JSON.stringify(ok).slice(0, 200));
  // By the school's play tower (shared/playground.json): no place on its slide, ladder or under its roof.
  const tower = JSON.parse(readFileSync(new URL('../shared/playground.json', import.meta.url), 'utf8')).tower;
  const near = ts.check(475, ground(475, -820), -820);
  assert.ok(near.ok, near.code);
  for (const s of near.spots) {
    const dx = s.x - tower.at[0];
    const dz = s.z - tower.at[1];
    const v = dx * tower.v[0] + dz * tower.v[1];
    const w = dx * tower.w[0] + dz * tower.w[1];
    assert.ok(!(Math.abs(v) < tower.roof.half + 0.3 && w > tower.ladder.foot - 0.3 && w < tower.slide.end[0] + 0.3), `${JSON.stringify(s)} on the play tower`);
  }
});

test('"Blue starts here": the admin\'s own spot as the server has it, never the page\'s; only the admin', () => {
  const s = setup();
  const { game } = s;
  const admin = s.join('admin', 'admin');
  const ann = s.join('ann');
  s.stand(admin, 536.3, -771.6);
  // A forged position in the call changes nothing: the mark is where the server has the admin.
  const r = game.host.act('admin', { op: 'mark', team: 'blue', x: 4.5, z: 6, y: 0 });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([r.mark.x, r.mark.z, r.mark.near], [536.3, -771.6, 'church']);
  assert.equal(game.host.starts.blue, r.mark.id);
  // Inside the main house (the admin may stand there): refused, with its code; the starts as they were.
  s.stand(admin, 4.5, 6, 0.05);
  assert.equal(game.host.act('admin', { op: 'mark', team: 'red' }).code, 'startHome');
  assert.equal(game.host.starts.red, 'bungalow');
  // A team that is not blue or red, a start that is no place: refused.
  assert.equal(game.host.act('admin', { op: 'mark', team: 'green' }).code, 'badValue');
  assert.equal(game.host.act('admin', { op: 'starts', blue: 'church', red: 'nowhere' }).code, 'badValue');
  assert.equal(game.host.act('admin', { op: 'starts', blue: { x: 1 }, red: 'school' }).code, 'badValue');
  // Not in the game: refused.
  assert.equal(game.host.act('nobody', { op: 'mark', team: 'red' }).code, 'notInGame');
  // A player's own socket message changes nothing and tells nothing; the admin's does (where the server has the admin).
  const say = (name, p, m) => {
    p.window = Date.now();
    p.msgs = p.states = p.others = 0;
    game.handle(name, p, JSON.stringify(m));
  };
  s.stand(ann, 465.2, -812);
  say('ann', ann, { t: 'teamstart', team: 'red' });
  assert.equal(game.host.starts.red, 'bungalow', 'a player\'s message changes nothing');
  assert.equal(s.sent.get('ann').some((m) => m.code === 'teamStartHere'), false, 'and tells nothing');
  s.stand(admin, 465.2, -812);
  say('admin', admin, { t: 'teamstart', team: 'red', x: 4.5, z: 6 });
  assert.equal(s.sent.get('admin').at(-1)?.code, 'teamStartHere', JSON.stringify(s.sent.get('admin').at(-1)));
  const red = game.host.marks.find((m) => m.id === game.host.starts.red);
  assert.deepEqual([red.x, red.z, red.near], [465.2, -812, 'school'], 'the admin\'s own spot, not the message\'s');
  // A programme entry names its starts; one that names no place is refused.
  assert.equal(game.host.act('admin', { op: 'programme', list: [{ kind: 'teams', blue: 'school', red: r.mark.id }, { kind: 'teams', blue: 'mars' }] }).ok, true);
  assert.equal(game.host.programme.length, 1, 'the unknown place\'s entry is left out');
  assert.deepEqual([game.host.programme[0].blue, game.host.programme[0].red], ['school', r.mark.id]);
});

test('the teams game from chosen starts: each team at its start, spread, back there after a death, open map, no trip', () => {
  const s = setup();
  const { game } = s;
  const admin = s.join('admin', 'admin');
  const names = ['ann', 'bob', 'cid', 'dee', 'eve', 'fay', 'gus', 'hal'];
  const ps = names.map((n) => s.join(n));
  game.host.act('admin', { op: 'teams', count: 2 });
  assert.ok(game.host.act('admin', { op: 'starts', blue: 'church', red: 'school' }).ok);
  game.modes.start('teams', 'admin');
  const st = game.modes.state;
  assert.equal(st.kind, 'teams');
  assert.equal(st.open, true);
  const v = game.modes.view();
  assert.equal(v.title, 'Team against team');
  assert.deepEqual(v.names, { house: 'blue', bungalow: 'red' });
  assert.deepEqual([v.starts.house.place, v.starts.bungalow.place], ['church', 'school']);
  const line = s.all.filter((m) => m.t === 'system').at(-1);
  assert.equal(line.code, 'teamvteamStarted');
  assert.deepEqual([line.args.team, line.args.place, line.args.team2, line.args.place2], ['blue', 'church', 'red', 'school']);
  const centre = { house: START_PLACES.get('church'), bungalow: START_PLACES.get('school') };
  const at = new Set();
  for (const [n, p] of [['admin', admin], ...names.map((n, i) => [n, ps[i]])]) {
    const team = st.teams[n];
    assert.ok(Math.hypot(p.state.x - centre[team].x, p.state.z - centre[team].z) < 14, `${n} at ${team}'s start`);
    at.add(`${p.state.x},${p.state.z}`);
  }
  assert.equal(at.size, names.length + 1, 'never two on one place');
  // The open map: no edge round the houses, no trip, no start place.
  assert.equal(game.fenced(), false);
  assert.equal(game.fence(), game.teamStarts.map);
  const ann = ps[0];
  game.travel('ann', ann, 'football', true, Date.now() + 60_000);
  assert.equal(s.sent.get('ann').filter((m) => m.t === 'travel').at(-1)?.code, 'travelGame');
  // A death: back at their own team's start after the wait, by the server's place.
  const foe = ps.find((_, i) => st.teams[names[i]] !== st.teams.ann);
  s.tick(5000);
  game.damage('ann', ann, names[ps.indexOf(foe)], foe, 200, false, 'sniper', Date.now());
  assert.equal(foe.alive, false);
  assert.equal(st.score[st.teams.ann], 1, 'a point for the killer\'s team');
  s.tick(3500);
  game.tick();
  assert.equal(foe.alive, true);
  const team = st.teams[names[ps.indexOf(foe)]];
  const back = s.all.filter((m) => m.t === 'respawn' && m.name === names[ps.indexOf(foe)]).at(-1);
  assert.ok(Math.hypot(back.x - centre[team].x, back.z - centre[team].z) < 14, `back at its own start ${JSON.stringify(back)}`);
  assert.equal(back.drop, game.rules.parachute ? 1 : undefined, 'by parachute when the rule says so, as before');
  // The goal ends it under the evening's name, and the host gives the evening's points to the side that won.
  st.score[st.teams.ann] = st.goal - 1;
  s.tick(5000);
  const foe2 = ps.find((p, i) => st.teams[names[i]] !== st.teams.ann && p.alive);
  game.damage('ann', ann, names[ps.indexOf(foe2)], foe2, 200, false, 'sniper', Date.now());
  const done = game.modes.state;
  assert.equal(done.phase, 'done');
  assert.equal(done.resultCode, 'teamWon');
  assert.equal(done.resultArgs.team, st.names[st.teams.ann]);
  const board = game.host.board().players;
  const pts = (n) => board.find((b) => b.name === n)?.points;
  assert.equal(pts('ann'), 4);
  assert.equal(pts(names[ps.indexOf(foe2)]), 1);
});

test('the teams game at the two houses: its old name, every player on a place of their own round the houses\' start places', () => {
  const s = setup();
  const { game } = s;
  const names = ['ann', 'bob', 'cid', 'dee', 'eve', 'fay', 'gus', 'hal', 'ida', 'jon'];
  const ps = names.map((n) => s.join(n));
  game.modes.start('teams', 'ann');
  const v = game.modes.view();
  assert.equal(v.title, 'House against bungalow');
  assert.equal(v.open, undefined);
  assert.equal(s.all.filter((m) => m.t === 'system').at(-1).code, 'teamsStarted');
  const at = new Set(ps.map((p) => `${p.state.x},${p.state.z}`));
  assert.equal(at.size, names.length, 'never two on one place');
  const SP = JSON.parse(readFileSync(new URL('../shared/spawns.json', import.meta.url), 'utf8'));
  for (const [i, p] of ps.entries()) {
    const team = game.modes.state.teams[names[i]];
    assert.ok(SP.filter((q) => q.team === team).some((q) => Math.hypot(q.x - p.state.x, q.z - p.state.z) < 13), `${names[i]} by its house`);
  }
});
