import assert from 'node:assert/strict';
import test from 'node:test';
import { Homes, newCode, normalizeCode, showCode } from './homes.mjs';
import { HOMES } from '../shared/homes.mjs';

const H1 = 'house';
const H2 = 'bungalow';
const PACK = { id: 'house', prisms: [], doors: [], fixtures: [], props: [] };

function setup() {
  const meta = new Map();
  const store = { getMeta: async (k) => meta.get(k) ?? null, setMeta: async (k, v) => void meta.set(k, v) };
  const homes = new Homes(store, {
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
  return { homes, call };
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
