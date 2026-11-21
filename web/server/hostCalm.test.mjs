import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';
import { RESULTS_MS } from './awards.mjs';

// A hosted evening (server/host.mjs calm): free play between the host's games stays calm, no "first to 10 kills" round
// starts after a team game and none ends (game.mjs freshRound, damage); on an ordinary day nothing changes.

function setup() {
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
  for (const name of ['ann', 'bob', 'cid', 'dee']) {
    const ws = { name, readyState: 1, OPEN: 1, send() {}, on: () => {}, close: () => {} };
    game.join(ws, { username: name, role: 'player', key: `k-${name}` }, { headers: {}, socket: {} });
  }
  const tick = (ms = 50) => {
    clock += ms;
    game.modes.tick(clock, ms);
  };
  return { game, out, tick, at: (ms) => (clock += ms), now: () => clock };
}

test('a hosted evening: after a team game free play stays calm, no "first to 10 kills" round starts or ends; an ordinary day as before', () => {
  for (const hosted of [true, false]) {
    const s = setup();
    if (hosted) assert.deepEqual(s.game.host.act('host', { op: 'programme', list: [{ kind: 'flag', minutes: 1 }, { kind: 'assault', minutes: 1 }] }), { ok: true });
    assert.equal(s.game.host.calm(), hosted, 'a programme with a game to come: a hosted evening');
    s.game.modes.start('flag', 'admin', 'compact', { minutes: 1 });
    s.at(60_000);
    s.tick();
    assert.equal(s.game.modes.state.phase, 'done');
    s.out.length = 0;
    s.at(RESULTS_MS + 1000); // a team game's results moment (server/awards.mjs)
    s.tick();
    assert.equal(s.game.modes.state.kind, 'free');
    assert.equal(s.out.some((m) => m.t === 'newround'), !hosted, hosted ? 'no new round told' : 'an ordinary day: the round as before');
    assert.ok(s.out.some((m) => m.t === 'scores'), 'the scores back to zero either way');
    // Ten kills in free play: a round won on an ordinary day, nothing on a hosted evening.
    const [a, c] = ['ann', 'bob'];
    const p = s.game.players.get(a);
    p.score.kills = 9;
    s.game.damage(a, p, c, s.game.players.get(c), 500, false, 'rifle', s.now());
    assert.equal(!!s.game.roundOver, !hosted);
    assert.equal(s.out.some((m) => m.t === 'round'), !hosted);
  }
});

test('a hosted evening: the host starting a game from the host page makes one; the evening\'s reset ends it while no programme game is to come', () => {
  const s = setup();
  assert.equal(s.game.host.calm(), false, 'an ordinary day');
  assert.deepEqual(s.game.host.act('host', { op: 'start', kind: 'flag', minutes: 1 }), { ok: true });
  s.game.host.act('host', { op: 'cancel' }); // its countdown called off (no timer left running)
  assert.equal(s.game.host.calm(), true);
  s.game.host.act('host', { op: 'reset' });
  assert.equal(s.game.host.calm(), false);
  // The programme played to its end: still a hosted evening (the host started its games).
  s.game.host.act('host', { op: 'programme', list: [{ kind: 'flag', minutes: 1 }] });
  assert.deepEqual(s.game.host.act('host', { op: 'next' }), { ok: true });
  s.game.host.act('host', { op: 'cancel' });
  assert.equal(s.game.host.calm(), true);
  s.game.host.act('host', { op: 'reset' });
  s.game.host.act('host', { op: 'rewind', index: 1 });
  assert.equal(s.game.host.calm(), false, 'reset, and nothing left to come');
});

test('a round won before the evening went calm still ends with its new round, as before', () => {
  const s = setup();
  const p = s.game.players.get('ann');
  p.score.kills = 9;
  s.game.damage('ann', p, 'bob', s.game.players.get('bob'), 500, false, 'rifle', s.now());
  assert.ok(s.game.roundOver, 'won on an ordinary day');
  s.game.host.act('host', { op: 'programme', list: [{ kind: 'flag', minutes: 1 }] });
  s.out.length = 0;
  s.game.freshRound();
  assert.ok(s.out.some((m) => m.t === 'newround'), 'its banner ended with the new round line');
  assert.equal(s.game.roundOver, null);
});
