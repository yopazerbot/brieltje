// The host's countdown, start and Stop reach the Zombies rooms (server/host.mjs startIn, gather, busy, stop;
// server/rooms.mjs closeRooms): the countdown shows in every room (the players' and the duel's), the players' rooms close
// GATHER_MS before the host's game starts (their game ended as by its own Stop: no run kept, no points) so their players
// are in it from its start, the duel ends as the host's Stop ends it and its rooms close at once, the host's Stop brings
// everyone in a room back to free play in the house, and no room opens while the host's countdown or game in the house is
// on (the duel keeps its own rule: rooms open as before during it, and it takes the teams' players at its start). What a
// player's page could try (its own mode messages, opening a room) never reaches another room or the host's controls.
// The host's freeze, mute, chat off, kick, move and bring reach a player wherever they play (game.mjs lan, host.mjs
// where, fetch): bring takes them out of a room to the host, a move in the duel is refused with its code.
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
    log() {}, addressOf: () => '192.0.2.1', session: () => null, kick: async () => {},
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

/** The Zombies duel on, ann and bob blue, cid and dee red, their pages in its rooms. */
function duelOn(s) {
  const h = s.main.host;
  h.teamCount = 2;
  h.teams.ann = 0;
  h.teams.bob = 0;
  h.teams.cid = 1;
  h.teams.dee = 1;
  assert.deepEqual(s.rooms.duel.start({ duel: 'warmup', minutes: 10 }, 'admin'), { ok: true });
  s.follow();
  for (const p of s.pages.values()) if (p.closed === 4006) p.closed = 'moved'; // followed: not again
  return s.rooms.duel.games();
}
/** `name` (in `g`) asks to step 0.3 m along x; where the server has them after. */
const stepX = (s, g, name) => {
  const p = g.players.get(name);
  Object.assign(p, { window: Date.now(), msgs: 0, states: 0, others: 0 });
  const st = p.state;
  g.handle(name, p, JSON.stringify({ t: 'state', x: st.x + 0.3, y: st.y, z: st.z, yaw: 0, pitch: 0, armed: false, w: 'pistol' }));
  return p.state.x;
};
const says = (ws, code) => ws.got.some((m) => m.t === 'system' && m.code === code);

test('the host\'s freeze, mute and chat off reach the players\' rooms and the duel\'s', async (t) => {
  const s = setup(t);
  try {
    const room = s.room('eva', ['eva', 'fay'], false);
    const [blue] = duelOn(s);
    s.wait(3000);
    const x0 = room.players.get('eva').state.x;
    assert.ok(Math.abs(stepX(s, room, 'eva') - (x0 + 0.3)) < 1e-6, 'free: the step is taken');
    assert.deepEqual(s.act({ op: 'freeze', on: true, text: 'Pizza' }), { ok: true });
    for (const n of ['eva', 'ann', 'cid']) assert.ok(s.pages.get(n).got.some((m) => m.t === 'freeze' && m.on && m.text === 'Pizza'), `${n} is told`);
    s.wait(1000);
    const x1 = room.players.get('eva').state.x;
    assert.equal(stepX(s, room, 'eva'), x1, 'frozen in a players\' room: held where they stand');
    const a1 = blue.players.get('ann').state.x;
    assert.equal(stepX(s, blue, 'ann'), a1, 'and in a duel room');
    assert.ok(room.lan.holds(room.players.get('fay')) && blue.lan.holds(blue.players.get('bob')));
    // Someone coming into a room while everyone is frozen: frozen too, after the welcome.
    const late = s.join(room, 'gus');
    await s.tick();
    assert.ok(late.got.some((m) => m.t === 'freeze' && m.on), 'told after the welcome');
    s.act({ op: 'freeze', on: false });
    assert.ok(s.pages.get('eva').got.some((m) => m.t === 'freeze' && !m.on));
    s.wait(1000);
    const x2 = room.players.get('eva').state.x;
    assert.ok(Math.abs(stepX(s, room, 'eva') - (x2 + 0.3)) < 1e-6, 'let go: the step is taken again');
    assert.equal(room.lan.holds(room.players.get('eva')), false);
    // Mute: a player in a room, as in the house (before: "Not here").
    assert.deepEqual(s.act({ op: 'mute', name: 'Fay', on: true }), { ok: true }, 'by a name typed with a capital');
    assert.ok(says(s.pages.get('fay'), 'youMuted'));
    const chat = (g, n) => {
      const p = g.players.get(n);
      p.lastChat = 0;
      Object.assign(p, { window: Date.now(), msgs: 0, others: 0 });
      const before = s.pages.get('eva').got.filter((m) => m.t === 'chat').length;
      g.handle(n, p, JSON.stringify({ t: 'chat', text: 'hello' }));
      return s.pages.get('eva').got.filter((m) => m.t === 'chat').length > before;
    };
    assert.equal(chat(room, 'fay'), false, 'muted in the room: nobody hears it');
    assert.equal(chat(room, 'gus'), true, 'the others still chat');
    s.act({ op: 'mute', name: 'fay', on: false });
    assert.equal(chat(room, 'fay'), true);
    s.act({ op: 'chat', on: false });
    assert.ok(says(s.pages.get('ann'), 'chatOffAll'), 'the duel room hears the chat is off');
    assert.equal(chat(room, 'fay'), false, 'chat off in the rooms too');
    s.act({ op: 'chat', on: true });
    assert.equal(chat(room, 'fay'), true);
  } finally {
    s.stop();
  }
});

test('the host\'s kick and move reach a player in a room; a move in the duel is refused with a code', (t) => {
  const s = setup(t);
  try {
    s.main.host.teamCount = 2;
    const room = s.room('eva', ['eva', 'fay'], false);
    assert.deepEqual(s.act({ op: 'move', name: 'eva', team: 1 }), { ok: true }, 'a players\' room: their team for the evening');
    assert.equal(s.main.host.teams.eva, 1);
    const [blue] = duelOn(s);
    assert.ok(blue.players.has('ann'));
    const r = s.act({ op: 'move', name: 'ann', team: 1 });
    assert.equal(r.code, 'duelMove', 'in the duel they play for the team they had at its start');
    assert.equal(s.main.host.teams.ann, 0, 'unchanged');
    // The host page lists them, where they are.
    const away = s.main.host.view().away;
    // (eva, red tonight since the move, was taken into red's room by the duel's start; fay, on no team, stays in hers.)
    assert.deepEqual(away.filter((p) => ['ann', 'eva', 'fay'].includes(p.name)).map((p) => [p.name, p.where]).sort(), [['ann', 'duel-blue'], ['eva', 'duel-red'], ['fay', 'room']]);
    // Kick (before: "Pick another player" for anyone not in the house).
    assert.deepEqual(s.act({ op: 'kick', name: 'fay' }), { ok: true });
    assert.deepEqual(s.act({ op: 'kick', name: 'dee' }), { ok: true });
    assert.equal(s.pages.get('fay').closed, 4001, 'out of the players\' room');
    assert.equal(s.pages.get('dee').closed, 4001, 'out of the duel room');
    assert.equal(room.players.has('fay'), false);
    assert.equal(s.act({ op: 'kick', name: 'admin' }).code, 'pickAnother', 'never the host');
    assert.equal(s.act({ op: 'kick', name: 'nobody' }).code, 'pickAnother');
  } finally {
    s.stop();
  }
});

test('the host brings a player out of a players\' room or the duel\'s, to where the host stands; the duel does not take them back', async (t) => {
  const s = setup(t);
  try {
    const me = s.main.players.get('admin').state;
    Object.assign(me, { x: 4.5, y: -0.1, z: 14 });
    const room = s.room('eva', ['eva', 'fay']);
    assert.deepEqual(s.act({ op: 'bring', name: 'eva' }), { ok: true });
    assert.equal(s.pages.get('eva').closed, 4006, 'their page goes to the open world at once (src/net/client.ts)');
    assert.ok(says(s.pages.get('eva'), 'hostBrings'));
    assert.equal(room.players.has('eva'), false, 'out of the room\'s game');
    assert.equal(room.modes.state.kind, 'zombies', 'which plays on for the others');
    s.follow();
    await s.tick();
    const eva = s.main.players.get('eva').state;
    assert.ok(Math.hypot(eva.x - me.x, eva.z - me.z) < 4, `by the host: ${eva.x},${eva.z}`);
    // Out of the duel's blue room.
    const [blue] = duelOn(s);
    s.wait(1000);
    assert.deepEqual(s.act({ op: 'bring', name: 'bob' }), { ok: true });
    assert.equal(blue.players.has('bob'), false);
    s.follow();
    await s.tick();
    await s.tick();
    assert.ok(s.main.players.has('bob'), 'in the house');
    const bob = s.main.players.get('bob').state;
    assert.ok(Math.hypot(bob.x - me.x, bob.z - me.z) < 4, `by the host: ${bob.x},${bob.z}`);
    s.rooms.duel.pull();
    assert.ok(s.main.players.has('bob') && s.pages.get('bob').closed === null, 'the duel\'s next pull leaves them in the house');
    assert.equal(s.rooms.duel.route({ username: 'bob', role: 'player', key: 'k-bob' }), null, 'a reload of theirs comes to the house too');
    // The host not in the game: nobody is taken out of a room.
    s.main.players.get('admin').state = null;
    assert.equal(s.act({ op: 'bring', name: 'ann' }).code, 'notInGame');
    assert.ok(blue.players.has('ann'));
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
    for (const op of ['stop', 'start', 'next', 'cancel', 'freeze', 'mute', 'chat', 'kick', 'move', 'bring']) {
      for (const g of [a, s.main]) {
        const n = g === a ? 'fay' : 'ann';
        const p = g.players.get(n);
        Object.assign(p, { window: Date.now(), msgs: 0, others: 0 });
        g.handle(n, p, JSON.stringify({ t: op, op, kind: 'tag', on: op !== 'chat', name: 'kim', team: 1, text: 'x' }));
      }
    }
    assert.equal(s.main.host.countdown, null);
    assert.equal(s.main.host.frozen, null, 'nobody frozen');
    assert.equal(s.main.host.muted.size, 0, 'nobody muted');
    assert.equal(s.main.host.chatOff, false);
    assert.ok(b.players.has('kim') && b.players.has('lou'), 'nobody kicked or taken out of a room');
    assert.equal(b.modes.state.kind, 'zombies');
  } finally {
    s.stop();
  }
});
