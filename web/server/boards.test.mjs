// The boards of the timed routes, the gnomes and the party games: the store's rows (a FileStore on a temp file, as
// server/board-names.test.mjs) and the HTTP side (server/boards.mjs). Run: node --test server/boards.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './store.mjs';
import { NAME_RE, RESERVED } from './auth.mjs';
import { Boards } from './boards.mjs';

async function fileStore() {
  const dir = await mkdtemp(join(tmpdir(), 'briel-boards-'));
  const store = new FileStore(join(dir, 'store.json'));
  await store.init();
  store.boardNames = [...RESERVED]; // as server.mjs sets it
  return { store, done: () => rm(dir, { recursive: true, force: true }) };
}
const account = (store, username) => store.createAccount({ username, email: `${username}@example.org`, pass: 'x' });

test('a better time replaces, a worse one does not; a tie: the earlier first; a name without an account is not kept', async () => {
  const { store, done } = await fileStore();
  try {
    await account(store, 'anna');
    await account(store, 'bram');
    assert.equal(await store.saveRaceTime('anna', 'foot@1', 40_000), true);
    assert.equal(await store.saveRaceTime('anna', 'foot@1', 41_000), false, 'worse');
    assert.equal(await store.saveRaceTime('anna', 'foot@1', 40_000), false, 'the same');
    assert.equal(await store.saveRaceTime('anna', 'foot@1', 39_000), true, 'better');
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await store.saveRaceTime('bram', 'foot@1', 39_000), true);
    assert.equal(await store.saveRaceTime('bob', 'foot@1', 30_000), false, 'no account');
    assert.equal(await store.saveRaceTime('yoshi', 'foot@1', 45_000), true, "the admin's reserved name");
    assert.deepEqual((await store.raceBoard('foot@1', 10)).map((r) => [r.username, r.ms]), [['anna', 39_000], ['bram', 39_000], ['yoshi', 45_000]]);
    assert.equal(await store.racePlace('foot@1', 39_000), 1);
    assert.equal(await store.racePlace('foot@1', 45_000), 3);
    assert.deepEqual(await store.racesOf('anna'), [{ route: 'foot@1', ms: 39_000 }]);
    // Gnomes: once each, accounts only; the board by count, then who got there first.
    assert.equal(await store.saveGnome('anna', 'g01'), true);
    assert.equal(await store.saveGnome('anna', 'g01'), false);
    assert.equal(await store.saveGnome('bob', 'g01'), false);
    await store.saveGnome('bram', 'g02');
    await store.saveGnome('anna', 'g02');
    assert.deepEqual((await store.gnomeBoard(10)).map((r) => [r.username, r.n]), [['anna', 2], ['bram', 1]]);
    // Party games won.
    for (const k of ['tag', 'tag', 'hide']) await store.addGameWin('anna', k);
    assert.equal(await store.addGameWin('anna', 'zombies'), false, 'not a party game of the board');
    assert.equal(await store.addGameWin('bob', 'tag'), false);
    assert.deepEqual(await store.gameBoard(10), [{ username: 'anna', wins: 3, hide: 1, tag: 2, treasure: 0, teams: 0 }]);
    assert.deepEqual(await store.gamesOf('anna'), { wins: 3, hide: 1, tag: 2, treasure: 0, teams: 0 });
  } finally {
    await done();
  }
});

test('deleting and pruning an account removes its rows; a new account under an old name starts empty', async () => {
  const { store, done } = await fileStore();
  try {
    for (const n of ['anna', 'bram']) {
      await account(store, n);
      await store.saveRaceTime(n, 'foot@1', 40_000);
      await store.saveGnome(n, 'g01');
      await store.addGameWin(n, 'tag');
    }
    await store.deleteAccount('anna');
    assert.deepEqual((await store.raceBoard('foot@1', 10)).map((r) => r.username), ['bram']);
    assert.equal(store.data.raceBest.some((r) => r.username === 'anna') || store.data.gnomeFound.some((r) => r.username === 'anna') || store.data.gameWins.some((r) => r.username === 'anna'), false);
    // Rows left under a name (as after a deletion during a write): a new account there starts at nothing.
    store.data.raceBest.push({ username: 'anna', route: 'foot@1', ms: 1, at: new Date().toISOString() });
    store.data.gnomeFound.push({ username: 'anna', gnome: 'g05', at: new Date().toISOString() });
    await account(store, 'anna');
    assert.deepEqual(await store.racesOf('anna'), []);
    assert.deepEqual(await store.gnomesOf('anna'), []);
    // Pruned for not logging in: the rows go too.
    store.data.accounts.find((r) => r.username === 'bram').seen = '2000-01-01T00:00:00.000Z';
    assert.deepEqual(await store.pruneAccounts(730), ['bram']);
    assert.deepEqual(await store.raceBoard('foot@1', 10), []);
    assert.deepEqual(await store.gnomeBoard(10), []);
    assert.deepEqual(await store.gameBoard(10), []);
  } finally {
    await done();
  }
});

test('at start: only rows whose account is gone go; never by route, gnome or kind (a route that did not load, a layout rolled back)', async () => {
  const { store, done } = await fileStore();
  try {
    await account(store, 'anna');
    await store.saveRaceTime('anna', 'foot@1', 40_000);
    await store.saveRaceTime('yoshi', 'foot@1', 41_000);
    const at = new Date().toISOString();
    store.data.raceBest.push(
      { username: 'anna', route: 'bike@1', ms: 90_000, at }, // a route whose data failed its checks this start
      { username: 'anna', route: 'foot@2', ms: 30_000, at }, // a layout bumped, then rolled back to foot@1: both kept
      { username: 'gone', route: 'foot@1', ms: 20_000, at },
    );
    store.data.gnomeFound.push({ username: 'anna', gnome: 'g01', at }, { username: 'anna', gnome: 'old', at }, { username: 'gone', gnome: 'g01', at });
    store.data.gameWins.push({ username: 'anna', kind: 'tag', wins: 2 }, { username: 'anna', kind: 'old', wins: 2 }, { username: 'gone', kind: 'tag', wins: 9 });
    await store.boardsForAccountsOnly();
    assert.deepEqual(store.data.raceBest.map((r) => `${r.username} ${r.route}`).sort(), ['anna bike@1', 'anna foot@1', 'anna foot@2', 'yoshi foot@1']);
    assert.deepEqual(store.data.gnomeFound.map((r) => `${r.username} ${r.gnome}`), ['anna g01', 'anna old']);
    assert.deepEqual(store.data.gameWins.map((r) => `${r.username} ${r.kind}`), ['anna tag', 'anna old']);
    // Rows of a key nobody reads are simply not shown: the board asks by key, the party games by known kind.
    assert.deepEqual((await store.raceBoard('foot@1', 10)).map((r) => r.username).sort(), ['anna', 'yoshi']);
    assert.deepEqual(await store.gamesOf('anna'), { wins: 2, hide: 0, tag: 2, treasure: 0, teams: 0 });
    // With no account at all, the reserved names' rows stay and nothing else is touched.
    await store.deleteAccount('anna');
    await store.boardsForAccountsOnly();
    assert.deepEqual(store.data.raceBest.map((r) => r.username), ['yoshi']);
  } finally {
    await done();
  }
});

/** A response that keeps what was sent. */
const res = () => ({ status: 0, body: null });
const json = (r, status, data) => Object.assign(r, { status, body: JSON.parse(JSON.stringify(data)) });
/** server.mjs body(): the same-origin JSON check. */
const readJson = async (req) => {
  if (req.headers.origin !== `http://${req.headers.host}`) throw Object.assign(new Error('Bad origin'), { status: 403 });
  if (req.headers['content-type'] !== 'application/json') throw Object.assign(new Error('JSON only'), { status: 415 });
  return req.body;
};
const req = (method, path, body, headers = {}) => ({ method, url: path, body, headers: { host: 'game.test', origin: 'http://game.test', 'content-type': 'application/json', ...headers } });
const ROUTES = [{ id: 'foot', key: 'foot@1' }, { id: 'bike', key: 'bike@1' }, { id: 'car', key: 'car@1' }];

async function boards() {
  const { store, done } = await fileStore();
  const logged = [];
  const forgot = [];
  const b = new Boards(store, {
    routes: ROUTES, gnomeTotal: 30, json, readJson, known: async (n) => RESERVED.has(n) || !!(await store.getAccount(n)), log: (event, _req, extra) => logged.push({ event, ...extra }),
    reserved: [...RESERVED], forget: (...a) => forgot.push(a),
  });
  const call = async (method, path, { body, headers, panel = null, session = null } = {}) => {
    const r = res();
    const handled = await b.handle(req(method, path, body, headers), r, new URL(path, 'http://game.test'), panel, session);
    return handled ? r : null;
  };
  return { store, b, logged, forgot, call, done };
}

test('GET /api/boards: ten rows at most, only names that pass NAME_RE, kept a while and built again after a change', async () => {
  const { store, b, call, done } = await boards();
  try {
    for (let i = 0; i < 14; i++) {
      await account(store, `p${i}`);
      await store.saveRaceTime(`p${i}`, 'foot@1', 30_000 + i);
      await store.saveGnome(`p${i}`, 'g01');
      await store.addGameWin(`p${i}`, 'teams');
    }
    // A row whose name no account could have (written straight into the file): never shown.
    store.data.accounts.push({ username: '<img src=x>', email: 'x', pass: 'x', created: '', seen: '', disabled: false });
    store.data.raceBest.push({ username: '<img src=x>', route: 'foot@1', ms: 1, at: new Date().toISOString() });
    const r = await call('GET', '/api/boards');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['games', 'gnomeTotal', 'gnomes', 'races']);
    assert.deepEqual(Object.keys(r.body.races), ['foot', 'bike', 'car']);
    assert.equal(r.body.races.foot.length, 10);
    assert.equal(r.body.races.foot[0].username, 'p0');
    assert.match(r.body.races.foot[0].at, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(r.body.races.foot.every((x) => NAME_RE.test(x.username)));
    assert.equal(r.body.gnomes.length, 10);
    assert.equal(r.body.games.length, 10);
    assert.deepEqual(Object.keys(r.body.games[0]).sort(), ['hide', 'tag', 'teams', 'treasure', 'username', 'wins']);
    assert.equal(r.body.gnomeTotal, 30);
    // Kept: a new time doesn't show until the cache goes (rooms.onScore clears it).
    await account(store, 'fast');
    await store.saveRaceTime('fast', 'foot@1', 25_000);
    assert.equal((await call('GET', '/api/boards')).body.races.foot[0].username, 'p0');
    b.clear();
    assert.equal((await call('GET', '/api/boards')).body.races.foot[0].username, 'fast');
    // Other methods and paths are not this module's.
    // Another method on the public paths: 405, never the 401 of a missing session.
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      assert.equal((await call(method, '/api/boards')).status, 405, method);
      assert.equal((await call(method, '/api/boards/mine')).status, 405, `${method} mine`);
    }
    assert.equal(await call('GET', '/api/boards/other'), null);
  } finally {
    await done();
  }
});

test('GET /api/boards/mine: 401 without a session, {} for a guest, the session\'s own lines only', async () => {
  const { store, call, done } = await boards();
  try {
    await account(store, 'anna');
    await account(store, 'bram');
    await store.saveRaceTime('bram', 'bike@1', 50_000);
    await store.saveRaceTime('anna', 'bike@1', 60_000);
    await store.saveGnome('anna', 'g01');
    await store.addGameWin('anna', 'hide');
    assert.equal((await call('GET', '/api/boards/mine')).status, 401);
    const g = await call('GET', '/api/boards/mine', { session: { username: 'gast', role: 'guest' } });
    assert.deepEqual([g.status, g.body], [200, {}]);
    const a = await call('GET', '/api/boards/mine?name=bram', { session: { username: 'anna', role: 'player' } });
    assert.deepEqual(a.body, { races: { bike: { ms: 60_000, place: 2 } }, gnomes: 1, games: { wins: 1, hide: 1, tag: 0, treasure: 0, teams: 0 } });
  } finally {
    await done();
  }
});

test('POST /api/admin/boards: the panel\'s admin only, same-origin JSON, checked, at most ten a minute, logged', async () => {
  const { store, logged, forgot, call, done } = await boards();
  const panel = { username: 'admin', role: 'admin' };
  const remove = (body, extra = {}) => call('POST', '/api/admin/boards', { body, panel, ...extra });
  try {
    await account(store, 'anna');
    await store.saveRaceTime('anna', 'foot@1', 40_000);
    await store.saveRaceTime('anna', 'bike@1', 60_000);
    await store.saveGnome('anna', 'g01');
    // Without the panel's session (a game session, even the admin's, is not it): refused.
    assert.equal((await call('POST', '/api/admin/boards', { body: { op: 'remove', name: 'anna', board: 'gnomes' }, session: { username: 'admin', role: 'admin' } })).status, 403);
    assert.equal((await call('PUT', '/api/admin/boards', { panel })).status, 405);
    // GET: the reserved names, for the panel's own row (behind the panel's session too).
    assert.deepEqual((await call('GET', '/api/admin/boards', { panel })).body, { reserved: [...RESERVED] });
    assert.equal((await call('GET', '/api/admin/boards')).status, 403);
    // From another site, or as a form: the same-origin check throws (server.mjs answers its status).
    await assert.rejects(remove({ op: 'remove', name: 'anna', board: 'gnomes' }, { headers: { origin: 'https://evil.example' } }), { status: 403 });
    await assert.rejects(remove({ op: 'remove', name: 'anna', board: 'gnomes' }, { headers: { 'content-type': 'application/x-www-form-urlencoded' } }), { status: 415 });
    assert.equal((await store.gnomesOf('anna')).length, 1, 'nothing removed by them');
    // Checked: the op, the name, the board, the route.
    assert.equal((await remove({ op: 'drop', name: 'anna', board: 'gnomes' })).body.code, 'badOp');
    assert.equal((await remove({ op: 'remove', name: '../x', board: 'gnomes' })).body.code, 'noAccount');
    assert.equal((await remove({ op: 'remove', name: 'nobody', board: 'gnomes' })).body.code, 'noAccount');
    assert.equal((await remove({ op: 'remove', name: 'anna', board: 'stats' })).body.code, 'badValue');
    assert.equal((await remove({ op: 'remove', name: 'anna', board: 'race', route: 'foot@1' })).body.code, 'badValue');
    assert.equal((await remove({ op: 'remove', name: 'anna', board: 'gnomes', route: 'foot' })).body.code, 'badValue');
    assert.equal(logged.length, 0);
    // A refusal's body carries its error and code, never the HTTP status.
    assert.deepEqual(Object.keys((await remove({ op: 'drop', name: 'anna' })).body).sort(), ['code', 'error']);
    // One route's time, then the gnomes.
    const r = await remove({ op: 'remove', name: 'anna', board: 'race', route: 'foot' });
    assert.deepEqual([r.status, r.body], [200, { ok: true, removed: 1 }]);
    assert.deepEqual(await store.racesOf('anna'), [{ route: 'bike@1', ms: 60_000 }]);
    assert.equal((await remove({ op: 'remove', name: 'anna', board: 'gnomes' })).body.removed, 1);
    assert.deepEqual(logged, [
      { event: 'board_removed', username: 'admin', detail: 'anna: race foot' },
      { event: 'board_removed', username: 'admin', detail: 'anna: gnomes' },
    ]);
    // No board named: all three at once, one request, one log line. The reserved names too.
    await store.saveRaceTime('anna', 'foot@1', 41_000);
    await store.saveGnome('anna', 'g02');
    await store.addGameWin('anna', 'tag');
    forgot.length = 0;
    const all = await remove({ op: 'remove', name: 'anna' });
    assert.deepEqual(forgot, [['anna', null, null]], 'the live tracker told: all boards');
    assert.deepEqual([all.status, all.body], [200, { ok: true, removed: 4 }]);
    assert.deepEqual([await store.racesOf('anna'), await store.gnomesOf('anna'), (await store.gamesOf('anna')).wins], [[], [], 0]);
    assert.deepEqual(logged.at(-1), { event: 'board_removed', username: 'admin', detail: 'anna: all boards' });
    await store.saveGnome('yoshi', 'g03');
    assert.equal((await remove({ op: 'remove', name: 'yoshi' })).body.removed, 1);
    // At most ten a minute.
    for (let i = 0; i < 6; i++) await remove({ op: 'remove', name: 'anna', board: 'games' }); // ten so far
    assert.equal((await remove({ op: 'remove', name: 'anna', board: 'games' })).status, 429);
  } finally {
    await done();
  }
});
