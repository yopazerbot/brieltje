import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';

// The host's countdown (server/host.mjs startIn: Next, or a game started from the host page, ten seconds before it
// starts) and what calls it off: the host's Cancel and Stop, and the admin's own Stop or game from the in-game menu.
// Before, Stop during the countdown stopped only what was playing, and the queued game started ten seconds later anyway.
// Called off, every page is told by the empty announcement that takes its countdown's bar away (no new message).

function setup(t) {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const store = { addStats: async () => {}, setMeta: async () => {}, getMeta: async () => null, addCar: async () => 1, deleteCar: async () => {} };
  const game = new Game({ session: () => null, store, log: () => {} }, [], null);
  for (const x of game.timers) clearInterval(x);
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
  for (const n of ['ann', 'bob', 'cid', 'dee']) join(n);
  join('admin', 'admin');
  t.mock.timers.enable({ apis: ['setTimeout'] }); // the countdown's timer: moved on by hand
  /** `ms` later, on the game's clock and the countdown's. */
  const wait = (ms) => {
    clock += ms;
    t.mock.timers.tick(ms);
  };
  const host = game.host;
  const act = (b) => {
    host.actions = []; // the host's flood guard let go (its own test: ten a second)
    return host.act('admin', b);
  };
  /** The admin's own menu (game.mjs 'mode'), as their page sends it. */
  const menu = (kind) => game.handle('admin', game.players.get('admin'), JSON.stringify({ t: 'mode', kind }));
  const cleared = () => out.filter((m) => m.t === 'announce' && m.ms === 0 && m.text === '' && !m.code);
  const counting = () => out.filter((m) => m.t === 'announce' && m.code === 'nextGame');
  host.act('admin', { op: 'programme', list: [{ kind: 'tag', minutes: 5 }, { kind: 'flag', place: 'compact', minutes: 5 }] });
  return { game, host, act, menu, wait, out, cleared, counting };
}

test('Stop during the countdown in free play: nothing starts, every page told the countdown is gone', (t) => {
  const s = setup(t);
  assert.deepEqual(s.act({ op: 'next' }), { ok: true });
  assert.equal(s.counting().length, 1, 'every page counts down');
  assert.equal(s.host.view().countdown.kind, 'tag');
  s.wait(4000);
  assert.deepEqual(s.act({ op: 'stop' }), { ok: true });
  assert.equal(s.host.countdown, null);
  assert.equal(s.host.view().countdown, null, 'the host page: no countdown');
  assert.equal(s.cleared().length, 1, 'every page told once: its countdown bar goes');
  s.wait(20_000);
  assert.equal(s.game.modes.state.kind, 'free', 'the queued game never started');
  assert.equal(s.out.filter((m) => m.t === 'mode').length, 0, 'no mode change at all');
  assert.equal(s.host.nextIndex, 1, 'the programme where Next put it, as with Cancel');
});

test('Stop while a game plays and the next one counts down: both end, nothing starts after', (t) => {
  const s = setup(t);
  s.act({ op: 'start', kind: 'hide', minutes: 5 });
  s.wait(10_000);
  assert.equal(s.game.modes.state.kind, 'hide', 'the first game started after its countdown');
  s.act({ op: 'next' });
  s.wait(5000);
  s.act({ op: 'stop' });
  assert.equal(s.game.modes.state.kind, 'free', 'the game playing stopped');
  assert.equal(s.host.countdown, null, 'and the one counting down called off');
  s.wait(20_000);
  assert.equal(s.game.modes.state.kind, 'free', 'still free play when the countdown would have ended');
  assert.equal(s.out.filter((m) => m.t === 'system' && m.code === 'tagStarted').length, 0);
});

test('Stop with nothing counting down leaves an announcement of the host\'s alone; Cancel clears as before', (t) => {
  const s = setup(t);
  s.act({ op: 'announce', text: 'Food is ready outside', secs: 30 });
  s.act({ op: 'start', kind: 'tag', minutes: 5 });
  s.wait(10_000);
  const before = s.cleared().length; // the countdown ran out: nothing to clear
  s.act({ op: 'stop' });
  assert.equal(s.cleared().length, before, 'no empty announcement: the host\'s own line stays on every screen');
  s.act({ op: 'cancel' });
  assert.equal(s.cleared().length, before + 1, 'Cancel clears the bar even with nothing counting down, as before');
});

test('Cancel calls off the countdown as before; a second Next replaces the first, which never fires', (t) => {
  const s = setup(t);
  s.act({ op: 'next' }); // tag
  s.wait(3000);
  s.act({ op: 'next' }); // flag, replacing it
  s.wait(8000); // the first one's ten seconds are over
  assert.equal(s.game.modes.state.kind, 'free', 'the replaced countdown never started its game');
  s.wait(3000);
  assert.equal(s.game.modes.state.kind, 'flag', 'the second one did, on its own clock');
  s.act({ op: 'stop' });
  s.act({ op: 'next' }); // the programme is done
  s.act({ op: 'start', kind: 'tag', minutes: 5 });
  s.act({ op: 'cancel' });
  assert.equal(s.host.countdown, null);
  s.wait(20_000);
  assert.equal(s.game.modes.state.kind, 'free');
});

test('the admin\'s own Stop or game from the in-game menu calls the host\'s countdown off; a player\'s does nothing', (t) => {
  const s = setup(t);
  s.act({ op: 'start', kind: 'flag', place: 'compact', minutes: 5 });
  // A player's page sends the same message: refused (game.mjs: the admin only), the countdown on.
  s.game.handle('ann', s.game.players.get('ann'), JSON.stringify({ t: 'mode', kind: 'free' }));
  s.game.handle('ann', s.game.players.get('ann'), JSON.stringify({ t: 'mode', kind: 'tag' }));
  assert.ok(s.host.countdown, 'a player calls nothing off');
  assert.equal(s.game.modes.state.kind, 'free');
  // Nonsense from the admin's page calls nothing off either.
  for (const kind of ['__proto__', 'constructor', 'nope', '']) s.menu(kind);
  assert.ok(s.host.countdown, 'no game of that kind: the countdown stays');
  s.menu('free');
  assert.equal(s.host.countdown, null, 'the admin\'s Stop from the menu calls it off');
  s.wait(15_000);
  assert.equal(s.game.modes.state.kind, 'free');
  // A game the admin starts by hand is not replaced ten seconds later by one the host queued.
  s.act({ op: 'start', kind: 'flag', place: 'compact', minutes: 5 });
  s.wait(2000);
  s.menu('tag');
  assert.equal(s.game.modes.state.kind, 'tag');
  s.wait(15_000);
  assert.equal(s.game.modes.state.kind, 'tag', 'the hand-started game plays on');
});

test('Stop and the timer racing: whichever comes first wins, and the state is whole either way', (t) => {
  const s = setup(t);
  // The timer first: the game starts, the Stop just after stops it, with no countdown left to call off.
  s.act({ op: 'start', kind: 'tag', minutes: 5 });
  s.wait(10_000);
  assert.equal(s.game.modes.state.kind, 'tag');
  const before = s.cleared().length;
  s.act({ op: 'stop' });
  assert.equal(s.game.modes.state.kind, 'free');
  assert.equal(s.cleared().length, before, 'nothing to call off');
  // Stop a moment before the end: nothing starts.
  s.act({ op: 'start', kind: 'tag', minutes: 5 });
  s.wait(9999);
  s.act({ op: 'stop' });
  s.wait(1);
  s.wait(10_000);
  assert.equal(s.game.modes.state.kind, 'free');
  // Stop spammed: the host's flood guard (ten a second) as before.
  s.host.actions = [];
  const r = Array.from({ length: 12 }, () => s.host.act('admin', { op: 'stop' }));
  assert.equal(r.filter((x) => x.ok).length, 10);
  assert.equal(r.filter((x) => x.code === 'tooFast').length, 2);
});
