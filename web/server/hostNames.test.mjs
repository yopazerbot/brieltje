import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';

// The host's actions on a player (server/host.mjs resolve): the name however it is typed. Every login keeps a name in
// lower case (server/auth.mjs NAME_RE), so "Uil" typed on the host's side means uil: moved, muted, brought, kicked, let
// in. Never the wrong player: two names here that differ only in case would both match, and then neither does; a flag
// game's guard (names with capitals) is nobody's match; the host is never their own kick.

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const store = { addStats: async () => {}, setMeta: async () => {}, getMeta: async () => null };
  const game = new Game({ session: () => null, store, log: () => {} }, [], null);
  for (const t of game.timers) clearInterval(t);
  const kicked = [];
  game.auth = { ...game.auth, store, session: () => null, log: () => {}, addressOf: () => '127.0.0.1' };
  game.kick = async (name) => kicked.push(name);
  game.broadcast = () => {};
  game.send = () => {};
  game.stampState = () => {};
  const join = (name, role = 'player') => {
    const ws = { name, readyState: 1, OPEN: 1, send() {}, on: () => {}, close: () => {} };
    game.join(ws, { username: name, role, key: `k-${name}` }, { headers: {}, socket: {} });
    return game.players.get(name);
  };
  /** One host action, each a second after the last (the host's limit of ten a second is not what is tested here). */
  const act = (b) => {
    clock += 1000;
    return game.host.act('admin', b);
  };
  return { game, join, act, kicked };
}

test('the host moves, mutes and brings a player whose name is typed with capitals', () => {
  const s = setup();
  s.join('admin', 'admin');
  s.join('uil');
  s.join('das');
  s.game.players.get('admin').state = { ...s.game.players.get('admin').state, x: 4.5, z: 14 };
  assert.deepEqual(s.act({ op: 'teams', count: 2 }), { ok: true });
  const before = s.game.host.teams.uil;
  assert.deepEqual(s.act({ op: 'move', name: 'Uil', team: 1 - before }), { ok: true });
  assert.equal(s.game.host.teams.uil, 1 - before, 'moved to the other team');
  assert.equal('Uil' in s.game.host.teams, false, 'no second entry under the typed name');
  assert.deepEqual(s.act({ op: 'move', name: 'UIL', team: before }), { ok: true });
  assert.equal(s.game.host.teams.uil, before);
  assert.deepEqual(s.act({ op: 'mute', name: 'DaS', on: true }), { ok: true });
  assert.ok(s.game.host.muted.has('das') && !s.game.host.muted.has('DaS'));
  assert.deepEqual(s.act({ op: 'bring', name: 'Das' }), { ok: true });
});

test('the host kicks and lets in by a name typed with capitals, never kicking themselves', () => {
  const s = setup();
  s.join('admin', 'admin');
  s.join('uil');
  assert.deepEqual(s.act({ op: 'kick', name: 'Uil' }), { ok: true });
  assert.deepEqual(s.kicked, ['uil']);
  assert.equal(s.act({ op: 'kick', name: 'Admin' }).code, 'pickAnother', 'the host is not their own kick');
  // Someone knocking at the locked doors, let in as typed; someone not yet here, let in ahead.
  s.game.host.locked = true;
  assert.equal(s.game.host.shut({ username: 'mol', role: 'guest' }), true, 'mol waits at the door');
  assert.deepEqual(s.act({ op: 'admit', name: 'Mol' }), { ok: true });
  assert.equal(s.game.host.shut({ username: 'mol', role: 'guest' }), false, 'mol may come in');
  assert.deepEqual(s.act({ op: 'admit', name: 'Vos' }), { ok: true });
  assert.equal(s.game.host.shut({ username: 'vos', role: 'guest' }), false, 'vos may come in when they arrive');
});

test('two names that differ only in case match neither; a guard matches nobody; an unknown name stays unknown', () => {
  const s = setup();
  s.join('admin', 'admin');
  s.join('uil');
  // Not possible through a login today: two players whose names differ only in case.
  s.join('Uil');
  assert.deepEqual(s.act({ op: 'teams', count: 2 }), { ok: true });
  const [a, b] = [s.game.host.teams.uil, s.game.host.teams.Uil];
  assert.deepEqual(s.act({ op: 'move', name: 'uil', team: 1 - a }), { ok: true }, 'the exact name still works');
  assert.equal(s.game.host.teams.Uil, b, 'and moves only that one');
  assert.equal(s.act({ op: 'move', name: 'UIL', team: 0 }).code, 'badValue', 'a name that matches both moves neither');
  assert.equal(s.act({ op: 'mute', name: 'uIl', on: true }).code, 'notHere');
  assert.equal(s.game.host.muted.size, 0);
  // A flag game's guard: never muted, moved or kicked, by its own name or another case of it.
  const guard = s.join('Blue guard 1');
  guard.guard = true;
  for (const n of ['Blue guard 1', 'blue guard 1']) assert.equal(s.act({ op: 'mute', name: n, on: true }).code, 'notHere', n);
  assert.equal(s.act({ op: 'kick', name: 'Nobody' }).code, 'pickAnother');
  assert.equal(s.act({ op: 'move', name: 'Nobody', team: 0 }).code, 'badValue');
});
