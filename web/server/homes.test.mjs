import assert from 'node:assert/strict';
import test from 'node:test';
import { Homes, newCode, normalizeCode, showCode } from './homes.mjs';
import { HOMES } from '../shared/homes.mjs';

const H1 = 'house';
const H2 = 'bungalow';
const PACK = { id: 'house', prisms: [], doors: [], fixtures: [], props: [] };

/** A store with the homes' records and the accounts' lasting access (server/store.mjs FileStore's rules: rows only for accounts that exist). */
function fakeStore(meta = new Map(), accounts = new Set(), grants = []) {
  return {
    meta, accounts, grants,
    getMeta: async (k) => meta.get(k) ?? null,
    setMeta: async (k, v) => void meta.set(k, v),
    listHomeGrants: async () => grants.filter((r) => accounts.has(r.username)).map((r) => ({ ...r })),
    saveHomeGrant: async (username, home, gen) => {
      if (!accounts.has(username)) return false;
      const old = grants.find((r) => r.username === username && r.home === home);
      if (old) Object.assign(old, { gen, at: new Date().toISOString() });
      else grants.push({ username, home, gen, at: new Date().toISOString() });
      return true;
    },
    deleteHomeGrants: async (home, username = null) => {
      const before = grants.length;
      grants.splice(0, grants.length, ...grants.filter((r) => r.home !== home || (username !== null && r.username !== username)));
      return before - grants.length;
    },
    deleteAccount: async (name) => {
      accounts.delete(name);
      grants.splice(0, grants.length, ...grants.filter((r) => r.username !== name));
    },
  };
}

function setup({ store = fakeStore(), sessions = new Map() } = {}) {
  // sessions: key -> { username, role, expires } as server/auth.mjs holds them; who and keysOf read them as server.mjs does.
  // Any other key stands for a guest's live session (the older tests name sessions 'p1', 'p2').
  const live = (s) => (s && s.expires >= Date.now() ? s : null);
  const homes = new Homes(store, {
    who: (key) => (sessions.has(key) ? live(sessions.get(key)) : key ? { username: key, role: 'guest', expires: Infinity } : null),
    keysOf: (name) => [...sessions].filter(([, s]) => s.username === name && s.role === 'player' && s.expires >= Date.now()).map(([k]) => k),
    list: HOMES,
    json: (res, status, data, headers) => void Object.assign(res, { status, data, headers }),
    readJson: async (req) => {
      if (req.crossSite) throw Object.assign(new Error('Bad origin'), { status: 403 });
      return req.body;
    },
    clientKey: (req) => req.who ?? 'a',
    pack: (id) => (id === H1 ? PACK : null), // a made-up inside: the real ones are private
  });
  const call = async (method, path, body, { admin = false, who, user = '', crossSite = false } = {}) => {
    const res = {};
    const handled = await homes.handle({ method, body, who, crossSite }, res, new URL(path, 'http://x'), admin, user);
    return { handled, res };
  };
  return { homes, call, store, sessions };
}

test('codes: ten characters of the alphabet, typed in any case with dashes', () => {
  const c = newCode();
  assert.match(c, /^[A-HJ-NP-Z2-9]{10}$/);
  assert.equal(normalizeCode(` ${showCode(c).toLowerCase()} `), c);
  assert.equal(normalizeCode({}), '');
});

test('the admin makes a code; it opens the home, and a wrong one does not', async () => {
  const { call } = setup();
  assert.equal((await call('POST', `/api/admin/homes/${H1}/code`, {}, { admin: false })).res.status, 403);
  const made = await call('POST', `/api/admin/homes/${H1}/code`, {}, { admin: true });
  const code = made.res.data.code;
  assert.match(code, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  const bad = await call('POST', '/api/home/unlock', { id: H1, code: 'AAAAA-AAAAA' });
  assert.equal(bad.res.status, 403);
  assert.equal(bad.res.data.code, 'home_denied');
  const good = await call('POST', '/api/home/unlock', { id: H1, code: code.toLowerCase().replace('-', ' ') });
  assert.equal(good.res.status, 200);
  assert.deepEqual(good.res.data, { ok: true, inside: PACK }, 'the right code gets the inside of the home, and nothing else');
  assert.match(good.res.headers['Cache-Control'], /no-store.*private.*no-transform/);
  assert.equal(bad.res.data.inside, undefined, 'a wrong code gets no inside');
  const list = (await call('GET', '/api/admin/homes', undefined, { admin: true })).res.data;
  assert.deepEqual(list.rows.map((r) => r.id), ['house', 'bungalow', 'molenhoek_end']);
  const row = list.rows.find((r) => r.id === H1);
  assert.deepEqual([row.unlocks, row.fails, row.hasCode, row.enabled], [1, 1, true, true]);
  assert.ok(!JSON.stringify(list).includes(code.replace('-', '')), 'the code is not in the list');
});

test('a home that has no code, an unknown id, off, revoked, expired: all the same refusal', async () => {
  const { call } = setup();
  const code = (await call('POST', `/api/admin/homes/${H1}/code`, {}, { admin: true })).res.data.code;
  const refused = async (id, c, who) => (await call('POST', '/api/home/unlock', { id, code: c }, { who })).res;
  const a = await refused('nowhere', code, 'u1');
  assert.deepEqual([a.status, a.data], [403, { error: 'Wrong code', code: 'home_denied' }]);
  assert.deepEqual(await refused('../../etc/passwd', code, 'u2'), a);
  assert.deepEqual(await refused('bungalow', code, 'u3'), a, 'a home without a code of its own');
  await call('POST', `/api/admin/homes/${H1}`, { enabled: false }, { admin: true });
  assert.deepEqual(await refused(H1, code, 'u4'), a);
  await call('POST', `/api/admin/homes/${H1}`, { enabled: true, expiresAt: '2000-01-01' }, { admin: true });
  assert.deepEqual(await refused(H1, code, 'u5'), a);
  await call('POST', `/api/admin/homes/${H1}`, { expiresAt: null }, { admin: true });
  assert.equal((await refused(H1, code, 'u6')).status, 200);
  await call('DELETE', `/api/admin/homes/${H1}/code`, undefined, { admin: true });
  assert.deepEqual(await refused(H1, code, 'u7'), a);
  assert.equal((await call('POST', `/api/admin/homes/${H1}`, { expiresAt: 'tomorrow' }, { admin: true })).res.status, 400);
});

test('guessing is slowed per sender, and one sender cannot shut the owner out', async () => {
  const { call } = setup();
  const code = (await call('POST', `/api/admin/homes/${H1}/code`, {}, { admin: true })).res.data.code;
  const codes = [];
  for (let i = 0; i < 10; i++) codes.push((await call('POST', '/api/home/unlock', { id: H1, code: 'BBBBB-BBBBB' }, { who: 'thief' })).res.status);
  assert.deepEqual(codes, [403, 403, 403, 403, 403, 403, 403, 403, 429, 429]);
  const slow = (await call('POST', '/api/home/unlock', { id: H1, code }, { who: 'thief' })).res;
  assert.equal(slow.status, 429, 'even the right code from a sender who has been guessing');
  assert.equal(slow.data.code, 'home_slow');
  assert.equal((await call('POST', '/api/home/unlock', { id: H1, code }, { who: 'owner' })).res.status, 200);
});

test('the admin needs no code, nobody else gets in without one', async () => {
  const { call } = setup();
  const own = await call('POST', '/api/home/unlock', { id: H1 }, { admin: true });
  assert.deepEqual(own.res.data, { ok: true, inside: PACK });
  assert.equal((await call('POST', '/api/home/unlock', { id: H1 }, { admin: false, who: 'x' })).res.status, 403);
  assert.equal((await call('POST', '/api/home/unlock', { id: 'nowhere' }, { admin: true, who: 'y' })).res.status, 403, 'an unknown home stays unknown');
});

test('a typed code lets that session in on the game server, and nobody else', async () => {
  const { call, homes } = setup();
  const code = (await call('POST', `/api/admin/homes/${H1}/code`, {}, { admin: true })).res.data.code;
  assert.equal(homes.granted('p1', H1), false);
  await call('POST', '/api/home/unlock', { id: H1, code: 'AAAAA-AAAAA' }, { user: 'p1', who: 'w1' });
  assert.equal(homes.granted('p1', H1), false, 'a wrong code gives nothing');
  await call('POST', '/api/home/unlock', { id: H1, code }, { user: 'p1', who: 'w2' });
  assert.equal(homes.granted('p1', H1), true);
  assert.equal(homes.granted('p2', H1), false);
  assert.equal(homes.granted('p1', H2), false, 'the code of one home opens only that home');
  await call('POST', '/api/home/unlock', { id: H1, code }, { user: '', who: 'w3' });
  assert.equal(homes.granted('', H1), false, 'no session: no grant');
});

test('the admin changes need the same-origin check, even with no body', async () => {
  const { call } = setup();
  await assert.rejects(call('POST', `/api/admin/homes/${H1}/code`, undefined, { admin: true, crossSite: true }), /Bad origin/);
  await assert.rejects(call('DELETE', `/api/admin/homes/${H1}/code`, undefined, { admin: true, crossSite: true }), /Bad origin/);
  await assert.rejects(call('POST', `/api/admin/homes/${H1}`, { enabled: true }, { admin: true, crossSite: true }), /Bad origin/);
  const list = (await call('GET', '/api/admin/homes', undefined, { admin: true })).res.data;
  assert.equal(list.rows[0].hasCode, false, 'nothing changed');
});

test('a grant ends when the code is revoked or replaced, or the home is switched off', async () => {
  const { call, homes } = setup();
  const code = async () => (await call('POST', `/api/admin/homes/${H1}/code`, {}, { admin: true })).res.data.code;
  let n = 0;
  const open = async (c) => call('POST', '/api/home/unlock', { id: H1, code: c }, { user: 'p1', who: `w${n++}` });
  await open(await code());
  assert.equal(homes.granted('p1', H1), true);
  await call('DELETE', `/api/admin/homes/${H1}/code`, undefined, { admin: true });
  assert.equal(homes.granted('p1', H1), false, 'revoked');
  await open(await code());
  assert.equal(homes.granted('p1', H1), true);
  await code();
  assert.equal(homes.granted('p1', H1), false, 'a new code');
  await open(await code());
  await call('POST', `/api/admin/homes/${H1}`, { enabled: false }, { admin: true });
  assert.equal(homes.granted('p1', H1), false, 'switched off');
});

test('there is no limit across senders: a crowd cannot shut the owner out', async () => {
  const { call } = setup();
  const code = (await call('POST', `/api/admin/homes/${H1}/code`, {}, { admin: true })).res.data.code;
  for (let i = 0; i < 60; i++) await call('POST', '/api/home/unlock', { id: H1, code: 'BBBBB-BBBBB' }, { who: `crowd${i}` });
  assert.equal((await call('POST', '/api/home/unlock', { id: H1, code }, { who: 'owner' })).res.status, 200);
});

test("past a home's budget, a player with an account waits in a lane a flood without one can't fill", async () => {
  const { call, homes } = setup();
  homes.capWaitMs = 30;
  homes.account = (req) => req.who === 'player';
  const code = (await call('POST', `/api/admin/homes/${H1}/code`, {}, { admin: true })).res.data.code;
  const now = Date.now();
  for (let i = 0; i < 300; i++) homes.checks.add(H1, now);
  const flood = Array.from({ length: 12 }, (_, i) => call('POST', '/api/home/unlock', { id: H1, code: 'BBBBB-BBBBB' }, { who: `crowd${i}` }));
  const owner = call('POST', '/api/home/unlock', { id: H1, code }, { who: 'player', user: 'p9' });
  const statuses = (await Promise.all(flood)).map((a) => a.res.status);
  assert.ok(statuses.filter((s) => s === 503).length > 0, 'the crowd overflows its own lane');
  assert.equal((await owner).res.status, 200, 'the player with an account still gets in');
  await homes.flush();
});

test('the admin routes only know the three homes', async () => {
  const { call } = setup();
  for (const id of ['molenhoek_end', 'bungalow', 'house']) assert.equal((await call('POST', `/api/admin/homes/${id}/code`, {}, { admin: true })).res.status, 200, id);
  assert.equal((await call('POST', '/api/admin/homes/home-01/code', {}, { admin: true })).res.status, 404);
  assert.equal((await call('POST', '/api/admin/homes/x/code', {}, { admin: true })).res.status, 404);
});

test('GET /api/home/:id/inside: the inside only for a session with the grant and for the admin, never cached', async () => {
  const { call, homes } = setup();
  const code = (await call('POST', `/api/admin/homes/${H1}/code`, {}, { admin: true })).res.data.code;
  const inside = async (id, opts) => (await call('GET', `/api/home/${id}/inside`, undefined, opts)).res;
  const denied = { error: 'Wrong code', code: 'home_denied' };
  assert.deepEqual((await inside(H1, { user: 'p1' })).data, denied, 'no grant');
  assert.deepEqual((await inside(H1, {})).data, denied, 'no session');
  assert.deepEqual((await inside('nowhere', { admin: true })).data, denied, 'an unknown home stays unknown');
  await call('POST', '/api/home/unlock', { id: H1, code }, { user: 'p1', who: 'w' });
  const ok = await inside(H1, { user: 'p1' });
  assert.deepEqual([ok.status, ok.data], [200, PACK]);
  assert.match(ok.headers['Cache-Control'], /no-store.*private.*no-transform/);
  assert.equal((await inside(H1, { user: 'p2' })).status, 403, 'another session has no right');
  assert.equal((await inside(H2, { user: 'p1' })).status, 403, 'the grant is for that one home');
  assert.equal((await inside(H2, { admin: true })).status, 404, 'the admin is told when a home has no inside (private data missing)');
  assert.equal((await inside(H1, { admin: true })).status, 200);
  homes.forget(H1);
  assert.equal((await inside(H1, { user: 'p1' })).status, 403, 'a revoked code takes the right with it');
  const post = await call('POST', `/api/home/${H1}/inside`, {}, { user: 'p1' });
  assert.equal(post.handled, false, 'GET only');
});

test('a new grant tells the game server (onGrant), so the state of the inside follows', async () => {
  const { call, homes } = setup();
  const told = [];
  homes.onGrant = (key, id) => told.push([key, id]);
  const code = (await call('POST', `/api/admin/homes/${H1}/code`, {}, { admin: true })).res.data.code;
  await call('POST', '/api/home/unlock', { id: H1, code: 'AAAAA-AAAAA' }, { user: 'p1', who: 'w1' });
  assert.deepEqual(told, []);
  await call('POST', '/api/home/unlock', { id: H1, code }, { user: 'p1', who: 'w2' });
  assert.deepEqual(told, [['p1', H1]]);
});

test('a flood of tries from many senders: two checks at once, a few wait, the rest hear "busy" (503)', async () => {
  const { call, homes } = setup();
  await call('POST', `/api/admin/homes/${H1}/code`, {}, { admin: true });
  const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => call('POST', '/api/home/unlock', { id: H1, code: 'BBBBB-BBBBB' }, { who: `flood${i}` })));
  const statuses = answers.map((a) => a.res.status);
  assert.equal(statuses.filter((s) => s === 403).length, 10, 'two running and eight waiting are checked');
  assert.equal(statuses.filter((s) => s === 503).length, 10, 'the rest are refused at once');
  assert.equal(answers.find((a) => a.res.status === 503).res.data.code, 'busy');
  assert.equal(homes.turns.active, 0);
  assert.equal(homes.checks.count(H1, Date.now()), 10, 'a "busy" refusal is not counted against the home\'s budget');
  await homes.flush();
});

test('each home has a budget of its own: tries at made-up ids never use up a real home\'s', async () => {
  const { call, homes } = setup();
  const code = (await call('POST', `/api/admin/homes/${H1}/code`, {}, { admin: true })).res.data.code;
  const now = Date.now();
  for (let i = 0; i < 300; i++) homes.checks.add('-', now); // 300 tries at made-up ids by a crowd
  for (let i = 0; i < 300; i++) homes.checks.add(H2, now); // and 300 at another home
  assert.equal((await call('POST', '/api/home/unlock', { id: H1, code }, { who: 'owner' })).res.status, 200);
  assert.equal(homes.slowLanes.has(H1), false, 'at once: no slow lane for a home whose budget is not used up');
  assert.equal(homes.checks.count(H1, Date.now()), 1);
});

test('past a home\'s budget nobody is refused for it: one at a time through a slow lane, and the owner gets in', async () => {
  const { call, homes } = setup();
  homes.capWaitMs = 30;
  const code = (await call('POST', `/api/admin/homes/${H1}/code`, {}, { admin: true })).res.data.code;
  const now = Date.now();
  for (let i = 0; i < 300; i++) homes.checks.add(H1, now); // the budget used up by a crowd
  const flood = Array.from({ length: 10 }, (_, i) => call('POST', '/api/home/unlock', { id: H1, code: 'BBBBB-BBBBB' }, { who: `crowd${i}` }));
  const statuses = (await Promise.all(flood)).map((a) => a.res.status);
  assert.equal(statuses.filter((s) => s === 403).length, 5, 'one running and four waiting in the slow lane are checked');
  assert.equal(statuses.filter((s) => s === 503).length, 5, 'the rest hear "busy", not "too many" for an hour');
  const lane = homes.slowLanes.get(`${H1}|anyone`);
  let laned = 0;
  const run = lane.run.bind(lane);
  lane.run = (fn) => (laned++, run(fn));
  const t = Date.now();
  assert.equal((await call('POST', '/api/home/unlock', { id: H1, code }, { who: 'owner', user: 'p1' })).res.status, 200, 'the owner still gets in');
  assert.ok(Date.now() - t >= 25 && laned === 1, 'through the slow lane, after its pause');
  assert.equal((await call('POST', '/api/home/unlock', { id: H1, code }, { who: 'owner2', user: 'p1' })).res.status, 200);
  assert.equal(laned, 1, 'a session that holds the grant skips the slow lane');
  assert.equal((await call('POST', '/api/home/unlock', { id: H1 }, { admin: true, who: 'root' })).res.status, 200, 'the admin needs no code');
  await homes.flush();
});

test('a code changed, revoked or switched off while a try waits for its check: that try opens nothing', async () => {
  for (const change of ['new code', 'revoked', 'switched off']) {
    const { call, homes } = setup();
    const code = (await call('POST', `/api/admin/homes/${H1}/code`, {}, { admin: true })).res.data.code;
    const run = homes.turns.run.bind(homes.turns);
    let once = true;
    homes.turns.run = async (fn) => {
      const r = await run(fn);
      if (once) {
        once = false; // the admin acts after the hash was checked, before the answer
        if (change === 'new code') await call('POST', `/api/admin/homes/${H1}/code`, {}, { admin: true });
        if (change === 'revoked') await call('DELETE', `/api/admin/homes/${H1}/code`, undefined, { admin: true });
        if (change === 'switched off') await call('POST', `/api/admin/homes/${H1}`, { enabled: false }, { admin: true });
      }
      return r;
    };
    const res = (await call('POST', '/api/home/unlock', { id: H1, code }, { user: 'p1', who: 'w' })).res;
    assert.deepEqual([res.status, res.data.code, res.data.inside], [403, 'home_denied', undefined], change);
    assert.equal(homes.granted('p1', H1), false, `${change}: no grant`);
    await homes.flush();
  }
});

test('wrong tries are counted in memory and written to the store at most once a minute', async () => {
  const { call, homes } = setup();
  await call('POST', `/api/admin/homes/${H1}/code`, {}, { admin: true });
  let writes = 0;
  const setMeta = homes.store.setMeta;
  homes.store.setMeta = (...a) => (writes++, setMeta(...a));
  for (let i = 0; i < 12; i++) await call('POST', '/api/home/unlock', { id: H1, code: 'BBBBB-BBBBB' }, { who: `w${i}` });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(writes <= 1, `one write for twelve wrong tries, not twelve (${writes})`);
  const row = () => call('GET', '/api/admin/homes', undefined, { admin: true }).then((r) => r.res.data.rows.find((x) => x.id === H1));
  assert.equal((await row()).fails, 12, 'the admin sees every wrong try at once');
  assert.ok(homes.flushTimer, 'the rest wait for the next write');
  await homes.flush();
  assert.equal(homes.fails.size, 0);
  assert.equal((await row()).fails, 12, 'and none counted twice');
  assert.equal(JSON.parse(await homes.store.getMeta('homes'))[H1].fails, 12, 'all in the store');
});

test("at start only the accounts' access made with the code in use counts", async () => {
  const meta = new Map([['homes', JSON.stringify({ [H1]: { enabled: true, hash: 'x', gen: 3 }, [H2]: { enabled: true, hash: 'y' } })]]);
  const at = '2026-11-08T10:00:00.000Z';
  const grants = [
    { username: 'anna', home: H1, gen: 3, at },
    { username: 'bert', home: H1, gen: 2, at }, // an older code's
    { username: 'gone', home: H1, gen: 3, at }, // no account any more
    { username: 'anna', home: 'nowhere', gen: 0, at },
    { username: 'anna', home: H2, gen: 0, at }, // a record from before generations: 0
  ];
  const store = fakeStore(meta, new Set(['anna', 'bert']), grants);
  const sessions = new Map([
    ['ka', { username: 'anna', role: 'player', expires: Date.now() + 60_000 }],
    ['kb', { username: 'bert', role: 'player', expires: Date.now() + 60_000 }],
  ]);
  const { homes, call } = setup({ store, sessions });
  await homes.load();
  assert.equal(homes.granted('ka', H1), true);
  assert.equal(homes.granted('ka', H2), true);
  assert.equal(homes.granted('kb', H1), false, 'an older code');
  assert.deepEqual([...homes.lasting.keys()], ['anna']);
  const rows = (await call('GET', '/api/admin/homes', undefined, { admin: true })).res.data.rows;
  assert.deepEqual(rows.find((r) => r.id === H1).accounts, [{ username: 'anna', at }]);
  sessions.set('ka', { ...sessions.get('ka'), expires: Date.now() - 1 });
  assert.equal(homes.granted('ka', H1), false, 'a session that has ended');
});
