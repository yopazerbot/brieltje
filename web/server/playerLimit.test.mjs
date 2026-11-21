import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';

// How many may play is the admin's number, with no ceiling in the code (Yoshi, 21 Nov 2026: "Don't put any hard cap on
// the amount of participants. It should be defined in admin dashboard"): 32 on a fresh server; the admin sets it from
// the host page (POST /api/host, op 'limit') or the in-game menu (the 'rules' message, the admin's alone); a join past
// it is refused with 'full'; a player's own message changes nothing; nothing is reserved for a large number; a list a
// page sends (a grenade's cover) is never longer than the players who are in.

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const meta = new Map();
  const store = { addStats: async () => {}, setMeta: async (k, v) => void meta.set(k, v), getMeta: async (k) => meta.get(k) ?? null };
  const sessions = new Map(); // cookie -> session, for upgrade
  const auth = { session: (req) => sessions.get(req.headers.cookie) ?? null, store, log: () => {}, addressOf: () => '127.0.0.1' };
  const game = new Game(auth, [], null);
  for (const t of game.timers) clearInterval(t);
  game.auth = { ...game.auth, ...auth };
  game.stampState = () => {};
  const closed = new Map(); // name -> close code of its last socket
  const told = new Map(); // name -> messages to its last socket
  const socket = (name) => {
    const got = [];
    told.set(name, got);
    return { name, readyState: 1, OPEN: 1, send: (d) => got.push(JSON.parse(d)), on() {}, close: (code) => closed.set(name, code), terminate() {} };
  };
  // An upgrade as server.mjs hands it over: same-site, with the page's session; the socket made at once.
  game.wss.handleUpgrade = (req, sock, head, done) => done(socket(req.headers.cookie));
  const knock = (name, role = 'guest') => {
    sessions.set(name, { username: name, role, key: `k-${name}` });
    const sock = { write() {}, destroy() {} };
    game.upgrade({ url: '/ws?v=2', headers: { origin: 'http://local.test', host: 'local.test', cookie: name }, socket: {} }, sock, Buffer.alloc(0));
    return { inside: game.players.has(name), full: (told.get(name) ?? []).find((m) => m.t === 'full'), code: closed.get(name) };
  };
  return { game, knock, meta, now: () => clock, tick: (ms) => (clock += ms) };
}

test('32 on a fresh server; the host sets 60: the 33rd to the 60th come in, the 61st is told the house is full', async () => {
  const s = setup();
  assert.equal(s.game.rules.maxPlayers, 32, 'the default stays 32');
  for (let i = 0; i < 32; i++) assert.ok(s.knock(`p${i}`).inside);
  const over = s.knock('p32');
  assert.equal(over.inside, false);
  assert.equal(over.full?.max, 32, 'told the limit');
  assert.equal(over.code, 4003);
  assert.deepEqual(s.game.host.act('admin', { op: 'limit', max: 60 }), { ok: true });
  await new Promise((r) => setImmediate(r)); // setRules stores, then sets
  assert.equal(s.game.rules.maxPlayers, 60);
  for (let i = 32; i < 60; i++) assert.ok(s.knock(`p${i}`).inside, `p${i} comes in`);
  assert.equal(s.game.players.size, 60);
  const sixtyFirst = s.knock('p60');
  assert.equal(sixtyFirst.inside, false, 'the 61st waits');
  assert.equal(sixtyFirst.full?.max, 60);
  assert.equal(JSON.parse(s.meta.get('rules')).maxPlayers, 60, 'kept over a restart, with the other house rules');
  // The admin still gets in past it (to raise it or kick someone from inside the game).
  assert.ok(s.knock('boss', 'admin').inside);
  // Lowered under who is in: nobody is put out, newcomers wait.
  assert.deepEqual(s.game.host.act('admin', { op: 'limit', max: 40 }), { ok: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(s.game.players.size, 61);
  assert.equal(s.knock('late').inside, false);
});

test('a restart keeps the number the admin set', async () => {
  const s = setup();
  s.meta.set('rules', JSON.stringify({ ...s.game.rules, maxPlayers: 75 }));
  s.meta.set('rules_limit16', '1');
  await s.game.loadRules();
  assert.equal(s.game.rules.maxPlayers, 75);
});

test("only the admin's 'rules' changes the number: a player's own is ignored", async () => {
  const s = setup();
  s.knock('ann');
  s.knock('boss', 'admin');
  s.game.handle('ann', s.game.players.get('ann'), JSON.stringify({ t: 'rules', maxPlayers: 1000 }));
  await new Promise((r) => setImmediate(r));
  assert.equal(s.game.rules.maxPlayers, 32, "a player's rules message changes nothing");
  s.game.handle('boss', s.game.players.get('boss'), JSON.stringify({ t: 'rules', maxPlayers: 100 }));
  await new Promise((r) => setImmediate(r));
  assert.equal(s.game.rules.maxPlayers, 100, "the admin's does");
});

test('2 is the least; a non-number, a negative, a fraction, a huge number and a string are handled', async () => {
  const s = setup();
  for (const bad of [1, 0, -5, 2.5, '60', null, true, Number.NaN, Infinity, 1e300, [60], { n: 60 }]) {
    assert.equal(s.game.host.act('admin', { op: 'limit', max: bad }).code, 'badValue', `refused: ${String(bad)}`);
    await s.game.setRules({ maxPlayers: bad }, 'admin');
    assert.equal(s.game.rules.maxPlayers, 32, `unchanged by ${String(bad)}`);
    s.tick(200); // the host's ten a second
  }
  assert.deepEqual(s.game.host.act('admin', { op: 'limit', max: 2 }), { ok: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(s.game.rules.maxPlayers, 2, '2 is taken');
  // A billion: taken as it is, and nothing is reserved for it (the server's memory before and after one join).
  s.tick(200);
  const heap = process.memoryUsage().heapUsed;
  assert.deepEqual(s.game.host.act('admin', { op: 'limit', max: 1e9 }), { ok: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(s.game.rules.maxPlayers, 1e9);
  assert.ok(s.knock('ann').inside);
  assert.ok(process.memoryUsage().heapUsed - heap < 32 * 1024 * 1024, 'no memory reserved for a billion places');
  assert.equal(s.game.host.view().max, 1e9);
});

test("a grenade's cover is never longer than the players who are in", () => {
  const s = setup();
  for (const n of ['ann', 'bob', 'cid']) s.knock(n);
  let seen = null;
  s.game.blast = (name, at, w, cover) => (seen = cover);
  const ann = s.game.players.get('ann');
  ann.thrown = [{ at: s.now() - 3500, x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: 0, lob: false }];
  const cover = ['bob', 'cid', ...Array.from({ length: 500 }, (_, i) => `x${i}`)];
  s.game.boom('ann', ann, { x: 0, y: 1, z: 0, cover }, s.now());
  assert.ok(seen, 'the grenade went off');
  assert.equal(seen.size, 3, 'three players in: three names at most');
  assert.ok(seen.has('bob') && seen.has('cid'));
});
