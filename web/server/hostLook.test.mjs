import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';
import { EVENING_TEAMS } from './host.mjs';
import { TEAM_COLORS } from './modes.mjs';

// The host's programme gives a game a look (server/host.mjs entry, server/modes.mjs LOOKS): 'paint', child-friendly for
// everyone while it runs; 'real', the house rule's child-friendly off (a player's own Paintball kept, on their page);
// none, the house rule. It goes back when the game ends, is stopped by the host or the admin starts another, and the
// stored house rule is never touched. The host's two evening teams are blue and red, and play the teams game in them.

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const stored = [];
  const store = { addStats: async () => {}, setMeta: async (k, v) => stored.push([k, v]), getMeta: async () => null };
  const game = new Game({ session: () => null, store, log: () => {} }, [], null);
  for (const t of game.timers) clearInterval(t);
  game.auth = { ...game.auth, store, session: () => null, log: () => {}, addressOf: () => '127.0.0.1' };
  const out = [];
  game.broadcast = (m) => out.push(structuredClone(m));
  game.send = () => {};
  game.stampState = () => {};
  const join = (name, role = 'player') => {
    const ws = { name, readyState: 1, OPEN: 1, send() {}, on: () => {}, close: () => {} };
    game.join(ws, { username: name, role, key: `k-${name}` }, { headers: {}, socket: {} });
    return game.players.get(name);
  };
  /** The rules the pages were last told. */
  const told = () => out.filter((m) => m.t === 'rules').at(-1)?.rules;
  /** A game from the host page, its ten-second countdown skipped (the same entry check, then modes.start). */
  const host = (b) => {
    const e = game.host.entry(b);
    assert.ok(e, 'the host accepts the game');
    game.modes.start(e.kind, 'admin', e.place, { minutes: e.minutes, goal: e.goal, look: e.look });
  };
  return { game, join, told, out, stored, host, at: (ms) => (clock += ms) };
}

test('paint: child-friendly for everyone while the game runs, the house rule back when it is over', () => {
  const s = setup();
  s.join('ann');
  s.join('bob');
  assert.equal(s.game.rules.paintball, false);
  s.host({ kind: 'tag', minutes: 1, look: 'paint' });
  assert.equal(s.told()?.paintball, true, 'every page told: child-friendly');
  assert.equal(s.game.shownRules().paintball, true);
  assert.equal(s.game.rules.paintball, false, 'the stored house rule untouched');
  assert.equal(s.game.modes.view().look, 'paint');
  // Played out: the result shows for a while (the look still holds), then free play and the house rule.
  s.at(61_000);
  s.game.modes.tick(Date.now(), 50);
  assert.equal(s.game.modes.state.phase, 'done');
  assert.equal(s.game.shownRules().paintball, true, 'still while its result shows');
  s.at(11_000);
  s.game.modes.tick(Date.now(), 50);
  assert.equal(s.game.modes.state.kind, 'free');
  assert.equal(s.told()?.paintball, false, 'back to the house rule');
  assert.deepEqual(s.stored.filter(([k]) => k === 'rules'), [], 'nothing stored');
});

test('real: the house rule child-friendly is off for the game, and stays stored as on', async () => {
  const s = setup();
  s.join('ann');
  s.join('bob');
  await s.game.setRules({ paintball: true }, 'admin');
  const savedBefore = s.stored.filter(([k]) => k === 'rules').length;
  s.host({ kind: 'teams', minutes: 5, look: 'real' });
  const rules = s.told();
  assert.equal(rules?.paintball, false, 'not forced to paint: each page plays as its player chose');
  // The page's own choice of Paintball (src/ui/menu.ts) is all that is left: nothing in the rules forces Action.
  assert.deepEqual(Object.keys(rules).sort(), Object.keys(s.game.rules).sort(), 'the same rules, only child-friendly differs');
  assert.equal(s.game.rules.paintball, true, 'the stored house rule untouched');
  // A page that joins now is told the same.
  const welcome = s.game.welcome(s.game.players.get('ann'), 'ann', '#fff', Date.now());
  assert.equal(welcome.rules.paintball, false);
  // The host stops it early.
  assert.deepEqual(s.game.host.act('admin', { op: 'stop' }), { ok: true });
  assert.equal(s.told()?.paintball, true, 'the house rule back');
  assert.equal(s.stored.filter(([k]) => k === 'rules').length, savedBefore, 'nothing stored');
});

test('the admin starting another game ends the look; a game without one plays the house rule', () => {
  const s = setup();
  s.join('ann');
  s.join('bob');
  s.host({ kind: 'tag', look: 'paint' });
  assert.equal(s.game.shownRules().paintball, true);
  s.game.modes.start('hide', 'admin'); // from the menu
  assert.equal(s.game.modes.look, null);
  assert.equal(s.told()?.paintball, false);
  const before = s.out.filter((m) => m.t === 'rules').length;
  s.game.modes.start('free', 'admin');
  s.host({ kind: 'treasure' });
  assert.equal(s.out.filter((m) => m.t === 'rules').length, before, 'no look, no change: nobody told');
});

test('the house rule changed while a look holds: stored, the look still shown', async () => {
  const s = setup();
  s.join('ann');
  s.join('bob');
  s.host({ kind: 'tag', look: 'paint' });
  await s.game.setRules({ paintball: true }, 'admin');
  await s.game.setRules({ paintball: false }, 'admin');
  assert.equal(JSON.parse(s.stored.filter(([k]) => k === 'rules').at(-1)[1]).paintball, false, 'the house rule stored as set');
  assert.equal(s.told()?.paintball, true, 'the game still in paint');
});

test('a look must be one of the three: anything else refuses the game', () => {
  const s = setup();
  const h = s.game.host;
  assert.equal(h.entry({ kind: 'tag', look: 'paint' }).look, 'paint');
  assert.equal(h.entry({ kind: 'tag', look: 'real' }).look, 'real');
  for (const none of [undefined, null, '']) assert.equal(h.entry({ kind: 'tag', look: none }).look, null);
  for (const bad of ['gore', 'PAINT', true, 1, {}, ['paint'], '__proto__']) assert.equal(h.entry({ kind: 'tag', look: bad }), null, String(bad));
  assert.equal(h.act('admin', { op: 'start', kind: 'tag', look: 'gore' }).code, 'badValue');
  h.act('admin', { op: 'programme', list: [{ kind: 'tag', look: 'paint' }, { kind: 'hide', look: 'gore' }, { kind: 'teams' }] });
  assert.deepEqual(h.programme.map((e) => [e.kind, e.look]), [['tag', 'paint'], ['teams', null]]);
  // modes.start checks it again: a look from anywhere else is none.
  s.join('ann');
  s.join('bob');
  s.game.modes.start('tag', 'admin', 'house', { look: 'gore' });
  assert.equal(s.game.modes.look, null);
});

test('the evening teams: blue and red first, four in all; they play the teams game in blue and red', () => {
  assert.deepEqual(EVENING_TEAMS.map((t) => t.id), ['blue', 'red', 'green', 'purple']);
  const s = setup();
  s.join('admin', 'admin');
  for (const n of ['ann', 'bob', 'cid', 'dee']) s.join(n);
  const h = s.game.host;
  h.act('admin', { op: 'teams', count: 2 });
  assert.deepEqual(Object.values(h.teams).sort(), [0, 0, 1, 1]);
  s.host({ kind: 'teams' });
  const m = s.game.modes;
  assert.equal(m.teamMatch, true);
  const red = Object.keys(h.teams).find((n) => h.teams[n] === 1);
  const blue = Object.keys(h.teams).find((n) => h.teams[n] === 0);
  assert.equal(m.teamOf(red), 'bungalow');
  assert.equal(s.game.colorOf(red, s.game.players.get(red)), EVENING_TEAMS[1].color, 'red, not orange');
  assert.equal(s.game.colorOf(blue, s.game.players.get(blue)), EVENING_TEAMS[0].color);
  assert.deepEqual(m.view().colors, { house: EVENING_TEAMS[0].color, bungalow: EVENING_TEAMS[1].color });
  const roster = s.out.filter((m) => m.t === 'colors').at(-1).list;
  assert.equal(roster.find((p) => p.name === red)?.color, EVENING_TEAMS[1].color, 'every page told the red');
  h.act('admin', { op: 'stop' });
  assert.equal(m.teamMatch, false);
});

test('without the host\'s teams the teams game is as it was: the house blue, the bungalow orange', () => {
  const s = setup();
  for (const n of ['ann', 'bob', 'cid', 'dee']) s.join(n);
  s.game.modes.start('teams', 'admin');
  const m = s.game.modes;
  assert.equal(m.teamMatch, true);
  const b = Object.keys(m.state.teams).find((n) => m.state.teams[n] === 'bungalow');
  assert.equal(s.game.colorOf(b, s.game.players.get(b)), TEAM_COLORS.bungalow);
  assert.deepEqual(m.view().colors, TEAM_COLORS);
  // The host makes two teams mid-game: they take over the sides, in blue and red.
  s.join('admin', 'admin');
  s.game.host.act('admin', { op: 'teams', count: 2 });
  assert.equal(m.teamColor('bungalow'), EVENING_TEAMS[1].color);
});

test('teamMatch: only while the teams game is played', () => {
  const s = setup();
  s.join('ann');
  s.join('bob');
  const m = s.game.modes;
  assert.equal(m.teamMatch, false);
  m.start('tag', 'admin');
  assert.equal(m.teamMatch, false);
  m.start('teams', 'admin');
  assert.equal(m.teamMatch, true);
  m.finish('over', 'teamsDraw', { house: 0, bungalow: 0 });
  assert.equal(m.teamMatch, false, 'not once its result shows');
});
