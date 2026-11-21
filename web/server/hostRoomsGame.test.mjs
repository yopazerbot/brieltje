// The host's countdown, start and Stop reach the Zombies rooms (server/host.mjs startIn, gather, busy, stop;
// server/rooms.mjs closeRooms): the countdown shows in every room (the players' and the duel's), the players' rooms close
// GATHER_MS before the host's game starts (their game ended as by its own Stop: no run kept, no points) so their players
// are in it from its start, the duel ends as the host's Stop ends it and its rooms close at once, the host's Stop brings
// everyone in a room back to free play in the house, and no room opens while the host's countdown or game in the house is
// on (the duel keeps its own rule: rooms open as before during it, and it takes the teams' players at its start). What a
// player's page could try (its own mode messages, opening a room) never reaches another room or the host's controls.
// Run: node --test server/hostRoomsGame.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from './game.mjs';
import { Rooms } from './rooms.mjs';
import { GATHER_MS } from './host.mjs';

const real = Date.now;

function setup(t) {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const kept = [];
  const auth = {
    log() {}, addressOf: () => '192.0.2.1', session: () => null,
    store: { saveZombieRun: async (...a) => (kept.push(a), true), addStats: async () => {}, setMeta: async () => {} },
  };
  const quiet = (g) => {
    for (const x of g.timers) clearInterval(x);
    return g;
  };
  const main = quiet(new Game(auth));
  const made = [];
  const rooms = new Rooms(main, (room) => {
    const g = quiet(new Game(auth, undefined, room));
    made.push(g);
    return g;
  });
  clearInterval(rooms.duel.timer);
  const pages = new Map(); // name -> the page's current socket
  /** A page of `name` connects to `game`; its socket's close runs the game's leave, as the real one does. */
  const join = (game, name, role = 'player') => {
    const on = {};
    const ws = {
      name, got: [], closed: null, readyState: 1, OPEN: 1,
      send: (d) => ws.got.push(JSON.parse(d)), on: (e, f) => (on[e] = f),
      close: (code) => {
        if (ws.readyState === 3) return;
        ws.readyState = 3;
        ws.closed = code;
        on.close?.();
      },
    };
    game.join(ws, { username: name, role, key: `k-${name}` }, { headers: {}, socket: {}, url: '/ws?v=2' });
    pages.set(name, ws);
    return ws;
  };
  /** Pages closed with 4004 (their room closed) connect to the open world again, as src/net/client.ts does. */
  const follow = () => {
    for (const [name, ws] of pages) if (ws.closed === 4004 || ws.closed === 4006) join(rooms.duel.route({ username: name, role: 'player', key: `k-${name}` }) ?? main, name);
  };
  for (const n of ['ann', 'bob', 'cid', 'dee']) join(main, n);
  join(main, 'admin', 'admin');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wait = (ms) => {
    clock += ms;
    t.mock.timers.tick(ms);
  };
  const act = (b) => {
    main.host.actions = [];
    return main.host.act('admin', b);
  };
  /** A players' room at the church opened by `owner`, with `names` in it and its Zombies started by the first. */
  const room = (owner, names, zombies = true) => {
    const r = rooms.create({ username: owner, role: 'player' }, 'church');
    assert.ok(r.room, JSON.stringify(r));
    const g = rooms.rooms.get(r.room.id).game;
    for (const n of names) join(g, n);
    if (zombies) {
      g.handle(names[0], g.players.get(names[0]), JSON.stringify({ t: 'mode', kind: 'zombies' }));
      assert.equal(g.modes.state.kind, 'zombies', 'the room plays Zombies');
    }
    return g;
  };
  const tick = () => new Promise((r) => setImmediate(r));
  const stop = () => {
    Date.now = real;
    for (const g of [main, ...made]) {
      try {
        g.close();
      } catch {
        // closed already
      }
    }
  };
  return { main, rooms, made, join, follow, pages, wait, act, room, tick, kept, stop };
}

const counting = (ws) => ws.got.filter((m) => m.t === 'announce' && m.code === 'nextGame' && m.count);
const cleared = (ws) => ws.got.some((m) => m.t === 'announce' && m.ms === 0 && m.text === '');

test('the host\'s countdown shows in every players\' room and both duel rooms; Cancel takes it away there too', async (t) => {
  const s = setup(t);
  try {
    const g = s.room('eva', ['eva', 'fay']);
    assert.deepEqual(s.act({ op: 'start', kind: 'tag', minutes: 5 }), { ok: true });
    for (const n of ['ann', 'admin', 'eva', 'fay']) assert.equal(counting(s.pages.get(n)).length, 1, `${n} sees the countdown`);
    assert.equal(counting(s.pages.get('eva'))[0].ms, 10_000);
    // Someone coming into the room during the countdown: told the rest of it, after the welcome.
    s.wait(4000);
    const late = s.join(g, 'gus');
    await s.tick();
    assert.equal(counting(late).length, 1, 'a page that comes in during it gets the line');
    assert.equal(counting(late)[0].ms, 6000, 'with the time left');
    assert.deepEqual(s.act({ op: 'cancel' }), { ok: true });
    for (const n of ['ann', 'eva', 'fay', 'gus']) assert.ok(cleared(s.pages.get(n)), `${n}'s bar goes`);
    s.wait(20_000);
    assert.equal(s.rooms.rooms.size, 1, 'called off before the gathering: the room plays on');
    assert.equal(g.modes.state.kind, 'zombies');
    assert.equal(s.main.modes.state.kind, 'free');
  } finally {
    s.stop();
  }
});

test('the countdown reaches the Zombies duel\'s two rooms too', (t) => {
  const s = setup(t);
  try {
    const h = s.main.host;
    h.teamCount = 2;
    h.teams.ann = 0;
    h.teams.bob = 0;
    h.teams.cid = 1;
    h.teams.dee = 1;
    assert.deepEqual(s.rooms.duel.start({ duel: 'warmup', minutes: 10 }, 'admin'), { ok: true });
    s.follow(); // the duel moved them (4006): their pages connect again, into their team's room
    const [blue, red] = s.rooms.duel.games();
    assert.ok(blue.players.has('ann') && red.players.has('cid'));
    s.act({ op: 'start', kind: 'tag', minutes: 5 });
    for (const n of ['ann', 'bob', 'cid', 'dee', 'admin']) assert.equal(counting(s.pages.get(n)).length, 1, `${n} sees it`);
  } finally {
    s.stop();
  }
});

test('the host\'s game starts: the players\' rooms close first, nothing kept or won there, their players in it from its start', (t) => {
  const s = setup(t);
  try {
    const g = s.room('eva', ['eva', 'fay']);
    const z = g.modes.state.z;
    z.horde.wave = 4; // a good run going on in the room
    const idle = s.room('hal', ['hal'], false); // a room where nothing plays
    assert.deepEqual(s.act({ op: 'start', kind: 'hide', minutes: 5 }), { ok: true });
    s.wait(10_000 - GATHER_MS - 1);
    assert.equal(s.rooms.rooms.size, 2, 'the rooms play on during the countdown');
    s.wait(1);
    assert.equal(s.rooms.rooms.size, 0, 'GATHER_MS before the start: every players\' room is closed');
    for (const n of ['eva', 'fay', 'hal']) {
      const ws = s.pages.get(n);
      assert.equal(ws.closed, 4004, `${n}'s page goes to the open world`);
      assert.ok(ws.got.some((m) => m.t === 'system' && m.code === 'roomsHostGame'), `${n} is told why`);
    }
    assert.equal(g.modes.state.z?.horde.zombies.size ?? 0, 0, 'the room\'s zombies are gone');
    assert.equal(s.kept.length, 0, 'no Zombies run kept for the boards');
    assert.equal(s.main.zombieBests?.size ?? 0, 0);
    s.follow();
    for (const n of ['eva', 'fay', 'hal']) assert.ok(s.main.players.has(n), `${n} is in the house`);
    s.wait(GATHER_MS);
    const st = s.main.modes.state;
    assert.equal(st.kind, 'hide', 'the host\'s game started');
    for (const n of ['eva', 'fay', 'hal']) assert.ok(st.players.has(n), `${n} plays it from its start (not a late seeker)`);
    assert.equal(idle.players.size, 0);
    assert.deepEqual(Object.keys(s.main.host.scores), [], 'nobody scored for the room\'s game');
  } finally {
    s.stop();
  }
});

test('the host\'s Stop ends the players\' rooms\' games and brings their players back to free play in the house', (t) => {
  const s = setup(t);
  try {
    const g = s.room('eva', ['eva', 'fay']);
    assert.equal(s.main.host.view().rooms, 1, 'the host page knows Stop has something to stop in free play');
    assert.deepEqual(s.act({ op: 'stop' }), { ok: true });
    assert.equal(s.rooms.rooms.size, 0);
    for (const n of ['eva', 'fay']) {
      assert.equal(s.pages.get(n).closed, 4004);
      assert.ok(s.pages.get(n).got.some((m) => m.t === 'system' && m.code === 'roomsHostStop'));
    }
    assert.equal(g.modes.state.z?.horde.zombies.size ?? 0, 0);
    assert.equal(s.kept.length, 0, 'no run kept');
    s.follow();
    assert.ok(s.main.players.has('eva') && s.main.players.has('fay'));
    assert.equal(s.main.modes.state.kind, 'free');
    assert.equal(s.main.host.view().rooms, 0);
  } finally {
    s.stop();
  }
});

test('a Zombies duel still on when the host\'s next game starts ends as Stop ends it, its rooms closed in time', (t) => {
  const s = setup(t);
  try {
    const h = s.main.host;
    h.teamCount = 2;
    h.teams.ann = 0;
    h.teams.bob = 0;
    h.teams.cid = 1;
    h.teams.dee = 1;
    s.rooms.duel.start({ duel: 'warmup', minutes: 10 }, 'admin');
    s.follow();
    assert.equal(s.main.players.has('ann'), false, 'in the duel');
    // The hall screen watching the blue room (src/watch.ts): it follows, back to the open world when the room closes.
    const hall = { got: [], closed: null, readyState: 1, OPEN: 1, send: (d) => hall.got.push(JSON.parse(d)), on: () => {}, close: (code) => (hall.closed = code) };
    s.rooms.duel.games()[0].watcher(hall, { key: 'k-admin', role: 'admin' });
    s.act({ op: 'start', kind: 'tag', minutes: 5 });
    assert.equal(counting(hall).length, 1, 'the hall screen\'s view in the duel room shows the countdown');
    s.wait(10_000 - GATHER_MS);
    assert.equal(s.rooms.duel.on, false, 'the duel is over, its rooms closed');
    assert.equal(hall.closed, 4004, 'the watch view goes back to the open world with them');
    assert.ok(s.pages.get('admin').got.some((m) => m.t === 'system' && (m.code === 'duelWon' || m.code === 'duelDraw')), 'ranked as the host\'s Stop ranks it');
    assert.equal(h.history.at(-1)?.kind, 'duel');
    s.follow();
    for (const n of ['ann', 'bob', 'cid', 'dee']) assert.ok(s.main.players.has(n), `${n} back in the house`);
    s.wait(GATHER_MS);
    assert.equal(s.main.modes.state.kind, 'tag');
    for (const n of ['ann', 'bob', 'cid', 'dee']) assert.ok(n in s.main.modes.state.times, `${n} plays tag from its start`);
  } finally {
    s.stop();
  }
});

test('no room opens while the host\'s countdown runs or the host\'s game or duel plays; after it, as before', (t) => {
  const s = setup(t);
  try {
    const ask = (u = 'ivy', role = 'player') => s.rooms.create({ username: u, role }, 'church');
    s.room('ole', ['ole'], false);
    s.act({ op: 'start', kind: 'tag', minutes: 5 });
    assert.equal(ask().code, 'hostSoon', 'during the countdown');
    assert.equal(ask('ole').code, 'hostSoon', 'nor is an owner\'s room given back (it closes in a moment)');
    assert.equal(ask('admin', 'admin').code, 'hostSoon', 'the admin too: everyone plays the host\'s game');
    assert.equal(ask('gast', 'guest').code, 'roomAccount', 'a guest is told as before');
    s.wait(10_000);
    assert.equal(s.main.modes.state.kind, 'tag');
    assert.equal(ask().code, 'hostPlaying', 'while it plays');
    assert.equal(ask().status, 409);
    s.act({ op: 'stop' });
    assert.ok(ask().room, 'free play: a room opens as before');
    // The Zombies duel keeps its own rule (server/duel.mjs, its tests): the players' rooms open as before, in its
    // countdown and while it plays, and nobody on a team plays in one (the duel takes them at its start).
    const h = s.main.host;
    h.teamCount = 2;
    h.teams.ann = 0;
    h.teams.cid = 1;
    assert.deepEqual(s.act({ op: 'start', kind: 'duel', duel: 'warmup', minutes: 10 }), { ok: true });
    assert.ok(ask('jan').room, 'in the duel\'s countdown');
    s.wait(10_000);
    assert.ok(s.rooms.duel.on);
    assert.equal(s.rooms.rooms.size, 2, 'the duel\'s countdown closed no players\' room');
    assert.ok(ask('kai').room, 'while the duel plays');
  } finally {
    s.stop();
  }
});

test('a player\'s page reaches none of it: its own mode messages start no countdown and end no other room', (t) => {
  const s = setup(t);
  try {
    const a = s.room('eva', ['eva', 'fay']);
    const b = s.room('kim', ['kim', 'lou']);
    // In the open world a player's 'mode' is refused (the admin's only): no game, no countdown, the rooms play on.
    for (const kind of ['tag', 'hide', 'free', 'zombies', 'duel']) s.main.handle('ann', s.main.players.get('ann'), JSON.stringify({ t: 'mode', kind }));
    assert.equal(s.main.host.countdown, null);
    assert.equal(s.main.modes.state.kind, 'free');
    assert.equal(s.rooms.rooms.size, 2);
    // In a room a player's Stop ends that room's game only (as before), never the other room's, never closes a room.
    s.wait(6000); // past the room's own limit on starting and stopping (game.mjs ROOM_MODE_MS)
    a.handle('fay', a.players.get('fay'), JSON.stringify({ t: 'mode', kind: 'free' }));
    assert.equal(a.modes.state.kind, 'free');
    assert.equal(b.modes.state.kind, 'zombies', 'the other room plays on');
    assert.equal(s.rooms.rooms.size, 2);
    // Messages of the host's actions sent over the game's socket are no messages at all there.
    for (const op of ['stop', 'start', 'next', 'cancel']) a.handle('fay', a.players.get('fay'), JSON.stringify({ t: op, op, kind: 'tag' }));
    assert.equal(s.main.host.countdown, null);
    assert.equal(b.modes.state.kind, 'zombies');
  } finally {
    s.stop();
  }
});
