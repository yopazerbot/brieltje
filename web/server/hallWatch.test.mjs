// The hall screen's watch views (src/watch.ts, admin/watch) in the Zombies duel's rooms (server/rooms.mjs upgrade,
// server/game.mjs watcher): only the admin's session watches, a duel room only by its side and only for the admin, never
// a players' room; a watcher is never counted or seen, nothing it sends is taken; the room's close sends it back; the
// host's view lists who plays in the duel rooms for the admin. Run: node --test server/hallWatch.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from './game.mjs';
import { Rooms } from './rooms.mjs';

const real = Date.now;
const SITE = { origin: 'http://brieltje.test', host: 'brieltje.test' };

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  let who = null; // the session the next upgrade carries
  const auth = {
    logged: [], sessions: new Map(),
    log(event, _req, extra) { this.logged.push({ event, ...extra }); },
    addressOf: () => '192.0.2.1', session: () => who,
    store: { saveZombieRun: async () => true, addStats: async () => {}, setMeta: async () => {} },
  };
  const made = [];
  const quiet = (g) => {
    for (const t of g.timers) clearInterval(t);
    return g;
  };
  const main = quiet(new Game(auth));
  const rooms = new Rooms(main, (room) => {
    const g = quiet(new Game(auth, undefined, room));
    made.push(g);
    return g;
  });
  clearInterval(rooms.duel.timer);
  const fake = (name) => {
    const on = {};
    const ws = { name, got: [], closed: null, readyState: 1, OPEN: 1, send: (d) => ws.got.push(JSON.parse(d)), on: (e, f) => (on[e] = f), close: (code) => { ws.closed ??= code; ws.readyState = 3; on.close?.(); }, fire: (e, d) => on[e]?.(d) };
    return ws;
  };
  /** Every game's WebSocket server hands over a fake socket (or a refusal is written to the raw socket). */
  const sockets = [];
  const hook = (g) => {
    g.wss.handleUpgrade = (_req, _socket, _head, done) => {
      const ws = fake('w');
      sockets.push(ws);
      done(ws);
    };
  };
  hook(main);
  /** An upgrade of `session` asking `q` through the rooms (as server.mjs does): the socket it got, or 'refused'. */
  const ask = (session, q, headers = SITE) => {
    for (const g of rooms.games()) hook(g);
    who = session;
    const raw = { refused: false, write: () => {}, destroy() { this.refused = true; } };
    const n = sockets.length;
    rooms.upgrade({ url: `/ws?v=2${q}`, headers }, raw, null);
    return raw.refused ? 'refused' : sockets.length > n ? sockets.at(-1) : 'none';
  };
  const join = (game, name) => {
    const ws = fake(name);
    game.join(ws, { username: name, role: 'player', key: `k-${name}` }, { headers: {}, socket: {}, url: '/ws?v=2' });
    game.players.get(name).state.armed = true;
    return ws;
  };
  const begin = (blue, red) => {
    main.host.teamCount = 2;
    for (const n of blue) main.host.teams[n] = 0;
    for (const n of red) main.host.teams[n] = 1;
    for (const n of [...blue, ...red]) join(main, n);
    assert.deepEqual(rooms.duel.start({ duel: 'warmup', minutes: 10 }, 'admin'), { ok: true });
    for (const n of [...blue, ...red]) join(rooms.duel.route({ username: n, role: 'player', key: `k-${n}` }), n);
    return rooms.duel.state.sides;
  };
  const admin = { username: 'admin', role: 'admin', key: 'k-admin' };
  const stop = () => {
    Date.now = real;
    for (const g of [main, ...made]) g.close();
  };
  return { main, rooms, ask, join, begin, admin, stop, tick: (ms) => (clock += ms) };
}

test("the admin's watcher reaches a duel team's room by its side; nobody else does, and no players' room", () => {
  const env = setup();
  try {
    const sides = env.begin(['ann'], ['bob']);
    const blue = env.ask(env.admin, '&watch=1&duel=blue');
    assert.notEqual(blue, 'refused');
    assert.equal(sides.blue.game.watchers.size, 1, "in blue's room");
    const welcome = blue.got.find((m) => m.t === 'welcome');
    assert.equal(welcome.watch, true);
    assert.equal(welcome.room.duel, 'blue');
    assert.ok(welcome.players.some((p) => p.name === 'ann'), 'told who plays there');
    const red = env.ask(env.admin, '&watch=1&duel=red');
    assert.equal(sides.red.game.watchers.size, 1, "in red's room");
    assert.ok(red.got.find((m) => m.t === 'welcome').players.some((p) => p.name === 'bob'));
    // A player's session (on a team or not), a guest, no session: refused in the room's own checks (a wallhack).
    for (const s of [{ username: 'ann', role: 'player', key: 'k-ann' }, { username: 'gus', role: 'guest', key: 'k-gus' }, null]) {
      assert.equal(env.ask(s, '&watch=1&duel=blue'), 'refused', `${s?.role ?? 'no session'} may not watch a duel room`);
    }
    // Another site's page (cross-site WebSocket hijacking): refused before anything is read.
    assert.equal(env.ask(env.admin, '&watch=1&duel=red', { origin: 'https://evil.test', host: 'brieltje.test' }), 'refused');
    assert.equal(env.ask(env.admin, '&watch=1&duel=red', { host: 'brieltje.test' }), 'refused');
    // A side that is no side, or a duel room's id: never a duel room.
    env.ask(env.admin, '&watch=1&duel=green');
    env.ask(env.admin, `&watch=1&room=${sides.blue.id}`);
    assert.equal(sides.blue.game.watchers.size, 1);
    assert.equal(sides.red.game.watchers.size, 1);
    // A players' room: the admin's watcher is refused there.
    const { room } = env.rooms.create({ username: 'cas', role: 'player' }, 'church');
    assert.equal(env.ask(env.admin, `&watch=1&room=${room.id}`), 'refused');
    // A page that asks for a duel room without watching: put where the server says (the duel's route), as before.
    assert.equal(env.ask({ username: 'nina', role: 'player', key: 'k-nina' }, '&duel=blue') === 'refused', false);
    assert.equal(sides.blue.game.players.has('nina'), false, 'not on a team: never in a duel room');
  } finally {
    env.stop();
  }
});

test('no duel on: a watcher asking for a side watches the open world', () => {
  const env = setup();
  try {
    const w = env.ask(env.admin, '&watch=1&duel=blue');
    assert.notEqual(w, 'refused');
    assert.equal(env.main.watchers.size, 1);
    assert.equal(w.got.find((m) => m.t === 'welcome').room, null);
  } finally {
    env.stop();
  }
});

test('a watcher in a duel room is never counted, seen or listed, and nothing it sends is taken', () => {
  const env = setup();
  try {
    const sides = env.begin(['ann', 'cas'], ['bob']);
    const g = sides.blue.game;
    const ann = g.players.get('ann');
    const before = { players: g.players.size, count: env.rooms.count(), view: env.rooms.duel.view().sides.map((s) => s.players), roster: env.rooms.roster().length };
    const seen = ann.ws.got.length;
    const w = env.ask(env.admin, '&watch=1&duel=blue');
    assert.equal(g.players.size, before.players);
    assert.equal(env.rooms.count(), before.count, 'not counted');
    assert.deepEqual(env.rooms.duel.view().sides.map((s) => s.players), before.view, "not in the duel's line");
    assert.equal(env.rooms.roster().length, before.roster, "not in the admin's player list");
    assert.ok(!env.main.host.inDuel().some((p) => p.name === '' || p.name === 'admin'), "not in the hall screen's list");
    const annWs = ann.ws;
    assert.ok(!annWs.got.slice(seen).some((m) => m.t === 'join'), 'the players are not told');
    // What it sends: a forged state, a chat line, a shot, a mode change, a team's start. None is taken.
    const at = { ...ann.state };
    for (const m of [
      { t: 'state', x: 1, y: 0, z: 1, yaw: 0, pitch: 0, armed: true, w: 'pistol' },
      { t: 'chat', text: 'hello from the watcher' },
      { t: 'shot', x: at.x, y: 1.5, z: at.z + 2, w: 'pistol', tx: at.x, ty: 1.5, tz: at.z },
      { t: 'mode', kind: 'zombies' },
      { t: 'hit', name: 'ann', w: 'pistol' },
    ]) w.fire('message', JSON.stringify(m));
    assert.ok(!annWs.got.slice(seen).some((m) => m.t === 'chat' || m.t === 'shot'), 'nothing reaches the players');
    assert.equal(ann.hp, g.players.get('ann').hp);
    assert.equal(g.players.size, before.players);
    assert.equal(g.modes.state.z, sides.blue.z, 'the room\'s game unchanged');
    // The room's broadcasts reach it (a chat line from a player there).
    g.broadcast({ t: 'chat', name: 'ann', text: 'hi' });
    assert.ok(w.got.some((m) => m.t === 'chat' && m.text === 'hi'));
  } finally {
    env.stop();
  }
});

test("the duel's end closes its rooms' watchers (4004: back to the open world); the host's view lists the duel's players", () => {
  const env = setup();
  try {
    const sides = env.begin(['ann'], ['bob']);
    const list = env.main.host.view().inDuel;
    assert.deepEqual(list.map((p) => [p.name, p.side]).sort(), [['ann', 'blue'], ['bob', 'red']]);
    assert.ok(list.every((p) => typeof p.alive === 'boolean' && Number.isInteger(p.kills) && Number.isInteger(p.beaten)));
    const w = env.ask(env.admin, '&watch=1&duel=red');
    env.rooms.duel.stop('admin');
    env.tick(20_000);
    env.rooms.duel.tick(Date.now());
    assert.equal(env.rooms.duel.on, false);
    assert.equal(w.closed, 4004);
    assert.equal(sides.red.game.watchers.size, 0);
    assert.deepEqual(env.main.host.view().inDuel, []);
    // Its page connects again with the same address: the open world now.
    const again = env.ask(env.admin, '&watch=1&duel=red');
    assert.notEqual(again, 'refused');
    assert.equal(env.main.watchers.size, 1);
  } finally {
    env.stop();
  }
});
