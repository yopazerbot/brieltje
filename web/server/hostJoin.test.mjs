import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';

// Someone coming in while the host has teams for the evening (server/host.mjs joined): a newcomer is dealt to the
// smaller team and every page is told the evening's teams (the newcomer's own page says "you are on team ..."); someone
// back after a reload is told their team again, alone (their page forgot it with the welcome), on the same team.

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
  const closers = new Map();
  const join = (name, role = 'player') => {
    sent.set(name, []);
    const ws = { name, readyState: 1, OPEN: 1, send() {}, on: (ev, fn) => ev === 'close' && closers.set(name, fn), close: () => {} };
    game.join(ws, { username: name, role, key: `k-${name}` }, { headers: {}, socket: {} });
    return game.players.get(name);
  };
  return { game, join, all, sent, leave: (n) => closers.get(n)() };
}

test('a newcomer is told the evening\'s team, with every page; someone back is told theirs again', () => {
  const s = setup();
  for (const n of ['ann', 'bob', 'cid']) s.join(n);
  s.game.host.act('admin', { op: 'teams', count: 2 });
  const before = s.all.filter((m) => m.t === 'eveningteams').length;
  s.join('dee');
  const told = s.all.filter((m) => m.t === 'eveningteams');
  assert.equal(told.length, before + 1, 'every page told once');
  assert.ok(['blue', 'red'].includes(told.at(-1).teams.dee), 'with the newcomer on a team');
  const counts = Object.values(told.at(-1).teams).reduce((c, t) => ((c[t] = (c[t] ?? 0) + 1), c), {});
  assert.deepEqual(Object.values(counts).sort(), [2, 2], 'on the smaller team: two a side');
  // Back after a reload: the same team, told to their page alone.
  const team = told.at(-1).teams.dee;
  s.leave('dee');
  s.join('dee');
  assert.equal(s.all.filter((m) => m.t === 'eveningteams').length, before + 1, 'no message to everyone');
  assert.deepEqual(s.sent.get('dee').filter((m) => m.t === 'eveningteams').map((m) => m.teams.dee), [team], 'their page told their team again');
  // The admin (the host) is put on no team and nobody is told anything new.
  s.join('admin', 'admin');
  assert.equal(s.all.filter((m) => m.t === 'eveningteams').length, before + 1);
  assert.equal('admin' in s.game.host.teams, false);
});

test('without teams for the evening nobody is told any', () => {
  const s = setup();
  s.join('ann');
  s.join('bob');
  assert.equal(s.all.some((m) => m.t === 'eveningteams'), false);
  assert.equal(s.sent.get('bob').some((m) => m.t === 'eveningteams'), false);
});
