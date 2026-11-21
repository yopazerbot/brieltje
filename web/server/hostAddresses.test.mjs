// The players' network addresses on the host page (Yoshi, 21 Nov 2026: "...the local IP address of the LAN party
// participants so I can correlate with network logs"): kept with each connection from its WebSocket upgrade by
// server/auth.mjs clientIp (server/game.mjs join), listed only in the host's view that asks for them (server/host.mjs
// connectionOf, GET /api/host?addresses=1), in the house and in the rooms. Never in what a player's page or the hall
// screen's watch view is sent, never in the plain host view (which the watch page reads too). A forged X-Forwarded-For,
// X-Real-IP or CF-Connecting-IP on a direct connection (no trusted proxy: this test runs without TRUST_PROXY) changes
// nothing: the address is the socket's. A page that comes back from another address shows the new one.
// The refusal of a non-admin's GET /api/host is server.mjs's (its admin check before every /api/host route):
// tools/dev/host_addresses_check.mjs checks it against a running server.
// Run: node --test server/hostAddresses.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from './game.mjs';
import { Rooms } from './rooms.mjs';

const real = Date.now;
const SITE = { origin: 'http://brieltje.test', host: 'brieltje.test' };
// What a page could write itself to make the host see another address (header forgery).
const FORGED = { 'x-forwarded-for': '203.0.113.66, 203.0.113.67', 'x-real-ip': '203.0.113.68', 'cf-connecting-ip': '203.0.113.69' };
const ADDR = { ann: '198.51.100.11', bob: '198.51.100.12', cas: '198.51.100.13', admin: '198.51.100.10' };

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  let who = null; // the session the next upgrade carries
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
  /** A page's socket: everything it is sent, as text (a binary tick as latin1, so an address in it would show). */
  const fake = () => {
    const on = {};
    const ws = {
      got: [], readyState: 1, OPEN: 1,
      send: (d) => ws.got.push(typeof d === 'string' ? d : Buffer.from(d).toString('latin1')),
      on: (e, f) => (on[e] = f), close: () => { if (ws.readyState !== 3) (ws.readyState = 3), on.close?.(); },
    };
    return ws;
  };
  const hook = (g) => {
    g.wss.handleUpgrade = (_req, _socket, _head, done) => {
      const ws = fake();
      sockets.push(ws);
      done(ws);
    };
  };
  /** A page of `session` connects from `ip` through the rooms, as server.mjs hands every upgrade over, with forged headers. */
  const connect = (session, ip, q = '') => {
    for (const g of rooms.games()) hook(g);
    who = session;
    const raw = { refused: false, write: () => {}, destroy() { this.refused = true; } };
    const n = sockets.length;
    rooms.upgrade({ url: `/ws?v=2${q}`, headers: { ...SITE, ...FORGED }, socket: { remoteAddress: ip } }, raw, null);
    assert.ok(!raw.refused && sockets.length > n, `${session.username} got in`);
    return sockets.at(-1);
  };
  const as = (name, role = 'player') => ({ username: name, role, key: `k-${name}` });
  const stop = () => {
    Date.now = real;
    for (const g of [main, ...made]) g.close();
  };
  return { main, rooms, connect, as, stop, sockets, tick: (ms) => (clock += ms) };
}

const everyone = (v) => [...v.players, ...v.away];
const leaks = (texts) => texts.filter((s) => Object.values(ADDR).some((a) => s.includes(a)) || /203\.0\.113\./.test(s));

test('the host view that asks for them lists each connection\'s own address, in the house and in a room; nothing else does', () => {
  const env = setup();
  try {
    const { main, rooms, connect, as } = env;
    const pages = { admin: connect(as('admin', 'admin'), ADDR.admin), ann: connect(as('ann'), ADDR.ann), bob: connect(as('bob', 'guest'), ADDR.bob) };
    const { room } = rooms.create(as('cas'), 'church');
    pages.cas = connect(as('cas'), ADDR.cas, `&room=${room.id}`);
    const watch = connect(as('admin', 'admin'), ADDR.admin, '&watch=1');
    assert.equal(main.watchers.size, 1, 'the hall screen watches');
    for (let i = 0; i < 6; i++) {
      env.tick(60);
      for (const g of rooms.games()) g.tick();
    }
    // The host page's own call: everyone's address, the socket's and never a forged header's, with since when.
    const v = main.host.view({ addresses: true });
    const seen = Object.fromEntries(everyone(v).map((p) => [p.name, p.ip]));
    assert.deepEqual(seen, { admin: ADDR.admin, ann: ADDR.ann, bob: ADDR.bob, cas: ADDR.cas });
    assert.equal(v.away.find((p) => p.name === 'cas').where, 'room', 'the room\'s player is listed as in a room');
    for (const p of everyone(v)) assert.equal(typeof p.since, 'number', `${p.name}: connected since`);
    // The plain view (the hall screen's watch page reads it, and the admin panel): no address, no join time.
    const plain = main.host.view();
    for (const p of everyone(plain)) assert.ok(!('ip' in p) && !('since' in p), `${p.name}: nothing of the connection`);
    assert.deepEqual(leaks([JSON.stringify(plain)]), []);
    // What the pages were sent: the players', the admin's own game page and the watch view's, every message.
    for (const [name, ws] of Object.entries({ ...pages, watch })) {
      assert.ok(ws.got.length > 3, `${name} was sent the game`);
      assert.deepEqual(leaks(ws.got), [], `${name}'s page is sent no address`);
    }
    // The admin panel's list of who is online (GET /api/players) carries none either.
    assert.deepEqual(leaks([JSON.stringify(rooms.roster())]), []);
  } finally {
    env.stop();
  }
});

test('a page that comes back from another address shows the new one', () => {
  const env = setup();
  try {
    const { main, connect, as } = env;
    connect(as('ann'), ADDR.ann);
    env.tick(5_000);
    connect(as('ann'), '198.51.100.99'); // the same session on another network (a phone off the Wi-Fi and on again)
    const [ann] = main.host.view({ addresses: true }).players;
    assert.equal(ann.ip, '198.51.100.99');
    assert.equal(ann.since, Date.now(), 'connected since the new connection');
  } finally {
    env.stop();
  }
});

test('a forged X-Forwarded-For on a direct connection changes nothing; nor does any other header', () => {
  const env = setup();
  try {
    const { main, connect, as } = env;
    connect(as('ann'), '::ffff:198.51.100.11'); // a dual-stack socket's IPv4, as Node gives it
    const [ann] = main.host.view({ addresses: true }).players;
    assert.equal(ann.ip, '::ffff:198.51.100.11', 'the socket\'s address, exactly as clientIp reads it');
    assert.ok(!JSON.stringify(main.host.view({ addresses: true })).includes('203.0.113.'), 'no forged address anywhere in the view');
  } finally {
    env.stop();
  }
});
