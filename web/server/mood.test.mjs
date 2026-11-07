import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';
import { DEFAULT_MOOD, MOODS } from '../shared/moods.mjs';

// The weather and time of day for everyone (shared/moods.mjs): only the admin sets it, only from the fixed list,
// at most once a second, and everyone who joins later is told it.
function setup() {
  const game = new Game({ session: () => null }, []);
  const told = [];
  game.broadcast = (m) => told.push(m);
  const player = (name, role = 'player') => {
    const p = {
      key: `k-${name}`, role, alive: true, state: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, armed: false, flying: false, w: 'pistol', c: false },
      weapons: new Set(['pistol']), nades: [], window: Date.now(), msgs: 0, states: 0, others: 0,
    };
    game.players.set(name, p);
    return p;
  };
  const send = (name, p, m) => game.handle(name, p, JSON.stringify(m));
  return { game, told, player, send };
}

test('the mood starts as the default and is one of the list', () => {
  const { game } = setup();
  assert.equal(game.mood, DEFAULT_MOOD);
  assert.ok(MOODS.includes(game.mood));
});

test('a player who is not the admin cannot set the mood (forged admin message)', () => {
  const { game, told, player, send } = setup();
  const guest = player('guest');
  const plain = player('plain', 'guest');
  for (const p of [guest, plain]) {
    for (const mood of MOODS) {
      p.nextMood = 0;
      send(p === guest ? 'guest' : 'plain', p, { t: 'mood', mood });
      // A forged role field in the message counts for nothing: the role is the session's.
      send(p === guest ? 'guest' : 'plain', p, { t: 'mood', mood, role: 'admin' });
    }
  }
  assert.equal(game.mood, DEFAULT_MOOD);
  assert.equal(told.length, 0, 'nothing is told to anyone');
});

test('the admin sets a mood from the list; everyone is told, with who set it', () => {
  const { game, told, player, send } = setup();
  const admin = player('root', 'admin');
  send('root', admin, { t: 'mood', mood: 'rain' });
  assert.equal(game.mood, 'rain');
  assert.deepEqual(told, [{ t: 'mood', mood: 'rain', by: 'root' }]);
});

test('anything not on the list is refused and changes nothing', () => {
  const { game, told, player, send } = setup();
  const admin = player('root', 'admin');
  const bad = ['', 'Sunny', 'RAIN', 'snow', 'dusk', 'night ', 'toString', '__proto__', 'constructor', null, 1, true, {}, [], ['rain'], { toString: 'rain' }, 'x'.repeat(5000)];
  for (const mood of bad) {
    admin.nextMood = 0;
    admin.msgs = admin.others = 0;
    send('root', admin, { t: 'mood', mood });
  }
  admin.nextMood = 0;
  send('root', admin, { t: 'mood' }); // no value at all
  assert.equal(game.mood, DEFAULT_MOOD);
  assert.equal(told.length, 0);
});

test('at most one change a second per admin (message flood), and the same mood again tells nobody', () => {
  const { game, told, player, send } = setup();
  const admin = player('root', 'admin');
  send('root', admin, { t: 'mood', mood: 'night' });
  for (let i = 0; i < 20; i++) send('root', admin, { t: 'mood', mood: MOODS[i % MOODS.length] });
  assert.equal(game.mood, 'night', 'the flood within the second changed nothing');
  assert.equal(told.length, 1);
  admin.nextMood = 0; // a second later
  send('root', admin, { t: 'mood', mood: 'night' });
  assert.equal(told.length, 1, 'the same mood again is not told');
  admin.nextMood = 0;
  send('root', admin, { t: 'mood', mood: 'overcast' });
  assert.equal(game.mood, 'overcast');
  assert.equal(told.length, 2);
});

test('a player who joins later is told the mood in the welcome', () => {
  const { game, player, send } = setup();
  const admin = player('root', 'admin');
  send('root', admin, { t: 'mood', mood: 'night' });
  game.players.delete('root'); // the fixture's admin has no scores; the welcome lists everyone's
  const sent = [];
  game.send = (_ws, m) => sent.push(m);
  game.auth = { session: () => null, log: () => {}, addressOf: () => '127.0.0.1' };
  const ws = { readyState: 1, OPEN: 1, send() {}, on() {}, close() {} };
  game.join(ws, { username: 'late', role: 'guest', key: 'k-late' }, { headers: {}, socket: {} });
  const welcome = sent.find((m) => m.t === 'welcome');
  assert.ok(welcome);
  assert.equal(welcome.mood, 'night');
});
