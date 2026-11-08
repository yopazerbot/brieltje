// The boards (the leaderboard and the best Zombies runs): accounts, and the admin under each of its reserved names
// (server/auth.mjs RESERVED, which only the admin password logs in under; Yoshi: "show yoshi (admin) scores").
// Run: node --test server/board-names.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './store.mjs';
import { Auth, RESERVED } from './auth.mjs';
import { Game } from './game.mjs';

async function fileStore() {
  const dir = await mkdtemp(join(tmpdir(), 'briel-board-'));
  const store = new FileStore(join(dir, 'store.json'));
  await store.init();
  store.boardNames = [...RESERVED]; // as server.mjs sets it
  return { store, done: () => rm(dir, { recursive: true, force: true }) };
}

test('the reserved names are the admin\'s: "yoshi" among them, and no guest takes one', async () => {
  assert.ok(RESERVED.has('yoshi'));
  assert.ok(RESERVED.has((process.env.ADMIN_USERNAME || 'admin').toLowerCase()));
  const auth = new Auth({ getAccount: async () => null, log: async () => {}, pruneLog: async () => {} }, false);
  auth.log = () => {};
  auth.deviceKey = 'test-key'; // loadSessions' job: signs the guest cookie
  const req ={ headers: {}, socket: { remoteAddress: '192.0.2.40' } };
  for (const name of RESERVED) assert.equal((await auth.join(req, name, () => false)).code, 'nameTaken', name);
});

test('runs and totals under every reserved name stay on the boards; a name without an account does not', async () => {
  const { store, done } = await fileStore();
  try {
    await store.createAccount({ username: 'anna', email: 'anna@example.org', pass: 'x' });
    for (const name of ['yoshi', 'admin', 'anna']) assert.equal(await store.saveZombieRun(name, 'church', 5, 10, 1), true, name);
    assert.equal(await store.saveZombieRun('bob', 'church', 9, 10, 1), false, 'no account, not reserved: not kept');
    // A row left without its account (as after a deletion during a run): goes at start; the reserved names' stay.
    store.data.zombieBest.push({ username: 'gone', place: 'church', wave: 8, kills: 1, team: 1, at: new Date().toISOString() });
    await store.zombieBestForAccountsOnly();
    assert.deepEqual((await store.zombieBoard('church', 20)).map((r) => r.username).sort(), ['admin', 'anna', 'yoshi']);
    assert.deepEqual((await store.zombieBoard(null, 20)).map((r) => r.username).sort(), ['admin', 'anna', 'yoshi']);
    for (const name of ['yoshi', 'anna', 'bob']) await store.addStats(name, { kills: 2 });
    await store.statsForAccountsOnly();
    assert.deepEqual((await store.leaderboard()).map((r) => r.username).sort(), ['anna', 'yoshi']);
    assert.equal(store.data.stats['u:bob'], undefined, "bob's totals went");
  } finally {
    await done();
  }
});

test('the game adds to the boards for the admin and accounts only, never a guest', () => {
  const added = [];
  const runs = [];
  const auth = {
    sessions: new Map(), log() {}, addressOf: () => '192.0.2.1',
    store: { addStats: async (name) => void added.push(name), saveZombieRun: async (name) => (runs.push(name), false), setMeta: async () => {} },
  };
  const g = new Game(auth);
  try {
    g.roles.set('yoshi', 'admin');
    g.roles.set('anna', 'player');
    g.roles.set('gast', 'guest');
    for (const name of ['yoshi', 'anna', 'gast', 'nobody']) g.stats(name, { kills: 1 });
    g.zombieRun('church', ['yoshi', 'anna', 'gast'], 3, {});
    assert.deepEqual(added, ['yoshi', 'anna']);
    assert.deepEqual(runs, ['yoshi', 'anna']);
  } finally {
    g.close();
  }
});
