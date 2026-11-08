// Zombies rooms (server/rooms.mjs): who may open one, one each, at most four, a game of their own that
// changes nothing of the open world, and closed once empty. Run: node --test server/rooms.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from './game.mjs';
import { MAX_ROOMS, ROOM_PLAYERS, Rooms } from './rooms.mjs';

function fakeAuth() {
  const runs = [];
  return {
    runs, logged: [], sessions: new Map(),
    log(event, _req, extra) { this.logged.push({ event, ...extra }); },
    addressOf: () => '192.0.2.1',
    store: { saveZombieRun: async (...a) => (runs.push(a), true), addStats: async () => {}, setMeta: async () => {} },
  };
}

function hub() {
  const auth = fakeAuth();
  const main = new Game(auth);
  const made = [];
  const rooms = new Rooms(main, (room) => {
    const g = new Game(auth, undefined, room);
    made.push(g);
    return g;
  });
  const stop = () => [main, ...made].forEach((g) => g.close());
  return { auth, main, rooms, stop };
}

const player = (role) => ({ role, window: Date.now(), msgs: 0, states: 0, others: 0, ws: { close() {}, readyState: 0, OPEN: 1 } });

test('only an account or the admin opens a room; one each; at most four', () => {
  const { rooms, stop } = hub();
  try {
    assert.equal(rooms.create({ username: 'gast', role: 'guest' }, 'church').code, 'roomAccount');
    assert.equal(rooms.create(null, 'church').code, 'roomAccount');
    assert.equal(rooms.create({ username: 'anna', role: 'player' }, 'nowhere').code, 'roomPlace');
    const a = rooms.create({ username: 'anna', role: 'player' }, 'church').room;
    assert.match(a.id, /^[A-Za-z0-9_-]{12}$/);
    assert.deepEqual({ ...a, id: '' }, { id: '', mine: true, place: 'church', players: 0, max: ROOM_PLAYERS, wave: 0, playing: false });
    assert.equal(rooms.create({ username: 'anna', role: 'player' }, 'house').room.id, a.id, 'asking again gives her room back');
    rooms.create({ username: 'bram', role: 'player' }, 'house');
    rooms.create({ username: 'cato', role: 'player' }, 'molenhoek');
    rooms.create({ username: 'admin', role: 'admin' }, 'bungalow');
    assert.equal(rooms.list().rooms.length, MAX_ROOMS);
    assert.equal(rooms.create({ username: 'dirk', role: 'player' }, 'church').code, 'roomsFull');
  } finally {
    stop();
  }
});

test('the list names who opened a room only to the admin; everyone else sees the place, the players and whether it is theirs', () => {
  const { rooms, stop } = hub();
  try {
    rooms.create({ username: 'anna', role: 'player' }, 'church');
    rooms.create({ username: 'bram', role: 'player' }, 'house');
    const names = (viewer) => rooms.list(viewer).rooms.map((r) => [r.place, r.owner ?? null, r.mine ?? false]);
    assert.deepEqual(names({ username: 'gast', role: 'guest' }), [['church', null, false], ['house', null, false]], 'a guest: no names');
    assert.deepEqual(names(null), [['church', null, false], ['house', null, false]], 'no session: no names');
    assert.deepEqual(names({ username: 'anna', role: 'player' }), [['church', null, true], ['house', null, false]], 'anna: her own room, no names');
    assert.deepEqual(names({ username: 'admin', role: 'admin' }), [['church', 'anna', false], ['house', 'bram', false]], 'the admin: who opened each');
    assert.equal(JSON.stringify(rooms.list({ username: 'gast', role: 'guest' })).includes('anna'), false);
  } finally {
    stop();
  }
});

test("a room is a game of its own: its place's edge always, the open world's things untouched", () => {
  const { main, rooms, stop } = hub();
  try {
    main.rules.flying = false;
    main.furniture.set(7, { id: 7, item: 'chair', x: 1, y: 0, z: 1, yaw: 0 });
    const { id } = rooms.create({ username: 'anna', role: 'player' }, 'church').room;
    const g = rooms.rooms.get(id).game;
    assert.equal(g.room.id, id);
    assert.equal(g.rules.flying, false);
    assert.equal(g.rules.maxPlayers, ROOM_PLAYERS);
    assert.equal(g.furniture.get(7).item, 'chair');
    assert.notEqual(g.furniture, main.furniture, 'its own copy');
    assert.equal(g.fenced(), true);
    assert.equal(g.fence(), g.room.edge);
    assert.equal(main.fenced(), false, 'the open world is not fenced by it');
    // What a room refuses: the open world's furniture, rules and weather, trips and start places.
    let touched = 0;
    for (const k of ['furnish', 'setRules', 'setMood', 'travel', 'spawn', 'manualDrop', 'placeCar']) g[k] = () => (touched++, Promise.resolve());
    const p = player('admin');
    for (const t of ['furn', 'rules', 'mood', 'travel', 'spawn', 'chute', 'tesla']) g.handle('admin', p, JSON.stringify({ t, to: 'church', op: 'put' }));
    assert.equal(touched, 0);
    // Room full at ROOM_PLAYERS, the admin too.
    for (let i = 0; i < ROOM_PLAYERS; i++) g.players.set(`p${i}`, {});
    assert.equal(g.full('admin'), true);
    g.players.clear();
  } finally {
    stop();
  }
});

test('in a room anyone starts Zombies at its place; only accounts and the admin stop a game', () => {
  const { rooms, stop } = hub();
  try {
    const { id } = rooms.create({ username: 'anna', role: 'player' }, 'molenhoek').room;
    const g = rooms.rooms.get(id).game;
    const calls = [];
    let running = false;
    g.modes.start = (kind, by, place) => {
      calls.push([kind, by, place]);
      running = kind === 'zombies';
    };
    Object.defineProperty(g.modes, 'zombies', { get: () => (running ? {} : null) });
    const guest = player('guest');
    g.handle('gast', guest, JSON.stringify({ t: 'mode', kind: 'teams' }));
    g.handle('gast', guest, JSON.stringify({ t: 'mode', kind: 'zombies', place: 'house' }));
    assert.deepEqual(calls, [['zombies', 'gast', 'molenhoek']], "the room's place, whatever was sent");
    guest.nextMode = 0;
    g.handle('gast', guest, JSON.stringify({ t: 'mode', kind: 'free' }));
    assert.equal(calls.length, 1, "a guest can't stop it");
    g.handle('anna', player('player'), JSON.stringify({ t: 'mode', kind: 'free' }));
    assert.equal(calls.length, 1, 'not within ROOM_MODE_MS of the start, whoever asks (players taking turns)');
    g.nextRoomMode = 0;
    g.handle('anna', player('player'), JSON.stringify({ t: 'mode', kind: 'free' }));
    assert.deepEqual(calls.at(-1), ['free', 'anna', 'molenhoek']);
  } finally {
    stop();
  }
});

test("the admin's rules reach every room (its own limit kept), and the admin closes a room", async () => {
  const { main, rooms, stop } = hub();
  try {
    const { id } = rooms.create({ username: 'anna', role: 'player' }, 'church').room;
    const g = rooms.rooms.get(id).game;
    const told = [];
    g.broadcast = (m) => told.push(m);
    main.auth.store.setMeta = async () => {};
    await main.setRules({ paintball: true, maxPlayers: 12 }, 'admin');
    assert.equal(g.rules.paintball, true, 'child-friendly for everyone, the room too');
    assert.equal(g.rules.maxPlayers, ROOM_PLAYERS);
    assert.ok(told.some((m) => m.t === 'rules') && told.some((m) => m.code === 'rules'));
    assert.equal(rooms.close('nope', 'admin'), false);
    assert.equal(rooms.close(id, 'admin'), true);
    assert.equal(rooms.rooms.has(id), false);
  } finally {
    stop();
  }
});

test('a Zombies run counts for accounts and the admin, never a guest; fighting totals too', () => {
  const { auth, main, stop } = hub();
  try {
    let added = 0;
    auth.store.addStats = async () => void added++;
    main.roles.set('anna', 'player');
    main.roles.set('gast', 'guest');
    main.roles.set('admin', 'admin');
    main.zombieRun('church', ['anna', 'gast', 'admin'], 7, { anna: 12, gast: 30 });
    assert.deepEqual(auth.runs, [['anna', 'church', 7, 12, 3], ['admin', 'church', 7, 0, 3]]); // the admin's too (Yoshi, 8 Nov 2026)
    main.stats('anna', { kills: 1 });
    main.stats('gast', { kills: 1 });
    main.stats('admin', { kills: 1 });
    assert.equal(added, 2, 'not the guest');
  } finally {
    stop();
  }
});

test('one name in one place: joining elsewhere ends the other connection; empty rooms close', () => {
  const { main, rooms, stop } = hub();
  try {
    const { id } = rooms.create({ username: 'anna', role: 'player' }, 'church').room;
    const r = rooms.rooms.get(id);
    let closed = null;
    main.players.set('anna', { ws: { close: (code) => (closed = code) } });
    r.game.players.set('anna', {});
    rooms.joined('anna', r.game, { role: 'player' });
    assert.equal(closed, 4000);
    main.players.delete('anna');
    assert.equal(rooms.gameOf('anna'), r.game);
    assert.equal(rooms.count(), 1);
    r.game.players.clear();
    const now = Date.now();
    rooms.sweep(now);
    rooms.sweep(now + 60_000);
    assert.equal(rooms.rooms.has(id), true, 'not yet');
    rooms.sweep(now + 91_000);
    assert.equal(rooms.rooms.has(id), false);
    assert.equal(rooms.list().rooms.length, 0);
  } finally {
    stop();
  }
});
