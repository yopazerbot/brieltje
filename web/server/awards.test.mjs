import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';
import { MAX, RESULTS_MS, lineOf, results } from './awards.mjs';

// The results moment after a team game (server/awards.mjs, server/modes.mjs finish, server/host.mjs gameOver): the
// awards chosen by the server from its own counts (ties, zeros, one a player, one for the losing side, 2 and 40 players),
// each player's own line, the moment's 20 s, the evening's record of them and its reset, and nothing a page says in it.

const row = (name, team, c = {}) => ({ name, team, captures: 0, returns: 0, stops: 0, guards: 0, assists: 0, tags: 0, tagged: 0, points: 0, ...c });
const ids = (r) => r.awards.map((a) => `${a.id}:${a.name}`);

test('the awards: in order, the highest count, one award a player, none for a count of zero', () => {
  const rows = [
    row('ann', 'blue', { captures: 3, returns: 2, tags: 9 }),
    row('bob', 'blue', { returns: 1, guards: 2, stops: 1 }),
    row('cid', 'red', { assists: 2, tags: 1, tagged: 4 }),
    row('dee', 'red', { tagged: 7 }),
    row('eve', 'red'),
  ];
  const r = results('flag', rows, 'blue', new Set(rows.map((x) => x.name)));
  // The wall: bob (3) has the saver already, nobody else guarded. Most tags: ann and cid have one already. The fourth:
  // the losing side has cid's, so the list goes on, then Never gave up for dee (tagged 7 times, still here).
  assert.deepEqual(ids(r), ['flagsIn:ann', 'saver:bob', 'helper:cid', 'neverGaveUp:dee']);
  assert.equal(r.awards[0].n, 3);
  assert.equal(r.awards[1].n, 1, 'ann has an award already: the saver is bob, with his one');
  assert.ok(r.awards.length <= MAX);
  assert.equal(new Set(r.awards.map((a) => a.name)).size, r.awards.length, 'one award a player');
  assert.ok(r.awards.every((a) => a.n > 0), 'none for a count of zero');
  assert.ok(!r.awards.some((a) => a.name === 'eve'), 'nothing done: no award');
});

test('the losing side gets one: Never gave up, else its best in an award not given yet', () => {
  // Blue did everything; red only came back after being tagged.
  const rows = [row('ann', 'blue', { captures: 2 }), row('bob', 'blue', { returns: 2 }), row('cid', 'blue', { guards: 3 }), row('dee', 'blue', { assists: 1 }), row('red1', 'red', { tagged: 5 }), row('red2', 'red', { tagged: 8 })];
  const r = results('flag', rows, 'blue', new Set(rows.map((x) => x.name)));
  assert.equal(r.awards.length, 4);
  assert.deepEqual(r.awards.at(-1), { id: 'neverGaveUp', name: 'red2', team: 'red', n: 8 });
  // Somebody who left gets no Never gave up; the losing side's best tags instead.
  const left = results('flag', [...rows.slice(0, 4), row('red1', 'red', { tags: 1, tagged: 5 }), row('red2', 'red', { tagged: 8 })], 'blue', new Set(['ann', 'bob', 'cid', 'dee']));
  assert.deepEqual(left.awards.at(-1), { id: 'tagger', name: 'red1', team: 'red', n: 1 });
  // A draw: the last place still goes to the side with none (red's Never gave up), not to blue's fourth.
  const draw = results('flag', rows, null, new Set(rows.map((x) => x.name)));
  assert.deepEqual(ids(draw), ['flagsIn:ann', 'saver:bob', 'wall:cid', 'neverGaveUp:red2']);
  // A draw, red without one but with a count in an award not given yet: that one (Best helper), before Never gave up.
  const both = results('flag', [...rows.slice(0, 3), row('dee', 'red', { assists: 1 }), row('red1', 'red', { tagged: 5 })], null, new Set(['ann', 'bob', 'cid', 'dee', 'red1']));
  assert.deepEqual(ids(both), ['flagsIn:ann', 'saver:bob', 'wall:cid', 'helper:dee']);
});

test('the winners outdone in every count: the last place still goes to them (a side with none), never all four to one side when the other did something', () => {
  // As played with 30 (a tie-break won by red, blue ahead in every count): blue took the first three.
  const rows = [row('b1', 'blue', { returns: 1, tags: 4 }), row('b2', 'blue', { guards: 2 }), row('b3', 'blue', { tags: 6 }), row('b4', 'blue', { tagged: 5, tags: 2 }),
    row('r1', 'red', { stops: 1 }), row('r2', 'red', { tags: 3 }), row('r3', 'red', { tagged: 5 })];
  const r = results('flag', rows, 'red', new Set(rows.map((x) => x.name)));
  assert.deepEqual(ids(r).slice(0, 3), ['saver:b1', 'wall:b2', 'tagger:b3']);
  assert.equal(r.awards.length, 4);
  assert.equal(r.awards[3].team, 'red', 'the winning side gets the last place');
  assert.deepEqual(r.awards[3], { id: 'neverGaveUp', name: 'r3', team: 'red', n: 5 }, 'every list award given: Never gave up');
  // In a draw each side without one gets the place in turn.
  const d = results('flag', rows, null, new Set(rows.map((x) => x.name)));
  assert.ok(d.awards.some((a) => a.team === 'red'));
});

test('level counts: the losing side first, then the more points, then the name; always the same answer', () => {
  const rows = [row('zed', 'blue', { tags: 4, points: 0 }), row('amy', 'blue', { tags: 4, points: 100 }), row('kim', 'red', { tags: 4 })];
  assert.deepEqual(results('flag', rows, 'blue').awards[0], { id: 'tagger', name: 'kim', team: 'red', n: 4 });
  assert.deepEqual(results('flag', rows, null).awards[0], { id: 'tagger', name: 'amy', team: 'blue', n: 4 }, 'a draw: the more points');
  const same = [row('bea', 'blue', { tags: 2 }), row('abe', 'blue', { tags: 2 })];
  assert.equal(results('flag', same, null).awards[0].name, 'abe');
  assert.equal(results('flag', [...same].reverse(), null).awards[0].name, 'abe');
});

test('nobody did anything: no awards; 2 players: two at most; 40 players: four, each a different one', () => {
  const none = results('flag', [row('a', 'blue'), row('b', 'red')], null);
  assert.deepEqual(none.awards, []);
  assert.deepEqual(none.lines, [['a', 'played', 0], ['b', 'played', 0]]);
  const two = results('flag', [row('a', 'blue', { captures: 1, returns: 3, tags: 5 }), row('b', 'red', { tags: 2, tagged: 4 })], 'blue', new Set(['a', 'b']));
  assert.deepEqual(ids(two), ['flagsIn:a', 'tagger:b']);
  const many = Array.from({ length: 40 }, (_, i) => row(`p${String(i).padStart(2, '0')}`, i % 2 ? 'red' : 'blue', { captures: i % 7 === 0 ? 1 : 0, returns: i % 5, guards: i % 3, stops: i % 4 === 1 ? 1 : 0, assists: i % 6 === 2 ? 2 : 0, tags: i, tagged: 40 - i }));
  const r = results('flag', many, 'red', new Set(many.map((x) => x.name)));
  assert.equal(r.awards.length, 4);
  assert.equal(new Set(r.awards.map((a) => a.name)).size, 4);
  assert.ok(r.awards.some((a) => a.team === 'red'), 'the losing side has one');
  assert.equal(r.lines.length, 40);
});

test('each player\'s own line: the best thing they did, by its worth; on the losing side too; "played" for nothing', () => {
  assert.deepEqual(lineOf(row('a', 'blue', { captures: 1, tags: 12 }), 'flag'), ['captures', 1]);
  assert.deepEqual(lineOf(row('a', 'blue', { returns: 1, tags: 2 }), 'flag'), ['returns', 1]);
  assert.deepEqual(lineOf(row('a', 'blue', { tags: 4, guards: 1 }), 'flag'), ['tags', 4]);
  assert.deepEqual(lineOf(row('a', 'red', { tagged: 3 }), 'flag'), ['tagged', 3]);
  assert.deepEqual(lineOf(row('a', 'red', { far: 64 }), 'assault'), ['far', 64]);
  assert.deepEqual(lineOf(row('a', 'red', { far: 100, captures: 1 }), 'assault'), ['captures', 1]);
  assert.deepEqual(lineOf({ name: 'a', team: 'house', tags: 0, tagged: 0, best: 0, near: 0 }, 'teams'), ['played', 0]);
});

test('the team deathmatch: Most tags, Hardest to catch (tags in a row), Team player (tags with a teammate near)', () => {
  const t = (name, team, c) => ({ name, team, tags: 0, tagged: 0, best: 0, near: 0, ...c });
  const rows = [t('ann', 'house', { tags: 9, best: 5, near: 2 }), t('bob', 'house', { tags: 3, best: 3, near: 3 }), t('cid', 'bungalow', { tags: 4, best: 2, near: 1, tagged: 6 }), t('dee', 'bungalow', { tagged: 9 })];
  const r = results('teams', rows, 'house', new Set(rows.map((x) => x.name)));
  assert.deepEqual(ids(r), ['tagger:ann', 'streak:bob', 'teamPlayer:cid', 'neverGaveUp:dee']);
});

// ---- played through on a Game (the server as it runs)

function setup(names = ['ann', 'bob', 'cid', 'dee']) {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const store = { addStats: async () => {}, setMeta: async () => {}, getMeta: async () => null, addCar: async () => 1, deleteCar: async () => {} };
  const game = new Game({ session: () => null, store, log: () => {} }, [], null);
  for (const t of game.timers) clearInterval(t);
  game.auth = { ...game.auth, store, session: () => null, log: () => {}, addressOf: () => '127.0.0.1' };
  const out = [];
  game.broadcast = (m) => out.push(structuredClone(m));
  game.broadcastThing = (m) => out.push(structuredClone(m));
  game.send = () => {};
  game.stampState = () => {};
  const sockets = new Map();
  for (const name of names) {
    const ws = { name, readyState: 1, OPEN: 1, send() {}, on: () => {}, close: () => {} };
    sockets.set(name, ws);
    game.join(ws, { username: name, role: 'player', key: `k-${name}` }, { headers: {}, socket: {} });
  }
  const tick = (ms = 50) => {
    clock += ms;
    game.modes.tick(clock, ms);
  };
  return { game, out, tick, sockets, at: (ms) => (clock += ms), now: () => clock };
}

test('Steal the flag ends: its awards and lines in every page\'s view for 20 s, the evening keeps them, a new evening clears them', () => {
  const s = setup();
  s.game.modes.start('flag', 'admin', 'compact', { minutes: 1 });
  const st = s.game.modes.state;
  const f = st.f;
  const blue = Object.keys(st.teams).filter((n) => st.teams[n] === 'blue');
  const red = Object.keys(st.teams).filter((n) => st.teams[n] === 'red');
  f.credit(blue[0], 'home');
  f.tagged(blue[0], red[0]);
  f.tagged(blue[1], red[0]);
  f.tagged(blue[1], red[1]);
  // A page that claims awards, credit or a result: no such message changes anything (forged score or awards).
  const before = JSON.stringify(f.statsList());
  for (const msg of [{ t: 'awards', awards: [{ id: 'flagsIn', name: red[1], n: 99 }] }, { t: 'results', lines: [[red[1], 'captures', 9]] }, { t: 'credit', act: 'capture' }, { t: 'flag', ev: 'captured' }]) {
    s.game.receive(red[1], s.game.players.get(red[1]), JSON.stringify(msg));
  }
  assert.equal(JSON.stringify(f.statsList()), before, 'nothing a page sends counts');
  s.at(60_000);
  s.tick();
  const end = s.game.modes.state;
  assert.equal(end.phase, 'done');
  assert.equal(end.resultCode, 'flagTagsWon');
  assert.equal(end.until - s.now(), RESULTS_MS, 'the results moment: 20 s');
  const view = s.out.filter((m) => m.t === 'mode').at(-1).mode;
  assert.ok(view.results, 'the awards in the view every page gets');
  // blue[1]'s tags: guards' tags (the Wall of the base) when their start place was within 20 m of their own stand (the
  // places are random), else Most tags.
  const ids2 = view.results.awards.map((a) => a.id);
  assert.ok(ids2[0] === 'saver' && ['wall', 'tagger'].includes(ids2[1]) && ids2[2] === 'neverGaveUp' && ids2.length === 3, JSON.stringify(ids2));
  assert.deepEqual(view.results.awards[0], { id: 'saver', name: blue[0], team: 'blue', n: 1, color: '#4fa3e0' });
  assert.equal(view.results.awards[1].name, blue[1]);
  assert.equal(view.results.awards[2].team, 'red', 'the losing side has one');
  assert.equal(view.results.awards[2].name, red[0]);
  assert.ok(view.results.lines.some(([n, act, k]) => n === red[0] && act === 'tagged' && k === 2));
  // The evening's board keeps them (the scores page's Tonight view), a new evening clears them.
  const board = s.game.host.board();
  assert.equal(board.awards.length, 1);
  assert.equal(board.awards[0].game, 'flag');
  assert.deepEqual(board.awards[0].list.map((a) => a.name), view.results.awards.map((a) => a.name));
  // Still there after 19 s; free play after 20, with no results in it.
  s.at(RESULTS_MS - 1000);
  s.tick();
  assert.equal(s.game.modes.state.phase, 'done');
  s.at(2000);
  s.tick();
  assert.equal(s.game.modes.state.kind, 'free');
  assert.equal(s.game.modes.view().results, undefined);
  assert.equal(s.game.host.board().awards.length, 1, 'kept through free play');
  assert.deepEqual(s.game.host.act('host', { op: 'reset' }), { ok: true });
  assert.deepEqual(s.game.host.board().awards, [], 'a new evening: none');
});

test('the team deathmatch counts its own tags: Most tags, a run, with a teammate near; a page sends nothing for it', () => {
  const s = setup(['ann', 'bob', 'cid', 'dee']);
  s.game.modes.start('teams', 'admin', 'house', { minutes: 1 });
  const st = s.game.modes.state;
  const house = Object.keys(st.teams).filter((n) => st.teams[n] === 'house');
  const bung = Object.keys(st.teams).filter((n) => st.teams[n] === 'bungalow');
  const place = (n, x, z) => (s.game.players.get(n).state = { ...(s.game.players.get(n).state ?? {}), x, y: 0, z });
  place(house[0], 0, 0);
  place(house[1], 3, 0); // close: a teammate near
  place(bung[0], 30, 0);
  place(bung[1], 60, 0);
  const tag = (a, b) => {
    const t = s.game.players.get(b);
    t.alive = true;
    t.hp = 100;
    s.game.damage(a, s.game.players.get(a), b, t, 500, false, 'rifle', s.now());
  };
  tag(house[0], bung[0]);
  tag(house[0], bung[1]);
  tag(house[0], bung[0]);
  tag(bung[1], house[0]);
  tag(house[1], bung[1]);
  s.game.receive(bung[0], s.game.players.get(bung[0]), JSON.stringify({ t: 'awards', awards: [] }));
  const a = st.acts;
  assert.deepEqual({ ...a.get(house[0]) }, { tags: 3, tagged: 1, run: 0, best: 3, near: 3 });
  assert.deepEqual({ ...a.get(bung[1]) }, { tags: 1, tagged: 2, run: 0, best: 1, near: 0 });
  s.at(60_000);
  s.tick();
  const end = s.game.modes.state;
  assert.equal(end.phase, 'done');
  assert.equal(end.until - s.now(), RESULTS_MS);
  const r = s.game.modes.view().results;
  assert.equal(r.awards[0].id, 'tagger');
  assert.equal(r.awards[0].name, house[0]);
  assert.equal(r.awards[0].color, '#4fa3e0');
  // The host's two teams play it, so each award names the side by the evening's name (blue, red), in its colour.
  assert.equal(r.awards[0].team, s.game.modes.sideName('house'));
  assert.ok(r.awards.some((x) => x.team === s.game.modes.sideName('bungalow')), 'the losing side has one');
  assert.ok(r.awards.every((x) => /^#[0-9a-f]{6}$/i.test(x.color)));
  assert.equal(r.lines.length, 4, 'a line for everyone on a team');
  assert.equal(s.game.host.board().awards[0].game, 'teams');
});

test('a game stopped by the host: no results moment, nothing kept', () => {
  const s = setup();
  s.game.modes.start('flag', 'admin', 'compact', { minutes: 1 });
  const st = s.game.modes.state;
  const blue = Object.keys(st.teams).find((n) => st.teams[n] === 'blue');
  st.f.credit(blue, 'home');
  s.game.modes.start('free', 'admin');
  assert.equal(s.game.modes.state.kind, 'free');
  assert.deepEqual(s.game.host.board().awards, []);
});
