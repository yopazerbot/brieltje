// Who has a bad connection, on the host page (server/hostLink.mjs, server/host.mjs view({ links }), GET /api/host?links=1):
// the four grades from the network's round trip, its jitter and missed pings; a page that never answers is bad, not
// missing; a slow device told from a slow network by the game's own ping; a busy server's own delay counted against
// nobody. Only in the view that asks for it, in the house and in the rooms: never in the plain view (the hall screen's
// watch page and the admin panel read that one). The refusal without a session (401) and for a guest (403) is
// server.mjs's admin check before every /api/host route: tools/dev/host_links_check.mjs checks it against a running server.
// Run: node --test server/hostLink.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Game } from './game.mjs';
import { Rooms } from './rooms.mjs';
import { links } from './linkQuality.mjs';
import { judge, serverLoad, BUSY_LAG_MS, LOST_LAG_MS } from './hostLink.mjs';

const link = (o = {}) => ({ connected: true, rtt: 20, mean: 20, jitter: 2, missed: 0, waiting: false, reconnects: 0, lost: 0, ...o });
const grade = (o, extra = {}) => judge({ link: link(o), ...extra }).grade;

test('the four grades: the round trip, its jitter, missed pings, a fresh reconnect', () => {
  assert.equal(grade({ mean: 12, rtt: 14 }), 0, 'good: quick and steady');
  assert.equal(grade({ mean: 12, jitter: 35 }), 1, 'fair: quick but unsteady');
  assert.equal(grade({ mean: 90, rtt: 95 }), 1, 'fair: to 120 ms');
  assert.equal(grade({ mean: 180, rtt: 170 }), 2, 'poor: to 250 ms');
  assert.equal(grade({ mean: 20, jitter: 60 }), 2, 'poor: jittery');
  assert.equal(grade({ mean: 20, rtt: 400 }), 2, 'poor: the last one very late');
  assert.equal(grade({ mean: 300, rtt: 320 }), 3, 'bad: beyond 250 ms');
  assert.equal(grade({ mean: 20 }, { recent: 1 }), 2, 'one ping missed in the last minute: poor');
  assert.equal(grade({ mean: 20, waiting: true }), 2, 'one unanswered now: poor');
  assert.equal(grade({ mean: 20 }, { recent: 3 }), 3, 'pings missed again and again: bad');
  const now = 1_800_000_000_000;
  assert.equal(grade({ mean: 20, reconnects: 1 }, { since: now - 20_000, now }), 2, 'just back after a lost connection: poor');
  assert.equal(grade({ mean: 20, reconnects: 1 }, { since: now - 120_000, now }), 0, 'back a while ago: as the rest');
});

test('a page that never answers is bad, not missing; one just come in is still measured', () => {
  const never = judge({ link: link({ rtt: null, mean: null, jitter: null, waiting: true }), recent: 2 });
  assert.equal(never.grade, 3);
  assert.equal(never.rtt, null);
  assert.equal(never.missed, 2);
  assert.equal(judge({ link: link({ rtt: null, mean: null, jitter: null }) }).grade, null, 'no ping overdue yet: measuring');
  assert.equal(judge({ link: null }).grade, null, 'nothing known');
});

test('the device or the network: the game\'s own ping against the network\'s', () => {
  assert.equal(judge({ link: link({ mean: 15 }), ping: 30 }).slow, 'none', 'a few ms of frame: fine');
  assert.equal(judge({ link: link({ mean: 15 }), ping: 140 }).slow, 'device', 'the page answers late, the network is quick');
  assert.equal(judge({ link: link({ mean: 15 }), ping: 140 }).grade, 0, 'the connection itself is good');
  assert.equal(judge({ link: link({ mean: 300 }), ping: 310 }).slow, 'network', 'both late by as much: the network');
  assert.equal(judge({ link: link({ mean: 300 }), ping: 420 }).slow, 'both');
  assert.equal(judge({ link: link({ mean: 15 }), ping: null }).slow, 'none', 'no game ping (an old page): the network only');
});

test('a busy server\'s own delay is taken off, and its misses are nobody\'s', () => {
  assert.deepEqual(serverLoad({ lagMs: 4, tickMaxMs: 20 }), { busy: false, lagMs: 4, delay: 0 });
  assert.equal(serverLoad({ lagMs: BUSY_LAG_MS, tickMaxMs: 20 }).busy, true, 'its loop late');
  assert.equal(serverLoad({ lagMs: 5, tickMaxMs: 140 }).delay, 140, 'a tick far over its 50 ms');
  assert.equal(serverLoad(undefined).busy, false, 'no sample yet');
  const load = serverLoad({ lagMs: 150, tickMaxMs: 160 });
  assert.equal(grade({ mean: 175, rtt: 180, jitter: 40 }), 2, 'as measured: poor');
  assert.equal(grade({ mean: 175, rtt: 180, jitter: 40 }, { load }), 0, 'the server\'s 160 ms off: good');
  assert.equal(grade({ mean: 600, rtt: 610 }, { load }), 3, 'still slow without it: still bad');
  const deaf = serverLoad({ lagMs: LOST_LAG_MS, tickMaxMs: 900 });
  assert.equal(grade({ mean: 1010, waiting: true }, { load: deaf, recent: 4 }), 0, 'the server too late to hear: no miss counted');
});

// The view, with the game's own players and rooms (as hostAddresses.test.mjs) and the pings delivered by hand.
function setup() {
  let clock = 1_800_000_000_000;
  const real = Date.now;
  Date.now = () => clock;
  let mono = 1_000_000;
  const linkNow = links.now;
  const linkAuto = links.auto;
  links.now = () => mono;
  links.auto = false; // the pings by hand
  let who = null;
  const auth = {
    sessions: new Map(), log() {}, addressOf: () => '192.0.2.1', session: () => who, kick: async () => {},
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
  const sockets = [];
  /** A page's socket: what it is sent, the WebSocket pings it gets (their payloads), and several listeners per event. */
  const fake = () => {
    const ws = Object.assign(new EventEmitter(), {
      got: [], pings: [], readyState: 1, OPEN: 1,
      send: (d) => ws.got.push(d),
      ping: (data) => ws.pings.push(data),
      close: () => { if (ws.readyState !== 3) (ws.readyState = 3), ws.emit('close', 1000); },
      terminate: () => ws.close(),
    });
    return ws;
  };
  const hook = (g) => {
    g.wss.handleUpgrade = (_req, _socket, _head, done) => {
      const ws = fake();
      sockets.push(ws);
      done(ws);
    };
  };
  const connect = (session, q = '') => {
    for (const g of rooms.games()) hook(g);
    who = session;
    const raw = { refused: false, write: () => {}, destroy() { this.refused = true; } };
    const n = sockets.length;
    rooms.upgrade({ url: `/ws?v=2${q}`, headers: { origin: 'http://brieltje.test', host: 'brieltje.test' }, socket: { remoteAddress: '198.51.100.20' } }, raw, null);
    assert.ok(!raw.refused && sockets.length > n, `${session.username} got in`);
    return sockets.at(-1);
  };
  /** One round of WebSocket pings; each page answers after its delay (ms), or not at all (null). */
  const round = (delays) => {
    mono += 2000;
    clock += 2000;
    const at = mono;
    links.ping();
    for (const [ws, ms] of delays) {
      if (ms === null) continue;
      mono = at + ms;
      ws.emit('pong', ws.pings.at(-1));
    }
    mono = at;
  };
  const as = (name, role = 'guest') => ({ username: name, role, key: `k-${name}` });
  const stop = () => {
    for (const g of [main, ...made]) g.close();
    for (const ws of sockets) ws.close();
    Date.now = real;
    links.now = linkNow;
    links.auto = linkAuto;
  };
  return { main, rooms, connect, round, as, stop };
}

const everyone = (v) => [...v.players, ...v.away];

test('the view that asks for it has each player\'s connection, in the house and in a room; the plain view has none', () => {
  const env = setup();
  try {
    const { main, rooms, connect, round, as } = env;
    const pages = { admin: connect(as('admin', 'admin')), ann: connect(as('ann')), bob: connect(as('bob')), dan: connect(as('dan')) };
    const { room } = rooms.create(as('cas', 'player'), 'church');
    pages.cas = connect(as('cas', 'player'), `&room=${room.id}`);
    connect(as('admin', 'admin'), '&watch=1'); // the hall screen
    for (let i = 0; i < 5; i++) round([[pages.admin, 3], [pages.ann, 8], [pages.bob, 300], [pages.cas, 12], [pages.dan, null]]);

    const plain = main.host.view();
    assert.ok(!('load' in plain), 'the plain view: nothing of the server\'s delay');
    for (const p of everyone(plain)) assert.ok(!('link' in p), `${p.name}: nothing of the connection in the plain view`);
    assert.ok(!/jitter|reconnects/.test(JSON.stringify(plain)), 'nor anywhere in it');

    const v = main.host.view({ links: true });
    assert.equal(typeof v.load?.busy, 'boolean', 'the server\'s own state for the line above the list');
    const of = Object.fromEntries(everyone(v).map((p) => [p.name, p.link]));
    assert.deepEqual(Object.keys(of).sort(), ['admin', 'ann', 'bob', 'cas', 'dan'], 'everyone, the room\'s player too');
    assert.equal(of.ann.grade, 0);
    assert.equal(of.ann.rtt, 8);
    assert.equal(of.ann.mean, 8);
    assert.equal(of.ann.missed, 0);
    assert.equal(typeof of.ann.since, 'number', 'connected since');
    assert.equal(of.bob.grade, 3, 'a 300 ms round trip: bad');
    assert.equal(v.away.find((p) => p.name === 'cas').link.grade, 0, 'in a room: measured as in the house');
    assert.equal(of.dan.grade, 3, 'never answers: bad');
    assert.equal(of.dan.rtt, null);
    assert.equal(of.dan.missed, 4, 'four pings missed in the last minute');
    for (const p of everyone(v)) assert.ok(!('ip' in p), `${p.name}: no address without its own switch`);

    // A minute later the old misses are gone from "the last minute"; it answers now, and is good again.
    for (let i = 0; i < 31; i++) round([[pages.dan, 10]]);
    const later = main.host.view({ links: true }).players.find((p) => p.name === 'dan').link;
    assert.equal(later.missed, 0);
    assert.equal(later.grade, 0);
  } finally {
    env.stop();
  }
});

test('a slow device shows as the device, by the game\'s own ping', () => {
  const env = setup();
  try {
    const { main, connect, round, as } = env;
    const eve = connect(as('eve'));
    for (let i = 0; i < 3; i++) round([[eve, 10]]);
    main.players.get('eve').rttAvg = 190; // the page answered the game's pings late: its frames are long
    const l = main.host.view({ links: true }).players.find((p) => p.name === 'eve').link;
    assert.equal(l.grade, 0, 'the connection is good');
    assert.equal(l.slow, 'device');
    assert.equal(l.ping, 190);
  } finally {
    env.stop();
  }
});
